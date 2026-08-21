import type { ShotlistDraft } from '@ai-drama/contracts'

/**
 * 分镜表的集级校验（03-pipeline.md §S3 的完成判据 + 13 §4.5 的 Prompt Lint）。
 *
 * **纯函数，零 IO**，与 `prompt.ts` / `shotMachine.ts` 同层。只读已有列，
 * 不需要任何迁移。
 *
 * ## 它在四层校验里的位置
 *
 * | 层 | 手段 | 拦什么 |
 * |---|---|---|
 * | L0 转向 | `strict` json_schema + `require_parameters` | 枚举、类型、语法。**官方明说不是保证** |
 * | L1 闸门 | `shotlistDraft(names).safeParse()` | 同上，但这里才是真的 |
 * | **L2 本函数** | 跨镜、跨场的约束 | schema 表达不了的东西 |
 * | L3 硬底 | `shots_duration_ck` | 绕过前三层直写库的路径 |
 *
 * ## errors 与 warnings 的区别不是严重程度，是**要不要重试**
 *
 * `errors` 会被原文追加回对话触发一轮修复，所以每条都要写成**模型能照着改**的
 * 形状：说清哪一场哪一镜、当前值是多少、该往哪个方向改。
 *
 * `warnings` 不触发重试——`03 §S3` 对景别那条的原文就是「标黄」，不是拒收。
 *
 * ## 它不跑在 seed 上
 *
 * `db/seed.ts` 的 12 镜夹具**过不了 E3**（42.5 秒 vs `targetDurationSec` 75 秒，
 * 偏差 −43%）。**只有 E3**：12 落在 `[10, 25]` 内，镜头数其实是合法的。那不是 bug：`seed.ts` 自己写着「12 镜是刻意的最小夹具，
 * 不是规模口径」。**本函数只校验 LLM 的输出。** 写在这里免得下一个人以为 lint 坏了。
 */

export interface LintResult {
  /** 触发一轮修复重试。文案要能让模型照着改 */
  readonly errors: string[]
  /** 只标黄，不重试 */
  readonly warnings: string[]
}

export interface LintContext {
  /** 输入里给了几场。模型必须一一对应，不能自己增删 */
  readonly sceneCount: number
  /** `episodes.target_duration_sec` */
  readonly targetDurationSec: number
}

/**
 * 03 §S3：单集镜头数在 10–25 之间（60–90 秒 / 2–8 秒每镜，典型 18 镜 × 4 秒）。
 *
 * **导出是为了让提示词从这里取数。** 此前 `callShotlist.ts` 的 system prompt 里
 * 另写了一遍 `'10 to 25 shots total'`，两份字面量互不相干：改大了 lint 放行而模型
 * 不会去用（改了等于没改），改小了模型照新的产而 lint 判死（**每次生成白烧一轮
 * 修复再失败**）。判据只该有一份。
 */
export const SHOT_COUNT = { min: 10, max: 25 } as const

/** 03 §S3：镜头时长总和 ≈ 目标时长（±15%）。导出理由同 `SHOT_COUNT` */
export const DURATION_TOLERANCE = 0.15

/** 13 §4.5：「禁 3 人以上复杂互动」——「三人同时打斗」必然崩。导出理由同 `SHOT_COUNT` */
export const MAX_CAST_PER_SHOT = 2

/** 03 §S3：连续三个同景别会被校验器标黄。导出理由同 `SHOT_COUNT` */
export const SAME_SHOT_TYPE_RUN = 3

/**
 * 13 §4.5 把这条列为「最贵的一条教训」：扩散模型主要识别正面内容，
 * 否定词经常反向生效——写「No held object」，模型偏偏塞给角色一把武器。
 * （同口径也见于 Google 对外的 Veo prompt guide，那是仓外出处，不在 docs/ 里。）
 *
 * **两处刻意收窄，都是实测撞出来的：**
 *
 * - 英文全部带 `\b` 词边界。不加的话 `Nolan`、`another`、`notebook` 全中。
 * - 中文的「无」不能裸用：它会打中「无奈」「无声」，尤其是**「无人机」**——
 *   而「无人机航拍」正是 `13 §机位词汇表` 的标准词，一个航拍镜头吃一条误报。
 *   收成 `无人(?!机)`。
 */
const NEGATION = /(\bno\b|\bnot\b|\bwithout\b|\bavoid\b|\bdon't\b|不要|没有|无人(?!机)|避免)/i

/**
 * 目标时长本身可不可能被满足。
 *
 * E2 封顶 25 镜、单镜封顶 10 秒 → 总时长上限 250 秒；E3 要求总时长 ≥ 目标 ×
 * (1 − 15%)。所以目标超过 **294 秒**时，**不存在任何能同时通过 E2 与 E3 的
 * 分镜表**——模型怎么改都不可能过，两轮 LLM 的钱白花，而人看到的报错是
 * 「总时长不对」，读不出真正的原因是这一集的目标时长本身就不可满足。
 *
 * 所以在调模型**之前**问一次。要支持长集得让 `SHOT_COUNT` 从目标时长推出来
 * 而不是硬编码，那是另一件事。
 *
 * @returns 不可达时返回可行动的说明；可达返回 null
 */
export function targetOutOfReach(targetDurationSec: number): string | null {
  const max = SHOT_COUNT.max * 10 // 单镜上限见 contracts 的 draftShot.durationSec
  const min = SHOT_COUNT.min * 1
  const lo = targetDurationSec * (1 - DURATION_TOLERANCE)
  const hi = targetDurationSec * (1 + DURATION_TOLERANCE)
  if (lo > max)
    return `目标时长 ${targetDurationSec} 秒不可能达成：最多 ${SHOT_COUNT.max} 镜 × 单镜 10 秒 = ${max} 秒，而 ±${DURATION_TOLERANCE * 100}% 要求至少 ${lo.toFixed(1)} 秒。把 targetDurationSec 调到 ${Math.floor(max / (1 - DURATION_TOLERANCE))} 秒以内（03 §S3 的口径是 60–90 秒一集）。`
  if (hi < min)
    return `目标时长 ${targetDurationSec} 秒不可能达成：至少 ${SHOT_COUNT.min} 镜 × 单镜 1 秒 = ${min} 秒，而 ±${DURATION_TOLERANCE * 100}% 只允许到 ${hi.toFixed(1)} 秒。`
  return null
}

interface Located {
  readonly scene: number
  readonly shot: number
  readonly index: number
  readonly s: ShotlistDraft['scenes'][number]['shots'][number]
}

/** 把嵌套结构拍平，同时算出跨场连续的全局镜号——报错要能指到具体位置 */
function flatten(draft: ShotlistDraft): Located[] {
  const out: Located[] = []
  let index = 0
  draft.scenes.forEach((sc, si) =>
    sc.shots.forEach((s, i) => {
      index += 1
      out.push({ scene: si + 1, shot: i + 1, index, s })
    }),
  )
  return out
}

const at = (l: Located): string => `第 ${l.scene} 场第 ${l.shot} 镜（全集第 ${l.index} 镜）`

export function lintShotlist(draft: ShotlistDraft, ctx: LintContext): LintResult {
  const errors: string[] = []
  const warnings: string[] = []
  const shots = flatten(draft)

  // E1 · 场次数对不上说明模型没按输入结构走，后面全会错位
  if (draft.scenes.length !== ctx.sceneCount) {
    errors.push(
      `场次数不对：输入有 ${ctx.sceneCount} 场，你返回了 ${draft.scenes.length} 场。` +
        `scenes 数组必须与输入的场次一一对应，不要增删或合并场次。`,
    )
  }

  // E2 · 03 §S3 完成判据
  if (shots.length < SHOT_COUNT.min || shots.length > SHOT_COUNT.max) {
    errors.push(
      `镜头总数 ${shots.length} 不在 ${SHOT_COUNT.min}–${SHOT_COUNT.max} 之间。` +
        `目标是 ${ctx.targetDurationSec} 秒一集、每镜 2–8 秒，典型 18 镜。` +
        (shots.length < SHOT_COUNT.min ? '把长镜头拆开。' : '合并相邻的同类镜头。'),
    )
  }

  /*
   * E3 · 03 §S3 完成判据。
   *
   * 文档原文是「**每场**的镜头时长总和 ≈ **场次**目标时长」，但 `scenes` 表没有
   * target_duration 列——加一列等于让 S2 决定每场配多少秒，那不是 S3 的事。
   * 所以落**集级**：`episodes.target_duration_sec` 是现存唯一的目标时长。
   */
  const total = shots.reduce((a, l) => a + l.s.durationSec, 0)
  const drift = (total - ctx.targetDurationSec) / ctx.targetDurationSec
  if (Math.abs(drift) > DURATION_TOLERANCE) {
    const pct = (drift * 100).toFixed(0)
    errors.push(
      `总时长 ${total.toFixed(1)} 秒，偏离目标 ${ctx.targetDurationSec} 秒 ${pct}%，` +
        `超过 ±${DURATION_TOLERANCE * 100}%。` +
        `请${drift > 0 ? '缩短镜头或减少镜头数' : '加长镜头或增加镜头数'}，让总和落进 ` +
        `${(ctx.targetDurationSec * (1 - DURATION_TOLERANCE)).toFixed(1)}–` +
        `${(ctx.targetDurationSec * (1 + DURATION_TOLERANCE)).toFixed(1)} 秒。`,
    )
  }

  for (const l of shots) {
    // E4 · 空镜说话：S6 的 TTS 取不到 voiceId，会配出一句无人称旁白
    if (l.s.dialogue.trim() !== '' && l.s.characterNames.length === 0) {
      errors.push(
        `${at(l)} 有台词「${l.s.dialogue.trim()}」但 characterNames 是空的。` +
          `台词要有说话的人——把说话者加进 characterNames，或把这句台词删掉。`,
      )
    }

    /*
     * E7 · 案例占位符泄漏。
     *
     * `characterNames` 有 enum + 受限解码双重挡着，`<A>` 进不去；
     * **`action` / `emotion` / `dialogue` 一层都没有**——那是照抄 system prompt 里
     * 那条案例唯一的出口，而它会一路进库、进 t2v prompt，烧掉 $2–11 的视频钱。
     * 所以是 E 不是 W：那一轮免费的修复正好用来换掉它。
     *
     * 编号跳过 E6：E6 留给已排期的「hiddenAnchors 逐字写错」，两边可以并存。
     *
     * ponytail: 一条字符类而不是维护一张占位符表——尖括号在这三个字段里没有任何
     * 合法用途，真误报也是人能一眼看懂的报错。要更细再换成 /<[A-Z]>/。
     */
    const leaked = [l.s.action, l.s.emotion, l.s.dialogue].filter((t) => /[<>]/.test(t))
    if (leaked.length > 0) {
      errors.push(
        `${at(l)} 抄了案例里的占位符（${leaked.join(' / ')}）。` +
          `案例是另一集的，只能学写法——把 <A>/<B> 换成 <cast> 里的真实角色名。`,
      )
    }

    // E5 · 13 §4.5「禁 3 人以上复杂互动」
    if (l.s.characterNames.length > MAX_CAST_PER_SHOT) {
      errors.push(
        `${at(l)} 有 ${l.s.characterNames.length} 个角色同框` +
          `（${l.s.characterNames.join('、')}）。` +
          `${MAX_CAST_PER_SHOT + 1} 人以上的复杂互动模型必然崩，` +
          `单镜最多 ${MAX_CAST_PER_SHOT} 人——拆成多个镜头。`,
      )
    }

    /*
     * W2 · 13 §4.5 的「最贵的一条教训」，一条正则的事。
     *
     * **只查 action 与 emotion，不查 dialogue。** 台词是角色说出来的话，
     * 「我没拿枪」是合法台词；进 prompt 的是画面描述，不是台词（`prompt.ts`
     * 刻意不把 dialogue 放进 prompt）。查它只会制造噪音。
     */
    const negated = [l.s.action, l.s.emotion].filter((t) => NEGATION.test(t))
    if (negated.length > 0) {
      warnings.push(
        `${at(l)} 用了否定式描述（${negated.join(' / ')}）。` +
          `扩散模型主要识别正面内容，否定词经常反向生效——改写成正面描述，` +
          `例如不写「手上没有东西」而写「双手空着、手掌张开、垂在体侧」。`,
      )
    }
  }

  /*
   * W1 · 03 §S3：连续三个同景别会被校验器标黄。
   *
   * **跨场次也算**——观众看到的是连续的画面流，不是分场剧本。一场的末镜与
   * 下一场的首镜同景别，在成片里就是相邻的两个镜头。
   */
  let run = 1
  for (let i = 1; i < shots.length; i++) {
    run = shots[i]!.s.shotType === shots[i - 1]!.s.shotType ? run + 1 : 1
    if (run === SAME_SHOT_TYPE_RUN) {
      warnings.push(
        `全集第 ${shots[i - 2]!.index}–${shots[i]!.index} 镜连续 ${SAME_SHOT_TYPE_RUN} 个 ` +
          `${shots[i]!.s.shotType} 景别，缺少变化。`,
      )
    }
  }

  return { errors, warnings }
}
