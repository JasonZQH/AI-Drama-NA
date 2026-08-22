import { z } from 'zod'
import { TimeOfDay } from './enums.js'
import { toWireSchema } from './wire.js'

/**
 * 剧本 → 场次拆解**提案**（S2）。
 *
 * ## 为什么需要它
 *
 * 场次此前**只有人能建**（面板上「+ 加一场」），而系统不读剧本——机械枚举
 * `insert(s.scenes)` 的写入方，只有 `db/seed.ts` 和那一个端点。
 *
 * 而下游把场次数当**硬约束**：分镜提示词说「Return exactly N scene objects…
 * Do not add, drop, or merge scenes」，lint 的 E1 判错并触发一轮修复。所以你粘
 * 一个五场的剧本、手建了两场，模型必须把五场内容塞进两格，**而没有任何一层会说
 * 一句话**——它照做，然后你在成片里看到场景混在一起。
 *
 * 这是整条链上最弱的一环：**一个人在没有任何依据的情况下做的结构决定，被当成
 * 所有下游的前提。**
 *
 * ## 提案，不是写入
 *
 * 这个 schema 的产物**不落库**。它回一份建议，人在面板上改、确认之后才建场次。
 * 「能让 LLM 定的让 LLM 定，人做复验」——LLM 有剧本、有上下文，它比空着填格子
 * 强；但场次划分是作者的结构决定，系统该**建议**不该**代替**。
 *
 * ## 顺带回答「资产列全了没有」
 *
 * `locationName` / `characterNames` 是**自由文本**，不是 enum——这是刻意的，与
 * 分镜那边正好相反。分镜阶段角色名必须逐字存在（编了就是错的）；而这一步的
 * 全部意义就是**把剧本里客观存在、而资产库里还没有的东西找出来**。调用方拿它
 * 与现有资产做差集，告诉人「你还缺门外走廊」。
 *
 * 参考图那条路还没通（P6 的 U1–U3），文字是描述环境的唯一通道——资产列不全，
 * 那一镜的环境就只能靠模型猜。
 */
const breakdownScene = z.strictObject({
  summary: z.string().min(4).describe('这一场发生了什么，一句话。它会成为分镜提示词里 <scenes> 那一行'),
  /**
   * 缺省用空串不用 `null`——与 `shotlist.ts` 第 1 条方言忌讳同一个理由：
   * `nullable` 在各家 JSON Schema 方言里分叉最厉害。
   */
  locationName: z
    .string()
    .describe(
      'The place this scene happens, in the language of the script. A short noun phrase like a set name, not a sentence.',
    ),
  characterNames: z
    .array(z.string())
    .describe('Who appears in this scene, using the names the script itself uses.'),
  timeOfDay: z.string().describe('One of: day, night, dawn, dusk. Empty string if the script does not say.'),
  lighting: z
    .string()
    .describe(
      'Free text: the light of this scene in one clause — name a visible source and its quality. Empty string if the script gives you nothing to go on.',
    ),
})

export const episodeBreakdown = () =>
  z.strictObject({
    scenes: z.array(breakdownScene).min(1),
    /**
     * 建议的整集时长。
     *
     * 调用方会拿它与 provider 的档位下限对撞（10 镜 × 4 秒 = 40 秒是 seedance 上
     * 的物理下限），不可达时给提示——而不是让人填一个凭空的数字再在成片上发现
     * 它做不到。
     */
    targetDurationSec: z
      .number()
      .describe('Suggested total length in seconds for this episode, based on how much story there is.'),
    /** 三行戏剧目标。它们拼成 `episodeBrief` 进分镜提示词 */
    logline: z.string().describe('One line: what this episode is about.'),
    hook: z.string().describe('The thing in the first 3 seconds that stops someone scrolling.'),
    cliffhanger: z.string().describe('The thing at the end that makes them open the next one.'),
  })

export type EpisodeBreakdown = z.infer<ReturnType<typeof episodeBreakdown>>
export type BreakdownScene = EpisodeBreakdown['scenes'][number]

/** 发给 `response_format.json_schema.schema` 的那份 */
export function breakdownJsonSchema(): Record<string, unknown> {
  return toWireSchema(episodeBreakdown())
}

/**
 * `timeOfDay` 是自由文本进来的（方言忌讳：不给 enum 之外的空值表达），这里收敛
 * 成枚举或 null。认不出来的一律 null——**猜一个错的时段比留空更贵**，留空还有
 * `lighting` 兜着。
 */
export function toTimeOfDay(raw: string): TimeOfDay | null {
  const v = raw.trim().toLowerCase()
  return TimeOfDay.options.includes(v as TimeOfDay) ? (v as TimeOfDay) : null
}
