'use client'

import { StatusPill, statusColor } from '@/components/StatusPill'
import { PageHeader } from '@/components/Shell'
import { api, type ProjectAssets } from '@/lib/api'
import { useCallback, useEffect, useState } from 'react'

type Character = ProjectAssets['characters'][number]

const isEmpty = (v: unknown): boolean => v === null || v === undefined

/**
 * 三路资产（face_set / body_ref / wardrobe）缺哪几路。
 *
 * 13-character-assets.md §3 的闸门：参考图没锁死就开始批量生成，等于在流沙上
 * 盖楼。所以「缺什么」必须直接可见，而不是等批量生成翻车才发现。
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

/** 资产页。本轮只读——编辑与锁定的交互见 issue #16 */
export function AssetsView({ projectId }: { projectId: string }): React.ReactElement {
  const [assets, setAssets] = useState<ProjectAssets | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      setAssets(await api<ProjectAssets>(`/api/projects/${projectId}/assets`))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    document.title = '资产 · ai-drama-studio'
  }, [])

  const chars = assets?.characters ?? []
  const notReady = chars.filter((c) => c.lockedAt === null || missingTracks(c).length > 0).length
  const total = chars.length + (assets?.locations.length ?? 0) + (assets?.styles.length ?? 0)

  return (
    <>
      <PageHeader title="资产" subtitle={assets ? `${total} 项 · 本轮只读` : ''} />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {err ? (
          <div
            className="rounded-md p-3 text-[12px]"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--status-error)' }}
          >
            <div style={{ color: 'var(--status-error)' }}>✕ 载入资产失败：{err}</div>
            <button
              type="button"
              className="mt-2 rounded-sm px-2 py-1"
              style={{ border: '1px solid var(--border-strong)' }}
              onClick={() => void load()}
            >
              重试
            </button>
          </div>
        ) : !assets ? (
          <div style={{ color: 'var(--text-muted)' }}>载入中…</div>
        ) : (
          <div className="flex flex-col gap-4">
            {notReady > 0 && (
              <div
                className="rounded-md px-3 py-2 text-[12px]"
                style={{
                  background: 'color-mix(in srgb, var(--status-review) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--status-review) 40%, transparent)',
                }}
              >
                <span style={{ color: 'var(--status-review)' }}>
                  ⚠ <span className="tnum">{notReady}</span> 个角色尚未齐备或未锁定
                </span>
                <span className="ml-2" style={{ color: 'var(--text-secondary)' }}>
                  三路资产没锁死就批量生成，等于在流沙上盖楼（13 §3）
                </span>
              </div>
            )}

            <Group
              title="角色"
              count={chars.length}
              emptyHint="角色是一致性的锚点——先建角色并锁定三路参考图，再批量生成，否则每一镜都会长得不一样。"
            >
              {chars.map((c) => (
                <CharacterCard key={c.id} c={c} />
              ))}
            </Group>

            <Group
              title="场景"
              count={assets.locations.length}
              emptyHint="场景决定同一地点跨镜头的光线与陈设是否对得上，缺了就只能靠 prompt 复述。"
            >
              {assets.locations.map((l) => (
                <Card
                  key={l.id}
                  name={l.name}
                  description={l.description}
                  meta={l.interior ? '内景' : '外景'}
                  locked={l.lockedAt !== null}
                />
              ))}
            </Group>

            <Group
              title="风格"
              count={assets.styles.length}
              emptyHint="风格档案统一整部剧的影调与负向词，没有它每次生成都会各走各的。"
            >
              {assets.styles.map((st) => (
                <Card
                  key={st.id}
                  name={st.name}
                  description={st.description}
                  {...(st.negativePrompt ? { footer: `负向 ${st.negativePrompt}` } : {})}
                />
              ))}
            </Group>
          </div>
        )}
      </div>
    </>
  )
}

export default AssetsView

function Group({
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
    <div>
      <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {title} <span className="tnum">{count}</span>
      </div>
      {count === 0 ? (
        <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
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
      className="rounded-md p-2.5"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${statusColor(c.lockedAt ? 'locked' : 'unlocked', 'asset')}`,
      }}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
        <span className="tnum shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          v{c.version}
        </span>
        <StatusPill status={c.lockedAt ? 'locked' : 'unlocked'} kind="asset" />
      </div>

      <div className="mt-1 line-clamp-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {c.description}
      </div>

      {/* 每一路各给一个 ✓/⚠ 加文字，不靠颜色单独传意（07 §8） */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <Track label="人脸组" ok={!isEmpty(c.faceSet)} />
        <Track label="体型" ok={!isEmpty(c.bodyRef)} />
        <Track label={`服装 ${c.wardrobe.length}`} ok={c.wardrobe.length > 0} />
        {c.voiceId && <span style={{ color: 'var(--text-muted)' }}>音色 {c.voiceId}</span>}
      </div>

      {miss.length > 0 && (
        <div className="mt-1 text-[11px]" style={{ color: 'var(--status-review)' }}>
          ⚠ 未齐备 · 缺 {miss.join(' / ')}
        </div>
      )}
    </article>
  )
}

function Track({ label, ok }: { label: string; ok: boolean }): React.ReactElement {
  return (
    <span className="tnum" style={{ color: ok ? 'var(--status-success)' : 'var(--status-review)' }}>
      {ok ? '✓' : '⚠'} {label}
    </span>
  )
}

function Card({
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
      className="rounded-md p-2.5"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        {meta !== undefined && (
          <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {meta}
          </span>
        )}
        {locked !== undefined && <StatusPill status={locked ? 'locked' : 'unlocked'} kind="asset" />}
      </div>
      <div className="mt-1 line-clamp-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
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
