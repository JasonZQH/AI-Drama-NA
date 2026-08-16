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

const DB_URL = process.env['DATABASE_URL'] ?? 'postgresql://drama:drama@localhost:5433/drama'
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
    healthProbe: () => client`SELECT 1`,
    makeSubscriber: () => createConnection(REDIS_URL),
  })
  await app.ready()

  const [p] = await db.select().from(s.projects).limit(1)
  if (!p) throw new Error('库里没有 project，先跑 pnpm db:seed')
  projectId = p.id
  const [ep] = await db.select().from(s.episodes).where(eq(s.episodes.projectId, projectId)).limit(1)
  episodeId = ep!.id
  const [sh] = await db.select().from(s.shots).limit(1)
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
  // 把镜头拨回 ready，让每轮从同一起点开始
  await db.update(s.shots).set({ status: 'ready', selectedTakeId: null, attemptCount: 0 })
  await queues.generate.drain(true)
}

afterAll(async () => {
  await cleanup()
  await app.close()
  await queues.close()
  await client.end()
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
    const r = await app.inject({ method: 'POST', url: `/api/shots/${shotId}/generate` })
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('INVALID_STATE_TRANSITION')
    expect(r.json().error.details).toMatchObject({ from: 'draft', event: 'generate.requested' })
    await db.update(s.shots).set({ status: 'ready' }).where(eq(s.shots.id, shotId))
  })

  it('ready 镜头 generate 回 202，写入 job 并入队', async () => {
    await queues.generate.drain(true)
    const r = await app.inject({ method: 'POST', url: `/api/shots/${shotId}/generate` })
    expect(r.statusCode).toBe(202)
    expect(r.json().status).toBe('generating')

    const jobs = await db.select().from(s.generationJobs).where(eq(s.generationJobs.shotId, shotId))
    expect(jobs.length).toBeGreaterThan(0)

    const queued = await queues.generate.getJobs(['waiting', 'prioritized', 'delayed'])
    expect(queued.length).toBeGreaterThan(0)
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
