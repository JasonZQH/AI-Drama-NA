import { ShotStatus } from '@ai-drama/contracts'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { budgetFromEnv, planBatch } from '../pipeline/batch.js'
import { transition, type ShotEvent, type ShotState } from '../pipeline/shotMachine.js'
import { createGenerationJob } from '../queue/ingest.js'
import type { Queues } from '../queue/queues.js'
import type { Storage } from '../storage/s3.js'
import { ApiError } from './errors.js'
import type { VideoProvider } from '@ai-drama/contracts'

export interface ApiDeps {
  readonly db: Db
  readonly queues: Queues
  readonly storage: Storage
  readonly providers: readonly VideoProvider[]
  readonly maxAttempts: number
}

const Uuid = z.object({ id: z.string().uuid() })

/** 状态迁移统一入口：非法迁移回 400，effects 交给调用方执行（03 §3） */
async function applyTransition(
  deps: ApiDeps,
  shotId: string,
  event: ShotEvent,
): Promise<{ next: ShotStatus }> {
  const [row] = await deps.db.select().from(s.shots).where(eq(s.shots.id, shotId))
  if (!row) throw new ApiError('NOT_FOUND', `shot ${shotId} 不存在`)

  const state: ShotState = {
    id: row.id,
    status: row.status,
    attemptCount: row.attemptCount,
    selectedTakeId: row.selectedTakeId,
  }
  const r = transition(state, event, { maxAttempts: deps.maxAttempts })
  if (!r.ok) throw new ApiError('INVALID_STATE_TRANSITION', r.reason, { from: row.status, event: event.type })

  for (const e of r.effects) {
    switch (e.type) {
      case 'enqueue.generation': {
        const jobId = await createGenerationJob(deps.db, {
          shotId: e.shotId,
          attempt: e.attempt,
          providerId: deps.providers[0]!.id,
          modelId: 'mock-v1',
          mode: 't2v',
          promptText: row.promptOverride ?? `${row.action}, ${row.shotType}`,
          params: {
            durationSec: Number(row.durationSec),
            resolution: '720p',
            aspectRatio: '9:16',
            fps: 24,
          },
        })
        await deps.queues.generate.add('generate', { generationJobId: jobId, shotId: e.shotId })
        await deps.db.update(s.shots).set({ attemptCount: e.attempt }).where(eq(s.shots.id, e.shotId))
        break
      }
      case 'set.selectedTake':
        await deps.db.update(s.takes).set({ status: 'selected' }).where(eq(s.takes.id, e.takeId))
        await deps.db.update(s.shots).set({ selectedTakeId: e.takeId }).where(eq(s.shots.id, e.shotId))
        break
      case 'clear.selectedTake':
        await deps.db.update(s.shots).set({ selectedTakeId: null }).where(eq(s.shots.id, e.shotId))
        break
      case 'archive.takes':
        // 归档而非删除：系统永不自动销毁已经花钱生成的东西（03 §7）
        await deps.db
          .update(s.takes)
          .set({ status: 'archived' })
          .where(and(eq(s.takes.shotId, e.shotId), eq(s.takes.status, 'candidate')))
        break
      case 'publish':
        await deps.queues.notify.add('notify', { projectId: '', payload: e.event })
        break
    }
  }

  await deps.db.update(s.shots).set({ status: r.next, updatedAt: new Date() }).where(eq(s.shots.id, shotId))
  return { next: r.next }
}

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps

  app.get('/api/projects', async () => ({
    projects: await db.select().from(s.projects).orderBy(desc(s.projects.createdAt)),
  }))

  app.get('/api/projects/:id', async (req) => {
    const { id } = Uuid.parse(req.params)
    const [p] = await db.select().from(s.projects).where(eq(s.projects.id, id))
    if (!p) throw new ApiError('NOT_FOUND', `project ${id} 不存在`)
    const episodes = await db
      .select()
      .from(s.episodes)
      .where(eq(s.episodes.projectId, id))
      .orderBy(s.episodes.index)
    return { project: p, episodes }
  })

  /** 分镜页的数据源：一集的场次 + 镜头 + 每镜的 take 数（08 §2） */
  app.get('/api/episodes/:id', async (req) => {
    const { id } = Uuid.parse(req.params)
    const [ep] = await db.select().from(s.episodes).where(eq(s.episodes.id, id))
    if (!ep) throw new ApiError('NOT_FOUND', `episode ${id} 不存在`)

    const scenes = await db.select().from(s.scenes).where(eq(s.scenes.episodeId, id)).orderBy(s.scenes.index)
    const shots = await db
      .select({
        shot: s.shots,
        takeCount: sql<number>`(select count(*) from ${s.takes} where ${s.takes.shotId} = ${s.shots.id} and ${s.takes.status} = 'candidate')::int`,
        costMicroUsd: sql<number>`(select coalesce(sum(${s.generationJobs.costMicroUsd}), 0) from ${s.generationJobs} where ${s.generationJobs.shotId} = ${s.shots.id})::bigint`,
      })
      .from(s.shots)
      .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
      .where(eq(s.scenes.episodeId, id))
      .orderBy(s.shots.index)

    return { episode: ep, scenes, shots }
  })

  app.post('/api/shots/:id/generate', async (req, reply) => {
    const { id } = Uuid.parse(req.params)
    const r = await applyTransition(deps, id, { type: 'generate.requested' })
    return reply.status(202).send({ shotId: id, status: r.next })
  })

  /**
   * 「生成整集」。**dryRun 是必须先用的**——它把「这批要花多少钱、有几个镜头
   * 会被依赖阻塞」先算出来，UI 的确认弹窗就靠它（06 §4）。
   */
  app.post('/api/episodes/:id/generate-batch', async (req, reply) => {
    const { id } = Uuid.parse(req.params)
    const body = z.object({ dryRun: z.boolean().default(false) }).parse(req.body ?? {})

    const provider = deps.providers[0]
    if (!provider) throw new ApiError('NO_PROVIDER_AVAILABLE', '池内没有可用的 provider')

    const plan = await planBatch(db, id, provider, budgetFromEnv())

    if (body.dryRun) {
      return {
        planned: plan.runnable.length,
        blocked: plan.blocked.length,
        skipped: plan.skipped.length,
        estimatedCostMicroUsd: plan.estimatedCostMicroUsd,
        budget: plan.budget,
      }
    }

    // 超限时 block 会让批量入队直接失败并在 UI 弹出，而不是安静地烧钱（05 §6）
    if (plan.budget.wouldExceed && plan.budget.onExceed === 'block') {
      throw new ApiError(
        'BUDGET_EXCEEDED',
        `预估 ${plan.estimatedCostMicroUsd} + 已花 ${plan.budget.spentTodayMicroUsd} 超过日限 ${plan.budget.dailyLimitMicroUsd}（微美元）`,
        { ...plan.budget, estimatedCostMicroUsd: plan.estimatedCostMicroUsd },
      )
    }

    const batchId = randomUUID()
    for (const shotId of plan.runnable) {
      await applyTransition(deps, shotId, { type: 'generate.requested' })
    }

    return reply.status(202).send({
      batchId,
      planned: plan.runnable.length,
      blocked: plan.blocked.length,
      estimatedCostMicroUsd: plan.estimatedCostMicroUsd,
    })
  })

  app.get('/api/shots/:id/takes', async (req) => {
    const { id } = Uuid.parse(req.params)
    const takes = await db
      .select({ take: s.takes, asset: s.assets, job: s.generationJobs })
      .from(s.takes)
      .innerJoin(s.assets, eq(s.takes.assetId, s.assets.id))
      .innerJoin(s.generationJobs, eq(s.takes.jobId, s.generationJobs.id))
      .where(eq(s.takes.shotId, id))
      .orderBy(desc(s.takes.createdAt))
    return { takes }
  })

  app.post('/api/takes/:id/select', async (req) => {
    const { id } = Uuid.parse(req.params)
    const [take] = await db.select().from(s.takes).where(eq(s.takes.id, id))
    if (!take) throw new ApiError('NOT_FOUND', `take ${id} 不存在`)
    const r = await applyTransition(deps, take.shotId, { type: 'take.selected', takeId: id })
    return { shotId: take.shotId, status: r.next, selectedTakeId: id }
  })

  app.post('/api/takes/:id/reject', async (req) => {
    const { id } = Uuid.parse(req.params)
    const [take] = await db.select().from(s.takes).where(eq(s.takes.id, id))
    if (!take) throw new ApiError('NOT_FOUND', `take ${id} 不存在`)
    await db.update(s.takes).set({ status: 'rejected' }).where(eq(s.takes.id, id))

    const [remaining] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.takes)
      .where(and(eq(s.takes.shotId, take.shotId), eq(s.takes.status, 'candidate')))

    // 全部拒绝才触发重试升级；还有候选就停留在 review
    if ((remaining?.n ?? 0) === 0) {
      const r = await applyTransition(deps, take.shotId, { type: 'takes.allRejected' })
      return { shotId: take.shotId, status: r.next, remaining: 0 }
    }
    return { shotId: take.shotId, status: 'review', remaining: remaining?.n ?? 0 }
  })

  /** Generation Ledger 视图：一个镜头的全部生成尝试，含失败的（C4） */
  app.get('/api/shots/:id/jobs', async (req) => {
    const { id } = Uuid.parse(req.params)
    return {
      jobs: await db
        .select()
        .from(s.generationJobs)
        .where(eq(s.generationJobs.shotId, id))
        .orderBy(s.generationJobs.attempt),
    }
  })

  /** 302 到预签名 URL。**控制面绝不代理媒体字节流**（10 §1.2） */
  app.get('/api/assets/:id/content', async (req, reply) => {
    const { id } = Uuid.parse(req.params)
    const [asset] = await db.select().from(s.assets).where(eq(s.assets.id, id))
    if (!asset) throw new ApiError('NOT_FOUND', `asset ${id} 不存在`)
    return reply.redirect(await deps.storage.presignGet(asset.storageKey, 900), 302)
  })

  /** 洞察页与顶栏 CostMeter 的数据源（08 §6、07 §6.1） */
  app.get('/api/projects/:id/stats', async (req) => {
    const { id } = Uuid.parse(req.params)
    const policy = budgetFromEnv()

    const byStatus = await db
      .select({ status: s.shots.status, n: sql<number>`count(*)::int` })
      .from(s.shots)
      .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
      .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
      .where(eq(s.episodes.projectId, id))
      .groupBy(s.shots.status)

    const [cost] = await db
      .select({
        total: sql<string>`coalesce(sum(${s.generationJobs.costMicroUsd}), 0)`,
        attempts: sql<number>`count(*)::int`,
        accepted: sql<number>`count(*) filter (where ${s.generationJobs.accepted})::int`,
      })
      .from(s.generationJobs)
      .innerJoin(s.shots, eq(s.generationJobs.shotId, s.shots.id))
      .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
      .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
      .where(eq(s.episodes.projectId, id))

    const shots = Object.fromEntries(ShotStatus.options.map((k) => [k, 0])) as Record<string, number>
    for (const r of byStatus) shots[r.status] = r.n

    const accepted = cost?.accepted ?? 0
    const totalMicroUsd = Number(cost?.total ?? 0)

    return {
      shots,
      cost: {
        totalMicroUsd,
        // CostMeter 的分母。目前来自全局 env，按项目区分见 issue #9
        dailyLimitMicroUsd: policy.dailyLimitMicroUsd,
      },
      quality: {
        attempts: cost?.attempts ?? 0,
        accepted,
        // 每可用镜头成本——比「每秒多少钱」有意义得多，它把重试率算了进去
        usdPerAcceptedMicro: accepted > 0 ? Math.round(totalMicroUsd / accepted) : null,
      },
    }
  })
}
