'use client'

import { Progress, StatusPill, statusColor } from '@/components/StatusPill'
import { Cost } from '@/components/Mock'
import { PageHeader } from '@/components/Shell'
import { api, usd, type EpisodeSummary, type ProjectSummary } from '@/lib/api'
import { useCallback, useEffect, useState } from 'react'

/**
 * 项目页 = **分集列表**，导航层级里之前缺失的那一级。原分镜页直接取
 * `episodes[0]`，在 80–100 集的真实剧集下不成立。
 *
 * 资产拆到了 `/projects/[id]/assets`：两块内容叠在一页必然要滚，而
 * 「一页不超过一屏」是硬约束。侧边栏负责在两者间跳。
 *
 * 分集链接开新浏览器标签——同一部剧的两集摊在两个窗口里对比是真实用法。
 */
export function ProjectView({ projectId }: { projectId: string }): React.ReactElement {
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const [sum, eps] = await Promise.all([
        api<{ projects: ProjectSummary[] }>('/api/projects/summary'),
        api<{ episodes: EpisodeSummary[] }>(`/api/projects/${projectId}/episodes`),
      ])
      setProject(sum.projects.find((p) => p.id === projectId) ?? null)
      setEpisodes(eps.episodes)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (project) document.title = `${project.title} · ai-drama-studio`
  }, [project])

  if (err) {
    // R3：报错要说明是什么，且给一个明确的下一步
    return (
      <div className="p-4">
        <div
          className="rounded-md p-3 text-[12px]"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--status-error)' }}
        >
          <div style={{ color: 'var(--status-error)' }}>✕ 载入项目失败：{err}</div>
          <button
            type="button"
            className="mt-2 rounded-sm px-2 py-1"
            style={{ border: '1px solid var(--border-strong)' }}
            onClick={() => void load()}
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <PageHeader
        title={project?.title ?? '载入中…'}
        {...(project?.synopsis ? { subtitle: project.synopsis } : {})}
      >
        {project && <StatusPill status={project.status} kind="project" />}
      </PageHeader>

      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3 p-3">
        <section className="grid grid-cols-4 gap-2">
          <Stat label="集数" value={project ? String(project.episodes) : '—'} />
          <Stat label="镜头" value={project ? String(project.shots) : '—'} />
          <Stat
            label="已锁定"
            value={project ? String(project.locked) : '—'}
            {...(project && project.shots > 0 ? { hint: `${pct(project.locked, project.shots)}%` } : {})}
          />
          <Stat
            label="花费"
            value={usd(project?.costMicroUsd)}
            {...(project ? { mock: [project.costMicroUsd, project.mockCostMicroUsd] as const } : {})}
          />
        </section>

        <section
          className="flex min-h-0 flex-col overflow-hidden rounded-[10px]"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        >
          <div
            className="flex shrink-0 items-center gap-4 px-3 py-1.5 text-[11px]"
            style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}
          >
            <span className="min-w-0 flex-1">集 · 标题</span>
            <span className="w-44 shrink-0">进度</span>
            <span className="w-20 shrink-0 text-right">待选片</span>
            <span className="w-28 shrink-0 text-right">花费</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!episodes ? (
              <div className="p-4" style={{ color: 'var(--text-muted)' }}>
                载入中…
              </div>
            ) : episodes.length === 0 ? (
              /* 空态给下一步动作，不能只说「暂无数据」 */
              <div className="p-4" style={{ color: 'var(--text-secondary)' }}>
                <p>这个项目还没有分集。</p>
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  分集来自剧本阶段（剧本页在 M1+ 才做）。本地开发想先看到画面，跑{' '}
                  <code className="font-mono">pnpm db:seed</code> 灌入示例剧集。
                </p>
              </div>
            ) : (
              episodes.map((ep) => <EpisodeRow key={ep.id} ep={ep} />)
            )}
          </div>
        </section>
      </div>
    </>
  )
}

export default ProjectView

const pct = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 100) : 0)

function Stat({
  label,
  value,
  hint,
  mock,
}: {
  label: string
  value: string
  hint?: string
  /** [总额, mock 额]，用来决定要不要打 MOCK 标 */
  mock?: readonly [number, number]
}): React.ReactElement {
  return (
    <div
      className="rounded-md px-2.5 py-2"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <div className="text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      {mock ? (
        <div className="mt-0.5 text-[22px] leading-7">
          <Cost microUsd={mock[0]} mockMicroUsd={mock[1]} />
        </div>
      ) : (
        <div className="tnum mt-0.5 text-[22px] leading-7">
          {value}
          {hint !== undefined && (
            <span className="tnum ml-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {hint}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function EpisodeRow({ ep }: { ep: EpisodeSummary }): React.ReactElement {
  return (
    <a
      href={`/episodes/${ep.id}`}
      target="_blank"
      rel="noopener"
      className="flex items-center gap-4 px-3 py-2 text-left"
      style={{
        borderTop: '1px solid var(--border)',
        // 阶段用左侧 3px 色条强化，扫视时一眼看出整季的分布（07 §6.2）
        borderLeft: `3px solid ${statusColor(ep.status, 'episode')}`,
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="tnum shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            #{ep.index}
          </span>
          <span className="min-w-0 truncate font-medium">{ep.title ?? '未命名'}</span>
          <StatusPill status={ep.status} kind="episode" />
          <span aria-hidden className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            ↗
          </span>
        </div>
        {ep.logline && (
          <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {ep.logline}
          </div>
        )}
      </div>

      <div className="w-44 shrink-0">
        <div className="tnum mb-0.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          已锁定 {ep.locked} / {ep.shots}
        </div>
        <Progress pct={ep.shots > 0 ? (ep.locked / ep.shots) * 100 : 0} />
      </div>

      <div className="w-20 shrink-0 text-right">
        {ep.review > 0 ? (
          <StatusPill status="review" count={ep.review} />
        ) : (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            —
          </span>
        )}
      </div>

      <div className="w-28 shrink-0 text-right text-[12px]">
        <Cost microUsd={ep.costMicroUsd} mockMicroUsd={ep.mockCostMicroUsd} />
      </div>
    </a>
  )
}
