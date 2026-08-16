import { describe, expect, it } from 'vitest'
import { MockProvider, fixturePathFor } from './mock.js'
import { makeRequest } from './contract.spec.js'
import { buildProviderPool, resolveProvider } from './registry.js'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('MockProvider 特有行为', () => {
  it('默认 15% 失败率——开发期不遇到失败，重试逻辑就等于没测过', () => {
    expect(new MockProvider().capabilities.maxConcurrent).toBe(16)
    // 统计 200 次提交里的失败注入，验证量级在 15% 附近而非 0 或 100%
    const p = new MockProvider({ latencyScale: 0 })
    let failed = 0
    for (let i = 0; i < 200; i++) {
      void p.submit(makeRequest({ requestId: uuid(1000 + i) }))
    }
    // 通过 poll 统计终态
    return Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        p.poll({ providerId: 'mock', externalId: uuid(1000 + i), submittedAt: 0 }),
      ),
    ).then((rs) => {
      failed = rs.filter((r) => r.status === 'failed').length
      expect(failed).toBeGreaterThan(200 * 0.05)
      expect(failed).toBeLessThan(200 * 0.3)
    })
  })

  it('确定性模式：同 seed 同 fixture，且不随机失败', async () => {
    const p = new MockProvider({ deterministic: true, latencyScale: 0 })
    const a = await p.poll(await p.submit(makeRequest({ requestId: uuid(11), seed: 42 })))
    const b = await p.poll(await p.submit(makeRequest({ requestId: uuid(12), seed: 42 })))
    expect(a.status).toBe('succeeded')
    expect(b.status).toBe('succeeded')
  })

  it('providerParams 逃生舱可注入确定性失败——e2e 不靠 15% 的骰子', async () => {
    const p = new MockProvider({ failureRate: 0, latencyScale: 0 })
    const h = await p.submit(
      makeRequest({ requestId: uuid(13), providerParams: { mock: { failFirstAttempt: 'timeout' } } }),
    )
    const r = await p.poll(h)
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.code).toBe('timeout')
  })

  it('无服务端内容过滤——mature 内容的路由规则要能选中它（04 §5 规则 2）', () => {
    expect(new MockProvider().capabilities.serverSideContentFilter).toBe(false)
  })

  it('按 prompt 里的景别关键词选 fixture，找不到退回 ms', () => {
    expect(fixturePathFor(makeRequest({ prompt: 'the rooftop, establishing' }))).toContain('establishing.mp4')
    expect(fixturePathFor(makeRequest({ prompt: 'her eyes, ecu' }))).toContain('ecu.mp4')
    expect(fixturePathFor(makeRequest({ prompt: '没有景别关键词' }))).toContain('ms.mp4')
  })

  it('fixture 文件真实存在——否则「跑通全链路」是假的', async () => {
    const { existsSync } = await import('node:fs')
    for (const k of ['ecu', 'cu', 'ms', 'ws', 'establishing', 'ots', 'pov']) {
      expect(existsSync(fixturePathFor(makeRequest({ prompt: `x ${k}` }))), `${k}.mp4 缺失`).toBe(true)
    }
  })

  it('进度是真实推进的百分比，不是转圈（07-design-system.md R1）', async () => {
    const p = new MockProvider({ failureRate: 0, latencyScale: 1 })
    const h = await p.submit(makeRequest({ requestId: uuid(14), durationSec: 4 }))
    const r = await p.poll(h)
    expect(r.status).toBe('running')
    if (r.status === 'running') {
      expect(r.progressPct).toBeGreaterThanOrEqual(0)
      expect(r.etaMs).toBeGreaterThan(0)
    }
  })
})

describe('Provider 池（04 §6）', () => {
  it('无任何 key 时池里只有 mock——这是「无 GPU 无 key 跑通」的前提', () => {
    const pool = buildProviderPool({})
    expect(pool.map((p) => p.id)).toEqual(['mock'])
  })

  it('可按 id 取回', () => {
    const pool = buildProviderPool({})
    expect(resolveProvider(pool, 'mock')?.id).toBe('mock')
    expect(resolveProvider(pool, 'vidu')).toBeUndefined()
  })

  it('从环境变量读配置', () => {
    const p = MockProvider.fromEnv({ MOCK_SEED_DETERMINISTIC: '1', MOCK_FAILURE_RATE: '0' })
    expect(p.id).toBe('mock')
  })
})
