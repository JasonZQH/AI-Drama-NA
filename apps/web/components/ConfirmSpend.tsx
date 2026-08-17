'use client'

import type { DryRunPlan } from '@/lib/api'
import { usd } from '@/lib/api'

/**
 * 花钱确认弹窗（07-design-system.md §6.3，规则 R2）。
 *
 * 必须显示：影响镜头数、预估成本、当前剩余预算。
 * **确认按钮文案是「生成 18 个镜头（约 $3.60）」而不是「确定」**——
 * 永远不要让用户在不知道价格的情况下点下去。
 */
export function ConfirmSpend({
  plan,
  busy,
  onCancel,
  onConfirm,
}: {
  plan: DryRunPlan
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.ReactElement {
  const remaining = plan.budget.dailyLimitMicroUsd - plan.budget.spentTodayMicroUsd
  const over = plan.budget.wouldExceed
  /*
   * 超预算之后按钮到底能不能点，取决于服务端的策略，不能写死。
   *
   * 08 §2 说「警告但不禁用，决定权在用户」，而服务端默认 BUDGET_ON_EXCEED=block
   * 会直接回 402——此前按钮永远可点，于是这是一条**死路交互**：用户点一个可点的
   * 红按钮，拿到一个错误。两份文档都没错，错在前端没读 onExceed 这个已经返回了的字段。
   */
  const blocked = over && plan.budget.onExceed === 'block'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgb(0 0 0 / 0.6)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cs-title"
    >
      <div
        className="w-full max-w-md rounded-[10px] p-5"
        style={{
          background: 'var(--bg-raised)',
          border: '1px solid var(--border-strong)',
          boxShadow: 'var(--shadow-overlay)',
        }}
      >
        <h2 id="cs-title" className="mb-4 text-[18px] leading-[26px] font-medium">
          生成本集
        </h2>

        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt style={{ color: 'var(--text-secondary)' }}>待生成</dt>
          <dd className="tnum">{plan.planned} 个镜头</dd>

          {plan.skipped > 0 && (
            <>
              <dt style={{ color: 'var(--text-secondary)' }}>跳过</dt>
              <dd className="tnum">{plan.skipped} 个（已锁定或不可生成）</dd>
            </>
          )}

          {plan.blocked > 0 && (
            <>
              <dt style={{ color: 'var(--text-secondary)' }}>依赖阻塞</dt>
              <dd className="tnum">{plan.blocked} 个（等待前序镜头选片）</dd>
            </>
          )}

          <dt style={{ color: 'var(--text-secondary)' }}>预估成本</dt>
          <dd className="tnum font-medium">{usd(plan.estimatedCostMicroUsd)}</dd>

          <dt style={{ color: 'var(--text-secondary)' }}>今日剩余预算</dt>
          <dd className="tnum" style={over ? { color: 'var(--status-error)' } : undefined}>
            {usd(remaining)}
            {over && ' · 将超预算'}
          </dd>
        </dl>

        {blocked && (
          <p className="mb-4 text-[13px] leading-[20px]" style={{ color: 'var(--status-error)' }}>
            日预算闸门当前是 <code>block</code>，这批会被服务端拦下。 调高 <code>BUDGET_DAILY_MICRO_USD</code>
            ，或把 <code>BUDGET_ON_EXCEED</code> 设成 <code>warn</code> 让决定权回到你手上。
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5"
            style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
          >
            取消
          </button>
          {/*
            `warn` 下超预算按钮变红但**不禁用**——是警告不是家长控制，决定权在
            用户（08-screen-specs.md §2）。`block` 下禁用，因为服务端本来就会
            回 402：让用户点一个注定失败的按钮不是尊重决定权，是浪费他一次点击。
          */}
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || plan.planned === 0 || blocked}
            className="rounded-md px-3 py-1.5 font-medium disabled:opacity-50"
            style={{ background: over ? 'var(--status-error)' : 'var(--accent)', color: '#fff' }}
          >
            {busy
              ? '入队中…'
              : blocked
                ? `超出日预算，无法生成（约 ${usd(plan.estimatedCostMicroUsd)}）`
                : `生成 ${plan.planned} 个镜头（约 ${usd(plan.estimatedCostMicroUsd)}）`}
          </button>
        </div>
      </div>
    </div>
  )
}
