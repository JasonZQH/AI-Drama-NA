import { TERMINAL_JOB_STATUSES } from '@ai-drama/contracts'
import { and, eq, notInArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { Db, DbOrTx } from '../db/client.js'
import * as s from '../db/schema.js'
import { hashFile, s3Key, type Storage } from '../storage/s3.js'

/**
 * q:ingest：把 provider 的产物变成 asset + take 行。
 *
 * 云 API 的产物由控制面下载后写入 MinIO 并校验 sha256；自部署 worker 是
 * 直写存储的，只回一个 storageKey，这里跳过转存（04-provider-adapter.md §4.3）。
 *
 * 内容寻址去重：相同 hash 直接复用已有 asset 行，新建引用而非新建对象
 * （10-media-storage.md §1.3）。
 */

/**
 * 单次下载的字节上限。真 provider 的一条 4 秒 720p take 是几 MB 到几十 MB，
 * 512MB 留了两个数量级的余量——它挡的不是正常产物，是「URL 指向了别的东西」
 * 和「对端流不停」这两种把磁盘写满的情形。
 */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

/** 覆盖连接、响应头与整个 body 的总时长。fetch 默认无超时 */
const DOWNLOAD_TIMEOUT_MS = 120_000

export interface IngestDeps {
  readonly db: Db
  readonly storage: Storage
  /**
   * 建完 take 后要推进镜头状态机。缺了它整条流水线会停在 generating——
   * 生成完成了、成本记了、take 也建了，但没人告诉镜头「有候选了」。
   */
  readonly onTakeAccepted?: (shotId: string, takeId: string) => Promise<unknown>
  /** 不传用上面的常量。测试要在不下载 512MB 的前提下验上限时传它 */
  readonly limits?: { readonly maxBytes?: number; readonly timeoutMs?: number }
}

export interface IngestInput {
  readonly generationJobId: string
  readonly shotId: string
  readonly projectId: string
  /** provider 侧可下载 URL，或本地 fixture 路径（mock） */
  readonly sourceUrl: string
  /** 自部署 worker 直写时给出，此时不转存 */
  readonly storageKey?: string
}

export interface IngestResult {
  readonly assetId: string
  readonly takeId: string
  readonly deduped: boolean
  /** false = 这条 ingest 迟到了，job 已经结算过，状态机未被推进（见下方终态守卫） */
  readonly settled: boolean
}

export async function handleIngest(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const key = input.storageKey ?? s3Key.take(input.projectId, input.shotId, input.generationJobId)

  // 自部署 worker 直写存储（provider 只回 storageKey），字节本来就不搬运
  const local = input.storageKey ? null : await materialize(input.sourceUrl, deps)
  try {
    return await ingestLocal(deps, input, key, local?.path)
  } finally {
    // 无论去重命中、上传失败、还是终态守卫拦下，临时文件都要走
    await local?.cleanup()
  }
}

async function ingestLocal(
  deps: IngestDeps,
  input: IngestInput,
  key: string,
  localPath: string | undefined,
): Promise<IngestResult> {
  /*
   * **先算哈希查重，再决定要不要上传。**
   *
   * 原来是反的：先 putFile 到一个唯一 key，再按 sha256 查已有 asset。命中时那个
   * 刚传上去的对象就成了孤儿——没人引用，也没人清理，而系统永不自动销毁字节
   * （03 §7），于是它会一直躺在存储里。mock 每次都返回同一条 fixture，所以这条
   * 路径每跑一次就多一个孤儿。
   *
   * 换成先查后传，比「传完再删」省：零删除路径、不销毁已付费字节，还顺手省掉
   * 命中时那一次完整上传。
   *
   * 自部署直写时产物已经在存储里（provider 只回 storageKey），本来就不搬运。
   */
  const { sha256, bytes } =
    localPath === undefined ? await hashExisting(deps, input.storageKey!) : await hashFile(localPath)

  const [existing] = await deps.db.select().from(s.assets).where(eq(s.assets.sha256, sha256)).limit(1)

  let assetId: string
  if (existing) {
    assetId = existing.id
  } else {
    // 内容是新的才真的上传。storageKey 分支的字节早就在存储里，不用再传一遍
    if (localPath !== undefined) {
      await deps.storage.putFile(key, localPath, 'video/mp4')
    }
    assetId = (
      await deps.db
        .insert(s.assets)
        .values({
          projectId: input.projectId,
          kind: 'video',
          storageKey: key,
          mime: 'video/mp4',
          bytes,
          sha256,
          producedBy: 'generation',
        })
        .returning({ id: s.assets.id })
    )[0]!.id
  }

  /*
   * 一个 job 至多一条 take —— 由 `UNIQUE(job_id)` 在数据库层保证。
   *
   * 应用层的守卫不够：同一个 job 可以有不止一条轮询链（reconcileOnBoot 会为
   * 非终态行再加一条，旧链是自重排的不会自己消失），两条都能走到这里；而且
   * onTakeAccepted 抛错会让 BullMQ 重放**整个** handler，重放时前面的插入已经
   * 提交了。约束是最后一道，`onConflictDoNothing` 让它优雅而不是抛。
   *
   * 后果不只是多一行：一笔已付费的生成产出两条候选，选片池被污染，而
   * usdPerAcceptedMicro 的分母（accepted 计数）会跟着多算——每可用镜头成本被
   * 系统性低估，而那正是 M1 最重要的那个指标。
   */
  const inserted = await deps.db
    .insert(s.takes)
    .values({
      shotId: input.shotId,
      jobId: input.generationJobId,
      assetId,
      status: 'candidate',
    })
    .onConflictDoNothing({ target: s.takes.jobId })
    .returning({ id: s.takes.id })

  const take =
    inserted[0] ??
    (
      await deps.db
        .select({ id: s.takes.id })
        .from(s.takes)
        .where(eq(s.takes.jobId, input.generationJobId))
        .limit(1)
    )[0]

  /*
   * 终态守卫，与 handlePoll 开头那道同源。
   *
   * 一条迟到的 ingest（重复轮询链、reconcile 恢复出来的旧链）会把一个已经判
   * failed 的行改写成 succeeded，而 failure_code 还留在行上——Ledger 里出现
   * 自相矛盾的一行，并被 stats 计进 usdPerAcceptedMicro 的分母。
   *
   * take 与 asset 已经建好，**不回滚**：字节已经在 MinIO 里、钱已经花过，
   * 系统永不自动销毁已经花钱生成的东西（03-pipeline.md §7）。只是不再推状态机——
   * 镜头已经走到别处，硬推只会被状态机拒掉并留下一个没人看的孤儿 take。
   *
   * **这里不写 accepted。** 它此前写的是 true，于是 accepted 的含义成了
   * 「这次生成出了片子」，而它唯一的用途是 usdPerAcceptedMicro 的分母
   * （stats.ts、api.ts）与首过率。分母若是「成功生成数」，一个镜头重试三次、
   * 三次都出片、人只选一条，账面上成本就被三条候选摊薄——**重试越多这个指标
   * 越好看**，而它恰恰是 M1 最重要的那个数。真正的语义是「被选中」，唯一
   * 知道这件事的是状态机的 set.selectedTake，所以写入点搬去了 applyTransition。
   */
  const settled = await deps.db
    .update(s.generationJobs)
    .set({ status: 'succeeded', finishedAt: new Date() })
    .where(
      and(
        eq(s.generationJobs.id, input.generationJobId),
        notInArray(s.generationJobs.status, [...TERMINAL_JOB_STATUSES]),
      ),
    )
    .returning({ id: s.generationJobs.id })

  if (settled.length > 0) await deps.onTakeAccepted?.(input.shotId, take!.id)

  return { assetId, takeId: take!.id, deduped: existing !== undefined, settled: settled.length > 0 }
}

interface LocalCopy {
  readonly path: string
  /** 只有真下载过才需要删。本地 fixture 是 no-op */
  cleanup(): Promise<void>
}

const NO_CLEANUP = (): Promise<void> => Promise.resolve()

/**
 * 把产物落到一个本地路径上，**整个 handleIngest 期间只做一次**。
 *
 * mock provider 返回本地 fixture 路径，真 provider 返回 http(s) URL。此前这里
 * 是个同步的 `localPathOf`，被调用两次（算哈希一次、上传一次）——改成下载的话
 * 那就是下两遍、留两个临时文件，而且 `finally` 要同时管住两个。所以先物化，
 * 再把路径传给下游。
 */
async function materialize(sourceUrl: string, deps: IngestDeps): Promise<LocalCopy> {
  if (!sourceUrl.startsWith('http://') && !sourceUrl.startsWith('https://')) {
    return { path: sourceUrl.replace(/^file:\/\//, ''), cleanup: NO_CLEANUP }
  }

  const maxBytes = deps.limits?.maxBytes ?? MAX_DOWNLOAD_BYTES
  const timeoutMs = deps.limits?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS

  const dir = await mkdtemp(join(tmpdir(), 'drama-ingest-'))
  const path = join(dir, 'take.mp4')
  const wipe = (): Promise<void> => rm(dir, { recursive: true, force: true })

  try {
    /*
     * 一个 signal 同时管住连接、响应头和整个 body——`AbortSignal.timeout` 从
     * 创建那刻起计时，中途断流会在这里超时报错而不是永久挂着。fetch 默认无超时。
     */
    const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${sourceUrl}`)
    if (!res.body) throw new Error(`下载响应没有 body：${sourceUrl}`)

    /*
     * **体积上限在流中途判，不读 `Content-Length`。**
     *
     * 那个头可以是错的、缺失的、或者故意撒谎的——按它做预检查等于允许对端
     * 决定我们的磁盘写多满。分块累计才是真的守住了。
     */
    let written = 0
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.byteLength
        if (written > maxBytes) {
          cb(new Error(`产物超过 ${maxBytes} 字节上限，已中断：${sourceUrl}`))
          return
        }
        cb(null, chunk)
      },
    })

    // pipeline 负责背压，并在任一环节出错时销毁整条链
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), cap, createWriteStream(path))
  } catch (e) {
    await wipe() // 失败路径也要清，否则每次失败留一个半截文件
    throw e
  }

  return { path, cleanup: wipe }
}

async function hashExisting(deps: IngestDeps, key: string): Promise<{ sha256: string; bytes: number }> {
  const buf = await deps.storage.getBytes(key)
  const { createHash } = await import('node:crypto')
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.byteLength }
}

/** 创建一条生成尝试。attempt 由 UNIQUE(shot_id, attempt) 物理保证不重复 */
export async function createGenerationJob(
  db: DbOrTx,
  input: {
    shotId: string
    attempt: number
    providerId: string
    modelId: string
    mode: 't2v' | 'i2v' | 'ref2v' | 'extend'
    promptText: string
    /** 来自 style_profiles.negative_prompt。此前这一列没有任何写入方 */
    negativeText?: string
    params?: Record<string, unknown>
    seed?: number
    /** 在途预留：建行即占额度，见 applyTransition 的注释 */
    costMicroUsd?: number
    costEstimated?: boolean
  },
): Promise<string> {
  const id = randomUUID()
  await db.insert(s.generationJobs).values({
    id,
    shotId: input.shotId,
    attempt: input.attempt,
    providerId: input.providerId,
    modelId: input.modelId,
    mode: input.mode,
    promptText: input.promptText,
    ...(input.negativeText === undefined ? {} : { negativeText: input.negativeText }),
    params: input.params ?? {},
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.costMicroUsd === undefined ? {} : { costMicroUsd: input.costMicroUsd }),
    ...(input.costEstimated === undefined ? {} : { costEstimated: input.costEstimated }),
    status: 'queued',
  })
  return id
}
