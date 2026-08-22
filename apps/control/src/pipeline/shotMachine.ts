import type { FailureCode, ShotStatus, StudioEvent } from '@ai-drama/contracts'
import { isRetryable } from '@ai-drama/contracts'

/**
 * 镜头状态机（03-pipeline.md §3）。
 *
 * **纯函数，零 IO。** 所有副作用以 Effect[] 返回给调用方执行——这样它可以被
 * 穷举测试而不需要起数据库。这条由 eslint 强制（eslint.config.js 把本文件
 * 纳入 domain 的零 IO 作用域），不靠自觉。
 *
 * 与文档状态图的一处偏离：图里画了 `evaluating` 节点，但 `ShotStatus` 枚举
 * （contracts 是真相源）没有它——有的是图上没画边的 `skipped`。`evaluating`
 * 实际属于 `JobStatus`。这里按枚举实现：镜头在 job 评测期间保持 generating，
 * 有 take 过闸才进 review。见 issue #30。
 */

/** 状态机需要的最小输入。刻意不收整行 Shot——它不该知道 prompt 或参考图 */
export interface ShotState {
  readonly id: string
  readonly status: ShotStatus
  readonly attemptCount: number
  readonly selectedTakeId: string | null
}

export type ShotEvent =
  /** intent 校验通过 */
  | { readonly type: 'intent.completed' }
  /** 人工改了 intent。历史 takes 保留为 archived，绝不删（§7：永不自动销毁花过钱的东西） */
  | { readonly type: 'intent.edited' }
  /** 用户点生成 / 批量入队 */
  | { readonly type: 'generate.requested' }
  /** 有 take 过了 eval 闸，进候选池 */
  | { readonly type: 'take.accepted'; readonly takeId: string }
  /** 一次生成尝试失败（provider 报错或 eval 拒绝） */
  | { readonly type: 'attempt.failed'; readonly code: FailureCode }
  /** 人工选片 */
  | { readonly type: 'take.selected'; readonly takeId: string }
  /** 人工「全部拒绝」，等价于一次质量重试 */
  | { readonly type: 'takes.allRejected' }
  /** 已锁定的镜头人工点「重做」 */
  | { readonly type: 'redo.requested' }
  /** 重试耗尽后人工介入 */
  | { readonly type: 'manual.reset' }
  /** 人工跳过 */
  | { readonly type: 'skip.requested' }

export type Effect =
  | { readonly type: 'enqueue.generation'; readonly shotId: string; readonly attempt: number }
  | { readonly type: 'archive.takes'; readonly shotId: string }
  | { readonly type: 'set.selectedTake'; readonly shotId: string; readonly takeId: string }
  | { readonly type: 'clear.selectedTake'; readonly shotId: string }
  | { readonly type: 'publish'; readonly event: StudioEvent }

export type TransitionResult =
  | { readonly ok: true; readonly next: ShotStatus; readonly effects: readonly Effect[] }
  | { readonly ok: false; readonly reason: string }

export interface TransitionContext {
  readonly maxAttempts: number
}

function statusEvent(shotId: string, status: ShotStatus): Effect {
  return { type: 'publish', event: { type: 'shot.status', shotId, status } }
}

function to(shotId: string, next: ShotStatus, ...extra: Effect[]): TransitionResult {
  return { ok: true, next, effects: [...extra, statusEvent(shotId, next)] }
}

function reject(from: ShotStatus, event: ShotEvent['type']): TransitionResult {
  return { ok: false, reason: `状态 ${from} 不接受事件 ${event}` }
}

/**
 * 失败后往哪走。两条独立的理由都会直接判死，不进重试循环：
 *
 * 1. 不可重试的失败码（05-job-orchestration.md §5.3）——content_filtered
 *    同 prompt 必然再被拒，重试纯烧配额；quota_exceeded 重试加剧问题；
 *    invalid_output 是适配器 bug，重试无用。
 * 2. 重试次数耗尽。
 */
function afterFailure(shot: ShotState, code: FailureCode, ctx: TransitionContext): TransitionResult {
  if (!isRetryable(code)) {
    return to(shot.id, 'failed', {
      type: 'publish',
      event: { type: 'error', shotId: shot.id, code, message: `${code} 不可重试，需人工处理` },
    })
  }
  if (shot.attemptCount >= ctx.maxAttempts) {
    return to(shot.id, 'failed', {
      type: 'publish',
      event: { type: 'error', shotId: shot.id, code, message: `重试耗尽（${ctx.maxAttempts} 次）` },
    })
  }
  // 回 ready 而不是直接 generating：下一次尝试要由编排层换 seed/参数/provider
  // 后重新入队，状态机不决定换什么（05-job-orchestration.md §5.2）
  return to(shot.id, 'ready')
}

/**
 * 唯一的迁移入口。非法迁移返回 ok:false 而不是抛异常——调用方据此回
 * 400 INVALID_STATE_TRANSITION（06-api-spec.md §8），且穷举测试更好写。
 */
export function transition(shot: ShotState, event: ShotEvent, ctx: TransitionContext): TransitionResult {
  // 跳过是人工决定，从任何非终态都能到达
  if (event.type === 'skip.requested') {
    return shot.status === 'skipped' ? reject(shot.status, event.type) : to(shot.id, 'skipped')
  }

  switch (shot.status) {
    case 'draft':
      return event.type === 'intent.completed' ? to(shot.id, 'ready') : reject(shot.status, event.type)

    case 'ready':
      switch (event.type) {
        case 'generate.requested':
          return to(shot.id, 'generating', {
            type: 'enqueue.generation',
            shotId: shot.id,
            attempt: shot.attemptCount + 1,
          })
        case 'intent.edited':
          return to(shot.id, 'ready', { type: 'archive.takes', shotId: shot.id })
        default:
          return reject(shot.status, event.type)
      }

    case 'generating':
      switch (event.type) {
        case 'take.accepted':
          return to(shot.id, 'review')
        case 'attempt.failed':
          return afterFailure(shot, event.code, ctx)
        default:
          return reject(shot.status, event.type)
      }

    case 'review':
      switch (event.type) {
        case 'take.selected':
          return to(shot.id, 'locked', {
            type: 'set.selectedTake',
            shotId: shot.id,
            takeId: event.takeId,
          })
        case 'takes.allRejected':
          // 人工全否等价于一次质量重试；用 eval_rejected 走同一条降级路径
          return afterFailure(shot, 'eval_rejected', ctx)
        case 'take.accepted':
          // 同一镜头的另一个 job 也过闸了——仍在 review，候选池变大而已
          return { ok: true, next: 'review', effects: [] }
        case 'intent.edited':
          return to(shot.id, 'ready', { type: 'archive.takes', shotId: shot.id })
        default:
          return reject(shot.status, event.type)
      }

    case 'locked':
      switch (event.type) {
        /*
         * **锁定之后仍然可以换片。** 在几条已经付过钱的 take 之间改主意不销毁
         * 任何东西，也不该先把当前这条归档——那是「重做」干的事。
         *
         * 停在 `locked`：换的是哪一条进成片，不是这一镜做完没有。
         * `set.selectedTake` 顺带把 `generation_jobs.accepted` 挪过去，
         * 「每可用镜头成本」的分母才不会因为改主意而虚高。
         */
        case 'take.selected':
          return to(shot.id, 'locked', {
            type: 'set.selectedTake',
            shotId: shot.id,
            takeId: event.takeId,
          })
        /*
         * **锁定之后仍然可以再生成一条。** 「这条能用，但我想再试一个」是常规
         * 需求，而原来只有「重做」一条路——它先把现有成片归档，等于逼人拿一条
         * 已经花过钱的片子去赌下一条。
         *
         * 回到 `generating`，`selectedTakeId` 原样留着：新片子回来时走
         * `take.accepted` 进 `review`，那时人手上有新旧两条可挑。挑不中新的就
         * 把旧的重新选回来（上面那条）——两条都在，谁都没被销毁。
         */
        case 'generate.requested':
          return to(shot.id, 'generating', {
            type: 'enqueue.generation',
            shotId: shot.id,
            attempt: shot.attemptCount + 1,
          })
        case 'redo.requested':
        case 'intent.edited':
          // 已选定的 take 归档而非删除，selectedTakeId 清空
          return to(
            shot.id,
            'ready',
            { type: 'clear.selectedTake', shotId: shot.id },
            { type: 'archive.takes', shotId: shot.id },
          )
        default:
          return reject(shot.status, event.type)
      }

    case 'failed':
      switch (event.type) {
        case 'manual.reset':
        case 'intent.edited':
          return to(shot.id, 'ready')
        default:
          return reject(shot.status, event.type)
      }

    case 'skipped':
      // 取消跳过 = 重新纳入生产
      return event.type === 'manual.reset' ? to(shot.id, 'ready') : reject(shot.status, event.type)
  }
}

/** 终态：不会再自行迁移，只能由人工事件唤醒 */
export const TERMINAL_STATUSES: readonly ShotStatus[] = ['locked', 'failed', 'skipped'] as const

/** 可入队生成的状态。批量入队前的依赖解析用它（03-pipeline.md §6） */
export function isEnqueueable(status: ShotStatus): boolean {
  return status === 'ready'
}
