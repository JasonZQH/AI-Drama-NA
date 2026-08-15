import { z } from 'zod'
import { FailureCode, ShotStatus } from './enums.js'

/**
 * SSE 事件负载（05-job-orchestration.md §7、06-api-spec.md §7）。
 *
 * 选 SSE 不选 WebSocket：进度是单向广播，SSE 天然支持断线重连与
 * HTTP/2 多路复用，不需要维护双向连接的状态机。
 */
export const StudioEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shot.status'), shotId: z.string().uuid(), status: ShotStatus }),
  z.object({
    type: z.literal('job.progress'),
    jobId: z.string().uuid(),
    shotId: z.string().uuid(),
    pct: z.number().min(0).max(100),
    etaMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('take.created'),
    shotId: z.string().uuid(),
    takeId: z.string().uuid(),
    thumbUrl: z.string(),
  }),
  z.object({
    type: z.literal('batch.progress'),
    episodeId: z.string().uuid(),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('cost.updated'),
    projectId: z.string().uuid(),
    spentMicroUsd: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('error'),
    shotId: z.string().uuid().optional(),
    code: FailureCode,
    message: z.string(),
  }),
])
export type StudioEvent = z.infer<typeof StudioEvent>

export type StudioEventType = StudioEvent['type']
