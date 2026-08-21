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

/**
 * 一套服装。角色可以有多套（睡衣版 / 工作版 / 休闲版），由
 * `scenes.state_in.characters[name].outfit` 按场选。
 *
 * ## `description` 是新增的，而且是目前唯一真正生效的字段
 *
 * 「这一场 Lena 穿睡衣」进 prompt **不需要任何图片**——需要的是一段文字
 * （`grey flannel pajamas`）。图那一半的用途是喂给视频模型当参考图，而「要不要
 * 喂、喂几张、会不会被首帧图吃掉」还没有答案（P6 的 U1–U3）。文字这一半现在
 * 就能生效，所以先做它。
 *
 * ## `wornMasked` 从必填改成可选
 *
 * 先例是 `characters.face_set` 的可空，schema 里的原话是「**角色卡先于参考图
 * 存在**（生产顺序是抽角色卡 → 出图 → 精修 → 入库 → 锁定）」。服装完全同理：
 * 先有「一套灰色法兰绒睡衣」这个概念，后有它的参考图。
 *
 * 改类型不需要迁移：`characters.wardrobe` 此前零写入方，库里没有旧数据。
 */
export const Outfit = z.object({
  id: z.string(),
  name: z.string(),
  /** 进 prompt 的那段文字。不给图也能生效的那一半 */
  description: z.string().default(''),
  /** 推荐：穿着态 + parsing mask 抠到服装区域。P6 之前没有产出它的链路 */
  wornMasked: z.string().uuid().optional(),
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
