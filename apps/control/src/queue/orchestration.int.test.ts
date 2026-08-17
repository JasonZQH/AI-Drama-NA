import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../db/client.js'
import * as s from '../db/schema.js'
import { MockProvider } from '../providers/mock.js'
import { Storage, s3Key, storageFromEnv } from '../storage/s3.js'
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
import { spentToday, spentTodayForShot } from '../pipeline/batch.js'
import { applyShotTransition, type TransitionQueues } from '../pipeline/applyTransition.js'
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

/**
 * 第二个连接池，专给并发用例。
 *
 * **不能只靠一个池 + `Promise.all`**：postgres.js 会把并发查询串到同一条连接上
 * 顺序执行，于是第二个调用在读的时候已经看得见第一个的结果——这样的用例把被测
 * 逻辑整个删掉也照样绿（PR-A 实测过一次，见「每行至多 submit 一次」那组的注释）。
 * 两个池 = 两条 TCP 连接 = 两个真正并行的 Postgres 事务。
 */
const other = createDb(DB_URL, 1)
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

// providers 显式标成 VideoProvider[]：不标的话会被推断成 MockProvider[]，
// 于是 countingDeps() 那个包装器（返回的是 VideoProvider）赋不进去
const deps = { db, redis, queues, providers: [provider] as VideoProvider[], maxAttempts: 4 }

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
  await other.client.end()
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

describe('状态迁移是原子的（同一镜头不会被并发付两次钱）', () => {
  const tdeps = (d: typeof db) => ({ db: d, queues, provider, maxAttempts: 4 })

  const countJobs = async (): Promise<number> =>
    (
      await db
        .select({ id: s.generationJobs.id })
        .from(s.generationJobs)
        .where(eq(s.generationJobs.shotId, shotId))
    ).length

  /** 把 attemptCount 落在本文件的号段里，免得建出的 job 撞别的测试文件 */
  async function armShot(attemptCount: number): Promise<void> {
    await db
      .update(s.shots)
      .set({ status: 'ready', attemptCount, selectedTakeId: null })
      .where(eq(s.shots.id, shotId))
  }

  /**
   * 行锁本身。**这条才是本 PR 的防退化网。**
   *
   * 不要指望「两个 Promise.all 的迁移」能把竞态跑出来——实测两个独立连接池
   * 也造不出危险交错，把 `.for('update')` 整个删掉，那种写法照样绿
   * （probe 实测：有锁无锁的 results 与 jobs 完全一致）。同样的坑 PR-A 踩过一次。
   *
   * 所以直接钉机制：一个连接持锁不放，另一个的迁移必须被挡住；放锁之后
   * 它才能继续，并且此时读到的是**提交后的新状态**，于是被状态机干净拒绝。
   */
  it('shot 行被锁住时，迁移要等锁释放并读到提交后的新状态', async () => {
    await armShot(TEST_ATTEMPT_BASE + 80)

    let unlock!: () => void
    const holding = new Promise<void>((r) => (unlock = r))
    // A 持锁 + 改状态，模拟「另一个请求正在做一次迁移」，故意不提交
    const holder = db.transaction(async (tx) => {
      await tx.select().from(s.shots).where(eq(s.shots.id, shotId)).for('update')
      await tx.update(s.shots).set({ status: 'generating' }).where(eq(s.shots.id, shotId))
      await holding
    })
    await new Promise((r) => setTimeout(r, 150)) // 确保锁真的拿到了

    const bDone = applyShotTransition(tdeps(other.db), shotId, { type: 'generate.requested' })
    const raced = await Promise.race([
      bDone.then(() => 'finished' as const),
      new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 400)),
    ])
    expect(raced).toBe('blocked')

    unlock()
    await holder

    /*
     * 这一条断言才是区分点，「被阻塞」本身不是——没有 FOR UPDATE 时 B 的 SELECT
     * 立刻读到旧的 'ready'，随后仍会卡在自己的 UPDATE 上，所以照样表现为「阻塞」。
     * 差别在醒来之后：读了锁才会看到提交后的 'generating' 并干净拒绝；
     * 没读锁则是拿着陈旧状态继续往下走——建一行 job（一笔钱）再把状态覆盖回去。
     */
    await expect(bDone).resolves.toMatchObject({ ok: false, from: 'generating' })
    await queues.generate.drain(true)
  })

  /**
   * 端到端的那一面：并发两次生成只该建一行 job。
   *
   * 坦白说这条**不区分**有没有行锁——两个调用即便都通过状态机，
   * `UNIQUE(shot_id, attempt)` 也会兜住第二次（两边读到同一个 attemptCount，
   * 算出同一个号）。留着是因为它断言的是最终结果，而上面那条断言的是机制；
   * 真正的防退化靠上面那条。
   */
  it('并发 generate.requested：只建一行 job，另一个被状态机干净拒绝', async () => {
    await armShot(TEST_ATTEMPT_BASE + 50)
    const before = await countJobs()

    const [a, b] = await Promise.all([
      applyShotTransition(tdeps(db), shotId, { type: 'generate.requested' }),
      applyShotTransition(tdeps(other.db), shotId, { type: 'generate.requested' }),
    ])

    expect((await countJobs()) - before, '同一镜头并发生成建了两行 = 付了两次钱').toBe(1)

    const ok = [a, b].filter((r) => r?.ok)
    const rejected = [a, b].filter((r) => r !== null && !r.ok)
    expect(ok).toHaveLength(1)
    // 干净拒绝，而不是唯一约束抛出的裸 pg 错（那会变成 500）
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ ok: false, from: 'generating' })

    await queues.generate.drain(true)
  })

  it('并发 take.selected：只有一个能锁定，另一个从 locked 被拒', async () => {
    await armShot(TEST_ATTEMPT_BASE + 60)
    /*
     * 两个候选来自**两次不同的生成尝试**——`UNIQUE(takes.job_id)` 之后这不再是
     * 风格问题而是硬约束：一个 job 至多一条 take。此前这里用同一个 jobId 建两条，
     * 模拟的是一个现实中不可能存在的状态，加上约束后立刻被数据库拒掉。
     */
    const jobA = await newJob()
    const jobB = await newJob()
    /*
     * 自己建 asset，**不要借用库里现成的**。
     *
     * 上一版写的是 `select().from(s.assets).limit(1)`，本地能过是因为库里有前几轮
     * ingest 用例的残留；CI 每次起新库，而建 asset 的那组用例排在本 describe
     * 之后——于是这条用例在 CI 上必挂。隐藏的跨 describe 顺序依赖，正是这个
     * 文件其他地方一直在避免的东西。
     */
    const [asset] = await db
      .insert(s.assets)
      .values({
        projectId,
        kind: 'video',
        storageKey: `test/transition-atomic/${jobA}.mp4`,
        mime: 'video/mp4',
        bytes: 1,
        sha256: 'f'.repeat(64),
        producedBy: 'generation',
      })
      .returning({ id: s.assets.id })

    const takes = await db
      .insert(s.takes)
      .values([
        { shotId, jobId: jobA, assetId: asset!.id, status: 'candidate' },
        { shotId, jobId: jobB, assetId: asset!.id, status: 'candidate' },
      ])
      .returning({ id: s.takes.id })
    await db.update(s.shots).set({ status: 'review' }).where(eq(s.shots.id, shotId))

    const [a, b] = await Promise.all([
      applyShotTransition(tdeps(db), shotId, { type: 'take.selected', takeId: takes[0]!.id }),
      applyShotTransition(tdeps(other.db), shotId, { type: 'take.selected', takeId: takes[1]!.id }),
    ])

    expect([a, b].filter((r) => r?.ok)).toHaveLength(1)
    const [shot] = await db.select().from(s.shots).where(eq(s.shots.id, shotId))
    expect(shot!.status).toBe('locked')
    // 选中的必须是赢的那一个，不能是两次写互相覆盖后的残留
    expect([takes[0]!.id, takes[1]!.id]).toContain(shot!.selectedTakeId)

    await db.delete(s.takes).where(
      inArray(
        s.takes.id,
        takes.map((t) => t.id),
      ),
    )
    await db.delete(s.assets).where(eq(s.assets.id, asset!.id))
  })

  /**
   * 入队必须在事务提交之后。
   *
   * 在事务里发的话，回滚时队列条目不会跟着回滚——留下一条指向不存在的
   * generation_jobs 行的任务。这里用唯一约束把事务打回来，断言队列干净。
   */
  it('事务回滚时不留下队列条目', async () => {
    const attempt = TEST_ATTEMPT_BASE + 70
    await armShot(attempt - 1) // 于是状态机会算出 attempt 这个号
    // 先占掉这个号，让事务里的 INSERT 撞唯一约束
    await createGenerationJob(db, {
      shotId,
      attempt,
      providerId: 'mock',
      modelId: 'mock-v1',
      mode: 't2v',
      promptText: 'occupied',
    })
    await queues.generate.drain(true)

    await expect(applyShotTransition(tdeps(db), shotId, { type: 'generate.requested' })).rejects.toThrow()

    const queued = await queues.generate.getJobs(['waiting', 'delayed', 'prioritized', 'active'])
    expect(
      queued.filter((j) => j.data.shotId === shotId),
      '回滚了却留下队列条目',
    ).toHaveLength(0)

    // 状态机没跑完，镜头必须还在原地
    const [shot] = await db.select().from(s.shots).where(eq(s.shots.id, shotId))
    expect(shot!.status).toBe('ready')
  })

  /**
   * 入队在事务**之后**这件事，靠上一条测不出来——那里唯一约束是在入队之前就抛的，
   * 两种写法都走不到入队。所以反过来验：让入队自己失败。
   *
   * - 入队在事务里 → 抛出发生在事务内 → 回滚 → **一行 job 都不该有**
   * - 入队在提交后 → 事务已落地 → job 行在、shot 已迁移，只是队列里没条目
   *
   * 后者正是我们要的：钱的账先落库，队列条目丢了由 reconcileOnBoot 捞回来
   * （它的第一个分支就负责 queued + provider_job_ref 为空的行）。反过来
   * 「因为 Redis 抖了就把已经决定好的状态迁移一起丢掉」要难恢复得多。
   */
  it('入队失败不回滚已提交的迁移——那正是 reconcile 负责的窗口', async () => {
    await armShot(TEST_ATTEMPT_BASE + 75)
    const before = await countJobs()

    const brokenQueues: TransitionQueues = {
      generate: { add: () => Promise.reject(new Error('redis 抖了')) },
      notify: queues.notify,
    }

    await expect(
      applyShotTransition({ ...tdeps(db), queues: brokenQueues }, shotId, { type: 'generate.requested' }),
    ).rejects.toThrow()

    expect((await countJobs()) - before, '入队失败不该把已经提交的 job 行也回滚掉').toBe(1)
    const [shot] = await db.select().from(s.shots).where(eq(s.shots.id, shotId))
    expect(shot!.status).toBe('generating')
  })

  afterAll(async () => {
    await db
      .update(s.shots)
      .set({ status: 'ready', attemptCount: 0, selectedTakeId: null })
      .where(eq(s.shots.id, shotId))
  })
})

describe('预算闸门下沉到唯一花钱入口', () => {
  const tdeps = (over: Partial<Parameters<typeof applyShotTransition>[0]> = {}) => ({
    db,
    queues,
    provider,
    maxAttempts: 4,
    ...over,
  })

  async function armShot(attemptCount: number): Promise<void> {
    await db
      .update(s.shots)
      .set({ status: 'ready', attemptCount, selectedTakeId: null })
      .where(eq(s.shots.id, shotId))
  }

  const lastJob = async () =>
    (
      await db
        .select()
        .from(s.generationJobs)
        .where(eq(s.generationJobs.shotId, shotId))
        .orderBy(desc(s.generationJobs.createdAt))
        .limit(1)
    )[0]

  /**
   * 在途预留。**没有它闸门等于没有**：`spentTodayForShot` 求和的是
   * `cost_micro_usd`，而排队中的任务此前这一列是 NULL——一次批量把 12 个镜头
   * 全排进去时账面仍是 0，闸门看到的永远是「还没花钱」。
   */
  it('排队中的任务立刻占额度，且标成估算', async () => {
    await armShot(TEST_ATTEMPT_BASE + 85)
    const before = await spentTodayForShot(db, shotId)

    expect((await applyShotTransition(tdeps(), shotId, { type: 'generate.requested' }))?.ok).toBe(true)

    expect(await spentTodayForShot(db, shotId), '还没提交就该开始占额度').toBeGreaterThan(before)
    const job = await lastJob()
    expect(job!.status).toBe('queued') // 确实还没提交
    expect(job!.costMicroUsd).toBeGreaterThan(0)
    expect(job!.costEstimated).toBe(true)
    await queues.generate.drain(true)
  })

  /**
   * 单镜路径此前**完全裸奔**——闸门只挂在 `/generate-batch` 一条路由上。
   * 下沉之后它和批量、和 fail() 的自动重试走同一道闸。
   */
  it('单镜生成也过闸门：超限时拒绝，且一行 job 都不建', async () => {
    await armShot(TEST_ATTEMPT_BASE + 86)
    const before = (await db.select({ id: s.generationJobs.id }).from(s.generationJobs)).length

    const r = await applyShotTransition(
      tdeps({ budget: { dailyLimitMicroUsd: 1, onExceed: 'block' } }),
      shotId,
      { type: 'generate.requested' },
    )

    expect(r).toMatchObject({ ok: false, code: 'BUDGET_EXCEEDED' })
    expect((await db.select({ id: s.generationJobs.id }).from(s.generationJobs)).length).toBe(before)
    // 被拦下时镜头留在原地，加了额度就能再发起
    const [shot] = await db.select().from(s.shots).where(eq(s.shots.id, shotId))
    expect(shot!.status).toBe('ready')
  })

  /** 08 §2：warn 是警告不是家长控制，决定权在用户 */
  it('warn 模式下超限也放行', async () => {
    await armShot(TEST_ATTEMPT_BASE + 87)
    const r = await applyShotTransition(
      tdeps({ budget: { dailyLimitMicroUsd: 1, onExceed: 'warn' } }),
      shotId,
      { type: 'generate.requested' },
    )
    expect(r?.ok).toBe(true)
    await queues.generate.drain(true)
  })

  afterAll(async () => {
    await db
      .update(s.shots)
      .set({ status: 'ready', attemptCount: 0, selectedTakeId: null })
      .where(eq(s.shots.id, shotId))
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

  /**
   * 一个 job 至多一条 take。
   *
   * 同一个 job 可以有不止一条轮询链（reconcileOnBoot 会为非终态行再加一条，
   * 旧链自重排不会消失），两条都会投 ingest；BullMQ 在 handler 抛错时又会重放
   * 整个 handler。所以这条不能只靠应用层，`UNIQUE(takes.job_id)` 是最后一道。
   *
   * 代价不只是多一行脏数据：一笔已付费的生成产出两条候选，选片池被污染，
   * usdPerAcceptedMicro 的分母跟着多算——每可用镜头成本被系统性低估。
   */
  it('同一个 job 重复 ingest 只产出一条 take', async () => {
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

    const first = await handleIngest(
      { db, storage },
      { generationJobId: id, shotId, projectId, sourceUrl: res.outputUrl },
    )
    // 第二条轮询链投来的同一个 ingest
    const second = await handleIngest(
      { db, storage },
      { generationJobId: id, shotId, projectId, sourceUrl: res.outputUrl },
    )

    expect(second.takeId, '重复 ingest 该回同一条 take，而不是新建一条').toBe(first.takeId)
    const takes = await db.select().from(s.takes).where(eq(s.takes.jobId, id))
    expect(takes).toHaveLength(1)
  })

  /**
   * 先算哈希查重、命中就不传。
   *
   * 原来是反的（先 putFile 到唯一 key 再按 sha 查重），命中时刚上传的那个对象
   * 就成了孤儿——没人引用也没人清理，而系统永不自动销毁字节。mock 每次返回
   * 同一条 fixture，所以这条路径每跑一次就多一个孤儿。
   */
  it('内容命中已有 asset 时根本不上传，不留孤儿对象', async () => {
    const { deps: d } = countingDeps()

    // 先跑一次，让这条 fixture 的 sha 已经在库里
    const a = await newJob()
    await handleGenerate(d, { generationJobId: a })
    const [ja] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, a))
    const ra = await provider.poll({
      providerId: 'mock',
      externalId: ja!.providerJobRef!,
      submittedAt: Date.now() - 10,
    })
    if (ra.status !== 'succeeded') throw new Error('mock 应当成功')
    await handleIngest({ db, storage }, { generationJobId: a, shotId, projectId, sourceUrl: ra.outputUrl })

    // 第二个 job 拿到同样的字节：应当复用 asset，且**它自己的 key 不该存在**
    const b = await newJob()
    await handleGenerate(d, { generationJobId: b })
    const [jb] = await db.select().from(s.generationJobs).where(eq(s.generationJobs.id, b))
    const rb = await provider.poll({
      providerId: 'mock',
      externalId: jb!.providerJobRef!,
      submittedAt: Date.now() - 10,
    })
    if (rb.status !== 'succeeded') throw new Error('mock 应当成功')

    const out = await handleIngest(
      { db, storage },
      { generationJobId: b, shotId, projectId, sourceUrl: rb.outputUrl },
    )

    expect(out.deduped).toBe(true)
    const orphanKey = s3Key.take(projectId, shotId, b)
    expect(await storage.exists(orphanKey), '命中去重却还是传了一份，留下孤儿对象').toBe(false)
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

describe('渲染的崩溃恢复', () => {
  /**
   * `renderEpisode` 是同步等 media worker 的，所以进程一死，那行 render_jobs
   * 就永远停在 running——没人再碰它，而 `GET /api/watch/:id` 只认 succeeded 的
   * 母版，那一集在面板上永远转圈。
   *
   * 与生成不同，这里没有「可能已计费」的两难：重渲染不花钱，母版只增不改，
   * 所以直接判失败让人重来。
   */
  it('reconcile 把渲染途中重启留下的 running 判失败并写明原因', async () => {
    const [ep] = await db.select({ id: s.episodes.id }).from(s.episodes).limit(1)

    /*
     * 占一个保留的 version 号，并且**先删后建**。
     *
     * `timelines` 上有 UNIQUE(episode_id, version)，version 默认 1。用默认值的话
     * 只要本用例失败过一次（cleanup 没跑到），下一轮插入就撞唯一约束——测试从
     * 「断言失败」退化成「根本跑不起来」。这个文件对 attempt 号已经用了同一套
     * 号段约定，version 照抄。
     */
    const TEST_VERSION = TEST_ATTEMPT_BASE
    await db
      .delete(s.renderJobs)
      .where(
        inArray(
          s.renderJobs.timelineId,
          db.select({ id: s.timelines.id }).from(s.timelines).where(eq(s.timelines.version, TEST_VERSION)),
        ),
      )
    await db.delete(s.timelines).where(eq(s.timelines.version, TEST_VERSION))

    const [tl] = await db
      .insert(s.timelines)
      .values({ episodeId: ep!.id, version: TEST_VERSION })
      .returning({ id: s.timelines.id })
    const [orphan] = await db
      .insert(s.renderJobs)
      .values({ timelineId: tl!.id, status: 'running', startedAt: new Date() })
      .returning({ id: s.renderJobs.id })

    const r = await reconcileOnBoot(deps)
    expect(r.staleRenders).toBeGreaterThanOrEqual(1)

    const [after] = await db.select().from(s.renderJobs).where(eq(s.renderJobs.id, orphan!.id))
    expect(after!.status).toBe('failed')
    expect(after!.ffmpegLog, '得告诉人这不是渲染本身失败，是重启').toContain('重启')
    expect(after!.finishedAt).not.toBeNull()

    await db.delete(s.renderJobs).where(eq(s.renderJobs.id, orphan!.id))
    await db.delete(s.timelines).where(eq(s.timelines.id, tl!.id))
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
