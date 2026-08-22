import { shotlistDraft, toIntent, type ShotlistDraft } from '@ai-drama/contracts'
import { describe, expect, it } from 'vitest'
import { lintShotlist, targetOutOfReach } from './shotlist.js'

/** 一个默认合法的镜头，按需覆盖 */
const shot = (over: Partial<ShotlistDraft['scenes'][number]['shots'][number]> = {}) => ({
  shotType: 'ms' as const,
  cameraMove: 'static' as const,
  action: 'Lena pushes the door open',
  emotion: '',
  dialogue: '',
  durationSec: 4,
  characterNames: [] as string[],
  ...over,
})

/** n 个镜头分成 sceneCount 场，景别轮换以免误触发 W1 */
const draft = (n: number, sceneCount = 3, over: Partial<ReturnType<typeof shot>> = {}): ShotlistDraft => {
  const kinds = ['ms', 'cu', 'ws'] as const
  const all = Array.from({ length: n }, (_, i) => shot({ shotType: kinds[i % 3]!, ...over }))
  const per = Math.ceil(n / sceneCount)
  return {
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      shots: all.slice(i * per, (i + 1) * per),
    })).filter((s) => s.shots.length > 0),
  }
}

// minShotSec 取 2：夹具用 4 秒一镜，2 秒让 E8 在基准上保持沉默，
// 而 E8 自己的用例显式传更高的下限
const ctx = { sceneCount: 3, targetDurationSec: 72, minShotSec: 2 }

describe('shotlistDraft（LLM 方言 schema）', () => {
  it('角色名灌成 enum——编造的角色在解码阶段就被拒', () => {
    const schema = shotlistDraft(['Lena', 'Marcus'])
    const ok = schema.safeParse({ scenes: [{ shots: [shot({ characterNames: ['Lena'] })] }] })
    expect(ok.success).toBe(true)
    const bad = schema.safeParse({ scenes: [{ shots: [shot({ characterNames: ['Batman'] })] }] })
    expect(bad.success, '编造的角色名该在 L1 就被拦下').toBe(false)
  })

  it('没有角色时退化成自由字符串——空 enum 是非法 JSON Schema', () => {
    expect(
      shotlistDraft([]).safeParse({ scenes: [{ shots: [shot({ characterNames: ['谁'] })] }] }).success,
    ).toBe(true)
  })

  /** strict json_schema 要求 additionalProperties:false，多字段必须被拒 */
  it('对象封死：多出来的键被拒', () => {
    const bad = shotlistDraft([]).safeParse({
      scenes: [{ shots: [{ ...shot(), sceneNumber: 1 }] }],
    })
    expect(bad.success).toBe(false)
  })

  it('每个字段都必填——少任何一个都拒（strict 模式的 required 覆盖全部）', () => {
    // 逐个字段删一遍，而不是只试 emotion 一个：required 漏掉哪个都是静默降级
    for (const key of Object.keys(shot())) {
      const missing: Record<string, unknown> = { ...shot() }
      delete missing[key]
      expect(
        shotlistDraft([]).safeParse({ scenes: [{ shots: [missing] }] }).success,
        `少了 ${key} 却通过了——strict json_schema 要求 required 覆盖全部属性`,
      ).toBe(false)
    }
  })

  /** 空串是「无」的表达，落库要还原成 undefined——'' 和 NULL 混着存会让每个读取方各写一遍兜底 */
  it('toIntent 把空串还原成 undefined，不是空字符串', () => {
    const i = toIntent(shot({ emotion: '  ', dialogue: '' }))
    expect(i.emotion).toBeUndefined()
    expect(i.dialogue).toBeUndefined()
    expect('emotion' in i, '空串该整个键都不出现').toBe(false)
  })

  it('toIntent 保留有值的字段并 trim', () => {
    const i = toIntent(shot({ emotion: ' 紧绷 ', dialogue: ' 还是那把椅子。 ', action: ' 扫视全场 ' }))
    expect(i.emotion).toBe('紧绷')
    expect(i.dialogue).toBe('还是那把椅子。')
    expect(i.action).toBe('扫视全场')
  })
})

describe('lintShotlist · errors（触发一轮修复）', () => {
  it('基准：18 镜 × 4s = 72s 三场，零 error 零 warning', () => {
    const r = lintShotlist(draft(18), ctx)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('E1 场次数对不上，多给少给都算，且两个数字不能对调', () => {
    // 少给一场。断言到具体数字：这段原文要回灌给模型照着改，把 ctx.sceneCount
    // 与 draft.scenes.length 在模板里对调会让模型往反方向改，而只匹配
    // /场次数不对/ 的断言看不出来
    expect(lintShotlist(draft(18, 2), ctx).errors.join()).toMatch(/输入有 3 场，你返回了 2 场/)
    // 多给一场——实现写成 `<` 而不是 `!==` 的话这条才会红
    expect(lintShotlist(draft(18, 4), ctx).errors.join()).toMatch(/输入有 3 场，你返回了 4 场/)
  })

  it('E2 镜头数越界，且提示方向相反', () => {
    // 断言到数字：印成场数（3）或把区间印反（25–10）都还是会匹配 /把长镜头拆开/
    expect(lintShotlist(draft(9, 3, { durationSec: 8 }), ctx).errors.join()).toMatch(
      /镜头总数 9 不在 10–25 之间。目标是 72 秒一集[^]*把长镜头拆开/,
    )
    expect(lintShotlist(draft(26, 3, { durationSec: 2.77 }), ctx).errors.join()).toMatch(
      /镜头总数 26 不在 10–25 之间[^]*合并相邻的同类镜头/,
    )
    // 边界 10 与 25 是合法的，不能是开区间
    expect(lintShotlist(draft(10, 3, { durationSec: 7.2 }), ctx).errors.join()).not.toMatch(/镜头总数/)
    expect(lintShotlist(draft(25, 3, { durationSec: 2.88 }), ctx).errors.join()).not.toMatch(/镜头总数/)
  })

  /**
   * **W3 是 warning 不是 error——时长是输出不是输入。**
   *
   * 原来是 error。真机实测的后果：目标 30 秒的一集，模型交出
   * `3.0×8 + 2.0×3 = 30.0`，精确到小数点后一位——它不是在导戏，是在解算术题。
   * 而那 30 秒根本不可达（seedance 最短 4 秒 × 至少 10 镜 = 40 秒），
   * E3 还给了满分。
   */
  it('W3 总时长偏离只标黄，两个方向的措辞不一样', () => {
    const long = lintShotlist(draft(18, 3, { durationSec: 6 }), ctx)
    expect(long.errors, '偏长不该拦住生成——剧情需要就该让它长').toEqual([])
    expect(long.warnings.join()).toMatch(/总时长 108\.0 秒，偏离目标 72 秒 50%[^]*比预想的长/)

    const short = lintShotlist(draft(18, 3, { durationSec: 2 }), ctx)
    expect(short.errors).toEqual([])
    expect(short.warnings.join()).toMatch(/总时长 36\.0 秒，偏离目标 72 秒 -50%[^]*比预想的短/)

    // 要给出「不想要就把目标改成多少」——不然人只知道偏了，不知道下一步做什么
    expect(long.warnings.join()).toMatch(/targetDurationSec 改成 108 秒/)
  })

  /**
   * ±15% **含边界**。
   *
   * 这条刻意用二进制精确的数：目标 80 秒、16 镜 × 5.75 = 92 秒，drift 恰好
   * 12/80。5.75 是 23/4、80 与 12 都是整数，所以除出来与字面量 `0.15` 是同一个
   * double，`> ` 判定不会因为累加误差翻面。
   *
   * 用 18 × 4.6 = 82.8 这种写法能过是**靠浮点运气**——4.6 不是二进制精确值，
   * 累加 18 次的误差方向决定这条用例的红绿。边界断言不该建在那上面。
   */
  it('恰好 ±15% 之内不标黄，多一点点才标', () => {
    const c = { sceneCount: 3, targetDurationSec: 80, minShotSec: 2 }
    expect(16 * 5.75).toBe(92) // 前提：这一步没有浮点误差
    expect(lintShotlist(draft(16, 3, { durationSec: 5.75 }), c).warnings.join()).not.toMatch(/总时长/)
    // 再多 0.25 秒/镜就越界
    expect(lintShotlist(draft(16, 3, { durationSec: 6 }), c).warnings.join()).toMatch(/总时长/)
  })

  it('E4 空镜说话——TTS 取不到 voiceId 会配出无人称旁白', () => {
    const d = draft(18)
    d.scenes[0]!.shots[0] = shot({ dialogue: '还是那把椅子。', characterNames: [] })
    const r = lintShotlist(d, ctx)
    // 台词原文要回显，否则模型定位不到是哪一句
    expect(r.errors.join()).toMatch(/有台词「还是那把椅子。」但 characterNames 是空的/)
    // 报错要指到具体位置，模型才改得准
    expect(r.errors.join()).toMatch(/第 1 场第 1 镜（全集第 1 镜）/)
  })

  /**
   * E8 · 低于 provider 的时长档位下限。
   *
   * 各家时长是**档位不是连续值**：seedance 全系最短 4 秒。规划 2 秒不会报错，
   * `snapDuration` 会静默抬到 4 秒——片子按 4 秒出、钱按 4 秒付，而整集时长是
   * 按 2 秒那份计划算的。真机实测：目标 30 秒的一集，成片 44.5 秒（+48%），
   * 而 E3 当时算出的是 30.0/30 完美。
   */
  it('E8 时长低于 provider 档位下限', () => {
    const seedance = { ...ctx, minShotSec: 4 }
    const d = draft(18)
    d.scenes[2]!.shots[3] = shot({ durationSec: 2 })
    expect(lintShotlist(d, seedance).errors.join()).toMatch(
      /第 3 场第 4 镜（全集第 16 镜） 时长 2 秒低于当前 provider 的档位下限 4 秒/,
    )
    // 正好等于下限是合法的——写成 `<=` 的话这条才会红
    const ok = draft(18)
    ok.scenes[2]!.shots[3] = shot({ durationSec: 4 })
    expect(lintShotlist(ok, seedance).errors.join()).not.toMatch(/档位下限/)
    // 档位细的模型（wan 支持 2 秒）不该被误伤
    expect(lintShotlist(d, { ...ctx, minShotSec: 2 }).errors.join()).not.toMatch(/档位下限/)
  })

  it('E5 三人以上同框，并回显是哪三个', () => {
    const d = draft(18)
    /*
     * 放在第 3 场第 4 镜（全集第 16 镜）而不是 (1,1,1)。
     *
     * `at()` 印的三个数在第一镜上**全都等于 1**，于是把场号镜号对调、或者把
     * 全集号印成场内序号，断言照样绿。三个数互不相等的位置才分辨得出来。
     */
    d.scenes[2]!.shots[3] = shot({ characterNames: ['Lena', 'Marcus', 'Ray'] })
    expect(lintShotlist(d, ctx).errors.join()).toMatch(
      /第 3 场第 4 镜（全集第 16 镜） 有 3 个角色同框（Lena、Marcus、Ray）/,
    )
    // 两人是允许的
    const two = draft(18)
    two.scenes[0]!.shots[0] = shot({ characterNames: ['Lena', 'Marcus'] })
    expect(lintShotlist(two, ctx).errors.join()).not.toMatch(/同框/)
  })

  /**
   * E7 · 照抄 system prompt 里那条案例的占位符。
   *
   * `characterNames` 有 enum + 受限解码双重挡着，`<A>` 进不去；**这三个文本字段
   * 一层都没有**——而它们会一路进库、进 t2v prompt，烧掉 $2–11 的视频钱。
   * 所以是 error 不是 warning：那一轮免费的修复正好用来换掉它。
   */
  it('E7 抄了案例里的占位符，三个文本字段各自都要抓得到', () => {
    for (const field of ['action', 'emotion', 'dialogue'] as const) {
      const d = draft(18)
      d.scenes[2]!.shots[3] = shot({ [field]: '<A> waits' })
      expect(lintShotlist(d, ctx).errors.join(), `${field} 里的占位符没被抓到`).toMatch(
        /第 3 场第 4 镜（全集第 16 镜） 抄了案例里的占位符/,
      )
    }
    // 干净的稿子不该被误伤
    expect(lintShotlist(draft(18), ctx).errors.join()).not.toMatch(/占位符/)
  })
})

/**
 * **不可能达成的目标要在花钱之前就说。**
 *
 * 下限此前写死成 schema 的 1 秒，而没有一家真能产出 1 秒。真机实测：
 * `targetDurationSec: 30` 配上「至少 10 镜」，在 seedance（4 秒起）上最短也要
 * 40 秒——这道闸当时放行了，E3 还算出 30.0/30 完美，一直到成片 44.5 秒才露出来。
 */
describe('targetOutOfReach 用的是 provider 的档位下限', () => {
  it('30 秒目标在 seedance（4 秒起）上够不着，但不拦生成', () => {
    const msg = targetOutOfReach(30, 4)
    expect(msg, 'seedance 上 10 镜 × 4 秒 = 40 秒 > 30 × 1.15').toBeTruthy()
    expect(msg).toMatch(/最短 4 秒一镜/)
    expect(msg, '语气要是提示不是拦截——时长是输出不是输入').toMatch(/生成照常进行/)
    expect(msg, '要给出目标该调到多少').toMatch(/35 秒以上/)
    expect(msg, '换模型是另一条路，要说出来').toMatch(/wan/)
  })

  it('同一个 30 秒目标在 wan（2 秒起）上是可以达成的', () => {
    expect(targetOutOfReach(30, 2), '10 镜 × 2 秒 = 20 秒 < 34.5，够得着').toBeNull()
  })

  it('不传下限时退回 1 秒——旧调用方的行为不变', () => {
    expect(targetOutOfReach(30)).toBeNull()
  })
})

describe('lintShotlist · warnings（只标黄，不重试）', () => {
  it('W1 连续三镜同景别，且跨场次也算', () => {
    // 三镜同景别落在两场的交界上——成片里它们就是相邻的
    const d: ShotlistDraft = {
      scenes: [
        { shots: [shot({ shotType: 'ws' }), shot({ shotType: 'cu' }), shot({ shotType: 'cu' })] },
        { shots: [shot({ shotType: 'cu' }), shot({ shotType: 'ms' })] },
        {
          shots: Array.from({ length: 13 }, (_, i) =>
            shot({ shotType: (['ms', 'cu', 'ws'] as const)[i % 3]! }),
          ),
        },
      ],
    }
    const r = lintShotlist(d, ctx)
    // 区间起止也要断言：起点写成 shots[i-1] 会印成「第 3–4 镜连续 3 个」，自相矛盾
    expect(r.warnings.join(), '跨场次的连续同景别没被抓到').toMatch(/全集第 2–4 镜连续 3 个 cu/)
    expect(r.errors, 'W1 是 warning，不该触发重试').toEqual([])
  })

  it('W1 只报一次，不为第 4、5 个连续镜头重复报', () => {
    const d = draft(18, 3, { shotType: 'cu' })
    // 18 镜全同景别，但只在第一次达到 3 连时报——重复刷屏会淹掉别的告警
    expect(lintShotlist(d, ctx).warnings.filter((w) => /连续 3 个/.test(w))).toHaveLength(1)
  })

  it('W2 否定式描述——13 §4.5 的「最贵的一条教训」', () => {
    const d = draft(18)
    d.scenes[0]!.shots[0] = shot({ action: 'her hands are empty, no weapon' })
    const r = lintShotlist(d, ctx)
    expect(r.warnings.join()).toMatch(/否定式描述/)
    expect(r.errors).toEqual([])
    // 单词边界：Nolan / another 这类含 no/not 的词不该误报
    const clean = draft(18)
    clean.scenes[0]!.shots[0] = shot({ action: 'Nolan turns to another notebook' })
    expect(lintShotlist(clean, ctx).warnings.join()).not.toMatch(/否定式/)
  })

  it('W2 也查 emotion，也查中文', () => {
    const emo = draft(18)
    emo.scenes[1]!.shots[0] = shot({ emotion: 'avoid eye contact' })
    expect(lintShotlist(emo, ctx).warnings.join(), 'emotion 分支没生效').toMatch(
      /第 2 场第 1 镜[^]*avoid eye contact/,
    )
    const zh = draft(18)
    zh.scenes[0]!.shots[0] = shot({ action: '她不要那把椅子' })
    expect(lintShotlist(zh, ctx).warnings.join(), '中文分支没生效').toMatch(/否定式描述（她不要那把椅子）/)
  })

  /** `shotlist.ts` 花七行论证「不查 dialogue」——那个决定本身得有守卫 */
  it('W2 刻意不查 dialogue：「我没有拿枪」是合法台词', () => {
    const d = draft(18)
    d.scenes[0]!.shots[0] = shot({ dialogue: '我没有拿枪', characterNames: ['Lena'] })
    expect(lintShotlist(d, ctx).warnings).toEqual([])
  })

  /** 「无」裸用会打中「无人机」，而「无人机航拍」是 13 机位词汇表的标准词 */
  it('W2 不把无人机当否定式', () => {
    const d = draft(18)
    d.scenes[0]!.shots[0] = shot({ action: '无人机航拍城市夜景，从 8 米推到 4 米' })
    expect(lintShotlist(d, ctx).warnings).toEqual([])
    // 但「无人的走廊」仍该告警——收窄的是 `无人机`，不是整条中文分支
    const empty = draft(18)
    empty.scenes[0]!.shots[0] = shot({ action: '无人的走廊' })
    expect(lintShotlist(empty, ctx).warnings.join()).toMatch(/否定式/)
  })

  it('多条 error 齐发，互不吞噬也不重复', () => {
    const d = draft(30, 5, { durationSec: 9 })
    d.scenes[0]!.shots[0] = shot({ dialogue: '谁在那', characterNames: [] })
    d.scenes[0]!.shots[1] = shot({ characterNames: ['Lena', 'Marcus', 'Ray'] })
    // E1 场数 + E2 镜数 + E4 空镜说话 + E5 三人同框，各一条。
    // **时长不在里面**：它是 W3 了，同一份稿子的偏差只标黄
    expect(lintShotlist(d, ctx).errors).toHaveLength(4)
    expect(lintShotlist(d, ctx).warnings.join(), '时长偏差要出现在 warning 那一侧').toMatch(/总时长/)
  })
})

/**
 * seed 的 12 镜夹具**过不了 E3**——这是刻意的，不是 bug。（只有 E3：12 落在
 * [10, 25] 内，镜头数其实合法。）
 *
 * `seed.ts` 自己写着「12 镜是刻意的最小夹具，不是规模口径」。lint 只校验 LLM
 * 的输出，不跑在 seed 上。这条用例是那句话的活文档：哪天有人把 lint 接到 seed
 * 上，它会立刻提醒为什么不该那么做。
 */
describe('seed 的 12 镜夹具是刻意的最小规模，只会被 W3 标黄', () => {
  it('12 镜 42.5 秒 vs 目标 75 秒 → 只标黄，不判错', () => {
    const durs = [4, 3, 4, 3.5, 4, 3, 2.5, 4, 4, 3.5, 4, 3]
    const kinds = [
      'establishing',
      'ms',
      'cu',
      'ots',
      'ws',
      'cu',
      'ecu',
      'ms',
      'establishing',
      'ms',
      'ots',
      'cu',
    ] as const
    const d: ShotlistDraft = {
      scenes: [0, 1, 2].map((si) => ({
        shots: durs
          .slice(si * 4, si * 4 + 4)
          .map((dur, i) => shot({ durationSec: dur, shotType: kinds[si * 4 + i]! })),
      })),
    }
    expect(durs.reduce((a, b) => a + b, 0)).toBe(42.5)

    const r = lintShotlist(d, { sceneCount: 3, targetDurationSec: 75, minShotSec: 2 })
    expect(r.errors, '12 镜 42.5 秒是合法的一集——短，但不该判错').toEqual([])
    expect(r.warnings.join(), '42.5s vs 75s 偏差 −43%，W3 要标出来').toMatch(/总时长 42.5 秒/)
    expect(r.warnings.join()).toMatch(/-43%/)
  })
})
