import type { GenerationRequest, VideoProvider } from '@ai-drama/contracts'
import { routeProvider } from '../providers/route.js'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client.js'
import * as s from '../db/schema.js'

/**
 * 批量生成的计划阶段（03-pipeline.md §6 + 05-job-orchestration.md §6）。
 *
 * 「生成整集」不是简单地把所有镜头入队：
 * - 有 continuityFromShotId 依赖且前序未 locked 的必须暂缓，否则拿不到末帧
 * - 入队前要过预算闸门，避免一次误操作把整批打到云 API 上
 *
 * dryRun 先算出「这批要花多少钱、有几个镜头会被依赖阻塞」，是 UI 上
 * 「生成整集」确认弹窗的数据来源（06-api-spec.md §4）。
 */

export interface BatchPlan {
  readonly runnable: readonly string[]
  /** 因连续性依赖未解锁而暂缓 */
  readonly blocked: readonly string[]
  /** 已 locked，跳过 */
  readonly skipped: readonly string[]
  readonly estimatedCostMicroUsd: number
  readonly budget: BudgetСheckResult
}

export interface BudgetСheckResult {
  readonly dailyLimitMicroUsd: number
  readonly spentTodayMicroUsd: number
  readonly wouldExceed: boolean
  readonly onExceed: 'block' | 'warn'
}

export interface BudgetPolicy {
  readonly dailyLimitMicroUsd: number
  readonly onExceed: 'block' | 'warn'
}

export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetPolicy {
  return {
    dailyLimitMicroUsd: Number(env['BUDGET_DAILY_MICRO_USD'] ?? 5_000_000),
    onExceed: env['BUDGET_ON_EXCEED'] === 'warn' ? 'warn' : 'block',
  }
}

/**
 * 依赖解析：有前序依赖且前序未 locked 的镜头保持 ready 不入队。
 * 批次完成后重新解析一轮，把新解锁的推进去，直到没有 runnable 为止。
 */
export function resolveDependencies(
  shots: readonly { id: string; status: string; continuityFromShotId: string | null }[],
): { runnable: string[]; blocked: string[]; skipped: string[] } {
  const locked = new Set(shots.filter((x) => x.status === 'locked').map((x) => x.id))
  const runnable: string[] = []
  const blocked: string[] = []
  const skipped: string[] = []

  for (const shot of shots) {
    if (shot.status === 'locked' || shot.status === 'skipped') {
      skipped.push(shot.id)
    } else if (shot.status !== 'ready') {
      // draft / generating / review / failed 都不该被批量入队重复触发
      skipped.push(shot.id)
    } else if (shot.continuityFromShotId && !locked.has(shot.continuityFromShotId)) {
      blocked.push(shot.id)
    } else {
      runnable.push(shot.id)
    }
  }
  return { runnable, blocked, skipped }
}

/**
 * 同一个项目今天已花 + **在途预留**，从某个镜头反查。
 *
 * 闸门下沉到 `applyShotTransition` 之后要在事务里问这个数，所以收 `DbOrTx`；
 * 入口是 shotId 而不是 projectId，因为那里手上只有镜头。
 */
export async function spentTodayForShot(db: DbOrTx, shotId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${s.generationJobs.costMicroUsd}), 0)` })
    .from(s.generationJobs)
    .innerJoin(s.shots, eq(s.generationJobs.shotId, s.shots.id))
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
    .where(
      and(
        sql`${s.episodes.projectId} = (
          select e.project_id from ${s.shots} sh
          join ${s.scenes} sc on sc.id = sh.scene_id
          join ${s.episodes} e on e.id = sc.episode_id
          where sh.id = ${shotId}
        )`,
        gte(s.generationJobs.createdAt, sql`date_trunc('day', now())`),
      ),
    )
  return Number(row?.total ?? 0)
}

/** 今日已花费。成本以整数微美元存储，浮点算钱迟早出问题（02 §1） */
export async function spentToday(db: Db, projectId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${s.generationJobs.costMicroUsd}), 0)` })
    .from(s.generationJobs)
    .innerJoin(s.shots, eq(s.generationJobs.shotId, s.shots.id))
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
    .where(
      and(
        eq(s.episodes.projectId, projectId),
        gte(s.generationJobs.createdAt, sql`date_trunc('day', now())`),
      ),
    )
  return Number(row?.total ?? 0)
}

export async function planBatch(
  db: Db,
  episodeId: string,
  /**
   * **整个池子，不是某一个 provider。**
   *
   * 此前这里收单个 `VideoProvider`，调用方传的是 `deps.providers[0]` ——而
   * `buildProviderPool` 把 mock 排在最前。于是 dryRun 用 **mock 的价目表**给
   * 每一镜估价，而实际入队时 `applyTransition` 会按 `provider_hint` 路由到真
   * provider。
   *
   * 真钱实测撞到的数字：面板显示「预估 **$0.60**」，实际是 11 × $0.3667 =
   * **$4.03**——低估 **10 倍**，而**预算闸门读的就是这个数**。
   *
   * `applyTransition` 里那句注释早就写着「估算用的是路由选出来的那家的价目表，
   * 不是 providers[0] 的——否则 dryRun 的数与实际扣费不是一回事」。单镜路径
   * 是对的，批量路径漏了。
   */
  pool: readonly VideoProvider[],
  policy: BudgetPolicy,
): Promise<BatchPlan> {
  const shots = await db
    .select({
      id: s.shots.id,
      status: s.shots.status,
      continuityFromShotId: s.shots.continuityFromShotId,
      durationSec: s.shots.durationSec,
      sceneId: s.shots.sceneId,
      providerHint: s.shots.providerHint,
      safetyProfile: s.shots.safetyProfile,
    })
    .from(s.shots)
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .where(eq(s.scenes.episodeId, episodeId))
    .orderBy(s.shots.index)

  const { runnable, blocked, skipped } = resolveDependencies(shots)

  /*
   * 事前估算，用于预算闸门与确认弹窗（04 §3 estimateCost）。
   *
   * **每一镜各自路由再估价**——同一集里不同镜头可以指定不同 provider，而不同
   * provider 的单价差 10 倍。用一家的价目表乘以镜头数得到的是一个碰巧的数。
   */
  const estimatedCostMicroUsd = runnable.reduce((sum, id) => {
    const shot = shots.find((x) => x.id === id)
    const probe: GenerationRequest = {
      requestId: '00000000-0000-4000-8000-000000000000',
      shotId: id,
      mode: 't2v',
      prompt: '',
      refImages: [],
      durationSec: Number(shot?.durationSec ?? 4),
      resolution: '720p',
      aspectRatio: '9:16',
      fps: 24,
      safetyProfile: shot?.safetyProfile ?? 'standard',
      priority: 'normal',
      providerParams: {},
    }
    const routed = routeProvider(pool, {
      providerHint: shot?.providerHint ?? null,
      filteredBy: [],
      probe,
    })
    // 路由不到就记 0：那一镜入队时会被判 NO_PROVIDER，本来就不会花钱
    return sum + (routed ? routed.provider.estimateCost(probe) : 0)
  }, 0)

  const [ep] = await db
    .select({ projectId: s.episodes.projectId })
    .from(s.episodes)
    .where(eq(s.episodes.id, episodeId))
  const spent = ep ? await spentToday(db, ep.projectId) : 0

  return {
    runnable,
    blocked,
    skipped,
    estimatedCostMicroUsd,
    budget: {
      dailyLimitMicroUsd: policy.dailyLimitMicroUsd,
      spentTodayMicroUsd: spent,
      wouldExceed: spent + estimatedCostMicroUsd > policy.dailyLimitMicroUsd,
      onExceed: policy.onExceed,
    },
  }
}
