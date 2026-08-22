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
  /**
   * 池里最宽松的那家 provider 的单镜时长下限（`ProviderCapabilities.minDurationSec`）。
   *
   * **各家的时长是档位不是连续值。** seedance 全系最短 4 秒，规划一个 2 秒的镜头
   * 等于规划一段买不到的片子——`snapDuration` 会静默抬到 4 秒，你付 4 秒的钱、
   * 拿 4 秒的片，而整集是按 2 秒那份计划算的。
   *
   * 取「最宽松」而不是「最严」：池里同时配了 wan（支持 2 秒）和 seedance 时，
   * 2 秒的镜头是**可以**买到的，只要路由到 wan。真正买不到的由 `validate()` 拦。
   */
  readonly minShotSec: number
  /**
   * 全体角色的锚点（小写)。`hiddenAnchors` 只能逐字引用其中之一。
   *
   * 空集 = 这个项目还没配锚点，那么任何 `hiddenAnchors` 都是模型编的。
   */
  readonly anchors: ReadonlySet<string>
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
 * 目标时长跟这一集实际能产出的范围差多远。
 *
 * **返回的是提示，不再是闸门。** W3 降级之后，总时长是输出不是输入——目标只
 * 用来告诉人「你预想的和实际能做的差多少」，不该拦住生成。
 *
 * 仍然值得在调模型**之前**算一次：目标 30 秒而 provider 最短 4 秒 × 至少 10 镜
 * = 40 秒时，人应该在花那两轮 LLM 之前就知道这个数达不到，而不是等 W3 事后
 * 告诉他偏了 48%。
 *
 * @returns 够不着时返回可行动的说明；够得着返回 null
 */
export function targetOutOfReach(targetDurationSec: number, minShotSec = 1): string | null {
  const max = SHOT_COUNT.max * 10 // 单镜上限见 contracts 的 draftShot.durationSec
  /*
   * **下限取自 provider 的档位，不是 schema 的 1 秒。**
   *
   * schema 允许 1 秒，但没有一家真能产出 1 秒——seedance 全系最短 4 秒。
   * 用 1 算出来的「可达成」是纸面上的：真机实测 `targetDurationSec: 30` 的一集，
   * 配上「至少 10 镜」，在 seedance 上最短也要 40 秒，而这道闸当时放行了，
   * E3 还算出 30.0/30 完美——一直到成片 44.5 秒才露出来。
   */
  const min = SHOT_COUNT.min * minShotSec
  const lo = targetDurationSec * (1 - DURATION_TOLERANCE)
  const hi = targetDurationSec * (1 + DURATION_TOLERANCE)
  if (lo > max)
    return `这一集会明显短于你的预期：最多 ${SHOT_COUNT.max} 镜 × 单镜 10 秒 = ${max} 秒，而目标 ${targetDurationSec} 秒的 ±${DURATION_TOLERANCE * 100}% 要求至少 ${lo.toFixed(1)} 秒。生成照常进行——想让两个数对上，把 targetDurationSec 调到 ${Math.floor(max / (1 - DURATION_TOLERANCE))} 秒以内（03 §S3 的口径是 60–90 秒一集）。`
  if (hi < min)
    return (
      `这一集会明显长于你的预期：当前 provider 最短 ${minShotSec} 秒一镜，` +
      `至少 ${SHOT_COUNT.min} 镜 = ${min} 秒，而目标 ${targetDurationSec} 秒的 ±${DURATION_TOLERANCE * 100}% ` +
      `只到 ${hi.toFixed(1)} 秒。生成照常进行——时长由剧本决定。` +
      `想让两个数对上，把 targetDurationSec 调到 ${Math.ceil(min / (1 + DURATION_TOLERANCE))} 秒以上，` +
      `或者配一个档位更细的模型（wan 系支持 2 秒起）。`
    )
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
   * W3 · 总时长偏离目标。**warning 不是 error——时长是输出不是输入。**
   *
   * 原来是 error。真机实测的后果：目标 30 秒的一集，模型交出
   * `3.0×8 + 2.0×3 = 30.0`——**精确到小数点后一位**。它不是在导戏，是在解一道
   * 算术题；而每一镜配多少秒本该由那一镜的动作需要多长决定。
   *
   * 更糟的是那 30 秒**根本不可达**（seedance 最短 4 秒 × 至少 10 镜 = 40 秒），
   * 于是模型被逼着写下一堆买不到的数字，E3 还给了满分。
   *
   * 现在硬约束只剩**单镜时长必须是这家 provider 真能产出的值**（E8）。
   * 一集多长由剧本决定，算出来多少就是多少——目标只用来提示「跟你预想的差多少」。
   * 成本不靠它兜底：批量生成前有 dryRun 估价 + 预算闸门 + 确认弹窗三道。
   *
   * 文档原文是「**每场**的镜头时长总和 ≈ **场次**目标时长」，但 `scenes` 表没有
   * target_duration 列——加一列等于让 S2 决定每场配多少秒，那不是 S3 的事。
   * 所以落**集级**：`episodes.target_duration_sec` 是现存唯一的目标时长。
   */
  const total = shots.reduce((a, l) => a + l.s.durationSec, 0)
  const drift = (total - ctx.targetDurationSec) / ctx.targetDurationSec
  if (Math.abs(drift) > DURATION_TOLERANCE) {
    const pct = (drift * 100).toFixed(0)
    warnings.push(
      `总时长 ${total.toFixed(1)} 秒，偏离目标 ${ctx.targetDurationSec} 秒 ${pct}%` +
        `（超过 ±${DURATION_TOLERANCE * 100}%）。目标是预期不是判据——` +
        `${drift > 0 ? '这一集比预想的长' : '这一集比预想的短'}，剧情需要就留着，` +
        `不需要就在分集页把 targetDurationSec 改成 ${Math.round(total)} 秒。`,
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

    /*
     * E8 · 低于 provider 的时长档位下限。
     *
     * `snapDuration` 会把它**静默抬到**下一档：规划 2 秒、买到 4 秒、付 4 秒的钱，
     * 而整集是按 2 秒那份计划算的。E3 因此算的是一堆买不到的数字，成片跟它对不上。
     * 是 E 不是 W——那一轮免费的修复正好用来换掉它，比事后拿剪刀补便宜。
     */
    if (l.s.durationSec < ctx.minShotSec) {
      errors.push(
        `${at(l)} 时长 ${l.s.durationSec} 秒低于当前 provider 的档位下限 ${ctx.minShotSec} 秒。` +
          `低于下限的会被静默抬到下一档：片子按 ${ctx.minShotSec} 秒出、钱按 ${ctx.minShotSec} 秒付，` +
          `而整集时长是按你写的那个数算的。改成 ${ctx.minShotSec} 秒或更长。`,
      )
    }

    /*
     * E6 · `hiddenAnchors` 里出现了锚点表里没有的项。
     *
     * `characterClause` 的 filter 是**精确匹配**，所以模型自由发挥出来的近义词
     * （`the pendant`、`her necklace`）永远匹配不上任何锚点：**filter 静默失效，
     * prompt 照旧带着那件道具，而四层校验全绿**——正是这个字段要修的那个 bug
     * 换了个入口又回来了。这类错必须在 L2 拦住。
     *
     * 是 E 不是 W：那一轮免费的修复正好用来换掉它，比事后对着成片猜便宜。
     */
    for (const a of l.s.hiddenAnchors) {
      if (ctx.anchors.has(a.trim().toLowerCase())) continue
      errors.push(
        `${at(l)} 的 hiddenAnchors 里有「${a}」，但角色锚点表里没有这一项。` +
          `只能逐字引用给定的锚点：${[...ctx.anchors].join('、') || '(这个项目还没有配锚点)'}。` +
          `不要改写、不要加冠词、不要用近义词——写错的那一项会被静默忽略。`,
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
