import { shotlistDraft, shotlistJsonSchema, type ShotlistDraft, type TimeOfDay } from '@ai-drama/contracts'
import { MAX_CAST_PER_SHOT, SAME_SHOT_TYPE_RUN, SHOT_COUNT, lintShotlist } from './shotlist.js'

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

export const MODEL = 'google/gemini-3.7-flash'
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
  /**
   * `episodes.logline` / `hook` / `cliffhanger` 拼成的两三行。
   *
   * 这三列 S1 就写好落库了，而分镜调用**一个都没传**——于是模型拿到的是一份
   * 没有戏剧目标的剧本。这就是「针对这个剧本的概述」，零新调用零新表列。
   */
  readonly episodeBrief: string | null
  readonly targetDurationSec: number
  /**
   * 池里最宽松的那家 provider 的单镜时长下限。
   *
   * 各家时长是**档位**不是连续值（seedance 全系最短 4 秒）。不发这个数，模型会
   * 规划一堆买不到的 2 秒镜头——`snapDuration` 静默抬到 4 秒，钱按 4 秒付，
   * 而整集按 2 秒那份计划算，成片跟面板上每一个数都对不上。
   */
  readonly minShotSec: number
  /** 顺序即场次号。模型必须一一对应，不能增删合并 */
  readonly scenes: readonly {
    readonly summary: string | null
    readonly timeOfDay: TimeOfDay | null
    /** `scenes.lighting`。自由文本优先、没有才回落枚举——与 `prompt.ts` 同一口径 */
    readonly lighting: string | null
  }[]
  readonly characters: readonly {
    readonly name: string
    readonly description: string
    /** `characters.anchor_tokens`。发它是为了让模型知道哪些外观是自动拼的、别复述 */
    readonly anchorTokens: readonly string[]
  }[]
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
 *
 * ## 四个数字从判据常量取，不再另写一遍
 *
 * 此前这里硬编码着 `'10 to 25 shots total'` / `'(within 15%)'` /
 * `'At most 2 characters'` / `'three shots in a row'`，与 `shotlist.ts` 的
 * `SHOT_COUNT` / `DURATION_TOLERANCE` / `MAX_CAST_PER_SHOT` /
 * `SAME_SHOT_TYPE_RUN` **是两份互不相干的字面量**，没有任何机制保证同步：
 *
 * - 判据改大、提示词没改 → 模型仍按旧上限产，改了等于没改
 * - 提示词改大、判据没改 → 模型照新的产、lint 判死，**每次生成白烧一轮修复再失败**
 *
 * 现在插值过来。**唯一还是字面量的是「2-8 seconds」**：那是 03 §S3 的建议区间，
 * 与 schema 的硬上限（`durationSec.min(1).max(10)`，对齐 `shots_duration_ck`）
 * 刻意不同——一个是「该怎么写」，一个是「不许越过」。合并它们会把建议变成硬限。
 */
export function systemPrompt(input: ShotlistInput): string {
  return [
    'You are a storyboard supervisor for vertical short-form drama (9:16, mobile-first).',
    'Break the given script into shots. Return JSON matching the provided schema exactly.',
    '',
    'Hard rules:',
    `- Return exactly ${input.scenes.length} scene objects, in the same order as the input scenes. Do not add, drop, or merge scenes.`,
    `- ${SHOT_COUNT.min} to ${SHOT_COUNT.max} shots total across all scenes. Typical is 18.`,
    /*
     * **时长是输出不是输入。**
     *
     * 原来这里写的是「must sum to about N (within 15%)」，配一条 error 级的判据。
     * 真机实测的后果：目标 30 秒的一集，模型交出 `3.0×8 + 2.0×3 = 30.0`，精确到
     * 小数点后一位——它不是在导戏，是在解算术题。而那 30 秒**根本不可达**
     * （seedance 最短 4 秒 × 至少 10 镜 = 40 秒），于是它被逼着写下一堆买不到的
     * 数字，而 E3 给了满分。
     *
     * 现在硬约束只剩「单镜必须是这家 provider 真能产出的整秒数」。一集多长由
     * 剧本决定，目标降级成一句 roughly。成本不靠它兜底：批量生成前有 dryRun
     * 估价 + 预算闸门 + 确认弹窗三道。
     */
    `- Give each shot the length its action actually needs. Let the scene decide how many shots it takes; do not pad or compress to hit a number.`,
    `- Whole seconds only, from ${input.minShotSec} to 8. **${input.minShotSec} is a hard floor** — the video model physically cannot make anything shorter, and a fraction of a second is rounded up to the next whole second you have to pay for.`,
    `- The episode should land roughly around ${input.targetDurationSec} seconds. That is the author's expectation, not a quota — if the script needs more or fewer shots, follow the script.`,
    `- At most ${MAX_CAST_PER_SHOT} characters per shot. More than that interacting reliably breaks the video model.`,
    '- Every shot with dialogue must list its speaker in characterNames.',
    `- Vary shotType; never use the same one ${SAME_SHOT_TYPE_RUN} shots in a row.`,
    '',
    'Writing style for `action` and `emotion`:',
    '- Describe only what the camera sees, in positive terms. Never write what is absent',
    '  ("no weapon", "without turning", "empty-handed") — diffusion models key on positive',
    '  content and frequently render the negated thing anyway. Write the positive form instead',
    '  ("hands open at her sides").',
    '- `dialogue` is the spoken line only, no speaker label. Empty string when the shot is silent.',
    '- `emotion` is a visible face or body state, not an inner feeling. Empty string when not relevant.',
    '- Do not restate anything already listed in <cast>. Build, hair, clothing and standing',
    '  props are attached to every shot automatically; typing them again puts the same coat in',
    '  the prompt twice. `action` is for what changes from shot to shot.',
    '- When a shot has dialogue, do not write "she speaks" or "he says" in `action`. The line is',
    '  already in `dialogue`. Write what the body does while it is delivered.',
    '- Vary the sentence shape. Not every shot is a named person performing a verb — some shots',
    '  are a prop, a doorway, a reflection, or a hand. Some are four words long.',
    /*
     * **报一次，之后由代码接管。**
     *
     * 锚点是跨镜一致性的载体，每一镜都自动拼进去；剧情把道具拿走之后它就变成
     * 自相矛盾。让模型每一镜重述「现在身上还有什么」是要求它跨镜记忆——那是
     * 代码的活（`resolvePrompt` 按 index 聚合前序），模型只报变化那一次。
     *
     * 同时把 W2 的正向表述口径绑在这里：说「她把项链摘下来」（正向、看得见），
     * 不说「她不再戴着项链」——扩散模型对否定词经常反向生效。
     */
    '- `hiddenAnchors` lists anchor tokens that are no longer on the character, copied verbatim',
    '  from the bracketed anchor list in <cast>. Use it only in the shot where the change happens —',
    '  every later shot inherits it automatically, so never repeat it.',
    '- When a shot removes something, say so positively in `action` ("she pulls the chain over her',
    '  head, bare collarbone") and put the token in `hiddenAnchors`. Never write "no necklace".',
    ...EXAMPLE,
  ].join('\n')
}

/**
 * **一条案例，四镜连续，自撰。**
 *
 * ## 为什么只有一条
 *
 * 跑的是 `google/gemini-3.7-flash`，而 Gemini 3 的型号专属页原话是「Be concise in
 * your input prompts… It may over-analyze verbose or overly complex prompt engineering
 * techniques used for older models.」——型号页压过通用策略页。「3–5 条」那个常见口径
 * 出自 Anthropic 给 Claude 的指南，跨厂商不算数。先一条把变量控住。
 *
 * ## 为什么是自撰的
 *
 * 四十多份公开语料里没有一份同时满足「与这七个字段同形 / 2–8 秒单镜粒度 / 许可证
 * 干净 / 本身不是 LLM 写的」。最接近的那份 dataset card 自己写着是 Gemini 2.5 生成的
 * caption——拿它教 Gemini 等于把模型的自我描述风格回喂回去。所以文字是自撰，**写法**
 * 逐条来自核实过的真实拍摄稿：状态变化在发生那一镜用及物动词写一次、之后不重述；
 * 光只在有变化时写且点名光源（`chandeliers` / `late-afternoon sun`，不是 `moody`）。
 *
 * ## 每一镜都在还一笔债
 *
 * 1. 第 1 镜没有人（`characterNames: []` 合法）、光点名光源——直接对症「场景光照太单一」
 * 2. 第 2 镜 `emotion` 是可见体态而不是 `exhaustion`——它会被逗号接在 action 后面，要读得通
 * 3. 第 3 镜给「项链被摘下」这个状态变化**单独一镜**
 * 4. 第 4 镜用 `collar open at her bare throat` **正向**承接上一镜，不写「不再戴着项链」
 *    ——`13-character-assets.md` 记的最贵一条教训就是这个
 * 5. 景别 establishing → ms → ecu → ots，时长 3/4/2/5：变化是**演示**出来的，不加一句文案
 *
 * ## 占位符不是省事，是唯一的防照抄
 *
 * 案例里的人名泄进 `action` **没有任何一层拦得住**（`characterNames` 有 enum 挡着，
 * action 没有）。所以案例里根本不放专有名词：`<A>` / `<B>` 一眼就能被 lint 的 E7
 * 抓出来，而 `Odile` 这种像真名的东西泄漏了也看不出来。
 */
const EXAMPLE = [
  '',
  '<example>',
  'One scene from a different episode, to show the writing and the rhythm. `<A>` and `<B>` are',
  'placeholders — this episode has its own people in <cast>. Never copy a name, a place, or a',
  'prop out of this example, and never emit `<A>` or `<B>` yourself. `<the pendant>` stands for',
  'an anchor token; in your output every `hiddenAnchors` entry must be copied verbatim from the',
  'bracketed anchor list in <cast>.',
  '',
  'SCRIPT',
  'INT. STAIRWELL - NIGHT',
  '<A> stops one flight up. She works the clasp open, drops the pendant into her coat pocket,',
  'and climbs the last flight. <B> is waiting on the landing.',
  '<B>: You came.',
  '',
  'SHOTS FOR THAT SCENE',
  '[',
  '  {"shotType":"establishing","cameraMove":"static","action":"a bare bulb burns over four flights of iron stair rail","emotion":"","dialogue":"","durationSec":3,"characterNames":[],"hiddenAnchors":[]},',
  '  {"shotType":"ms","cameraMove":"handheld","action":"<A> halts mid-flight, one hand flat on the rail","emotion":"shoulders dropping, breathing hard","dialogue":"","durationSec":4,"characterNames":["<A>"],"hiddenAnchors":[]},',
  '  {"shotType":"ecu","cameraMove":"static","action":"her thumb works the clasp open and the pendant drops into her coat pocket","emotion":"","dialogue":"","durationSec":2,"characterNames":["<A>"],"hiddenAnchors":["<the pendant>"]},',
  '  {"shotType":"ots","cameraMove":"dolly","action":"over <B> as <A> climbs the last three steps, collar open at her bare throat","emotion":"chin lifted","dialogue":"You came.","durationSec":5,"characterNames":["<A>","<B>"],"hiddenAnchors":[]}',
  ']',
  '</example>',
] as const

/**
 * **裸大写标签换成 XML，顺序换成「资料在前、指令在后」。**
 *
 * 换标签不是审美：剧本自带 `## SCENE 1` 这类 markdown 标题，视觉层级压过裸大写的
 * `SCRIPT`，模型无从判断那一行是资料还是新分节。markdown 这条路已经被剧本自己占了。
 *
 * `<scenes>` 挪到剧本**之后**，因为它不是参考资料而是**输出要逐条勾掉的清单**
 * （E1 判的就是它的条数），末尾是高注意力位。收尾那段指令同理。
 *
 * ## CAST 行的冒号换成破折号
 *
 * `- Lena: woman, 25…` 与剧本里的台词行 `LIN XIA: 你怎么在这。` **同形**。
 * `prompt.ts` 已经为下游同一个理由裁决过一次（冒号后接内容正是 Veo 的台词语法）。
 * 一个字符的 diff，消掉一整类「把角色描述当台词写进 dialogue」。
 *
 * ## 三样东西早就落库了，只是从没发出去
 *
 * `episodeBrief`（logline/hook/cliffhanger）、`scenes.lighting`、`characters.anchorTokens`
 * ——全部在 S1/S2 就写好落库，`api.ts` 一个都没传。用户问的「针对这个剧本的特殊情节
 * 人物场景的概述」答案就在这儿：**不用人手写，也不用第二次 LLM 调用。**
 */
export function userPrompt(input: ShotlistInput): string {
  const scenes = input.scenes
    .map((s, i) => {
      // 与 prompt.ts 同一口径：自由文本优先，四格枚举是兜底
      const light = s.lighting?.trim() || (s.timeOfDay ?? '')
      return `${i + 1}. ${s.summary ?? '(no summary)'}${light ? ` · ${light}` : ''}`
    })
    .join('\n')
  const cast = input.characters
    .map((c) => {
      const anchors = c.anchorTokens.length > 0 ? ` [always on screen: ${c.anchorTokens.join(', ')}]` : ''
      return `- ${c.name} — ${c.description}${anchors}`
    })
    .join('\n')
  return [
    input.synopsis ? `<series>\n${input.synopsis}\n</series>` : '',
    input.episodeBrief ? `<episode>\n${input.episodeBrief}\n</episode>` : '',
    `<script>\n${input.scriptMd}\n</script>`,
    `<cast use-these-names-verbatim>\n${cast || '(none)'}\n</cast>`,
    `<scenes count="${input.scenes.length}">\n${scenes}\n</scenes>`,
    [
      'Based on the script above, break it into shots.',
      `- Return ${input.scenes.length} scene objects, in the order of <scenes>. The Nth object covers the Nth entry; if the script's own scene headings disagree in count, follow <scenes>.`,
      '- Cover the whole script, from its first line to its last.',
      `- Shot durations must sum to about ${input.targetDurationSec} seconds.`,
      '- The text after each · in <scenes> is the lighting for that whole scene. It is attached to every shot automatically — use it to decide what is visible, do not retype it in `action`.',
      '- Everything in <cast>, including the bracketed items, is attached to every shot automatically. `action` is for what changes from shot to shot.',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')
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
  minShotSec: number,
  anchors: ReadonlySet<string>,
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
  const lint = lintShotlist(decoded.data, { sceneCount, targetDurationSec, minShotSec, anchors })
  if (lint.errors.length > 0) return { errors: lint.errors }
  return { draft: decoded.data, warnings: lint.warnings }
}

export async function callShotlist(input: ShotlistInput, opts: ShotlistOptions): Promise<ShotlistOutcome> {
  const names = input.characters.map((c) => c.name)
  // E6 的比对基准：全体角色的锚点，小写。现算不落库——它是输入的投影，不是状态
  const anchors = new Set(input.characters.flatMap((c) => c.anchorTokens.map((a) => a.toLowerCase())))
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

    const out = check(raw, names, input.scenes.length, input.targetDurationSec, input.minShotSec, anchors)
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

  const referer = process.env['OPENROUTER_REFERER']
  const title = process.env['OPENROUTER_TITLE']
  const res = await fetch(`${opts.baseUrl ?? BASE_URL}/chat/completions`, {
    method: 'POST',
    /*
     * 归因头与视频链保持一致（`openrouter.ts` 建 headers 那几行）。
     *
     * 不带的话，OpenRouter 后台里**文本这条链的花费是没有归属的**——而这个项目
     * 恰恰要按 provider/model 分摊成本。两条链走同一个账号、只有一条带归因，
     * 报表就对不上。不影响计费，只影响能不能看清钱花在哪。
     */
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
      ...(referer ? { 'http-referer': referer } : {}),
      ...(title ? { 'x-title': title } : {}),
    },
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
