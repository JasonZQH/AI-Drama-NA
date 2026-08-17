import type { GenerationRequest, VideoProvider } from '@ai-drama/contracts'

/**
 * Provider 路由器（04-provider-adapter.md §5）。
 *
 * 04 §5 定义了五步决策，**M1 只落地第 1、3 步**，另外三步现在没有对象：
 *
 * | 步骤 | M1 | 为什么 |
 * |---|---|---|
 * | 1 硬约束过滤 | ✅ | `shots.provider_hint` 已存在且零读取，免费的一半 |
 * | 2 mature 只路由到无服务端过滤的 | ❌ | 池里没有自部署。留位置，issue #15 |
 * | 3 失败规避 | ✅ | 在某家被 content_filtered 过就排到最后 |
 * | 4 统计排序（usd_per_accepted）| ❌ | 依赖不存在的物化视图，且样本不足 30 必走退化分支——M1 期间 100% 如此 |
 * | 5 预算闸门 | ✅ | 已在 `pipeline/applyTransition.ts` 下沉到唯一花钱入口，这里不重复 |
 *
 * **不建 `RoutingContext` / `ProviderPriors` / 物化视图**：第 4 步在 M1 期间必然
 * 只返回「固定优先级」，给一个不存在的输入建统计管道是纯浪费。等真跑出样本再说。
 *
 * 这个函数**纯同步、零 IO**：`validate` 本来就不许有 IO（04 §7），失败历史由调用方
 * 从库里查好传进来。所以它能被单测穷举，不必打真实依赖。
 */

export interface RoutingContext {
  /** `shots.provider_hint`。非空且在池里就直接用它——人工指定优先于一切自动决策 */
  readonly providerHint: string | null
  /** 本镜此前在**哪些 provider** 上被 content_filtered 过。它们排到最后 */
  readonly filteredBy: readonly string[]
  /** 用来跑 `validate()` 的探针请求。真实请求还没构造，但能力约束已经确定 */
  readonly probe: GenerationRequest
}

export interface RoutingResult {
  readonly provider: VideoProvider
  /** 为什么选它。落进日志与 Ledger，出问题时不用猜 */
  readonly reason: 'hint' | 'only-candidate' | 'preferred' | 'fallback-after-filtered'
}

/**
 * 从池里挑一个 provider。池空、或没有一个能力匹配时返回 null。
 *
 * **健康检查刻意不做。** 04 §5 第 1 步含「筛掉 health() 不健康的」，但主动探测意味着
 * 每次路由决策一次网络调用，而池里只有一个 provider 时它挡不掉任何东西。真要做也
 * 不该是主动探测——用 Redis 里的 per-provider 连续失败计数（`queue/semaphore.ts`
 * 有现成的计数器模式），由已经在发生的 poll 失败驱动，零额外网络调用。
 * 等池里真有第二个可选项时再加。
 */
export function routeProvider(pool: readonly VideoProvider[], ctx: RoutingContext): RoutingResult | null {
  if (pool.length === 0) return null

  // ── 第 1 步：硬约束 ──
  //
  // providerHint 优先，但仍要过能力检查：人工指定一个做不到的 provider，
  // 现在失败比提交后失败便宜得多（validate 不发网络调用）。
  if (ctx.providerHint) {
    const hinted = pool.find((p) => p.id === ctx.providerHint)
    if (hinted && hinted.validate(ctx.probe).ok) return { provider: hinted, reason: 'hint' }
    // 指定了但用不了就落回自动路由——把它当硬失败会让一个过期的 hint 卡死整个镜头
  }

  const capable = pool.filter((p) => p.validate(ctx.probe).ok)
  if (capable.length === 0) return null
  if (capable.length === 1) return { provider: capable[0]!, reason: 'only-candidate' }

  // ── 第 3 步：失败规避 ──
  //
  // content_filtered 是不可重试的（05 §5.3）：同一个 prompt 在同一家必然再被拒。
  // 所以不是「降权」而是「排到最后」——只有在别无选择时才回到它。
  const filtered = new Set(ctx.filteredBy)
  const clean = capable.filter((p) => !filtered.has(p.id))

  return clean.length > 0
    ? { provider: clean[0]!, reason: 'preferred' }
    : { provider: capable[0]!, reason: 'fallback-after-filtered' }
}
