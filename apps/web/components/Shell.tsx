'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, usd, type Overview } from '@/lib/api'
import { useEventBus, type StudioEvent } from '@/lib/events'
import { MockChip } from './Mock'

/**
 * 管理面板外壳：顶栏 + 侧边栏 + 一屏高的内容区。
 *
 * **不滚动是硬约束，不是审美。** 外壳 `h-screen overflow-hidden`，内容区
 * `min-h-0 flex-1`；需要滚的列表各自在自己那一格里滚。页面整体一滚，顶栏的
 * 队列与预算就会被推出视野，而那两个数字正是「随时能瞥一眼」才有价值。
 *
 * 导航一律走真实路由，项目/分集在**新浏览器标签**打开——所以这里没有应用内
 * 标签栈，也没有 LRU。代价是每个浏览器标签一条 SSE，这是浏览器标签的固有成本。
 *
 * SSE 的 provider 在根 layout，不在这里：分集页自己渲染 Shell，provider 放这层
 * 会让它的 useStudioEvent 落在 context 之上，一条事件也收不到。
 */
export function Shell({
  nav,
  children,
}: {
  /** 侧边栏的上下文区块（如「当前项目」），由各页面提供 */
  nav?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  const { connected, subscribe } = useEventBus()

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar connected={connected} subscribe={subscribe} />
      <div className="flex min-h-0 flex-1">
        <Sidebar>{nav}</Sidebar>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  )
}

function Sidebar({ children }: { children?: React.ReactNode }): React.ReactElement {
  return (
    <nav
      className="flex w-[180px] shrink-0 flex-col overflow-y-auto py-2"
      style={{ borderRight: '1px solid var(--border)', background: 'var(--bg-surface)' }}
      aria-label="主导航"
    >
      <SideGroup title="全局">
        <SideLink href="/" label="工作台" glyph="▤" />
        <SideLink href="/keys" label="密钥" glyph="⚿" />
      </SideGroup>
      {children}
      <div className="mt-auto px-3 pt-4">
        <div className="text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>
          M0 · mock provider
        </div>
      </div>
    </nav>
  )
}

export function SideGroup({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="mb-3">
      <div className="mb-1 px-3 text-[10px] tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {title}
      </div>
      {children}
    </div>
  )
}

export function SideLink({
  href,
  label,
  glyph,
  count,
  active,
  newTab,
}: {
  href: string
  label: string
  glyph?: string
  count?: number
  active?: boolean
  /** 项目与分集开新浏览器标签，其余站内跳转 */
  newTab?: boolean
}): React.ReactElement {
  return (
    <a
      href={href}
      {...(newTab ? { target: '_blank', rel: 'noopener' } : {})}
      className="flex items-center gap-2 px-3 py-1.5 text-[12px]"
      style={{
        background: active ? 'var(--accent-subtle)' : 'transparent',
        color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
      }}
      {...(active ? { 'aria-current': 'page' as const } : {})}
    >
      {glyph && (
        <span aria-hidden className="shrink-0">
          {glyph}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="tnum shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {count}
        </span>
      )}
      {newTab && (
        <span aria-hidden className="shrink-0 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          ↗
        </span>
      )}
    </a>
  )
}

/**
 * 顶栏常驻生产状态（07 §2 R1：进度必须可读）。
 * 它是全局的，所以在外壳里——切到项目页时不该看不见队列在跑。
 */
function TopBar({
  connected,
  subscribe,
}: {
  connected: boolean
  subscribe: (fn: (e: StudioEvent) => void) => () => void
}): React.ReactElement {
  const [ov, setOv] = useState<Overview | null>(null)

  const reload = useCallback(() => {
    void api<Overview>('/api/stats/overview')
      .then(setOv)
      .catch(() => setOv(null))
  }, [])

  useEffect(reload, [reload])

  // 事件驱动刷新，但攒 800ms 再发一次请求——整集生成时事件是几十条连着来的
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    return subscribe(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(reload, 800)
    })
  }, [subscribe, reload])

  const spent = ov?.budget.spentTodayMicroUsd ?? 0
  const limit = ov?.budget.dailyLimitMicroUsd ?? 0
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0
  const hot = pct >= 80
  const allMock = !!ov && ov.totals.mockCostMicroUsd >= ov.totals.costMicroUsd && ov.totals.costMicroUsd > 0

  return (
    <header
      className="flex h-10 shrink-0 items-center gap-4 px-3"
      style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}
    >
      <span className="font-medium tracking-tight">ai-drama-studio</span>

      {/* 全是演示数据这件事要常驻，不能只在某一页说一次 */}
      {allMock && (
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <MockChip />
          全部成本由 mock provider 生成，非真实计费
        </span>
      )}

      <div className="ml-auto flex items-center gap-3 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        <span className="inline-flex items-center gap-1.5">
          <span
            className={ov && ov.queue.running > 0 ? 'pulse' : undefined}
            style={{ color: 'var(--status-running)' }}
            aria-hidden
          >
            ⚡
          </span>
          <span className="tnum">{ov?.queue.running ?? 0}</span> 生成中
        </span>
        <span>
          <span className="tnum">{ov?.queue.queued ?? 0}</span> 排队
        </span>
        <span className="tnum" style={{ color: hot ? 'var(--status-review)' : 'var(--text-secondary)' }}>
          今日 {usd(spent)} / {usd(limit)}
        </span>
        <div className="h-1 w-20 overflow-hidden rounded-sm" style={{ background: 'var(--bg-inset)' }}>
          <div
            className="h-full transition-[width] duration-500"
            style={{ width: `${pct}%`, background: hot ? 'var(--status-review)' : 'var(--status-success)' }}
          />
        </div>
        <span
          title={connected ? '实时连接正常' : '实时连接已断开，正在重连'}
          className="text-[11px]"
          style={{ color: connected ? 'var(--status-success)' : 'var(--status-error)' }}
        >
          {connected ? '● 实时' : '● 重连中'}
        </span>
      </div>
    </header>
  )
}

/** 页面标题条。每页一条，高度固定，属于「不滚动」预算的一部分 */
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <header
      className="flex h-11 shrink-0 items-center gap-3 px-4"
      style={{ borderBottom: '1px solid var(--border)' }}
    >
      <h1 className="shrink-0 text-[15px] font-medium">{title}</h1>
      {subtitle && (
        <span className="min-w-0 truncate text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {subtitle}
        </span>
      )}
      <span className="flex-1" />
      {children}
    </header>
  )
}
