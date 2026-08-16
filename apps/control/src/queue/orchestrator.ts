import type { GenerationRequest, VideoProvider } from '@ai-drama/contracts'
import { eq, inArray } from 'drizzle-orm'
import type IORedis from 'ioredis'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { release, tryAcquire } from './semaphore.js'
import { pollDelayMs, type Queues } from './queues.js'

/**
 * 编排：把 generation_jobs 的生命周期与队列串起来。
 *
 * 两条贯穿始终的规矩：
 *
 * 1. **提交即返回**（05-job-orchestration.md §7.5）。绝不在 BullMQ 的 job 里
 *    同步等生成完成——那会占满 worker 槽位、让 lock 续期依赖 event loop 让出，
 *    网络一抖任务就丢，而 GPU 上钱已经花了。提交完写库、立刻完成，
 *    进度交给自重排的轮询任务。
 *
 * 2. **Postgres 是真相源**（ADR-0003）。Redis 里的东西可以全丢，
 *    重启后从非终态记录重建。
 */

export interface OrchestratorDeps {
  readonly db: Db
  readonly redis: IORedis
  readonly queues: Queues
  readonly providers: readonly VideoProvider[]
  /** 每镜最大质量重试次数（03-pipeline.md §4 的 evalPolicy） */
  readonly maxAttempts: number
}

export const PROVIDER_TIMEOUT_MS = 15 * 60 * 1000

function providerOf(deps: OrchestratorDeps, id: string): VideoProvider {
  const p = deps.providers.find((x) => x.id === id)
  if (!p) throw new Error(`provider 不在池中：${id}`)
  return p
}

/**
 * q:generate 的 handler。
 *
 * 幂等由两层保证：provider 的 submit 契约（同 requestId 同 handle），
 * 以及 generation_jobs 的 UNIQUE(shot_id, attempt)。任何一层单独失效
 * 都不会导致重复计费。
 */
export async function handleGenerate(
  deps: OrchestratorDeps,
  data: { generationJobId: string },
): Promise<'submitted' | 'requeued' | 'skipped'> {
  const [job] = await deps.db
    .select()
    .from(s.generationJobs)
    .where(eq(s.generationJobs.id, data.generationJobId))
  if (!job) return 'skipped'

  // 已提交过的直接转轮询——崩溃恢复重放时会走到这里
  if (job.providerJobRef) {
    await enqueuePoll(deps, job.id, job.providerId, job.providerJobRef, Date.now())
    return 'skipped'
  }

  const provider = providerOf(deps, job.providerId)

  // provider 配额是跨进程的（§3 第 ② 层）。拿不到槽位就重排，不阻塞 worker
  const got = await tryAcquire(deps.redis, provider.id, provider.capabilities.maxConcurrent)
  if (!got) {
    await deps.queues.generate.add(
      'generate',
      { generationJobId: job.id, shotId: job.shotId },
      { delay: 2000 },
    )
    return 'requeued'
  }

  try {
    const req = buildRequest(job)
    const v = provider.validate(req)
    if (!v.ok) {
      await fail(deps, job.id, 'invalid_output', `能力不匹配：${v.reason}`)
      return 'skipped'
    }

    const handle = await provider.submit(req)
    await deps.db
      .update(s.generationJobs)
      .set({ status: 'submitted', providerJobRef: handle.externalId, startedAt: new Date() })
      .where(eq(s.generationJobs.id, job.id))

    await enqueuePoll(deps, job.id, provider.id, handle.externalId, handle.submittedAt)
    return 'submitted'
  } finally {
    // 槽位在提交完成后就释放：占用的是「并发提交数」，不是「并发生成数」。
    // provider 侧的真实并发由它自己的队列管，我们不该替它排队。
    await release(deps.redis, provider.id)
  }
}

function buildRequest(job: typeof s.generationJobs.$inferSelect): GenerationRequest {
  const params = job.params as Record<string, unknown>
  return {
    requestId: job.id,
    shotId: job.shotId,
    mode: job.mode,
    prompt: job.promptText,
    ...(job.negativeText ? { negativePrompt: job.negativeText } : {}),
    refImages: [],
    durationSec: Number(params['durationSec'] ?? 4),
    resolution: (params['resolution'] as '720p') ?? '720p',
    aspectRatio: (params['aspectRatio'] as '9:16') ?? '9:16',
    fps: Number(params['fps'] ?? 24),
    ...(job.seed === null ? {} : { seed: job.seed }),
    safetyProfile: 'standard',
    priority: 'normal',
    providerParams: (params['providerParams'] as Record<string, unknown>) ?? {},
  }
}

async function enqueuePoll(
  deps: OrchestratorDeps,
  generationJobId: string,
  providerId: string,
  externalId: string,
  submittedAt: number,
): Promise<void> {
  await deps.queues.poll.add(
    'poll',
    { generationJobId, providerId, externalId, submittedAt, pollCount: 0 },
    { delay: pollDelayMs(0) },
  )
}

/**
 * q:poll 的 handler —— **自重排**，不是常驻循环。
 *
 * 同一时刻内存里没有任何挂起的循环，只有 Redis 里的延时条目。
 * 几千个并行任务也不会压垮进程（§4）。
 */
export async function handlePoll(
  deps: OrchestratorDeps,
  data: {
    generationJobId: string
    providerId: string
    externalId: string
    submittedAt: number
    pollCount: number
  },
): Promise<'running' | 'succeeded' | 'failed' | 'timeout'> {
  const provider = providerOf(deps, data.providerId)
  const handle = { providerId: data.providerId, externalId: data.externalId, submittedAt: data.submittedAt }

  const res = await provider.poll(handle)

  if (res.status === 'running' || res.status === 'submitted') {
    if (Date.now() - data.submittedAt > PROVIDER_TIMEOUT_MS) {
      await provider.cancel(handle).catch(() => undefined)
      await fail(deps, data.generationJobId, 'timeout', `超过 ${PROVIDER_TIMEOUT_MS / 60000} 分钟未返回`)
      return 'timeout'
    }
    await deps.db
      .update(s.generationJobs)
      .set({ status: 'running' })
      .where(eq(s.generationJobs.id, data.generationJobId))
    await deps.queues.poll.add(
      'poll',
      { ...data, pollCount: data.pollCount + 1 },
      { delay: pollDelayMs(data.pollCount + 1) },
    )
    return 'running'
  }

  if (res.status === 'failed') {
    await fail(deps, data.generationJobId, res.code, res.message)
    return 'failed'
  }

  // 正面判定 succeeded 而不是靠排除法：ProviderProgress.status 是
  // 'submitted' | 'running' 两值枚举，上面那个 || 判断不足以让 TS 把它从
  // 联合里narrow 掉。宁可多一次显式检查，也不要靠穷举推断。
  if (res.status !== 'succeeded') return 'running'

  // 终态成功：转 ingest 下载/转存。控制面不在这里搬字节
  const [job] = await deps.db
    .select({ shotId: s.generationJobs.shotId })
    .from(s.generationJobs)
    .where(eq(s.generationJobs.id, data.generationJobId))
  if (!job) return 'failed'

  const projectId = await projectOfShot(deps.db, job.shotId)
  await deps.db
    .update(s.generationJobs)
    .set({
      status: 'downloading',
      costMicroUsd: res.costMicroUsd,
      latencyMs: Date.now() - data.submittedAt,
      ...(res.seedUsed === undefined ? {} : { seed: res.seedUsed }),
    })
    .where(eq(s.generationJobs.id, data.generationJobId))

  await deps.queues.ingest.add('ingest', {
    generationJobId: data.generationJobId,
    shotId: job.shotId,
    projectId,
    sourceUrl: res.outputUrl,
    ...(res.storageKey ? { storageKey: res.storageKey } : {}),
  })
  return 'succeeded'
}

async function projectOfShot(db: Db, shotId: string): Promise<string> {
  const rows = await db
    .select({ projectId: s.projects.id })
    .from(s.shots)
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
    .innerJoin(s.projects, eq(s.episodes.projectId, s.projects.id))
    .where(eq(s.shots.id, shotId))
  const first = rows[0]
  if (!first) throw new Error(`找不到 shot ${shotId} 所属的 project`)
  return first.projectId
}

async function fail(
  deps: OrchestratorDeps,
  generationJobId: string,
  code: (typeof s.generationJobs.$inferSelect)['failureCode'],
  detail: string,
): Promise<void> {
  await deps.db
    .update(s.generationJobs)
    .set({
      status: 'failed',
      failureCode: code,
      failureDetail: detail,
      finishedAt: new Date(),
      accepted: false,
    })
    .where(eq(s.generationJobs.id, generationJobId))
}

/**
 * 崩溃恢复（§8）。控制面重启时把非终态任务捞回来：
 * 从未提交成功的重新入队（幂等键保证不会重复计费），已提交的恢复轮询而非重新提交。
 *
 * 幂等是这套逻辑成立的前提——所以它是 provider 契约测试的第一条。
 */
export async function reconcileOnBoot(
  deps: OrchestratorDeps,
): Promise<{ requeued: number; resumed: number }> {
  const stuck = await deps.db
    .select()
    .from(s.generationJobs)
    .where(inArray(s.generationJobs.status, ['queued', 'submitted', 'running', 'downloading', 'evaluating']))

  let requeued = 0
  let resumed = 0

  for (const job of stuck) {
    if (!job.providerJobRef) {
      await deps.queues.generate.add('generate', { generationJobId: job.id, shotId: job.shotId })
      requeued++
    } else {
      await deps.queues.poll.add('poll', {
        generationJobId: job.id,
        providerId: job.providerId,
        externalId: job.providerJobRef,
        submittedAt: job.startedAt?.getTime() ?? Date.now(),
        pollCount: 0,
      })
      resumed++
    }
  }
  return { requeued, resumed }
}
