'use client'

import { useEffect, useState } from 'react'
import { api, type EpisodeSummary, type ProjectSummary } from '@/lib/api'
import { Shell, SideGroup, SideLink } from './Shell'

export type ProjectSection = 'episodes' | 'assets' | `episode:${string}`

/**
 * 项目上下文的侧边栏。
 *
 * 「一页不超过一屏」逼着把原来堆在项目页里的分集列表与资产拆成两页，于是需要
 * 一个跳转面——就是这里。分集也列进来，因为从一集跳到另一集是最高频的动作，
 * 走「回项目页再点」是白绕一圈。
 *
 * 分集链接开新浏览器标签（`newTab`），与工作台上的项目链接一致。
 */
export function ProjectShell({
  projectId,
  active,
  children,
}: {
  projectId: string
  active: ProjectSection
  children: React.ReactNode
}): React.ReactElement {
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([])

  useEffect(() => {
    let alive = true
    void Promise.all([
      api<{ projects: ProjectSummary[] }>('/api/projects/summary'),
      api<{ episodes: EpisodeSummary[] }>(`/api/projects/${projectId}/episodes`),
    ])
      .then(([sum, eps]) => {
        if (!alive) return
        setProject(sum.projects.find((p) => p.id === projectId) ?? null)
        setEpisodes(eps.episodes)
      })
      .catch(() => {
        // 侧边栏取不到不该挡住主内容——主内容自己会报错并给重试
      })
    return () => {
      alive = false
    }
  }, [projectId])

  return (
    <Shell
      nav={
        <>
          <SideGroup title={project ? project.title : '项目'}>
            <SideLink
              href={`/projects/${projectId}`}
              label="分集"
              glyph="▦"
              count={episodes.length}
              active={active === 'episodes'}
            />
            <SideLink
              href={`/projects/${projectId}/assets`}
              label="资产"
              glyph="◈"
              active={active === 'assets'}
            />
            <SideLink href={`/projects/${projectId}/review`} label="选片" glyph="⚑" newTab />
          </SideGroup>

          {episodes.length > 0 && (
            <SideGroup title="分集">
              {episodes.map((ep) => (
                <SideLink
                  key={ep.id}
                  href={`/episodes/${ep.id}`}
                  label={`#${ep.index} ${ep.title ?? '未命名'}`}
                  {...(ep.review > 0 ? { count: ep.review } : {})}
                  active={active === `episode:${ep.id}`}
                  newTab={active !== `episode:${ep.id}`}
                />
              ))}
            </SideGroup>
          )}
        </>
      }
    >
      {children}
    </Shell>
  )
}
