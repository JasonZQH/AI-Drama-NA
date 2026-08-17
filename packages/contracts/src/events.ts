import { z } from 'zod'
import { FailureCode, ShotStatus } from './enums.js'
import { GenStage } from './provider.js'

/**
 * SSE 事件负载（05-job-orchestration.md §7、06-api-spec.md §7）。
 *
 * 选 SSE 不选 WebSocket：进度是单向广播，SSE 天然支持断线重连与
 * HTTP/2 多路复用，不需要维护双向连接的状态机。
 *
 * **这里只列真的有生产者的事件。** 曾经还有 `take.created`、`batch.progress`、
 * `cost.updated` 三种：契约里声明了、前端订阅了、`EpisodeView` 还为其中两种写好
 * 了分支，但全仓零处发送。声明了却没人发的事件比没有更糟——读代码的人会以为
 * 那条路已经通了，然后花一下午找「为什么没收到」。
 *
 * 它们也确实多余：面板是「收到任何事件就防抖重拉」的设计，`shot.status` 一发，
 * 该刷新的都刷新了。要加回来，先有生产者。
 */
export const StudioEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shot.status'), shotId: z.string().uuid(), status: ShotStatus }),
  z.object({
    type: z.literal('job.progress'),
    jobId: z.string().uuid(),
    shotId: z.string().uuid(),
    pct: z.number().min(0).max(100),
    etaMs: z.number().int().nonnegative().optional(),
    /** 阶段比百分比更能解释「为什么现在不动」，尤其是模型加载那 60–90 秒 */
    stage: GenStage.optional(),
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
