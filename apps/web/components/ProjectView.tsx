'use client'

import { Progress, StatusPill, statusColor } from '@/components/StatusPill'
import { api, usd, type EpisodeSummary, type ProjectAssets, type ProjectSummary } from '@/lib/api'
import { useCallback, useEffect, useRef, useState } from 'react'

type Character = ProjectAssets['characters'][number]

const isEmpty = (v: unknown): boolean => v === null || v === undefined

/**
 * 三路资产（face_set / body_ref / wardrobe）缺哪几路。
 *
 * 13-character-assets.md §3 的闸门：参考图没锁死就开始批量生成，等于在流沙上
 * 盖楼。所以「缺什么」必须在面板上直接可见，而不是等批量生成翻车才发现。
 *
 * jsonb 列到前端是 unknown，这里只判空——结构校验是入库闸门的职责，不重复。
 */
function missingTracks(c: Character): string[] {
  const miss: string[] = []
  if (isEmpty(c.faceSet)) miss.push('人脸组')
  if (isEmpty(c.bodyRef)) miss.push('体型')
  if (c.wardrobe.length === 0) miss.push('服装')
  return miss
}

/**
 * 项目页（2026-08-15-web-admin-panel-design.md §3）。
 *
 * 主体是**分集列表**——导航层级里之前缺失的那一级。原分镜页直接取
 * `episodes[0]`，在 80–100 集的真实剧集下不成立。
 */
export function ProjectView({
  projectId,
  onOpenEpisode,
  onTitle,
}: {
  projectId: string
  onOpenEpisode: (episodeId: string, title: string) => void
  /** 深链恢复出来的标签叫「载入中…」，标题拿到了要回报给标签栏 */
  onTitle?: (title: string) => void
}): React.ReactElement {
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null)
  const [assets, setAssets] = useState<ProjectAssets | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // onTitle 在 shell 里是行内箭头函数，每次渲染都是新引用。放进 load 的依赖
  // 会让 load 每渲染一次就变一次，配上下面的 effect 正好是无限重取
  const onTitleRef = useRef(onTitle)
  useEffect(() => {
    onTitleRef.current = onTitle
  })

  const load = useCallback(async () => {
    setErr(null)
    try {
      // 三个请求互不依赖，串行等于白等两个 RTT
      const [sum, eps, ast] = await Promise.all([
        api<{ projects: ProjectSummary[] }>('/api/projects/summary'),
        api<{ episodes: EpisodeSummary[] }>(`/api/projects/${projectId}/episodes`),
        api<ProjectAssets>(`/api/projects/${projectId}/assets`),
      ])
      const found = sum.projects.find((p) => p.id === projectId) ?? null
      setProject(found)
      setEpisodes(eps.episodes)
      setAssets(ast)
      if (found) onTitleRef.current?.(found.title)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  if (err) {
    // R3：报错要说明是什么，且给一个明确的下一步
    return (
      <div className="p-6">
        <div
          className="rounded-md p-3"
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

  if (!episodes || !assets) {
    return (
      <div className="p-6" style={{ color: 'var(--text-secondary)' }}>
        载入中…
      </div>
    )
  }

  if (!project) {
    return (
      <div className="p-6" style={{ color: 'var(--text-secondary)' }}>
        这个项目不在列表里——可能已被删除。回工作台看看还有哪些项目。
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-4 pb-12">
        <header className="mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[24px] leading-8 font-medium">{project.title}</h1>
            <StatusPill status={project.status} kind="project" />
          </div>
          {project.synopsis && (
            <p className="mt-1 max-w-3xl" style={{ color: 'var(--text-secondary)' }}>
              {project.synopsis}
            </p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="集数" value={String(project.episodes)} />
            <Stat label="镜头" value={String(project.shots)} />
            <Stat
              label="已锁定"
              value={String(project.locked)}
              {...(project.shots > 0 ? { hint: `${pct(project.locked, project.shots)}%` } : {})}
            />
            <Stat label="花费" value={usd(project.costMicroUsd)} />
          </div>
        </header>

        <section className="mb-8">
          <SectionTitle title="分集" count={episodes.length} />
          {episodes.length === 0 ? (
            <Empty
              title="这个项目还没有分集"
              hint="分集来自剧本阶段（剧本页在 M1+ 才做）。本地开发想先看到画面，跑 pnpm db:seed 灌入示例剧集。"
            />
          ) : (
            <div className="overflow-hidden rounded-md" style={{ border: '1px solid var(--border)' }}>
              <div
                className="flex items-center gap-4 px-3 py-1.5 text-[11px]"
                style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}
              >
                <span className="min-w-0 flex-1">集 · 标题</span>
                <span className="w-44 shrink-0">进度</span>
                <span className="w-24 shrink-0 text-right">待选片</span>
                <span className="w-20 shrink-0 text-right">花费</span>
              </div>
              {episodes.map((ep) => (
                <EpisodeRow key={ep.id} ep={ep} onOpen={onOpenEpisode} />
              ))}
            </div>
          )}
        </section>

        <AssetsSection assets={assets} />
      </div>
    </div>
  )
}

// shell 用默认导入挂载各标签页的内容组件
export default ProjectView

const pct = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 100) : 0)

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): React.ReactElement {
  return (
    <div
      className="rounded-md px-3 py-2"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div className="tnum text-[24px] leading-8">
        {value}
        {hint !== undefined && (
          <span className="tnum ml-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {hint}
          </span>
        )}
      </div>
    </div>
  )
}

function SectionTitle({ title, count }: { title: string; count: number }): React.ReactElement {
  return (
    <h2 className="mb-2 text-[18px] leading-[26px]">
      {title}
      <span className="tnum ml-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        {count}
      </span>
    </h2>
  )
}

/** 空态必须给下一步动作——「暂无数据」等于把人晾在原地 */
function Empty({ title, hint }: { title: string; hint: string }): React.ReactElement {
  return (
    <div
      className="rounded-md px-4 py-6"
      style={{ background: 'var(--bg-surface)', border: '1px dashed var(--border-strong)' }}
    >
      <div>{title}</div>
      <div className="mt-1 max-w-2xl" style={{ color: 'var(--text-secondary)' }}>
        {hint}
      </div>
    </div>
  )
}

function EpisodeRow({
  ep,
  onOpen,
}: {
  ep: EpisodeSummary
  onOpen: (episodeId: string, title: string) => void
}): React.ReactElement {
  const label = `第 ${ep.index} 集${ep.title ? ` · ${ep.title}` : ''}`
  return (
    <button
      type="button"
      onClick={() => onOpen(ep.id, label)}
      className="flex w-full items-center gap-4 px-3 py-2.5 text-left"
      style={{
        background: 'var(--bg-base)',
        borderTop: '1px solid var(--border)',
        // 阶段用左侧 3px 色条强化，扫视时一眼看出整季的分布（07 §6.2）
        borderLeft: `3px solid ${statusColor(ep.status, 'episode')}`,
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="tnum shrink-0" style={{ color: 'var(--text-muted)' }}>
            #{ep.index}
          </span>
          <span className="truncate font-medium">{ep.title ?? '未命名'}</span>
          <StatusPill status={ep.status} kind="episode" />
        </div>
        <div className="truncate" style={{ color: 'var(--text-secondary)' }}>
          {ep.logline ?? '—'}
        </div>
      </div>

      <div className="w-44 shrink-0">
        {ep.shots === 0 ? (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            尚无镜头
          </span>
        ) : (
          <>
            <div className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
              已锁定 {ep.locked} / {ep.shots}
            </div>
            <Progress pct={pct(ep.locked, ep.shots)} />
          </>
        )}
      </div>

      {/* 待选片是「需要人介入」的信号，用 --status-review 强调 */}
      <div className="flex w-24 shrink-0 justify-end">
        {ep.review > 0 ? (
          <StatusPill status="review" count={ep.review} />
        ) : (
          <span className="tnum" style={{ color: 'var(--text-muted)' }}>
            —
          </span>
        )}
      </div>

      <div className="tnum w-20 shrink-0 text-right">{usd(ep.costMicroUsd)}</div>
    </button>
  )
}

/** 本轮只读——资产的编辑与锁定交互见 issue #16 */
function AssetsSection({ assets }: { assets: ProjectAssets }): React.ReactElement {
  const { characters, locations, styles } = assets
  const total = characters.length + locations.length + styles.length
  const notReady = characters.filter((c) => c.lockedAt === null || missingTracks(c).length > 0).length

  if (total === 0) {
    return (
      <section>
        <SectionTitle title="资产" count={0} />
        <Empty
          title="还没有任何角色、场景或风格"
          hint="参考图是一致性的基础，建议先建角色再批量生成——角色没锁定就开工，一致性问题会级联放大，中途修正代价极高。本轮面板只读，先用 pnpm db:seed 或后端接口建角色。"
        />
      </section>
    )
  }

  return (
    <section>
      <SectionTitle title="资产" count={total} />

      {notReady > 0 && (
        <div
          className="mb-3 rounded-md px-3 py-2"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--status-review)' }}
        >
          <span style={{ color: 'var(--status-review)' }}>
            ⚠ <span className="tnum">{notReady}</span> 个角色尚未齐备或未锁定
          </span>
          <span className="ml-2" style={{ color: 'var(--text-secondary)' }}>
            三路资产没锁死就批量生成，等于在流沙上盖楼（13 §3）
          </span>
        </div>
      )}

      <AssetGroup
        title="角色"
        count={characters.length}
        emptyHint="角色是一致性的锚点——先建角色并锁定三路参考图，再批量生成，否则每一镜都会长得不一样。"
      >
        {characters.map((c) => (
          <CharacterCard key={c.id} c={c} />
        ))}
      </AssetGroup>

      <AssetGroup
        title="场景"
        count={locations.length}
        emptyHint="场景决定同一地点跨镜头的光线与陈设是否对得上，缺了就只能靠 prompt 复述。"
      >
        {locations.map((l) => (
          <AssetCard
            key={l.id}
            name={l.name}
            description={l.description}
            meta={l.interior ? '内景' : '外景'}
            locked={l.lockedAt !== null}
          />
        ))}
      </AssetGroup>

      <AssetGroup
        title="风格"
        count={styles.length}
        emptyHint="风格档案统一整部剧的影调与负向词，没有它每次生成都会各走各的。"
      >
        {styles.map((st) => (
          <AssetCard
            key={st.id}
            name={st.name}
            description={st.description}
            {...(st.negativePrompt ? { footer: `负向 ${st.negativePrompt}` } : {})}
          />
        ))}
      </AssetGroup>
    </section>
  )
}

function AssetGroup({
  title,
  count,
  emptyHint,
  children,
}: {
  title: string
  count: number
  emptyHint: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {title} <span className="tnum">{count}</span>
      </div>
      {count === 0 ? (
        <div style={{ color: 'var(--text-muted)' }}>
          还没有{title}。{emptyHint}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">{children}</div>
      )}
    </div>
  )
}

function CharacterCard({ c }: { c: Character }): React.ReactElement {
  const miss = missingTracks(c)
  return (
    <article
      className="rounded-md p-3"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${statusColor(c.lockedAt ? 'locked' : 'unlocked', 'asset')}`,
      }}
    >
      <div className="flex items-center gap-2">
        <span className="truncate font-medium">{c.name}</span>
        <span className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
          v{c.version}
        </span>
        <span className="flex-1" />
        <StatusPill status={c.lockedAt ? 'locked' : 'unlocked'} kind="asset" />
      </div>

      <div className="mt-1 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
        {c.description}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <Track label="人脸组" ok={!isEmpty(c.faceSet)} />
        <Track label="体型" ok={!isEmpty(c.bodyRef)} />
        <Track label={`服装 ${c.wardrobe.length}`} ok={c.wardrobe.length > 0} />
        <span style={{ color: 'var(--text-muted)' }}>音色 {c.voiceId ?? '未设'}</span>
      </div>

      {miss.length > 0 && (
        <div className="mt-1.5 text-[11px]" style={{ color: 'var(--status-review)' }}>
          ⚠ 未齐备 · 缺 {miss.join(' / ')}
        </div>
      )}
    </article>
  )
}

/** 三路各自的齐备状态。色 + 符号 + 文字，不靠颜色单独传意（07 §8） */
function Track({ label, ok }: { label: string; ok: boolean }): React.ReactElement {
  return (
    <span className="tnum" style={{ color: ok ? 'var(--status-success)' : 'var(--status-review)' }}>
      {ok ? '✓' : '⚠'} {label}
    </span>
  )
}

function AssetCard({
  name,
  description,
  meta,
  footer,
  locked,
}: {
  name: string
  description: string
  /** 短标记（内景 / 外景）。长文本走 footer，挤在标题行会把名字压没 */
  meta?: string
  footer?: string
  locked?: boolean
}): React.ReactElement {
  return (
    <article
      className="rounded-md p-3"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-2">
        {/* 名字优先：meta 不设 shrink-0，否则风格的负向词串会把名字挤成一个字 */}
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        {meta !== undefined && (
          <span className="min-w-0 shrink truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {meta}
          </span>
        )}
        {locked !== undefined && <StatusPill status={locked ? 'locked' : 'unlocked'} kind="asset" />}
      </div>
      <div className="mt-1 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
        {description}
      </div>
      {footer !== undefined && (
        <div className="mt-1.5 line-clamp-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {footer}
        </div>
      )}
    </article>
  )
}
