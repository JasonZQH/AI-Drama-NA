import { z } from 'zod'

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
export const WIRE_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
])

/** `properties` 的键是字段名（shotType…），只能递归它的值，不能拿白名单去筛 */
export function toWire(node: unknown): unknown {
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

/**
 * 把一个 zod schema 渲染成可以直接塞进 `response_format.json_schema.schema` 的那份。
 *
 * 抽出来共用而不是每个调用点复制一遍：复制就等于两套方言，迟早漂开——而漂开的
 * 表现是「某一个端点偶尔莫名其妙解析失败」，最难查的那一类。
 */
export function toWireSchema(schema: z.ZodType): Record<string, unknown> {
  return toWire(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })) as Record<string, unknown>
}
