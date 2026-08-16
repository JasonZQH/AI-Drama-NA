import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../db/client.js'
import * as s from '../db/schema.js'
import { MockProvider } from '../providers/mock.js'
import { Storage, storageFromEnv } from '../storage/s3.js'
import type { VideoProvider } from '@ai-drama/contracts'
import { handleIngest, createGenerationJob } from './ingest.js'
import {
  CLAIM_STALE_MS,
  claimForSubmit,
  handleGenerate,
  handlePoll,
  reconcileOnBoot,
} from './orchestrator.js'
import { createConnection, createQueues, pollDelayMs } from './queues.js'
import { spentToday } from '../pipeline/batch.js'
import { inFlight, release, reset, tryAcquire } from './semaphore.js'

/**
 * 集成测试：跑在**真实的** Redis + Postgres + MinIO 上。
 *
 * 这一层的 bug（幂等、恢复、限流）在单测里几乎不可见，在生产上会表现为
 * 「莫名其妙多扣了钱」或「任务卡死」，事后极难排查（11-dev-setup.md §9）。
 * 所以它必须打真实依赖，不能 mock 掉。
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://drama:drama@localhost:5432/drama'
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'

const { db, client } = createDb(DB_URL, 3)
const redis = createConnection(REDIS_URL)
const queues = createQueues({ url: REDIS_URL })
const provider = new MockProvider({ latencyScale: 0, failureRate: 0 })
const storage = new Storage(
  storageFromEnv({
    S3_BUCKET: 'drama',
    S3_INTERNAL_ENDPOINT: process.env['S3_INTERNAL_ENDPOINT'] ?? 'http://localhost:9000',
    S3_ACCESS_KEY: 'adminlocal',
    S3_SECRET_KEY: 'adminlocal123',
  }),
)

const deps = { db, redis, queues, providers: [provider], maxAttempts: 4 }

let shotId: string
let projectId: string

/** 本套测试占用的 attempt 号段。真实生产的 attempt 只会是 1..4 */
const TEST_ATTEMPT_BASE = 900
const TEST_ATTEMPT_MAX = 1000

beforeAll(async () => {
  // 复用 seed 出来的 demo 项目，不自己造数据——夹具漂移了测试要能发现
  // 取最后一个镜头，与 api.int.test.ts（取第一个）错开，避免共享真实数据库时互相干扰
  const [shot] = await db.select({ id: s.shots.id }).from(s.shots).orderBy(desc(s.shots.index)).limit(1)
  if (!shot) throw new Error('库里没有 shot，先跑 pnpm db:seed')
  shotId = shot.id
  const [p] = await db.select({ id: s.projects.id }).from(s.projects).limit(1)
  projectId = p!.id
  await reset(redis, 'mock')

  // 清掉上一轮的残留。集成测试必须可重复运行——否则第二次跑就会撞
  // UNIQUE(shot_id, attempt)，而那是本套测试自己要验证的约束
  await cleanupTestRows()
})

/** takes 引用 jobs 且无级联，所以顺序是先 takes 后 jobs */
async function cleanupTestRows(): Promise<void> {
  const stale = await db
    .select({ id: s.generationJobs.id })
    .from(s.generationJobs)
    .where(
      and(gte(s.generationJobs.attempt, TEST_ATTEMPT_BASE), lt(s.generationJobs.attempt, TEST_ATTEMPT_MAX)),
    )
  if (stale.length === 0) return
  const ids = stale.map((r) => r.id)
  await db.delete(s.takes).where(inArray(s.takes.jobId, ids))
  await db.delete(s.generationJobs).where(inArray(s.generationJobs.id, ids))
}

afterAll(async () => {
  await cleanupTestRows()
  await queues.close()
  redis.disconnect()
  await client.end()
})

/** 每个用例用独立 attempt 号，避开 UNIQUE(shot_id, attempt) */
let attemptSeq = TEST_ATTEMPT_BASE
const nextAttempt = () => ++attemptSeq

async function newJob(over: Partial<Parameters<typeof createGenerationJob>[1]> = {}): Promise<string> {
  return createGenerationJob(db, {
    shotId,
    attempt: nextAttempt(),
    providerId: 'mock',
    modelId: 'mock-v1',
    mode: 't2v',
    promptText: 'a woman looks up at the door, cu',
    params: { durationSec: 4, resolution: '720p', aspectRatio: '9:16', fps: 24 },
    ...over,
  })
}

/**
 * 数 submit 被调了几次。
 *
 * **不能用 spread 包 MockProvider**——方法在原型上，`{ ...p }` 拿不到。
 * 也不能靠 providerJobRef 判断：buildRequest 用 `requestId: job.id`，mock 又把
 * externalId 设成 requestId，所以 providerJobRef 恒等于 job.id，submit 调一次
 * 还是十次它都一模一样。这个包装器是仓库里唯一能观测到调用次数的东西。
 */
function counting(p: VideoProvider): { provider: VideoProvider; submits: () => number } {
  let n = 0
  return {
    provider: {
      id: p.id,
      capabilities: p.capabilities,
      validate: (r) => p.validate(r),
      estimateCost: (r) => p.estimateCost(r),
      submit: (r) => {
        n++
        return p.submit(r)
      },
      poll: (h) => p.poll(h),
      cancel: (h) => p.cancel(h),
      health: () => p.health(),
    },
    submits: () => n,
  }
}

/**
 * 每个用例一套独立计数器，但**包的是模块级那个 provider 实例**。
 *
 * 不能 new 一个新的：MockProvider 的任务表在实例内（mock.ts 的 private jobs Map），
 * 换实例就等于换了一个不认识旧 handle 的 provider，后面的 poll 会拿到「未知任务」。
 */
function countingDeps(): { deps: typeof deps; submits: () => number } {
  const c = counting(provider)
  return { deps: { ...deps, providers: [c.provider] }, submits: c.submits }
}

describe('每行至多 submit 一次（花钱的不变量）', () => {
  /**
   * 认领本身的 CAS 语义。
   *
   * **不要写成 `Promise.all([handleGenerate, handleGenerate])` 然后数 submit** ——
   * 实测那样测不出东西：postgres.js 会把这几次查询串到同一条连接上顺序执行，
   * 于是第二、三次调用在 SELECT 时就已经看得见 providerJobRef，走了 :130 那条
   * 既有的早退分支。把认领整个删掉，那种写法照样绿（已实测：submits=1，
   * 返回 ["submitted","skipped","skipped"]）。真实的竞态发生在**跨进程**之间
   * （控制面 reconcile 与 worker、或两个 worker 副本），进程内造不出来。
   *
   * 所以直接钉住不变量本身：同一行只可能被认领成功一次。
   */
  it('同一行只能被认领一次，第二次必然失败', async () => {
    const id = await newJob()
    expect(await claimForSubmit(db, id)).toBe(true)
    expect(await claimForSubmit(db, id)).toBe(false)
  })

  /**
   * 这条才是防退化的那一张网：模拟「另一个进程已经认领并正在提交」，
   * 断言本进程绝不会再花一次钱。删掉 handleGenerate 里的认领判断，它就会红。
   */
  it('行已被别处认领时，handleGenerate 绝不提交', async () => {
    const { deps: d, submits } = countingDeps()
    const id = await newJob()

    // 另一个 worker 抢先认领（它还没来得及写 providerJobRef）
    expect(await claimForSubmit(db, id)).toBe(true)

    expect(await handleGenerate(d, { generationJobId: id })).toBe('skipped')
    expect(submits(), '认领不属于自己就绝不能调 submit').toBe(0)

    const [row] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(row!.providerJobRef).toBeNull()
  })

  /**
   * 事实 5：信号量重排会 re-add 同一个 generationJobId。
   * 所以认领必须发生在 tryAcquire 成功**之后**——否则重排会白白烧掉认领，
   * 任务再也提交不了。这条用例专门钉住这个顺序。
   */
  it('拿不到信号量槽位时不认领，重排回来仍能正常提交', async () => {
    const { deps: d, submits } = countingDeps()
    const id = await newJob()
    const limit = d.providers[0]!.capabilities.maxConcurrent

    await reset(redis, 'mock')
    for (let i = 0; i < limit; i++) expect(await tryAcquire(redis, 'mock', limit)).toBe(true)

    expect(await handleGenerate(d, { generationJobId: id })).toBe('requeued')
    const [parked] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(parked!.startedAt, '重排路径不该碰认领').toBeNull()
    expect(submits()).toBe(0)

    await reset(redis, 'mock')
    await queues.generate.drain(true)

    expect(await handleGenerate(d, { generationJobId: id })).toBe('submitted')
    expect(submits()).toBe(1)
  })

  /**
   * submit 抛出时分不清「没发出去」和「发出去了但响应丢了」——OpenRouter 的
   * POST 没有幂等键。所以认领不释放，走一条不可重试的码停下来等人。
   */
  it('submit 抛异常 → submit_unknown，且这一行永不重投', async () => {
    const boom = counting(new MockProvider({ latencyScale: 0, failureRate: 0 }))
    const exploding: VideoProvider = {
      ...boom.provider,
      submit: () => Promise.reject(new Error('ECONNRESET')),
    }
    const d = { ...deps, providers: [exploding] }
    const id = await newJob()

    expect(await handleGenerate(d, { generationJobId: id })).toBe('skipped')

    const [row] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(row!.failureCode).toBe('submit_unknown')
    expect(row!.startedAt, '认领不释放——释放了就等于允许重投').not.toBeNull()

    // 再来一次也不会提交：认领还在，且行已终态
    const again = countingDeps()
    expect(await handleGenerate(again.deps, { generationJobId: id })).toBe('skipped')
    expect(again.submits()).toBe(0)
  })

  /**
   * 进程死在 submit 里会留下悬空认领。重投可能付第二次钱，不管则镜头永远
   * 卡在 generating——所以 reconcile 判 submit_unknown，交给人决定。
   *
   * 注意这个分支碰不到历史数据：本 PR 之前 started_at 只与 provider_job_ref
   * 同时写入，所以「有 started_at 而无 provider_job_ref」在旧行里结构上不存在。
   */
  it('认领悬空超过阈值 → reconcile 判 submit_unknown，不重投', async () => {
    const { deps: d, submits } = countingDeps()
    const id = await newJob()
    await db
      .update(s.generationJobs)
      .set({ startedAt: new Date(Date.now() - CLAIM_STALE_MS - 60_000) })
      .where(eq(s.generationJobs.id, id))

    // 队列条目重放时认领已被占，不会二次提交
    expect(await handleGenerate(d, { generationJobId: id })).toBe('skipped')
    expect(submits()).toBe(0)

    const r = await reconcileOnBoot(deps)
    expect(r.inDoubt).toBeGreaterThanOrEqual(1)

    const [row] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(row!.failureCode).toBe('submit_unknown')
    expect(row!.status).toBe('failed')
  })

  it('认领很新时 reconcile 不动它——可能有 worker 正在 submit 里', async () => {
    const id = await newJob()
    await db.update(s.generationJobs).set({ startedAt: new Date() }).where(eq(s.generationJobs.id, id))

    const r = await reconcileOnBoot(deps)
    expect(r.inFlight).toBeGreaterThanOrEqual(1)

    const [row] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(row!.failureCode).toBeNull()
    expect(row!.status).toBe('queued')
  })
})

describe('失败也记账（预算闸门读的就是这些数）', () => {
  /** 驱动一个注入了失败的 job 走到终态，返回落库后的行 */
  async function failWith(code: 'provider_error' | 'content_filtered') {
    const { deps: d } = countingDeps()
    const id = await newJob({
      params: {
        durationSec: 4,
        resolution: '720p',
        aspectRatio: '9:16',
        fps: 24,
        providerParams: { mock: { failFirstAttempt: code } },
      },
    })
    await handleGenerate(d, { generationJobId: id })
    const [job] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    await handlePoll(d, {
      generationJobId: id,
      providerId: 'mock',
      externalId: job!.providerJobRef!,
      submittedAt: Date.now() - 100,
      pollCount: 0,
    })
    const [row] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    return row!
  }

  it('provider 回报了失败成本就用真数，不标估算', async () => {
    const row = await failWith('provider_error')
    expect(row.failureCode).toBe('provider_error')
    expect(row.costMicroUsd).toBeGreaterThan(0) // 失败的算力也是钱
    expect(row.costEstimated).toBe(false)
  })

  /**
   * mock 对 content_filtered 刻意不报成本（提交即被策略拒，没真跑推理）。
   * 这条走的是编排层的兜底：**没报不等于免费**，按价目表估并标成估算。
   */
  it('provider 没报成本时按价目表估，并标成估算', async () => {
    const row = await failWith('content_filtered')
    expect(row.failureCode).toBe('content_filtered')
    expect(row.costMicroUsd).toBeGreaterThan(0)
    expect(row.costEstimated).toBe(true)
  })

  it('超时按估算记账——任务在 provider 那边真的跑了十几分钟', async () => {
    const { deps: d } = countingDeps()
    const id = await newJob()
    await handleGenerate(d, { generationJobId: id })
    const [job] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    const slow = new MockProvider({ latencyScale: 1000, failureRate: 0 })
    await slow.submit({
      requestId: job!.providerJobRef!,
      shotId,
      mode: 't2v',
      prompt: 'p',
      refImages: [],
      durationSec: 4,
      resolution: '720p',
      aspectRatio: '9:16',
      fps: 24,
      safetyProfile: 'standard',
      priority: 'normal',
      providerParams: {},
    })

    expect(
      await handlePoll(
        { ...deps, providers: [slow] },
        {
          generationJobId: id,
          providerId: 'mock',
          externalId: job!.providerJobRef!,
          submittedAt: Date.now() - 20 * 60 * 1000,
          pollCount: 3,
        },
      ),
    ).toBe('timeout')

    const [row] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(row!.costMicroUsd).toBeGreaterThan(0)
    expect(row!.costEstimated).toBe(true)
  })

  /** 唯一确知没花钱的失败：validate 不得有 IO，走到这里一次调用都没发生 */
  it('能力校验不通过记 0，且不标估算', async () => {
    const { deps: d, submits } = countingDeps()
    const id = await newJob({ params: { durationSec: 99 } }) // 超过 mock 的 10 秒上限

    expect(await handleGenerate(d, { generationJobId: id })).toBe('skipped')
    expect(submits()).toBe(0)

    const [row] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(row!.failureCode).toBe('invalid_output')
    expect(row!.costMicroUsd).toBe(0)
    expect(row!.costEstimated).toBe(false)
  })

  it('提交结果未知按估算记账——记 0 的话闸门就拦不住了', async () => {
    const exploding: VideoProvider = {
      ...counting(provider).provider,
      submit: () => Promise.reject(new Error('ECONNRESET')),
    }
    const id = await newJob()
    await handleGenerate({ ...deps, providers: [exploding] }, { generationJobId: id })

    const [row] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(row!.failureCode).toBe('submit_unknown')
    expect(row!.costMicroUsd).toBeGreaterThan(0)
    expect(row!.costEstimated).toBe(true)
  })

  /**
   * 这一条才是本 PR 的目的：闸门读的是 spentToday，而 spentToday 求和的
   * 就是 cost_micro_usd。失败不记账 = 日限额永远不会触发。
   */
  it('失败的花费进得了 spentToday，闸门才看得见', async () => {
    const before = await spentToday(db, projectId)
    const row = await failWith('provider_error')
    const after = await spentToday(db, projectId)
    expect(after - before).toBe(row.costMicroUsd)
  })
})

describe('终态不被迟到的队列条目改写（Ledger 不说谎）', () => {
  /**
   * 同一个 job 可以有不止一条轮询链。没有终态守卫时，后到的那条会把已经判死
   * 的行改回 running 再写成 succeeded，留下「既成功又带 failure_code」的一行，
   * 并且每一次判死都可能让状态机再开一个 attempt——一次真实超时烧掉两三笔钱。
   */
  it('超时判死之后，第二条轮询链不再改写这一行', async () => {
    const { deps: d } = countingDeps()
    const id = await newJob()
    await handleGenerate(d, { generationJobId: id })
    const [job] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    // 永远跑不完的 provider，并让它认识这个 externalId（同上面那条超时用例的做法）
    const slow = new MockProvider({ latencyScale: 1000, failureRate: 0 })
    await slow.submit({
      requestId: job!.providerJobRef!,
      shotId,
      mode: 't2v',
      prompt: 'p',
      refImages: [],
      durationSec: 4,
      resolution: '720p',
      aspectRatio: '9:16',
      fps: 24,
      safetyProfile: 'standard',
      priority: 'normal',
      providerParams: {},
    })
    const stalled = { ...deps, providers: [slow] }
    const args = {
      generationJobId: id,
      providerId: 'mock',
      externalId: job!.providerJobRef!,
      submittedAt: Date.now() - 20 * 60 * 1000,
      pollCount: 3,
    }

    expect(await handlePoll(stalled, args)).toBe('timeout')
    const [first] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    // 第二条链撞上终态守卫，一个字段都不该被改
    expect(await handlePoll(stalled, args)).toBe('skipped')
    const [second] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    expect(second!.status).toBe('failed')
    expect(second!.finishedAt?.getTime()).toBe(first!.finishedAt?.getTime())
    expect(second!.failureCode).toBe('timeout')
  })

  it('迟到的 ingest 不会把判死的行改写成 succeeded', async () => {
    const { deps: d } = countingDeps()
    const id = await newJob()
    await handleGenerate(d, { generationJobId: id })
    const [job] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    const res = await provider.poll({
      providerId: 'mock',
      externalId: job!.providerJobRef!,
      submittedAt: Date.now() - 10,
    })
    if (res.status !== 'succeeded') throw new Error('mock 应当成功')

    // 先把它判死，模拟另一条链已经超时
    await db
      .update(s.generationJobs)
      .set({ status: 'failed', failureCode: 'timeout', finishedAt: new Date() })
      .where(eq(s.generationJobs.id, id))

    const out = await handleIngest(
      { db, storage },
      { generationJobId: id, shotId, projectId, sourceUrl: res.outputUrl },
    )

    // 产物照建不误（钱已经花了，不销毁），但 job 不复活、状态机不推进
    expect(out.settled).toBe(false)
    expect(out.takeId).toBeTruthy()
    const [row] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(row!.status).toBe('failed')
    expect(row!.accepted).not.toBe(true)
  })
})

describe('幂等（崩溃恢复整个建立在这条上）', () => {
  it('UNIQUE(shot_id, attempt) 在数据库层挡住重复的尝试', async () => {
    const attempt = nextAttempt()
    await createGenerationJob(db, {
      shotId,
      attempt,
      providerId: 'mock',
      modelId: 'm',
      mode: 't2v',
      promptText: 'p',
    })
    await expect(
      createGenerationJob(db, {
        shotId,
        attempt,
        providerId: 'mock',
        modelId: 'm',
        mode: 't2v',
        promptText: 'p',
      }),
    ).rejects.toThrow()
  })

  /**
   * 提交成功之后的重放走 providerJobRef 那条早退分支，转轮询而不是重新提交。
   *
   * 注意断言里的 `submits()`：这个文件此前那版只断言 providerJobRef 前后相等，
   * 而 providerJobRef 恒等于 job.id（buildRequest 用 requestId: job.id，mock 又
   * 把 externalId 设成 requestId），所以 submit 被调两次它照样绿——等于没测。
   */
  it('提交成功后重放 generate 只转轮询，不二次提交', async () => {
    const { deps: d, submits } = countingDeps()
    const id = await newJob()
    await handleGenerate(d, { generationJobId: id })
    const [after1] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    // 模拟崩溃后重放
    const r2 = await handleGenerate(d, { generationJobId: id })
    const [after2] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    expect(r2).toBe('skipped') // 已有 providerJobRef，直接转轮询
    expect(submits()).toBe(1)
    expect(after2!.providerJobRef).toBe(after1!.providerJobRef)
  })
})

describe('提交即返回，不在 job 里等生成完成（§7.5）', () => {
  it('generate 返回后状态是 submitted 且已有 providerJobRef', async () => {
    const id = await newJob()
    const r = await handleGenerate(deps, { generationJobId: id })
    expect(r).toBe('submitted')

    const [job] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(job!.status).toBe('submitted')
    expect(job!.providerJobRef).toBeTruthy()
    expect(job!.startedAt).toBeTruthy()
  })

  it('轮询任务被排进了 q:poll，而不是在内存里挂着循环', async () => {
    const id = await newJob()
    await handleGenerate(deps, { generationJobId: id })
    const delayed = await queues.poll.getDelayed()
    expect(delayed.some((j) => j.data.generationJobId === id)).toBe(true)
  })
})

describe('自重排轮询（§4）', () => {
  it('退避是 3s → 上限 30s，不是固定间隔', () => {
    expect(pollDelayMs(0)).toBe(3000)
    expect(pollDelayMs(1)).toBeCloseTo(4200, -2)
    expect(pollDelayMs(50)).toBe(30_000) // 封顶
  })

  it('终态成功后转 q:ingest，并回填成本与延迟', async () => {
    const id = await newJob()
    await handleGenerate(deps, { generationJobId: id })
    const [job] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    const r = await handlePoll(deps, {
      generationJobId: id,
      providerId: 'mock',
      externalId: job!.providerJobRef!,
      submittedAt: Date.now() - 100,
      pollCount: 0,
    })
    expect(r).toBe('succeeded')

    const [after] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(after!.status).toBe('downloading')
    expect(after!.costMicroUsd).toBeGreaterThan(0) // null 会让整张成本报表失真
    expect(after!.latencyMs).toBeGreaterThanOrEqual(0)
  })

  /**
   * 这条路径此前是**死的**：poll() 返回的 progressPct / stage 被 handlePoll 原地
   * 丢掉，`job.progress` 从来没有人发过——契约里有、SSE 层为它写了节流、前端
   * 进度条在等它。mock 默认 latencyScale=0 会立刻跑完，所以谁也没撞见 running
   * 分支。这个测试专门用一个慢 provider 把那个分支钉住。
   */
  it('还在跑时把 provider 的进度发成 job.progress（含 stage）', async () => {
    const slow = new MockProvider({ latencyScale: 1, failureRate: 0 })
    const slowDeps = { ...deps, providers: [slow] }

    const id = await newJob()
    await handleGenerate(slowDeps, { generationJobId: id })
    const [job] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    const r = await handlePoll(slowDeps, {
      generationJobId: id,
      providerId: 'mock',
      externalId: job!.providerJobRef!,
      submittedAt: Date.now(),
      pollCount: 0,
    })
    expect(r).toBe('running')

    /*
     * 按 jobId 而非 shotId 认领事件。
     *
     * 整套测试复用同一个 shot，而 BullMQ 会保留 completed 任务——按 shotId 找
     * 会捞到上一轮跑剩的事件，于是把 publishProgress 整个删掉测试照样绿
     * （已实测）。generationJobId 每次 newJob() 都是新的，才真的钉得住这一次调用。
     */
    const queued = await queues.notify.getJobs(['waiting', 'delayed', 'completed', 'active'], 0, 500)
    const mine = queued
      .map((j) => (j.data as { payload?: Record<string, unknown> }).payload)
      .find((p) => p?.['type'] === 'job.progress' && p['jobId'] === id) as
      { pct: number; stage?: string } | undefined

    expect(mine, 'handlePoll 没有把本次轮询的进度发到 notify 队列').toBeDefined()
    expect(mine!.pct).toBeGreaterThanOrEqual(0)
    // 刚提交就轮询，必然落在加载模型那一段——这正是「0% 停很久」的场景
    expect(mine!.stage).toBe('loading_model')
  })

  it('超时会取消并标记 timeout，而不是无限轮询下去', async () => {
    const id = await newJob()
    await handleGenerate(deps, { generationJobId: id })
    const [job] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    const slow = new MockProvider({ latencyScale: 1000, failureRate: 0 })
    await slow.submit({
      requestId: job!.providerJobRef!,
      shotId,
      mode: 't2v',
      prompt: 'p',
      refImages: [],
      durationSec: 4,
      resolution: '720p',
      aspectRatio: '9:16',
      fps: 24,
      safetyProfile: 'standard',
      priority: 'normal',
      providerParams: {},
    })

    const r = await handlePoll(
      { ...deps, providers: [slow] },
      {
        generationJobId: id,
        providerId: 'mock',
        externalId: job!.providerJobRef!,
        submittedAt: Date.now() - 20 * 60 * 1000, // 20 分钟前
        pollCount: 3,
      },
    )
    expect(r).toBe('timeout')

    const [after] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(after!.failureCode).toBe('timeout')
  })
})

describe('ingest：产物落库与内容去重', () => {
  it('产物进 MinIO，建 asset + take，job 转 succeeded', async () => {
    const id = await newJob()
    await handleGenerate(deps, { generationJobId: id })
    const [job] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    const res = await provider.poll({
      providerId: 'mock',
      externalId: job!.providerJobRef!,
      submittedAt: Date.now() - 10,
    })
    if (res.status !== 'succeeded') throw new Error('mock 应当成功')

    const out = await handleIngest(
      { db, storage },
      { generationJobId: id, shotId, projectId, sourceUrl: res.outputUrl },
    )

    expect(out.assetId).toBeTruthy()
    expect(out.takeId).toBeTruthy()

    const [asset] = await db.select().from(s.assets).where(eq(s.assets.id, out.assetId))
    expect(asset!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(asset!.bytes).toBeGreaterThan(0)
    expect(await storage.exists(asset!.storageKey)).toBe(true) // 真在 MinIO 里

    const [after] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
    expect(after!.status).toBe('succeeded')
  })

  it('相同内容复用已有 asset 行，不重复建对象', async () => {
    const a = await newJob()
    const b = await newJob()
    for (const id of [a, b]) await handleGenerate(deps, { generationJobId: id })

    const outs = []
    for (const id of [a, b]) {
      const [job] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))
      const res = await provider.poll({
        providerId: 'mock',
        externalId: job!.providerJobRef!,
        submittedAt: Date.now() - 10,
      })
      if (res.status !== 'succeeded') throw new Error('应当成功')
      outs.push(
        await handleIngest(
          { db, storage },
          { generationJobId: id, shotId, projectId, sourceUrl: res.outputUrl },
        ),
      )
    }

    // 同一条 fixture → 同一个 sha256 → 同一个 asset，但两条独立的 take
    expect(outs[1]!.deduped).toBe(true)
    expect(outs[1]!.assetId).toBe(outs[0]!.assetId)
    expect(outs[1]!.takeId).not.toBe(outs[0]!.takeId)
  })
})

describe('崩溃恢复（§8）', () => {
  it('未提交的重新入队，已提交的恢复轮询而非重新提交', async () => {
    await queues.generate.drain(true)
    await queues.poll.drain(true)

    const neverSubmitted = await newJob()
    const alreadySubmitted = await newJob()
    await handleGenerate(deps, { generationJobId: alreadySubmitted })
    // 把它拨回 running 模拟「提交了但没跑完就崩了」
    await db
      .update(s.generationJobs)
      .set({ status: 'running' })
      .where(eq(s.generationJobs.id, alreadySubmitted))

    const r = await reconcileOnBoot(deps)

    expect(r.requeued).toBeGreaterThanOrEqual(1)
    expect(r.resumed).toBeGreaterThanOrEqual(1)

    const gen = await queues.generate.getJobs(['waiting', 'delayed', 'prioritized'])
    expect(gen.some((j) => j.data.generationJobId === neverSubmitted)).toBe(true)

    const pol = await queues.poll.getJobs(['waiting', 'delayed', 'prioritized'])
    expect(pol.some((j) => j.data.generationJobId === alreadySubmitted)).toBe(true)
  })
})

describe('provider 配额信号量是跨进程的（§3 第 ② 层）', () => {
  it('超过上限拿不到槽位，释放后可再拿', async () => {
    await reset(redis, 'testp')
    expect(await tryAcquire(redis, 'testp', 2)).toBe(true)
    expect(await tryAcquire(redis, 'testp', 2)).toBe(true)
    expect(await tryAcquire(redis, 'testp', 2)).toBe(false) // 满了
    expect(await inFlight(redis, 'testp')).toBe(2)

    await release(redis, 'testp')
    expect(await tryAcquire(redis, 'testp', 2)).toBe(true)
    await reset(redis, 'testp')
  })

  it('重复 release 不会把计数减成负数', async () => {
    await reset(redis, 'testp2')
    await release(redis, 'testp2')
    await release(redis, 'testp2')
    expect(await inFlight(redis, 'testp2')).toBe(0)
    await reset(redis, 'testp2')
  })
})

describe('BullMQ 真的能用（msgpackr 原生模块未编译的验证）', () => {
  it('入队 → 取回，负载完整', async () => {
    await queues.ingest.drain(true)
    await queues.ingest.add('probe', {
      generationJobId: 'g',
      shotId: 's',
      projectId: 'p',
      sourceUrl: '/tmp/x.mp4',
    })
    const jobs = await queues.ingest.getJobs(['waiting', 'prioritized'])
    expect(jobs.some((j) => j.data.sourceUrl === '/tmp/x.mp4')).toBe(true)
    await queues.ingest.drain(true)
  })
})
