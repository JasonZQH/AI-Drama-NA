'use client'

import type { EpisodeTree } from '@/lib/api'
import { assetUrl } from '@/lib/api'

/** 一镜的实时进度。stage 来自 provider（ComfyUI 的 loading_model / denoising / …） */
export interface ShotProgress {
  pct: number
  etaMs?: number
  stage?: string
}
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Progress, StatusPill, statusColor } from './StatusPill'
import { Cost } from './Mock'

/**
 * 虚拟化的镜头网格（07-design-system.md §6.2）。
 *
 * **按行虚拟化，不按单卡**：一行是一个 DOM 节点、内部用 grid 排 N 列，
 * 这样列数随断点变化时只需要重算行的切分，不必给每张卡算 x/y 坐标。
 *
 * 虚拟化在多标签方案里不是优化而是前提：12 个标签全挂载，各自几百张卡
 * 同时在 DOM 里会把内存和样式重算拖垮
 * （见 specs/2026-08-15-web-admin-panel-design.md §3.1）。
 */

export type ShotEntry = EpisodeTree['shots'][number]

export interface SceneGroup {
  scene: { id: string; index: number; summary: string | null }
  shots: ShotEntry[]
}

type Row =
  | { kind: 'header'; key: string; scene: SceneGroup['scene']; count: number; sec: number }
  | { kind: 'cells'; key: string; items: ShotEntry[] }

const GAP = 8

/** 断点沿用原分镜页的 grid-cols-2 / sm:3 / lg:4 / xl:6 */
function colsFor(w: number): number {
  if (w < 640) return 2
  if (w < 1024) return 3
  if (w < 1280) return 4
  return 6
}

export function ShotGrid({
  groups,
  selectedId,
  onSelect,
  progress,
}: {
  groups: SceneGroup[]
  selectedId: string | null
  onSelect: (shotId: string) => void
  /** shotId → 实时进度。R1：超过 2 秒的操作必须有真实进度，不能只转圈 */
  progress?: Record<string, ShotProgress>
}): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      // 标签被 hidden 时宽度是 0；保留上一次的值，切回来时不必重排一遍
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cols = colsFor(width || 1280)

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const g of groups) {
      if (g.shots.length === 0) continue
      out.push({
        kind: 'header',
        key: `h:${g.scene.id}`,
        scene: g.scene,
        count: g.shots.length,
        sec: g.shots.reduce((a, x) => a + Number(x.shot.durationSec), 0),
      })
      for (let i = 0; i < g.shots.length; i += cols) {
        out.push({ kind: 'cells', key: `r:${g.scene.id}:${i}`, items: g.shots.slice(i, i + cols) })
      }
    }
    return out
  }, [groups, cols])

  // 估高只求「大致对」，真实高度由 measureElement 回填；估得离谱会让滚动条跳
  const rowH = useMemo(() => {
    const colW = width > 0 ? (width - (cols - 1) * GAP) / cols : 200
    return Math.min(200, (colW * 16) / 9) + 96
  }, [width, cols])

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'header' ? 44 : rowH),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 4,
  })

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
      <div className="relative w-full" style={{ height: virt.getTotalSize() }}>
        {virt.getVirtualItems().map((vi) => {
          const row = rows[vi.index]
          if (!row) return null
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virt.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              {row.kind === 'header' ? (
                <h3 className="pt-3 pb-2" style={{ color: 'var(--text-secondary)' }}>
                  SCENE {row.scene.index} · {row.scene.summary ?? '—'}
                  <span className="tnum ml-2" style={{ color: 'var(--text-muted)' }}>
                    ({row.count} 镜 · {row.sec.toFixed(1)}s)
                  </span>
                </h3>
              ) : (
                <div
                  className="grid pb-2"
                  style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP }}
                >
                  {row.items.map((e) => (
                    <ShotCard
                      key={e.shot.id}
                      entry={e}
                      selected={e.shot.id === selectedId}
                      onSelect={onSelect}
                      {...(progress?.[e.shot.id] ? { progress: progress[e.shot.id]! } : {})}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 最核心的组件，网格里出现几十次（07 §6.2）。
 * 状态用左侧 3px 色条强化，扫视时能一眼看出整屏分布。
 */
function ShotCard({
  entry,
  selected,
  onSelect,
  progress,
}: {
  entry: ShotEntry
  selected: boolean
  onSelect: (shotId: string) => void
  progress?: ShotProgress
}): React.ReactElement {
  const { shot, takeCount, costMicroUsd, mockCostMicroUsd, posterAssetId } = entry
  return (
    // button 而非 div：焦点环、Enter/Space 触发都是原生的，不用自己补 a11y
    <button
      type="button"
      onClick={() => onSelect(shot.id)}
      aria-pressed={selected}
      className="block w-full overflow-hidden rounded-md text-left"
      style={{
        background: 'var(--bg-surface)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderLeft: `3px solid ${statusColor(shot.status)}`,
      }}
    >
      {/*
        缩略图保持 9:16 真实比例，但限高——不限的话一张卡就有 500px 高，
        一屏只装得下 4 个，正是 07 §1「一屏要看到 24 个镜头」要避免的。
      */}
      <div
        className="relative mx-auto aspect-[9/16] w-full"
        style={{ background: 'var(--bg-inset)', maxHeight: 200 }}
      >
        {/*
          **封面 = 最后一次生成的第一帧。**
          用 `<video preload="metadata">` 而不是另生成一张缩略图：浏览器会把
          第一帧当 poster 画出来，省掉一整条「抽帧 → 存储 → 再取」的链路，而
          那条链路要动 media worker、存储和一张新表。
          `muted`/`playsInline` 是 iOS Safari 不黑屏的前提。
        */}
        {posterAssetId && (
          <video
            src={assetUrl(posterAssetId)}
            preload="metadata"
            muted
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <div className="absolute top-1 right-1">
          <StatusPill status={shot.status} {...(shot.status === 'review' ? { count: takeCount } : {})} />
        </div>
        {takeCount > 0 && (
          <div
            className="tnum absolute right-1 bottom-1 rounded-sm px-1 text-[11px]"
            style={{ background: 'rgb(0 0 0 / 0.6)', color: 'var(--text-secondary)' }}
          >
            {takeCount} take
          </div>
        )}
      </div>

      <div className="p-2">
        <div className="tnum" style={{ color: 'var(--text-secondary)' }}>
          #{shot.index} · {shot.shotType.toUpperCase()} · {Number(shot.durationSec).toFixed(1)}s
        </div>
        <div className="mt-0.5 line-clamp-2">{shot.action}</div>
        {progress && (
          <div className="mt-2">
            <Progress
              pct={progress.pct}
              {...(progress.etaMs ? { etaMs: progress.etaMs } : {})}
              {...(progress.stage ? { stage: progress.stage } : {})}
            />
          </div>
        )}
        <div
          className="tnum mt-1 flex items-center justify-between text-[11px]"
          style={{ color: 'var(--text-muted)' }}
        >
          <span>{shot.attemptCount > 0 ? `尝试 ${shot.attemptCount}` : ''}</span>
          {costMicroUsd > 0 && <Cost microUsd={costMicroUsd} mockMicroUsd={mockCostMicroUsd} />}
        </div>
      </div>
    </button>
  )
}
