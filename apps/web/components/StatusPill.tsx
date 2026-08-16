/**
 * 状态胶囊（07-design-system.md §6.1）。
 *
 * **每个状态色必须配一个图标或文字标签**——只靠颜色区分对色觉障碍用户
 * 不可用，何况 running 和 accent 是同一个蓝。
 *
 * 四套词表分开，不能合成一张表：`draft` 在 ShotStatus 里是「intent 未完成」，
 * 在 ProjectStatus 里是「草稿」，`producing` 只存在于项目与分集。合表会让
 * 已发布的一集显示成「待完善」——把做完的东西标成没做完，比不显示还糟。
 */
type Entry = { label: string; color: string; glyph: string; pulse?: boolean }

const SHOT: Record<string, Entry> = {
  draft: { label: '待完善', color: 'var(--status-idle)', glyph: '○' },
  ready: { label: '待生成', color: 'var(--status-idle)', glyph: '●' },
  generating: { label: '生成中', color: 'var(--status-running)', glyph: '◐', pulse: true },
  review: { label: '待选片', color: 'var(--status-review)', glyph: '⚑' },
  locked: { label: '已锁定', color: 'var(--status-success)', glyph: '✓' },
  failed: { label: '失败', color: 'var(--status-error)', glyph: '✕' },
  skipped: { label: '已跳过', color: 'var(--status-cancelled)', glyph: '⊘' },
}

const PROJECT: Record<string, Entry> = {
  draft: { label: '草稿', color: 'var(--status-idle)', glyph: '○' },
  producing: { label: '制作中', color: 'var(--status-running)', glyph: '◐' },
  completed: { label: '已完成', color: 'var(--status-success)', glyph: '✓' },
  archived: { label: '已归档', color: 'var(--status-cancelled)', glyph: '⊘' },
}

const EPISODE: Record<string, Entry> = {
  outline: { label: '大纲', color: 'var(--status-idle)', glyph: '○' },
  scripted: { label: '已成稿', color: 'var(--status-idle)', glyph: '✎' },
  shotlisted: { label: '已分镜', color: 'var(--status-idle)', glyph: '▤' },
  producing: { label: '制作中', color: 'var(--status-running)', glyph: '◐' },
  assembled: { label: '已成片', color: 'var(--status-success)', glyph: '✓' },
  published: { label: '已发布', color: 'var(--status-success)', glyph: '★' },
}

const JOB: Record<string, Entry> = {
  queued: { label: '排队中', color: 'var(--status-idle)', glyph: '○' },
  submitted: { label: '已提交', color: 'var(--status-running)', glyph: '↑' },
  running: { label: '生成中', color: 'var(--status-running)', glyph: '◐', pulse: true },
  downloading: { label: '下载中', color: 'var(--status-running)', glyph: '↓' },
  evaluating: { label: '评估中', color: 'var(--status-running)', glyph: '◎' },
  succeeded: { label: '成功', color: 'var(--status-success)', glyph: '✓' },
  failed: { label: '失败', color: 'var(--status-error)', glyph: '✕' },
  cancelled: { label: '已取消', color: 'var(--status-cancelled)', glyph: '⊘' },
}

/**
 * 一致性资产只有「锁没锁」这一个状态（13-character-assets.md §3 的闸门）。
 * 未锁定不是错误也不是「待完善」——资产可能已经画完了只是还没定版，
 * 借用镜头词表会把这件正常的事说成没做完。
 */
const ASSET: Record<string, Entry> = {
  locked: { label: '已锁定', color: 'var(--status-success)', glyph: '✓' },
  unlocked: { label: '未锁定', color: 'var(--status-idle)', glyph: '○' },
}

export type StatusKind = 'shot' | 'project' | 'episode' | 'job' | 'asset'

const TABLES: Record<StatusKind, Record<string, Entry>> = {
  shot: SHOT,
  project: PROJECT,
  episode: EPISODE,
  job: JOB,
  asset: ASSET,
}

/**
 * 词表里没有的取值原样显示、走中性色。
 * 静默兜底成某个已知状态会说谎——不认识就说不认识。
 */
function lookup(kind: StatusKind, status: string): Entry {
  return TABLES[kind][status] ?? { label: status, color: 'var(--status-idle)', glyph: '·' }
}

export function statusColor(status: string, kind: StatusKind = 'shot'): string {
  return lookup(kind, status).color
}

export function StatusPill({
  status,
  count,
  kind = 'shot',
}: {
  status: string
  count?: number
  kind?: StatusKind
}): React.ReactElement {
  const m = lookup(kind, status)
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
