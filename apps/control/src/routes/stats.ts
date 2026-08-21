import { and, eq, gte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { budgetFromEnv } from '../pipeline/batch.js'

/**
 * 管理面板的聚合端点（见 docs/superpowers/specs/2026-08-15-web-admin-panel-design.md）。
 *
 * 与 `/api/projects/:id/stats` 的区别：那个是单项目的，这里是**跨项目**的经营口径。
 */

/**
 * 区间 → 粒度是自动推导的，不让调用方指定。
 * 365 个日粒度点挤在一张卡片宽度里既读不出趋势也画不清。
 */
const RANGES = {
  '30d': { interval: '30 days', granularity: 'day' },
  '3m': { interval: '3 months', granularity: 'day' },
  '6m': { interval: '6 months', granularity: 'week' },
  '1y': { interval: '1 year', granularity: 'week' },
  all: { interval: null, granularity: 'month' },
} as const

export type RangeKey = keyof typeof RANGES

const RangeQuery = z.object({
  range: z.enum(['30d', '3m', '6m', '1y', 'all']).default('30d'),
})

/**
 * mock provider 产生的成本不是真实计费。
 *
 * 面板上一个 `$0.65` 和真实账单上的 `$0.65` 长得一模一样，不标出来就是在
 * 撒谎——尤其是「每可用镜头成本」这种会被拿去做决策的数字。所以每个成本
 * 聚合都同时给出其中的 mock 部分，由界面决定怎么标。
 *
 * 判据是 `provider_id = 'mock'`（见 providers/mock.ts）。M1 接入真实
 * provider 后这个分子自然变小，不需要改这里。
 */
const MOCK_PROVIDER_ID = 'mock'

const mockCostSql = sql<string>`coalesce(sum(${s.generationJobs.costMicroUsd}) filter (where ${s.generationJobs.providerId} = ${MOCK_PROVIDER_ID}), 0)`

export interface OverviewResponse {
  totals: {
    projects: number
    shots: number
    costMicroUsd: number
    /** 其中由 mock provider 产生的部分。等于 costMicroUsd 时说明全是演示数据 */
    mockCostMicroUsd: number
    /** 每可用镜头成本——比「每秒多少钱」有意义得多，它把重试率算了进去 */
    usdPerAcceptedMicro: number | null
  }
  attention: { failedShots: number; pendingReview: number }
  queue: { running: number; queued: number }
  budget: { spentTodayMicroUsd: number; dailyLimitMicroUsd: number }
  /**
   * 可扩展性的落点：这两个区块现在就存在。M4 接投放回传时是**填充**它们，
   * 而不是改结构——前端卡片的位置与类型都不用动。代价只是两个 null 字段。
   */
  distribution: null | { spendMicroUsd: number; impressions: number; installs: number }
  revenue: null | { grossMicroUsd: number; roi: number }
}

export function registerStats(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps

  app.get('/api/stats/overview', async (): Promise<OverviewResponse> => {
    const policy = budgetFromEnv()

    const [counts] = await db
      .select({
        projects: sql<number>`(select count(*) from ${s.projects})::int`,
        shots: sql<number>`(select count(*) from ${s.shots})::int`,
        failedShots: sql<number>`(select count(*) from ${s.shots} where ${s.shots.status} = 'failed')::int`,
        pendingReview: sql<number>`(select count(*) from ${s.shots} where ${s.shots.status} = 'review')::int`,
        generating: sql<number>`(select count(*) from ${s.shots} where ${s.shots.status} = 'generating')::int`,
      })
      .from(sql`(select 1) as _`)

    const [cost] = await db
      .select({
        total: sql<string>`coalesce(sum(${s.generationJobs.costMicroUsd}), 0)`,
        mock: mockCostSql,
        accepted: sql<number>`count(*) filter (where ${s.generationJobs.accepted})::int`,
      })
      .from(s.generationJobs)

    const [today] = await db
      .select({ total: sql<string>`coalesce(sum(${s.generationJobs.costMicroUsd}), 0)` })
      .from(s.generationJobs)
      .where(gte(s.generationJobs.createdAt, sql`date_trunc('day', now())`))

    const [queued] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.generationJobs)
      .where(sql`${s.generationJobs.status} in ('queued','submitted')`)

    const totalMicroUsd = Number(cost?.total ?? 0)
    const accepted = cost?.accepted ?? 0

    return {
      totals: {
        projects: counts?.projects ?? 0,
        shots: counts?.shots ?? 0,
        costMicroUsd: totalMicroUsd,
        mockCostMicroUsd: Number(cost?.mock ?? 0),
        usdPerAcceptedMicro: accepted > 0 ? Math.round(totalMicroUsd / accepted) : null,
      },
      attention: {
        failedShots: counts?.failedShots ?? 0,
        pendingReview: counts?.pendingReview ?? 0,
      },
      queue: { running: counts?.generating ?? 0, queued: queued?.n ?? 0 },
      budget: {
        spentTodayMicroUsd: Number(today?.total ?? 0),
        dailyLimitMicroUsd: policy.dailyLimitMicroUsd,
      },
      distribution: null,
      revenue: null,
    }
  })

  app.get('/api/stats/timeseries', async (req) => {
    const { range } = RangeQuery.parse(req.query)
    const { interval, granularity } = RANGES[range]

    // 粒度与区间都是白名单里的字面量，不是用户输入拼进 SQL 的
    const bucket = sql.raw(`date_trunc('${granularity}', created_at)`)
    const since = interval ? sql`created_at >= now() - interval '${sql.raw(interval)}'` : sql`true`

    const rows = await db
      .select({
        at: sql<string>`to_char(${bucket}, 'YYYY-MM-DD')`,
        costMicroUsd: sql<string>`coalesce(sum(cost_micro_usd), 0)`,
        mockCostMicroUsd: sql<string>`coalesce(sum(cost_micro_usd) filter (where provider_id = ${MOCK_PROVIDER_ID}), 0)`,
        attempts: sql<number>`count(*)::int`,
        // 一次通过率的分子：首次尝试即被采用
        accepted: sql<number>`count(*) filter (where accepted)::int`,
        firstPass: sql<number>`count(*) filter (where accepted and attempt = 1)::int`,
      })
      .from(s.generationJobs)
      .where(since)
      .groupBy(bucket)
      .orderBy(bucket)

    return {
      range,
      granularity,
      points: rows.map((r) => ({
        at: r.at,
        costMicroUsd: Number(r.costMicroUsd),
        mockCostMicroUsd: Number(r.mockCostMicroUsd),
        attempts: r.attempts,
        accepted: r.accepted,
        firstPass: r.firstPass,
      })),
    }
  })

  /**
   * 项目列表带聚合，避免前端 N+1。
   *
   * 用 join + groupBy 而不是相关子查询：后者在 drizzle 里插值列对象时
   * 不会带表限定，会生成 `where "project_id" = "id"` 这种有歧义的 SQL。
   * join 版本也更快——一次扫描而不是每行 N 个子查询。
   *
   * 注意 count(distinct)：join generation_jobs 会让 shots 行按尝试次数
   * 重复，不 distinct 会把镜头数算成尝试数。
   */
  app.get('/api/projects/summary', async () => {
    const rows = await db
      .select({
        project: s.projects,
        episodes: sql<number>`count(distinct ${s.episodes.id})::int`,
        shots: sql<number>`count(distinct ${s.shots.id})::int`,
        locked: sql<number>`count(distinct ${s.shots.id}) filter (where ${s.shots.status} = 'locked')::int`,
        costMicroUsd: sql<string>`coalesce(sum(${s.generationJobs.costMicroUsd}), 0)`,
        mockCostMicroUsd: mockCostSql,
      })
      .from(s.projects)
      .leftJoin(s.episodes, eq(s.episodes.projectId, s.projects.id))
      .leftJoin(s.scenes, eq(s.scenes.episodeId, s.episodes.id))
      .leftJoin(s.shots, eq(s.shots.sceneId, s.scenes.id))
      .leftJoin(s.generationJobs, eq(s.generationJobs.shotId, s.shots.id))
      .groupBy(s.projects.id)
      .orderBy(sql`${s.projects.createdAt} desc`)

    return {
      projects: rows.map((r) => ({
        ...r.project,
        episodes: r.episodes,
        shots: r.shots,
        locked: r.locked,
        costMicroUsd: Number(r.costMicroUsd),
        mockCostMicroUsd: Number(r.mockCostMicroUsd),
      })),
    }
  })

  /** 一个项目的分集列表，带标题与进度——导航层级里缺失的那一级 */
  app.get('/api/projects/:id/episodes', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const rows = await db
      .select({
        episode: s.episodes,
        shots: sql<number>`count(distinct ${s.shots.id})::int`,
        locked: sql<number>`count(distinct ${s.shots.id}) filter (where ${s.shots.status} = 'locked')::int`,
        review: sql<number>`count(distinct ${s.shots.id}) filter (where ${s.shots.status} = 'review')::int`,
        costMicroUsd: sql<string>`coalesce(sum(${s.generationJobs.costMicroUsd}), 0)`,
        mockCostMicroUsd: mockCostSql,
        /*
         * 有没有成片。分集列表是找片子最自然的地方，而此前唯一通向 `/watch`
         * 的路径是渲染那一刻的 `window.open`——关掉标签页就再也找不到了。
         */
        hasMaster: sql<boolean>`exists (
          select 1 from ${s.renderJobs} rj
          join ${s.timelines} tl on tl.id = rj.timeline_id
          where tl.episode_id = ${s.episodes.id} and rj.status = 'succeeded'
        )`,
      })
      .from(s.episodes)
      .leftJoin(s.scenes, eq(s.scenes.episodeId, s.episodes.id))
      .leftJoin(s.shots, eq(s.shots.sceneId, s.scenes.id))
      .leftJoin(s.generationJobs, eq(s.generationJobs.shotId, s.shots.id))
      .where(eq(s.episodes.projectId, id))
      .groupBy(s.episodes.id)
      .orderBy(s.episodes.index)

    return {
      episodes: rows.map((r) => ({
        ...r.episode,
        hasMaster: r.hasMaster,
        shots: r.shots,
        locked: r.locked,
        review: r.review,
        costMicroUsd: Number(r.costMicroUsd),
        mockCostMicroUsd: Number(r.mockCostMicroUsd),
      })),
    }
  })

  /** 项目的一致性资产。本轮只读——锁定闸门的交互见 issue #16 */
  app.get('/api/projects/:id/assets', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const [characters, locations, styles] = await Promise.all([
      db.select().from(s.characters).where(eq(s.characters.projectId, id)),
      db.select().from(s.locations).where(eq(s.locations.projectId, id)),
      db.select().from(s.styleProfiles).where(eq(s.styleProfiles.projectId, id)),
    ])
    return { characters, locations, styles }
  })

  /** 跨项目的待办：失败与待选片的镜头，点进去要能直达 */
  app.get('/api/attention', async () => {
    const rows = await db
      .select({
        shotId: s.shots.id,
        shotIndex: s.shots.index,
        status: s.shots.status,
        action: s.shots.action,
        episodeId: s.episodes.id,
        episodeIndex: s.episodes.index,
        episodeTitle: s.episodes.title,
        projectId: s.projects.id,
        projectTitle: s.projects.title,
      })
      .from(s.shots)
      .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
      .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
      .innerJoin(s.projects, eq(s.episodes.projectId, s.projects.id))
      .where(and(sql`${s.shots.status} in ('failed','review')`))
      .orderBy(s.shots.status, s.shots.index)
      .limit(50)
    return { items: rows }
  })
}
