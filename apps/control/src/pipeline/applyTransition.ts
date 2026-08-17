import type { VideoProvider } from '@ai-drama/contracts'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { createGenerationJob } from '../queue/ingest.js'
import type { Queues } from '../queue/queues.js'
import { budgetFromEnv, spentTodayForShot, type BudgetPolicy, type BudgetСheckResult } from './batch.js'
import { transition, type ShotEvent } from './shotMachine.js'

/**
 * 状态迁移的**唯一执行点**。
 *
 * 状态机本身是纯函数、只返回 Effect[]；这里负责把那些副作用真的做掉。
 * HTTP 路由与队列 handler 都必须走这里——曾经它只存在于 routes 里，
 * 于是 ingest 建完 take 没人推进状态机，镜头永远停在 generating。
 */

/**
 * 这里只用得上「往两个队列里塞东西」，所以只要这两个能力。
 *
 * 收窄不是洁癖：要整个 `Queues` 的话，测试里想换掉 `generate.add`（比如验
 * 「入队失败不该回滚已提交的迁移」）就只能写 `as unknown as Queues` ——
 * 而 eslint 明令禁止双重断言，它的提示恰好是「先问为什么类型对不上」。
 * 答案就是这个：依赖声明得比实际用到的宽。
 */
export interface TransitionQueues {
  readonly generate: Pick<Queues['generate'], 'add'>
  readonly notify: Pick<Queues['notify'], 'add'>
}

export interface TransitionDeps {
  readonly db: Db
  readonly queues: TransitionQueues
  /**
   * 要整个 provider 而不只是它的 id：闸门下沉到这里之后需要 `estimateCost`
   * 来算预留（provider 路由器落地时这个字段会换成一个解析函数）。
   */
  readonly provider: VideoProvider
  readonly maxAttempts: number
  /** 不传则读 env。测试要压低日限额时传它，不必去改 process.env */
  readonly budget?: BudgetPolicy
}

export type ApplyResult =
  | { readonly ok: true; readonly next: string }
  | {
      readonly ok: false
      /**
       * 两种拒绝要分开：状态机拒绝是 400（用户点错了），预算拒绝是 402
       * （用户没点错，是钱不够）。混成一种的话 UI 说不清该让人做什么。
       */
      readonly code: 'INVALID_TRANSITION' | 'BUDGET_EXCEEDED'
      readonly reason: string
      readonly from: string
      readonly budget?: BudgetСheckResult
    }

/**
 * 一次迁移里所有要入队的东西。**必须等事务提交之后再发。**
 *
 * 在事务里发有两个问题，第二个更贵：
 * 1. 一次 Redis 往返被圈进了 Postgres 的行锁持有期，锁白白多握几毫秒；
 * 2. 事务如果回滚，队列条目**不会跟着回滚**——于是留下一条指向不存在的
 *    generation_jobs 行的任务。handleGenerate 读不到行只会 return 'skipped'，
 *    看起来无害，但它掩盖了「这次迁移其实失败了」这件事。
 */
type Pending = () => Promise<unknown>

export async function applyShotTransition(
  deps: TransitionDeps,
  shotId: string,
  event: ShotEvent,
): Promise<ApplyResult | null> {
  const pending: Pending[] = []

  /*
   * 整段包进一个事务，并对 shot 行加锁。
   *
   * 这里原本是「读状态 → 依次做副作用 → 最后写状态」的裸序列，中间没有任何
   * 边界。两个后果，都实际会发生：
   *
   * - **并发**：两个请求同时读到 status='ready'，双双通过状态机校验，各建一行
   *   generation_jobs——同一个镜头付两次钱。attempt 号来自 shots.attemptCount
   *   的无锁读-改-写，所以连 UNIQUE(shot_id, attempt) 都挡不住（拿到的是 N+1
   *   和 N+2 两个合法号）。撞成同一个号时唯一约束抛出的裸 pg 错又会变成 500。
   * - **中断**：崩在「建了 job 行」与「写 shot 状态」之间，会留下 job 已入队
   *   而 shot 仍是 ready 的半完成状态；下次 reconcileOnBoot 会替它真花一笔钱，
   *   而产物回来时 take.accepted 打在 ready 上会被状态机拒掉——钱花了，
   *   take 成孤儿。
   *
   * FOR UPDATE 让第二个事务阻塞在行锁上，等第一个提交后重新读到新状态，
   * 于是状态机干净地拒绝它（400 而不是 500，也不是第二笔钱）。
   */
  const result = await deps.db.transaction(async (tx): Promise<ApplyResult | null> => {
    const [row] = await tx.select().from(s.shots).where(eq(s.shots.id, shotId)).for('update')
    if (!row) return null

    const r = transition(
      {
        id: row.id,
        status: row.status,
        attemptCount: row.attemptCount,
        selectedTakeId: row.selectedTakeId,
      },
      event,
      { maxAttempts: deps.maxAttempts },
    )
    if (!r.ok) return { ok: false, code: 'INVALID_TRANSITION', reason: r.reason, from: row.status }

    for (const e of r.effects) {
      switch (e.type) {
        case 'enqueue.generation': {
          const params = {
            durationSec: Number(row.durationSec),
            resolution: '720p' as const,
            aspectRatio: '9:16' as const,
            fps: 24,
          }

          /*
           * 预算闸门就在这里，而不是在三个 caller 各写一遍。
           *
           * `enqueue.generation` 是全系统唯一的花钱入口：单镜 API、批量生成、
           * 以及 fail() 里自动创建的下一次 attempt 全都经过它。此前闸门只挂在
           * 批量路由上，后两条完全裸奔——一个镜头失败重试 4 次不过任何闸门。
           */
          const estimate = deps.provider.estimateCost({
            requestId: '00000000-0000-4000-8000-000000000000',
            shotId: e.shotId,
            mode: 't2v',
            prompt: '',
            refImages: [],
            safetyProfile: row.safetyProfile,
            priority: 'normal',
            providerParams: {},
            ...params,
          })
          const policy = deps.budget ?? budgetFromEnv()
          const spent = await spentTodayForShot(tx, e.shotId)
          if (spent + estimate > policy.dailyLimitMicroUsd && policy.onExceed === 'block') {
            return {
              ok: false,
              code: 'BUDGET_EXCEEDED',
              from: row.status,
              reason: `预估 ${estimate} + 已花 ${spent} 超过日限 ${policy.dailyLimitMicroUsd}（微美元）`,
              budget: {
                dailyLimitMicroUsd: policy.dailyLimitMicroUsd,
                spentTodayMicroUsd: spent,
                wouldExceed: true,
                onExceed: policy.onExceed,
              },
            }
          }

          const jobId = await createGenerationJob(tx, {
            shotId: e.shotId,
            attempt: e.attempt,
            providerId: deps.provider.id,
            modelId: 'mock-v1',
            mode: 't2v',
            promptText: row.promptOverride ?? `${row.action}, ${row.shotType}`,
            params,
            /*
             * **在途预留**：建行的同时就把估算值记进成本。
             *
             * `spentTodayForShot` 求和的就是这一列，所以排队中的任务立刻开始
             * 占额度，不必新建表或计数器。任务落终态时真实计费会覆盖它
             * （成功走 handlePoll、失败走 fail()，两条都已经在写这一列）；
             * 能力校验不通过写 0，等于把预留退回去。
             *
             * 没有它，闸门只看得见「已结算」的钱：一次批量把 12 个镜头全排进去
             * 时账面仍是 0，闸门形同虚设。
             */
            costMicroUsd: estimate,
            costEstimated: true,
          })
          pending.push(() =>
            deps.queues.generate.add('generate', { generationJobId: jobId, shotId: e.shotId }),
          )
          await tx.update(s.shots).set({ attemptCount: e.attempt }).where(eq(s.shots.id, e.shotId))
          break
        }
        case 'set.selectedTake':
          await tx.update(s.takes).set({ status: 'selected' }).where(eq(s.takes.id, e.takeId))
          await tx.update(s.shots).set({ selectedTakeId: e.takeId }).where(eq(s.shots.id, e.shotId))
          break
        case 'clear.selectedTake':
          await tx.update(s.shots).set({ selectedTakeId: null }).where(eq(s.shots.id, e.shotId))
          break
        case 'archive.takes':
          // 归档而非删除：系统永不自动销毁已经花钱生成的东西（03 §7）
          await tx
            .update(s.takes)
            .set({ status: 'archived' })
            .where(and(eq(s.takes.shotId, e.shotId), eq(s.takes.status, 'candidate')))
          break
        case 'publish':
          pending.push(() => deps.queues.notify.add('notify', { projectId: '', payload: e.event }))
          break
      }
    }

    await tx.update(s.shots).set({ status: r.next, updatedAt: new Date() }).where(eq(s.shots.id, shotId))
    return { ok: true, next: r.next }
  })

  /*
   * 提交之后才入队。残留窗口是「提交成功但入队失败」——此时 job 行是 queued
   * 且 provider_job_ref 为空，reconcileOnBoot 的第一个分支正好负责把它捞回来
   * 重新入队。所以这里不需要 outbox 表：崩溃恢复那条路径已经在承担这个职责。
   */
  for (const run of pending) await run()

  return result
}
