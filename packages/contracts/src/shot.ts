import { z } from 'zod'
import { CameraMove, ShotType } from './enums.js'

/**
 * Shot Intent 是镜头的结构化意图，**不是 prompt**（00-overview.md §5 术语表）。
 * Intent 是叙事相关的，prompt 是 provider 相关的——分开之后，换 provider
 * 只需换 prompt-kit 的模板，剧本层一个字不用改。这是适配器层能成立的前提。
 *
 * S3 分镜阶段用它约束 LLM 的结构化输出（03-pipeline.md §S3）。
 */
export const ShotIntent = z.object({
  shotType: ShotType,
  cameraMove: CameraMove.optional(),
  /** 画面里发生什么 */
  action: z.string().min(4),
  emotion: z.string().optional(),
  /** 本镜台词，驱动 TTS */
  dialogue: z.string().optional(),
  /**
   * 硬包络 1–10 秒，与 13-character-assets.md §4.5 lint 的 2–8 秒是两层：
   * lint 是软告警，schema 是边界。完成判据允许 10 镜 × 90 秒 = 9 秒/镜，
   * 收窄到 8 会让合法分镜表无法表达。两者是否应该统一见 issue #5。
   */
  durationSec: z.number().min(1).max(10),
  characterNames: z.array(z.string()),
})
export type ShotIntent = z.infer<typeof ShotIntent>

/**
 * 画面可见状态，与 Story State（叙事真相）严格区分（03-pipeline.md §5）。
 * 混在一起会导致模型漂移反过来改写剧情设定。
 */
export const ContinuityState = z.object({
  characters: z.record(
    z.string(),
    z.object({
      outfit: z.string().optional(),
      hairstyle: z.string().optional(),
      holding: z.array(z.string()).optional(),
      injuries: z.array(z.string()).optional(),
    }),
  ),
  lighting: z.string().optional(),
  props: z.array(z.string()).optional(),
  /** 越轴检查 */
  cameraDirection: z.string().optional(),
})
export type ContinuityState = z.infer<typeof ContinuityState>

/** 角色参考资产三路分离（ADR-0008）——三类的构图要求、质量闸门、失败模式完全不同 */
export const FaceSet = z.object({
  /** 正面 · 中性表情 · 均匀光照 · 白底 */
  primary: z.string().uuid(),
  profileLeft: z.string().uuid().optional(),
  profileRight: z.string().uuid().optional(),
  threeQuarter: z.array(z.string().uuid()).default([]),
})
export type FaceSet = z.infer<typeof FaceSet>

export const BodyRef = z.object({
  /** 正面 + 背面全身 */
  fullBody: z.string().uuid(),
  /** 写实比例取 strip（默认），风格化比例取 keep */
  headPolicy: z.enum(['keep', 'strip']).default('strip'),
  /** strip + 风格化比例时必填，补几何信息 */
  poseMap: z.string().uuid().optional(),
})
export type BodyRef = z.infer<typeof BodyRef>

export const Outfit = z.object({
  id: z.string(),
  name: z.string(),
  /** 推荐：穿着态 + parsing mask 抠到服装区域 */
  wornMasked: z.string().uuid(),
  /** 备选：平铺 */
  flatLay: z.string().uuid().optional(),
})
export type Outfit = z.infer<typeof Outfit>

/** 各平台 role routing 能力与数量上限差异巨大（13-character-assets.md §1.2） */
export const PlatformBindings = z.object({
  vidu: z.object({ subjectName: z.string(), assetIds: z.array(z.string().uuid()).max(3) }).optional(),
  kling: z.object({ elementId: z.string(), assetIds: z.array(z.string().uuid()).min(2).max(4) }).optional(),
  gemini: z.object({ characterSlot: z.number().int().min(1).max(5) }).optional(),
  /** 无 role routing，须在 prompt 显式声明同一身份 */
  seedance: z.object({ assetIds: z.array(z.string().uuid()) }).optional(),
})
export type PlatformBindings = z.infer<typeof PlatformBindings>

/** IP 授权链，本阶段预留不实现（02-data-model.md §10） */
export const RightsRef = z.object({
  sourceId: z.string(),
  licenseScope: z.string(),
  territory: z.array(z.string()),
  expiresAt: z.string().datetime().optional(),
})
export type RightsRef = z.infer<typeof RightsRef>
