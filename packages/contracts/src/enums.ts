import { z } from 'zod'

/**
 * 全项目状态枚举的唯一真相源（02-data-model.md §8）。
 * TS 类型、运行时校验、给 Python 的 JSON Schema 都由这里派生。
 *
 * 一切进度用 status 枚举 + 时间戳，禁止 is_done 这类布尔字段。
 */

export const ShotStatus = z.enum([
  'draft', // intent 未完成
  'ready', // intent 完整，可生成
  'generating', // 至少一个 job 在跑
  'review', // 有 candidate take 待选
  'locked', // 已选定 selectedTakeId
  'failed', // 重试耗尽
  'skipped', // 人工跳过
])
export type ShotStatus = z.infer<typeof ShotStatus>

export const JobStatus = z.enum([
  'queued',
  'submitted',
  'running',
  'downloading',
  'evaluating',
  'succeeded',
  'failed',
  'cancelled',
])
export type JobStatus = z.infer<typeof JobStatus>

/**
 * 已结算的任务状态：到这里就不该再被任何迟到的队列条目改写。
 *
 * 同一个 job 可以有不止一条轮询链（reconcileOnBoot 会为非终态行再加一条，
 * 而旧链是自重排的、不会自己消失）。没有这道守卫，后到的那条会把已经判
 * failed 的行改回 running 再写成 succeeded，留下一行「既成功又带失败码」的
 * 记录——而 Ledger 的全部价值就在于它不说谎（约束 C4）。
 */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'] as const

export function isTerminalJobStatus(status: string): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status)
}

/**
 * 取值在文档中从未出现过，此处为最小可用定义。见 issue #4。
 * 若与实际发行流程不符，改这里即可——它还没有被任何业务逻辑依赖。
 */
export const ProjectStatus = z.enum(['draft', 'producing', 'completed', 'archived'])
export type ProjectStatus = z.infer<typeof ProjectStatus>

export const EpisodeStatus = z.enum([
  'outline',
  'scripted',
  'shotlisted',
  'producing',
  'assembled',
  'published',
])
export type EpisodeStatus = z.infer<typeof EpisodeStatus>

export const ShotType = z.enum(['ecu', 'cu', 'ms', 'ws', 'establishing', 'ots', 'pov'])
export type ShotType = z.infer<typeof ShotType>

export const CameraMove = z.enum(['static', 'pan', 'tilt', 'dolly', 'orbit', 'handheld'])
export type CameraMove = z.infer<typeof CameraMove>

export const TimeOfDay = z.enum(['day', 'night', 'dawn', 'dusk'])
export type TimeOfDay = z.infer<typeof TimeOfDay>

export const TakeStatus = z.enum(['candidate', 'selected', 'rejected', 'archived'])
export type TakeStatus = z.infer<typeof TakeStatus>

export const AssetKind = z.enum(['image', 'video', 'audio', 'subtitle', 'lora', 'master'])
export type AssetKind = z.infer<typeof AssetKind>

export const ProducedBy = z.enum(['generation', 'render', 'upload', 'transcode'])
export type ProducedBy = z.infer<typeof ProducedBy>

export const GenMode = z.enum(['t2v', 'i2v', 'ref2v', 'extend'])
export type GenMode = z.infer<typeof GenMode>

export const SafetyProfile = z.enum(['standard', 'mature'])
export type SafetyProfile = z.infer<typeof SafetyProfile>

/** 投放安全 / 商店安全 / 完整 TV-MA（约束 C7，镜头级分离） */
export const ContentTier = z.enum(['L0', 'L1', 'L2'])
export type ContentTier = z.infer<typeof ContentTier>

export const HookType = z.enum(['betrayal', 'reveal', 'conflict', 'cliffhanger', 'reversal', 'emotional'])
export type HookType = z.infer<typeof HookType>

export const AdPlatform = z.enum(['tiktok', 'meta_fb', 'meta_ig', 'snapchat', 'yt_shorts', 'unity'])
export type AdPlatform = z.infer<typeof AdPlatform>

export const TimelineStatus = z.enum(['draft', 'locked', 'rendering', 'rendered'])
export type TimelineStatus = z.infer<typeof TimelineStatus>

export const Transition = z.enum(['cut', 'dissolve', 'fade_black', 'whip'])
export type Transition = z.infer<typeof Transition>

export const FailureCode = z.enum([
  'provider_error',
  'timeout',
  'content_filtered',
  'quota_exceeded',
  'download_failed',
  'eval_rejected',
  'invalid_output',
  'cancelled',
  /**
   * 提交请求已发出，但结果未知——连接在响应途中断掉、或进程死在 submit 与记账之间。
   *
   * 与其他所有码的区别：**我们不知道钱花没花**。OpenRouter 的 POST /api/v1/videos
   * 没有幂等键（04-provider-adapter.md §5），所以既问不出来也不能安全重放。
   * 唯一正确的动作是停下来交给人，故它必须留在 RETRYABLE 之外。
   */
  'submit_unknown',
])
export type FailureCode = z.infer<typeof FailureCode>

/**
 * **可重试**的失败码（05-job-orchestration.md §5.3）。
 *
 * 这里是白名单而不是黑名单，方向是刻意的：`isRetryable` 的返回值直接决定
 * `afterFailure` 会不会自动开下一次 attempt，而下一次 attempt 就是下一笔钱。
 * 黑名单的默认值是「花钱」——将来任何人加一个新失败码而忘了同步名单，
 * 系统就会替他自动重投。白名单的默认值是「停下来等人」，错的方向便宜得多。
 *
 * 名单本身与改成白名单之前完全一致，这次没有改变任何现有码的行为。
 */
export const RETRYABLE: readonly FailureCode[] = [
  'provider_error', // 多为临时故障
  'timeout', // provider 未按时返回
  'download_failed', // 产物已生成，只是没搬回来
  'eval_rejected', // 换 seed 或参数有机会过
  'cancelled', // 人工取消后可再次发起
] as const

export function isRetryable(code: FailureCode): boolean {
  return RETRYABLE.includes(code)
}
