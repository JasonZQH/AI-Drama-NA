/**
 * 状态胶囊（07-design-system.md §6.1）。
 *
 * **每个状态色必须配一个图标或文字标签**——只靠颜色区分对色觉障碍用户
 * 不可用，何况 running 和 accent 是同一个蓝。
 */
const MAP: Record<string, { label: string; color: string; glyph: string; pulse?: boolean }> = {
  draft: { label: '待完善', color: 'var(--status-idle)', glyph: '○' },
  ready: { label: '待生成', color: 'var(--status-idle)', glyph: '●' },
  generating: { label: '生成中', color: 'var(--status-running)', glyph: '◐', pulse: true },
  review: { label: '待选片', color: 'var(--status-review)', glyph: '⚑' },
  locked: { label: '已锁定', color: 'var(--status-success)', glyph: '✓' },
  failed: { label: '失败', color: 'var(--status-error)', glyph: '✕' },
  skipped: { label: '已跳过', color: 'var(--status-cancelled)', glyph: '⊘' },
}

export function statusColor(status: string): string {
  return MAP[status]?.color ?? 'var(--status-idle)'
}

export function StatusPill({ status, count }: { status: string; count?: number }): React.ReactElement {
  const m = MAP[status] ?? MAP['draft']!
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] leading-4"
      style={{ background: 'color-mix(in srgb, var(--bg-raised) 85%, transparent)', color: m.color }}
      title={status}
    >
      <span className={m.pulse ? 'pulse' : undefined} aria-hidden>
        {m.glyph}
      </span>
      <span>{m.label}</span>
      {count !== undefined && count > 0 && <span className="tnum">{count}</span>}
    </span>
  )
}

/**
 * 进度条。优先 determinate——任何超过 2 秒的操作都必须有真实进度，
 * 转圈在这里等于「系统卡死」（§2 R1）。
 */
export function Progress({ pct, etaMs }: { pct?: number; etaMs?: number }): React.ReactElement {
  const determinate = pct !== undefined
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-sm" style={{ background: 'var(--bg-inset)' }}>
        <div
          className="h-full transition-[width] duration-300"
          style={{
            width: determinate ? `${pct}%` : '30%',
            background: 'var(--status-running)',
          }}
        />
      </div>
      <span className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {determinate ? `${Math.round(pct)}%` : '排队中'}
        {etaMs !== undefined && etaMs > 0 && ` · 约 ${Math.ceil(etaMs / 1000)}s`}
      </span>
    </div>
  )
}
