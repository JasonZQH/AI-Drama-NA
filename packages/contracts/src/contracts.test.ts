import { describe, expect, it } from 'vitest'
import {
  ContentTier,
  FailureCode,
  GenerationRequest,
  RETRYABLE,
  ShotIntent,
  StudioEvent,
  isRetryable,
} from './index.js'

const UUID = '00000000-0000-4000-8000-000000000000'

describe('重试分类（05-job-orchestration.md §5.3）', () => {
  it('四种失败不可重试——重试它们只会烧配额、掩盖 bug、或重复计费', () => {
    expect(isRetryable('content_filtered')).toBe(false)
    expect(isRetryable('quota_exceeded')).toBe(false)
    expect(isRetryable('invalid_output')).toBe(false)
    // 提交结果未知时自动重投 = 可能的二次计费，必须停下来交给人
    expect(isRetryable('submit_unknown')).toBe(false)
  })

  it('可重试名单是白名单，逐条列全', () => {
    expect([...RETRYABLE]).toEqual([
      'provider_error',
      'timeout',
      'download_failed',
      'eval_rejected',
      'cancelled',
    ])
    for (const c of RETRYABLE) expect(isRetryable(c)).toBe(true)
  })

  /**
   * 这条是这组测试里唯一真正防退化的一条。
   *
   * 白名单的意义在于「新加的码默认不重试」，而不是「名单碰巧是对的」。
   * 上一版这里写的是 `options.filter(c => !NON_RETRYABLE.includes(c))`——
   * 它跟着黑名单一起变，任何新码加进来都自动被断言成可重试，等于没测。
   */
  it('白名单之外的码一律不可重试，加新码不会默认变成花钱', () => {
    for (const c of FailureCode.options) {
      expect(isRetryable(c)).toBe(RETRYABLE.includes(c))
    }
  })
})

describe('GenerationRequest', () => {
  const minimal = {
    requestId: UUID,
    shotId: UUID,
    mode: 't2v' as const,
    prompt: 'a woman looks up at the door',
    durationSec: 4,
    resolution: '720p' as const,
    aspectRatio: '9:16' as const,
  }

  it('默认值补齐：fps / priority / safetyProfile / refImages / providerParams', () => {
    const r = GenerationRequest.parse(minimal)
    expect(r.fps).toBe(24)
    expect(r.priority).toBe('normal')
    expect(r.safetyProfile).toBe('standard')
    expect(r.refImages).toEqual([])
    expect(r.providerParams).toEqual({})
  })

  it('超出 provider 能力上限的时长被拒——这一步不该发起网络调用', () => {
    expect(() => GenerationRequest.parse({ ...minimal, durationSec: 16 })).toThrow()
  })

  it('参考图必须带 role，不能靠数组下标传语义', () => {
    expect(() =>
      GenerationRequest.parse({
        ...minimal,
        refImages: [{ url: 'https://example.test/a.png' }],
      }),
    ).toThrow()

    const ok = GenerationRequest.parse({
      ...minimal,
      refImages: [{ role: 'first_frame', url: 'https://example.test/a.png' }],
    })
    expect(ok.refImages[0]?.role).toBe('first_frame')
  })
})

describe('ShotIntent（03-pipeline.md §S3）', () => {
  it('action 太短会被拒——「站着」这类无法生成有效 prompt', () => {
    expect(() =>
      ShotIntent.parse({ shotType: 'cu', action: '站', durationSec: 4, characterNames: [] }),
    ).toThrow()
  })

  it('接受完成判据允许的边界：10 镜 × 90 秒 = 9 秒/镜', () => {
    const s = ShotIntent.parse({
      shotType: 'ws',
      action: 'establishing the rooftop',
      durationSec: 9,
      characterNames: [],
    })
    expect(s.durationSec).toBe(9)
  })
})

describe('StudioEvent 判别联合（05-job-orchestration.md §7）', () => {
  it('按 type 判别，负载形状各自校验', () => {
    const e = StudioEvent.parse({ type: 'batch.progress', episodeId: UUID, done: 18, total: 24, failed: 1 })
    expect(e.type).toBe('batch.progress')
  })

  it('拒绝形状不匹配的事件', () => {
    expect(() => StudioEvent.parse({ type: 'shot.status', shotId: UUID, status: 'nonexistent' })).toThrow()
  })
})

describe('三层分级（约束 C7）', () => {
  it('恰好三层，顺序为投放安全 → 商店安全 → 完整 TV-MA', () => {
    expect(ContentTier.options).toEqual(['L0', 'L1', 'L2'])
  })
})
