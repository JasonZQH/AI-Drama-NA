'use client'

import { api, assetUrl } from '@/lib/api'
import { use, useEffect, useState } from 'react'

/**
 * 播放器（08-screen-specs.md §7）。
 *
 * 与 Studio 分离的路由组，是**成品验收视角**——用观众的眼睛看，而不是
 * 生产者的眼睛。生产者太容易陷入镜头细节而忘了整体观感，切到这个视角
 * 能发现分镜页发现不了的问题。
 *
 * 有母版就放母版；还没渲染时退回逐镜连播，好让人在拼接前也能预览。
 */
interface Playlist {
  title: string
  index: number
  clips: { takeId: string; assetId: string; shotIndex: number }[]
}

export default function Watch({ params }: { params: Promise<{ episodeId: string }> }): React.ReactElement {
  const { episodeId } = use(params)
  const [list, setList] = useState<Playlist | null>(null)
  const [i, setI] = useState(0)

  const [master, setMaster] = useState<{ assetId: string; durationSec: number | null } | null>(null)

  useEffect(() => {
    void (async () => {
      // 优先母版：拼接过的成片才是「观众看到的东西」
      const w = await api<{ masterAssetId: string | null; durationSec: number | null }>(
        `/api/watch/${episodeId}`,
      )
      if (w.masterAssetId) setMaster({ assetId: w.masterAssetId, durationSec: w.durationSec })

      const tree = await api<{
        episode: { title: string | null; index: number }
        shots: { shot: { id: string; index: number; selectedTakeId: string | null } }[]
      }>(`/api/episodes/${episodeId}`)

      const clips: Playlist['clips'] = []
      for (const { shot } of tree.shots) {
        if (!shot.selectedTakeId) continue
        const r = await api<{ takes: { take: { id: string }; asset: { id: string } }[] }>(
          `/api/shots/${shot.id}/takes`,
        )
        const chosen = r.takes.find((t) => t.take.id === shot.selectedTakeId)
        if (chosen) clips.push({ takeId: chosen.take.id, assetId: chosen.asset.id, shotIndex: shot.index })
      }
      setList({ title: tree.episode.title ?? '未命名', index: tree.episode.index, clips })
    })()
  }, [episodeId])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'ArrowRight') setI((x) => Math.min(x + 1, (list?.clips.length ?? 1) - 1))
      if (e.key === 'ArrowLeft') setI((x) => Math.max(x - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [list])

  if (master) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-4">
        <video
          src={assetUrl(master.assetId)}
          className="w-full rounded-md"
          style={{ background: 'var(--bg-inset)', aspectRatio: '9 / 16' }}
          controls
          autoPlay
          playsInline
        />
        <div className="mt-3">
          <div className="font-medium">
            第 {list?.index ?? '—'} 集 · {list?.title ?? ''}
          </div>
          <div className="tnum" style={{ color: 'var(--text-muted)' }}>
            成片母版{master.durationSec ? ` · ${master.durationSec.toFixed(1)}s` : ''}
          </div>
        </div>
      </main>
    )
  }

  if (!list) return <main className="p-8">载入中…</main>

  if (list.clips.length === 0) {
    return (
      <main className="mx-auto max-w-md p-8" style={{ color: 'var(--text-secondary)' }}>
        本集还没有选定的镜头。先去选片页锁定一些，这里才有得放。
      </main>
    )
  }

  const clip = list.clips[i]!

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-4">
      <video
        key={clip.takeId}
        src={assetUrl(clip.assetId)}
        className="w-full rounded-md"
        style={{ background: 'var(--bg-inset)', aspectRatio: '9 / 16' }}
        controls
        autoPlay
        playsInline
        // 连播：一条放完自动下一条
        onEnded={() => setI((x) => Math.min(x + 1, list.clips.length - 1))}
      />
      <div className="mt-3 flex items-center justify-between">
        <div>
          <div className="font-medium">
            第 {list.index} 集 · {list.title}
          </div>
          <div className="tnum" style={{ color: 'var(--text-muted)' }}>
            镜头 {clip.shotIndex} · {i + 1}/{list.clips.length}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setI((x) => Math.max(x - 1, 0))}
            disabled={i === 0}
            className="rounded-md px-3 py-1.5 disabled:opacity-40"
            style={{ border: '1px solid var(--border-strong)' }}
          >
            ◀
          </button>
          <button
            type="button"
            onClick={() => setI((x) => Math.min(x + 1, list.clips.length - 1))}
            disabled={i === list.clips.length - 1}
            className="rounded-md px-3 py-1.5 disabled:opacity-40"
            style={{ border: '1px solid var(--border-strong)' }}
          >
            ▶
          </button>
        </div>
      </div>
    </main>
  )
}
