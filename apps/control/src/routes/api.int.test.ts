import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../db/client.js'
import * as s from '../db/schema.js'
import { MockProvider } from '../providers/mock.js'
import { createConnection, createQueues } from '../queue/queues.js'
import { buildServer } from '../server.js'
import { Storage, storageFromEnv } from '../storage/s3.js'
import { resolveDependencies } from '../pipeline/batch.js'

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

  const [p] = await db.select().from(s.projects).limit(1)
  if (!p) throw new Error('库里没有 project，先跑 pnpm db:seed')
  projectId = p.id
  const [ep] = await db.select().from(s.episodes).where(eq(s.episodes.projectId, projectId)).limit(1)
  episodeId = ep!.id
  // 必须 ORDER BY：不加的话 Postgres 返回顺序不确定，会与并发/后续的测试
  // 文件抢同一个镜头，表现为「有时过有时不过」
  const [sh] = await db.select().from(s.shots).orderBy(s.shots.index).limit(1)
  shotId = sh!.id

  await cleanup()
})

async function cleanup(): Promise<void> {
  const stale = await db
    .select({ id: s.generationJobs.id })
    .from(s.generationJobs)
    .where(
      and(gte(s.generationJobs.attempt, TEST_ATTEMPT_BASE), lt(s.generationJobs.attempt, TEST_ATTEMPT_MAX)),
    )
  if (stale.length > 0) {
    const ids = stale.map((r) => r.id)
    await db.delete(s.takes).where(inArray(s.takes.jobId, ids))
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
