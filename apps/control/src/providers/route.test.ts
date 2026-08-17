import type { GenerationRequest, ProviderCapabilities, VideoProvider } from '@ai-drama/contracts'
import { describe, expect, it } from 'vitest'
import { routeProvider } from './route.js'

/**
 * 路由器是**纯同步零 IO** 的，所以这一套是单测而不是集成测试——
 * 它能穷举，不必打真实依赖。这也是把它从 `applyTransition` 里拆出来的理由：
 * 混在事务里的话，「选谁」这个决策就只能靠跑一遍真实链路来验。
 */

const caps = (over: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  modes: ['t2v'],
  maxDurationSec: 10,
  resolutions: ['720p'],
  aspectRatios: ['9:16'],
  maxRefImages: 4,
  supportsSeed: true,
  supportsNegative: true,
  supportsFirstLastFrame: true,
  supportsAudio: false,
  serverSideContentFilter: false,
  maxConcurrent: 8,
  costModel: { unit: 'per_second', microUsdPerUnit: 20_000 },
  ...over,
})

/** 只实现路由器真正会碰的三样：id / modelId / validate */
function fake(id: string, ok = true, over: Partial<ProviderCapabilities> = {}): VideoProvider {
  return {
    id,
    modelId: `${id}-v1`,
    capabilities: caps(over),
    validate: () => (ok ? { ok: true } : { ok: false, reason: '能力不匹配' }),
    estimateCost: () => 80_000,
    submit: () => Promise.reject(new Error('路由器不该调它')),
    poll: () => Promise.reject(new Error('路由器不该调它')),
    cancel: () => Promise.resolve(),
    health: () => Promise.resolve({ ok: true }),
  }
}

const probe = {
  requestId: '00000000-0000-4000-8000-000000000000',
  shotId: '00000000-0000-4000-8000-000000000001',
  mode: 't2v',
  prompt: '',
  refImages: [],
  durationSec: 4,
  resolution: '720p',
  aspectRatio: '9:16',
  fps: 24,
  safetyProfile: 'standard',
  priority: 'normal',
  providerParams: {},
} as GenerationRequest

const ctx = (over: Partial<Parameters<typeof routeProvider>[1]> = {}) => ({
  providerHint: null,
  filteredBy: [],
  probe,
  ...over,
})

describe('Provider 路由器（04 §5 的第 1、3 步）', () => {
  it('空池返回 null，而不是抛', () => {
    expect(routeProvider([], ctx())).toBeNull()
  })

  it('没有一个能力匹配时返回 null——调用方据此回 NO_PROVIDER 而不是硬提交', () => {
    expect(routeProvider([fake('a', false), fake('b', false)], ctx())).toBeNull()
  })

  it('只有一个候选时直接用它', () => {
    expect(routeProvider([fake('a')], ctx())).toMatchObject({
      provider: { id: 'a' },
      reason: 'only-candidate',
    })
  })

  // ── 第 1 步：硬约束 ──

  it('providerHint 优先于池的顺序——人工指定压过一切自动决策', () => {
    const r = routeProvider([fake('a'), fake('b')], ctx({ providerHint: 'b' }))
    expect(r).toMatchObject({ provider: { id: 'b' }, reason: 'hint' })
  })

  /**
   * hint 指向一个做不到的 provider 时**落回自动路由**，而不是判死。
   *
   * 把它当硬失败的话，一个过期的 hint（比如镜头时长改长了、原来那家做不到）
   * 会永久卡死这个镜头，而人在界面上看不出是 hint 的问题。
   */
  it('hint 能力不匹配时落回自动路由，不卡死镜头', () => {
    const r = routeProvider([fake('a'), fake('bad', false)], ctx({ providerHint: 'bad' }))
    expect(r).toMatchObject({ provider: { id: 'a' } })
  })

  it('hint 指向池外的 id 时同样落回自动路由', () => {
    const r = routeProvider([fake('a')], ctx({ providerHint: 'not-in-pool' }))
    expect(r).toMatchObject({ provider: { id: 'a' } })
  })

  it('能力不匹配的被筛掉，哪怕它排在前面', () => {
    const r = routeProvider([fake('bad', false), fake('good')], ctx())
    expect(r).toMatchObject({ provider: { id: 'good' } })
  })

  // ── 第 3 步：失败规避 ──

  /**
   * content_filtered 是不可重试的（05 §5.3）——同 prompt 在同一家必然再被拒。
   * 所以不是降权，是排到最后。
   */
  it('在某家被 content_filtered 过就避开它', () => {
    const r = routeProvider([fake('a'), fake('b')], ctx({ filteredBy: ['a'] }))
    expect(r).toMatchObject({ provider: { id: 'b' }, reason: 'preferred' })
  })

  it('全都被过滤过时仍要给一个，并标明这是回退', () => {
    const r = routeProvider([fake('a'), fake('b')], ctx({ filteredBy: ['a', 'b'] }))
    expect(r).toMatchObject({ reason: 'fallback-after-filtered' })
    expect(r?.provider.id).toBe('a')
  })

  it('失败历史里的 provider 已不在池中时不影响选择', () => {
    const r = routeProvider([fake('a')], ctx({ filteredBy: ['gone'] }))
    expect(r).toMatchObject({ provider: { id: 'a' } })
  })

  // ── 池的顺序（DEFAULT_PROVIDER 决定谁排第一，见 registry.ts）──

  it('无 hint 无失败历史时取池的第一个', () => {
    const r = routeProvider([fake('first'), fake('second')], ctx())
    expect(r?.provider.id).toBe('first')
  })
})
