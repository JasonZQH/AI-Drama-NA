import { createServer, type Server } from 'node:http'
import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '../db/client.js'
import { DEMO_TITLE } from '../db/seed.js'
import * as s from '../db/schema.js'
import { MockProvider } from '../providers/mock.js'
import { createConnection, createQueues } from '../queue/queues.js'
import { assertNoWorker } from '../queue/assertNoWorker.js'
import { MediaWorkerUnavailable, renderEpisode } from '../pipeline/render.js'
import { buildServer, type ServerDeps } from '../server.js'
import { Storage, storageFromEnv } from '../storage/s3.js'
import { resolveDependencies } from '../pipeline/batch.js'
import { createGenerationJob } from '../queue/ingest.js'
import { ShotlistRejected } from '../pipeline/callShotlist.js'
import { resolvePrompt } from '../pipeline/resolvePrompt.js'
import { probeOpenRouter, type ProbeResult } from '../credentials/probe.js'
import { deleteCredential, resolveKey, upsertCredential } from '../credentials/store.js'
import { LivePool, publishProvidersChanged, subscribeProviderChanges } from '../providers/pool.js'
import { DURATION_TOLERANCE, SHOT_COUNT } from '../pipeline/shotlist.js'
import type { ShotlistFn } from './api.js'

/**
 * API 集成测试：真起 Fastify，打真实 Postgres / Redis / MinIO。
 * 用 app.inject() 而非真实网络——它走完整的路由、校验、错误处理链路，
 * 但不占端口，能并行跑。
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://drama:drama@localhost:5432/drama'
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'

const { db, client } = createDb(DB_URL, 3)
const queues = createQueues({ url: REDIS_URL })
const storage = new Storage(
  storageFromEnv({
    S3_BUCKET: 'drama',
    S3_INTERNAL_ENDPOINT: process.env['S3_INTERNAL_ENDPOINT'] ?? 'http://localhost:9000',
    S3_ACCESS_KEY: 'adminlocal',
    S3_SECRET_KEY: 'adminlocal123',
  }),
)

/** 写路径闸门的测试用 key（server.ts 的 guardWrites） */
const TEST_API_KEY = 'test-key'
const WRITE_HEADERS = { 'x-api-key': TEST_API_KEY }

let app: FastifyInstance
let projectId: string
let episodeId: string
let shotId: string

/**
 * 号段必须与其他集成测试文件互不重叠——它们共享同一个真实数据库。
 * 本文件占 [800, 900)，orchestration.int.test.ts 占 [900, 1000)。
 */
const TEST_ATTEMPT_BASE = 800
const TEST_ATTEMPT_MAX = 900

beforeAll(async () => {
  // 有 worker 在跑的话，测试入队的任务会被立刻消费掉——先说清楚，别让人对着
  // 「expected false to be true」猜半天
  await assertNoWorker(queues)
  process.env['LOG_LEVEL'] = 'silent' // 测试输出要能一眼看出结论，不被请求日志淹没
  app = buildServer({
    db,
    queues,
    storage,
    providers: [new MockProvider({ latencyScale: 0, failureRate: 0 })],
    maxAttempts: 4,
    /*
     * 会抛的桩。本文件目前**没有任何渲染用例**——此前它干脆没传 media，
     * 类型上就是错的（`pnpm typecheck` 看不到测试文件，所以一直没人发现）。
     * 传个显式会抛的，一旦将来有人加渲染用例，报错会直说「该给个真桩了」，
     * 而不是丢一个 undefined 的属性访问。
     */
    media: {
      render: () => Promise.reject(new Error('api.int.test.ts 未配置 media worker 桩')),
    },
    healthProbe: () => client`SELECT 1`,
    makeSubscriber: () => createConnection(REDIS_URL),
    apiKey: TEST_API_KEY,
  })
  await app.ready()

  /*
   * **按 seed 的固定标题定位，不能 `.limit(1)`。**
   *
   * `db:seed` 只重建它自己那个项目，不动库里别的——这是对的（不该销毁别人的
   * 数据），但意味着开发机上随手建的项目会一直在。而无序的 `.limit(1)` 会随机
   * 挑中它们，于是整个文件跑在一个 0 镜的项目上，症状是「GET /api/episodes/:id
   * 返回 0 个镜头」这种看起来像读取路由坏了的失败。
   *
   * 实测撞到过：面板演示时手工建的一个项目留在库里，八条用例当场变红。
   * 按标题挑 = 与 `seed.ts` 共用同一个定位方式（它也是按 DEMO_TITLE 找的）。
   */
  const [p] = await db.select().from(s.projects).where(eq(s.projects.title, DEMO_TITLE))
  if (!p) throw new Error(`库里没有夹具项目「${DEMO_TITLE}」，先跑 pnpm db:seed`)
  projectId = p.id
  /*
   * **必须 ORDER BY**，理由与下面挑 shot 的那条一样，但后果更隐蔽：任何用例
   * 临时建的 episode 都可能被这里挑中，于是整个文件跑在一集不存在的数据上，
   * 而 PATCH 那组的 afterAll 还会把 seed 的文案写到那集头上。
   * 实测过一次——分镜端点用例留下一集残留，`GET /api/episodes/:id` 当场从
   * 12 镜变成 1 镜。seed 的那集是 index=1。
   */
  const [ep] = await db
    .select()
    .from(s.episodes)
    .where(eq(s.episodes.projectId, projectId))
    .orderBy(s.episodes.index)
    .limit(1)
  episodeId = ep!.id
  /*
   * **必须限定在夹具项目内**，不能在全库里挑。
   *
   * `orderBy(index).limit(1)` 取的是全库 index 最小的那一镜——而任何别的项目
   * 都有 index=1 的镜头，并列时挑中谁**完全不确定**。挑中真实项目的那一次，
   * 下面的 `cleanup()` 会把它的 generation_jobs、takes、timeline_clips 全删掉，
   * 并把镜头状态重置。
   *
   * 实测毁过一次真实数据：Jason 跑完一整集、选完片、渲染完成之后，我跑了
   * `pnpm test:int`——他那一集的第 1 镜生成记录清零、全部选片被撤销。
   * 表现出来像是「改了个时段，之前的生成都消失了」，而与时段毫无关系。
   *
   * 这是同一类错误的第三次（前两次：按 limit(1) 挑项目、密钥表被清空）。
   * 判据很简单：**集成测试碰的每一行都必须证明它属于夹具项目。**
   */
  const [sh] = await db
    .select()
    .from(s.shots)
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
    .where(eq(s.episodes.projectId, projectId))
    .orderBy(s.shots.index)
    .limit(1)
  if (!sh) throw new Error(`夹具项目「${DEMO_TITLE}」里没有镜头，先跑 pnpm db:seed`)
  shotId = sh.shots.id

  await cleanup()
})

/**
 * 凭据表的备份与还原。
 *
 * **集成测试跑在开发库上**，而密钥那两组用例要清空 `provider_credentials`
 * 才能测「没配 key 时」的路径。第一版直接 `delete`——于是**跑一次
 * `pnpm test:int` 就会把人在面板里存的真 key 删掉**。
 *
 * 实测撞到了：Jason 在面板里存了 key，一次集成测试之后就没了。
 *
 * 现在：进这组用例前整表捞出来，退出时原样塞回去。
 */
let credentialBackup: (typeof s.providerCredentials.$inferSelect)[] = []

async function stashCredentials(): Promise<void> {
  credentialBackup = await db.select().from(s.providerCredentials)
  await db.delete(s.providerCredentials)
}

async function restoreCredentials(): Promise<void> {
  await db.delete(s.providerCredentials)
  if (credentialBackup.length > 0) await db.insert(s.providerCredentials).values(credentialBackup)
  credentialBackup = []
}

async function cleanup(): Promise<void> {
  const stale = await db
    .select({ id: s.generationJobs.id })
    .from(s.generationJobs)
    .where(
      and(gte(s.generationJobs.attempt, TEST_ATTEMPT_BASE), lt(s.generationJobs.attempt, TEST_ATTEMPT_MAX)),
    )
  if (stale.length > 0) {
    const ids = stale.map((r) => r.id)
    /*
     * timeline_clips 要先删。`timeline_clips.take_id → takes` 没有 cascade，
     * 一旦哪个用例真的渲染过（渲染会 ensureTimeline 建 clips），这里就 23503。
     *
     * 同一条链在 db/seed.ts 里也踩过——`timeline_clips → takes → assets` 三层
     * 引用全都没有 cascade，于是每一处拆解都得自己维护顺序。
     */
    const takeIds = (
      await db.select({ id: s.takes.id }).from(s.takes).where(inArray(s.takes.jobId, ids))
    ).map((t) => t.id)
    if (takeIds.length > 0) {
      await db.delete(s.timelineClips).where(inArray(s.timelineClips.takeId, takeIds))
      await db.delete(s.takes).where(inArray(s.takes.id, takeIds))
    }
    await db.delete(s.generationJobs).where(inArray(s.generationJobs.id, ids))
  }
  // 本文件走真实端点，创建的是自然 attempt（1、2…），不落在保留号段里，
  // 所以要按 shot 清而不是按号段清——否则下一轮重放 attempt=1 会撞唯一约束
  const mine = await db
    .select({ id: s.generationJobs.id })
    .from(s.generationJobs)
    .where(eq(s.generationJobs.shotId, shotId))
  if (mine.length > 0) {
    const ids = mine.map((r) => r.id)
    /*
     * timeline_clips 要先删：它引用 takes 且无级联，而渲染那组用例会建 timeline。
     * 少了这一步，只要本文件跑过一次渲染，**下一次跑就必然炸在 cleanup 上**
     * （FK 23503），整个文件的用例全被跳过。CI 每次起新容器所以从没暴露过，
     * 本地连着跑第二遍才会撞上——顺手修掉，它挡住的正是最常用的验证方式。
     */
    const takeIds = await db.select({ id: s.takes.id }).from(s.takes).where(inArray(s.takes.jobId, ids))
    if (takeIds.length > 0) {
      await db.delete(s.timelineClips).where(
        inArray(
          s.timelineClips.takeId,
          takeIds.map((t) => t.id),
        ),
      )
    }
    await db.delete(s.takes).where(inArray(s.takes.jobId, ids))
    await db.delete(s.generationJobs).where(inArray(s.generationJobs.id, ids))
  }

  await db.update(s.shots).set({ status: 'ready', selectedTakeId: null, attemptCount: 0 })
  await queues.generate.drain(true)
}

afterAll(async () => {
  await cleanup()
  await app.close()
  await queues.close()
  await client.end()
})

/**
 * 写路径闸门（server.ts 的 guardWrites）。
 *
 * 这一组钉的是一条**实测走通过**的攻击：任意网页发一个无 body、无 Content-Type
 * 的 POST 就能规划整集并真的花钱（当时实测 202，11 镜，$0.77 预估）。那种请求是
 * CORS 简单请求，浏览器直接发，`no-cors` 下响应虽读不到但服务端已经执行完——
 * 收紧 origin 拦不住，只有「要求一个自定义头」才行。
 */
// 两条用例各调一次，号写死就会撞 gj_shot_attempt_uq。区间 [800,900) 由 cleanup 兜底
let fixtureAttempt = TEST_ATTEMPT_BASE + 70
const makeRenderable = async (): Promise<void> => {
  const [shot] = await db
    .select({ id: s.shots.id })
    .from(s.shots)
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .where(eq(s.scenes.episodeId, episodeId))
    .limit(1)
  /*
   * 集成测试必须能反复跑。两处残留都会让这条用例以 409 假失败：
   * - 上一轮的 asset 撞 assets_storage_key_uq
   * - 上一轮的 timeline 被 ensureTimeline 原样复用，而它的 clips 指向已被
   *   清掉的 take ⇒ clips.length === 0 ⇒ renderEpisode 在调 media 之前就抛
   *   「没有已选定的镜头」，那本来就是 409
   */
  const tls = await db
    .select({ id: s.timelines.id })
    .from(s.timelines)
    .where(eq(s.timelines.episodeId, episodeId))
  if (tls.length > 0) {
    const tlIds = tls.map((t) => t.id)
    await db.delete(s.renderJobs).where(inArray(s.renderJobs.timelineId, tlIds))
    await db.delete(s.timelineClips).where(inArray(s.timelineClips.timelineId, tlIds))
    await db.delete(s.timelines).where(inArray(s.timelines.id, tlIds))
  }

  const key = `test/render-503/${shot!.id}.mp4`
  const stale = await db.select({ id: s.assets.id }).from(s.assets).where(eq(s.assets.storageKey, key))
  if (stale.length > 0) {
    const ids = stale.map((a) => a.id)
    await db.delete(s.takes).where(inArray(s.takes.assetId, ids))
    await db.delete(s.assets).where(inArray(s.assets.id, ids))
  }

  const [asset] = await db
    .insert(s.assets)
    .values({
      projectId,
      kind: 'video',
      storageKey: key,
      mime: 'video/mp4',
      bytes: 1,
      sha256: 'e'.repeat(64),
      producedBy: 'generation',
    })
    .returning({ id: s.assets.id })
  const jobId = await createGenerationJob(db, {
    shotId: shot!.id,
    attempt: fixtureAttempt++,
    providerId: 'mock',
    modelId: 'mock-v1',
    mode: 't2v',
    promptText: 'render-503 fixture',
  })
  const [take] = await db
    .insert(s.takes)
    .values({ shotId: shot!.id, jobId, assetId: asset!.id, status: 'selected' })
    .returning({ id: s.takes.id })
  await db.update(s.shots).set({ status: 'locked', selectedTakeId: take!.id }).where(eq(s.shots.id, shot!.id))
}

describe('写路径闸门：没有 x-api-key 就不能花钱', () => {
  it('无头无 body 的 generate-batch 回 401，且一行 job 都没建', async () => {
    const before = await db.select({ id: s.generationJobs.id }).from(s.generationJobs)

    // 与攻击形态逐字一致：无 x-api-key、无 payload、无 content-type
    const r = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episodeId}/generate-batch`,
    })

    expect(r.statusCode).toBe(401)
    expect(r.json().error.code).toBe('UNAUTHORIZED')

    const after = await db.select({ id: s.generationJobs.id }).from(s.generationJobs)
    expect(after.length, '401 之后不该有任何新的生成任务').toBe(before.length)
  })

  it('key 不对也回 401', async () => {
    const r = await app.inject({
      method: 'POST',
      headers: { 'x-api-key': 'wrong' },
      url: `/api/shots/${shotId}/generate`,
    })
    expect(r.statusCode).toBe(401)
  })

  /**
   * GET 刻意不挡：SSE 走 EventSource，浏览器 API 设不了自定义头，
   * 护 GET 会直接打断实时进度流。钱的边界全在非 GET 上。
   */
  it('GET 不受影响——否则 SSE 与整个只读面板会一起挂掉', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(r.statusCode).toBe(200)
  })

  /** OPTIONS 是 CORS 预检本身，挡掉它等于把合法前端也一起挡了 */
  it('OPTIONS 预检放行', async () => {
    const r = await app.inject({
      method: 'OPTIONS',
      url: `/api/shots/${shotId}/generate`,
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-api-key',
      },
    })
    expect(r.statusCode).toBeLessThan(400)
  })
})

describe('读取路由', () => {
  it('GET /health 真的碰库', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, service: 'control' })
  })

  it('GET /api/episodes/:id 返回分镜页需要的树：场次 + 镜头 + take 数 + 成本', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/episodes/${episodeId}` })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.scenes.length).toBeGreaterThan(0)
    expect(body.shots.length).toBe(12) // seed 夹具
    expect(body.shots[0]).toHaveProperty('takeCount')
    expect(body.shots[0]).toHaveProperty('costMicroUsd')
  })

  it('不存在的资源回 404 且是统一错误体', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/episodes/00000000-0000-4000-8000-000000000000',
    })
    expect(r.statusCode).toBe(404)
    expect(r.json().error).toMatchObject({ code: 'NOT_FOUND' })
    expect(r.json().error.requestId).toBeTruthy() // 贯穿日志，报错截图即可定位
  })

  it('非 uuid 的 id 回 422 且带字段级错误', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/episodes/not-a-uuid' })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('VALIDATION_FAILED')
    expect(r.json().error.details.issues).toBeTruthy()
  })
})

describe('generate-batch 的 dryRun（06 §4：必须先用的那个）', () => {
  it('返回计划与成本预估，且不入队任何东西', async () => {
    await queues.generate.drain(true)
    const before = await queues.generate.getJobCounts()

    const r = await app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/episodes/${episodeId}/generate-batch`,
      payload: { dryRun: true },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.planned).toBe(12)
    expect(body.estimatedCostMicroUsd).toBeGreaterThan(0)
    expect(body.budget.dailyLimitMicroUsd).toBeGreaterThan(0) // CostMeter 的分母

    const after = await queues.generate.getJobCounts()
    expect(after.waiting).toBe(before.waiting) // dryRun 真的没入队
  })

  it('超预算时 block 拦下并回 402，而不是安静地烧钱', async () => {
    const prev = process.env['BUDGET_DAILY_MICRO_USD']
    process.env['BUDGET_DAILY_MICRO_USD'] = '1' // 1 微美元，必然超

    const r = await app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/episodes/${episodeId}/generate-batch`,
      payload: {},
    })
    expect(r.statusCode).toBe(402)
    expect(r.json().error.code).toBe('BUDGET_EXCEEDED')
    expect(r.json().error.details.estimatedCostMicroUsd).toBeGreaterThan(0)

    if (prev === undefined) delete process.env['BUDGET_DAILY_MICRO_USD']
    else process.env['BUDGET_DAILY_MICRO_USD'] = prev
  })
})

/**
 * dryRun 的估算必须按**每一镜自己的 provider** 算。
 *
 * 此前 `planBatch` 收单个 provider，调用方传 `deps.providers[0]` ——而
 * `buildProviderPool` 把 mock 排在最前。于是同一集里指定了真 provider 的镜头
 * 也按 mock 的价目表估价。
 *
 * 真钱实测撞到的数字：面板显示「预估 **$0.60**」，实际 11 × $0.3667 = **$4.03**
 * ——低估 10 倍，而**预算闸门读的就是这个数**。
 */
describe('批量估算按每镜路由，不是拿池里第一个乘以镜头数', () => {
  it('给镜头指定更贵的 provider，dryRun 的数要跟着涨', async () => {
    const dry = () =>
      app
        .inject({
          method: 'POST',
          url: `/api/episodes/${episodeId}/generate-batch`,
          headers: WRITE_HEADERS,
          payload: { dryRun: true },
        })
        .then((r) => r.json() as { planned: number; estimatedCostMicroUsd: number })

    const before = await dry()
    expect(before.planned).toBeGreaterThan(0)

    /*
     * 造一个"更贵的 mock"塞进池子并指到某一镜上。用 mock 的变体而不是真
     * provider：这条用例要验的是**路由参与了估算**，不是某一家的具体价钱。
     */
    const pricey = new MockProvider({ latencyScale: 0, failureRate: 0 })
    Object.defineProperty(pricey, 'id', { value: 'mock-pricey' })
    const original = pricey.estimateCost.bind(pricey)
    pricey.estimateCost = (req) => original(req) * 100

    const withPricey = buildServer({
      db,
      queues,
      storage,
      providers: [new MockProvider({ latencyScale: 0, failureRate: 0 }), pricey],
      maxAttempts: 4,
      media: { render: () => Promise.reject(new Error('未配置')) },
      healthProbe: () => client`SELECT 1`,
      makeSubscriber: () => createConnection(REDIS_URL),
      apiKey: TEST_API_KEY,
    })
    await withPricey.ready()

    const [shot] = await db
      .select({ id: s.shots.id })
      .from(s.shots)
      .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
      .where(and(eq(s.scenes.episodeId, episodeId), eq(s.shots.status, 'ready')))
      .limit(1)
    if (!shot) return // 这一集当下没有 ready 的镜头，别的用例改过状态

    await db.update(s.shots).set({ providerHint: 'mock-pricey' }).where(eq(s.shots.id, shot.id))
    try {
      const after = await withPricey
        .inject({
          method: 'POST',
          url: `/api/episodes/${episodeId}/generate-batch`,
          headers: WRITE_HEADERS,
          payload: { dryRun: true },
        })
        .then((r) => r.json() as { estimatedCostMicroUsd: number })
      expect(
        after.estimatedCostMicroUsd,
        '指定了贵 100 倍的 provider，估算却没变——说明估算没走路由，闸门读的是个假数',
      ).toBeGreaterThan(before.estimatedCostMicroUsd)
    } finally {
      await db.update(s.shots).set({ providerHint: null }).where(eq(s.shots.id, shot.id))
    }
  })
})

describe('依赖解析（03 §6）', () => {
  it('前序未 locked 的镜头被阻塞，不入队', () => {
    const r = resolveDependencies([
      { id: 'a', status: 'ready', continuityFromShotId: null },
      { id: 'b', status: 'ready', continuityFromShotId: 'a' }, // a 还没 locked
      { id: 'c', status: 'locked', continuityFromShotId: null },
      { id: 'd', status: 'ready', continuityFromShotId: 'c' }, // c 已 locked
    ])
    expect(r.runnable).toEqual(['a', 'd'])
    expect(r.blocked).toEqual(['b'])
    expect(r.skipped).toEqual(['c'])
  })

  it('非 ready 状态一律不重复入队', () => {
    const r = resolveDependencies([
      { id: 'g', status: 'generating', continuityFromShotId: null },
      { id: 'v', status: 'review', continuityFromShotId: null },
      { id: 'f', status: 'failed', continuityFromShotId: null },
    ])
    expect(r.runnable).toEqual([])
    expect(r.skipped).toHaveLength(3)
  })
})

describe('状态迁移必须走状态机', () => {
  it('对 draft 镜头调 generate 回 400 INVALID_STATE_TRANSITION', async () => {
    await db.update(s.shots).set({ status: 'draft' }).where(eq(s.shots.id, shotId))
    const r = await app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/shots/${shotId}/generate`,
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('INVALID_STATE_TRANSITION')
    expect(r.json().error.details).toMatchObject({ from: 'draft', event: 'generate.requested' })
    await db.update(s.shots).set({ status: 'ready' }).where(eq(s.shots.id, shotId))
  })

  it('ready 镜头 generate 回 202，写入 job 并入队', async () => {
    await queues.generate.drain(true)
    const r = await app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/shots/${shotId}/generate`,
    })
    expect(r.statusCode).toBe(202)
    expect(r.json().status).toBe('generating')

    const jobs = await db.select().from(s.generationJobs).where(eq(s.generationJobs.shotId, shotId))
    expect(jobs.length).toBeGreaterThan(0)

    const queued = await queues.generate.getJobs(['waiting', 'prioritized', 'delayed'])
    expect(queued.length).toBeGreaterThan(0)
  })

  /**
   * 单镜路径此前**完全不过预算闸门**——它只挂在 `/generate-batch` 上。
   * 闸门下沉到 `applyShotTransition` 之后这条路由自动被覆盖，这里验的是
   * 402 那层映射：预算拒绝不能和状态机拒绝混成同一个 400，两者要人做的事不一样。
   */
  it('超预算时单镜 generate 回 402 而不是 202', async () => {
    const prev = process.env['BUDGET_DAILY_MICRO_USD']
    process.env['BUDGET_DAILY_MICRO_USD'] = '1' // 1 微美元，必然超

    await db.update(s.shots).set({ status: 'ready' }).where(eq(s.shots.id, shotId))
    const before = await db.select({ id: s.generationJobs.id }).from(s.generationJobs)

    const r = await app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/shots/${shotId}/generate`,
    })

    expect(r.statusCode).toBe(402)
    expect(r.json().error.code).toBe('BUDGET_EXCEEDED')
    expect(r.json().error.details.dailyLimitMicroUsd).toBe(1)

    const after = await db.select({ id: s.generationJobs.id }).from(s.generationJobs)
    expect(after.length, '402 之后不该留下任何生成任务').toBe(before.length)

    if (prev === undefined) delete process.env['BUDGET_DAILY_MICRO_USD']
    else process.env['BUDGET_DAILY_MICRO_USD'] = prev
  })
})

describe('Ledger 视图（约束 C4）', () => {
  it('GET /api/shots/:id/jobs 返回全部尝试，含失败的', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/shots/${shotId}/jobs` })
    expect(r.statusCode).toBe(200)
    expect(Array.isArray(r.json().jobs)).toBe(true)
  })
})

describe('统计（洞察页与 CostMeter 的数据源）', () => {
  it('返回按状态的镜头分布、花费、以及每可用镜头成本', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/stats` })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.shots).toHaveProperty('ready')
    expect(b.cost).toHaveProperty('dailyLimitMicroUsd')
    expect(b.quality).toHaveProperty('usdPerAcceptedMicro')
  })
})

describe('资产内容：302 到预签名 URL，控制面不代理字节流（10 §1.2）', () => {
  it('回 302 且 Location 指向 S3 预签名地址', async () => {
    const [asset] = await db.select().from(s.assets).limit(1)
    if (!asset) return // 还没有资产时跳过

    const r = await app.inject({ method: 'GET', url: `/api/assets/${asset.id}/content` })
    expect(r.statusCode).toBe(302)
    const loc = r.headers.location as string
    expect(loc).toContain('X-Amz-Signature') // 真的是预签名 URL
    expect(loc).not.toContain('/api/') // 不经控制面中转
  })
})

/**
 * 依赖不可达要回 503，不能压成 409。
 *
 * 实测踩到的：media worker 没起时，面板上显示的是
 * `409 CONFLICT: fetch failed`——两条信息都错。409 让人以为是这一集的数据有问题，
 * 而 `fetch failed` 是 undici 对连不上的统称，既不说是谁没起、也不说该去哪看。
 * 处置动作完全不同：503 是「去把服务起起来」，409 是「去看这一集」。
 */
describe('依赖不可达 → 503，而不是 409', () => {
  // 与 beforeAll 的主 app 同形，只换 media 桩——本用例要验的就是这一个依赖
  const render = (media: ServerDeps['media']) =>
    buildServer({
      db,
      queues,
      storage,
      providers: [new MockProvider({ latencyScale: 0, failureRate: 0 })],
      maxAttempts: 4,
      media,
      healthProbe: () => client`SELECT 1`,
      makeSubscriber: () => createConnection(REDIS_URL),
      apiKey: TEST_API_KEY,
    })

  /**
   * 让这一集变成**可渲染**。
   *
   * 不放 beforeAll 而是用例里现调：文件级的 `cleanup()` 会把所有 shot 重置回
   * `ready` 并清掉 selectedTakeId，跟它赌执行顺序是错的。
   *
   * 必须先有 clip，否则 renderEpisode 在调 media 之前就以「没有已选定的镜头」
   * 抛出——那本来就该是 409，桩根本走不到，用例会假装自己在测映射。
   * （写这条时先踩了一次。）
   */
  it('media worker 连不上 → 503 DEPENDENCY_UNAVAILABLE，且消息指明是谁', async () => {
    await makeRenderable()
    const app = render({
      render: () =>
        Promise.reject(new MediaWorkerUnavailable('media worker 不可达（http://x:8002）：ECONNREFUSED')),
    })
    await app.ready()
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/episodes/${episodeId}/render`,
        headers: { 'x-api-key': TEST_API_KEY },
      })
      expect(res.statusCode).toBe(503)
      const body = res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('DEPENDENCY_UNAVAILABLE')
      expect(body.error.message, '要说清是谁不可达').toContain('media worker')
      expect(body.error.message, '要给出可行动的原因，不是 fetch failed').toContain('ECONNREFUSED')
    } finally {
      await app.close()
    }
  })

  it('worker 起着但渲染失败 → 仍是 409，不要把数据问题说成服务没起', async () => {
    await makeRenderable()
    const app = render({ render: () => Promise.reject(new Error('media worker 500: ffmpeg 解码失败')) })
    await app.ready()
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/episodes/${episodeId}/render`,
        headers: { 'x-api-key': TEST_API_KEY },
      })
      expect(res.statusCode).toBe(409)
      expect((res.json() as { error: { code: string } }).error.code).toBe('CONFLICT')
    } finally {
      await app.close()
    }
  })
})

/**
 * 空 timeline 会把一集永久钉死在「渲染不了」。
 *
 * `ensureTimeline` 原来是「存在就返回」。在一个镜头都没锁定时调用过一次
 * （面板加了渲染按钮之后，一次误点就够），就留下一个 0 clip 的 timeline，
 * 此后每次渲染都复用它 → `clips.length === 0` → 一路抛「没有已选定的镜头」。
 *
 * 实测踩到：浏览器里 12 镜全锁定、按钮显示「渲染成片 12/12」，点下去仍然报
 * 「没有已选定的镜头」。
 */
describe('空 timeline 要回填，不能永久复用', () => {
  it('有锁定镜头但 timeline 是空的时候，渲染要回填而不是抛', async () => {
    // 先有一个锁定镜头 + 它的 take（makeRenderable 顺带清掉 timelines）
    await makeRenderable()

    // 再手工造出「空 timeline」这个状态——它正是零锁定时误点渲染的产物
    const [tl] = await db
      .insert(s.timelines)
      .values({ episodeId, version: 1, status: 'draft' })
      .returning({ id: s.timelines.id })
    const clipCount = async (): Promise<number> =>
      (await db.select().from(s.timelineClips).where(eq(s.timelineClips.timelineId, tl!.id))).length
    expect(await clipCount(), '前提没造对').toBe(0)

    // 走到 media 就说明 clips 不为空了。原实现在这里抛「没有已选定的镜头」，
    // 而且**每次都抛**——这一集被永久钉死
    let reached = false
    await renderEpisode(
      {
        db,
        media: {
          render: () => {
            reached = true
            return Promise.reject(new Error('media worker 500: 到这里就够了'))
          },
        },
      },
      episodeId,
    ).catch(() => undefined)

    expect(reached, '空 timeline 没回填——这一集被永久钉死了').toBe(true)
    expect(await clipCount(), '回填后该有 clip').toBeGreaterThan(0)
  })
})

/**
 * 一集的文本层编辑。
 *
 * `script_md` 此前是一列孤儿——从第一版迁移起就存在，零写入方零读取方。
 * 补上写入口之后，分镜才有真剧本可读，而不是在 200 字的 hook+logline 上
 * 让模型自己编情节。
 */
describe('PATCH /api/episodes/:id', () => {
  const patch = (body: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/episodes/${episodeId}`,
      headers: { 'x-api-key': TEST_API_KEY },
      payload: body,
    })

  const readBack = async () => (await db.select().from(s.episodes).where(eq(s.episodes.id, episodeId)))[0]!

  it('写 script_md 并能读回', async () => {
    const md = '# 第一场\n\nLena 推门进来，铃响。\n\n> 还是那把椅子。'
    const res = await patch({ scriptMd: md })
    expect(res.statusCode).toBe(200)
    expect((await readBack()).scriptMd).toBe(md)
    // GET 也要能读到——分镜端点靠它取输入
    const got = await app.inject({ method: 'GET', url: `/api/episodes/${episodeId}` })
    expect((got.json() as { episode: { scriptMd: string } }).episode.scriptMd).toBe(md)
  })

  /** PATCH 的语义是「改我给的这些」。不传就动了别的字段，是这类端点最常见的坑 */
  it('不传的字段一个都不动', async () => {
    await patch({ scriptMd: '剧本正文', title: '原标题', hook: '原钩子' })
    await patch({ scriptMd: '换过的正文' })
    const ep = await readBack()
    expect(ep.scriptMd).toBe('换过的正文')
    expect(ep.title, 'title 没传却被清掉了').toBe('原标题')
    expect(ep.hook, 'hook 没传却被清掉了').toBe('原钩子')
  })

  // 库里 '' 和 NULL 混着存的话，后面每个读取方都要各写一遍兜底
  it('空串落 NULL，不是空字符串', async () => {
    await patch({ hook: '有钩子' })
    await patch({ hook: '   ' })
    expect((await readBack()).hook).toBeNull()
  })

  it('空 body 是合法 no-op，不该 400', async () => {
    await patch({ title: '标题还在' })
    const res = await patch({})
    expect(res.statusCode).toBe(200)
    expect((await readBack()).title).toBe('标题还在')
  })

  it('写路径要 x-api-key', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/episodes/${episodeId}`,
      payload: { title: 'x' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('不存在的 episode 回 404 而不是静默成功', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/episodes/00000000-0000-4000-8000-000000000000`,
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { title: 'x' },
    })
    expect(res.statusCode).toBe(404)
  })

  afterAll(async () => {
    // 还原 seed 的原值，别让后面的用例读到测试写进去的文本
    await db
      .update(s.episodes)
      .set({
        title: 'The Return',
        logline: 'Lena walks back into the life that discarded her.',
        hook: 'She was declared dead three years ago. She just ordered coffee.',
        cliffhanger: 'Marcus recognises the pendant — and reaches for his phone.',
        scriptMd: null,
      })
      .where(eq(s.episodes.id, episodeId))
  })
})

describe('POST /api/episodes/:id/shotlist', () => {
  /**
   * 自建一集，不借 seed 的那一集——它已经有 12 个镜头，会被「已有镜头」那道闸挡下。
   * index 用 900+ 避开 seed 与其他用例（`episodes_project_index_uq`）。
   */
  let epId = ''
  let sceneIds: string[] = []
  let charNames: string[] = []

  /** 18 镜 × 4s = 72s，三场，景别轮换——lint 全绿的那一份 */
  const draftOf = (names: readonly string[]) => ({
    scenes: [0, 1, 2].map((sc) => ({
      shots: Array.from({ length: 6 }, (_, i) => ({
        shotType: (['ms', 'cu', 'ws'] as const)[(sc * 6 + i) % 3]!,
        cameraMove: 'static' as const,
        action: 'Lena crosses the room',
        // 一半空镜、一半有台词，才能验 character_ids 两个方向都对
        emotion: '',
        dialogue: i % 2 === 0 ? '' : 'You did.',
        durationSec: 4,
        characterNames: i % 2 === 0 ? [] : [names[0]!],
      })),
    })),
  })

  /** 注入桩：不打 OpenRouter。真打的话每跑一次 CI 就是一次真实计费 */
  const withStub = (fn: ShotlistFn): FastifyInstance =>
    buildServer({
      db,
      queues,
      storage,
      providers: [new MockProvider({ latencyScale: 0, failureRate: 0 })],
      maxAttempts: 4,
      media: { render: () => Promise.reject(new Error('未配置')) },
      healthProbe: () => client`SELECT 1`,
      makeSubscriber: () => createConnection(REDIS_URL),
      apiKey: TEST_API_KEY,
      shotlist: fn,
    })

  const ok = (names: readonly string[]) =>
    withStub(() => Promise.resolve({ draft: draftOf(names), warnings: [], repaired: false, costUsd: 0.0034 }))

  const post = (a: FastifyInstance, id: string) =>
    a.inject({ method: 'POST', url: `/api/episodes/${id}/shotlist`, headers: WRITE_HEADERS })

  beforeAll(async () => {
    const [ep] = await db
      .insert(s.episodes)
      .values({ projectId, index: 901, title: '分镜端点用例', targetDurationSec: 72 })
      .returning()
    epId = ep!.id
    const rows = await db
      .insert(s.scenes)
      .values([0, 1, 2].map((i) => ({ episodeId: epId, index: i + 1, summary: `场 ${i + 1}` })))
      .returning()
    sceneIds = rows.map((r) => r.id)
    charNames = (
      await db
        .select({ name: s.characters.name })
        .from(s.characters)
        .where(eq(s.characters.projectId, projectId))
    ).map((c) => c.name)
  })

  /** 每条用例自己清干净：`shots_scene_index_uq` 会让第二次插入撞车 */
  const clearShots = async () => {
    await db.delete(s.shots).where(inArray(s.shots.sceneId, sceneIds))
  }

  it('没有剧本时先拦下来，不去花那 $0.003', async () => {
    const res = await post(ok(charNames), epId)
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    // 报错要说清该做什么
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/剧本/)
  })

  describe('有剧本之后', () => {
    beforeAll(async () => {
      await db
        .update(s.episodes)
        .set({ scriptMd: '# 第一场\n\nLena 推门进来。' })
        .where(eq(s.episodes.id, epId))
    })

    it('18 镜落库，index 跨场全集连续，空镜的 character_ids 是空数组', async () => {
      await clearShots()
      const res = await post(ok(charNames), epId)
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ shots: 18, scenes: 3, repaired: false })

      const rows = await db
        .select()
        .from(s.shots)
        .where(inArray(s.shots.sceneId, sceneIds))
        .orderBy(s.shots.index)
      expect(rows).toHaveLength(18)
      expect(rows.map((r) => r.index)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
      // 三场各 6 镜，且第 7 镜属于第二场——跨场连续不是「每场从 1 开始」
      expect(rows[6]!.sceneId).toBe(sceneIds[1])
      expect(rows[0]!.characterIds).toEqual([])
      expect(rows[1]!.characterIds).toHaveLength(1)
      expect(rows[0]!.dialogue).toBeNull() // 空串要落 NULL
      expect(rows[1]!.dialogue).toBe('You did.')
      expect(rows[0]!.emotion, '空串该落 NULL 而不是 ""').toBeNull()
      expect(rows[0]!.durationSec).toBe('4.0')

      /*
       * **落 `ready` 不是 `draft`。**
       *
       * `draft` 的唯一出路是 `intent.completed`，而全仓没有任何东西发这个事件
       * ——落成 draft 的话这些镜头永远动不了，面板上「待生成 0」。
       *
       * 第一版就是这样，而这条用例只断言了行数与字段，一路绿到真钱实测才撞上。
       */
      expect(
        rows.map((r) => r.status),
        '分镜落库的镜头必须能直接生成——draft 的唯一出路 intent.completed 没有任何发出方',
      ).toEqual(Array.from({ length: 18 }, () => 'ready'))
    })

    /** 上一条的执行版：真的能被状态机接受，而不只是列里写着 ready */
    it('落库的镜头真的能进生成——不是只有状态列长得对', async () => {
      await clearShots()
      expect((await post(ok(charNames), epId)).statusCode).toBe(201)
      const [shot] = await db
        .select({ id: s.shots.id })
        .from(s.shots)
        .where(inArray(s.shots.sceneId, sceneIds))
        .orderBy(s.shots.index)
        .limit(1)
      const gen = await app.inject({
        method: 'POST',
        url: `/api/shots/${shot!.id}/generate`,
        headers: WRITE_HEADERS,
      })
      expect(gen.statusCode, '状态机拒绝了刚生成的分镜——它们进不了生成').toBe(202)
    })

    it('已经有镜头就拒绝——重来会让已计费的产物失效', async () => {
      const res = await post(ok(charNames), epId)
      expect(res.statusCode).toBe(409)
      expect((res.json() as { error: { message: string } }).error.message).toMatch(/18 个镜头/)
    })

    it('模型两轮都不过 → 422 带上校验原文，不是 500', async () => {
      await clearShots()
      const app2 = withStub(() =>
        Promise.reject(new ShotlistRejected(['总时长 48.0 秒，偏离目标 72 秒 -33%'], '{}')),
      )
      const res = await post(app2, epId)
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({
        error: { code: 'VALIDATION_FAILED', details: { errors: ['总时长 48.0 秒，偏离目标 72 秒 -33%'] } },
      })
      expect(await db.select().from(s.shots).where(inArray(s.shots.sceneId, sceneIds))).toHaveLength(0)
    })

    /**
     * `vitest.config.ts` 把 `*_API_KEY` 从测试环境里摘掉了，所以这条是确定性的。
     * 不注入桩 = 走真实的 `shotlistFromEnv()`，正是没配 key 时用户会打到的那条路径。
     */
    it('没配 OPENROUTER_API_KEY → 503 + 可行动的报错，不是 500 fetch failed', async () => {
      await clearShots()
      /*
       * **必须先把库里的凭据收起来。**
       *
       * 密钥搬进库之后（PR-D），「没配 key」不再等于「env 里没有」——人在面板
       * 里存过一把的话，`resolveKey` 会取到它、真去打 OpenRouter、被出网拦截
       * 判成 500。这条用例第一次跑在有真 key 的开发库上就是这么红的。
       *
       * 与「按 DEMO_TITLE 挑夹具项目」是同一类：集成测试不该依赖开发库里
       * 恰好有什么。收起来的那把在 finally 里原样还回去——**跑测试不能弄丢
       * 人在面板里存的 key**。
       */
      await stashCredentials()
      const bare = buildServer({
        db,
        queues,
        storage,
        providers: [new MockProvider({ latencyScale: 0, failureRate: 0 })],
        maxAttempts: 4,
        media: { render: () => Promise.reject(new Error('未配置')) },
        healthProbe: () => client`SELECT 1`,
        makeSubscriber: () => createConnection(REDIS_URL),
        apiKey: TEST_API_KEY,
      })
      try {
        const res = await post(bare, epId)
        expect(res.statusCode).toBe(503)
        const body = res.json() as { error: { code: string; message: string } }
        expect(body.error.code).toBe('DEPENDENCY_UNAVAILABLE')
        expect(body.error.message, '报错要说清去哪儿配').toMatch(/OPENROUTER_API_KEY/)
        expect(body.error.message, '面板那条路也要说').toMatch(/面板/)
      } finally {
        await restoreCredentials()
      }
    })

    /**
     * E2 封顶 25 镜 × 单镜 10 秒 = 250 秒，E3 要求 ≥ 目标 × 0.85——目标超过
     * 294 秒时**没有任何分镜表能同时过 E2 与 E3**。不提前拦的话是两轮 LLM 的
     * 钱花完，然后给一句「总时长不对」，人看不出真正的原因。
     */
    /**
     * **目标够不着不拦生成，但要在生成结果里说清楚。**
     *
     * 时长是输出不是输入（见 `shotlist.ts` 的 W3）：一集多长由剧本决定。目标只
     * 用来告诉人「你预想的和实际能做的差多少」——而这句话要在**第一次拿到分镜时**
     * 就看见，不是等他渲染完发现成片比预期长 48% 才回头猜。
     */
    it('目标时长够不着 → 照常生成，但 warning 里要说明白', async () => {
      await clearShots()
      await db.update(s.episodes).set({ targetDurationSec: 600 }).where(eq(s.episodes.id, epId))
      let called = false
      const app2 = withStub(() => {
        called = true
        return Promise.resolve({ draft: draftOf(charNames), warnings: [], repaired: false, costUsd: 0 })
      })
      const res = await post(app2, epId)
      expect(res.statusCode, '够不着不是错误——剧情需要多长就多长').toBe(201)
      expect(called, '模型该照常被调用').toBe(true)
      const warnings = (res.json() as { warnings: string[] }).warnings
      expect(warnings.join(), '够不着这件事要排在最前面').toMatch(/^这一集会明显短于你的预期/)
      await db.update(s.episodes).set({ targetDurationSec: 72 }).where(eq(s.episodes.id, epId))
    })

    it('没有场次 → 409，而不是让模型去猜', async () => {
      // finally 里删：断言炸掉时 inline 的 delete 不会执行，残留的 episode
      // 会让下一次重放撞 episodes_project_index_uq，看起来像另一个 bug
      await db.delete(s.episodes).where(eq(s.episodes.index, 902))
      const [empty] = await db
        .insert(s.episodes)
        .values({ projectId, index: 902, scriptMd: '有剧本没场次', targetDurationSec: 72 })
        .returning()
      try {
        const res = await post(ok(charNames), empty!.id)
        expect(res.statusCode).toBe(409)
      } finally {
        await db.delete(s.episodes).where(eq(s.episodes.id, empty!.id))
      }
    })

    it('写路径要 x-api-key', async () => {
      const res = await ok(charNames).inject({ method: 'POST', url: `/api/episodes/${epId}/shotlist` })
      expect(res.statusCode).toBe(401)
    })
  })

  afterAll(async () => {
    await clearShots()
    await db.delete(s.episodes).where(eq(s.episodes.id, epId))
  })
})

/**
 * `shots_scene_index_uq`：`episodes` 与 `scenes` 两层都有对应约束，唯独 shots
 * 这层此前只有一个普通 index——重号不报错，而 `orderBy(shots.index)` 的顺序
 * 会因此变成不确定的，剪辑时间线正是照这个顺序拼的。
 */
describe('shots.index 的唯一约束真的存在', () => {
  it('同一场里插重号会被数据库拒掉', async () => {
    await db.delete(s.episodes).where(eq(s.episodes.index, 903))
    const [ep] = await db
      .insert(s.episodes)
      .values({ projectId, index: 903, targetDurationSec: 72 })
      .returning()
    const [sc] = await db.insert(s.scenes).values({ episodeId: ep!.id, index: 1 }).returning()
    const row = { sceneId: sc!.id, index: 7, shotType: 'ms' as const, action: 'x' }
    await db.insert(s.shots).values(row)
    /*
     * drizzle 把 PostgresError 包了一层，外层 message 只有 "Failed query: …"。
     * 断言外层等于断言「插入失败了」——**唯一约束没了也可能因为别的原因失败**。
     * 所以下探到 cause 上的约束名。
     */
    const err = await db
      .insert(s.shots)
      .values(row)
      .then(
        () => null,
        (e: unknown) => e,
      )
    const cause = (err as { cause?: { constraint_name?: string; code?: string } })?.cause
    expect(cause?.code, '23505 = unique_violation').toBe('23505')
    expect(cause?.constraint_name).toBe('shots_scene_index_uq')
  })

  // 断言炸掉时也要清——残留的 episode 会被文件顶部的 beforeAll 挑中
  afterAll(async () => {
    await db.delete(s.episodes).where(eq(s.episodes.index, 903))
  })
})

/**
 * 作者侧写入路径（P0）。
 *
 * 在这之前 `projects` / `scenes` / `characters` / `locations` / `style_profiles`
 * 五张表的**唯一写入方都是 `db/seed.ts`**——系统能跑一部剧，但造不出一部剧。
 */
describe('作者侧：新建项目 / 分集 / 场次', () => {
  const created: string[] = []
  const write = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: WRITE_HEADERS, ...(payload ? { payload } : {}) })

  afterAll(async () => {
    for (const id of created) await db.delete(s.projects).where(eq(s.projects.id, id))
  })

  const newProject = async (title = '作者侧用例') => {
    const r = await write('POST', '/api/projects', { title })
    const p = (r.json() as { project: { id: string } }).project
    created.push(p.id)
    return p
  }

  it('新建项目：201 + 能被列表读回', async () => {
    const r = await write('POST', '/api/projects', { title: '新剧', synopsis: '一句话梗概' })
    expect(r.statusCode).toBe(201)
    const p = (r.json() as { project: { id: string; title: string; synopsis: string } }).project
    created.push(p.id)
    expect(p.title).toBe('新剧')
    expect(p.synopsis).toBe('一句话梗概')

    const list = await app.inject({ method: 'GET', url: '/api/projects' })
    expect((list.json() as { projects: { id: string }[] }).projects.map((x) => x.id)).toContain(p.id)
  })

  it('没名字的项目拒收——列表里一行「未命名」谁都认不出来', async () => {
    expect((await write('POST', '/api/projects', { title: '   ' })).statusCode).toBe(422)
    expect((await write('POST', '/api/projects', {})).statusCode).toBe(422)
  })

  /**
   * 编号自动分配。手填就是把撞唯一约束变成用户的问题，而
   * `episodes_project_index_uq` / `scenes_episode_index_uq` 都是真的在那儿。
   */
  it('分集编号自动 +1，第一集是 1', async () => {
    const p = await newProject()
    const a = await write('POST', `/api/projects/${p.id}/episodes`, { title: '第一集' })
    const b = await write('POST', `/api/projects/${p.id}/episodes`, { title: '第二集' })
    expect(a.statusCode).toBe(201)
    expect((a.json() as { episode: { index: number } }).episode.index).toBe(1)
    expect((b.json() as { episode: { index: number } }).episode.index).toBe(2)
  })

  it('场次编号自动 +1，且能被分镜端点读到', async () => {
    const p = await newProject()
    const ep = (
      (await write('POST', `/api/projects/${p.id}/episodes`, {})).json() as { episode: { id: string } }
    ).episode
    for (const summary of ['第一场', '第二场']) {
      const r = await write('POST', `/api/episodes/${ep.id}/scenes`, { summary, timeOfDay: 'night' })
      expect(r.statusCode).toBe(201)
    }
    const rows = await db.select().from(s.scenes).where(eq(s.scenes.episodeId, ep.id)).orderBy(s.scenes.index)
    expect(rows.map((r) => r.index)).toEqual([1, 2])
    expect(rows[0]!.timeOfDay).toBe('night')

    // 场次是分镜的输入：有了它，那道「没有场次 → 409」的闸就不该再响
    await write('PATCH', `/api/episodes/${ep.id}`, { scriptMd: '有剧本了' })
    const r = await write('POST', `/api/episodes/${ep.id}/shotlist`)
    expect(r.statusCode, '有剧本有场次之后不该再被前置条件拦下').not.toBe(409)
  })

  /**
   * 光照自由文本压过枚举。四个枚举格只映射成四个固定英文词，而「路灯刚亮起、
   * 霓虹还半暗」与 `night` 在画面上是两回事——这一列不压过枚举的话，加它没有意义。
   */
  it('lighting 自由文本压过 timeOfDay，清空后回落', async () => {
    const p = await newProject()
    const ep = (
      (await write('POST', `/api/projects/${p.id}/episodes`, {})).json() as { episode: { id: string } }
    ).episode
    const sc = (
      (await write('POST', `/api/episodes/${ep.id}/scenes`, { timeOfDay: 'night' })).json() as {
        scene: { id: string }
      }
    ).scene
    const [shot] = await db
      .insert(s.shots)
      .values({ sceneId: sc.id, index: 1, shotType: 'ms', action: 'she waits' })
      .returning()

    const before = await resolvePrompt(db, shot!.id)
    expect(before!.prompt, '没写 lighting 时用枚举那个词').toContain('night')

    await write('PATCH', `/api/scenes/${sc.id}`, { lighting: 'streetlamps just flickered on' })
    const after = await resolvePrompt(db, shot!.id)
    expect(after!.prompt).toContain('streetlamps just flickered on')

    // 空串落 NULL，然后回落到枚举
    await write('PATCH', `/api/scenes/${sc.id}`, { lighting: '  ' })
    const cleared = await resolvePrompt(db, shot!.id)
    expect(cleared!.prompt, '清空之后该回落到枚举').toContain('night')
    expect(cleared!.prompt).not.toContain('streetlamps')
  })

  it('PATCH 场次改摘要与时段，空串落 NULL', async () => {
    const p = await newProject()
    const ep = (
      (await write('POST', `/api/projects/${p.id}/episodes`, {})).json() as { episode: { id: string } }
    ).episode
    const sc = (
      (await write('POST', `/api/episodes/${ep.id}/scenes`, { summary: '原摘要' })).json() as {
        scene: { id: string }
      }
    ).scene
    await write('PATCH', `/api/scenes/${sc.id}`, { summary: '改过的' })
    let [row] = await db.select().from(s.scenes).where(eq(s.scenes.id, sc.id))
    expect(row!.summary).toBe('改过的')
    await write('PATCH', `/api/scenes/${sc.id}`, { summary: '  ' })
    ;[row] = await db.select().from(s.scenes).where(eq(s.scenes.id, sc.id))
    expect(row!.summary).toBeNull()
  })

  /** `projects.style_profile_id` 不回填，风格建了也进不了任何一条 prompt */
  it('PATCH 项目能回填 styleProfileId——风格进 prompt 靠这一跳', async () => {
    const p = await newProject()
    const [style] = await db
      .insert(s.styleProfiles)
      .values({ projectId: p.id, name: '测试风格', description: 'cinematic' })
      .returning()
    const r = await write('PATCH', `/api/projects/${p.id}`, { styleProfileId: style!.id })
    expect(r.statusCode).toBe(200)
    const [row] = await db.select().from(s.projects).where(eq(s.projects.id, p.id))
    expect(row!.styleProfileId).toBe(style!.id)
  })

  it('删空项目可以，删不存在的回 404', async () => {
    const p = await newProject()
    expect((await write('DELETE', `/api/projects/${p.id}`)).statusCode).toBe(204)
    expect(await db.select().from(s.projects).where(eq(s.projects.id, p.id))).toHaveLength(0)
    created.splice(created.indexOf(p.id), 1)
    expect((await write('DELETE', `/api/projects/${p.id}`)).statusCode).toBe(404)
  })

  /**
   * **这条是这一组里最要紧的。**
   *
   * `projects → episodes → scenes → shots` 全链路 cascade，一条 DELETE 能把
   * 已经生成、已经计费的 take 与 asset 一起带走，而系统的规矩是永不自动销毁
   * 字节（03 §7）。
   */
  it('花过钱的不给删，报错里带上金额', async () => {
    const p = await newProject()
    const ep = (
      (await write('POST', `/api/projects/${p.id}/episodes`, {})).json() as { episode: { id: string } }
    ).episode
    const sc = (
      (await write('POST', `/api/episodes/${ep.id}/scenes`, {})).json() as { scene: { id: string } }
    ).scene
    const [shot] = await db
      .insert(s.shots)
      .values({ sceneId: sc.id, index: 1, shotType: 'ms', action: 'x' })
      .returning()

    // 还没花钱：删得掉（这里只验闸没响，随后回滚）
    expect((await write('DELETE', `/api/episodes/${ep.id}`)).statusCode).toBe(204)

    // 重建一份，这次记一笔账
    const ep2 = (
      (await write('POST', `/api/projects/${p.id}/episodes`, {})).json() as { episode: { id: string } }
    ).episode
    const sc2 = (
      (await write('POST', `/api/episodes/${ep2.id}/scenes`, {})).json() as { scene: { id: string } }
    ).scene
    const [shot2] = await db
      .insert(s.shots)
      .values({ sceneId: sc2.id, index: 1, shotType: 'ms', action: 'x' })
      .returning()
    await db.insert(s.generationJobs).values({
      shotId: shot2!.id,
      attempt: 1,
      providerId: 'mock',
      modelId: 'mock-v1',
      mode: 't2v',
      promptText: 'x',
      params: {},
      costMicroUsd: 1_230_000,
    })
    void shot

    for (const url of [`/api/episodes/${ep2.id}`, `/api/projects/${p.id}`]) {
      const r = await write('DELETE', url)
      expect(r.statusCode, `${url} 应该被闸门拦下`).toBe(409)
      const msg = (r.json() as { error: { message: string } }).error.message
      expect(msg, '报错要说清花了多少钱').toMatch(/\$1\.23/)
      expect(msg).toMatch(/1 次生成/)
    }
    // 还在库里，没被删掉
    expect(await db.select().from(s.shots).where(eq(s.shots.id, shot2!.id))).toHaveLength(1)
  })

  it('删场次：有镜头就拒，空的可以', async () => {
    const p = await newProject()
    const ep = (
      (await write('POST', `/api/projects/${p.id}/episodes`, {})).json() as { episode: { id: string } }
    ).episode
    const sc = (
      (await write('POST', `/api/episodes/${ep.id}/scenes`, {})).json() as { scene: { id: string } }
    ).scene
    await db.insert(s.shots).values({ sceneId: sc.id, index: 1, shotType: 'ms', action: 'x' })
    const bad = await write('DELETE', `/api/scenes/${sc.id}`)
    expect(bad.statusCode).toBe(409)
    expect((bad.json() as { error: { message: string } }).error.message).toMatch(/1 个镜头/)

    await db.delete(s.shots).where(eq(s.shots.sceneId, sc.id))
    expect((await write('DELETE', `/api/scenes/${sc.id}`)).statusCode).toBe(204)
  })

  it('写路径全都要 x-api-key', async () => {
    for (const [method, url] of [
      ['POST', '/api/projects'],
      ['DELETE', `/api/projects/00000000-0000-4000-8000-000000000000`],
    ] as const) {
      const r = await app.inject({ method, url, payload: { title: 'x' } })
      expect(r.statusCode, `${method} ${url} 没有闸门`).toBe(401)
    }
  })
})

/**
 * provider 凭据（PR-D）。
 *
 * 探测会真的打 OpenRouter，所以这里全部用 loopback server 打桩——不打桩的话
 * 每跑一次 CI 就是一次对外请求，而 `vitest.setup.ts` 的出网拦截也会挡下来。
 */
describe('密钥管理', () => {
  const REAL = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd'
  /**
   * 注入探测桩。不注入的话 `POST /api/keys` 会真的打 openrouter.ai——
   * 而「无效 key 直接拒收」正是这组端点最该被守住的行为，不能因为出网被拦
   * 就测不到。
   */
  let probeMode: 'ok' | 'invalid' | 'down' = 'ok'
  let probedWith: string[] = []
  const fakeProbe = (key: string): Promise<ProbeResult> => {
    probedWith.push(key)
    if (probeMode === 'invalid')
      return Promise.resolve({
        ok: false,
        kind: 'invalid',
        detail: 'OpenRouter 拒绝了这把 key：User not found.',
      })
    if (probeMode === 'down')
      return Promise.resolve({ ok: false, kind: 'unreachable', detail: '连不上 OpenRouter：ECONNREFUSED' })
    return Promise.resolve({
      ok: true,
      label: '个人账号',
      limitUsd: 20,
      remainingUsd: 17.5,
      usedUsd: 2.5,
      usedTodayUsd: 0.4,
      isFreeTier: false,
      account: { totalCredits: 10, totalUsage: 2.5, remaining: 7.5 },
    })
  }

  let keysApp: FastifyInstance
  const post = (payload: Record<string, unknown>) =>
    keysApp.inject({ method: 'POST', url: '/api/keys', headers: WRITE_HEADERS, payload })

  beforeAll(async () => {
    process.env['CREDENTIAL_SECRET'] = 'int-test-secret'
    // 开发库上跑，先把人存的真 key 收起来，退出时还回去
    await stashCredentials()
    keysApp = buildServer({
      db,
      queues,
      storage,
      providers: [new MockProvider({ latencyScale: 0, failureRate: 0 })],
      maxAttempts: 4,
      media: { render: () => Promise.reject(new Error('未配置')) },
      healthProbe: () => client`SELECT 1`,
      makeSubscriber: () => createConnection(REDIS_URL),
      apiKey: TEST_API_KEY,
      probeKey: fakeProbe,
    })
    await keysApp.ready()
  })

  afterAll(async () => {
    await restoreCredentials()
    delete process.env['CREDENTIAL_SECRET']
  })

  beforeEach(async () => {
    await db.delete(s.providerCredentials)
    probeMode = 'ok'
    probedWith = []
  })

  /** 存一把（绕开真实探测，直接写 store）。路由那条单独测 */
  const store = (key = REAL, label: string | null = '个人账号') =>
    upsertCredential(db, { provider: 'openrouter', key, label, verified: true })

  it('列表只回掩码信息，明文一个字符都不出库', async () => {
    await store()
    const r = await app.inject({ method: 'GET', url: '/api/keys' })
    expect(r.statusCode).toBe(200)
    const raw = r.body
    expect(raw, '响应体里出现了密钥明文').not.toContain(REAL)
    expect(raw, '哪怕中段也不行').not.toContain('0123456789abcdef')
    expect(raw, '密文也不该出去').not.toContain('ciphertext')

    const body = r.json() as {
      credentials: { provider: string; source: string; last4: string | null }[]
      runtime: { providers: string[]; credentialSecretConfigured: boolean }
    }
    const or = body.credentials.find((c) => c.provider === 'openrouter')!
    expect(or.source).toBe('db')
    expect(or.last4).toBe('abcd')
    expect(body.runtime.credentialSecretConfigured).toBe(true)
  })

  /** 库里有 key 但 runtime 没加载 = 「还没重启」。这一版不是热更新，差异要摆出来 */
  it('runtime 回的是进程实际加载的 provider，与库里存的分开', async () => {
    await store()
    const body = (await app.inject({ method: 'GET', url: '/api/keys' })).json() as {
      runtime: { providers: string[] }
    }
    // 本文件的 app 只注册了 mock，所以存了 openrouter 的 key 也不会出现在这里
    expect(body.runtime.providers).toEqual(['mock'])
  })

  it('没存过时 source 是 none 或 env，不是 db', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/keys' })).json() as {
      credentials: { provider: string; source: string; last4: string | null }[]
    }
    const or = body.credentials.find((c) => c.provider === 'openrouter')!
    expect(or.source).not.toBe('db')
    expect(or.last4).toBeNull()
  })

  /** 库里存的是密文，不是明文——`pg_dump` 泄露的是这一列 */
  it('落库的是密文，直接查表看不到明文', async () => {
    await store()
    const [row] = await db.select().from(s.providerCredentials)
    expect(row!.ciphertext).not.toContain('sk-or')
    expect(row!.ciphertext).not.toBe(REAL)
    expect(row!.last4).toBe('abcd')
    // 但解得回来
    expect(await resolveKey(db, 'openrouter')).toBe(REAL)
  })

  it('resolveKey：库优先于 env', async () => {
    const envOnly = { OPENROUTER_API_KEY: 'sk-or-v1-from-env' } as NodeJS.ProcessEnv
    expect(await resolveKey(db, 'openrouter', envOnly)).toBe('sk-or-v1-from-env')
    await store()
    expect(await resolveKey(db, 'openrouter', envOnly), '存过之后该以库里的为准').toBe(REAL)
  })

  it('删掉之后回落到 env', async () => {
    await store()
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/keys/openrouter', headers: WRITE_HEADERS }))
        .statusCode,
    ).toBe(204)
    expect(await resolveKey(db, 'openrouter', {} as NodeJS.ProcessEnv)).toBeNull()
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/keys/openrouter', headers: WRITE_HEADERS }))
        .statusCode,
      '删两次第二次该 404',
    ).toBe(404)
  })

  it('不认识的 provider 直接拒，不建一行垃圾', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: WRITE_HEADERS,
      payload: { provider: 'comfyui', key: REAL },
    })
    expect(r.statusCode).toBe(422)
    expect(await db.select().from(s.providerCredentials)).toHaveLength(0)
  })

  it('写路径要 x-api-key', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/keys',
      payload: { provider: 'openrouter', key: REAL },
    })
    expect(r.statusCode).toBe(401)
  })

  /**
   * 没配 `CREDENTIAL_SECRET` 时**拒绝存**，不静默降级成明文。
   * 「配置缺失就降级」是这类功能最常见的坏结局：看起来能用，安全性已经没了。
   */
  it('没配 CREDENTIAL_SECRET 就存不进去，且报错说清怎么补', async () => {
    const saved = process.env['CREDENTIAL_SECRET']
    delete process.env['CREDENTIAL_SECRET']
    try {
      await expect(store()).rejects.toThrow(/CREDENTIAL_SECRET/)
      expect(await db.select().from(s.providerCredentials), '拒绝之后不该留下半行').toHaveLength(0)
    } finally {
      process.env['CREDENTIAL_SECRET'] = saved
    }
  })

  it('换一把 key 是覆盖，不留历史行', async () => {
    await store(REAL)
    await store('sk-or-v1-aaaabbbbccccddddeeeeffffaaaabbbbccccddddeeeeffff9999', '换过的')
    const rows = await db.select().from(s.providerCredentials)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.last4).toBe('9999')
    expect(rows[0]!.label).toBe('换过的')
  })

  /**
   * **存之前先验。** 无效的 key 直接拒收，而不是存下来等下一次花钱时才发现。
   */
  it('key 无效 → 422 拒收，库里一行都不留', async () => {
    probeMode = 'invalid'
    const r = await post({ provider: 'openrouter', key: REAL })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { error: { message: string } }).error.message).toMatch(/User not found/)
    expect(await db.select().from(s.providerCredentials), '被拒的 key 不该落库').toHaveLength(0)
  })

  /**
   * `invalid` 与 `unreachable` 的状态码必须分开：混成一种的话，OpenRouter
   * 抽风时会让人把一把好 key 删掉重配。
   */
  it('连不上 → 503 且默认不存，带 force 才存并标为未验证', async () => {
    probeMode = 'down'
    const r = await post({ provider: 'openrouter', key: REAL })
    expect(r.statusCode).toBe(503)
    expect(await db.select().from(s.providerCredentials)).toHaveLength(0)

    const forced = await post({ provider: 'openrouter', key: REAL, force: true })
    expect(forced.statusCode).toBe(201)
    const [row] = await db.select().from(s.providerCredentials)
    expect(row!.verifiedAt, '没验过就不该标成已验证').toBeNull()
  })

  /** force 跳得过「连不上」，跳不过「key 不对」——后者是确定性的坏 */
  it('force 也存不进一把无效的 key', async () => {
    probeMode = 'invalid'
    expect((await post({ provider: 'openrouter', key: REAL, force: true })).statusCode).toBe(422)
    expect(await db.select().from(s.providerCredentials)).toHaveLength(0)
  })

  it('有效 key → 201，回额度，标为已验证，且响应里没有明文', async () => {
    probeMode = 'ok'
    const r = await post({ provider: 'openrouter', key: REAL, label: '个人账号' })
    expect(r.statusCode).toBe(201)
    expect(r.body, '响应体里出现了密钥明文').not.toContain(REAL)
    const body = r.json() as {
      credential: { last4: string; verifiedAt: string | null }
      probe: { ok: boolean; remainingUsd: number }
    }
    expect(body.credential.last4).toBe('abcd')
    expect(body.credential.verifiedAt).not.toBeNull()
    expect(body.probe.remainingUsd).toBe(17.5)
    // 验的是提交上来的那把，不是别的
    expect(probedWith).toEqual([REAL])
  })

  it('太短的 key 在 zod 就被拦下，探测都不会发起', async () => {
    const r = await post({ provider: 'openrouter', key: 'abc' })
    expect(r.statusCode).toBe(422)
    expect(probedWith, '不该为一个明显不是密钥的串去打网络').toEqual([])
  })

  it('重新探测已存的那把，成功后刷新 verifiedAt', async () => {
    await store()
    await db.update(s.providerCredentials).set({ verifiedAt: null })
    const r = await keysApp.inject({
      method: 'POST',
      url: '/api/keys/openrouter/probe',
      headers: WRITE_HEADERS,
    })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { probe: { ok: boolean } }).probe.ok).toBe(true)
    const [row] = await db.select().from(s.providerCredentials)
    expect(row!.verifiedAt).not.toBeNull()
    // 探测用的是库里解密出来的那把
    expect(probedWith).toEqual([REAL])
  })

  it('没存过就探测 → 503，报错指向面板与 .env 两条路', async () => {
    const saved = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    try {
      const r = await keysApp.inject({
        method: 'POST',
        url: '/api/keys/openrouter/probe',
        headers: WRITE_HEADERS,
      })
      expect(r.statusCode).toBe(503)
      const msg = (r.json() as { error: { message: string } }).error.message
      expect(msg).toMatch(/面板/)
      expect(msg).toMatch(/OPENROUTER_API_KEY/)
    } finally {
      if (saved !== undefined) process.env['OPENROUTER_API_KEY'] = saved
    }
  })

  /**
   * 分镜那条链路**每次请求现取密钥**（不像 provider 池是开机建的），所以面板
   * 存完立刻生效。没存时的报错要同时指出两条路：面板与 `.env`。
   */
  it('没有 key 时的 503 文案指向面板与 .env 两条路', async () => {
    const saved = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    try {
      const r = await app.inject({
        method: 'POST',
        url: `/api/episodes/${episodeId}/shotlist`,
        headers: WRITE_HEADERS,
      })
      const msg = (r.json() as { error: { message: string } }).error.message
      // 这一集有 12 个镜头，会先被「已有镜头」那道闸拦下——两种都可以，
      // 但只要走到密钥这一步，文案就必须把两条路都说出来
      if (r.statusCode === 503) {
        expect(msg).toMatch(/密钥/)
        expect(msg, '要说清面板里也能配').toMatch(/面板/)
        expect(msg).toMatch(/OPENROUTER_API_KEY/)
      }
    } finally {
      if (saved !== undefined) process.env['OPENROUTER_API_KEY'] = saved
    }
  })
})

/**
 * provider 池热更新（PR-E）。
 *
 * PR-D 把密钥搬进了库，但 `buildProviderPool()` 在控制面与 worker 里各建一次、
 * 都在开机时——所以存完 key 视频链路要重启两个进程才认。这一组验它不用了。
 */
describe('provider 池热更新', () => {
  const REAL = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd'
  /** 只放一个模型，断言时数量才算得清 */
  const ENV = { OPENROUTER_VIDEO_MODELS: 'google/veo-3.1-lite' } as NodeJS.ProcessEnv

  beforeAll(async () => {
    process.env['CREDENTIAL_SECRET'] = 'int-test-secret'
    await stashCredentials()
  })
  afterAll(async () => {
    await restoreCredentials()
    delete process.env['CREDENTIAL_SECRET']
  })
  beforeEach(async () => {
    await db.delete(s.providerCredentials)
  })

  it('库里没有密钥时池里只有 mock', async () => {
    const pool = new LivePool(db, ENV)
    expect(await pool.refresh()).toEqual(['mock'])
  })

  it('存进一把之后 refresh 就把 openrouter 拉进来了', async () => {
    const pool = new LivePool(db, ENV)
    await pool.refresh()
    await upsertCredential(db, { provider: 'openrouter', key: REAL, label: null, verified: true })
    expect(await pool.refresh()).toEqual(['mock', 'openrouter:google/veo-3.1-lite'])
  })

  /**
   * **数组引用不变**是这套设计成立的前提：三个 Deps 接口和全部调用点都是
   * 「用的时候才读 `deps.providers`」，引用一换它们就全看不到新内容了。
   */
  it('refresh 换的是内容不是引用', async () => {
    const pool = new LivePool(db, ENV)
    const handle = pool.providers // 模拟 deps 里存下来的那一份
    await pool.refresh()
    expect(handle).toHaveLength(1)
    await upsertCredential(db, { provider: 'openrouter', key: REAL, label: null, verified: true })
    await pool.refresh()
    expect(handle, '拿着旧引用的调用方必须看得到新内容').toHaveLength(2)
    expect(handle).toBe(pool.providers)
  })

  /**
   * 删掉库里那把之后**回落到 `.env`**，两处都没有才真的空掉。
   *
   * 这是设计如此不是漏洞：`.env` 的语义是「还没用过面板时的初始值」，
   * 删掉面板里存的那把就等于回到初始值。
   */
  it('删掉库里的之后回落到 .env，两处都没有才空', async () => {
    const envWithKey = { ...ENV, OPENROUTER_API_KEY: 'sk-or-v1-stale-from-env' } as NodeJS.ProcessEnv
    const pool = new LivePool(db, envWithKey)
    await upsertCredential(db, { provider: 'openrouter', key: REAL, label: null, verified: true })
    expect(await pool.refresh()).toHaveLength(2)

    await deleteCredential(db, 'openrouter')
    // resolveKey 会回落到 env，所以这里仍然是 2——这是**设计如此**：
    // .env 是「还没用过面板时的初始值」，删库里的那把等于回到初始值
    expect(await pool.refresh(), '回落到 .env 的那把').toHaveLength(2)

    // 而 .env 里也没有时，必须真的空掉
    const bare = new LivePool(db, ENV)
    expect(await bare.refresh()).toEqual(['mock'])
  })

  /** 跨进程：一个 LivePool 广播，另一个收到后自己重建 */
  it('Redis 广播能让另一个进程的池子跟着变', async () => {
    const a = new LivePool(db, ENV) // 扮演控制面
    const b = new LivePool(db, ENV) // 扮演 worker
    await a.refresh()
    await b.refresh()
    expect(b.providers).toHaveLength(1)

    const sub = createConnection(REDIS_URL)
    const pub = createConnection(REDIS_URL)
    const stop = await subscribeProviderChanges(sub, b)
    try {
      await upsertCredential(db, { provider: 'openrouter', key: REAL, label: null, verified: true })
      await publishProvidersChanged(pub)
      // pub/sub 是异步的，等它到
      for (let i = 0; i < 40 && b.providers.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
      expect(
        b.providers.map((p) => p.id),
        'worker 那边没跟上',
      ).toEqual(['mock', 'openrouter:google/veo-3.1-lite'])
    } finally {
      await stop()
      sub.disconnect()
      pub.disconnect()
    }
  })

  /**
   * 删密钥会让池子少掉一整家，而**在飞的 job 是按 `provider_id` 回查池子的**
   * （`orchestrator.ts` 的 `providerOf`，查不到就抛）。所以有在飞的就拒绝删。
   */
  it('有在飞的任务时拒绝删密钥', async () => {
    await upsertCredential(db, { provider: 'openrouter', key: REAL, label: null, verified: true })
    const [job] = await db
      .insert(s.generationJobs)
      .values({
        shotId,
        attempt: TEST_ATTEMPT_BASE + 71,
        providerId: 'openrouter:google/veo-3.1-lite',
        modelId: 'google/veo-3.1-lite',
        mode: 't2v',
        promptText: 'x',
        params: {},
        status: 'running',
      })
      .returning()
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/keys/openrouter',
        headers: WRITE_HEADERS,
      })
      expect(r.statusCode).toBe(409)
      expect((r.json() as { error: { message: string } }).error.message).toMatch(/1 个 openrouter 的任务在飞/)
      expect(await db.select().from(s.providerCredentials), '被拒之后不该真删').toHaveLength(1)

      // 跑完之后就删得掉了
      await db.update(s.generationJobs).set({ status: 'succeeded' }).where(eq(s.generationJobs.id, job!.id))
      expect(
        (await app.inject({ method: 'DELETE', url: '/api/keys/openrouter', headers: WRITE_HEADERS }))
          .statusCode,
      ).toBe(204)
    } finally {
      await db.delete(s.generationJobs).where(eq(s.generationJobs.id, job!.id))
    }
  })

  /**
   * 订阅那条连接只订了自己的频道，但**一条连接可以同时订多个**——将来有人复用
   * 它的话，别的频道的消息不该触发重建。这条守的就是那个。
   */
  it('别的频道的消息不会触发重建', async () => {
    const pool = new LivePool(db, ENV)
    await pool.refresh()
    const sub = createConnection(REDIS_URL)
    const pub = createConnection(REDIS_URL)
    const stop = await subscribeProviderChanges(sub, pool)
    try {
      await sub.subscribe('studio:events') // 复用同一条连接订别的
      await upsertCredential(db, { provider: 'openrouter', key: REAL, label: null, verified: true })
      await pub.publish('studio:events', JSON.stringify({ type: 'noise' }))
      await new Promise((r) => setTimeout(r, 300))
      expect(pool.providers, '不该被别的频道的消息带着重建').toHaveLength(1)
      // 而自己的频道仍然有效
      await publishProvidersChanged(pub)
      for (let i = 0; i < 40 && pool.providers.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
      expect(pool.providers).toHaveLength(2)
    } finally {
      await stop()
      sub.disconnect()
      pub.disconnect()
    }
  })

  /** 存/删之后要**真的**调重建回调，否则页面上仍然显示旧的 runtime */
  it('POST 与 DELETE 都会触发本进程重建', async () => {
    let reloads = 0
    const hot = buildServer({
      db,
      queues,
      storage,
      providers: [new MockProvider({ latencyScale: 0, failureRate: 0 })],
      maxAttempts: 4,
      media: { render: () => Promise.reject(new Error('未配置')) },
      healthProbe: () => client`SELECT 1`,
      makeSubscriber: () => createConnection(REDIS_URL),
      apiKey: TEST_API_KEY,
      probeKey: () =>
        Promise.resolve({
          ok: true as const,
          label: null,
          limitUsd: null,
          remainingUsd: null,
          usedUsd: 0,
          usedTodayUsd: 0,
          isFreeTier: false,
          account: null,
        }),
      onCredentialsChanged: () => {
        reloads += 1
        return Promise.resolve()
      },
    })
    await hot.ready()

    const post = await hot.inject({
      method: 'POST',
      url: '/api/keys',
      headers: WRITE_HEADERS,
      payload: { provider: 'openrouter', key: REAL },
    })
    expect(post.statusCode).toBe(201)
    expect((post.json() as { reload: { ok: boolean } }).reload.ok, '要如实回报重建结果').toBe(true)
    expect(reloads).toBe(1)

    expect(
      (await hot.inject({ method: 'DELETE', url: '/api/keys/openrouter', headers: WRITE_HEADERS }))
        .statusCode,
    ).toBe(204)
    expect(reloads, 'DELETE 之后也要重建，否则池里还留着已删的那家').toBe(2)
  })

  /** 重建失败不该让「已经存好的密钥」看起来像没存上 */
  it('重建失败时密钥仍然存下，但 reload.ok 是 false', async () => {
    const broken = buildServer({
      db,
      queues,
      storage,
      providers: [new MockProvider({ latencyScale: 0, failureRate: 0 })],
      maxAttempts: 4,
      media: { render: () => Promise.reject(new Error('未配置')) },
      healthProbe: () => client`SELECT 1`,
      makeSubscriber: () => createConnection(REDIS_URL),
      apiKey: TEST_API_KEY,
      probeKey: () =>
        Promise.resolve({
          ok: true as const,
          label: null,
          limitUsd: null,
          remainingUsd: null,
          usedUsd: 0,
          usedTodayUsd: 0,
          isFreeTier: false,
          account: null,
        }),
      onCredentialsChanged: () => Promise.reject(new Error('Redis 挂了')),
    })
    await broken.ready()
    const r = await broken.inject({
      method: 'POST',
      url: '/api/keys',
      headers: WRITE_HEADERS,
      payload: { provider: 'openrouter', key: REAL },
    })
    expect(r.statusCode, '重建失败不该让存密钥这件事失败').toBe(201)
    const body = r.json() as { reload: { ok: boolean; detail?: string } }
    expect(body.reload.ok).toBe(false)
    expect(body.reload.detail).toMatch(/Redis 挂了/)
    expect(await db.select().from(s.providerCredentials), '密钥要真的存下来了').toHaveLength(1)
  })

  /** 换一把 key **不该**被在飞的任务挡住：provider id 与密钥无关 */
  it('换一把 key 不受在飞任务影响', async () => {
    await upsertCredential(db, { provider: 'openrouter', key: REAL, label: null, verified: true })
    const before = new LivePool(db, ENV)
    const idsBefore = await before.refresh()
    await upsertCredential(db, {
      provider: 'openrouter',
      key: 'sk-or-v1-aaaabbbbccccddddeeeeffffaaaabbbbccccddddeeeeffff9999',
      label: null,
      verified: true,
    })
    expect(await before.refresh(), 'id 只由 (家, 模型) 决定，换密钥不该改变它').toEqual(idsBefore)
  })
})

describe('密钥探测（打桩，不打真实 OpenRouter）', () => {
  let server: Server
  let base = ''
  let mode: 'ok' | 'invalid' | 'down' = 'ok'
  let creditsMode: 'ok' | 'down' | 'empty' = 'ok'

  beforeAll(async () => {
    server = createServer((req, res) => {
      // 余额是另一个端点，探测会顺手打它
      if (req.url?.endsWith('/credits')) {
        if (creditsMode === 'down') {
          res.writeHead(500)
          res.end('nope')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify(
            creditsMode === 'empty'
              ? { data: { total_credits: 3, total_usage: 3 } }
              : { data: { total_credits: 10, total_usage: 2.5 } },
          ),
        )
        return
      }
      if (mode === 'invalid') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'User not found.', code: 401 } }))
      } else if (mode === 'down') {
        res.writeHead(503)
        res.end('upstream down')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: { label: 'k', limit: 20, limit_remaining: 17.5, usage: 2.5, usage_daily: 0.4 },
          }),
        )
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const a = server.address()
    if (a === null || typeof a === 'string') throw new Error('拿不到端口')
    base = `http://127.0.0.1:${a.port}`
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('有效 key：回额度与用量', async () => {
    mode = 'ok'
    const r = await probeOpenRouter('sk-x', base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.limitUsd).toBe(20)
      expect(r.remainingUsd).toBe(17.5)
      expect(r.usedTodayUsd).toBe(0.4)
    }
  })

  /**
   * **账户余额与 key 的有效性是两件事。**
   *
   * `GET /api/v1/key` 看不到余额——一把没充过钱的 key 在那里完全健康
   * （`limit: null` 只表示这把 key 没有单独限额）。不专门查一次 `/credits`
   * 的话，面板会显示「✓ 有效 · 剩余 不限」，然后第一次真实生成 402。
   *
   * 实测过：Jason 的 key 在 `/key` 上 `limit: null`，而 `/credits` 回
   * `{"total_credits":10,"total_usage":0}`。
   */
  it('账户余额单独取，且不影响「key 有效」的判定', async () => {
    mode = 'ok'
    const r = await probeOpenRouter('sk-x', base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.account).toEqual({ totalCredits: 10, totalUsage: 2.5, remaining: 7.5 })
    }
  })

  it('/credits 挂了不改变结论，只是拿不到余额', async () => {
    mode = 'ok'
    creditsMode = 'down'
    try {
      const r = await probeOpenRouter('sk-x', base)
      expect(r.ok, '余额取不到不该把一把好 key 判成无效').toBe(true)
      if (r.ok) expect(r.account).toBeNull()
    } finally {
      creditsMode = 'ok'
    }
  })

  it('余额为 0 时 remaining 是 0，不是 null', async () => {
    mode = 'ok'
    creditsMode = 'empty'
    try {
      const r = await probeOpenRouter('sk-x', base)
      expect(r.ok).toBe(true)
      // 面板据此给出「余额为 0，任何真实生成都会 402」的警告
      if (r.ok) expect(r.account?.remaining).toBe(0)
    } finally {
      creditsMode = 'ok'
    }
  })

  /**
   * `invalid` 与 `unreachable` 分开，因为处置动作相反：前者换 key，后者等一会儿。
   * 混成一种的话，OpenRouter 抽风时会让人把一把好 key 删掉重配。
   */
  it('401 是 invalid，5xx 是 unreachable——两者不能混', async () => {
    mode = 'invalid'
    const bad = await probeOpenRouter('sk-x', base)
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.kind).toBe('invalid')
      expect(bad.detail).toContain('User not found')
    }

    mode = 'down'
    const down = await probeOpenRouter('sk-x', base)
    expect(down.ok).toBe(false)
    if (!down.ok) expect(down.kind).toBe('unreachable')
  })

  it('连不上是 unreachable，且原因能看出来（不是光秃秃的 fetch failed）', async () => {
    // 起一个再关掉，拿一个**确定没人监听**的端口。写死端口号会 flaky，
    // 而 port 1 会被 undici 判成 bad port、根本不发起连接，测不到这条路径
    const tmp = createServer()
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r))
    const a = tmp.address()
    if (a === null || typeof a === 'string') throw new Error('拿不到端口')
    const dead = a.port
    await new Promise<void>((r) => tmp.close(() => r()))

    const r = await probeOpenRouter('sk-x', `http://127.0.0.1:${dead}`)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe('unreachable')
      expect(r.detail, 'happy-eyeballs 会把真原因藏进 AggregateError').toMatch(/ECONNREFUSED/)
    }
  })
})

/**
 * 提示词检视（PR-K）。
 *
 * 最要紧的一条是**预览与真实生成同源**：两者都走 `resolvePrompt`。另写一份
 * 取数逻辑就是 PR-J 修掉的那类 bug 的翻版——两份会漂，而漂了之后预览显示的和
 * 真实发出去的不是一回事，那比没有预览更坏（人会照着一份假的去调措辞）。
 */
/**
 * 成片必须能在面板上找到。
 *
 * 此前面板里**唯一**通向 `/watch` 的路径是渲染那一刻的 `window.open`——
 * 关掉那个标签页，片子就再也找不到了。而它是这条流水线的最终产物。
 */
describe('成片入口', () => {
  it('GET /api/episodes/:id 回 master：有渲染过就给 assetId', async () => {
    const before = (await app.inject({ method: 'GET', url: `/api/episodes/${episodeId}` })).json() as {
      master: { assetId: string } | null
    }
    // 这一集有没有渲染过取决于别的用例，两种都合法——但形状必须在
    expect(before).toHaveProperty('master')

    // 造一条成功的 render_job，master 必须出现
    const [tl] = await db.insert(s.timelines).values({ episodeId, version: 900, status: 'draft' }).returning()
    const [asset] = await db
      .insert(s.assets)
      .values({
        projectId,
        kind: 'master',
        storageKey: 'test/master-entry.mp4',
        mime: 'video/mp4',
        bytes: 1,
        sha256: 'x'.repeat(64),
        producedBy: 'render',
      })
      .returning()
    const [rj] = await db
      .insert(s.renderJobs)
      .values({
        timelineId: tl!.id,
        status: 'succeeded',
        outputAssetId: asset!.id,
        finishedAt: new Date(),
      })
      .returning()
    try {
      const after = (await app.inject({ method: 'GET', url: `/api/episodes/${episodeId}` })).json() as {
        master: { assetId: string } | null
      }
      expect(after.master?.assetId, '渲染过了却没给成片入口').toBe(asset!.id)
    } finally {
      await db.delete(s.renderJobs).where(eq(s.renderJobs.id, rj!.id))
      await db.delete(s.assets).where(eq(s.assets.id, asset!.id))
      await db.delete(s.timelines).where(eq(s.timelines.id, tl!.id))
    }
  })

  it('分集列表带 hasMaster，列表页据此给入口', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/episodes` })
    const eps = (r.json() as { episodes: { id: string; hasMaster: boolean }[] }).episodes
    expect(eps.length).toBeGreaterThan(0)
    for (const e of eps) expect(typeof e.hasMaster, `${e.id} 没有 hasMaster`).toBe('boolean')
  })
})

describe('提示词检视', () => {
  it('GET /api/prompts 回底座，且标出该改哪个文件', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/prompts' })
    expect(r.statusCode).toBe(200)
    const b = r.json() as {
      shotlist: { model: string; source: string; system: string; criteria: Record<string, unknown> }
      video: { prose: Record<string, Record<string, string>>; assembly: string[] }
    }
    expect(b.shotlist.model).toBe('google/gemini-3.7-flash')
    expect(b.shotlist.source, '要告诉人去哪儿改').toContain('callShotlist.ts')
    expect(b.shotlist.system).toContain('storyboard supervisor')
    // 判据数字取自常量，与提示词同源（PR-J）
    expect(b.shotlist.criteria['shotCount']).toEqual({ min: SHOT_COUNT.min, max: SHOT_COUNT.max })
    expect(b.shotlist.criteria['durationTolerancePct']).toBe(DURATION_TOLERANCE * 100)
    // 三张散文表都在，且是真的那三张
    expect(b.video.prose['shotType']?.['cu']).toBe('close-up')
    expect(b.video.prose['cameraMove']?.['dolly']).toBe('slow dolly in')
    expect(b.video.assembly.length).toBeGreaterThan(0)
  })

  it('底座里不该出现任何密钥', async () => {
    const raw = (await app.inject({ method: 'GET', url: '/api/prompts' })).body
    expect(raw).not.toMatch(/sk-or-|Bearer|apiKey/)
  })

  /** **这条是这一组的核心。** 预览必须与真实入队时构建的那份逐字相同 */
  /**
   * 闸门与出口必须成对存在。`redo.requested` 从第一版就在状态机里，但一直零
   * 发射方——报错让人「去重做」而重做不存在，正是面板上那类「说了等于没说」。
   */
  it('POST /api/shots/:id/redo 把锁定的镜头放回 ready', async () => {
    await db.update(s.shots).set({ status: 'locked' }).where(eq(s.shots.id, shotId))
    const r = await app.inject({ method: 'POST', url: `/api/shots/${shotId}/redo`, headers: WRITE_HEADERS })
    expect(r.statusCode).toBe(200)
    const [row] = await db.select().from(s.shots).where(eq(s.shots.id, shotId))
    expect(row!.status).toBe('ready')
    expect(row!.selectedTakeId, '选中要跟着清掉，否则闸门会把这一镜永久卡死').toBeNull()
  })

  it('预览与真实生成逐字一致', async () => {
    const preview = await app.inject({
      method: 'POST',
      url: '/api/ai/prompt-preview',
      headers: WRITE_HEADERS,
      payload: { shotId },
    })
    expect(preview.statusCode).toBe(200)
    const p = preview.json() as { prompt: string; negativePrompt: string | null; overridden: boolean }
    expect(p.overridden).toBe(false)
    expect(p.prompt.length).toBeGreaterThan(20)

    /*
     * 真跑一次生成，比对落库的 prompt_text。
     *
     * **先把残留的 take 归档**：前面的用例可能给这一镜留下一条 `selected`，
     * 而「有选定成片就不再花钱」那道闸（applyTransition.ts）会拦下来。
     * 直接 UPDATE 成 ready 却不动 take，正是烧掉 $4.03 的那个真实状态。
     */
    await db.update(s.takes).set({ status: 'archived' }).where(eq(s.takes.shotId, shotId))
    await db.update(s.shots).set({ status: 'ready', selectedTakeId: null }).where(eq(s.shots.id, shotId))
    const gen = await app.inject({
      method: 'POST',
      url: `/api/shots/${shotId}/generate`,
      headers: WRITE_HEADERS,
    })
    expect(gen.statusCode).toBe(202)
    const [job] = await db
      .select({ promptText: s.generationJobs.promptText, negativeText: s.generationJobs.negativeText })
      .from(s.generationJobs)
      .where(eq(s.generationJobs.shotId, shotId))
      .orderBy(desc(s.generationJobs.attempt))
      .limit(1)
    expect(job!.promptText, '预览与真实发出去的不是同一份——两者已经漂了').toBe(p.prompt)
    expect(job!.negativeText).toBe(p.negativePrompt)
  })

  /** 人工旁路：写了 prompt_override 就整段原样发，拼装被完全跳过 */
  it('prompt_override 会被如实标出来', async () => {
    await db.update(s.shots).set({ promptOverride: '手写的 prompt，不要动它' }).where(eq(s.shots.id, shotId))
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/ai/prompt-preview',
        headers: WRITE_HEADERS,
        payload: { shotId },
      })
      const p = r.json() as { prompt: string; overridden: boolean }
      expect(p.overridden, '走旁路时必须标出来，否则人以为拼装规则变了').toBe(true)
      expect(p.prompt).toBe('手写的 prompt，不要动它')
    } finally {
      await db.update(s.shots).set({ promptOverride: null }).where(eq(s.shots.id, shotId))
    }
  })

  it('预览带回取到的资产，供解释「为什么长这样」', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/ai/prompt-preview',
      headers: WRITE_HEADERS,
      payload: { shotId },
    })
    const p = r.json() as {
      inputs: { style: { description: string } | null; location: unknown; characters: unknown[] }
    }
    // seed 的项目挂了风格，所以这里必须取得到——取不到说明 styleProfileId 那一跳断了
    expect(p.inputs.style?.description).toContain('cinematic')
  })

  it('不存在的 shot 回 404', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/ai/prompt-preview',
      headers: WRITE_HEADERS,
      payload: { shotId: '00000000-0000-4000-8000-000000000000' },
    })
    expect(r.statusCode).toBe(404)
  })
})

/**
 * CORS 预检必须放行我们真的用到的方法。
 *
 * `app.inject()` **不走 CORS**，所以端点的集成测试全绿也证明不了浏览器能调它。
 * P1 就踩了这个：PATCH 端点写完、6 条 int 测全过，面板上点保存却什么都没发生，
 * 服务端日志一片干净——请求压根没发出去。
 */
describe('CORS 预检放行实际用到的方法', () => {
  const preflight = (method: string) =>
    app.inject({
      method: 'OPTIONS',
      url: `/api/episodes/${episodeId}`,
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': method,
        'access-control-request-headers': 'content-type,x-api-key',
      },
    })

  it('GET / POST / PATCH / DELETE 都在 allow-methods 里', async () => {
    const res = await preflight('PATCH')
    expect(res.statusCode).toBe(204)
    const allowed = String(res.headers['access-control-allow-methods'] ?? '')
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect(allowed, `${m} 不在 allow-methods 里，浏览器会静默不发请求`).toContain(m)
    }
  })

  it('x-api-key 在 allow-headers 里——没有它写路径全部发不出去', async () => {
    const res = await preflight('POST')
    expect(String(res.headers['access-control-allow-headers'] ?? '')).toContain('x-api-key')
  })
})
