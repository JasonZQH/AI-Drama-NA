'use client'

import { MockChip } from '@/components/Mock'
import { PromptPreview } from '@/components/PromptPreview'
import { StatusPill, statusColor } from '@/components/StatusPill'
import { api, assetUrl, usd, type JobRow, type TakeRow } from '@/lib/api'
import { useEffect, useRef, useState } from 'react'

/**
 * 镜头详情抽屉 —— `07-design-system.md` §6.2 的 `PromptInspector` 落点。
 *
 * 「这是 R3 的落地：失败时用户第一件事就是看这里。」所以三个区块的次序
 * 不是随意的：意图 → 每次尝试的完整 prompt 与失败码 → 产出的 takes。
 * 中间那块是主角，另外两块是它的上下文。
 *
 * intent 由调用方传入而非本组件拉取：镜头网格手上已有 `EpisodeTree` 的
 * 整行 shot，再发一次请求纯属浪费；也没有单镜头端点可用。
 */
export interface ShotIntent {
  id?: string
  index: number
  shotType: string
  action: string
  durationSec: string
  status: string
  dialogue?: string | null
  cameraMove?: string | null
  emotion?: string | null
  promptOverride?: string | null
  /** **本镜自己报的**移除事件，不是投影。投影由服务端读时算 */
  hiddenAnchors?: string[]
}

const SHOT_TYPE: Record<string, string> = {
  ecu: '大特写',
  cu: '特写',
  ms: '中景',
  ws: '全景',
  establishing: '定场',
  ots: '过肩',
  pov: '主观',
}

const CAMERA_MOVE: Record<string, string> = {
  static: '固定',
  pan: '横摇',
  tilt: '纵摇',
  dolly: '推轨',
  orbit: '环绕',
  handheld: '手持',
}

const JOB_STATUS: Record<string, { label: string; color: string }> = {
  queued: { label: '排队中', color: 'var(--status-idle)' },
  submitted: { label: '已提交', color: 'var(--status-running)' },
  running: { label: '生成中', color: 'var(--status-running)' },
  downloading: { label: '下载中', color: 'var(--status-running)' },
  evaluating: { label: '评估中', color: 'var(--status-running)' },
  succeeded: { label: '成功', color: 'var(--status-success)' },
  failed: { label: '失败', color: 'var(--status-error)' },
  cancelled: { label: '已取消', color: 'var(--status-cancelled)' },
}

const TAKE_STATUS: Record<string, { label: string; color: string }> = {
  candidate: { label: '候选', color: 'var(--status-review)' },
  selected: { label: '已选用', color: 'var(--status-success)' },
  rejected: { label: '已拒绝', color: 'var(--status-cancelled)' },
  archived: { label: '已归档', color: 'var(--status-cancelled)' },
}

/**
 * 失败码解释与可重试性，逐条对应 `packages/contracts` 的 `NON_RETRYABLE`
 * （`05-job-orchestration.md` §5.3）。这里重写一份而不是 import：只为三个
 * 字符串把 zod 与全部 schema 拉进客户端包不划算，且每条都要配中文解释。
 * **不可重试的意思是「同 prompt 再来一次只会再被拒，纯烧配额」**，
 * 界面必须说出来，否则用户会一直点重试。
 */
const FAILURE: Record<string, { retryable: boolean; why: string; next: string }> = {
  provider_error: {
    retryable: true,
    why: 'provider 侧报错，多为临时故障。',
    next: '可直接重试；连续多次同码要考虑换 provider。',
  },
  timeout: {
    retryable: true,
    why: 'provider 超时未返回结果。',
    next: '可直接重试；反复超时说明该档位排队严重，换 provider 更快。',
  },
  download_failed: {
    retryable: true,
    why: '产物已生成但下载失败，通常是网络或存储抖动。',
    next: '可直接重试，成本已经花了但资产没落地。',
  },
  eval_rejected: {
    retryable: true,
    why: '自动评估判定不达标（清晰度 / 一致性 / 时长）。',
    next: '可重试；同一原因连续出现时改 Intent 比换 seed 有效。',
  },
  cancelled: {
    retryable: true,
    why: '任务被取消，不是生成质量问题。',
    next: '可直接重新发起。',
  },
  content_filtered: {
    retryable: false,
    why: '该 prompt 被 provider 的内容策略拒绝。同 prompt 重试必然再被拒，纯烧配额。',
    next: '改写 Intent 里触发策略的措辞，或改用 self-host provider 生成。',
  },
  quota_exceeded: {
    retryable: false,
    why: '该 provider 的配额或限流已耗尽。重试只会加剧问题。',
    next: '暂停该 provider，换一个再生成，或等配额窗口重置。',
  },
  invalid_output: {
    retryable: false,
    why: '产物不符合契约——适配器 bug 或该模型能力不匹配，重试无用。',
    next: '换 provider 生成；同时这是需要修代码的信号。',
  },
  /**
   * 这一条的措辞是全表最要紧的：**它是唯一一个「可能已经计费」的失败码**。
   * 缺了它会落到兜底文案「先看详情，再决定重试还是改 Intent」——把
   * 「钱可能已经花了、别急着重来」显示成「大概可以重试」，正好说反。
   */
  submit_unknown: {
    retryable: false,
    why: '提交请求已发出，但没收到回应——可能已经计费，也可能根本没送到。系统故意停在这里，不替你自动再花一次钱。',
    next: '先到 provider 后台核对这笔有没有产生账单，确认没有再点「重新发起」。',
  },
}

interface Props {
  shotId: string | null
  /** 镜头意图。调用方（镜头网格）手上已有这行数据，直接传下来 */
  shot?: ShotIntent | null
  onClose: () => void
  /** 改完要让父组件重取——`shot` 是它给的，抽屉自己没有数据源 */
  onChanged: () => void
}

export function ShotDrawer({ shotId, shot, onClose, onChanged }: Props): React.ReactElement | null {
  if (!shotId) return null
  // key 让换镜头时整块重挂载：复制反馈、details 展开态都跟着重置，
  // 省掉一整套「shotId 变了要清哪些 state」的手工同步
  return (
    <Panel key={shotId} shotId={shotId} {...(shot ? { shot } : {})} onClose={onClose} onChanged={onChanged} />
  )
}

function Panel({
  shotId,
  shot,
  onClose,
  onChanged,
}: {
  shotId: string
  shot?: ShotIntent
  onChanged: () => void
  onClose: () => void
}): React.ReactElement {
  const [jobs, setJobs] = useState<JobRow[] | null>(null)
  const [takes, setTakes] = useState<TakeRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setErr(null)
    void (async () => {
      try {
        const [j, t] = await Promise.all([
          api<{ jobs: JobRow[] }>(`/api/shots/${shotId}/jobs`),
          api<{ takes: TakeRow[] }>(`/api/shots/${shotId}/takes`),
        ])
        if (!alive) return
        setJobs(j.jobs)
        setTakes(t.takes)
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [shotId, reload])

  // 焦点移进抽屉，关闭时还回原处，否则键盘用户看不见自己在操作什么。
  // 这个 effect 的依赖必须是空的：onClose 的引用随父组件每次渲染而变，
  // 挂在它上面会在每次 SSE 心跳后把焦点从用户正在操作的元素上抢走
  useEffect(() => {
    const prev = document.activeElement
    panelRef.current?.focus()
    return () => {
      if (prev instanceof HTMLElement) prev.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const spent = (jobs ?? []).reduce((a, j) => a + (j.costMicroUsd ?? 0), 0)

  /*
   * 随流的右侧栏，不是覆盖全屏的模态。
   *
   * 模态会盖住外壳的标签栏与常驻队列指示——而读一条 prompt 的典型场景恰恰是
   * 「另外 11 个镜头正在生成」，此时禁止切标签、看不见队列是本末倒置。
   * 代价是网格变窄一档（虚拟化的 ResizeObserver 会自己重排列数）。
   */
  return (
    <>
      <style>{`
        @keyframes sd-in { from { transform: translateX(100%) } to { transform: none } }
        .sd-panel { animation: sd-in .18s ease-out }
        @media (prefers-reduced-motion: reduce) { .sd-panel { animation: none } }
      `}</style>

      <aside
        ref={panelRef}
        role="complementary"
        aria-label={shot ? `镜头 ${shot.index} 详情` : '镜头详情'}
        tabIndex={-1}
        className="sd-panel flex h-full shrink-0 flex-col"
        style={{
          width: 'min(480px, 100vw)',
          background: 'var(--bg-surface)',
          borderLeft: '1px solid var(--border)',
        }}
      >
        <header
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <span className="tnum font-medium">{shot ? `镜头 #${shot.index}` : '镜头详情'}</span>
          {shot && <StatusPill status={shot.status} />}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-sm px-2 py-1"
            style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {shot && <Intent shot={shot} onSaved={onChanged} />}

          <Section title="Prompt 检视器" hint={jobs ? `${jobs.length} 次尝试 · 合计 ${usd(spent)}` : ''}>
            {/*
              先给「下一次会发出去什么」，再给历史。
              此前这一格在零尝试时只说「没有 prompt 可看」——而恰恰是没生成过的
              时候最需要看：花钱之前。见 06-api-spec.md 的 prompt-preview。
            */}
            <div className="mb-3">
              <PromptPreview
                shotId={shotId}
                canGenerate={shot?.status === 'ready'}
                onGenerated={() => setReload((n) => n + 1)}
                ownEvents={shot?.hiddenAnchors ?? []}
                onChanged={onChanged}
              />
              {/*
                锁定之后唯一的出路。`redo.requested` 从第一版就在状态机里，但一直
                零发射方——于是「这一镜我不满意，重来」在产品上不存在，而
                「有选定成片就不再花钱」那道闸给的出路正是它。
              */}
              {shot?.status === 'locked' && (
                <button
                  type="button"
                  className="mt-2 rounded-md px-2 py-1 text-[12px]"
                  style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
                  onClick={() => {
                    void api(`/api/shots/${shotId}/redo`, { method: 'POST' }).then(() =>
                      setReload((n) => n + 1),
                    )
                  }}
                  title="把选中的成片归档，这一镜回到「待生成」。已花的钱不退，产物不删"
                >
                  重做这一镜
                </button>
              )}
            </div>
            {err ? (
              /* R3：失败要说明是什么、以及下一步 */
              <div
                className="rounded-md p-3"
                style={{ background: 'var(--bg-inset)', border: '1px solid var(--status-error)' }}
              >
                <div style={{ color: 'var(--status-error)' }}>✕ 生成记录载入失败</div>
                <div className="mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {err}
                </div>
                <button
                  type="button"
                  className="mt-2 rounded-sm px-2 py-1"
                  style={{ border: '1px solid var(--border-strong)' }}
                  onClick={() => setReload((n) => n + 1)}
                >
                  重新载入
                </button>
              </div>
            ) : !jobs ? (
              <Skeleton lines={3} label="正在读取生成记录…" />
            ) : jobs.length === 0 ? (
              <Empty
                text="还没有生成尝试，所以下面没有历史。"
                next="上面那段就是点「生成」会发出去的内容。确认弹窗会先告诉你要花多少钱。"
              />
            ) : (
              /* 倒序：诊断失败时最新一次尝试才是现场，历史是佐证 */
              [...jobs]
                .sort((a, b) => b.attempt - a.attempt)
                .map((job, i) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    prev={jobs.find((x) => x.attempt === job.attempt - 1) ?? null}
                    open={i === 0}
                  />
                ))
            )}
          </Section>

          <Section title="Takes" hint={takes ? `${takes.length} 个` : ''}>
            {!takes && !err ? (
              <Skeleton lines={2} label="正在读取候选片段…" />
            ) : takes && takes.length === 0 ? (
              <Empty
                text="还没有候选片段——尝试要么全失败了，要么还在跑。"
                next="先看上面最后一次尝试的失败码：可重试的直接重试，不可重试的先改 Intent 或换 provider。"
              />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {(takes ?? []).map((t) => (
                  <TakeCard key={t.take.id} row={t} />
                ))}
              </div>
            )}
          </Section>
        </div>
      </aside>
    </>
  )
}

/**
 * Intent **可编辑**。
 *
 * 在这之前 `shots` 上唯一能写的字段是 `provider_hint`，这一格是纯展示——分镜
 * 一旦生成就是只读的，第 3 镜写错一个词只有 redo（同一个 prompt 重掷骰子）或者
 * 删掉整集重来两条路。
 *
 * ## 为什么是「编辑模式 + 显式保存」，不是 SceneEditor 那种失焦即存
 *
 * 保存会走 `intent.edited`：**已经花钱生成的 take 会被归档，镜头回到待生成**。
 * 场次那边失焦即存是安全的（改摘要不销毁任何产物），这里不是——一次误触的失焦
 * 就把选好的成片作废了。所以要显式点保存，而且在 `review`/`locked` 上先把后果
 * 写在按钮旁边。
 */
function Intent({ shot, onSaved }: { shot: ShotIntent; onSaved: () => void }): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(shot)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 外部刷新（重新生成、别处改了）要能盖回来
  useEffect(() => setV(shot), [shot])

  const set = (patch: Partial<ShotIntent>): void => setV((x) => ({ ...x, ...patch }))
  const destructive = shot.status === 'review' || shot.status === 'locked'

  async function save(): Promise<void> {
    if (!shot.id) return
    setBusy(true)
    setErr(null)
    try {
      await api(`/api/shots/${shot.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          shotType: v.shotType,
          cameraMove: v.cameraMove ?? null,
          action: v.action,
          emotion: v.emotion ?? null,
          dialogue: v.dialogue ?? null,
          durationSec: Number(v.durationSec),
          promptOverride: v.promptOverride ?? null,
        }),
      })
      setEditing(false)
      onSaved()
    } catch (e) {
      // 报错留在表单里，别关闭——关了人刚敲的就没了
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (editing)
    return (
      <Section title="Intent">
        <div
          className="flex flex-col gap-2 rounded-md p-3"
          style={{ background: 'var(--bg-inset)', border: '1px solid var(--border-strong)' }}
        >
          {err !== null && (
            <div className="text-[12px]" style={{ color: 'var(--danger-text)' }}>
              ✕ {err}
            </div>
          )}
          <Row label="景别">
            <select value={v.shotType} onChange={(e) => set({ shotType: e.target.value })} style={CTL}>
              {Object.entries(SHOT_TYPE).map(([k, label]) => (
                <option key={k} value={k}>
                  {label} {k.toUpperCase()}
                </option>
              ))}
            </select>
          </Row>
          <Row label="运镜">
            <select
              value={v.cameraMove ?? ''}
              onChange={(e) => set({ cameraMove: e.target.value || null })}
              style={CTL}
            >
              <option value="">未定</option>
              {Object.entries(CAMERA_MOVE).map(([k, label]) => (
                <option key={k} value={k}>
                  {label} {k}
                </option>
              ))}
            </select>
          </Row>
          <Row label="动作">
            <textarea
              value={v.action}
              onChange={(e) => set({ action: e.target.value })}
              rows={2}
              style={CTL}
              className="resize-none leading-6"
            />
          </Row>
          <Row label="情绪">
            <input
              value={v.emotion ?? ''}
              onChange={(e) => set({ emotion: e.target.value })}
              placeholder="可见的表情或体态，不写内心感受"
              style={CTL}
            />
          </Row>
          <Row label="台词">
            <input
              value={v.dialogue ?? ''}
              onChange={(e) => set({ dialogue: e.target.value })}
              placeholder="只写说的话，不写说话人"
              style={CTL}
            />
          </Row>
          <Row label="时长">
            <input
              type="number"
              step={1}
              min={1}
              max={10}
              value={v.durationSec}
              onChange={(e) => set({ durationSec: e.target.value })}
              style={CTL}
              className="tnum w-24"
            />
          </Row>
          <Row label="旁路">
            <textarea
              value={v.promptOverride ?? ''}
              onChange={(e) => set({ promptOverride: e.target.value })}
              rows={2}
              placeholder="填了就整段原样发给 provider，上面的拼装被完全跳过。留空 = 自动拼"
              style={CTL}
              className="resize-none leading-6"
            />
          </Row>

          {destructive && (
            <div className="text-[11px]" style={{ color: 'var(--status-review)' }}>
              ⚠ 这一镜已经有成片了。保存会把它归档、镜头回到「待生成」——已经花的钱不退，
              产物不删，但要重新生成一次才有新的。
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || v.action.trim().length < 4}
              title={v.action.trim().length < 4 ? '动作至少 4 个字符' : ''}
              className="rounded-md px-3 py-1 text-[12px] font-medium disabled:opacity-40"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              {busy ? '保存中…' : destructive ? '保存并作废现有成片' : '保存'}
            </button>
            <button
              type="button"
              onClick={() => {
                setV(shot)
                setErr(null)
                setEditing(false)
              }}
              disabled={busy}
              className="rounded-md px-3 py-1 text-[12px] disabled:opacity-40"
              style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
            >
              取消
            </button>
          </div>
        </div>
      </Section>
    )

  const rows: [string, string][] = [
    ['景别', SHOT_TYPE[shot.shotType] ?? shot.shotType.toUpperCase()],
    ['运镜', shot.cameraMove ? (CAMERA_MOVE[shot.cameraMove] ?? shot.cameraMove) : '—'],
    ['动作', shot.action],
    ['情绪', shot.emotion ?? '—'],
    ['台词', shot.dialogue ?? '—'],
    ['时长', `${Number(shot.durationSec).toFixed(1)}s`],
    ...(shot.promptOverride ? ([['旁路', shot.promptOverride]] as [string, string][]) : []),
  ]
  return (
    <Section
      title="Intent"
      action={
        shot.id ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md px-2 py-0.5 text-[11px]"
            style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
          >
            编辑
          </button>
        ) : null
      }
    >
      <div
        className="rounded-md"
        style={{
          background: 'var(--bg-inset)',
          border: '1px solid var(--border)',
          borderLeft: `3px solid ${statusColor(shot.status)}`,
        }}
      >
        <dl className="grid grid-cols-[52px_1fr] gap-x-3 gap-y-1.5 p-3">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
              <dd className={k === '时长' ? 'tnum' : undefined}>{v}</dd>
            </div>
          ))}
          <dt style={{ color: 'var(--text-muted)' }}>状态</dt>
          <dd>
            <StatusPill status={shot.status} />
          </dd>
        </dl>
      </div>
    </Section>
  )
}

/**
 * 一次尝试一张卡。**跟上一次比有什么变化**必须一眼看得出来，否则记录没有
 * 诊断价值，用户只会看到「又失败了」。
 *
 * ⚠️ 注意现状：`05` §5.2 描述的「换 seed → 强化 prompt → 换 provider」
 * **还没有实现**——重试用的是完全相同的参数，所以下面的差异对比目前恒为空。
 * 这不是渲染的 bug，是编排层还没变更任何东西（随 provider 路由器一并落地）。
 * 这段对比逻辑先留着：它一落地就自动有内容，删了反而要再写一遍。
 */
function JobCard({
  job,
  prev,
  open,
}: {
  job: JobRow
  prev: JobRow | null
  /** 最新一次尝试默认展开——失败诊断的现场就在这里 */
  open: boolean
}): React.ReactElement {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(job.promptText)
      setCopied('ok')
    } catch {
      // 非安全上下文（http 直连 IP）下 clipboard 不可用，说出来好过静默
      setCopied('fail')
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 1600)
  }

  const st = JOB_STATUS[job.status] ?? { label: job.status, color: 'var(--status-idle)' }
  const fail = job.failureCode ? FAILURE[job.failureCode] : undefined

  const changes: string[] = []
  if (prev) {
    if (prev.providerId !== job.providerId || prev.modelId !== job.modelId) changes.push('换了 provider')
    if (prev.promptText !== job.promptText) changes.push('强化了 prompt')
    if (prev.seed !== job.seed) changes.push('换了 seed')
    if (prev.negativeText !== job.negativeText) changes.push('改了负向词')
  }

  return (
    <article
      className="mb-2 rounded-md"
      style={{
        background: 'var(--bg-raised)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${st.color}`,
      }}
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <span className="tnum font-medium">尝试 {job.attempt}</span>
        <span style={{ color: st.color }}>{st.label}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-sm px-2 py-0.5 text-[11px]"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          复制 prompt
        </button>
        <span
          aria-live="polite"
          className="text-[11px]"
          style={{ color: copied === 'fail' ? 'var(--status-error)' : 'var(--status-success)' }}
        >
          {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : ''}
        </span>
      </div>

      <div
        className="tnum flex flex-wrap gap-x-3 px-3 pt-1 text-[11px]"
        style={{ color: 'var(--text-muted)' }}
      >
        <span>
          {job.providerId} / {job.modelId}
          {job.providerId === 'mock' && (
            <>
              {' '}
              <MockChip />
            </>
          )}
        </span>
        {/*
          估算值要看得出来是估算的。
          超时与「提交结果未知」这两种失败照样计费，但金额只能按价目表估——
          把它和 provider 回报的真实计费画成一样，就是在报表上撒谎（约束 C4）。
        */}
        <span title={job.costEstimated ? '按价目表估算，非 provider 回报的真实计费' : undefined}>
          {job.costEstimated ? '≈' : ''}
          {usd(job.costMicroUsd)}
        </span>
        <span>{job.latencyMs === null ? '—' : `${(job.latencyMs / 1000).toFixed(1)}s`}</span>
        <span>seed {job.seed ?? '—'}</span>
        <span>{new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
      </div>

      {changes.length > 0 && (
        <div className="px-3 pt-1.5">
          <span
            className="rounded-sm px-1.5 py-0.5 text-[11px]"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}
          >
            本次{changes.join(' · ')}
          </span>
        </div>
      )}

      {/* details 是原生的可折叠，自带展开态与键盘可达，不需要自己搭 */}
      <details open={open} className="px-3 pt-2">
        <summary className="cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
          Prompt<span className="tnum"> · {job.promptText.length} 字</span>
        </summary>
        <pre
          className="mt-1.5 max-h-80 overflow-auto rounded-sm p-2 text-[12px] leading-[18px] whitespace-pre-wrap"
          style={{ background: 'var(--bg-inset)', fontFamily: 'var(--font-mono)' }}
        >
          {job.promptText}
        </pre>
      </details>

      {job.negativeText && (
        <details className="px-3 pt-1.5">
          <summary className="cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            负向词<span className="tnum"> · {job.negativeText.length} 字</span>
          </summary>
          <pre
            className="mt-1.5 max-h-40 overflow-auto rounded-sm p-2 text-[12px] leading-[18px] whitespace-pre-wrap"
            style={{ background: 'var(--bg-inset)', fontFamily: 'var(--font-mono)' }}
          >
            {job.negativeText}
          </pre>
        </details>
      )}

      {job.failureCode && (
        <div
          className="m-3 mt-2 rounded-sm p-2"
          style={{ background: 'var(--bg-inset)', border: '1px solid var(--status-error)' }}
        >
          <div className="flex items-center gap-2">
            <span style={{ color: 'var(--status-error)', fontFamily: 'var(--font-mono)' }}>
              ✕ {job.failureCode}
            </span>
            <span
              className="rounded-sm px-1.5 py-0.5 text-[11px]"
              style={{
                color: fail?.retryable === false ? 'var(--status-error)' : 'var(--status-review)',
                border: `1px solid ${fail?.retryable === false ? 'var(--status-error)' : 'var(--status-review)'}`,
              }}
            >
              {fail === undefined ? '重试性未知' : fail.retryable ? '可重试' : '不可重试'}
            </span>
          </div>
          <div className="mt-1" style={{ color: 'var(--text-secondary)' }}>
            {fail?.why ?? '未收录的失败码，按 provider 返回的详情判断。'}
          </div>
          <div className="mt-1" style={{ color: 'var(--text-secondary)' }}>
            下一步：{fail?.next ?? '先看下面的详情，再决定重试还是改 Intent。'}
          </div>
          {job.failureDetail && (
            <pre
              className="mt-1.5 max-h-32 overflow-auto text-[11px] whitespace-pre-wrap"
              style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
            >
              {job.failureDetail}
            </pre>
          )}
        </div>
      )}
      {!job.failureCode && <div className="h-3" />}
    </article>
  )
}

function TakeCard({ row }: { row: TakeRow }): React.ReactElement {
  const st = TAKE_STATUS[row.take.status] ?? { label: row.take.status, color: 'var(--status-idle)' }
  return (
    <figure className="overflow-hidden rounded-md" style={{ border: '1px solid var(--border)' }}>
      <video
        src={assetUrl(row.asset.id)}
        controls
        muted
        playsInline
        preload="metadata"
        className="aspect-[9/16] w-full"
        style={{ background: 'var(--bg-inset)', maxHeight: 200 }}
      />
      <figcaption className="p-2">
        <div className="flex items-center justify-between">
          <span style={{ color: st.color }}>● {st.label}</span>
          <span className="tnum" style={{ color: 'var(--text-secondary)' }}>
            {usd(row.job.costMicroUsd)}
          </span>
        </div>
        <div className="tnum mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {row.job.providerId} · 尝试 {row.job.attempt} · seed {row.job.seed ?? '—'}
          {row.job.providerId === 'mock' && (
            <>
              {' '}
              <MockChip />
            </>
          )}
        </div>
        {row.asset.durationSec !== null && (
          <div className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {Number(row.asset.durationSec).toFixed(1)}s
          </div>
        )}
      </figcaption>
    </figure>
  )
}

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string
  hint?: string
  /** 右上角的动作按钮（Intent 的「编辑」） */
  action?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
      <h3 className="mb-2 flex items-baseline gap-2">
        <span style={{ color: 'var(--text-secondary)' }}>{title}</span>
        {hint && (
          <span className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {hint}
          </span>
        )}
        {action && (
          <>
            <span className="flex-1" />
            {action}
          </>
        )}
      </h3>
      {children}
    </section>
  )
}

/** Intent 编辑表单的一行：左标签右控件，与只读态的 dl 对齐 */
function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="grid grid-cols-[52px_1fr] items-baseline gap-x-3">
      <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      {children}
    </label>
  )
}

const CTL = {
  background: 'var(--bg-base)',
  border: '1px solid var(--border)',
  color: 'var(--text-primary)',
  borderRadius: '6px',
  padding: '4px 8px',
  fontSize: '13px',
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%',
} as const

/** 空白等于「坏了」。骨架 + 明确文案，让人知道是在等而不是在卡 */
function Skeleton({ lines, label }: { lines: number; label: string }): React.ReactElement {
  return (
    <div aria-live="polite">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="pulse mb-2 h-12 rounded-md"
          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
        />
      ))}
      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
    </div>
  )
}

/** 空态必须给下一步动作，不能只写「暂无数据」 */
function Empty({ text, next }: { text: string; next: string }): React.ReactElement {
  return (
    <div
      className="rounded-md p-3"
      style={{ background: 'var(--bg-inset)', border: '1px dashed var(--border-strong)' }}
    >
      <div style={{ color: 'var(--text-secondary)' }}>{text}</div>
      <div className="mt-1" style={{ color: 'var(--text-muted)' }}>
        {next}
      </div>
    </div>
  )
}
