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
])
export type FailureCode = z.infer<typeof FailureCode>

/**
 * 不可重试的失败码（05-job-orchestration.md §5.3）。
 * content_filtered：同 prompt 必然再被拒，重试纯烧配额。
 * quota_exceeded：重试加剧问题，应暂停该 provider 并告警。
 * invalid_output：适配器 bug 或能力不匹配，重试无用，需修代码。
 */
export const NON_RETRYABLE: readonly FailureCode[] = [
  'content_filtered',
  'quota_exceeded',
  'invalid_output',
] as const

export function isRetryable(code: FailureCode): boolean {
  return !NON_RETRYABLE.includes(code)
}
