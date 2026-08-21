'use client'

import { ConfirmSpend } from '@/components/ConfirmSpend'
import { ShotDrawer } from '@/components/ShotDrawer'
import { ShotGrid, type SceneGroup, type ShotEntry, type ShotProgress } from '@/components/ShotGrid'
import { statusColor } from '@/components/StatusPill'
import { api, type DryRunPlan, type EpisodeTree } from '@/lib/api'
import { useStudioEvent } from '@/lib/events'
import { ProjectShell } from '@/components/ProjectShell'
import { ScriptEditor } from '@/components/ScriptEditor'
import { SceneEditor } from '@/components/SceneEditor'
import { PageHeader, Shell } from '@/components/Shell'
import { useSearchParams } from 'next/navigation'
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

/**
 * 分集页。
 *
 * 落点（筛选 + 目标镜头）走 URL query 而不是内部状态：工作台的待办在新浏览器
 * 标签里打开这一页，`?filter=failed&shot=<id>` 是唯一能跨标签传过来的东西，
 * 顺带让这个落点可收藏、可分享、后退也还在——规格 §4「点击直达对应筛选态」。
 */
export default function EpisodeView({ episodeId }: { episodeId: string }): React.ReactElement {
  const params = useSearchParams()
  const focusFilter = params.get('filter')
  const focusShot = params.get('shot')
  const [tree, setTree] = useState<EpisodeTree | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [plan, setPlan] = useState<DryRunPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, ShotProgress>>({})
  const [scriptOpen, setScriptOpen] = useState(false)
  const [scenesOpen, setScenesOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setTree(await api<EpisodeTree>(`/api/episodes/${episodeId}`))
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [episodeId])

  useEffect(() => {
    void load()
  }, [load])

  // 只在 URL 变化时套用落点。用户随后手动改筛选不该被拽回来
  useEffect(() => {
    if (focusFilter && FILTERS.some((f) => f.key === focusFilter)) setFilter(focusFilter as FilterKey)
    if (focusShot) setSelectedId(focusShot)
  }, [focusFilter, focusShot])

  useEffect(() => {
    if (tree) {
      document.title = `第 ${tree.episode.index} 集${tree.episode.title ? ` · ${tree.episode.title}` : ''} · ai-drama-studio`
    }
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
      setProgress((p) => ({
        ...p,
        [e.shotId]: {
          pct: e.pct,
          ...(e.etaMs ? { etaMs: e.etaMs } : {}),
          ...(e.stage ? { stage: e.stage } : {}),
        },
      }))
    } else if (e.type === 'shot.status') {
      if (!shotIds.has(e.shotId)) return
      // 状态跃迁了就清掉这一镜的进度条——它已经不在生成中
      setProgress((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== e.shotId)))
      scheduleReload()
    }
  })

  const lockedCount = useMemo(
    () => (tree?.shots ?? []).filter((x) => x.shot.status === 'locked').length,
    [tree],
  )

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

  /**
   * 剧本 → 分镜。`POST /api/episodes/:id/shotlist`（#68）在面板上没有入口，
   * 而它是整条链路的**起点**——没有它，`shots` 的唯一来源仍是 `db/seed.ts`。
   *
   * 端点自己会查四个前置条件并给可行动的报错。这里只把「必然失败」的两种在
   * 按钮上先说清楚（没剧本、已有镜头），剩下的（没场次、没 key）由报错承担
   * ——它们在面板上看不出来，猜不如问。
   */
  async function makeShotlist(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ shots: number; repaired: boolean; warnings: string[] }>(
        `/api/episodes/${episodeId}/shotlist`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      // warnings 不触发重试，但人该看到——尤其是否定式描述那条
      if (r.warnings.length > 0)
        setErr(`生成了 ${r.shots} 镜，${r.warnings.length} 条告警：\n${r.warnings.join('\n')}`)
      await load()
    } catch (e) {
      // 没配 key 时这里是 503，消息里直说去 .env 加哪个变量
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 渲染成片。
   *
   * `POST /api/episodes/:id/render` 一直都在，但面板上没有任何入口——12 镜全锁定
   * 之后只能 curl。端点是**同步**的（见 routes/api.ts 的注释：一集 12 镜实测
   * 4 秒级，同步等得住），所以这里 await 完就能直接跳去看片。
   */
  async function render(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      await api(`/api/episodes/${episodeId}/render`, { method: 'POST', body: JSON.stringify({}) })
      window.open(`/watch/${episodeId}`, '_blank', 'noopener')
      await load()
    } catch (e) {
      // media worker 没起时这里是 503 DEPENDENCY_UNAVAILABLE，消息里带 ECONNREFUSED
      // 与该起哪个服务——比「渲染失败」有用得多
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!tree) {
    return (
      <Shell>
        <div className="p-6 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {err ?? '载入中…'}
        </div>
      </Shell>
    )
  }

  const totalSec = tree.shots.reduce((a, x) => a + Number(x.shot.durationSec), 0)
  const noLocation = tree.scenes.filter((sc) => !sc.locationId).length
  const projectId = tree.episode.projectId

  return (
    <ProjectShell projectId={projectId} active={`episode:${episodeId}`}>
      <PageHeader
        title={`第 ${tree.episode.index} 集`}
        subtitle={`${tree.episode.title ?? '未命名'} · ${tree.shots.length} 镜 · ${totalSec.toFixed(1)}s / 目标 ${tree.episode.targetDurationSec}s`}
      >
        {(counts['review'] ?? 0) > 0 && (
          // 选片是全屏比片的活，开新浏览器标签，别把这一页顶掉
          <a
            href={`/projects/${projectId}/review`}
            target="_blank"
            rel="noopener"
            className="tnum rounded-md px-2 py-1 text-[12px]"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}
          >
            选片 {counts['review']} ↗
          </a>
        )}
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md px-2 py-1 text-[12px]"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          刷新
        </button>
        {/* 剧本是分镜的输入。字数直接摆出来——空的时候要一眼看得见 */}
        {/*
          场次是分镜的必需输入（没有就 409），而在这之前它在面板上完全看不见：
          ShotGrid 的 SCENE 分组头是按镜头分组出来的，零镜头时整个网格被空态换掉。
          缺地点的场次数摆在按钮上——不挂地点 = 那一场的 prompt 里没有环境描述。
        */}
        <button
          type="button"
          onClick={() => setScenesOpen(true)}
          title="分镜按场次切镜头。没有场次，「生成分镜」会直接拒绝"
          className="tnum rounded-md px-2 py-1 text-[12px]"
          style={{
            border: '1px solid var(--border-strong)',
            color: noLocation > 0 ? 'var(--status-review)' : 'var(--text-secondary)',
          }}
        >
          场次 {tree.scenes.length}
          {noLocation > 0 ? ` · ${noLocation} 缺地点` : ''}
        </button>
        <button
          type="button"
          onClick={() => setScriptOpen(true)}
          className="tnum rounded-md px-2 py-1 text-[12px]"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          剧本 {tree.episode.scriptMd ? `${tree.episode.scriptMd.length} 字` : '未填'}
        </button>
        {/* 分镜是「生成整集」的前置。已经有镜头就禁掉——端点会拒，但按钮先说 */}
        <button
          type="button"
          onClick={() => void makeShotlist()}
          disabled={busy || !tree.episode.scriptMd || tree.shots.length > 0}
          title={
            tree.shots.length > 0
              ? '这一集已经有镜头了。重新生成会让已计费的产物失效——要重来请先删掉'
              : !tree.episode.scriptMd
                ? '先填剧本'
                : '按剧本切分镜头，写入 shots'
          }
          className="rounded-md px-3 py-1 text-[12px] disabled:opacity-40"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          {busy ? '生成中…' : '生成分镜'}
        </button>
        <button
          type="button"
          onClick={() => void openConfirm()}
          className="rounded-md px-3 py-1 text-[12px] font-medium"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          生成整集
        </button>
        {/*
          **看成片。** 此前面板上唯一通向 `/watch` 的路径是渲染那一刻的
          `window.open`——关掉那个标签页，片子就再也找不到了。片子是这条流水线
          的最终产物，它必须有一个常驻入口。
        */}
        {tree.master && (
          <a
            href={`/watch/${episodeId}`}
            target="_blank"
            rel="noopener"
            title={`渲染于 ${new Date(tree.master.finishedAt).toLocaleString('zh-CN')}`}
            className="rounded-md px-3 py-1 text-[12px] font-medium"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}
          >
            ▶ 看成片 ↗
          </a>
        )}
        {/* 一个锁定镜头都没有时渲染必然以「没有已选定的镜头」失败，不如禁用 */}
        <button
          type="button"
          onClick={() => void render()}
          disabled={busy || lockedCount === 0}
          title={lockedCount === 0 ? '先去选片页锁定镜头' : `把 ${lockedCount} 个已锁定镜头拼成母版`}
          className="rounded-md px-3 py-1 text-[12px] font-medium disabled:opacity-40"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          {busy ? '渲染中…' : `${tree.master ? '重新渲染' : '渲染成片'} ${lockedCount}/${tree.shots.length}`}
        </button>
      </PageHeader>

      {scenesOpen && (
        <SceneEditor
          episodeId={episodeId}
          projectId={projectId}
          scenes={tree.scenes}
          onChanged={() => void load()}
          onClose={() => setScenesOpen(false)}
        />
      )}

      {scriptOpen && (
        <ScriptEditor
          episodeId={episodeId}
          initial={tree.episode.scriptMd ?? ''}
          onSaved={(md) => setTree((t) => (t ? { ...t, episode: { ...t.episode, scriptMd: md } } : t))}
          onClose={() => setScriptOpen(false)}
        />
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 py-1.5">
        {FILTERS.map((f) => {
          const n = f.key === 'all' ? tree.shots.length : (counts[f.key] ?? 0)
          const on = filter === f.key
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={on}
              className="flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[12px]"
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
          className="mx-3 mb-2 shrink-0 rounded-md p-2 text-[12px]"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--status-error)' }}
        >
          <span style={{ color: 'var(--status-error)' }}>✕ {err}</span>
          <button
            type="button"
            className="ml-2 rounded-sm px-2 py-0.5"
            style={{ border: '1px solid var(--border-strong)' }}
            onClick={() => void load()}
          >
            重新载入
          </button>
          <button
            type="button"
            className="ml-2 rounded-sm px-2 py-0.5"
            style={{ border: '1px solid var(--border-strong)' }}
            onClick={() => setErr(null)}
          >
            知道了
          </button>
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
    </ProjectShell>
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
          <p>本集还没有镜头。</p>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            顺序是：顶部「剧本」粘一段 → 顶部「场次」配好场次与地点 → 点「生成分镜」。
            三样齐了那个按钮才点得动。
          </p>
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
