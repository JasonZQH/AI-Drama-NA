import { breakdownJsonSchema, episodeBreakdown, type EpisodeBreakdown } from '@ai-drama/contracts'
import { MODEL, postChat } from './callShotlist.js'

/**
 * 剧本 → 场次拆解**提案**（S2）。
 *
 * ## 与 `callShotlist` 的关系
 *
 * 同一个模型、同一套三行必配（strict json_schema + `require_parameters` +
 * response-healing）、同一道 L1 闸门。HTTP 那一层抽到 `postChat` 共用——两份
 * 会漂，而漂开的表现是「其中一个端点偶尔莫名其妙失败」。
 *
 * ## 三处刻意不一样
 *
 * 1. **不修复。** 分镜那边错误原文回灌重来一轮，因为它有一整套可机器校验的判据
 *    （场次数、镜数、总时长、说话人…），模型照着改得动。拆解没有那种判据——
 *    「这个剧本该分几场」没有对错，只有合不合作者的意。所以失败就抛，人重点一次
 *    ($0.003)，比白烧一轮修复再交人便宜。
 * 2. **不落库。** 回一份建议，人在面板上改、确认之后才建场次。「能让 LLM 定的让
 *    LLM 定，人做复验」——LLM 有剧本、有上下文，比空着填格子强；但场次划分是
 *    作者的结构决定，系统该建议不该代替。
 * 3. **角色与地点是自由文本，不是 enum。** 与分镜那边正好相反：分镜阶段编一个
 *    不存在的角色就是错的；而这一步的全部意义就是**把剧本里客观存在、资产库里
 *    还没有的东西找出来**。调用方拿它与现有资产做差集。
 */

export interface BreakdownInput {
  /** `episodes.script_md`。没有它这一步无事可做 */
  readonly scriptMd: string
  /** `projects.synopsis`——给模型一点系列语境 */
  readonly synopsis: string | null
  /** 池里最宽松的单镜时长下限。用来把建议时长钉在可达范围内 */
  readonly minShotSec: number
  /** 已有的地点资产名。发出去是为了让模型**优先复用**，而不是每一场发明一个新的 */
  readonly knownLocations: readonly string[]
  readonly knownCharacters: readonly string[]
}

export interface BreakdownOutcome {
  readonly breakdown: EpisodeBreakdown
  readonly costUsd: number
}

export class BreakdownRejected extends Error {
  constructor(
    readonly errors: readonly string[],
    readonly raw: string,
  ) {
    super(`场次拆解没通过校验：\n${errors.join('\n')}`)
    this.name = 'BreakdownRejected'
  }
}

/**
 * 硬规则只有三条，因为这一步几乎没有可机器校验的判据。
 *
 * **不给场次数上下限**：那正是要让模型按剧本决定的东西。给了范围它就会去凑数，
 * 而凑出来的场次划分比人拍脑袋更糟——人至少读过剧本。
 */
export function breakdownSystemPrompt(input: BreakdownInput): string {
  return [
    'You are a script supervisor for vertical short-form drama (9:16, mobile-first).',
    'Read the script and break it into scenes. Return JSON matching the provided schema exactly.',
    '',
    'Rules:',
    '- A scene is one continuous place and time. A new place, or a jump in time, starts a new scene.',
    '  Let the script decide how many there are — do not pad or merge to hit a number.',
    '- `locationName` is a set name, not a sentence: "hallway outside 3B", not "the hallway where she waits".',
    '  Reuse a name from KNOWN LOCATIONS when the scene happens there; invent one only when the script',
    '  needs a place that is not on that list.',
    '- Every distinct place the camera is in needs its own scene. A shot looking through a door into a',
    '  corridor is still the corridor — if the script goes there, it is a place.',
    `- Suggest a total length. Each shot will be at least ${input.minShotSec} seconds and an episode runs`,
    `  10 to 25 shots, so anything under ${input.minShotSec * 10} seconds cannot be made.`,
    '- `lighting` is free text: name one visible light source and its quality. Leave it empty rather than',
    '  inventing light the script does not imply.',
    '- Write summaries in the language of the script.',
  ].join('\n')
}

export function breakdownUserPrompt(input: BreakdownInput): string {
  return [
    input.synopsis ? `<series>\n${input.synopsis}\n</series>` : '',
    `<known-locations>\n${input.knownLocations.join('\n') || '(none yet)'}\n</known-locations>`,
    `<known-characters>\n${input.knownCharacters.join('\n') || '(none yet)'}\n</known-characters>`,
    `<script>\n${input.scriptMd}\n</script>`,
    'Break the script above into scenes.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function callBreakdown(
  input: BreakdownInput,
  opts: { apiKey: string; baseUrl?: string; model?: string },
): Promise<BreakdownOutcome> {
  const { content, costUsd } = await postChat(
    [
      { role: 'system', content: breakdownSystemPrompt(input) },
      { role: 'user', content: breakdownUserPrompt(input) },
    ],
    { name: 'breakdown', schema: breakdownJsonSchema() },
    { apiKey: opts.apiKey, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), model: opts.model ?? MODEL },
  )

  let parsed: unknown
  try {
    parsed = JSON.parse(unfence(content))
  } catch (e) {
    throw new BreakdownRejected([`返回的不是合法 JSON：${String(e)}`], content)
  }
  // L1 闸门。strict 只是转向，这里才是真的（见 callShotlist.ts 的四层校验）
  const decoded = episodeBreakdown().safeParse(parsed)
  if (!decoded.success)
    throw new BreakdownRejected(
      decoded.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      content,
    )
  return { breakdown: decoded.data, costUsd }
}

/** strict 之下模型仍可能包一层 ```json。剥壳比赌便宜（同 callShotlist） */
function unfence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text)
  return (m?.[1] ?? text).trim()
}
