'use client'

import { api, assetUrl, usd, type EpisodeTree, type TakeRow } from '@/lib/api'
import Link from 'next/link'
import { use, useCallback, useEffect, useRef, useState } from 'react'

/**
 * 选片页（08-screen-specs.md §4）——高频重复操作，目标是**一个镜头 3 秒内
 * 决策完**，所以为键盘优化：选片和审片是重复几百次的操作，必须能脱离鼠标。
 */
export default function Review({ params }: { params: Promise<{ id: string }> }): React.ReactElement {
  const { id: projectId } = use(params)

  const [queue, setQueue] = useState<EpisodeTree['shots']>([])
  const [cursor, setCursor] = useState(0)
  const [takes, setTakes] = useState<TakeRow[]>([])
  const [busy, setBusy] = useState(false)
  const videos = useRef<(HTMLVideoElement | null)[]>([])

  const current = queue[cursor]

  const loadQueue = useCallback(async () => {
    const p = await api<{ episodes: { id: string }[] }>(`/api/projects/${projectId}`)
    const first = p.episodes[0]
    if (!first) return
    const tree = await api<EpisodeTree>(`/api/episodes/${first.id}`)
    setQueue(tree.shots.filter((x) => x.shot.status === 'review'))
  }, [projectId])

  useEffect(() => {
    void loadQueue()
  }, [loadQueue])

  useEffect(() => {
    if (!current) {
      setTakes([])
      return
    }
    void api<{ takes: TakeRow[] }>(`/api/shots/${current.shot.id}/takes`).then((r) =>
      setTakes(r.takes.filter((t) => t.take.status === 'candidate')),
    )
  }, [current])

  const select = useCallback(
    async (takeId: string) => {
      if (busy) return
      setBusy(true)
      try {
        await api(`/api/takes/${takeId}/select`, { method: 'POST' })
        // 确认后自动跳到下一个待选镜头，形成流水线节奏
        setQueue((q) => q.filter((_, i) => i !== cursor))
        setCursor((c) => Math.min(c, Math.max(0, queue.length - 2)))
      } finally {
        setBusy(false)
      }
    },
    [busy, cursor, queue.length],
  )

  /** 同步播放：三个 take 同起同停，便于逐帧对比 */
  const toggleAll = useCallback(() => {
    const list = videos.current.filter(Boolean) as HTMLVideoElement[]
    const anyPlaying = list.some((v) => !v.paused)
    for (const v of list) {
      if (anyPlaying) v.pause()
      else void v.play()
    }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      // 快捷键表见 07-design-system.md §7
      if (e.key === 'j') setCursor((c) => Math.min(c + 1, queue.length - 1))
      else if (e.key === 'k') setCursor((c) => Math.max(c - 1, 0))
      else if (e.key === ' ') {
        e.preventDefault()
        toggleAll()
      } else if (/^[1-9]$/.test(e.key)) {
        const t = takes[Number(e.key) - 1]
        if (t) void select(t.take.id)
      } else if (e.key === 'Enter') {
        const t = takes[0]
        if (t) void select(t.take.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [queue.length, takes, select, toggleAll])

  return (
    <main className="min-h-dvh">
      <header
        className="flex items-center gap-4 px-4 py-2"
        style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}
      >
        <Link href="/">← 工作台</Link>
        <span className="tnum">待选 {queue.length} 个</span>
        {current && (
          <span className="tnum" style={{ color: 'var(--text-secondary)' }}>
            #{current.shot.index} · {current.shot.shotType.toUpperCase()} ·{' '}
            {Number(current.shot.durationSec).toFixed(1)}s
          </span>
        )}
        <span className="flex-1" />
        <kbd className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          J/K 切换 · Space 播放 · 1–9 选片 · Enter 确认
        </kbd>
      </header>

      {!current ? (
        <div className="p-8" style={{ color: 'var(--text-secondary)' }}>
          没有待选镜头。去{' '}
          <Link href="/" style={{ color: 'var(--accent-text)' }}>
            工作台
          </Link>{' '}
          生成一些。
        </div>
      ) : (
        <>
          <p className="px-4 py-3">{current.shot.action}</p>
          <div className="grid gap-3 px-4 pb-6 sm:grid-cols-2 lg:grid-cols-3">
            {takes.map((t, i) => (
              <article
                key={t.take.id}
                className="overflow-hidden rounded-md"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
              >
                <video
                  ref={(el) => {
                    videos.current[i] = el
                  }}
                  src={assetUrl(t.asset.id)}
                  className="aspect-[9/16] w-full"
                  style={{ background: 'var(--bg-inset)' }}
                  muted
                  playsInline
                  loop
                  controls
                />
                <div className="p-2">
                  {/* 显示 provider 与成本——用户会自然形成「哪家在这类镜头上好用」的直觉 */}
                  <div className="tnum flex justify-between" style={{ color: 'var(--text-secondary)' }}>
                    <span>{t.job.providerId}</span>
                    <span>{usd(t.job.costMicroUsd)}</span>
                  </div>
                  <div className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    尝试 {t.job.attempt} · seed {t.job.seed ?? '—'}
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void select(t.take.id)}
                    className="mt-2 w-full rounded-md py-1.5 font-medium disabled:opacity-50"
                    style={{ background: 'var(--accent)', color: '#fff' }}
                  >
                    [{i + 1}] 选它
                  </button>
                </div>
              </article>
            ))}
            {takes.length === 0 && (
              <div style={{ color: 'var(--text-secondary)' }}>这一镜还没有候选 take。</div>
            )}
          </div>
        </>
      )}
    </main>
  )
}
