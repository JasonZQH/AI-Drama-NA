import type {
  GenerationRequest,
  GenerationResult,
  GenStage,
  PollOutcome,
  ProviderCapabilities,
  ProviderFailure,
  ProviderHandle,
  ProviderHealth,
  ValidationResult,
  VideoProvider,
} from '@ai-drama/contracts'
import { FailureCode } from '@ai-drama/contracts'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * MockProvider —— **不是玩具，是一等公民**（04-provider-adapter.md §4.1）。
 *
 * 它是约束 C3「Mac 上无 GPU、无 API key 也能跑通全链路」的载体。M0 的整条
 * 验收链路都跑在它上面，所以它必须像真的一样：会失败、有延迟、有成本、
 * 产出可解码的视频。
 *
 * 尤其是**失败**：重试逻辑与错误 UI 必须在开发期就被真实触发过，不能等接
 * 真 provider 时集中爆发。
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')

/** 真实价目表量级（约 $0.08 / 4 秒 720p），让成本报表在开发期就有数据 */
const MICRO_USD_PER_SECOND = 20_000

/** 随机失败时在这三种码之间轮换——覆盖可重试与不可重试两条路径 */
const FAILURE_MODES: readonly FailureCode[] = ['provider_error', 'timeout', 'content_filtered']

export interface MockProviderOptions {
  /** 0..1。默认 0.15——开发期不遇到失败，重试逻辑就等于没测过 */
  failureRate?: number
  /** 同 seed 返回同一条 fixture 且不随机失败，用于快照测试与 e2e */
  deterministic?: boolean
  /** 延迟缩放。CI 里设 0.05 把几十秒压到一两秒 */
  latencyScale?: number
}

interface MockJob {
  readonly req: GenerationRequest
  readonly startedAt: number
  readonly durationMs: number
  /** null = 这次会成功 */
  readonly failWith: FailureCode | null
  cancelled: boolean
}

/** 32 位整数哈希，用于确定性模式下从 seed 派生稳定的伪随机 */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 0xffffffff
}

/**
 * 按 ComfyUI 的真实形状排阶段（09 §2.3）。
 *
 * 前 20% 记为 loading_model：真机上首次加载 14B 权重要 60–90 秒，这段时间
 * 百分比几乎不动。mock 里照这个形状走，是为了让界面在 M0 就被这个「0% 停很久」
 * 的场景压过一遍，而不是等 M2 接上 GPU 才发现进度条读起来像挂了。
 */
function mockStage(frac: number): GenStage {
  if (frac < 0.2) return 'loading_model'
  if (frac < 0.8) return 'denoising'
  if (frac < 0.95) return 'decoding'
  return 'uploading'
}

export class MockProvider implements VideoProvider {
  readonly id = 'mock'

  readonly capabilities: ProviderCapabilities = {
    modes: ['t2v', 'i2v', 'ref2v', 'extend'],
    maxDurationSec: 10,
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: ['9:16', '16:9', '1:1'],
    maxRefImages: 4,
    supportsSeed: true,
    supportsNegative: true,
    supportsFirstLastFrame: true,
    supportsAudio: false,
    /** 无服务端过滤：mature 内容的路由规则要能选中它（04 §5 规则 2） */
    serverSideContentFilter: false,
    maxConcurrent: 16,
    costModel: { unit: 'per_second', microUsdPerUnit: MICRO_USD_PER_SECOND },
  }

  /** requestId → job。幂等的载体：同 requestId 重复提交拿回同一个 */
  private readonly jobs = new Map<string, MockJob>()

  private readonly failureRate: number
  private readonly deterministic: boolean
  private readonly latencyScale: number

  constructor(opts: MockProviderOptions = {}) {
    this.failureRate = opts.failureRate ?? 0.15
    this.deterministic = opts.deterministic ?? false
    this.latencyScale = opts.latencyScale ?? 1
  }

  /** 从环境变量构造，与 registry 保持同一套默认值 */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): MockProvider {
    // exactOptionalPropertyTypes 下不能显式传 undefined——没配就整个不传，
    // 让构造函数的默认值生效，而不是用 undefined 覆盖掉它
    const rate = env['MOCK_FAILURE_RATE']
    const scale = env['MOCK_LATENCY_SCALE']
    return new MockProvider({
      ...(rate === undefined ? {} : { failureRate: Number(rate) }),
      ...(scale === undefined ? {} : { latencyScale: Number(scale) }),
      deterministic: env['MOCK_SEED_DETERMINISTIC'] === '1',
    })
  }

  /** 提交前检查。**不得有任何 IO**——能力不匹配要在花钱之前挡掉（04 §7） */
  validate(req: GenerationRequest): ValidationResult {
    const c = this.capabilities
    if (!c.modes.includes(req.mode)) return { ok: false, reason: `不支持 mode=${req.mode}` }
    if (req.durationSec > c.maxDurationSec)
      return { ok: false, reason: `时长 ${req.durationSec}s 超过上限 ${c.maxDurationSec}s` }
    if (!c.resolutions.includes(req.resolution)) return { ok: false, reason: `不支持 ${req.resolution}` }
    if (!c.aspectRatios.includes(req.aspectRatio)) return { ok: false, reason: `不支持 ${req.aspectRatio}` }
    if (req.refImages.length > c.maxRefImages)
      return { ok: false, reason: `参考图 ${req.refImages.length} 张超过上限 ${c.maxRefImages}` }
    return { ok: true }
  }

  estimateCost(req: GenerationRequest): number {
    return Math.round(req.durationSec * MICRO_USD_PER_SECOND)
  }

  /**
   * 幂等：同 requestId 重复提交返回同一 handle，且**只计一次费**。
   * 崩溃恢复（05-job-orchestration.md §8）整个建立在这条上。
   */
  submit(req: GenerationRequest): Promise<ProviderHandle> {
    const existing = this.jobs.get(req.requestId)
    if (existing) return Promise.resolve(this.handleOf(existing))

    const v = this.validate(req)
    if (!v.ok) return Promise.reject(new Error(`能力不匹配，未提交：${v.reason}`))

    // 确定性模式下随机源来自 seed；否则真随机
    const roll = this.deterministic ? hash(`${req.seed ?? 0}:${req.requestId}`) : Math.random()

    // providerParams 逃生舱：e2e 用它做确定性失败注入，不依赖 15% 的骰子
    const injected = (req.providerParams as { mock?: { failFirstAttempt?: string } }).mock?.failFirstAttempt
    const failWith = injected
      ? (FailureCode.parse(injected) as FailureCode)
      : !this.deterministic && roll < this.failureRate
        ? (FAILURE_MODES[Math.floor(roll * 1000) % FAILURE_MODES.length] ?? 'provider_error')
        : null

    const job: MockJob = {
      req,
      startedAt: Date.now(),
      // 模拟真实延迟：durationSec × 8s ± 30%
      durationMs: req.durationSec * 8000 * (0.7 + roll * 0.6) * this.latencyScale,
      failWith,
      cancelled: false,
    }
    this.jobs.set(req.requestId, job)
    return Promise.resolve(this.handleOf(job))
  }

  poll(handle: ProviderHandle): Promise<PollOutcome> {
    const job = this.jobs.get(handle.externalId)
    if (!job) {
      const f: ProviderFailure = {
        status: 'failed',
        code: 'provider_error',
        message: `未知任务 ${handle.externalId}`,
        retryable: false,
      }
      return Promise.resolve(f)
    }

    if (job.cancelled) {
      const f: ProviderFailure = {
        status: 'failed',
        code: 'cancelled',
        message: '任务已取消',
        retryable: false,
      }
      return Promise.resolve(f)
    }

    const elapsed = Date.now() - job.startedAt
    if (elapsed < job.durationMs) {
      const frac = elapsed / job.durationMs
      return Promise.resolve({
        status: 'running' as const,
        progressPct: Math.min(99, Math.round(frac * 100)),
        etaMs: Math.max(0, Math.round(job.durationMs - elapsed)),
        stage: mockStage(frac),
      })
    }

    if (job.failWith) {
      const f: ProviderFailure = {
        status: 'failed',
        code: job.failWith,
        message: `mock 注入的失败：${job.failWith}`,
        // content_filtered 同 prompt 必然再被拒（05 §5.3）
        retryable: job.failWith !== 'content_filtered',
        /*
         * **失败也计费**，跟真 provider 一样——算力已经消耗掉了。
         *
         * 唯一的例外是被内容策略挡下的：那是提交后立刻拒，没有真的跑推理，
         * 多数厂商也不收这笔。这个区分不是装饰——它让「哪些失败该记账」这条
         * 逻辑在 mock 上就能被真实触发，而不是等接上真账单才第一次执行。
         */
        ...(job.failWith === 'content_filtered' ? {} : { costMicroUsd: this.estimateCost(job.req) }),
      }
      return Promise.resolve(f)
    }

    return Promise.resolve(this.resultOf(job))
  }

  cancel(handle: ProviderHandle): Promise<void> {
    const job = this.jobs.get(handle.externalId)
    if (job) job.cancelled = true
    return Promise.resolve()
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({ ok: true, queueDepth: this.jobs.size, detail: 'mock 永远健康' })
  }

  private handleOf(job: MockJob): ProviderHandle {
    return { providerId: this.id, externalId: job.req.requestId, submittedAt: job.startedAt }
  }

  private resultOf(job: MockJob): GenerationResult {
    const { req } = job
    const [w, h] = { '9:16': [480, 854], '16:9': [854, 480], '1:1': [480, 480] }[req.aspectRatio] as [
      number,
      number,
    ]
    return {
      status: 'succeeded',
      outputUrl: fixturePathFor(req),
      durationSec: req.durationSec,
      widthPx: w,
      heightPx: h,
      fps: req.fps,
      seedUsed: req.seed ?? Math.floor(hash(req.requestId) * 2 ** 31),
      costMicroUsd: this.estimateCost(req),
      providerMeta: { mock: true, fixture: fixturePathFor(req), costEstimated: true },
    }
  }
}

/**
 * 按 shotType 选 fixture。请求里没有 shotType（那是叙事层的概念，
 * provider 契约不该知道），所以从 prompt 里找景别关键词，找不到退回 ms。
 */
export function fixturePathFor(req: GenerationRequest): string {
  const kinds = ['establishing', 'ecu', 'ots', 'pov', 'cu', 'ms', 'ws'] as const
  const p = req.prompt.toLowerCase()
  const kind = kinds.find((k) => new RegExp(`\\b${k}\\b`).test(p)) ?? 'ms'
  const path = join(FIXTURES, `${kind}.mp4`)
  return existsSync(path) ? path : join(FIXTURES, 'ms.mp4')
}
