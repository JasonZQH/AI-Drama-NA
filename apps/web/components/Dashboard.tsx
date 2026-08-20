'use client'

import { Progress, StatusPill } from '@/components/StatusPill'
import { TrendChart } from '@/components/TrendChart'
import { Cost, MockChip, mockLevel } from '@/components/Mock'
import { PageHeader, SideGroup, SideLink } from '@/components/Shell'
import { CreateDialog } from '@/components/CreateDialog'
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
 * **整页必须装进一屏。** 所以三块内容用 grid 分配固定份额：快照一行、趋势一
 * 行、下方两列各自内部滚动。页面本身不滚——顶栏的队列与预算一旦被推出视野，
 * 「随时瞥一眼」这个用途就没了。
 *
 * 导航是链接不是回调：项目开新浏览器标签，深链与后退交还给浏览器。
 */
/** 工作台的侧边栏：所有项目直达。放这里是因为从任何一页跳到任一项目都是高频动作 */
export function DashboardNav(): React.ReactElement {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  useEffect(() => {
    let alive = true
    void api<{ projects: ProjectSummary[] }>('/api/projects/summary')
      .then((r) => {
        if (alive) setProjects(r.projects)
      })
      .catch(() => {
        // 侧边栏取不到不该挡住主内容
      })
    return () => {
      alive = false
    }
  }, [])

  if (projects.length === 0) return <></>
  return (
    <SideGroup title="项目">
      {projects.map((p) => (
        <SideLink
          key={p.id}
          href={`/projects/${p.id}`}
          label={p.title}
          {...(p.shots > 0 ? { count: p.shots } : {})}
          newTab
        />
      ))}
    </SideGroup>
  )
}

export function Dashboard(): React.ReactElement {
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
   * 数完（或确定编排不会跑）再交还给 React。
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

  // 工作台常开着，用户可能在别处干几十分钟才切回来。事件驱动刷新，
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
  const mock = ov ? mockLevel(ov.totals.costMicroUsd, ov.totals.mockCostMicroUsd) : 'none'
  const [creating, setCreating] = useState(false)

  return (
    <>
      <PageHeader title="工作台" subtitle={ov ? `${ov.totals.projects} 个项目 · ${ov.totals.shots} 镜` : ''}>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md px-2 py-1 text-[12px]"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          刷新
        </button>
        {/*
          在此之前 `projects` 表的唯一写入方是 `db/seed.ts`——面板能跑一部剧，
          但造不出第二部。08 §8 的空态表本来就写着「创建第一个项目」。
        */}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md px-3 py-1 text-[12px] font-medium"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          新建项目
        </button>
      </PageHeader>

      {creating && (
        <CreateDialog
          title="新建项目"
          fields={[
            { key: 'title', label: '剧名', required: true, placeholder: 'Ashes of the Alpha' },
            {
              key: 'synopsis',
              label: '梗概',
              kind: 'textarea',
              placeholder: '一两句话说清这部剧讲什么',
              hint: '会作为 SERIES SYNOPSIS 进分镜提示词，留空则模型只能看单集的信息',
            },
          ]}
          onClose={() => setCreating(false)}
          onSubmit={async (v) => {
            const r = await api<{ project: { id: string } }>('/api/projects', {
              method: 'POST',
              body: JSON.stringify({
                title: v['title'],
                ...(v['synopsis']?.trim() ? { synopsis: v['synopsis'] } : {}),
              }),
            })
            // 直接跳进新项目：建完停在工作台还要自己找一遍
            window.location.href = `/projects/${r.project.id}`
          }}
        />
      )}

      {/* 三行：快照 auto、趋势 auto、下方两列吃掉剩余高度并各自内滚 */}
      <div ref={root} className="grid min-h-0 flex-1 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 p-3">
        {err && (
          /* R3：失败要说明是什么、以及下一步 */
          <div
            className="rounded-md p-2 text-[12px]"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--status-error)' }}
          >
            <span style={{ color: 'var(--status-error)' }}>✕ 读取失败：{err}</span>
            <span className="ml-2" style={{ color: 'var(--text-muted)' }}>
              控制面可能没在跑，确认 <code className="font-mono">pnpm dev</code> 已启动。
            </span>
            <button
              type="button"
              className="ml-2 rounded-sm px-2 py-0.5"
              style={{ border: '1px solid var(--border-strong)' }}
              onClick={() => void load()}
            >
              重试
            </button>
          </div>
        )}

        <section className="grid grid-cols-4 gap-2 xl:grid-cols-7">
          {/* 这一格的数字由 TrendChart 的 timeline 递增写入——它是那条曲线的积分 */}
          <Stat
            label="总花费"
            value={counted ? usd(ov?.totals.costMicroUsd) : ''}
            valueRef={totalRef}
            {...(mock !== 'none' ? { chip: mock } : {})}
          />
          <Stat label="项目" value={ov ? String(ov.totals.projects) : '—'} />
          <Stat label="总镜头" value={ov ? String(ov.totals.shots) : '—'} />
          <Stat
            label="每可用镜头成本"
            value={usd(ov?.totals.usdPerAcceptedMicro)}
            hint="含重试与废片"
            {...(mock !== 'none' ? { chip: mock } : {})}
          />
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
        </section>

        <TrendChart
          data={series}
          range={range}
          onRangeChange={setRange}
          totalRef={totalRef}
          onSettled={() => setCounted(true)}
          totalMicroUsd={ov?.totals.costMicroUsd ?? null}
        />

        <div className="grid min-h-0 gap-3 lg:grid-cols-2">
          <Pane
            title="需要你处理"
            {...(attention && attention.length > 0 ? { count: attention.length } : {})}
          >
            {!attention ? (
              <Loading />
            ) : attention.length === 0 ? (
              <Empty
                text={
                  projects && projects.length > 0
                    ? '没有失败，也没有待选的片子。'
                    : '还没有项目，自然也没有待办。右上角「新建项目」开一部，或跑 pnpm db:seed 载入示例剧集。'
                }
              />
            ) : (
              <div className="flex flex-col gap-3">
                <Group status="failed" items={failed} />
                <Group status="review" items={review} />
              </div>
            )}
          </Pane>

          <Pane title="项目" {...(projects ? { count: projects.length } : {})}>
            {!projects ? (
              <Loading />
            ) : projects.length === 0 ? (
              <Empty
                text="还没有项目。"
                hint="点右上角「新建项目」开一部新剧，或运行 pnpm db:seed 载入示例项目（1 集 / 12 镜 / mock provider）。"
              />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {projects.map((p) => (
                  <li key={p.id}>
                    {/* 新浏览器标签：深链、后退、多显示器摊开都交还给浏览器 */}
                    <a
                      href={`/projects/${p.id}`}
                      target="_blank"
                      rel="noopener"
                      className="block rounded-md p-2.5"
                      style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
                        <StatusPill status={p.status} kind="project" />
                        <span aria-hidden className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          ↗
                        </span>
                      </div>
                      <div
                        className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px]"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        <span className="tnum">{p.episodes} 集</span>
                        <span className="tnum">{p.shots} 镜</span>
                        <span className="tnum">已锁定 {p.locked}</span>
                        <Cost microUsd={p.costMicroUsd} mockMicroUsd={p.mockCostMicroUsd} />
                      </div>
                      {/* R1：进度必须可读，不能只给个转圈 */}
                      <div className="mt-1.5">
                        <Progress pct={p.shots > 0 ? (p.locked / p.shots) * 100 : 0} />
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Pane>
        </div>
      </div>
    </>
  )
}

export default Dashboard

/** 一格内容区。标题固定，内容自己滚——页面整体不滚是硬约束 */
function Pane({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section
      className="flex min-h-0 flex-col rounded-[10px]"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <h2
        className="flex shrink-0 items-center gap-2 px-3 py-2 text-[13px] font-medium"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {title}
        {count !== undefined && (
          <span className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {count}
          </span>
        )}
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </section>
  )
}

function Stat({
  label,
  value,
  hint,
  dim,
  chip,
  valueRef,
}: {
  label: string
  value: string
  hint?: string
  dim?: boolean
  chip?: 'partial' | 'all'
  valueRef?: React.Ref<HTMLDivElement>
}): React.ReactElement {
  return (
    <div
      className="stat rounded-md px-2.5 py-2"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        {chip && <MockChip {...(chip === 'partial' ? { partial: true } : {})} />}
      </div>
      <div
        ref={valueRef}
        className="tnum mt-0.5 text-[22px] leading-7"
        style={dim ? { color: 'var(--text-muted)' } : undefined}
      >
        {value}
      </div>
      {hint !== undefined && (
        <div className="truncate text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </div>
      )}
    </div>
  )
}

function Loading(): React.ReactElement {
  return <div style={{ color: 'var(--text-muted)' }}>载入中…</div>
}

/** 空态必须给下一步动作——「暂无数据」等于把人晾在原地 */
function Empty({ text, hint }: { text: string; hint?: string }): React.ReactElement {
  return (
    <div style={{ color: 'var(--text-secondary)' }}>
      <p>{text}</p>
      {hint && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </p>
      )}
    </div>
  )
}

/**
 * 待办分组。点一条直达该镜所在的分集，并在 URL 上带好筛选与目标镜头
 * ——规格 §4：「点击直达对应筛选态，不是跳到列表让人自己找」。
 */
function Group({
  status,
  items,
}: {
  status: 'failed' | 'review'
  items: AttentionItem[]
}): React.ReactElement | null {
  if (items.length === 0) return null
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <StatusPill status={status} />
        <span className="tnum text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          {items.length} 个
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((it) => (
          <li key={it.shotId}>
            <a
              href={`/episodes/${it.episodeId}?filter=${status}&shot=${it.shotId}`}
              target="_blank"
              rel="noopener"
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-[12px]"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
            >
              <span className="tnum shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                #{it.shotIndex}
              </span>
              <span className="min-w-0 flex-1 truncate">{it.action}</span>
              <span className="shrink-0 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {it.projectTitle}
              </span>
              <span className="shrink-0 text-[11px]" style={{ color: 'var(--accent-text)' }}>
                去处理 ↗
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
