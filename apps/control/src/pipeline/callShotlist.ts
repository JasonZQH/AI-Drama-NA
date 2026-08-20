import { shotlistDraft, shotlistJsonSchema, type ShotlistDraft, type TimeOfDay } from '@ai-drama/contracts'
import { lintShotlist } from './shotlist.js'

/**
 * 剧本 → 分镜表（`03-pipeline.md` S3）。**一个函数，一个实现。**
 *
 * ## 为什么不建 `TextProvider` 接口
 *
 * 一个接口一个实现正是 ADR-0002 **不支持**的形状——那条 ADR 的立论是「两条
 * **已存在**的路径要产生可比记账」，而这里只有一条。要换模型改一个常量，
 * 要接第二家再谈抽象（issue #6 已按此降级）。
 *
 * ## 模型选 `google/gemini-3.7-flash`，判据是端点一致性不是智能
 *
 * | | Gemini 3.7 Flash | DeepSeek V4 Flash 0731 |
 * |---|---|---|
 * | OpenRouter 端点数 | 6，全是 Google | 28，横跨 26 家 |
 * | 声明 `structured_outputs` | **6/6** | **22/28** |
 * | 缺的那几家 | — | 含全场最低价的 StreamLake（默认会路由过去）与 DeepSeek 自家端点（只有 `json_object`） |
 *
 * 只有 `json_object` = 保证是合法 JSON，**不保证符合你的 schema**：模型可以返回
 * `{"ok":true}`，zod 下一行拒掉，每次都要重试而日志里看不出原因。价格差是噪音
 * ——一次调用约 1.5k in + 1.5k out，Gemini ≈ $0.0034 vs DeepSeek ≈ $0.0004，
 * 而同一集的视频账单是 $2–11。**差额是视频钱的 0.14%。**
 *
 * ## 四层校验，只有第二层是保证
 *
 * L0 转向（strict + `require_parameters` + healing）→ **L1 闸门
 * `shotlistDraft().safeParse`** → L2 集级 `lintShotlist` → L3
 * `shots_duration_ck`。官方原话：strict「is not guaranteed on every endpoint」。
 * **schema 是转向器不是保证，落库前必须重新 parse。**
 *
 * ## 一次生成整集，不逐场
 *
 * E2/E3/W1 全是集级量。逐场就必须把累计秒数喂回去——那是手搓一个整集上下文
 * 只是分了 N 次付钱。整集重来只要 $0.003。
 *
 * ## 只修一轮
 *
 * errors 非空 → 原文追加回对话再来一次 → 还不过就抛，交人。方向与
 * `enums.ts` 的 `RETRYABLE` 白名单注释一致：「默认值是停下来等人，错的方向
 * 便宜得多」。**warnings 不触发重试。**
 */

const MODEL = 'google/gemini-3.7-flash'
const BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * 单次 HTTP 超时。比视频适配器的 30 秒宽：这里是一次性吐出整集约 1.5k token
 * 的生成，而不是提交后轮询。太短的代价是钱花了却拿不到结果——重试一轮更贵。
 */
const HTTP_TIMEOUT_MS = 120_000

export interface ShotlistInput {
  /** `episodes.script_md`。没有它就是让模型自己编情节而你无处干预 */
  readonly scriptMd: string
  /** `projects.synopsis`——episodes 没有这列 */
  readonly synopsis: string | null
  readonly targetDurationSec: number
  /** 顺序即场次号。模型必须一一对应，不能增删合并 */
  readonly scenes: readonly {
    readonly summary: string | null
    readonly timeOfDay: TimeOfDay | null
  }[]
  readonly characters: readonly { readonly name: string; readonly description: string }[]
}

export interface ShotlistOptions {
  readonly apiKey: string
  /** 单测把 loopback server 的地址塞进来。照 `OpenRouterProvider` 的同一个 seam */
  readonly baseUrl?: string
  readonly model?: string
}

export interface ShotlistOutcome {
  readonly draft: ShotlistDraft
  /** 只标黄，调用方自行决定要不要展示 */
  readonly warnings: readonly string[]
  /** 是否用掉了那一轮修复。连续为 true 说明提示词该改了 */
  readonly repaired: boolean
  /** OpenRouter 回报的真实计费（美元）。拿不到时是 0 */
  readonly costUsd: number
}

/** 模型不肯就范。与「OpenRouter 挂了」分开，调用方要给的处置不同 */
export class ShotlistRejected extends Error {
  constructor(
    readonly errors: readonly string[],
    readonly raw: string,
  ) {
    super(`分镜两轮都没通过校验：\n${errors.join('\n')}`)
    this.name = 'ShotlistRejected'
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
  usage?: { cost?: number }
  error?: { message?: string }
}

/**
 * 硬规则与 `lintShotlist` 一一对应。写进提示词是为了**少触发**那一轮修复，
 * 不是替代它——提示词是建议，`lintShotlist` 才是判据。
 */
function systemPrompt(input: ShotlistInput): string {
  return [
    'You are a storyboard supervisor for vertical short-form drama (9:16, mobile-first).',
    'Break the given script into shots. Return JSON matching the provided schema exactly.',
    '',
    'Hard rules:',
    `- Return exactly ${input.scenes.length} scene objects, in the same order as the input scenes. Do not add, drop, or merge scenes.`,
    '- 10 to 25 shots total across all scenes. Typical is 18.',
    `- Shot durations must sum to about ${input.targetDurationSec} seconds (within 15%). Each shot 2-8 seconds.`,
    '- At most 2 characters per shot. Three or more interacting reliably breaks the video model.',
    '- Every shot with dialogue must list its speaker in characterNames.',
    '- Vary shotType; never use the same one three shots in a row.',
    '',
    'Writing style for `action` and `emotion`:',
    '- Describe only what the camera sees, in positive terms. Never write what is absent',
    '  ("no weapon", "without turning", "empty-handed") — diffusion models key on positive',
    '  content and frequently render the negated thing anyway. Write the positive form instead',
    '  ("hands open at her sides").',
    '- `dialogue` is the spoken line only, no speaker label. Empty string when the shot is silent.',
    '- `emotion` is empty string when not relevant.',
  ].join('\n')
}

function userPrompt(input: ShotlistInput): string {
  const scenes = input.scenes
    .map((s, i) => `${i + 1}. ${s.summary ?? '(no summary)'}${s.timeOfDay ? ` [${s.timeOfDay}]` : ''}`)
    .join('\n')
  const cast = input.characters.map((c) => `- ${c.name}: ${c.description}`).join('\n')
  return [
    input.synopsis ? `SERIES SYNOPSIS\n${input.synopsis}\n` : '',
    `CAST (use these names verbatim in characterNames)\n${cast || '(none)'}\n`,
    `SCENES (${input.scenes.length}, in order)\n${scenes}\n`,
    `TARGET DURATION\n${input.targetDurationSec} seconds\n`,
    `SCRIPT\n${input.scriptMd}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * strict json_schema 之下模型仍可能包一层 ```json ——`response-healing` 只修
 * 语法层且只对非流式生效，两道都不是保证。剥壳比赌便宜。
 */
function unfence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text)
  return (m?.[1] ?? text).trim()
}

/** 两轮共用：解码 → L1 → L2。返回 null 表示这一轮没过，错误在 errors 里 */
function check(
  raw: string,
  names: readonly string[],
  sceneCount: number,
  targetDurationSec: number,
): { draft: ShotlistDraft; warnings: string[] } | { errors: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(unfence(raw))
  } catch (e) {
    return { errors: [`返回的不是合法 JSON：${String(e)}`] }
  }

  // L1 闸门。strict 只是转向，这里才是真的
  const decoded = shotlistDraft(names).safeParse(parsed)
  if (!decoded.success) {
    return {
      errors: decoded.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }

  // L2 集级 lint
  const lint = lintShotlist(decoded.data, { sceneCount, targetDurationSec })
  if (lint.errors.length > 0) return { errors: lint.errors }
  return { draft: decoded.data, warnings: lint.warnings }
}

export async function callShotlist(input: ShotlistInput, opts: ShotlistOptions): Promise<ShotlistOutcome> {
  const names = input.characters.map((c) => c.name)
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(input) },
    { role: 'user', content: userPrompt(input) },
  ]

  let costUsd = 0
  let last: { errors: string[] } = { errors: [] }
  let raw = ''

  // 两轮：一次生成 + 一次修复。第二轮还不过就交人
  for (let round = 0; round < 2; round++) {
    const r = await post(messages, names, opts)
    costUsd += r.costUsd
    raw = r.content

    const out = check(raw, names, input.scenes.length, input.targetDurationSec)
    if ('draft' in out) return { ...out, repaired: round > 0, costUsd }

    last = out
    // 错误原文追加回对话——`lintShotlist` 的文案就是照「模型能照着改」写的
    messages.push(
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: `Your previous output failed validation. Fix these and return the full corrected JSON:\n${out.errors.join('\n')}`,
      },
    )
  }

  throw new ShotlistRejected(last.errors, raw)
}

async function post(
  messages: readonly ChatMessage[],
  names: readonly string[],
  opts: ShotlistOptions,
): Promise<{ content: string; costUsd: number }> {
  const body = {
    model: opts.model ?? MODEL,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'shotlist', strict: true, schema: shotlistJsonSchema(names) },
    },
    /**
     * **最容易漏的一行。** 缺了它 OpenRouter 可以把请求路由到不声明
     * `structured_outputs` 的端点，`response_format` 被静默降级成 `json_object`
     * ——合法 JSON 但不符合 schema，症状是「偶尔莫名其妙解析失败」。
     */
    provider: { require_parameters: true },
    /** 免费；只修语法层，且只对非流式生效——所以这里不 stream */
    plugins: [{ id: 'response-healing' }],
  }

  const res = await fetch(`${opts.baseUrl ?? BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`OpenRouter chat/completions HTTP ${res.status}：${text.slice(0, 400)}`)

  const json = JSON.parse(text) as ChatResponse
  const content = json.choices?.[0]?.message?.content
  if (content === undefined)
    throw new Error(`OpenRouter 返回里没有 content：${(json.error?.message ?? text).slice(0, 400)}`)
  return { content, costUsd: json.usage?.cost ?? 0 }
}
