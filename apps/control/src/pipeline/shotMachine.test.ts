import { ShotStatus, type FailureCode } from '@ai-drama/contracts'
import { describe, expect, it } from 'vitest'
import { TERMINAL_STATUSES, isEnqueueable, transition } from './shotMachine.js'
import type { Effect, ShotEvent, ShotState } from './shotMachine.js'

const SHOT = '00000000-0000-4000-8000-000000000001'
const TAKE = '00000000-0000-4000-8000-000000000002'

const shot = (status: ShotState['status'], over: Partial<ShotState> = {}): ShotState => ({
  id: SHOT,
  status,
  attemptCount: 0,
  selectedTakeId: null,
  ...over,
})

const CTX = { maxAttempts: 4 }

/** 全部事件各取一个代表，用于穷举 */
const ALL_EVENTS: readonly ShotEvent[] = [
  { type: 'intent.completed' },
  { type: 'intent.edited' },
  { type: 'generate.requested' },
  { type: 'take.accepted', takeId: TAKE },
  { type: 'attempt.failed', code: 'provider_error' },
  { type: 'take.selected', takeId: TAKE },
  { type: 'takes.allRejected' },
  { type: 'redo.requested' },
  { type: 'manual.reset' },
  { type: 'skip.requested' },
]

/**
 * 合法迁移的完整真值表。**这张表就是规格**——它之外的一切组合都必须被拒。
 * 键是 `状态|事件`，值是迁移后的状态。
 */
const LEGAL: Record<string, ShotStatus> = {
  'draft|intent.completed': 'ready',
  'draft|skip.requested': 'skipped',

  'ready|generate.requested': 'generating',
  'ready|intent.edited': 'ready',
  'ready|skip.requested': 'skipped',

  'generating|take.accepted': 'review',
  'generating|attempt.failed': 'ready', // attemptCount=0 < maxAttempts，故重试
  'generating|skip.requested': 'skipped',

  'review|take.selected': 'locked',
  'review|takes.allRejected': 'ready',
  'review|take.accepted': 'review',
  'review|intent.edited': 'ready',
  'review|skip.requested': 'skipped',

  // 锁定之后仍然可以换片、可以再生成——两条都不销毁已经付过钱的 take
  'locked|take.selected': 'locked',
  'locked|generate.requested': 'generating',
  'locked|redo.requested': 'ready',
  'locked|intent.edited': 'ready',
  'locked|skip.requested': 'skipped',

  'failed|manual.reset': 'ready',
  'failed|intent.edited': 'ready',
  'failed|skip.requested': 'skipped',

  'skipped|manual.reset': 'ready',
}

/**
 * **锁定之后仍然可以换片、可以再生成。**
 *
 * 原来 `locked` 只接 redo / intent.edited，两条都先把现有成片归档——于是
 * 「这条能用，但我想再试一个」这件常规需求，只能拿一条已经花过钱的片子去赌
 * 下一条；而在几条已付费的 take 之间改主意，本来什么都不该销毁。
 */
describe('locked 上的两条新路', () => {
  const locked = { id: 'sh', status: 'locked' as const, attemptCount: 2, selectedTakeId: 'tk-old' }

  it('换片：停在 locked，只改选中的是哪一条', () => {
    const r = transition(locked, { type: 'take.selected', takeId: 'tk-new' }, { maxAttempts: 4 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.next, '换的是哪一条进成片，不是这一镜做完没有').toBe('locked')
    expect(r.effects).toContainEqual({ type: 'set.selectedTake', shotId: 'sh', takeId: 'tk-new' })
    expect(
      r.effects.some((e) => e.type === 'archive.takes'),
      '换片不销毁任何东西——归档是「重做」干的事',
    ).toBe(false)
  })

  it('再生成：回 generating，attempt 接着数，选中的不动', () => {
    const r = transition(locked, { type: 'generate.requested' }, { maxAttempts: 4 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.next).toBe('generating')
    expect(r.effects).toContainEqual({ type: 'enqueue.generation', shotId: 'sh', attempt: 3 })
    expect(
      r.effects.some((e) => e.type === 'clear.selectedTake' || e.type === 'archive.takes'),
      '旧的要留着——新片子不如它时得选得回来',
    ).toBe(false)
  })

  it('重做仍然归档并清选中——它和「再生成一条」是两件事', () => {
    const r = transition(locked, { type: 'redo.requested' }, { maxAttempts: 4 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.next).toBe('ready')
    expect(r.effects.map((e) => e.type)).toEqual(
      expect.arrayContaining(['clear.selectedTake', 'archive.takes']),
    )
  })
})

describe('穷举全部 状态 × 事件 组合', () => {
  const combos = ShotStatus.options.flatMap((s) => ALL_EVENTS.map((e) => [s, e] as const))

  it(`矩阵是 ${ShotStatus.options.length} 状态 × ${ALL_EVENTS.length} 事件 = ${ShotStatus.options.length * ALL_EVENTS.length} 组`, () => {
    expect(combos).toHaveLength(70)
  })

  it.each(combos)('%s + %o', (status, event) => {
    const result = transition(shot(status), event, CTX)
    const expected = LEGAL[`${status}|${event.type}`]

    if (expected === undefined) {
      // 非法迁移：必须被拒，且给出可读理由（调用方据此回 400）
      expect(result.ok, `${status} + ${event.type} 本应被拒但通过了`).toBe(false)
      if (!result.ok) expect(result.reason).toContain(status)
      return
    }

    expect(result.ok, `${status} + ${event.type} 本应合法但被拒`).toBe(true)
    if (result.ok) expect(result.next).toBe(expected)
  })

  it('真值表里的每一条都真的被覆盖到了（防止表写错了自己不知道）', () => {
    const reachable = new Set(
      combos.filter(([s, e]) => transition(shot(s), e, CTX).ok).map(([s, e]) => `${s}|${e.type}`),
    )
    expect([...reachable].sort()).toEqual(Object.keys(LEGAL).sort())
  })
})

describe('重试降级（05-job-orchestration.md §5）', () => {
  it('未到上限时回 ready，由编排层换 seed/参数/provider 后重新入队', () => {
    const r = transition(
      shot('generating', { attemptCount: 1 }),
      { type: 'attempt.failed', code: 'timeout' },
      CTX,
    )
    expect(r.ok && r.next).toBe('ready')
  })

  it('达到上限即 failed', () => {
    const r = transition(
      shot('generating', { attemptCount: 4 }),
      { type: 'attempt.failed', code: 'timeout' },
      CTX,
    )
    expect(r.ok && r.next).toBe('failed')
  })

  const NON_RETRYABLE: FailureCode[] = [
    'content_filtered',
    'quota_exceeded',
    'invalid_output',
    // 提交结果未知：自动重投可能是第二次付费，必须停下来等人
    'submit_unknown',
  ]
  it.each(NON_RETRYABLE)('%s 直接 failed，不管还剩几次重试——重试它们只会烧配额', (code) => {
    const r = transition(shot('generating', { attemptCount: 0 }), { type: 'attempt.failed', code }, CTX)
    expect(r.ok && r.next).toBe('failed')
  })

  it('可重试的失败码在同样条件下会重试——证明上一条不是因为别的原因', () => {
    const r = transition(
      shot('generating', { attemptCount: 0 }),
      { type: 'attempt.failed', code: 'provider_error' },
      CTX,
    )
    expect(r.ok && r.next).toBe('ready')
  })
})

describe('Effect 是返回的，不是执行的', () => {
  const effects = (r: ReturnType<typeof transition>): readonly Effect[] => (r.ok ? r.effects : [])

  it('入队请求带上递增后的 attempt', () => {
    const r = transition(shot('ready', { attemptCount: 2 }), { type: 'generate.requested' }, CTX)
    expect(effects(r)).toContainEqual({ type: 'enqueue.generation', shotId: SHOT, attempt: 3 })
  })

  it('每次迁移都广播状态，UI 不用轮询', () => {
    const r = transition(shot('draft'), { type: 'intent.completed' }, CTX)
    expect(effects(r)).toContainEqual({
      type: 'publish',
      event: { type: 'shot.status', shotId: SHOT, status: 'ready' },
    })
  })

  it('选片写 selectedTakeId', () => {
    const r = transition(shot('review'), { type: 'take.selected', takeId: TAKE }, CTX)
    expect(effects(r)).toContainEqual({ type: 'set.selectedTake', shotId: SHOT, takeId: TAKE })
  })

  it('重做清 selectedTakeId 并归档 takes——绝不删除已花钱生成的东西（§7）', () => {
    const r = transition(shot('locked', { selectedTakeId: TAKE }), { type: 'redo.requested' }, CTX)
    const e = effects(r)
    expect(e).toContainEqual({ type: 'clear.selectedTake', shotId: SHOT })
    expect(e).toContainEqual({ type: 'archive.takes', shotId: SHOT })
    expect(e.some((x) => x.type.includes('delete'))).toBe(false)
  })

  it('改 intent 归档历史 takes 而非删除', () => {
    const r = transition(shot('review'), { type: 'intent.edited' }, CTX)
    expect(effects(r)).toContainEqual({ type: 'archive.takes', shotId: SHOT })
  })

  it('不可重试的失败会广播错误事件，UI 才能给出可操作的下一步（07 R3）', () => {
    const r = transition(shot('generating'), { type: 'attempt.failed', code: 'content_filtered' }, CTX)
    expect(effects(r).some((e) => e.type === 'publish' && e.event.type === 'error')).toBe(true)
  })
})

describe('纯函数性质', () => {
  it('不修改输入', () => {
    const before = shot('ready', { attemptCount: 2 })
    const snapshot = JSON.stringify(before)
    transition(before, { type: 'generate.requested' }, CTX)
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('同输入同输出，可重复调用', () => {
    const s = shot('review')
    const e: ShotEvent = { type: 'take.selected', takeId: TAKE }
    expect(transition(s, e, CTX)).toEqual(transition(s, e, CTX))
  })
})

describe('辅助判定', () => {
  it('只有 ready 可入队——批量入队的依赖解析靠它', () => {
    for (const s of ShotStatus.options) expect(isEnqueueable(s)).toBe(s === 'ready')
  })

  it('三个终态不会自行迁移，只能被人工事件唤醒', () => {
    const human: ShotEvent[] = [
      { type: 'manual.reset' },
      { type: 'redo.requested' },
      { type: 'intent.edited' },
    ]
    for (const s of TERMINAL_STATUSES) {
      const auto = transition(shot(s), { type: 'attempt.failed', code: 'timeout' }, CTX)
      expect(auto.ok, `${s} 不该接受自动事件`).toBe(false)
      expect(
        human.some((e) => transition(shot(s), e, CTX).ok),
        `${s} 应能被人工唤醒`,
      ).toBe(true)
    }
  })
})
