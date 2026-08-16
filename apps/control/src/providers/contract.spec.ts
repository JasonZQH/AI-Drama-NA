import type { GenerationRequest, VideoProvider } from '@ai-drama/contracts'
import { GenerationRequest as GenReq } from '@ai-drama/contracts'
import { describe, expect, it } from 'vitest'
import { MockProvider } from './mock.js'

/**
 * Provider 契约测试套件（04-provider-adapter.md §7）。
 *
 * **每个新 provider 必须通过这同一套。** 所以它是一个可复用的函数，不是
 * 只测 mock 的一次性脚本——Vidu / Kling / SelfHost 接入时直接 `runContractSuite(new ViduProvider(...))`。
 *
 * 云 provider 届时用录制回放跑（nock/msw），CI 不烧真钱。
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export function makeRequest(over: Partial<GenerationRequest> = {}): GenerationRequest {
  return GenReq.parse({
    requestId: uuid(1),
    shotId: uuid(2),
    mode: 't2v',
    prompt: 'a woman looks up at the door, cu',
    durationSec: 4,
    resolution: '720p',
    aspectRatio: '9:16',
    ...over,
  })
}

/** 把 provider 的进度推到终态。mock 用假时钟，真 provider 用轮询 */
async function drain(p: VideoProvider, handle: Awaited<ReturnType<VideoProvider['submit']>>, maxMs = 5000) {
  const deadline = Date.now() + maxMs
  for (;;) {
    const r = await p.poll(handle)
    if (r.status !== 'running' && r.status !== 'submitted') return r
    if (Date.now() > deadline) throw new Error('轮询超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

export function runContractSuite(name: string, make: () => VideoProvider): void {
  describe(`Provider 契约 · ${name}`, () => {
    it('幂等提交：同 requestId 连提两次，externalId 相同', async () => {
      const p = make()
      const req = makeRequest()
      const a = await p.submit(req)
      const b = await p.submit(req)
      expect(b.externalId).toBe(a.externalId)
      expect(b.submittedAt).toBe(a.submittedAt) // 只计一次费的可观测代理
    })

    it('能力声明一致：声明支持的每种 mode 都能真实提交成功', async () => {
      const p = make()
      for (const [i, mode] of p.capabilities.modes.entries()) {
        const req = makeRequest({ requestId: uuid(100 + i), mode })
        await expect(p.submit(req)).resolves.toMatchObject({ providerId: p.id })
      }
    })

    it('超能力请求：validate 拒绝，且不发起任何调用', async () => {
      const p = make()
      const tooLong = makeRequest({ durationSec: p.capabilities.maxDurationSec + 1 })

      const v = p.validate(tooLong)
      expect(v.ok).toBe(false)

      // 「不发起网络调用」的可观测证据：被拒的请求不会在 provider 内留下任何痕迹
      const before = (await p.health()).queueDepth
      p.validate(tooLong)
      expect((await p.health()).queueDepth).toBe(before)
    })

    it('取消：提交后立即 cancel，终态为 cancelled', async () => {
      const p = make()
      const handle = await p.submit(makeRequest({ requestId: uuid(3) }))
      await p.cancel(handle)
      const r = await drain(p, handle)
      expect(r.status).toBe('failed')
      if (r.status === 'failed') expect(r.code).toBe('cancelled')
    })

    it('错误映射：content_filtered 必须标为不可重试', async () => {
      const p = make()
      const handle = await p.submit(
        makeRequest({
          requestId: uuid(4),
          providerParams: { mock: { failFirstAttempt: 'content_filtered' } },
        }),
      )
      const r = await drain(p, handle)
      expect(r.status).toBe('failed')
      if (r.status === 'failed') {
        expect(r.code).toBe('content_filtered')
        // 同 prompt 重试必然再被拒，纯烧配额（05 §5.3）
        expect(r.retryable).toBe(false)
      }
    })

    it('错误映射：provider_error 是可重试的', async () => {
      const p = make()
      const handle = await p.submit(
        makeRequest({
          requestId: uuid(5),
          providerParams: { mock: { failFirstAttempt: 'provider_error' } },
        }),
      )
      const r = await drain(p, handle)
      if (r.status === 'failed') expect(r.retryable).toBe(true)
    })

    it('成本非空：成功结果的 costMicroUsd > 0', async () => {
      const p = make()
      const handle = await p.submit(makeRequest({ requestId: uuid(6) }))
      const r = await drain(p, handle)
      expect(r.status).toBe('succeeded')
      if (r.status === 'succeeded') {
        // 宁可要估算值也不要 null——null 会让整张成本报表失真（04 §2）
        expect(r.costMicroUsd).toBeGreaterThan(0)
      }
    })

    it('事前估算与事后计费同量级（dryRun 预算闸门靠它）', async () => {
      const p = make()
      const req = makeRequest({ requestId: uuid(7) })
      const est = p.estimateCost(req)
      const r = await drain(p, await p.submit(req))
      if (r.status === 'succeeded') {
        expect(Math.abs(r.costMicroUsd - est) / est).toBeLessThan(0.2) // M1 验收要求误差 <20%
      }
    })

    it('health 可用，路由器据此摘除故障 provider', async () => {
      await expect(make().health()).resolves.toMatchObject({ ok: expect.any(Boolean) })
    })
  })
}

// 延迟压到 0，让契约测试跑得快；失败率归零，避免随机干扰断言
const fast = () => new MockProvider({ latencyScale: 0, failureRate: 0 })

runContractSuite('MockProvider', fast)
