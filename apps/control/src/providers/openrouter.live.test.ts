import { describe, expect, it } from 'vitest'
import { runContractSuite } from './contractSuite.js'
import { OpenRouterProvider } from './openrouter.js'
import { OPENROUTER_MODELS } from './openrouterModels.js'

/**
 * 需要出网的两组检查。**平时全部跳过。**
 *
 * `vitest.setup.ts` 在 test 车道拦掉了所有非 loopback 连接，`RECORD=1` 才放行
 * （见那个文件的注释）。所以这里的门槛与它一致：
 *
 * - **快照漂移**：只需要出网，`GET /videos/models` 是公开端点，不花钱
 * - **契约套件**：需要真 key，**会真的花钱**（每跑一次 3 次计费提交）
 *
 * 两者分开门控——想核对能力快照有没有过时，不该被迫先掏 key、更不该顺带扣费。
 */

const CAN_REACH_NETWORK = process.env['RECORD'] === '1'
const API_KEY = process.env['OPENROUTER_API_KEY']

describe.runIf(CAN_REACH_NETWORK)('能力快照与线上一致（公开端点，不计费）', () => {
  it('每个快照模型的能力字段与 /videos/models 逐字段相符', async () => {
    const res = await fetch('https://openrouter.ai/api/v1/videos/models')
    expect(res.ok, `models 端点 HTTP ${res.status}`).toBe(true)
    const live = new Map(
      ((await res.json()) as { data: Record<string, unknown>[] }).data.map((m) => [m['id'] as string, m]),
    )

    for (const snap of OPENROUTER_MODELS) {
      const l = live.get(snap.id)
      expect(l, `${snap.id} 已从 OpenRouter 下架——快照必须跟着改`).toBeDefined()
      if (!l) continue

      // 排序无关：线上返回的 supported_durations 实测就是乱序的（veo-lite 是 [8,4,6]）
      const sortNum = (a: readonly number[]) => [...a].sort((x, y) => x - y)
      const sortStr = (a: readonly string[]) => [...a].sort()

      expect(sortStr(l['supported_resolutions'] as string[]), `${snap.id} 分辨率漂了`).toEqual(
        sortStr(snap.supportedResolutions),
      )
      expect(sortStr(l['supported_aspect_ratios'] as string[]), `${snap.id} 画幅漂了`).toEqual(
        sortStr(snap.supportedAspectRatios),
      )
      expect(sortNum(l['supported_durations'] as number[]), `${snap.id} 时长档位漂了`).toEqual(
        sortNum(snap.supportedDurations),
      )
      expect(l['seed'], `${snap.id} 的 seed 支持变了——重试换 seed 会静默失效`).toBe(snap.seed)
      /*
       * supported_sizes 对按 token 计价的模型直接决定钱：像素数进公式。
       * 线上少一档尺寸而我们还按老的算，账单就对不上。按秒计价的模型线上
       * 没给这个字段（veo/wan 实测是 undefined），快照里存空数组。
       */
      expect(
        sortStr((l['supported_sizes'] as string[] | undefined) ?? []),
        `${snap.id} 尺寸档位漂了——按 token 计价时这直接是钱`,
      ).toEqual(sortStr(snap.supportedSizes))
      /*
       * 价目表漂了就是预算闸门在按过期单价拦人。这条断言故意做成全等而不是
       * 「只看我们用到的那条键」——多出来的键往往意味着计价维度变了。
       */
      expect(l['pricing_skus'], `${snap.id} 价目表漂了——预算闸门在按过期单价算`).toEqual(snap.pricingSkus)

      /*
       * 负向词的参数名。**写错不报错，只是静默丢弃**——那正是这个字段存在之前
       * 的状态（`style_profiles.negative_prompt` 一路算到 `negative_text` 然后
       * 在构造 body 那一行被扔掉）。所以它必须被线上核，不能靠记性。
       */
      const pass = (l['allowed_passthrough_parameters'] as string[] | undefined) ?? []
      const liveNeg = pass.find((x) => /negative/i.test(x))
      expect(liveNeg, `${snap.id} 的负向词参数名漂了——写错的话负向词被静默丢弃`).toBe(snap.negativeParam)
    }
  })

  /**
   * passthrough 是**按 provider slug 路由**的：官方原话「only the options for
   * the matched provider are forwarded」。slug 写错 = 参数静默丢弃。
   *
   * 而快照里存单个 slug 这件事本身有个前提：**这些模型都只有一个端点**。哪天
   * 多出第二家，「该用哪个 slug」就取决于实际路由到谁，这条断言会先撞上。
   */
  it('每个模型仍是单端点，且 slug 与快照一致', async () => {
    for (const snap of OPENROUTER_MODELS) {
      const res = await fetch(`https://openrouter.ai/api/v1/models/${snap.id}/endpoints`)
      expect(res.ok, `${snap.id} endpoints HTTP ${res.status}`).toBe(true)
      const eps = ((await res.json()) as { data: { endpoints: { tag: string }[] } }).data.endpoints
      expect(eps.length, `${snap.id} 不再是单端点——slug 得按实际路由选，不能写死`).toBe(1)
      expect(eps[0]?.tag, `${snap.id} 的 provider slug 漂了——passthrough 会被静默丢弃`).toBe(
        snap.providerSlug,
      )
    }
  })
})

/**
 * 契约套件。**跑一次会真的花钱**（幂等 1 次 + 取消 1 次 + 成本 1 次 = 3 次计费提交）。
 *
 * `cancelEffective: false`：OpenRouter 没有 cancel 端点（2026-08-17 实测文档中
 * 不存在）。不传这个的话「取消」那条会 drain 到任务真的跑完再断言 failed——
 * 一条红用例外加一次完整的计费生成。
 *
 * `timeoutMs` 15 分钟：与 orchestrator 的 `PROVIDER_TIMEOUT_MS` 同量级。只调
 * drain 的 deadline 没用，vitest 的 testTimeout 默认 5 秒会先把 it() 杀掉——
 * 而那时 submit 已经计过费了（见 contractSuite.ts）。
 */
if (CAN_REACH_NETWORK && API_KEY !== undefined && OPENROUTER_MODELS[0] !== undefined) {
  const model = OPENROUTER_MODELS[0]
  runContractSuite(model.id, () => new OpenRouterProvider({ apiKey: API_KEY, model }), {
    timeoutMs: 15 * 60_000,
    cancelEffective: false,
  })
}
