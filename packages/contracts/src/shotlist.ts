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
    action: z.string().min(4),
    /** `''` = 无 */
    emotion: z.string(),
    /** `''` = 无 */
    dialogue: z.string(),
    /**
     * 上界与 `shots_duration_ck`（`> 0 AND <= 10`）对齐，下界更严一档。
     *
     * 落库列是 `numeric(4,1)`，**小数点后第二位会被 Postgres 静默截掉**（4.567 → 4.6）。
     * 不在这里加 `multipleOf: 0.1` 去挡：那正是本文件第 2 条忌讳说的数值 bounds，
     * 而 18 镜最多累计 0.9 秒误差、对 ±15% 的 E3 是噪音。
     */
    durationSec: z.number().min(1).max(10),
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
 * - OpenAI 系的 `strict: true` 子集**不接受**这些关键字，整个 schema 被拒；
 * - Gemini 的 OpenAPI 3.0 子集对它们的处理不稳。
 *
 * 而它们留下来也没有收益：**JSON Schema 是转向器，闸门是下一行的
 * `safeParse`**。zod 那边一个字不改，长度和区间照样拦得住。
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
  }
}
