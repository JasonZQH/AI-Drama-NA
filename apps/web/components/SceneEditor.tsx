'use client'

import { api, type ProjectAssets } from '@/lib/api'
import { useCallback, useEffect, useState } from 'react'

/**
 * 场次编辑（PR-F）。
 *
 * ## 为什么它是真的卡住人
 *
 * 场次是分镜的**必需输入**——`POST /api/episodes/:id/shotlist` 第一件事就是查它，
 * 没有就 409。而在这之前场次在面板上**完全看不见**：`ShotGrid` 确实会渲染
 * `SCENE 1 · 摘要` 的分组头，但那是**按镜头分组**出来的，零镜头时整个网格被空态
 * 替换掉。于是刚建的一集里，你既看不到场次也建不了场次。
 *
 * 端点 P0-A 就全有了（POST/PATCH/DELETE），这里只补 UI。
 *
 * ## 做成抽屉不是常驻区块
 *
 * 「一页不超过一屏」是硬约束（08 §0），而分集页的主体是镜头网格。场次是
 * 「偶尔编辑、常态只读」的东西，与剧本抽屉同一个定位。
 *
 * ## `locationId` 是这一页最要紧的字段
 *
 * `resolvePrompt` 的 leftJoin 走的就是它：`scenes.location_id → locations`。
 * 场次不挂地点 = 这一场的每一条 prompt 里**没有任何环境描述**。
 */

interface Scene {
  id: string
  index: number
  summary: string | null
  timeOfDay: string | null
  /** 自由文本光照。有它就压过 timeOfDay 的固定词，见 pipeline/prompt.ts */
  lighting: string | null
  locationId: string | null
}

const TIMES = [
  { v: '', label: '未定' },
  { v: 'day', label: '白天 daytime' },
  { v: 'night', label: '夜晚 night' },
  { v: 'dawn', label: '黎明 dawn light' },
  { v: 'dusk', label: '黄昏 dusk light' },
]

/** 场次拆解提案的形状。与 `POST /api/episodes/:id/breakdown` 的响应同构 */
interface Proposal {
  breakdown: {
    scenes: {
      summary: string
      locationName: string
      characterNames: string[]
      timeOfDay: string
      lighting: string
    }[]
    targetDurationSec: number
  }
  missing: { locations: string[]; characters: string[] }
  durationNote: string | null
}

/** 服务端认的四格。别的一律落 null——猜一个错的时段比留空更贵 */
const TIME_OF_DAY = new Set(['day', 'night', 'dawn', 'dusk'])

export function SceneEditor({
  episodeId,
  projectId,
  scenes,
  onChanged,
  onClose,
}: {
  episodeId: string
  projectId: string
  scenes: Scene[]
  onChanged: () => void
  onClose: () => void
}): React.ReactElement {
  const [locations, setLocations] = useState<ProjectAssets['locations']>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [proposing, setProposing] = useState(false)
  const [proposal, setProposal] = useState<Proposal | null>(null)

  /** 读剧本，回一份场次建议。**不建场次**——看完再决定 */
  async function propose(): Promise<void> {
    setProposing(true)
    setErr(null)
    try {
      setProposal(await api<Proposal>(`/api/episodes/${episodeId}/breakdown`, { method: 'POST' }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setProposing(false)
    }
  }

  /**
   * 采用建议：逐场建。
   *
   * **地点只在名字对得上现有资产时才挂**——建议里的名字是自由文本（那正是它能报出
   * 「你缺门外走廊」的原因），挂一个不存在的 id 会 500。对不上的留空，人去资产页
   * 补完再回来挂。
   */
  async function adopt(): Promise<void> {
    if (!proposal) return
    const byName = new Map(locations.map((l) => [l.name.trim().toLowerCase(), l.id]))
    await run(async () => {
      for (const sc of proposal.breakdown.scenes) {
        const locationId = byName.get(sc.locationName.trim().toLowerCase()) ?? null
        await api(`/api/episodes/${episodeId}/scenes`, {
          method: 'POST',
          body: JSON.stringify({
            summary: sc.summary,
            lighting: sc.lighting || null,
            timeOfDay: TIME_OF_DAY.has(sc.timeOfDay) ? sc.timeOfDay : null,
            locationId,
          }),
        })
      }
      // 建议时长是这一步顺带产出的，一并落到分集上——人当初填的那个是凭空的
      await api(`/api/episodes/${episodeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ targetDurationSec: proposal.breakdown.targetDurationSec }),
      })
      setProposal(null)
    })
  }

  const loadLocations = useCallback(async () => {
    try {
      setLocations((await api<ProjectAssets>(`/api/projects/${projectId}/assets`)).locations)
    } catch {
      // 地点取不到不该挡住场次编辑本身
    }
  }, [projectId])

  useEffect(() => {
    void loadLocations()
  }, [loadLocations])

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [busy, onClose])

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      // 服务端会说清「这一场下面有 N 个镜头」这类，原样显示
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const patch = (id: string, body: Record<string, unknown>): Promise<void> =>
    run(() => api(`/api/scenes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }))

  /** 下拉末项的「新建地点」——真实节奏是写着写着才发现需要一个新场景 */
  async function newLocation(sceneId: string): Promise<void> {
    const name = window.prompt('新地点的名字')?.trim()
    if (!name) return
    await run(async () => {
      const r = await api<{ location: { id: string } }>(`/api/projects/${projectId}/locations`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      await api(`/api/scenes/${sceneId}`, {
        method: 'PATCH',
        body: JSON.stringify({ locationId: r.location.id }),
      })
      await loadLocations()
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      role="dialog"
      aria-modal="true"
      aria-label="场次"
    >
      <div
        className="flex max-h-[85vh] min-h-[40vh] w-full max-w-3xl flex-col rounded-lg"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)' }}
      >
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="text-[13px] font-medium">场次</div>
          <div className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {scenes.length} 场 · 分镜按它切镜头
          </div>
          <div className="flex-1" />
          {/*
            **从剧本读场次。** 场次此前只有人能建，而系统不读剧本——下游却把场次数
            当硬约束（分镜提示词「Do not add, drop, or merge scenes」+ lint 的 E1）。
            五场的剧本手建两场，模型必须把五场塞进两格，而没有任何一层会说一句话。

            这里回的是**建议**：看完再决定采不采用，采用了才真的建场次。
          */}
          <button
            type="button"
            disabled={busy || proposing}
            onClick={() => void propose()}
            title="读剧本，给一份场次划分建议（约 $0.002）。不会直接建场次"
            className="rounded-md px-2 py-1 text-[12px] disabled:opacity-40"
            style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
          >
            {proposing ? '读取中…' : '✎ 从剧本读场次'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() => api(`/api/episodes/${episodeId}/scenes`, { method: 'POST', body: '{}' }))
            }
            className="rounded-md px-2 py-1 text-[12px] disabled:opacity-40"
            style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
          >
            + 加一场
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1 text-[12px] font-medium disabled:opacity-40"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            完成
          </button>
        </div>

        {err !== null && (
          <div className="px-4 pt-3 text-[12px]" style={{ color: 'var(--danger-text)' }}>
            ✕ {err}
          </div>
        )}

        {proposal && (
          <div
            className="mx-4 mt-3 flex flex-col gap-2 rounded-md p-3"
            style={{ background: 'var(--bg-inset)', border: '1px solid var(--accent)' }}
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[12px] font-medium">建议 {proposal.breakdown.scenes.length} 场</span>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                建议整集 {proposal.breakdown.targetDurationSec} 秒
              </span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setProposal(null)}
                className="rounded-md px-2 py-0.5 text-[11px]"
                style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
              >
                丢弃
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void adopt()}
                className="rounded-md px-2 py-0.5 text-[11px] font-medium disabled:opacity-40"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                采用（建 {proposal.breakdown.scenes.length} 场）
              </button>
            </div>
            {proposal.breakdown.scenes.map((x, i) => (
              <div key={i} className="text-[12px]">
                <span style={{ color: 'var(--text-muted)' }}>
                  {i + 1}. [{x.locationName || '未指定'}]{' '}
                </span>
                {x.summary}
                {x.lighting && <span style={{ color: 'var(--text-muted)' }}> · 光：{x.lighting}</span>}
              </div>
            ))}
            {/*
              「剧本里的资产要列全」唯一能被系统查出来的时刻。参考图那条路还没通，
              文字是描述环境的唯一来源——列不全，那一镜的环境只能靠模型猜。
            */}
            {(proposal.missing.locations.length > 0 || proposal.missing.characters.length > 0) && (
              <div className="text-[11px]" style={{ color: 'var(--status-review)' }}>
                ⚠ 资产库里还没有：
                {[...proposal.missing.locations, ...proposal.missing.characters].join('、')}
                —— 去资产页补上，不然这些场的环境／人物只能靠模型猜
              </div>
            )}
            {proposal.durationNote && (
              <div className="text-[11px]" style={{ color: 'var(--status-review)' }}>
                ⚠ {proposal.durationNote}
              </div>
            )}
          </div>
        )}

        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-4">
          {scenes.length === 0 && (
            <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              这一集还没有场次。分镜是按场次切的——没有场次，「生成分镜」会直接拒绝。 点右上角「+ 加一场」。
            </div>
          )}

          {scenes.map((sc) => (
            <div
              key={sc.id}
              className="flex flex-col gap-2 rounded-md p-2.5"
              style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-center gap-2">
                <span className="tnum shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  SCENE {sc.index}
                </span>
                <SummaryInput value={sc.summary ?? ''} onSave={(v) => void patch(sc.id, { summary: v })} />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => api(`/api/scenes/${sc.id}`, { method: 'DELETE' }))}
                  title="有镜头的场次删不掉——会让全集镜号出现空洞"
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] disabled:opacity-40"
                  style={{ border: '1px solid var(--border-strong)', color: 'var(--text-muted)' }}
                >
                  ✕
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                {/* 地点：resolvePrompt 的 leftJoin 走的就是它。不挂 = prompt 里没有环境描述 */}
                <select
                  value={sc.locationId ?? ''}
                  onChange={(e) => {
                    if (e.target.value === '__new') void newLocation(sc.id)
                    else void patch(sc.id, { locationId: e.target.value || null })
                  }}
                  className="rounded-md px-2 py-1 outline-none"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    color: sc.locationId ? 'var(--text-primary)' : 'var(--status-review)',
                  }}
                >
                  <option value="">⚠ 没挂地点</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}（{l.interior ? '内景' : '外景'}）
                    </option>
                  ))}
                  <option value="__new">+ 新建地点…</option>
                </select>

                <select
                  value={sc.timeOfDay ?? ''}
                  onChange={(e) => void patch(sc.id, { timeOfDay: e.target.value || null })}
                  className="rounded-md px-2 py-1 outline-none"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {TIMES.map((t) => (
                    <option key={t.v} value={t.v}>
                      {t.label}
                    </option>
                  ))}
                </select>

                {!sc.locationId && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    不挂地点的话，这一场的每一条 prompt 里都没有环境描述
                  </span>
                )}
              </div>

              {/*
                **光照：自由文本压过上面那个枚举。**
                四个枚举格（day/night/dawn/dusk）映射成四个固定英文词，而光照
                恰恰是短剧里区分度最高的一项——「路灯刚亮，招牌还没全开」与
                「深夜」在画面上完全是两回事。枚举留作粗分桶。
              */}
              <SummaryInput
                value={sc.lighting ?? ''}
                onSave={(v) => void patch(sc.id, { lighting: v })}
                placeholder={`光照（可留空，留空就用上面那个「${TIMES.find((t) => t.v === (sc.timeOfDay ?? ''))?.label ?? '未定'}」）`}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 摘要输入。失焦即存，**但改了没存时要看得见**。
 *
 * 第一版是裸 `<input defaultValue>` + `onBlur` 保存：功能是对的，可是人在框里
 * 敲完字直接关抽屉，文字看着还在、实际一个字都没落库——**静默丢失**。
 * e2e 实测撞到了这个（三场只有失焦过的那一场存住）。
 *
 * 现在：受控 + 脏标记 + Enter 也存。不做「关闭时拦截」——那是剧本抽屉的量级
 * （一整集的正文），一行摘要值不上一个确认框。
 */
function SummaryInput({
  value,
  onSave,
  placeholder = '这一场发生了什么（进分镜提示词的 SCENES 列表）',
}: {
  value: string
  onSave: (v: string) => void
  placeholder?: string
}): React.ReactElement {
  const [v, setV] = useState(value)
  // 外部刷新（新建场次、别处改了）要能盖回来
  useEffect(() => setV(value), [value])
  const dirty = v !== value

  return (
    <div className="relative min-w-0 flex-1">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => dirty && onSave(v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && dirty) onSave(v)
          if (e.key === 'Escape') setV(value)
        }}
        placeholder={placeholder}
        className="w-full rounded-md px-2 py-1 pr-14 text-[13px] outline-none"
        style={{
          background: 'var(--bg-surface)',
          border: `1px solid ${dirty ? 'var(--status-review)' : 'var(--border)'}`,
          color: 'var(--text-primary)',
        }}
      />
      {dirty && (
        <span
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px]"
          style={{ color: 'var(--status-review)' }}
        >
          未保存
        </span>
      )}
    </div>
  )
}
