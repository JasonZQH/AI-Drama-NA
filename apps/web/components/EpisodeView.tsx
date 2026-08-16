'use client'

import { ConfirmSpend } from '@/components/ConfirmSpend'
import { ShotDrawer } from '@/components/ShotDrawer'
import { ShotGrid, type SceneGroup, type ShotEntry } from '@/components/ShotGrid'
import { statusColor } from '@/components/StatusPill'
import { api, type DryRunPlan, type EpisodeTree } from '@/lib/api'
import { useStudioEvent } from '@/lib/events'
import { tabId, useTabs } from '@/lib/tabs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * 一个 episode 标签页的内容（specs/2026-08-15-web-admin-panel-design.md §3）。
 *
 * 高度由外层标签容器给定——网格自己是滚动容器，虚拟化才有量得到的视口。
 */

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'ready', label: '待生成' },
  { key: 'generating', label: '生成中' },
  { key: 'review', label: '待选片' },
  { key: 'locked', label: '已锁定' },
  { key: 'failed', label: '失败' },
] as const

type FilterKey = (typeof FILTERS)[number]['key']

export default function EpisodeView({
  episodeId,
  projectId,
  onTitle,
  focus,
}: {
  episodeId: string
  projectId: string
  onTitle?: (title: string) => void
  /** 从工作台的待办点过来时的落点：筛到哪一档、直接打开哪一镜的抽屉 */
  focus?: { filter?: string; shotId?: string; at: number }
}): React.ReactElement {
  const [tree, setTree] = useState<EpisodeTree | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [plan, setPlan] = useState<DryRunPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, { pct: number; etaMs?: number }>>({})

  // 面包屑只在父项目标签已经开着时给——不主动 open，否则会用占位标题
  // 覆盖掉那个标签已有的真实标题
  const { tabs, activate } = useTabs()
  const parent = tabs.find((t) => t.id === tabId.project(projectId))

  const load = useCallback(async () => {
    try {
      setTree(await api<EpisodeTree>(`/api/episodes/${episodeId}`))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [episodeId])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * 规格 §4：待办要「直达对应筛选态，不是跳到列表让人自己找」。
   * 依赖是 focus?.at 而非 focus 对象本身——对象每次渲染都是新引用，
   * 挂上去会在用户手动改了筛选之后又被强行拽回来。
   */
  useEffect(() => {
    if (!focus) return
    if (focus.filter && FILTERS.some((f) => f.key === focus.filter)) {
      setFilter(focus.filter as FilterKey)
    }
    if (focus.shotId) setSelectedId(focus.shotId)
  }, [focus?.at])

  const titleCb = useRef(onTitle)
  titleCb.current = onTitle
  useEffect(() => {
    if (tree)
      titleCb.current?.(`第 ${tree.episode.index} 集${tree.episode.title ? ` · ${tree.episode.title}` : ''}`)
  }, [tree])

  /**
   * 一集跑完会连着来几十条 shot.status，逐条 reload 就是几十次全树 GET
   * ——乘以打开的标签数。合并到一次尾随刷新。
   */
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) return
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null
      void load()
    }, 400)
  }, [load])
  useEffect(
    () => () => {
      if (reloadTimer.current !== null) clearTimeout(reloadTimer.current)
    },
    [],
  )

  // 外壳只有一条 SSE，事件是全局广播的：不属于本集的镜头一律不理，
  // 否则每个标签都会被别的项目的事件拖去重新拉一次全树
  const shotIds = useMemo(() => new Set(tree?.shots.map((x) => x.shot.id) ?? []), [tree])
  useStudioEvent((e) => {
    if (e.type === 'job.progress') {
      if (!shotIds.has(e.shotId)) return
      setProgress((p) => ({ ...p, [e.shotId]: { pct: e.pct, ...(e.etaMs ? { etaMs: e.etaMs } : {}) } }))
    } else if (e.type === 'shot.status' || e.type === 'take.created') {
      if (!shotIds.has(e.shotId)) return
      // 状态跃迁了就清掉这一镜的进度条——它已经不在生成中
      setProgress((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== e.shotId)))
      scheduleReload()
    } else if (e.type === 'batch.progress' && e.episodeId === episodeId) {
      scheduleReload()
    }
  })

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const x of tree?.shots ?? []) c[x.shot.status] = (c[x.shot.status] ?? 0) + 1
    return c
  }, [tree])

  const groups = useMemo<SceneGroup[]>(() => {
    if (!tree) return []
    return tree.scenes
      .map((scene) => ({
        scene,
        shots: tree.shots.filter(
          (x) => x.shot.sceneId === scene.id && (filter === 'all' || x.shot.status === filter),
        ),
      }))
      .filter((g) => g.shots.length > 0)
  }, [tree, filter])

  const selected = useMemo<ShotEntry | null>(
    () => tree?.shots.find((x) => x.shot.id === selectedId) ?? null,
    [tree, selectedId],
  )

  /** 「生成整集」先 dryRun——把「要花多少钱、几个被阻塞」先算出来（R2） */
  async function openConfirm(): Promise<void> {
    setErr(null)
    try {
      setPlan(
        await api<DryRunPlan>(`/api/episodes/${episodeId}/generate-batch`, {
          method: 'POST',
          body: JSON.stringify({ dryRun: true }),
        }),
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function confirm(): Promise<void> {
    setBusy(true)
    try {
      await api(`/api/episodes/${episodeId}/generate-batch`, { method: 'POST', body: JSON.stringify({}) })
      setPlan(null)
      await load()
    } catch (e) {
      // 失败必须可操作，不能只说「生成失败」（R3）
      setErr(e instanceof Error ? e.message : String(e))
      setPlan(null)
    } finally {
      setBusy(false)
    }
  }

  if (!tree) {
    return (
      <div className="p-6" style={{ color: 'var(--text-secondary)' }}>
        {err ?? '载入中…'}
      </div>
    )
  }

  const totalSec = tree.shots.reduce((a, x) => a + Number(x.shot.durationSec), 0)

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header
        className="flex flex-wrap items-center gap-3 px-4 py-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {parent && (
          <button
            type="button"
            onClick={() => activate(parent.id)}
            className="rounded-sm px-1"
            style={{ color: 'var(--text-muted)' }}
          >
            ← {parent.title}
          </button>
        )}
        <h2 className="tnum font-medium">第 {tree.episode.index} 集</h2>
        <span style={{ color: 'var(--text-secondary)' }}>{tree.episode.title ?? '未命名'}</span>
        <span className="tnum" style={{ color: 'var(--text-muted)' }}>
          {tree.shots.length} 镜 · {totalSec.toFixed(1)}s / 目标 {tree.episode.targetDurationSec}s
        </span>
        <span className="flex-1" />
        {(counts['review'] ?? 0) > 0 && (
          /*
            选片是全屏比片的活，开新浏览器标签而不是站内跳转——站内跳转会
            卸载整个 workspace，把开着的标签栈全丢掉，代价远大于省下的一次切换。
          */
          <a
            href={`/projects/${projectId}/review`}
            target="_blank"
            rel="noopener"
            className="tnum rounded-md px-2 py-1"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}
          >
            选片 {counts['review']} ↗
          </a>
        )}
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md px-2 py-1"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          刷新
        </button>
        <button
          type="button"
          onClick={() => void openConfirm()}
          className="rounded-md px-3 py-1.5 font-medium"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          生成整集
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2">
        {FILTERS.map((f) => {
          const n = f.key === 'all' ? tree.shots.length : (counts[f.key] ?? 0)
          const on = filter === f.key
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={on}
              className="flex items-center gap-1.5 rounded-sm px-2 py-0.5"
              style={{
                background: on ? 'var(--accent-subtle)' : 'transparent',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                color: on ? 'var(--accent-text)' : 'var(--text-secondary)',
              }}
            >
              {f.key !== 'all' && (
                <span
                  aria-hidden
                  className="inline-block size-1.5 rounded-full"
                  style={{ background: statusColor(f.key) }}
                />
              )}
              {f.label}
              <span className="tnum" style={{ color: 'var(--text-muted)' }}>
                {n}
              </span>
            </button>
          )
        })}
      </div>

      {err && (
        /* R3：失败要说明是什么、以及下一步 */
        <div
          className="mx-4 mb-2 rounded-md p-3"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--status-error)' }}
        >
          <div style={{ color: 'var(--status-error)' }}>✕ {err}</div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="rounded-sm px-2 py-1"
              style={{ border: '1px solid var(--border-strong)' }}
              onClick={() => void load()}
            >
              重新载入
            </button>
            <button
              type="button"
              className="rounded-sm px-2 py-1"
              style={{ border: '1px solid var(--border-strong)' }}
              onClick={() => setErr(null)}
            >
              知道了
            </button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {groups.length === 0 ? (
          <Empty
            filter={filter}
            hasShots={tree.shots.length > 0}
            onClear={() => setFilter('all')}
            onReload={() => void load()}
          />
        ) : (
          <ShotGrid groups={groups} selectedId={selectedId} onSelect={setSelectedId} progress={progress} />
        )}

        <ShotDrawer shotId={selectedId} shot={selected?.shot ?? null} onClose={() => setSelectedId(null)} />
      </div>

      {plan && (
        <ConfirmSpend
          plan={plan}
          busy={busy}
          onCancel={() => setPlan(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </section>
  )
}

/** 空态必须给下一步动作——「暂无数据」是把问题原样还给用户 */
function Empty({
  filter,
  hasShots,
  onClear,
  onReload,
}: {
  filter: FilterKey
  hasShots: boolean
  onClear: () => void
  onReload: () => void
}): React.ReactElement {
  const label = FILTERS.find((f) => f.key === filter)?.label ?? ''
  return (
    <div className="flex-1 p-8" style={{ color: 'var(--text-secondary)' }}>
      {hasShots ? (
        <>
          <p>没有「{label}」的镜头。</p>
          <button
            type="button"
            onClick={onClear}
            className="mt-3 rounded-md px-3 py-1.5"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}
          >
            查看全部镜头
          </button>
        </>
      ) : (
        <>
          <p>本集还没有镜头。镜头由剧本拆解写入，导入后回到这里刷新。</p>
          <button
            type="button"
            onClick={onReload}
            className="mt-3 rounded-md px-3 py-1.5"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}
          >
            刷新
          </button>
        </>
      )}
    </div>
  )
}
