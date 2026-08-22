import type { GenMode, GenerationRequest, VideoProvider } from '@ai-drama/contracts'
import { GenerationRequest as GenReq } from '@ai-drama/contracts'
import { describe, expect, it } from 'vitest'
import { pollDelayMs } from '../queue/queues.js'

/**
 * Provider 契约测试套件（04-provider-adapter.md §7）。
 *
 * **每个新 provider 必须通过这同一套。** 所以它是一个可复用的函数，不是
 * 只测 mock 的一次性脚本——OpenRouter / SelfHost 接入时直接
 * `runContractSuite('openrouter:...', () => new OpenRouterProvider(...))`。
 *
 * 文件名不带 `.spec` / `.test` 是刻意的：vitest 的默认 include 会收集
 * `**\/*.{test,spec}.*`，而本文件只导出函数、不自注册。此前它叫
 * `contract.spec.ts` 并在末尾自己调了一次 `runContractSuite`，于是
 * `mock.test.ts` 里那句 `import { makeRequest } from './contract.spec.js'`
 * 会把整个 describe 再注册进**那个**文件的树里——整套用例跑两遍。
 *
 * ## 一次跑完要花多少钱
 *
 * 对真 provider，**只有 3 条会真的提交**（幂等 1 次、取消 1 次、成本 1 次），
 * 且都在同一个 model 实例上。这个数字是设计出来的，不是碰巧：
 *
 * - 「能力声明一致」只调 `validate()`——契约规定它零 IO（04 §7）。用提交去
 *   证明「声明的 mode 真能用」，代价是每个 mode 一次弃单计费（mock 声明 4 种，
 *   OpenRouter 3 种，再乘以池里的 model 条目数），而它证明的东西还更弱：
 *   submit 成功不等于那个 mode 能产出合法结果。
 * - 「成本非空」与「估算误差 <20%」合并成一条：它们是同一次观测的两个断言，
 *   拆开就是白白多提交一次。
 */

/** 参考图 URL 只进 validate，永远不会被取——example.com 是 IANA 保留域 */
const REF_IMAGE_URL = 'https://example.com/ref.png'

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

/**
 * 某个 mode 的最小合法请求。
 *
 * t2v 之外的三种都要参考图，且 role 不同——`RefImage.role` 是语义角色而不是
 * 数组下标，正是为了让这里能说清「第一帧」和「角色参考」不是一回事（04 §4）。
 */
export function makeRequestForMode(mode: GenMode, over: Partial<GenerationRequest> = {}): GenerationRequest {
  const role = { i2v: 'first_frame', ref2v: 'character', extend: 'last_frame' } as const
  return makeRequest({
    mode,
    ...(mode === 't2v' ? {} : { refImages: [{ role: role[mode], url: REF_IMAGE_URL }] }),
    ...over,
  })
}

export interface ContractSuiteOptions {
  /**
   * 单条用例的上限，同时也是 `drain()` 的 deadline。**两者必须一起拧。**
   *
   * 只调 drain 是没用的：vitest 的 `testTimeout` 默认就是 5000ms，把 deadline
   * 调到 15 分钟只会让 `it()` 先被杀掉——而此时 submit 已经计过费了。
   *
   * mock 用默认值；真 provider 传一个和它真实生成时长同量级的数（分钟级）。
   */
  readonly timeoutMs?: number
  /**
   * provider 的 cancel 是否真的能停下一个已提交的任务。
   *
   * 传 false 时「取消」那条只断言 `cancel()` 不抛，不再 drain 到终态。这不是
   * 放水：某些厂商压根没有 cancel 端点（OpenRouter 的文档里就没有），此时
   * cancel 是永久 no-op，硬断言 `failed` 会让任务一路跑到成功——一条红用例
   * 外加一次完整的计费生成。编排层对这种 provider 另有对策（超时后不立刻
   * 开下一次 attempt，否则两个任务同时计费）。
   */
  readonly cancelEffective?: boolean
}

/**
 * 把 provider 的进度推到终态。
 *
 * 轮询间隔复用生产的退避曲线（3s → 30s），不要用固定的几十毫秒：15 分钟的
 * deadline 配 10ms 间隔是单条用例 9 万次 GET，对真 provider 就是一台限流机器。
 * mock 在 `latencyScale: 0` 下首次 poll 就是终态，一次都不会 sleep。
 */
async function drain(p: VideoProvider, handle: Awaited<ReturnType<VideoProvider['submit']>>, maxMs: number) {
  const deadline = Date.now() + maxMs
  for (let n = 0; ; n++) {
    const r = await p.poll(handle)
    if (r.status !== 'running' && r.status !== 'submitted') return r
    if (Date.now() > deadline) throw new Error(`轮询超过 ${maxMs}ms 仍未终态`)
    await new Promise((res) => setTimeout(res, Math.min(pollDelayMs(n), Math.max(0, deadline - Date.now()))))
  }
}

export function runContractSuite(
  name: string,
  make: () => VideoProvider,
  opts: ContractSuiteOptions = {},
): void {
  const timeoutMs = opts.timeoutMs ?? 5000
  const cancelEffective = opts.cancelEffective ?? true

  // 多给 vitest 5 秒余量，好让 drain 自己那条「轮询超过 Nms 仍未终态」先抛出来。
  // 否则 15 分钟后看到的是 "Test timed out"，读不出到底是卡在 poll 还是卡在 submit
  describe(`Provider 契约 · ${name}`, { timeout: timeoutMs + 5_000 }, () => {
    it('幂等提交：同 requestId 连提两次，externalId 相同', async () => {
      const p = make()
      const req = makeRequest()
      const a = await p.submit(req)
      const b = await p.submit(req)
      expect(b.externalId).toBe(a.externalId)
      expect(b.submittedAt).toBe(a.submittedAt) // 只计一次费的可观测代理
    })

    /**
     * 声明的每种 mode 都要真的能通过自己的 validate。
     *
     * 这条挡的是「capabilities 里写了 i2v，validate 却拒绝所有 i2v 请求」——
     * 路由器只看 `validate(probe).ok`（route.ts），声明与实现不一致时它会把
     * 镜头路由过来，然后在 orchestrator 的 validate 处失败并白烧一次 attempt。
     *
     * 用 validate 而不是 submit，见文件头的成本说明。
     */
    it('能力声明一致：声明支持的每种 mode 都能通过自己的 validate', () => {
      const p = make()
      expect(p.capabilities.modes.length).toBeGreaterThan(0)
      for (const [i, mode] of p.capabilities.modes.entries()) {
        const v = p.validate(makeRequestForMode(mode, { requestId: uuid(100 + i) }))
        expect(v, `声明支持 ${mode} 但 validate 拒绝了它`).toMatchObject({ ok: true })
      }
    })

    it('超能力请求：validate 拒绝', () => {
      const p = make()
      const v = p.validate(makeRequest({ durationSec: p.capabilities.maxDurationSec + 1 }))
      expect(v.ok).toBe(false)
    })

    /**
     * **时长下限也要是真的。**
     *
     * 契约一度只建模天花板，而咬人的是地板：seedance 全系最短 4 秒，分镜规划
     * 2 秒不会报错，`snapDuration` 静默抬到 4 秒——片子按 4 秒出、钱按 4 秒付，
     * 而整集是按 2 秒那份计划算的。真机实测目标 30 秒的一集出了 44.5 秒成片。
     *
     * 这一条盯的是「下限确实是这家能接的最短值」：`minDurationSec` 本身要能过
     * `validate`，而适配器声明的下限如果取错了端（拿上限当下限），这条就红。
     */
    it('minDurationSec 是真能产出的最短时长，且不大于上限', () => {
      const p = make()
      const { minDurationSec: lo, maxDurationSec: hi } = p.capabilities
      expect(lo, `下限 ${lo} 比上限 ${hi} 还大——多半是取错了端`).toBeLessThanOrEqual(hi)
      expect(lo, '下限得是个正数').toBeGreaterThan(0)
      expect(
        p.validate(makeRequest({ durationSec: lo })),
        `声明最短 ${lo} 秒，validate 却拒绝了它`,
      ).toMatchObject({ ok: true })
    })

    /*
     * 此处曾有一条「不发起网络调用」的断言，用 health().queueDepth 前后比对来
     * 证明。删掉的原因有两个：`queueDepth` 在契约里是 optional，云适配器不填
     * 时整条退化成 expect(undefined).toBe(undefined)；而它自己要发两次 health
     * 请求才能完成这次「证明」。真正的证据是 test 车道的出网拦截
     * （vitest.setup.ts）——validate 里真有 IO 的话那里会直接抛。
     */

    it('取消：提交后立即 cancel', async () => {
      const p = make()
      const handle = await p.submit(makeRequest({ requestId: uuid(3) }))
      await expect(p.cancel(handle)).resolves.toBeUndefined()
      if (!cancelEffective) return

      const r = await drain(p, handle, timeoutMs)
      expect(r.status).toBe('failed')
      if (r.status === 'failed') expect(r.code).toBe('cancelled')
    })

    /**
     * 成功结果的成本必须非空，且与事前估算同量级。
     *
     * 两条断言共用一次提交。非空是 M1 验收第 1 条（成本正确回填）——宁可要
     * 估算值也不要 null，null 会让整张成本报表失真（04 §2）；同量级是第 2 条，
     * dryRun 的预算闸门靠 estimateCost 拦人，它和实际扣费差一个数量级的话
     * 闸门就是摆设。
     */
    it('成功结果：成本非空，且与事前估算误差 <20%', async () => {
      const p = make()
      const req = makeRequest({ requestId: uuid(6) })
      const est = p.estimateCost(req)
      expect(est).toBeGreaterThan(0)

      const r = await drain(p, await p.submit(req), timeoutMs)
      expect(r.status).toBe('succeeded')
      if (r.status !== 'succeeded') return
      expect(r.costMicroUsd).toBeGreaterThan(0)
      expect(Math.abs(r.costMicroUsd - est) / est).toBeLessThan(0.2)
    })

    it('health 可用，路由器据此摘除故障 provider', async () => {
      await expect(make().health()).resolves.toMatchObject({ ok: expect.any(Boolean) })
    })
  })
}

/**
 * 错误映射的三条，**只有 mock 能跑**。
 *
 * 它们靠 `providerParams.mock.failFirstAttempt` 确定性地注入失败，而读这个
 * 字段的只有 `mock.ts` 一处。此前这三条和其余用例混在同一个 `runContractSuite`
 * 里，于是任何真 provider 注册进来都会：两条硬断言 `failed` 直接红（它其实
 * 成功了，还烧掉两次生成），一条断言裹在 `if (r.status === 'failed')` 里变成
 * 零断言的假绿。
 *
 * 拆成两个导出比加一个注入钩子更省：钩子要 options 形状 + `it.skip` 分支，
 * 而 M1 内不会有第二个实现——云适配器物理上注册不进这半套，这就够了。
 * 将来若某个云 provider 能用某条「毒 prompt」稳定触发 content_filtered，
 * 那是往通用套件里加一个常量，不是加一个回调。
 */
export function runMockFailureSuite(name: string, make: () => VideoProvider): void {
  describe(`Provider 契约 · ${name} · 错误映射（注入失败）`, () => {
    const inject = (n: number, code: string) =>
      makeRequest({ requestId: uuid(n), providerParams: { mock: { failFirstAttempt: code } } })

    it('content_filtered 必须标为不可重试', async () => {
      const p = make()
      const r = await drain(p, await p.submit(inject(4, 'content_filtered')), 5000)
      expect(r.status).toBe('failed')
      if (r.status !== 'failed') return
      expect(r.code).toBe('content_filtered')
      // 同 prompt 重试必然再被拒，纯烧配额（05 §5.3）
      expect(r.retryable).toBe(false)
    })

    it('provider_error 是可重试的', async () => {
      const p = make()
      const r = await drain(p, await p.submit(inject(5, 'provider_error')), 5000)
      // 断言不在 if 里：此前是 `if (r.status === 'failed') expect(...)`，
      // 注入没生效时整条用例零断言通过
      expect(r.status).toBe('failed')
      if (r.status !== 'failed') return
      expect(r.retryable).toBe(true)
    })

    /**
     * 失败也要能记账。
     *
     * 真 provider 对失败、超时、取消的生成照样计费——算力已经消耗。适配器
     * 知道就填 `costMicroUsd`，不知道就留空由编排层估算。这条只要求「字段
     * 存在时必须是合法的非负整数」，不强求一定要填：有些失败（提交即被内容
     * 策略拒绝）确实不计费，硬性要求填会逼适配器编数字。
     *
     * 它挡的是另一件事——填了一个负数、小数、或 0 之外的假值。
     */
    it('失败结果若报成本，必须是合法的非负整数微美元', async () => {
      const p = make()
      const r = await drain(p, await p.submit(inject(8, 'provider_error')), 5000)
      expect(r.status).toBe('failed')
      if (r.status !== 'failed' || r.costMicroUsd === undefined) return
      expect(Number.isInteger(r.costMicroUsd)).toBe(true)
      expect(r.costMicroUsd).toBeGreaterThanOrEqual(0)
    })
  })
}
