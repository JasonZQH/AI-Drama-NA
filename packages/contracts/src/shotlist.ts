import { z } from 'zod'
import { CameraMove, ShotType } from './enums.js'
import type { ShotIntent } from './shot.js'

/**
 * LLM 方言：与 `ShotIntent` 同构，但**每字段必填、对象封死**。
 *
 * ## 为什么不能直接把 ShotIntent 当 response_format
 *
 * OpenRouter 的 `strict: true` json_schema 要求 `required` 覆盖全部 properties
 * 且 `additionalProperties: false`，而 `ShotIntent` 用 `.optional()`（`shot.ts:13`
 * 起三处）。直接塞进去，schema 转换器要么报错要么静默降级。
 *
 * ## 三条方言上的忌讳（每条都会让某一家静默失效）
 *
 * 1. **缺省用空串，不用 `null`。** `nullable` 在 OpenAI 系渲染成 `anyOf`、在
 *    Gemini 的 OpenAPI 3.0 子集里渲染成 `nullable` —— 这是各家分叉最厉害的
 *    一处，绕开比赌便宜。`toIntent()` 负责把空串还原成 `undefined`。
 * 2. **不用 `z.int()` 表达任何编号。** 它渲染出 `maximum: 9007199254740991`，
 *    Gemini 的子集对这类 bounds 处理不稳。场次号与镜号一律由代码分配——
 *    数组顺序即编号，让模型报号是白送一整类错误。
 * 3. **`cameraMove` 不给可空。** `'static'` 本就是中性取值，`prompt.ts` 会把它
 *    渲染成 "static camera"，不是缺失。
 *
 * 可移植的方言交集：纯对象 + 全必填 + enum + 不依赖任何数值 bounds。
 * `additionalProperties: false` 在 OpenAI 系是硬要求、在 Gemini 转换时被丢弃——
 * 写上不会错，只是那边不生效，兜底靠落库前重新 parse。
 */
const draftShot = (names: readonly string[]) =>
  z.strictObject({
    shotType: ShotType,
    cameraMove: CameraMove,
    action: z.string().min(4).describe('这一镜画面里发生什么，只写镜头看得见的东西'),
    /**
     * **这一列至今零 description，而 `WIRE_KEYS` 只放行 description**——等于它对
     * 模型完全没有包络。真实那一集 8 个非空 emotion **8 个全是抽象内心名词**
     * （anticipation / solitude / decisiveness / defiance），而 `prompt.ts` 会把它
     * 逗号接在 action 后面，拼出 `…, anticipation.` 这种拍不出来的悬空片段。
     *
     * `''` = 无。
     */
    emotion: z
      .string()
      .describe(
        '可见的表情或体态，不是内心感受。写「下巴收紧」「肩膀垮下来」，不写「焦虑」「决心」。无关时留空串',
      ),
    /** `''` = 无 */
    dialogue: z.string(),
    /**
     * 上界与 `shots_duration_ck`（`> 0 AND <= 10`）对齐，下界更严一档。
     *
     * 落库列是 `numeric(4,1)`，**小数点后第二位会被 Postgres 静默截掉**（4.567 → 4.6）。
     * 不在这里加 `multipleOf: 0.1` 去挡：那正是本文件第 2 条忌讳说的数值 bounds，
     * 而 18 镜最多累计 0.9 秒误差、对 ±15% 的 E3 是噪音。
     */
    durationSec: z
      .number()
      .min(1)
      .max(10)
      /*
       * **`description` 是 bounds 被剃掉之后唯一还能传给模型的包络。**
       * 见下面 `WIRE_KEYS`：`minimum`/`maximum` 不发出去，模型看不到 1–10。
       * 不说的话超限只在 L1 被拒，白烧一轮修复。
       */
      .describe('本镜时长，1 到 10 秒之间，典型 4 秒'),
    /**
     * 从这一镜起**不再出现**的角色锚点，逐字取自输入里给的锚点表。`[]` = 无变化。
     *
     * ## 为什么需要它
     *
     * 锚点是跨镜一致性的载体（ADR-0008）：每一镜都带同一串，模型才有机会把人
     * 画成同一个。这对**身份**成立（发型、脸、那件一直穿着的外套），对**道具**
     * 不成立——道具会被剧情拿走。一个字段混了两种语义。
     *
     * 真机实测：给角色配了锚点 `brass key on a cord at her neck`，剧本第 2 镜她
     * 把钥匙摘下放到桌上。拼出来的 prompt 在同一句里自相矛盾——既有那串锚点，
     * 又有「她把钥匙放到桌上」；而摘下之后的第 3、5、6、8、9、11 镜**照旧带着**
     * 它。成片上肉眼可见：第 2 镜末帧钥匙在桌上，第 3 镜又回到脖子上。
     *
     * ## 为什么只报一次
     *
     * **跨镜记忆由代码承担，不由模型承担。** 落库时前向填充成累计集
     * （见 `api.ts` 的分镜落库），于是 `resolvePrompt` 依旧是纯粹的单镜查询、
     * `buildPrompt` 依旧是纯函数——这是唯一与现有架构相容的形状。
     *
     * ## 消费者
     *
     * `prompt.ts` 的 `characterClause` 拿它做**精确匹配**的 filter：把该锚点从
     * 那一镜的特征表里**删掉**。**不是**拼一句「不再戴着项链」——
     * `13-character-assets.md` 记的「最贵的一条教训」就是写「No held object」
     * 模型偏偏塞了把武器。用删除表达消失，不用否定词。
     */
    hiddenAnchors: z
      .array(z.string())
      .describe(
        'Anchor tokens that are no longer on the character from this shot onward, copied verbatim from the anchor list in CAST. Empty array in almost every shot. Report a token once, in the shot where it changes — later shots inherit it automatically.',
      ),
    /**
     * **角色名是唯一能在 schema 层钉死的叙事字段。**
     *
     * 把本项目 `characters` 表的实际名字灌成 enum，「LLM 编了个不存在的角色」
     * 在解码阶段就没了——不必等到落库时才发现 `byName` 查不到。
     * 空数组 = 空镜，合法。
     *
     * 项目还没有角色时退化成自由字符串：一个空 enum 是非法 JSON Schema。
     */
    characterNames: z.array(names.length > 0 ? z.enum(names as [string, ...string[]]) : z.string()),
  })

/**
 * 场次**不报号**：数组第 i 项对应传进去的第 i 个 scene。长度对不上由 lint 的
 * E1 判错并触发一轮修复——那说明模型没按输入结构走，后面全会错位。
 */
export const shotlistDraft = (characterNames: readonly string[] = []) =>
  z.strictObject({
    scenes: z.array(z.strictObject({ shots: z.array(draftShot(characterNames)).min(1) })).min(1),
  })

export type ShotlistDraft = z.infer<ReturnType<typeof shotlistDraft>>
export type DraftShot = ShotlistDraft['scenes'][number]['shots'][number]

/**
 * 方言交集的白名单。`z.toJSONSchema()` 会把 zod 的校验忠实地渲染成
 * `minLength` / `minimum` / `maximum` / `minItems`——**那些恰好是本文件第 2 条
 * 忌讳说的数值 bounds**，留着就是在赌各家转换器：
 *
 * 各家对这些关键字的支持是**分叉且在动**的（有的整份 schema 拒收、有的静默
 * 丢弃、有的按版本变）。与其跟着任何一家的当期文档走，不如只发**交集**——
 * 这个判断不依赖任何一家下个月改不改。
 *
 * 而它们留下来也没有收益：**JSON Schema 是转向器，闸门是下一行的
 * `safeParse`**。zod 那边一个字不改，长度和区间照样拦得住；给模型的软性提示
 * 走 `description`（白名单里放行了它，`durationSec` 就是这么把 1–10 说出去的）。
 */
const WIRE_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
])

/** `properties` 的键是字段名（shotType…），只能递归它的值，不能拿白名单去筛 */
function toWire(node: unknown): unknown {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  /*
   * `$ref` 不在白名单里，剃掉之后剩一个 `{}` ——那在 JSON Schema 里是**「任意
   * 值」**，strict 会照收，于是整棵子树的约束静默消失。
   *
   * 当前触发不了（全仓零 `.meta()`/`register()`，zod v4 默认 `reused: 'inline'`），
   * 但给任一子 schema 加个 id 就会冒出来。**而这条测不出来**：toWire 已经把
   * `$ref` 抹掉了，断言输出里没有 `$ref` 永远是绿的。所以只能在这里炸。
   */
  if ('$ref' in node) throw new Error('shotlistJsonSchema: schema 里出现了 $ref，白名单会把它剃成「任意值」')
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (!WIRE_KEYS.has(k)) continue
    out[k] =
      k === 'properties' && v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([f, sub]) => [f, toWire(sub)]))
        : toWire(v)
  }
  return out
}

/** 发给 `response_format.json_schema.schema` 的那份。见 `WIRE_KEYS` 的注释 */
export function shotlistJsonSchema(characterNames: readonly string[] = []): Record<string, unknown> {
  const full = z.toJSONSchema(shotlistDraft(characterNames), { io: 'input', unrepresentable: 'any' })
  return toWire(full) as Record<string, unknown>
}

/**
 * LLM 方言 → `ShotIntent`。空串还原成 `undefined`：落库要 NULL 不要 `''`，
 * 混着存的话后面每个读取方都要各写一遍兜底。
 */
export function toIntent(d: DraftShot): ShotIntent {
  return {
    shotType: d.shotType,
    cameraMove: d.cameraMove,
    action: d.action.trim(),
    durationSec: d.durationSec,
    characterNames: d.characterNames,
    ...(d.emotion.trim() ? { emotion: d.emotion.trim() } : {}),
    ...(d.dialogue.trim() ? { dialogue: d.dialogue.trim() } : {}),
    // 空数组原样带过：它是「这一镜没有变化」，不是缺省
    hiddenAnchors: d.hiddenAnchors.map((a) => a.trim()).filter(Boolean),
  }
}
