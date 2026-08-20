import type { GenerationRequest } from '@ai-drama/contracts'

/**
 * OpenRouter 视频模型能力与计价快照。
 *
 * ## 为什么是快照而不是启动时拉
 *
 * `validate` 与 `estimateCost` 在契约里都是**同步且零 IO** 的（04 §7）——它们跑在
 * 路由与预算闸门的热路径上，一次网络往返会把「花钱之前的廉价守卫」变成延迟税。
 * 而 `buildProviderPool` 本身也是同步的。所以能力必须在构造之前就已知。
 *
 * ## 那它怎么保证不漂
 *
 * `GET /api/v1/videos/models` 是**公开端点**（无需 key，实测 200），所以
 * `openrouter.live.test.ts` 在 `RECORD=1` 下重新拉一次并逐字段对比。平时的
 * test 车道有出网拦截，那条自动跳过——不会在 CI 里悄悄发请求。
 *
 * 字段与取值均取自 2026-08-17 的实际响应，未做任何加工。
 */

export interface OpenRouterModel {
  readonly id: string
  readonly supportedResolutions: readonly string[]
  readonly supportedAspectRatios: readonly string[]
  /** **离散整数列表**，不是区间。2.5 秒的镜头必须向上取到这里面的值 */
  readonly supportedDurations: readonly number[]
  /** `WIDTHxHEIGHT`。按 token 计价的模型要用它算像素数，不能靠猜 */
  readonly supportedSizes: readonly string[]
  readonly supportedFrameImages: readonly string[]
  readonly generateAudio: boolean
  readonly seed: boolean
  /**
   * 原样抄自线上。**两套完全不同的计价族**，键名前缀就是判据：
   *
   * - `duration_seconds*` —— 按秒（veo、kling、wan）
   * - `video_tokens*` —— 按 token（seedance 全系）
   *
   * 后缀编码 `(模式, 分辨率, 有无音轨)`，越具体的键优先。单位是美元的字符串，
   * 不要提前转 number——转换只在算钱那一刻做。
   */
  readonly pricingSkus: Readonly<Record<string, string>>
  /**
   * 负向词在**统一请求体里没有字段**——只能走 passthrough，而 passthrough 的
   * 参数名各家不同：veo 是驼峰 `negativePrompt`，wan/kling 是下划线
   * `negative_prompt`，seedance 全系压根没有（只允许 `watermark, req_key`）。
   *
   * `undefined` = 这个模型不支持，`capabilities.supportsNegative` 直接读它。
   *
   * 值抄自 `GET /videos/models` 的 `allowed_passthrough_parameters`（公开端点，
   * 不需要 key、不花钱）。RECORD=1 的漂移检查会核。
   */
  readonly negativeParam?: string
  /**
   * 上游 provider 的 slug。**passthrough 是按它路由的**——官方原文：「Options
   * are keyed by provider slug, and **only the options for the matched
   * provider are forwarded**」。写错不报错，参数被静默丢弃。
   *
   * 取自 `GET /models/:id/endpoints` 里每个端点的 `tag`。池里这 6 个模型当前
   * 都是**单端点**，所以 slug 唯一确定；哪天某个模型多了第二家，这里就得跟着
   * 变成「按实际路由到的端点选」——漂移检查会先撞上。
   */
  readonly providerSlug?: string
}

export const OPENROUTER_MODELS: readonly OpenRouterModel[] = [
  {
    id: 'google/veo-3.1-lite',
    negativeParam: 'negativePrompt', // 驼峰，实测自 allowed_passthrough_parameters
    providerSlug: 'google-vertex',
    supportedResolutions: ['720p', '1080p'],
    supportedAspectRatios: ['16:9', '9:16'],
    supportedDurations: [8, 4, 6],
    supportedSizes: ['1280x720', '720x1280', '1920x1080', '1080x1920'],
    supportedFrameImages: ['first_frame', 'last_frame'],
    generateAudio: true,
    seed: true,
    pricingSkus: {
      duration_seconds_with_audio: '0.08',
      duration_seconds_without_audio: '0.05',
      duration_seconds_with_audio_720p: '0.05',
      duration_seconds_without_audio_720p: '0.03',
    },
  },
  {
    id: 'google/veo-3.1',
    negativeParam: 'negativePrompt', // 驼峰，实测自 allowed_passthrough_parameters
    providerSlug: 'google-vertex',
    supportedResolutions: ['720p', '1080p', '4K'],
    supportedAspectRatios: ['16:9', '9:16'],
    supportedDurations: [4, 6, 8],
    supportedSizes: ['1280x720', '1080x1920', '1920x1080', '720x1280', '3840x2160', '2160x3840'],
    supportedFrameImages: ['first_frame', 'last_frame'],
    generateAudio: true,
    seed: true,
    pricingSkus: {
      duration_seconds_with_audio: '0.40',
      duration_seconds_with_audio_4k: '0.60',
      duration_seconds_without_audio: '0.20',
      duration_seconds_without_audio_4k: '0.40',
    },
  },
  {
    id: 'alibaba/wan-2.7',
    negativeParam: 'negative_prompt', // 下划线，与 veo 不同
    providerSlug: 'atlas-cloud',
    supportedResolutions: ['720p', '1080p'],
    supportedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    supportedDurations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    supportedSizes: [
      '1280x720',
      '720x1280',
      '1920x1080',
      '1080x1920',
      '720x720',
      '1080x1080',
      '960x720',
      '720x960',
      '1440x1080',
      '1080x1440',
    ],
    supportedFrameImages: ['first_frame', 'last_frame'],
    generateAudio: true,
    seed: true,
    pricingSkus: { duration_seconds: '0.1' },
  },
  {
    id: 'bytedance/seedance-2.0',
    // 无 negativeParam：seedance 全系的 passthrough 只有 watermark, req_key
    providerSlug: 'seed',
    supportedResolutions: ['480p', '720p', '1080p', '4K'],
    supportedAspectRatios: ['1:1', '3:4', '9:16', '4:3', '16:9', '21:9', '9:21'],
    supportedDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportedSizes: [
      '480x480',
      '480x640',
      '480x854',
      '640x480',
      '854x480',
      '1120x480',
      '720x720',
      '720x960',
      '720x1280',
      '720x1680',
      '960x720',
      '1280x720',
      '1680x720',
      '1080x1080',
      '1080x1440',
      '1080x1920',
      '1440x1080',
      '1920x1080',
      '2520x1080',
      '3840x2160',
      '2160x3840',
      '2160x2160',
      '2880x2160',
      '2160x2880',
      '5040x2160',
    ],
    supportedFrameImages: ['first_frame', 'last_frame'],
    generateAudio: true,
    seed: true,
    pricingSkus: {
      video_tokens: '0.000007',
      video_tokens_4k: '0.000004',
      video_tokens_1080p: '0.0000077',
      video_tokens_without_audio: '0.000007',
      video_tokens_with_video_input: '0.0000043',
      video_tokens_4k_with_video_input: '0.0000024',
      video_tokens_1080p_with_video_input: '0.0000047',
    },
  },
  {
    id: 'bytedance/seedance-2.0-fast',
    // 无 negativeParam：seedance 全系的 passthrough 只有 watermark, req_key
    providerSlug: 'seed',
    supportedResolutions: ['480p', '720p'],
    supportedAspectRatios: ['1:1', '3:4', '9:16', '4:3', '16:9', '21:9', '9:21'],
    supportedDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportedSizes: [
      '480x480',
      '480x640',
      '480x854',
      '640x480',
      '854x480',
      '1120x480',
      '720x720',
      '720x960',
      '720x1280',
      '720x1680',
      '960x720',
      '1280x720',
      '1680x720',
    ],
    supportedFrameImages: ['first_frame', 'last_frame'],
    generateAudio: true,
    seed: true,
    pricingSkus: {
      video_tokens: '0.0000042',
      video_tokens_without_audio: '0.0000042',
      video_tokens_with_video_input: '0.000002475',
    },
  },
  {
    id: 'bytedance/seedance-1-5-pro',
    // 无 negativeParam：seedance 全系的 passthrough 只有 watermark, req_key
    providerSlug: 'seed',
    supportedResolutions: ['480p', '720p', '1080p'],
    supportedAspectRatios: ['1:1', '3:4', '9:16', '9:21', '4:3', '16:9', '21:9'],
    supportedDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    supportedSizes: [
      '480x480',
      '480x640',
      '480x854',
      '480x1120',
      '640x480',
      '720x720',
      '720x960',
      '720x1280',
      '720x1680',
      '854x480',
      '960x720',
      '1080x1080',
      '1080x1440',
      '1080x1920',
      '1080x2520',
      '1120x480',
      '1280x720',
      '1440x1080',
      '1680x720',
      '1920x1080',
      '2520x1080',
    ],
    supportedFrameImages: ['first_frame', 'last_frame'],
    generateAudio: true,
    seed: true,
    pricingSkus: { video_tokens: '0.0000024', video_tokens_without_audio: '0.0000012' },
  },
]

export function findModel(id: string): OpenRouterModel | undefined {
  return OPENROUTER_MODELS.find((m) => m.id === id)
}

/**
 * 把镜头时长抬到该模型真正接受的档位。
 *
 * **必须向上取，且必须在计价时也用取整后的值。** 镜头时长是叙事概念
 * （`shots.duration_sec` 允许 2.5、3.5 这类小数），而每个模型只收一个离散整数
 * 列表——veo-3.1-lite 只有 `[4,6,8]`。线性按 `durationSec × 单价` 估算的话，
 * 一个 2.5 秒的镜头会被估成 4 秒价钱的 62%，而账单来的是 4 秒的全价。
 *
 * 多出来的秒数由 media worker 裁掉；让 provider 的档位去倒逼分镜是本末倒置。
 *
 * @returns 取整后的时长；超过该模型上限时返回 null（由 validate 负责拒绝）
 */
export function snapDuration(model: OpenRouterModel, durationSec: number): number | null {
  const sorted = [...model.supportedDurations].sort((a, b) => a - b)
  return sorted.find((d) => d >= durationSec) ?? null
}

/** 分辨率的短边像素。竖屏 9:16 的 720p 是 720×1280，短边才是 720 */
const SHORT_EDGE: Readonly<Record<string, number>> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  '4K': 2160,
}

/**
 * `(分辨率, 画幅)` → 该模型真正接受的 `WIDTHxHEIGHT`。
 *
 * 从模型自己的 `supported_sizes` 里挑，不硬编码——按 token 计价时像素数直接
 * 决定钱，猜错一档就是账单差一倍。
 */
export function sizeFor(
  model: OpenRouterModel,
  resolution: string,
  aspectRatio: string,
): { width: number; height: number } | null {
  const short = SHORT_EDGE[resolution]
  if (short === undefined) return null
  const [aw, ah] = aspectRatio.split(':').map(Number)
  if (!aw || !ah) return null
  const portrait = ah > aw

  const parsed = model.supportedSizes
    .map((s) => s.split('x').map(Number))
    .filter((p): p is [number, number] => p.length === 2 && !!p[0] && !!p[1])
    .map(([width, height]) => ({ width, height }))

  const hit = parsed.find(
    (p) =>
      Math.min(p.width, p.height) === short &&
      Math.abs(p.width / p.height - aw / ah) < 0.02 &&
      portrait === p.height > p.width,
  )
  if (hit) return hit

  /*
   * supported_sizes 里挑不到时按短边推。
   *
   * 目前六个模型线上都给了这个字段——「veo/wan 没给」是我先前 dump 时漏请求
   * 该字段得出的错误结论，被 RECORD=1 的漂移检查当场抓出来。留这条兜底是因为
   * 快照可能落后于线上新增的画幅；对按秒计价的模型无所谓（尺寸不进价格公式），
   * 对按 token 的模型则会被漂移检查先拦下。
   */
  const long = Math.round((short * Math.max(aw, ah)) / Math.min(aw, ah))
  return portrait ? { width: short, height: long } : { width: long, height: short }
}

/** 该模型按哪一族计价。键名前缀就是判据 */
export function pricingFamily(model: OpenRouterModel): 'per_second' | 'per_token' | null {
  const keys = Object.keys(model.pricingSkus)
  if (keys.some((k) => k.startsWith('duration_seconds'))) return 'per_second'
  if (keys.some((k) => k.startsWith('video_tokens'))) return 'per_token'
  return null
}

/**
 * 选价目表条目。键名从具体到笼统退化：
 * `<前缀>_without_audio_720p` → `<前缀>_without_audio` → `<前缀>_720p` → `<前缀>`
 *
 * 找不到任何键时返回 null——那说明快照漂了或者这个模型的计价形状我们没见过，
 * 让调用方显式失败，而不是悄悄按 0 计价（记 0 会让预算闸门失效）。
 */
function unitPrice(model: OpenRouterModel, resolution: string, withAudio: boolean): number | null {
  const prefix = pricingFamily(model) === 'per_token' ? 'video_tokens' : 'duration_seconds'
  const audio = withAudio ? 'with_audio' : 'without_audio'
  // 4K 的键写作 `_4k`，其余用分辨率原文小写
  const res = resolution.toLowerCase()
  for (const key of [`${prefix}_${audio}_${res}`, `${prefix}_${audio}`, `${prefix}_${res}`, prefix]) {
    const v = model.pricingSkus[key]
    if (v !== undefined) return Number(v)
  }
  return null
}

/**
 * 事前成本估算，单位整数微美元。**同步、零 IO**——它跑在预算闸门里。
 *
 * ## 两族计价，两个公式
 *
 * **按秒**（veo / kling / wan）：`取整后的秒数 × 每秒单价`。
 *
 * **按 token**（seedance 全系）：ByteDance 公布的口径是
 *
 * ```
 * tokens = 输出宽 × 输出高 × 时长 × fps / 1024
 * ```
 *
 * 所以**不需要标定、也不该去猜**。代进本项目的档位（720×1280、4 秒、24fps）
 * 是 86,400 token，乘 seedance-2.0 的 $0.000007 得 $0.605 一镜——比
 * veo-3.1-lite 的 $0.12 贵五倍，而这正是闸门必须算准的那种量级差。
 *
 * 别忘了 `fps` 进公式：把 24 写死会在将来支持 30fps 时低估 25%。
 */
export function estimateMicroUsd(model: OpenRouterModel, req: GenerationRequest, withAudio: boolean): number {
  const seconds = snapDuration(model, req.durationSec)
  if (seconds === null) return 0 // validate 会先拒掉，走不到这里

  const price = unitPrice(model, req.resolution, withAudio)
  // 找不到对应键时不要静默按 0——记 0 会让预算闸门失效
  if (price === null) throw new Error(`${model.id} 没有匹配 ${req.resolution} 的价目表条目`)

  const family = pricingFamily(model)
  if (family === 'per_second') return Math.round(seconds * price * 1e6)

  const size = sizeFor(model, req.resolution, req.aspectRatio)
  if (size === null) throw new Error(`${model.id} 算不出 ${req.resolution}/${req.aspectRatio} 的输出尺寸`)
  const tokens = (size.width * size.height * seconds * req.fps) / 1024
  return Math.round(tokens * price * 1e6)
}
