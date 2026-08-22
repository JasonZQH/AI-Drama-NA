import { scriptDraft, scriptJsonSchema, type ScriptDraft } from '@ai-drama/contracts'
import { MODEL, postChat } from './callShotlist.js'
import { SHOT_COUNT } from './shotlist.js'

/**
 * 素材 → 剧本**提案**（S1）。
 *
 * `episodes.script_md` 此前只有人能写。而真实用法是「我手上有一部小说/一段素材，
 * 要把它改成一集竖屏短剧」——把 S1 留成人工，等于要求用户先完成最难的那一步。
 *
 * 与 `callBreakdown` 同构：同一个模型、同一套三行必配、同一道 L1 闸门、**不修复**、
 * **不落库**。HTTP 那层共用 `postChat`。
 */

export interface ScriptInput {
  /** 原始素材：一段小说、一个梗概、一条新闻。这是唯一必需的输入 */
  readonly source: string
  /** 编剧类型/调性。空着就走通用竖屏短剧口径 */
  readonly genre: string | null
  /** `projects.synopsis`——同一部剧的其他集给的语境 */
  readonly synopsis: string | null
  /** 池里最宽松的单镜时长下限。用来把剧本的体量钉在可拍范围内 */
  readonly minShotSec: number
  /** 已有的角色名。同一部剧的后续集要复用，而不是每集换一批人 */
  readonly knownCharacters: readonly string[]
}

export interface ScriptOutcome {
  readonly draft: ScriptDraft
  readonly costUsd: number
}

export class ScriptRejected extends Error {
  constructor(
    readonly errors: readonly string[],
    readonly raw: string,
  ) {
    super(`剧本改编没通过校验：\n${errors.join('\n')}`)
    this.name = 'ScriptRejected'
  }
}

/**
 * ## 为什么把「拍得出来」的约束写进编剧提示词
 *
 * 剧本是给这条流水线用的，不是给人拍的。写一场十个人的追车戏在这里是**不可执行
 * 的输出**——单镜最多 2 个角色（`13 §4.5`「三人以上必然崩」），而且没有任何一层
 * 会在生成之前告诉你。所以约束前置到编剧这一步，比事后在分镜层判死便宜。
 *
 * 篇幅同理：一集 10–25 镜、单镜不短于 provider 的档位下限，倒推出剧本该有多少
 * 个「可独立成镜的动作」。不给这个数的话模型会写一集 20 场的电视剧。
 */
export function scriptSystemPrompt(input: ScriptInput): string {
  const minSec = input.minShotSec
  return [
    'You are a screenwriter for vertical short-form drama (9:16, mobile-first, watched on a phone).',
    'Adapt the source material into ONE episode. Return JSON matching the provided schema exactly.',
    '',
    'What this format needs:',
    '- The first 3 seconds decide whether anyone watches the rest. Open on the sharpest image you have,',
    '  not on setup. Establish who and where inside the first scene, not before it.',
    '- End on a turn that makes the next episode feel necessary.',
    '',
    'What this pipeline can actually shoot — write inside it, not around it:',
    `- The episode becomes ${SHOT_COUNT.min}–${SHOT_COUNT.max} shots, each at least ${minSec} seconds.`,
    `  So write roughly ${SHOT_COUNT.min}–${SHOT_COUNT.max} distinct visual beats — a beat is one thing`,
    '  the camera can hold on. Fewer scenes with more beats beats many thin scenes.',
    '- **At most 2 characters in any one moment.** Three people interacting breaks the video model.',
    '- Every scene is one place and one time. A new place or a time jump starts a new scene.',
    '- Write what a camera can see. Interior states have to arrive as behaviour: what the hands do,',
    '  where the eyes go, what gets picked up or put down.',
    '- **Give at least one object a state change** — taken off, handed over, dropped, left behind.',
    '  Objects that change are what makes a 40-second episode feel like it has a plot.',
    '- Vary the beats deliberately: some want to be held long, some want to be a single cut. Write them',
    '  so the difference is visible on the page.',
    '- Dialogue is sparse and spoken aloud. One or two short lines per exchange, no speeches.',
    '',
    'Format:',
    '- Head every scene `## <number> · <place>`, then a slugline line, then action paragraphs.',
    '- Dialogue lines are `**NAME**：line`.',
    input.genre ? `\nGenre and tone: ${input.genre}` : '',
    input.knownCharacters.length > 0
      ? `\nThis series already has these characters — reuse them where the source allows: ${input.knownCharacters.join('、')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function scriptUserPrompt(input: ScriptInput): string {
  return [
    input.synopsis ? `<series>\n${input.synopsis}\n</series>` : '',
    `<source>\n${input.source}\n</source>`,
    'Adapt the source above into one episode. Write in the language of the source.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function callScript(
  input: ScriptInput,
  opts: { apiKey: string; baseUrl?: string; model?: string },
): Promise<ScriptOutcome> {
  const { content, costUsd } = await postChat(
    [
      { role: 'system', content: scriptSystemPrompt(input) },
      { role: 'user', content: scriptUserPrompt(input) },
    ],
    { name: 'script', schema: scriptJsonSchema() },
    { apiKey: opts.apiKey, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), model: opts.model ?? MODEL },
  )

  let parsed: unknown
  try {
    parsed = JSON.parse(unfence(content))
  } catch (e) {
    throw new ScriptRejected([`返回的不是合法 JSON：${String(e)}`], content)
  }
  const decoded = scriptDraft().safeParse(parsed)
  if (!decoded.success)
    throw new ScriptRejected(
      decoded.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      content,
    )
  return { draft: decoded.data, costUsd }
}

/** strict 之下模型仍可能包一层 ```json（同 callShotlist / callBreakdown） */
function unfence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text)
  return (m?.[1] ?? text).trim()
}
