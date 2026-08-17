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
       * 价目表漂了就是预算闸门在按过期单价拦人。这条断言故意做成全等而不是
       * 「只看我们用到的那条键」——多出来的键往往意味着计价维度变了。
       */
      expect(l['pricing_skus'], `${snap.id} 价目表漂了——预算闸门在按过期单价算`).toEqual(snap.pricingSkus)
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
