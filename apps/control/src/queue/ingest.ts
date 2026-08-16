import { TERMINAL_JOB_STATUSES } from '@ai-drama/contracts'
import { and, eq, notInArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { s3Key, type Storage } from '../storage/s3.js'

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

  // 自部署直写时产物已在存储里，不重复搬运
  const { sha256, bytes } = input.storageKey
    ? await hashExisting(deps, input.storageKey)
    : await deps.storage.putFile(key, localPathOf(input.sourceUrl), 'video/mp4')

  // 内容去重：同 hash 复用已有 asset
  const [existing] = await deps.db.select().from(s.assets).where(eq(s.assets.sha256, sha256)).limit(1)

  const assetId =
    existing?.id ??
    (
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

  const [take] = await deps.db
    .insert(s.takes)
    .values({
      shotId: input.shotId,
      jobId: input.generationJobId,
      assetId,
      status: 'candidate',
    })
    .returning({ id: s.takes.id })

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
   */
  const settled = await deps.db
    .update(s.generationJobs)
    .set({ status: 'succeeded', accepted: true, finishedAt: new Date() })
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
  db: Db,
  input: {
    shotId: string
    attempt: number
    providerId: string
    modelId: string
    mode: 't2v' | 'i2v' | 'ref2v' | 'extend'
    promptText: string
    params?: Record<string, unknown>
    seed?: number
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
    params: input.params ?? {},
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    status: 'queued',
  })
  return id
}
