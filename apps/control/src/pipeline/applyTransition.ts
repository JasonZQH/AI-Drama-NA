import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { createGenerationJob } from '../queue/ingest.js'
import type { Queues } from '../queue/queues.js'
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
  readonly providerId: string
  readonly maxAttempts: number
}

export type ApplyResult =
  | { readonly ok: true; readonly next: string }
  | { readonly ok: false; readonly reason: string; readonly from: string }

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
    if (!r.ok) return { ok: false, reason: r.reason, from: row.status }

    for (const e of r.effects) {
      switch (e.type) {
        case 'enqueue.generation': {
          const jobId = await createGenerationJob(tx, {
            shotId: e.shotId,
            attempt: e.attempt,
            providerId: deps.providerId,
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
