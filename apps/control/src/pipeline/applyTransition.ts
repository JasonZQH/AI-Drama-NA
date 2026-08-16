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

export interface TransitionDeps {
  readonly db: Db
  readonly queues: Queues
  readonly providerId: string
  readonly maxAttempts: number
}

export type ApplyResult =
  | { readonly ok: true; readonly next: string }
  | { readonly ok: false; readonly reason: string; readonly from: string }

export async function applyShotTransition(
  deps: TransitionDeps,
  shotId: string,
  event: ShotEvent,
): Promise<ApplyResult | null> {
  const [row] = await deps.db.select().from(s.shots).where(eq(s.shots.id, shotId))
  if (!row) return null

  const r = transition(
    { id: row.id, status: row.status, attemptCount: row.attemptCount, selectedTakeId: row.selectedTakeId },
    event,
    { maxAttempts: deps.maxAttempts },
  )
  if (!r.ok) return { ok: false, reason: r.reason, from: row.status }

  for (const e of r.effects) {
    switch (e.type) {
      case 'enqueue.generation': {
        const jobId = await createGenerationJob(deps.db, {
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
  return { ok: true, next: r.next }
}
