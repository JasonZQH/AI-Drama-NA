import { RETRYABLE } from '@ai-drama/contracts'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRequest } from './contractSuite.js'
import { OpenRouterProvider, mapFailure } from './openrouter.js'
import { estimateMicroUsd, findModel, pricingFamily, sizeFor, snapDuration } from './openrouterModels.js'
import { buildProviderPool } from './registry.js'

const VEO_LITE = findModel('google/veo-3.1-lite')!
const WAN = findModel('alibaba/wan-2.7')!
const SEEDANCE = findModel('bytedance/seedance-2.0')!

const make = (model = VEO_LITE) => new OpenRouterProvider({ apiKey: 'test-key', model })

describe('OpenRouter 能力快照', () => {
  it('池的单位是 (provider, model)——id 带上模型名', () => {
    expect(make().id).toBe('openrouter:google/veo-3.1-lite')
    expect(make().modelId).toBe('google/veo-3.1-lite')
  })

  /**
   * **时长必须向上取到受支持的档位。**
   *
   * `shots.duration_sec` 允许 2.5、3.5 这类小数（CHECK 只管 0 < d <= 10），而
   * 每个模型只收一个离散整数列表——veo-3.1-lite 是 [4,6,8]。这条守的是
   * 「按请求时长线性估价」那个错误做法。
   */
  it('snapDuration 向上取整到档位，超上限返回 null', () => {
    expect(snapDuration(VEO_LITE, 2.5)).toBe(4)
    expect(snapDuration(VEO_LITE, 4)).toBe(4)
    expect(snapDuration(VEO_LITE, 4.1)).toBe(6)
    expect(snapDuration(VEO_LITE, 9)).toBeNull()
    // wan 的档位密得多，2.5 秒的镜头只要付 3 秒
    expect(snapDuration(WAN, 2.5)).toBe(3)
  })

  /**
   * **能力里的时长下限就是档位表里最小的那个。**
   *
   * 契约一度只建模天花板（`maxDurationSec`），而咬人的是地板。三家的地板都不同：
   * veo-lite 4 秒、wan 2 秒、seedance 4 秒——分镜规划 2 秒在 wan 上买得到，
   * 在 seedance 上会被 `snapDuration` **静默抬到 4 秒**：片子按 4 秒出、钱按
   * 4 秒付，而整集是按 2 秒那份计划算的。真机实测目标 30 秒的一集出了 44.5 秒。
   *
   * 断言到具体数字而不是 `toBeLessThanOrEqual(max)`：取错端（拿上限当下限）时
   * `min === max` 是自洽的，范围断言看不出来。
   */
  it('minDurationSec 取档位表最小值，不是最大值', () => {
    const cap = (m: typeof VEO_LITE) => make(m).capabilities
    expect(cap(VEO_LITE).minDurationSec, 'veo-lite 是 [4,6,8]').toBe(4)
    expect(cap(WAN).minDurationSec, 'wan 档位密，2 秒起').toBe(2)
    expect(cap(SEEDANCE).minDurationSec, 'seedance 全系 4 秒起').toBe(4)
    // 与上限确实是两端，不是同一个数
    expect(cap(WAN).minDurationSec).toBeLessThan(cap(WAN).maxDurationSec)
  })

  it('计价族按键名前缀判定', () => {
    expect(pricingFamily(VEO_LITE)).toBe('per_second')
    expect(pricingFamily(WAN)).toBe('per_second')
    expect(pricingFamily(SEEDANCE)).toBe('per_token')
  })

  /**
   * 尺寸直接决定按 token 计价的钱，猜错一档账单就差一倍。
   * 所以从模型自己的 supported_sizes 里挑，不硬编码。
   */
  it('尺寸从 supported_sizes 里挑，竖屏不能挑成横屏', () => {
    expect(sizeFor(SEEDANCE, '720p', '9:16')).toEqual({ width: 720, height: 1280 })
    expect(sizeFor(SEEDANCE, '720p', '16:9')).toEqual({ width: 1280, height: 720 })
    expect(sizeFor(SEEDANCE, '1080p', '9:16')).toEqual({ width: 1080, height: 1920 })
    // veo / wan 线上就没给 supported_sizes，按短边推——它们按秒计价，尺寸不进公式
    expect(sizeFor(VEO_LITE, '720p', '9:16')).toEqual({ width: 720, height: 1280 })
  })

  /**
   * 这条是预算闸门的地基。低估的直接后果是闸门放行了实际会超限的批量。
   */
  it('估价按取整后的时长，不是请求时长', () => {
    const p = make()
    // 2.5s 的镜头按 4s 付：4 × $0.03 = $0.12 = 120000 微美元
    expect(p.estimateCost(makeRequest({ durationSec: 2.5 }))).toBe(120_000)
    expect(p.estimateCost(makeRequest({ durationSec: 4 }))).toBe(120_000)
    // 线性估算会给出 2.5 × 0.03 = 75000，比真实账单低 38%
    expect(p.estimateCost(makeRequest({ durationSec: 2.5 }))).not.toBe(75_000)
    // wan 档位密，2.5s 只付 3s
    expect(make(WAN).estimateCost(makeRequest({ durationSec: 2.5 }))).toBe(300_000)
  })

  /**
   * **按 token 计价用 ByteDance 公布的公式，不标定、不猜。**
   *
   *   tokens = 宽 × 高 × 时长 × fps / 1024
   *
   * 720×1280×4×24/1024 = 86,400 token，× $0.000007 = $0.605 一镜。
   * 这条同时钉住三件事：公式、尺寸挑对了、fps 真的进了公式。
   */
  it('seedance 按 token 公式估价', () => {
    const p = make(SEEDANCE)
    expect(p.estimateCost(makeRequest({ durationSec: 4 }))).toBe(604_800)
    // 2.5s 向上取到 4s（seedance 最低档就是 4），价钱不变
    expect(p.estimateCost(makeRequest({ durationSec: 2.5 }))).toBe(604_800)
    // 8 秒是 4 秒的两倍
    expect(p.estimateCost(makeRequest({ durationSec: 8 }))).toBe(1_209_600)
  })

  it('fps 真的进了 token 公式——写死 24 会在 30fps 时低估 25%', () => {
    const at24 = estimateMicroUsd(SEEDANCE, makeRequest({ durationSec: 4, fps: 24 }), false)
    const at30 = estimateMicroUsd(SEEDANCE, makeRequest({ durationSec: 4, fps: 30 }), false)
    expect(at30 / at24).toBeCloseTo(30 / 24, 5)
  })

  it('横屏比竖屏贵不了也便宜不了——像素数一样', () => {
    const portrait = estimateMicroUsd(SEEDANCE, makeRequest({ aspectRatio: '9:16' }), false)
    const landscape = estimateMicroUsd(SEEDANCE, makeRequest({ aspectRatio: '16:9' }), false)
    expect(landscape).toBe(portrait)
  })

  /** 一集 12 镜比默认日预算（$5）还贵——闸门会拦，这不是 bug 是设计 */
  it('seedance-2.0 一集 12 镜超过默认日预算', () => {
    const perShot = make(SEEDANCE).estimateCost(makeRequest({ durationSec: 4 }))
    expect(perShot * 12).toBeGreaterThan(5_000_000)
  })

  it('validate 零 IO，且拒绝超出档位的时长', () => {
    const p = make()
    expect(p.validate(makeRequest({ durationSec: 4 }))).toMatchObject({ ok: true })
    expect(p.validate(makeRequest({ durationSec: 9 }))).toMatchObject({ ok: false })
    expect(p.validate(makeRequest({ resolution: '480p' }))).toMatchObject({ ok: false })
    // 非 t2v 要参考图，与 mock 同一条规则
    expect(p.validate(makeRequest({ mode: 'i2v' }))).toMatchObject({ ok: false })
  })

  /**
   * mature 内容按 04 §5 规则 2 只路由到 serverSideContentFilter===false 的
   * provider。所有走 OpenRouter 的模型都有服务端过滤——这一位写错会让 L2 的
   * 镜头被路由到一个必然拒绝它的地方，白烧一次 attempt。
   */
  it('声明有服务端内容过滤——L2 不会被路由过来', () => {
    expect(make().capabilities.serverSideContentFilter).toBe(true)
  })

  /**
   * 统一请求体里确实没有这个字段，但**能走 passthrough**——支不支持完全取决于
   * 各模型的 `allowed_passthrough_parameters`，不是一刀切的 false。
   */
  it('负向词按模型声明：veo/wan 有，seedance 全系没有', () => {
    expect(make(VEO_LITE).capabilities.supportsNegative).toBe(true)
    expect(make(WAN).capabilities.supportsNegative).toBe(true)
    expect(make(SEEDANCE).capabilities.supportsNegative).toBe(false)
  })

  it('cancel 是 no-op：OpenRouter 没有这个端点，不该假装取消成功', async () => {
    await expect(make().cancel()).resolves.toBeUndefined()
  })
})

/**
 * **厂商的拒稿文本 → 统一 FailureCode。**
 *
 * 这个函数此前既没导出也没测过——于是它漏掉一整类没人发现，直到真钱撞上：
 * seedance 拒稿的原话是「output video may be related to **copyright
 * restrictions**」，原来那串词一个都不命中，落进 `provider_error`；而它在
 * `RETRYABLE` 里、注释写着「多为临时故障」，于是编排层拿**同一个 prompt**
 * 撞了 4 次（maxAttempts），每次 $0.3629，**一个镜头烧掉 $1.45**。
 *
 * 分类错的代价不是「标签不好看」，是**把确定性失败当成偶发失败重试**。
 */
describe('mapFailure：分类错 = 拿同一个 prompt 重复付钱', () => {
  const cases: [string, ReturnType<typeof mapFailure>][] = [
    // 真机实测的那一条，逐字
    [
      'The request failed because the output video may be related to copyright restrictions. Request id: 0217873756957',
      'content_filtered',
    ],
    ['Output blocked by safety policy', 'content_filtered'],
    ['content filter triggered', 'content_filtered'],
    ['possible copyright infringement detected', 'content_filtered'],
    ['insufficient credits on your account', 'quota_exceeded'],
    ['upstream request timed out', 'timeout'],
    ['invalid duration for this model', 'invalid_output'],
    // 兜底：认不出的才是 provider_error，而它是唯一会被自动重试的
    ['upstream connection reset', 'provider_error'],
  ]
  for (const [raw, want] of cases)
    it(`「${raw.slice(0, 40)}…」→ ${want}`, () => {
      expect(mapFailure(raw)).toBe(want)
    })

  it('content_filtered 不在 RETRYABLE 里——这条才是钱的闸', () => {
    expect(RETRYABLE).not.toContain('content_filtered')
    expect(RETRYABLE, 'provider_error 是可重试的，所以分类必须准').toContain('provider_error')
  })
})

describe('OpenRouter 进池的条件', () => {
  it('没有 key 就不进池——「无 GPU 无 key 跑通全链路」的前提', () => {
    expect(buildProviderPool({}).map((p) => p.id)).toEqual(['mock'])
  })

  it('配了 key 与 model 才进，每个 model 一个条目', () => {
    const pool = buildProviderPool({
      OPENROUTER_API_KEY: 'k',
      OPENROUTER_VIDEO_MODELS: 'google/veo-3.1-lite, alibaba/wan-2.7',
    })
    expect(pool.map((p) => p.id)).toEqual([
      'mock',
      'openrouter:google/veo-3.1-lite',
      'openrouter:alibaba/wan-2.7',
    ])
  })

  it('配了 key 但没配 model 时池里只有 mock，不是悄悄用默认模型', () => {
    expect(buildProviderPool({ OPENROUTER_API_KEY: 'k' }).map((p) => p.id)).toEqual(['mock'])
  })

  // 静默跳过会让人以为配了就生效，而实际池里没有它——错的方向是安静的那个
  it('不认识的 model 直接抛，不静默跳过', () => {
    expect(() =>
      buildProviderPool({ OPENROUTER_API_KEY: 'k', OPENROUTER_VIDEO_MODELS: 'acme/nope' }),
    ).toThrow(/不在能力快照/)
  })

  it('DEFAULT_PROVIDER 把指定条目排到第一', () => {
    const pool = buildProviderPool({
      OPENROUTER_API_KEY: 'k',
      OPENROUTER_VIDEO_MODELS: 'google/veo-3.1-lite',
      DEFAULT_PROVIDER: 'openrouter:google/veo-3.1-lite',
    })
    expect(pool[0]!.id).toBe('openrouter:google/veo-3.1-lite')
  })
})

/**
 * submit 的请求体。用 loopback server 而不是 `vi.stubGlobal('fetch')`——后者会
 * 绕过 `vitest.setup.ts` 挂在 `net.Socket.prototype.connect` 上的出网拦截。
 */
describe('submit 请求体：负向词的 passthrough', () => {
  let server: Server
  let baseUrl = ''
  let body: Record<string, unknown> = {}

  beforeAll(async () => {
    server = createServer((req, res) => {
      let buf = ''
      req.on('data', (c) => (buf += c))
      req.on('end', () => {
        body = JSON.parse(buf) as Record<string, unknown>
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'vid_1', status: 'pending' }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('拿不到端口')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  const submit = async (model: typeof VEO_LITE, negativePrompt?: string) => {
    body = {}
    const p = new OpenRouterProvider({ apiKey: 'k', model, baseUrl })
    await p.submit(makeRequest({ durationSec: 4, ...(negativePrompt ? { negativePrompt } : {}) }))
    return body
  }

  /**
   * 这条是本次改动的存在理由：`style_profiles.negative_prompt` 此前是算出来、
   * 落 `generation_jobs.negative_text`、**然后在构造 HTTP body 这一行扔掉**。
   */
  it('veo：驼峰 negativePrompt，塞在 google-vertex 名下', async () => {
    const b = await submit(VEO_LITE, 'cartoon, watermark')
    expect(b['provider']).toEqual({
      options: { 'google-vertex': { parameters: { negativePrompt: 'cartoon, watermark' } } },
    })
  })

  /** 参数名与 slug 各家都不同，而两处错了都不报错，只是静默丢弃 */
  it('wan：下划线 negative_prompt，塞在 atlas-cloud 名下', async () => {
    const b = await submit(WAN, 'cartoon')
    expect(b['provider']).toEqual({
      options: { 'atlas-cloud': { parameters: { negative_prompt: 'cartoon' } } },
    })
  })

  it('seedance 不带——它的 passthrough 只有 watermark, req_key', async () => {
    expect((await submit(SEEDANCE, 'cartoon'))['provider']).toBeUndefined()
  })

  it('没有负向词就整个 provider 键都不出现，不是空对象', async () => {
    expect((await submit(VEO_LITE))['provider']).toBeUndefined()
  })
})
