'use client'

import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, usd, type Overview } from '@/lib/api'
import { EventBusProvider, useEventBus, type StudioEvent } from '@/lib/events'
import { MAX_TABS, TabsProvider, tabId, useTabs, type Tab } from '@/lib/tabs'
import Dashboard from './Dashboard'
import EpisodeView from './EpisodeView'
import ProjectView from './ProjectView'

gsap.registerPlugin(useGSAP)

/** 待办点击时要带过去的落点：筛到哪一档、盯哪一镜 */
type Focus = { filter?: string; shotId?: string }

export default function Workspace(): React.ReactElement {
  return (
    <TabsProvider>
      <Shell />
    </TabsProvider>
  )
}

function Shell(): React.ReactElement {
  const { tabs, activeId, open, close, activate, rename, evicted, dismissEvicted } = useTabs()
  const { connected, subscribe } = useEventBus()

  const openProject = useCallback(
    (id: string, title: string) => open({ id: tabId.project(id), kind: 'project', title, entityId: id }),
    [open],
  )
  const openEpisode = useCallback(
    (episodeId: string, projectId: string, title: string, focus?: Focus) =>
      open({
        id: tabId.episode(episodeId, projectId),
        kind: 'episode',
        title,
        entityId: episodeId,
        projectId,
        // at 每次都不同，标签已开着时也能重新聚焦到新的待办
        ...(focus ? { focus: { ...focus, at: Date.now() } } : {}),
      }),
    [open],
  )

  return (
    <EventBusProvider value={subscribe}>
      <div className="flex h-screen flex-col">
        <TopBar connected={connected} subscribe={subscribe} />
        <TabBar tabs={tabs} activeId={activeId} onActivate={activate} onClose={close} />
        <Panels
          tabs={tabs}
          activeId={activeId}
          onOpenProject={openProject}
          onOpenEpisode={openEpisode}
          onRename={rename}
        />
        {evicted && <EvictedToast title={evicted} onDismiss={dismissEvicted} />}
      </div>
    </EventBusProvider>
  )
}

/**
 * 顶栏常驻生产状态（07 §2 R1：进度必须可读）。
 *
 * 它是全局的，所以放在外壳而不是各标签里——切到项目页时不该看不见队列在跑。
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

  return (
    <header
      className="flex h-11 shrink-0 items-center gap-4 px-4"
      style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}
    >
      <span className="font-medium tracking-tight">ai-drama-studio</span>

      <div className="flex items-center gap-3 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
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
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span
          className="text-[12px] tnum"
          style={{ color: hot ? 'var(--status-review)' : 'var(--text-secondary)' }}
        >
          今日 {usd(spent)} / {usd(limit)}
        </span>
        <div className="h-1 w-28 overflow-hidden rounded-sm" style={{ background: 'var(--bg-inset)' }}>
          <div
            className="h-full transition-[width] duration-500"
            style={{ width: `${pct}%`, background: hot ? 'var(--status-review)' : 'var(--status-success)' }}
          />
        </div>
        <span
          title={connected ? '实时连接正常' : '实时连接已断开，正在重连'}
          className="ml-1 text-[11px]"
          style={{ color: connected ? 'var(--status-success)' : 'var(--status-error)' }}
        >
          {connected ? '● 实时' : '● 重连中'}
        </span>
      </div>
    </header>
  )
}

function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
}: {
  tabs: readonly Tab[]
  activeId: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
}): React.ReactElement {
  // Ctrl/Cmd+1..9 直达。工具类应用键盘优先（07 §1）
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > 9) return
      const t = tabs[n - 1]
      if (!t) return
      e.preventDefault()
      onActivate(t.id)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [tabs, onActivate])

  return (
    <nav
      className="flex h-9 shrink-0 items-stretch overflow-x-auto"
      style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-base)' }}
      aria-label="打开的标签"
    >
      {tabs.map((t, i) => {
        const active = t.id === activeId
        return (
          <div
            key={t.id}
            className="group relative flex shrink-0 items-center"
            style={{
              borderRight: '1px solid var(--border)',
              background: active ? 'var(--bg-surface)' : 'transparent',
            }}
          >
            <button
              type="button"
              onClick={() => onActivate(t.id)}
              className="max-w-[200px] truncate px-3 py-1.5 text-left text-[12px] transition-colors"
              style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}
              title={i < 9 ? `${t.title}（⌘${i + 1}）` : t.title}
              aria-current={active ? 'page' : undefined}
            >
              {t.title}
            </button>
            {t.kind !== 'home' && (
              <button
                type="button"
                onClick={() => onClose(t.id)}
                className="mr-1.5 rounded-sm px-1 text-[12px] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                style={{ color: 'var(--text-muted)' }}
                aria-label={`关闭 ${t.title}`}
              >
                ✕
              </button>
            )}
            {active && (
              <span
                className="absolute inset-x-0 bottom-0 h-[2px]"
                style={{ background: 'var(--accent)' }}
                aria-hidden
              />
            )}
          </div>
        )
      })}
      <span
        className="ml-auto shrink-0 self-center px-3 text-[11px] tnum"
        style={{ color: 'var(--text-muted)' }}
      >
        {tabs.length}/{MAX_TABS}
      </span>
    </nav>
  )
}

/**
 * 全挂载 + display:none。
 *
 * 用 display 而不是卸载，是因为状态保留正是多标签存在的理由；用 display 而不是
 * visibility/opacity，是为了让隐藏标签退出布局与命中测试，虚拟化列表也不会
 * 在零高度容器里瞎算。
 */
function Panels({
  tabs,
  activeId,
  onOpenProject,
  onOpenEpisode,
  onRename,
}: {
  tabs: readonly Tab[]
  activeId: string
  onOpenProject: (id: string, title: string) => void
  onOpenEpisode: (episodeId: string, projectId: string, title: string, focus?: Focus) => void
  onRename: (id: string, title: string) => void
}): React.ReactElement {
  const root = useRef<HTMLDivElement>(null)

  // 切换时给新面板一点位移。唯一的编排时刻留给趋势曲线，这里只做最小提示
  useGSAP(
    () => {
      const el = root.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(activeId)}"]`)
      if (!el) return
      const mm = gsap.matchMedia()
      mm.add({ ok: '(prefers-reduced-motion: no-preference)' }, (ctx) => {
        if (!ctx.conditions?.['ok']) return
        gsap.fromTo(el, { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: 0.18, ease: 'power2.out' })
      })
      return () => mm.revert()
    },
    { scope: root, dependencies: [activeId] },
  )

  return (
    <div ref={root} className="min-h-0 flex-1">
      {/*
        滚动条归各面板自己管，这一层只裁剪。
        外层也 overflow-y-auto 的话 episode 标签会套两层滚动容器——目前能跑，
        但虚拟化是拿这个容器量视口高度的，双滚动一旦成立就会量错。
      */}
      {tabs.map((t) => (
        <div
          key={t.id}
          data-tab={t.id}
          className="h-full overflow-hidden"
          {...(t.id === activeId ? {} : { style: { display: 'none' } })}
        >
          {t.kind === 'home' && <Dashboard onOpenProject={onOpenProject} onOpenEpisode={onOpenEpisode} />}
          {t.kind === 'project' && t.entityId && (
            <ProjectView
              projectId={t.entityId}
              onOpenEpisode={(episodeId, title) => onOpenEpisode(episodeId, t.entityId ?? '', title)}
              onTitle={(title) => onRename(t.id, title)}
            />
          )}
          {t.kind === 'episode' && t.entityId && (
            <EpisodeView
              episodeId={t.entityId}
              projectId={t.projectId ?? ''}
              onTitle={(title) => onRename(t.id, title)}
              {...(t.focus ? { focus: t.focus } : {})}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function EvictedToast({ title, onDismiss }: { title: string; onDismiss: () => void }): React.ReactElement {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000)
    return () => clearTimeout(t)
  }, [onDismiss])

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-md px-4 py-2 text-[12px]"
      style={{
        background: 'var(--bg-raised)',
        border: '1px solid var(--border-strong)',
        boxShadow: 'var(--shadow-overlay)',
      }}
    >
      已达 {MAX_TABS} 个标签上限，关闭了最久未用的「{title}」
      <button type="button" onClick={onDismiss} className="ml-3" style={{ color: 'var(--text-muted)' }}>
        知道了
      </button>
    </div>
  )
}
