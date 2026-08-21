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
