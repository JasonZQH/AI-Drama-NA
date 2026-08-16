import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../db/client.js'
import * as s from '../db/schema.js'
import { MockProvider } from '../providers/mock.js'
import { Storage, storageFromEnv } from '../storage/s3.js'
import { handleIngest, createGenerationJob } from './ingest.js'
import { handleGenerate, handlePoll, reconcileOnBoot } from './orchestrator.js'
import { createConnection, createQueues, pollDelayMs } from './queues.js'
import { inFlight, release, reset, tryAcquire } from './semaphore.js'

/**
 * 集成测试：跑在**真实的** Redis + Postgres + MinIO 上。
 *
 * 这一层的 bug（幂等、恢复、限流）在单测里几乎不可见，在生产上会表现为
 * 「莫名其妙多扣了钱」或「任务卡死」，事后极难排查（11-dev-setup.md §9）。
 * 所以它必须打真实依赖，不能 mock 掉。
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://drama:drama@localhost:5433/drama'
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

  it('同一个 job 重复走 generate 不会二次提交给 provider', async () => {
    const id = await newJob()
    await handleGenerate(deps, { generationJobId: id })
    const [after1] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    // 模拟崩溃后重放
    const r2 = await handleGenerate(deps, { generationJobId: id })
    const [after2] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, id))

    expect(r2).toBe('skipped') // 已有 providerJobRef，直接转轮询
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
