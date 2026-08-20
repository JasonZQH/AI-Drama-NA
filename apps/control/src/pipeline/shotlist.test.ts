import { shotlistDraft, toIntent, type ShotlistDraft } from '@ai-drama/contracts'
import { describe, expect, it } from 'vitest'
import { lintShotlist } from './shotlist.js'

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

const ctx = { sceneCount: 3, targetDurationSec: 72 }

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

  it('E1 场次数对不上', () => {
    const r = lintShotlist(draft(18, 2), ctx)
    expect(r.errors.join()).toMatch(/场次数不对/)
  })

  it('E2 镜头数越界，且提示方向相反', () => {
    expect(lintShotlist(draft(9, 3, { durationSec: 8 }), ctx).errors.join()).toMatch(/把长镜头拆开/)
    expect(lintShotlist(draft(26, 3, { durationSec: 2.77 }), ctx).errors.join()).toMatch(/合并相邻的同类镜头/)
    // 边界 10 与 25 是合法的，不能是开区间
    expect(lintShotlist(draft(10, 3, { durationSec: 7.2 }), ctx).errors.join()).not.toMatch(/镜头总数/)
    expect(lintShotlist(draft(25, 3, { durationSec: 2.88 }), ctx).errors.join()).not.toMatch(/镜头总数/)
  })

  it('E3 总时长偏离 >±15%，两个方向的提示不一样', () => {
    expect(lintShotlist(draft(18, 3, { durationSec: 6 }), ctx).errors.join()).toMatch(/缩短镜头/)
    expect(lintShotlist(draft(18, 3, { durationSec: 2 }), ctx).errors.join()).toMatch(/加长镜头/)
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
  it('恰好 ±15% 是合法的，多一点点就不是', () => {
    const c = { sceneCount: 3, targetDurationSec: 80 }
    expect(16 * 5.75).toBe(92) // 前提：这一步没有浮点误差
    expect(lintShotlist(draft(16, 3, { durationSec: 5.75 }), c).errors.join()).not.toMatch(/总时长/)
    // 再多 0.25 秒/镜就越界
    expect(lintShotlist(draft(16, 3, { durationSec: 6 }), c).errors.join()).toMatch(/总时长/)
  })

  it('E4 空镜说话——TTS 取不到 voiceId 会配出无人称旁白', () => {
    const d = draft(18)
    d.scenes[0]!.shots[0] = shot({ dialogue: '还是那把椅子。', characterNames: [] })
    const r = lintShotlist(d, ctx)
    expect(r.errors.join()).toMatch(/有台词.*characterNames 是空的/)
    // 报错要指到具体位置，模型才改得准
    expect(r.errors.join()).toMatch(/第 1 场第 1 镜（全集第 1 镜）/)
  })

  it('E5 三人以上同框', () => {
    const d = draft(18)
    d.scenes[0]!.shots[0] = shot({ characterNames: ['Lena', 'Marcus', 'Ray'] })
    expect(lintShotlist(d, ctx).errors.join()).toMatch(/3 个角色同框/)
    // 两人是允许的
    const two = draft(18)
    two.scenes[0]!.shots[0] = shot({ characterNames: ['Lena', 'Marcus'] })
    expect(lintShotlist(two, ctx).errors.join()).not.toMatch(/同框/)
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
    expect(r.warnings.join(), '跨场次的连续同景别没被抓到').toMatch(/连续 3 个 cu/)
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
})

/**
 * seed 的 12 镜夹具**过不了** E2/E3——这是刻意的，不是 bug。
 *
 * `seed.ts` 自己写着「12 镜是刻意的最小夹具，不是规模口径」。lint 只校验 LLM
 * 的输出，不跑在 seed 上。这条用例是那句话的活文档：哪天有人把 lint 接到 seed
 * 上，它会立刻提醒为什么不该那么做。
 */
describe('seed 的 12 镜夹具是刻意的最小规模，过不了集级判据', () => {
  it('12 镜 42.5 秒 vs 目标 75 秒 → E2 与 E3 都触发', () => {
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

    const r = lintShotlist(d, { sceneCount: 3, targetDurationSec: 75 })
    expect(r.errors.join(), '12 < 10 不成立，镜头数其实是合法的').not.toMatch(/镜头总数/)
    expect(r.errors.join(), '42.5s vs 75s 偏差 −43%，必须被 E3 抓到').toMatch(/总时长 42.5 秒/)
    expect(r.errors.join()).toMatch(/-43%/)
  })
})
