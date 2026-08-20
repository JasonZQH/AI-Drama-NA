import type {
  GenerationRequest,
  GenerationResult,
  PollOutcome,
  ProviderCapabilities,
  ProviderFailure,
  ProviderHandle,
  ProviderHealth,
  ValidationResult,
  VideoProvider,
} from '@ai-drama/contracts'
import {
  estimateMicroUsd,
  findModel,
  pricingFamily,
  snapDuration,
  type OpenRouterModel,
} from './openrouterModels.js'

/**
 * OpenRouter 视频适配器（M1 P5）。
 *
 * 一把 key、一个 host、原生回报 `usage.cost`——选它而不是直连各厂的理由见
 * `adr/0012`。**池的单位是 `(provider, model)`**：每个 model 一个实例，
 * `id = 'openrouter:google/veo-3.1-lite'`，这样 `generation_jobs.model_id`
 * 与 `gj_analytics_idx` 才能按模型切成本。
 *
 * ## 实测到的三件事（2026-08-17，逐条影响实现）
 *
 * 1. **没有 cancel 端点。** 文档里不存在 cancel/delete。所以 `cancel()` 是
 *    诚实的 no-op，契约套件注册时传 `cancelEffective: false`。后果要往上游看：
 *    超时后不能立刻开下一次 attempt，否则两个任务同时计费（orchestrator 的
 *    超时路径已按估算值记账，正是为这种情形）。
 * 2. **没有请求级幂等键。** `X-OpenRouter-Idempotency-Key` 只是回调 webhook 的
 *    投递头（`<job_id>-<status>`），不是请求幂等。所以同 requestId 重复提交会
 *    产生两个 job、计两次费——幂等完全落在编排层的 CAS 认领上（PR-A），
 *    而 submit 抛出时走不可重试的 `submit_unknown`（PR-B）。
 * 3. **`supported_durations` 是离散整数列表。** 见 `openrouterModels.ts`。
 *
 * ## 一个未验证项
 *
 * 产物字段叫 `unsigned_urls`，而文档给的下载示例带着 `Authorization`。若它确实
 * 需要鉴权，`queue/ingest.ts` 的裸 `fetch` 会 401。第一次拿到 key 时先跑
 * `scripts/probe-openrouter.mjs` 验这一条——**在验之前不要跑整集**。
 */

const BASE_URL = 'https://openrouter.ai/api/v1'

/** 提交/轮询的单次 HTTP 超时。生成本身的等待归 orchestrator 的轮询链管 */
const HTTP_TIMEOUT_MS = 30_000

/**
 * **是否让 provider 自带音轨——一个常量，两处使用，不许分叉。**
 *
 * 关掉：我们的音频走 M3 的 TTS 链路，让 provider 自带既贵又会和后期对不上。
 *
 * 提成常量是因为它同时决定 `submit` 的请求体和 `estimateCost` 选哪条价目表键。
 * 两处各写一遍的话就会出现「估算按有音轨、账单按无音轨」——实测在
 * veo-3.1-lite 上是 $0.05/s vs $0.03/s，估算高出 67%，M1 验收第 2 条
 * （误差 <20%）当场不成立。这正是 probe 与真实请求分叉的同一类 bug。
 */
const GENERATE_AUDIO = false

export interface OpenRouterOptions {
  readonly apiKey: string
  readonly model: OpenRouterModel
  readonly baseUrl?: string
  /** 归因用，OpenRouter 的排行榜会读它们。不影响计费 */
  readonly referer?: string
  readonly title?: string
}

interface SubmitResponse {
  id: string
  status: string
}

interface PollResponse {
  id: string
  status: string
  unsigned_urls?: string[]
  error?: string | { message?: string; code?: string }
  usage?: { cost?: number; is_byok?: boolean }
}

export class OpenRouterProvider implements VideoProvider {
  readonly id: string
  readonly modelId: string
  readonly capabilities: ProviderCapabilities

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly model: OpenRouterModel
  private readonly headers: Record<string, string>

  constructor(opts: OpenRouterOptions) {
    this.model = opts.model
    this.modelId = opts.model.id
    this.id = `openrouter:${opts.model.id}`
    this.apiKey = opts.apiKey
    this.baseUrl = opts.baseUrl ?? BASE_URL
    this.headers = {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
      ...(opts.referer ? { 'http-referer': opts.referer } : {}),
      ...(opts.title ? { 'x-title': opts.title } : {}),
    }

    const durations = [...opts.model.supportedDurations].sort((a, b) => a - b)
    this.capabilities = {
      /*
       * 只声明 t2v 与 i2v/ref2v 里我们真能构造出请求的那些。`extend` 不声明——
       * OpenRouter 的统一 schema 没有「续写一段已有视频」这个入口。
       */
      modes: opts.model.supportedFrameImages.length > 0 ? ['t2v', 'i2v', 'ref2v'] : ['t2v'],
      maxDurationSec: durations[durations.length - 1] ?? 0,
      resolutions: opts.model.supportedResolutions.filter((r): r is '480p' | '720p' | '1080p' =>
        ['480p', '720p', '1080p'].includes(r),
      ),
      aspectRatios: opts.model.supportedAspectRatios.filter((a): a is '9:16' | '16:9' | '1:1' =>
        ['9:16', '16:9', '1:1'].includes(a),
      ),
      /** 统一 schema 下 `input_references` 是扁平数组，没有各家的 role routing（issue #11） */
      maxRefImages: opts.model.supportedFrameImages.length > 0 ? 4 : 0,
      supportsSeed: opts.model.seed,
      /**
       * 统一请求体里没有 negative_prompt 字段，但**能走 passthrough**——
       * 支不支持完全取决于该模型的 `allowed_passthrough_parameters`。
       * veo/wan 有，seedance 全系没有（只允许 `watermark, req_key`）。
       */
      supportsNegative: opts.model.negativeParam !== undefined,
      supportsFirstLastFrame: opts.model.supportedFrameImages.includes('last_frame'),
      supportsAudio: opts.model.generateAudio,
      /**
       * 所有走 OpenRouter 的模型都有服务端内容过滤——mature 内容按 04 §5 规则 2
       * 不会被路由到这里，因此不需要为它写任何 content_filtered 之外的分支。
       */
      serverSideContentFilter: true,
      maxConcurrent: 4,
      /*
       * 两族计价，`unit` 要如实写。路由器目前不读它，但 04 §2 的 CostModel 是
       * 对外承诺的形状——写成 per_second 而实际按 token 收，是让下一个人踩坑。
       *
       * microUsdPerUnit 用一次「本项目标准档」（4s 720p 9:16）的总价除以秒数，
       * 得到一个可比的每秒口径。真正算钱走 estimateMicroUsd，不走这里。
       */
      costModel: {
        unit: pricingFamily(opts.model) === 'per_token' ? 'per_token' : 'per_second',
        microUsdPerUnit: Math.round(
          estimateMicroUsd(opts.model, referenceRequest(opts.model), GENERATE_AUDIO) / 4,
        ),
      },
    }
  }

  /**
   * 从 env 构造整池。`OPENROUTER_VIDEO_MODELS` 里每个 model 一个实例。
   * 没配 key 就返回空数组——未配置的 provider 不该进池（04 §6）。
   */
  static poolFromEnv(env: NodeJS.ProcessEnv = process.env): OpenRouterProvider[] {
    const apiKey = env['OPENROUTER_API_KEY']
    if (!apiKey) return []
    const ids = (env['OPENROUTER_VIDEO_MODELS'] ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)

    return ids.map((id) => {
      const model = findModel(id)
      // 不认识的 model 直接抛：静默跳过会让人以为配了就生效，而实际池里没有它
      if (!model) throw new Error(`OPENROUTER_VIDEO_MODELS 里的 ${id} 不在能力快照中`)
      return new OpenRouterProvider({
        apiKey,
        model,
        ...(env['OPENROUTER_REFERER'] ? { referer: env['OPENROUTER_REFERER'] } : {}),
        ...(env['OPENROUTER_TITLE'] ? { title: env['OPENROUTER_TITLE'] } : {}),
      })
    })
  }

  /** 零 IO。契约要求（04 §7），也是 test 车道出网拦截会替我们盯住的一条 */
  validate(req: GenerationRequest): ValidationResult {
    const c = this.capabilities
    if (!c.modes.includes(req.mode)) return { ok: false, reason: `不支持 mode=${req.mode}` }
    if (!c.resolutions.includes(req.resolution)) return { ok: false, reason: `不支持 ${req.resolution}` }
    if (!c.aspectRatios.includes(req.aspectRatio)) return { ok: false, reason: `不支持 ${req.aspectRatio}` }
    if (req.refImages.length > c.maxRefImages)
      return { ok: false, reason: `参考图 ${req.refImages.length} 张超过上限 ${c.maxRefImages}` }
    if (req.mode !== 't2v' && req.refImages.length === 0)
      return { ok: false, reason: `mode=${req.mode} 至少需要一张参考图` }
    if (snapDuration(this.model, req.durationSec) === null)
      return {
        ok: false,
        reason: `时长 ${req.durationSec}s 超过 ${this.modelId} 的档位上限 ${c.maxDurationSec}s`,
      }
    return { ok: true }
  }

  /**
   * **按取整后的时长计价，不是按请求的时长。**
   *
   * 2.5 秒的镜头在 veo-3.1-lite（档位 4/6/8）上按 4 秒付钱。线性估算会低估 38%，
   * 而预算闸门读的正是这个数——低估的直接后果是闸门放行了实际会超限的批量。
   */
  estimateCost(req: GenerationRequest): number {
    // 与 submit 用同一个音轨常量。分开写就是估算与账单按不同价目表键算
    return estimateMicroUsd(this.model, req, GENERATE_AUDIO)
  }

  async submit(req: GenerationRequest): Promise<ProviderHandle> {
    const seconds = snapDuration(this.model, req.durationSec)
    if (seconds === null) throw new Error(`时长 ${req.durationSec}s 不在 ${this.modelId} 的档位内`)

    const body: Record<string, unknown> = {
      model: this.modelId,
      prompt: req.prompt,
      duration: seconds,
      resolution: req.resolution,
      aspect_ratio: req.aspectRatio,
      generate_audio: GENERATE_AUDIO, // 与 estimateCost 同源，见常量注释
      ...(this.capabilities.supportsSeed && req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.refImages.length > 0 ? { input_references: refPayload(req) } : {}),
      ...negativePassthrough(this.model, req.negativePrompt),
    }

    const res = await this.fetchJson<SubmitResponse>('POST', '/videos', body)
    // 202 与 200 都当成受理；契约只关心「拿到了一个可轮询的 id」
    return { providerId: this.id, externalId: res.id, submittedAt: Date.now() }
  }

  async poll(handle: ProviderHandle): Promise<PollOutcome> {
    const r = await this.fetchJson<PollResponse>('GET', `/videos/${handle.externalId}`)

    if (r.status === 'pending') return { status: 'submitted', stage: 'queued' }
    if (r.status === 'in_progress') {
      /*
       * **轮询响应里没有百分比。** 只有四个状态值。所以 pct 留空、只给 stage——
       * 契约里 `progressPct` 是 optional 正是为这种 provider 准备的，而 SSE 层
       * 会把它补成 0：一条不动的 0% 条配「生成中」是「系统在忙」，什么都不发
       * 才是「系统死了」（07 §2 R1）。
       */
      return { status: 'running', stage: 'denoising' }
    }
    if (r.status === 'failed') return this.failureOf(r)
    if (r.status === 'completed') return this.resultOf(r)

    // 没见过的状态值当可重试错误处理，并把原值带出去，便于发现 API 变更
    const f: ProviderFailure = {
      status: 'failed',
      code: 'provider_error',
      message: `未知状态 ${r.status}`,
      retryable: true,
      ...(r.usage?.cost === undefined ? {} : { costMicroUsd: usdToMicro(r.usage.cost) }),
    }
    return f
  }

  /**
   * **诚实的 no-op：OpenRouter 没有 cancel 端点。**
   *
   * 不抛错是因为契约签名是 `Promise<void>`，而调用方（orchestrator 的超时路径）
   * 本来就是 best-effort。真正要紧的是上游别把「已取消」当真：任务还在跑、还在
   * 计费，所以超时那条路记的是**估算成本**而不是 0，也不该立刻开下一次 attempt。
   */
  cancel(): Promise<void> {
    return Promise.resolve()
  }

  /** 用公开的模型列表探活：不需要 key、不产生任何计费 */
  async health(): Promise<ProviderHealth> {
    try {
      const res = await fetch(`${this.baseUrl}/videos/models`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      return res.ok ? { ok: true } : { ok: false, detail: `models 端点 HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, detail: String(e) }
    }
  }

  private resultOf(r: PollResponse): GenerationResult {
    const url = r.unsigned_urls?.[0]
    if (!url) throw new Error(`completed 但没有 unsigned_urls：${r.id}`)
    const [w, h] = sizeOf(this.capabilities.resolutions[0] ?? '720p')
    return {
      status: 'succeeded',
      outputUrl: url,
      // 时长/宽高由 media worker 的 ffprobe 校正；这里给的是请求档位，不是实测值
      durationSec: 0,
      widthPx: w,
      heightPx: h,
      fps: 24,
      costMicroUsd: usdToMicro(r.usage?.cost ?? 0),
      providerMeta: {
        openrouter: true,
        // usage.cost 是厂商真实计费，不是估算——这一位决定报表里显不显示 ≈
        costEstimated: r.usage?.cost === undefined,
        ...(r.usage?.is_byok === undefined ? {} : { isByok: r.usage.is_byok }),
      },
    }
  }

  private failureOf(r: PollResponse): ProviderFailure {
    const raw = typeof r.error === 'string' ? r.error : (r.error?.message ?? '未提供原因')
    const code = mapFailure(raw)
    return {
      status: 'failed',
      code,
      message: raw,
      retryable: code !== 'content_filtered' && code !== 'quota_exceeded',
      /*
       * **失败也可能计费。** usage 缺失不等于免费——多数厂商对失败的生成照样收费，
       * 只是不在失败响应里带账单。留空由编排层按价目表估（PR-B 的 fail() 会做）。
       */
      ...(r.usage?.cost === undefined ? {} : { costMicroUsd: usdToMicro(r.usage.cost) }),
    }
  }

  private async fetchJson<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`OpenRouter ${method} ${path} HTTP ${res.status}：${text.slice(0, 400)}`)
    return JSON.parse(text) as T
  }
}

/**
 * 负向词的 passthrough。**`style_profiles.negative_prompt` 此前是算出来、落
 * `generation_jobs.negative_text`、然后扔掉**——`buildPrompt` 一直在返回它，
 * 构造 HTTP body 这一行把它丢了。
 *
 * 形状是官方文档的原样（`provider.options.<slug>.parameters.<name>`）：
 *
 * ```json
 * { "provider": { "options": { "google-vertex": {
 *     "parameters": { "negativePrompt": "blurry, low quality" } } } } }
 * ```
 *
 * **两处都错不得，而且错了都不报错：**
 *
 * - 参数名各家不同（veo 驼峰、wan 下划线），写错 → 不在
 *   `allowed_passthrough_parameters` 里 → 丢弃；
 * - slug 是路由键，官方原话「only the options for the matched provider are
 *   forwarded」，写错 → 同样丢弃。
 *
 * 所以两个值都抄自线上、都由漂移检查核，不靠记性。
 */
function negativePassthrough(
  model: OpenRouterModel,
  negativePrompt: string | undefined,
): Record<string, unknown> {
  const name = model.negativeParam
  const slug = model.providerSlug
  if (!name || !slug || !negativePrompt) return {}
  return { provider: { options: { [slug]: { parameters: { [name]: negativePrompt } } } } }
}

function refPayload(req: GenerationRequest): unknown[] {
  return req.refImages.map((r) => ({ type: 'image_url', image_url: { url: r.url } }))
}

/** `usage.cost` 是美元浮点数。转换只在边界做一次，往上游一律是整数微美元 */
function usdToMicro(usd: number): number {
  return Math.max(0, Math.round(usd * 1e6))
}

function sizeOf(resolution: string): [number, number] {
  // 竖屏 9:16。真实尺寸由 media worker 规范化，这里只给一个合理的登记值
  return resolution === '1080p' ? [1080, 1920] : [720, 1280]
}

/**
 * 厂商的错误文本 → 统一 FailureCode。
 *
 * 上游代码永远不该分支在厂商的原始字符串上（04 §3）。匹配用小写子串而不是
 * 精确相等——OpenRouter 转发的是各家自己的措辞，形状不稳定。
 */
function mapFailure(raw: string): ProviderFailure['code'] {
  const s = raw.toLowerCase()
  if (/(safety|policy|moderat|content filter|blocked|nsfw)/.test(s)) return 'content_filtered'
  if (/(quota|rate limit|insufficient credit|payment|billing)/.test(s)) return 'quota_exceeded'
  if (/(timeout|timed out|deadline)/.test(s)) return 'timeout'
  if (/(invalid|unsupported|bad request|validation)/.test(s)) return 'invalid_output'
  return 'provider_error'
}

/**
 * 「本项目标准档」的一条参考请求：4 秒 720p 9:16。
 *
 * 只用来给 `capabilities.costModel.microUsdPerUnit` 折算一个可比的每秒口径——
 * 按 token 计价的模型没有天然的「每秒单价」，而 04 §2 的 CostModel 要求给一个。
 */
function referenceRequest(model: OpenRouterModel): GenerationRequest {
  return {
    requestId: '00000000-0000-4000-8000-000000000000',
    shotId: '00000000-0000-4000-8000-000000000000',
    mode: 't2v',
    prompt: '',
    refImages: [],
    durationSec: snapDuration(model, 4) ?? 4,
    resolution: '720p',
    aspectRatio: '9:16',
    fps: 24,
    safetyProfile: 'standard',
    priority: 'normal',
    providerParams: {},
  }
}
