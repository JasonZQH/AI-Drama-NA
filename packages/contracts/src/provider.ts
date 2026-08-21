import { z } from 'zod'
import { FailureCode, GenMode, SafetyProfile } from './enums.js'

/**
 * 生成后端的统一契约（04-provider-adapter.md，对应 ADR-0002）。
 * 所有字段都是 provider 中立的——业务代码永远只认识这一层，不认识任何厂商。
 */

/** 参考图用语义化 role 而非数组下标：不同 provider 对参考图的语义完全不同 */
export const RefImageRole = z.enum(['character', 'location', 'style', 'first_frame', 'last_frame'])
export type RefImageRole = z.infer<typeof RefImageRole>

export const RefImage = z.object({
  role: RefImageRole,
  /** 预签名 URL，provider 可直接拉取 */
  url: z.string().url(),
  weight: z.number().min(0).max(1).optional(),
})
export type RefImage = z.infer<typeof RefImage>

export const GenerationRequest = z.object({
  /** = generation_jobs.id，用于幂等重放 */
  requestId: z.string().uuid(),
  shotId: z.string().uuid(),

  mode: GenMode,
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  refImages: z.array(RefImage).default([]),

  durationSec: z.number().min(1).max(15),
  resolution: z.enum(['480p', '720p', '1080p']),
  aspectRatio: z.enum(['9:16', '16:9', '1:1']),
  fps: z.number().int().default(24),
  seed: z.number().int().optional(),

  safetyProfile: SafetyProfile.default('standard'),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  /**
   * provider 私有参数逃生舱。规矩：只有该 provider 的适配器可以读它，
   * 业务逻辑永远不构造它（由 UI 的高级设置面板直接写入）。
   */
  providerParams: z.record(z.string(), z.unknown()).default({}),
})
export type GenerationRequest = z.infer<typeof GenerationRequest>

export const GenerationResult = z.object({
  status: z.literal('succeeded'),
  /** provider 侧可下载 URL；自部署 worker 直写存储时给 storageKey */
  outputUrl: z.string(),
  storageKey: z.string().optional(),
  durationSec: z.number(),
  widthPx: z.number().int(),
  heightPx: z.number().int(),
  fps: z.number(),
  seedUsed: z.number().int().optional(),
  /**
   * provider 不回报时由适配器按价目表估算，并标 providerMeta.costEstimated。
   * 宁可要估算值也不要 null——null 会让整张成本报表失真。
   */
  costMicroUsd: z.number().int().nonnegative(),
  providerMeta: z.record(z.string(), z.unknown()).default({}),
})
export type GenerationResult = z.infer<typeof GenerationResult>

export const ProviderFailure = z.object({
  status: z.literal('failed'),
  code: FailureCode,
  message: z.string(),
  retryable: z.boolean(),
  /** 限流时 provider 给的建议，由队列层做退避——适配器内不 sleep */
  retryAfterMs: z.number().int().nonnegative().optional(),
  /**
   * 这次**失败**的计费。可选，但缺省不等于免费。
   *
   * 真 provider 对失败、超时、取消的生成照样计费——算力已经消耗掉了。
   * 适配器知道就填；不知道就留空，由编排层按价目表估算并标 costEstimated。
   * 唯一该留空**且**确实为零的，是从未真正发出请求的那种失败（能力校验不通过）。
   *
   * 缺了这个字段，预算闸门读到的是一串 0：一个镜头重试到 maxAttempts 可以
   * 产生四笔真实扣费而账面全空，日限额永远不会触发。
   */
  costMicroUsd: z.number().int().nonnegative().optional(),
})
export type ProviderFailure = z.infer<typeof ProviderFailure>

/**
 * 生成阶段。对应 Worker Contract 的 `JobState.stage`（09 §2.3）。
 *
 * **有它才能解释「0% 停很久」。** ComfyUI 首次加载 14B 模型要 60–90 秒，
 * 这期间 progressPct 一直是 0——只画进度条的话用户读到的是「挂了」，
 * 于是去点重试，而重试会把模型再加载一遍。云 provider 给不出阶段就留空。
 */
export const GenStage = z.enum(['queued', 'loading_model', 'denoising', 'decoding', 'uploading'])
export type GenStage = z.infer<typeof GenStage>

export const ProviderProgress = z.object({
  status: z.enum(['submitted', 'running']),
  progressPct: z.number().min(0).max(100).optional(),
  etaMs: z.number().int().nonnegative().optional(),
  stage: GenStage.optional(),
})
export type ProviderProgress = z.infer<typeof ProviderProgress>

export const ProviderHandle = z.object({
  providerId: z.string(),
  externalId: z.string(),
  submittedAt: z.number().int(),
})
export type ProviderHandle = z.infer<typeof ProviderHandle>

export const CostModel = z.object({
  unit: z.enum(['per_second', 'per_clip', 'per_token']),
  microUsdPerUnit: z.number().nonnegative(),
})
export type CostModel = z.infer<typeof CostModel>

export const ProviderCapabilities = z.object({
  modes: z.array(GenMode),
  maxDurationSec: z.number(),
  resolutions: z.array(z.enum(['480p', '720p', '1080p'])),
  aspectRatios: z.array(z.enum(['9:16', '16:9', '1:1'])),
  maxRefImages: z.number().int().nonnegative(),
  supportsSeed: z.boolean(),
  supportsNegative: z.boolean(),
  supportsFirstLastFrame: z.boolean(),
  /** 原生音画同步。口型同步是 R 级硬指标，路由需按它筛选（见 issue #15） */
  supportsAudio: z.boolean(),
  /** 服务端是否有内容过滤——决定 mature 内容能否路由到它（04 §5 规则 2） */
  serverSideContentFilter: z.boolean(),
  maxConcurrent: z.number().int().positive(),
  costModel: CostModel,
})
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>

export const ValidationResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])
export type ValidationResult = z.infer<typeof ValidationResult>

export const ProviderHealth = z.object({
  ok: z.boolean(),
  queueDepth: z.number().int().nonnegative().optional(),
  detail: z.string().optional(),
})
export type ProviderHealth = z.infer<typeof ProviderHealth>

export type PollOutcome = ProviderProgress | GenerationResult | ProviderFailure

/**
 * 每个新 provider 必须通过同一套契约测试（04-provider-adapter.md §7）。
 * 第一条就是幂等——崩溃恢复（05 §8）整个建立在它上面。
 */
export interface VideoProvider {
  readonly id: string

  /**
   * 落进 `generation_jobs.model_id` 的值，用于成本归因。
   *
   * 为什么是 provider 的属性而不是每次调用传：池的单位是 **(provider, model)**
   * 而不是 provider。OpenRouter 一家之下 Veo 3.1 有音频、Wan 没有，时长与分辨率
   * 上限也各不相同——capabilities 是 per-model 的，所以一个 model 就是池里一个条目
   * （`id = 'openrouter:google/veo-3.1'`）。这样路由器的能力过滤才有真实对象。
   *
   * 此前这个值在 `applyTransition` 里硬编码成 `'mock-v1'`，于是 ledger 里每一笔
   * 真实花费的模型名都会是 mock 的，`gj_analytics_idx` 那个 (provider_id, model_id)
   * 索引直接失效——而 M1 验收要的正是「成本可归因」。
   */
  readonly modelId: string

  readonly capabilities: ProviderCapabilities

  /** 提交前检查：能力不匹配时快速失败，不浪费一次调用，且不得发起网络请求 */
  validate(req: GenerationRequest): ValidationResult

  /** 事前成本估算，用于路由决策与预算闸门。单位 micro USD */
  estimateCost(req: GenerationRequest): number

  /** 必须幂等：同 requestId 重复提交返回同一 handle，只计一次费 */
  submit(req: GenerationRequest): Promise<ProviderHandle>

  /** 适配器内部负责把各家状态码映射到统一枚举 */
  poll(handle: ProviderHandle): Promise<PollOutcome>

  cancel(handle: ProviderHandle): Promise<void>

  /** 供路由器摘除故障 provider */
  health(): Promise<ProviderHealth>

  /**
   * 取产物时要带的额外请求头。
   *
   * **存在的理由是一次真钱事故。** OpenRouter 的产物字段叫 `unsigned_urls`
   * ——名字暗示不需要鉴权，而适配器的注释里早就写着「若它确实需要鉴权，
   * `queue/ingest.ts` 的裸 fetch 会 401」。第一次真实生成验证了后者：
   * **$0.3667 花掉了，视频拿不回来**（`下载失败 HTTP 401`）。
   *
   * 为什么是「给头」而不是「你去下载」：`ingest.ts` 那套停滞闸、总时长闸、
   * 流中途体积上限是所有 provider 共用的，让每家自己下载等于每家重写一遍。
   * 密钥仍然只留在适配器里——不进 job 数据、不进数据库。
   */
  artifactHeaders?(url: string): Record<string, string>
}
