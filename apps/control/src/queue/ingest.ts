import { TERMINAL_JOB_STATUSES } from '@ai-drama/contracts'
import { and, eq, notInArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
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

export interface IngestDeps {
  readonly db: Db
  readonly storage: Storage
  /**
   * 建完 take 后要推进镜头状态机。缺了它整条流水线会停在 generating——
   * 生成完成了、成本记了、take 也建了，但没人告诉镜头「有候选了」。
   */
  readonly onTakeAccepted?: (shotId: string, takeId: string) => Promise<unknown>
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
  const { sha256, bytes } = input.storageKey
    ? await hashExisting(deps, input.storageKey)
    : await hashFile(localPathOf(input.sourceUrl))

  const [existing] = await deps.db.select().from(s.assets).where(eq(s.assets.sha256, sha256)).limit(1)

  let assetId: string
  if (existing) {
    assetId = existing.id
  } else {
    // 内容是新的才真的上传。storageKey 分支的字节早就在存储里，不用再传一遍
    if (!input.storageKey) {
      await deps.storage.putFile(key, localPathOf(input.sourceUrl), 'video/mp4')
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

/** mock provider 返回的是本地 fixture 路径；真 provider 返回 http(s) URL */
function localPathOf(sourceUrl: string): string {
  if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://')) {
    throw new Error(`远程 URL 的下载在 M1 接入云 provider 时实现：${sourceUrl}`)
  }
  return sourceUrl.replace(/^file:\/\//, '')
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
