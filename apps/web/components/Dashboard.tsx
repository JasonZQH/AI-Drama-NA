'use client'

import { Progress, StatusPill } from '@/components/StatusPill'
import { TrendChart } from '@/components/TrendChart'
import {
  api,
  usd,
  type AttentionItem,
  type Overview,
  type ProjectSummary,
  type RangeKey,
  type Timeseries,
} from '@/lib/api'
import { useStudioEvent } from '@/lib/events'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useCallback, useEffect, useRef, useState } from 'react'

gsap.registerPlugin(useGSAP)

/**
 * 工作台（2026-08-15-web-admin-panel-design.md §4）。
 *
 * 纯展示 + 自取数：不碰 useTabs，导航一律走回调。这样它在任何外壳里都能挂——
 * 标签系统是外壳的实现细节，不该渗进页面。
 */
export function Dashboard({
  onOpenProject,
  onOpenEpisode,
}: {
  onOpenProject: (id: string, title: string) => void
  onOpenEpisode: (
    episodeId: string,
    projectId: string,
    title: string,
    focus?: { filter?: string; shotId?: string },
  ) => void
}): React.ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const totalRef = useRef<HTMLDivElement>(null)

  const [ov, setOv] = useState<Overview | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [attention, setAttention] = useState<AttentionItem[] | null>(null)
  const [series, setSeries] = useState<Timeseries | null>(null)
  const [range, setRange] = useState<RangeKey>('30d')
  /*
   * 「总花费」这一格在编排期间归 GSAP 写。React 同时渲染终值的话，
   * ov 一到达就会先画出终值、再被 timeline 拽回 0 数上去，闪一下。
   * 数完（或确定编排不会跑）再交还给 React，之后 SSE 刷新才写得进去。
   */
  const [counted, setCounted] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      // 三个请求互不依赖，串行等于白等两个 RTT
      const [o, p, a] = await Promise.all([
        api<Overview>('/api/stats/overview'),
        api<{ projects: ProjectSummary[] }>('/api/projects/summary'),
        api<{ items: AttentionItem[] }>('/api/attention'),
      ])
      setOv(o)
      setProjects(p.projects)
      setAttention(a.items)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 工作台是常驻标签，用户可能在别处干几十分钟才切回来。事件驱动刷新，
  // 但攒 1s 再发一次请求——整集生成时事件是几十条连着来的
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useStudioEvent(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void load(), 1000)
  })
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  useEffect(() => {
    let alive = true
    void api<Timeseries>(`/api/stats/timeseries?range=${range}`)
      .then((t) => {
        if (alive) setSeries(t)
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [range])

  // 卡片入场的轻微 stagger——除趋势曲线外全页只此一处动效（规格 §7）
  useGSAP(
    () => {
      if (!ov) return
      const mm = gsap.matchMedia()
      mm.add({ ok: '(prefers-reduced-motion: no-preference)' }, (ctx) => {
        if (ctx.conditions?.['ok'] !== true) return
        gsap.from('.stat', { autoAlpha: 0, y: 6, duration: 0.3, stagger: 0.03, ease: 'power2.out' })
      })
      return () => mm.revert()
    },
    { scope: root, dependencies: [ov !== null] },
  )

  const dist = ov?.distribution ?? null
  const rev = ov?.revenue ?? null
  const failed = attention?.filter((a) => a.status === 'failed') ?? []
  const review = attention?.filter((a) => a.status === 'review') ?? []
  const firstProject = projects?.[0]

  return (
    <div ref={root} className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
        {err && (
          /* R3：失败要说明是什么、以及下一步 */
          <div
            className="rounded-md p-3"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--status-error)' }}
          >
            <div style={{ color: 'var(--status-error)' }}>✕ 读取失败：{err}</div>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              控制面可能没在跑。确认 <code className="font-mono">pnpm dev</code> 已启动后重试。
            </p>
            <button
              type="button"
              className="mt-2 rounded-sm px-2 py-1"
              style={{ border: '1px solid var(--border-strong)' }}
              onClick={() => void load()}
            >
              重试
            </button>
          </div>
        )}

        <section>
          <h2 className="mb-2 text-[18px] leading-[26px] font-medium">经营快照</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
            {/* 这一格的数字由 TrendChart 的 timeline 递增写入——它是那条曲线的积分 */}
            <Stat label="总花费" value={counted ? usd(ov?.totals.costMicroUsd) : ''} valueRef={totalRef} />
            <Stat label="项目" value={ov ? String(ov.totals.projects) : '—'} />
            <Stat label="总镜头" value={ov ? String(ov.totals.shots) : '—'} />
            <Stat label="每可用镜头成本" value={usd(ov?.totals.usdPerAcceptedMicro)} hint="含重试与废片" />
            {/* 位置现在就占住：M4 接投放回传时是填充数据，不是改结构（规格 §6） */}
            <Stat
              label="投放"
              value={dist ? usd(dist.spendMicroUsd) : '—'}
              hint={dist ? `${dist.installs} 安装` : 'M4 接入'}
              dim={!dist}
            />
            <Stat
              label="收入"
              value={rev ? usd(rev.grossMicroUsd) : '—'}
              hint={rev ? '毛收入' : 'M4 接入'}
              dim={!rev}
            />
            <Stat
              label="ROI"
              value={rev ? `${rev.roi.toFixed(2)}×` : '—'}
              hint={rev ? '收入 / 投放' : 'M4 接入'}
              dim={!rev}
            />
          </div>
        </section>

        <TrendChart
          data={series}
          range={range}
          onRangeChange={setRange}
          totalRef={totalRef}
          onSettled={() => setCounted(true)}
          totalMicroUsd={ov?.totals.costMicroUsd ?? null}
        />

        <div className="grid gap-6 lg:grid-cols-2">
          <section
            className="rounded-[10px] p-4"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
          >
            <h2 className="mb-3 text-[18px] leading-[26px] font-medium">
              需要你处理
              {attention && attention.length > 0 && (
                <span className="tnum ml-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
                  {attention.length}
                </span>
              )}
            </h2>

            {!attention ? (
              <Loading />
            ) : attention.length === 0 ? (
              <Empty
                text={
                  firstProject
                    ? '没有失败，也没有待选的片子。'
                    : '还没有项目，自然也没有待办。跑 pnpm db:seed 载入示例剧集（1 集 / 12 镜 / mock provider）就有东西可处理了。'
                }
                action={
                  firstProject
                    ? {
                        label: `打开「${firstProject.title}」继续生成`,
                        run: () => onOpenProject(firstProject.id, firstProject.title),
                      }
                    : null
                }
              />
            ) : (
              <div className="flex flex-col gap-4">
                <Group status="failed" items={failed} onOpen={onOpenEpisode} />
                <Group status="review" items={review} onOpen={onOpenEpisode} />
              </div>
            )}
          </section>

          <section
            className="rounded-[10px] p-4"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
          >
            <h2 className="mb-3 text-[18px] leading-[26px] font-medium">项目</h2>

            {!projects ? (
              <Loading />
            ) : projects.length === 0 ? (
              <Empty
                text="还没有项目。"
                hint="运行 pnpm db:seed 载入示例项目（1 集 / 12 镜 / mock provider），第一分钟就能看到完整流程。"
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => onOpenProject(p.id, p.title)}
                      className="w-full rounded-md p-3 text-left"
                      style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
                        <StatusPill status={p.status} kind="project" />
                      </div>
                      <div
                        className="tnum mt-1 flex flex-wrap gap-x-3 text-[11px]"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        <span>{p.episodes} 集</span>
                        <span>{p.shots} 镜</span>
                        <span>已锁定 {p.locked}</span>
                        <span>{usd(p.costMicroUsd)}</span>
                      </div>
                      {/* R1：进度必须可读，不能只给个转圈 */}
                      <div className="mt-2">
                        <Progress pct={p.shots > 0 ? (p.locked / p.shots) * 100 : 0} />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

export default Dashboard

function Stat({
  label,
  value,
  hint,
  dim,
  valueRef,
}: {
  label: string
  value: string
  hint?: string
  dim?: boolean
  valueRef?: React.Ref<HTMLDivElement>
}): React.ReactElement {
  return (
    <div
      className="stat rounded-md p-3"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <div className="text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div
        ref={valueRef}
        className="tnum mt-0.5 text-[28px] leading-[34px]"
        style={dim ? { color: 'var(--text-muted)' } : undefined}
      >
        {value}
      </div>
      {hint && (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </div>
      )}
    </div>
  )
}

/**
 * 待办分组。点一条直达该镜所在的分集，不是跳到列表让人自己找（规格 §4）。
 */
function Group({
  status,
  items,
  onOpen,
}: {
  /** 镜头状态口径，直接交给 StatusPill——不从 items[0] 猜 */
  status: 'failed' | 'review'
  items: AttentionItem[]
  onOpen: (
    episodeId: string,
    projectId: string,
    title: string,
    focus?: { filter?: string; shotId?: string },
  ) => void
}): React.ReactElement | null {
  if (items.length === 0) return null
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <StatusPill status={status} />
        <span className="tnum" style={{ color: 'var(--text-secondary)' }}>
          {items.length} 个
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((it) => (
          <li key={it.shotId}>
            <button
              type="button"
              onClick={() =>
                onOpen(it.episodeId, it.projectId, episodeLabel(it), {
                  filter: status,
                  shotId: it.shotId,
                })
              }
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
            >
              <span className="tnum shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                #{it.shotIndex}
              </span>
              <span className="min-w-0 flex-1 truncate">{it.action}</span>
              <span className="shrink-0 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {it.projectTitle} · {episodeLabel(it)}
              </span>
              <span className="shrink-0 text-[11px]" style={{ color: 'var(--accent-text)' }}>
                去处理 →
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const episodeLabel = (it: AttentionItem): string =>
  it.episodeTitle ? `第 ${it.episodeIndex} 集 · ${it.episodeTitle}` : `第 ${it.episodeIndex} 集`

function Loading(): React.ReactElement {
  return <p style={{ color: 'var(--text-secondary)' }}>载入中…</p>
}

/** 空态必须给下一步动作，不能只写「暂无数据」（验收 §10） */
function Empty({
  text,
  hint,
  action,
}: {
  text: string
  hint?: string
  action?: { label: string; run: () => void } | null
}): React.ReactElement {
  return (
    <div className="rounded-md p-4" style={{ background: 'var(--bg-inset)', color: 'var(--text-secondary)' }}>
      <p>{text}</p>
      {hint && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </p>
      )}
      {action && (
        <button
          type="button"
          onClick={action.run}
          className="mt-2 rounded-sm px-2 py-1"
          style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
