'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/**
 * 应用内多标签栏（见 docs/superpowers/specs/2026-08-15-web-admin-panel-design.md §3.1）。
 *
 * 采用「全挂载 + CSS 隐藏」：所有打开的标签同时挂载，非活跃的以 hidden 隐藏。
 *
 * **为什么不用「路由驱动 + 状态快照」**：状态保留是多标签这个模式存在的
 * 全部理由，而快照方案只能保留事先想到要存的字段——播到一半的视频、
 * 填了一半的表单、展开的抽屉都会丢，且每加一个有状态的组件都要记得去
 * store 登记一次。
 *
 * 代价是 N 个标签的 DOM 同时存在，所以配两条约束：标签上限 12，
 * 以及镜头网格必须虚拟化。
 */

export const MAX_TABS = 12

export type TabKind = 'home' | 'project' | 'episode'

export interface Tab {
  /** 稳定标识，同时用于 URL 同步 */
  readonly id: string
  readonly kind: TabKind
  readonly title: string
  readonly subtitle?: string
  /** project 或 episode 的 uuid；home 为 null */
  readonly entityId: string | null
  /** 面包屑用：episode 标签要知道自己属于哪个 project */
  readonly projectId?: string
  /**
   * 打开时要落在哪。
   *
   * 规格 §4 对「需要你处理」的要求是「点击直达对应筛选态，不是跳到列表让人
   * 自己找」——所以待办要能把筛选与目标镜头一并带过来。每次 open 都换一个
   * `at` 值，好让目标标签已经开着时也能重新聚焦，而不是静默复用旧位置。
   */
  readonly focus?: { filter?: string; shotId?: string; at: number }
  /** 最近活跃时间，超上限时用它决定关谁 */
  lastActiveAt: number
}

interface TabsApi {
  readonly tabs: readonly Tab[]
  readonly activeId: string
  open(tab: Omit<Tab, 'lastActiveAt'>): void
  close(id: string): void
  activate(id: string): void
  /** 深链恢复的标签只有 id，标题要等面板取到数据后回填 */
  rename(id: string, title: string, subtitle?: string): void
  /** 超上限时被自动关闭的标签标题，用于提示 */
  readonly evicted: string | null
  dismissEvicted(): void
}

const HOME: Tab = { id: 'home', kind: 'home', title: '工作台', entityId: null, lastActiveAt: 0 }

const Ctx = createContext<TabsApi | null>(null)

export function useTabs(): TabsApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTabs 必须在 TabsProvider 之内使用')
  return v
}

export function TabsProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [tabs, setTabs] = useState<Tab[]>([{ ...HOME, lastActiveAt: Date.now() }])
  const [activeId, setActiveId] = useState('home')
  const [evicted, setEvicted] = useState<string | null>(null)

  // URL 同步：刷新与深链都要成立。用 hash 而非 path，因为标签栈是客户端状态，
  // 走 path 会让 Next 卸载并重建整棵树，正好抵消全挂载的意义
  useEffect(() => {
    const fromHash = window.location.hash.slice(1)
    if (fromHash && fromHash !== 'home') {
      const [kind, entityId, ...rest] = fromHash.split(':')
      if ((kind === 'project' || kind === 'episode') && entityId) {
        setTabs((prev) =>
          prev.some((t) => t.id === fromHash)
            ? prev
            : [
                ...prev,
                {
                  id: fromHash,
                  kind,
                  title: '载入中…',
                  entityId,
                  ...(rest[0] ? { projectId: rest[0] } : {}),
                  lastActiveAt: Date.now(),
                },
              ],
        )
        setActiveId(fromHash)
      }
    }
  }, [])

  useEffect(() => {
    const next = activeId === 'home' ? '' : `#${activeId}`
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', next || window.location.pathname)
    }
  }, [activeId])

  const open = useCallback((t: Omit<Tab, 'lastActiveAt'>) => {
    setTabs((prev) => {
      const existing = prev.find((x) => x.id === t.id)
      if (existing) {
        return prev.map((x) => (x.id === t.id ? { ...x, ...t, lastActiveAt: Date.now() } : x))
      }
      const next = [...prev, { ...t, lastActiveAt: Date.now() }]
      if (next.length <= MAX_TABS) return next

      // 超上限：关掉最久未活跃的，但永远不关工作台
      const victim = next
        .filter((x) => x.kind !== 'home' && x.id !== t.id)
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]
      if (!victim) return next
      setEvicted(victim.title)
      return next.filter((x) => x.id !== victim.id)
    })
    setActiveId(t.id)
  }, [])

  const close = useCallback((id: string) => {
    if (id === 'home') return
    setTabs((prev) => {
      const idx = prev.findIndex((x) => x.id === id)
      const next = prev.filter((x) => x.id !== id)
      setActiveId((cur) => (cur === id ? (next[Math.max(0, idx - 1)]?.id ?? 'home') : cur))
      return next
    })
  }, [])

  const activate = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, lastActiveAt: Date.now() } : t)))
    setActiveId(id)
  }, [])

  const rename = useCallback((id: string, title: string, subtitle?: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id && (t.title !== title || t.subtitle !== subtitle)
          ? { ...t, title, ...(subtitle ? { subtitle } : {}) }
          : t,
      ),
    )
  }, [])

  const api = useMemo<TabsApi>(
    () => ({
      tabs,
      activeId,
      open,
      close,
      activate,
      rename,
      evicted,
      dismissEvicted: () => setEvicted(null),
    }),
    [tabs, activeId, open, close, activate, rename, evicted],
  )

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export const tabId = {
  project: (id: string) => `project:${id}`,
  episode: (episodeId: string, projectId: string) => `episode:${episodeId}:${projectId}`,
}
