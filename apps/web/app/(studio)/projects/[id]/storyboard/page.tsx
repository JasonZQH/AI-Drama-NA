'use client'

import { ConfirmSpend } from '@/components/ConfirmSpend'
import { Progress, StatusPill, statusColor } from '@/components/StatusPill'
import { api, usd, type DryRunPlan, type EpisodeTree } from '@/lib/api'
import { useStudioEvents, type StudioEvent } from '@/lib/events'
import Link from 'next/link'
import { use, useCallback, useEffect, useState } from 'react'

/**
 * 分镜页（08-screen-specs.md §2）——用户 80% 的时间在这里。
 *
 * 一屏要能看到 24 个镜头的状态，而不是 6 个大卡片：信息密度高于呼吸感，
 * 留白服务于分组不服务于美观（07 §1）。
 */
export default function Storyboard({ params }: { params: Promise<{ id: string }> }): React.ReactElement {
  const { id: projectId } = use(params)

  const [tree, setTree] = useState<EpisodeTree | null>(null)
  const [episodeId, setEpisodeId] = useState<string | null>(null)
  const [plan, setPlan] = useState<DryRunPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, { pct: number; etaMs?: number }>>({})

  const load = useCallback(async () => {
    const p = await api<{ episodes: { id: string }[] }>(`/api/projects/${projectId}`)
    const first = p.episodes[0]
    if (!first) return
    setEpisodeId(first.id)
    setTree(await api<EpisodeTree>(`/api/episodes/${first.id}`))
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  // 长任务不阻塞导航：进度由 SSE 维持，不轮询（07 §7）
  const onEvent = useCallback(
    (e: StudioEvent) => {
      if (e.type === 'job.progress') {
        setProgress((p) => ({ ...p, [e.shotId]: { pct: e.pct, ...(e.etaMs ? { etaMs: e.etaMs } : {}) } }))
      } else if (e.type === 'shot.status' || e.type === 'take.created') {
        // 状态跃迁了就清掉这一镜的进度条——它已经不在生成中
        setProgress((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== e.shotId)))
        void load()
      }
    },
    [load],
  )
  const connected = useStudioEvents(projectId, onEvent)

  /** 「生成整集」先 dryRun——把「要花多少钱、几个被阻塞」先算出来（06 §4） */
  async function openConfirm(): Promise<void> {
    if (!episodeId) return
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
    if (!episodeId) return
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

  if (!tree) {
    return (
      <main className="p-6" style={{ color: 'var(--text-secondary)' }}>
        载入中…
      </main>
    )
  }

  const totalSec = tree.shots.reduce((a, x) => a + Number(x.shot.durationSec), 0)
  const pending = tree.shots.filter((x) => x.shot.status === 'review').length

  return (
    <main className="min-h-dvh">
      {/* 顶栏：QueueIndicator 与 CostMeter 在所有页面常驻（08 §0） */}
      <header
        className="sticky top-0 z-10 flex items-center gap-4 px-4 py-2"
        style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}
      >
        <Link href="/" className="font-medium">
          ai-drama-studio
        </Link>
        <span style={{ color: 'var(--text-muted)' }}>/</span>
        <span className="tnum">
          第 {tree.episode.index} 集 · {tree.shots.length} 镜 · {totalSec.toFixed(1)}s
        </span>
        <span className="flex-1" />
        <span
          className="tnum text-[11px]"
          style={{ color: connected ? 'var(--status-success)' : 'var(--status-idle)' }}
        >
          {connected ? '● 实时已连接' : '○ 实时未连接'}
        </span>
        {pending > 0 && (
          <Link
            href={`/projects/${projectId}/review`}
            className="rounded-md px-2 py-1"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}
          >
            选片 {pending}
          </Link>
        )}
        <button
          type="button"
          onClick={() => void openConfirm()}
          className="rounded-md px-3 py-1.5 font-medium"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          生成整集
        </button>
      </header>

      {err && (
        /* R3：失败要说明是什么、以及下一步 */
        <div
          className="mx-4 mt-3 rounded-md p-3"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--status-error)' }}
        >
          <div style={{ color: 'var(--status-error)' }}>✕ {err}</div>
          <button
            type="button"
            className="mt-2 rounded-sm px-2 py-1"
            style={{ border: '1px solid var(--border-strong)' }}
            onClick={() => setErr(null)}
          >
            知道了
          </button>
        </div>
      )}

      {tree.scenes.map((scene) => {
        const shots = tree.shots.filter((x) => x.shot.sceneId === scene.id)
        if (shots.length === 0) return null
        const sec = shots.reduce((a, x) => a + Number(x.shot.durationSec), 0)
        return (
          <section key={scene.id} className="px-4 py-3">
            <h2 className="mb-2" style={{ color: 'var(--text-secondary)' }}>
              SCENE {scene.index} · {scene.summary ?? '—'}
              <span className="tnum ml-2" style={{ color: 'var(--text-muted)' }}>
                ({shots.length} 镜 · {sec.toFixed(1)}s)
              </span>
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {shots.map(({ shot, takeCount, costMicroUsd }) => (
                <ShotCard
                  key={shot.id}
                  shot={shot}
                  takeCount={takeCount}
                  costMicroUsd={costMicroUsd}
                  {...(progress[shot.id] ? { progress: progress[shot.id]! } : {})}
                />
              ))}
            </div>
          </section>
        )
      })}

      {plan && (
        <ConfirmSpend
          plan={plan}
          busy={busy}
          onCancel={() => setPlan(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </main>
  )
}

/**
 * 最核心的组件，网格里出现几十次（07 §6.2）。
 * 状态用左侧 3px 色条强化，扫视时能一眼看出整屏分布。
 */
function ShotCard({
  shot,
  takeCount,
  costMicroUsd,
  progress,
}: {
  shot: EpisodeTree['shots'][number]['shot']
  takeCount: number
  costMicroUsd: number
  progress?: { pct: number; etaMs?: number }
}): React.ReactElement {
  return (
    <article
      className="overflow-hidden rounded-md"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${statusColor(shot.status)}`,
      }}
    >
      {/*
        缩略图保持 9:16 真实比例，但限高——不限的话一张卡就有 500px 高，
        一屏只装得下 4 个，正是 07 §1「一屏要能看到 24 个镜头，而不是
        6 个大卡片」要避免的。限高后缩略图居中，比例不失真。
      */}
      <div
        className="relative mx-auto aspect-[9/16] w-full"
        style={{ background: 'var(--bg-inset)', maxHeight: 200 }}
      >
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
            <Progress pct={progress.pct} {...(progress.etaMs ? { etaMs: progress.etaMs } : {})} />
          </div>
        )}
        <div
          className="tnum mt-1 flex items-center justify-between text-[11px]"
          style={{ color: 'var(--text-muted)' }}
        >
          <span>{shot.attemptCount > 0 ? `尝试 ${shot.attemptCount}` : ''}</span>
          <span>{costMicroUsd > 0 ? usd(costMicroUsd) : ''}</span>
        </div>
      </div>
    </article>
  )
}
