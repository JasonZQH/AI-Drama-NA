import { describe, expect, it } from 'vitest'
import {
  ContentTier,
  FailureCode,
  GenerationRequest,
  NON_RETRYABLE,
  ShotIntent,
  StudioEvent,
  isRetryable,
} from './index.js'

const UUID = '00000000-0000-4000-8000-000000000000'

describe('重试分类（05-job-orchestration.md §5.3）', () => {
  it('三种失败不可重试——重试它们只会烧配额或掩盖 bug', () => {
    expect(isRetryable('content_filtered')).toBe(false)
    expect(isRetryable('quota_exceeded')).toBe(false)
    expect(isRetryable('invalid_output')).toBe(false)
  })

  it('其余失败可重试', () => {
    const retryable = FailureCode.options.filter((c) => !NON_RETRYABLE.includes(c))
    expect(retryable).toEqual(['provider_error', 'timeout', 'download_failed', 'eval_rejected', 'cancelled'])
    for (const c of retryable) expect(isRetryable(c)).toBe(true)
  })

  it('分类覆盖全部失败码，没有漏网的', () => {
    for (const c of FailureCode.options) expect(typeof isRetryable(c)).toBe('boolean')
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
