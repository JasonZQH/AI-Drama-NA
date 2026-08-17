/**
 * OpenRouter 视频模型能力快照。
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
 * `openrouter.drift.test.ts` 在 `RECORD=1` 下重新拉一次并逐字段对比。平时的
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
  readonly supportedFrameImages: readonly string[]
  readonly generateAudio: boolean
  readonly seed: boolean
  /**
   * 按秒计价，键名编码了 `(模式, 分辨率, 有无音轨)`。越具体的键优先。
   * 单位是美元/秒的字符串——不要提前转 number，转换只在算钱那一刻做。
   */
  readonly pricingSkus: Readonly<Record<string, string>>
}

export const OPENROUTER_MODELS: readonly OpenRouterModel[] = [
  {
    id: 'google/veo-3.1-lite',
    supportedResolutions: ['720p', '1080p'],
    supportedAspectRatios: ['16:9', '9:16'],
    supportedDurations: [8, 4, 6],
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
    supportedResolutions: ['720p', '1080p', '4K'],
    supportedAspectRatios: ['16:9', '9:16'],
    supportedDurations: [4, 6, 8],
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
    supportedResolutions: ['720p', '1080p'],
    supportedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    supportedDurations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    supportedFrameImages: ['first_frame', 'last_frame'],
    generateAudio: true,
    seed: true,
    pricingSkus: { duration_seconds: '0.1' },
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

/**
 * 选价目表条目。键名从具体到笼统退化：
 * `duration_seconds_without_audio_720p` → `duration_seconds_without_audio` → `duration_seconds`
 *
 * 找不到任何键时返回 null——那说明快照漂了或者这个模型的计价形状我们没见过，
 * 让调用方显式失败，而不是悄悄按 0 计价（记 0 会让预算闸门失效）。
 */
export function pricePerSecond(
  model: OpenRouterModel,
  resolution: string,
  withAudio: boolean,
): number | null {
  const audio = withAudio ? 'with_audio' : 'without_audio'
  const res = resolution.toLowerCase()
  for (const key of [
    `duration_seconds_${audio}_${res}`,
    `duration_seconds_${audio}`,
    `duration_seconds_${res}`,
    'duration_seconds',
  ]) {
    const v = model.pricingSkus[key]
    if (v !== undefined) return Number(v)
  }
  return null
}
