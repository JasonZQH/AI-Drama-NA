'use client'

import { api } from '@/lib/api'
import { useEffect, useState } from 'react'

/**
 * 三路资产的编辑器（PR-G）。
 *
 * 在这之前资产页页头写着「本轮只读」——0 个按钮、0 个输入框。于是「调提示词」
 * 在面板上根本做不到，尽管这三张表的内容正是每一条 prompt 的主体。
 *
 * ## 只开真正进 prompt 的字段
 *
 * `buildPrompt` 实际读的就这些：角色的 `name`/`description`/`anchorTokens`、
 * 地点的再加 `interior`、风格的 `description`/`negativePrompt`。
 *
 * **不开**参考图那一路（`faceSet`/`bodyRef`/`referenceAssetIds`）——「要不要
 * 参考图、要几张、怎么绑」是 P6 的 U1–U3 要买的答案，现在做表单是在流沙上盖楼。
 * 而且它们不是文本框，是文件上传 + 存储 + 人脸检测。
 *
 * ## `wardrobe` 只做文字那一半
 *
 * 「这一场 Lena 穿睡衣」进 prompt 不需要图，需要的是一段文字。图那一半的用途
 * 是喂给视频模型当参考图，同样卡在 P6 后面。所以这里每套服装只有名字 + 描述，
 * 与 `characters.face_set` 可空是同一个理由：**角色卡先于参考图存在**。
 */

export type AssetKind = 'character' | 'location' | 'style'

export interface Outfit {
  id: string
  name: string
  description: string
}

export interface AssetRow {
  id?: string
  name?: string
  description?: string
  anchorTokens?: string[]
  interior?: boolean
  negativePrompt?: string | null
  voiceId?: string | null
  wardrobe?: Outfit[]
}

const LABEL: Record<AssetKind, string> = { character: '角色', location: '地点', style: '风格' }
const PATH: Record<AssetKind, string> = { character: 'characters', location: 'locations', style: 'styles' }

export function AssetEditor({
  kind,
  projectId,
  initial,
  onClose,
  onSaved,
}: {
  kind: AssetKind
  projectId: string
  /** 有 id = 编辑，无 id = 新建 */
  initial: AssetRow
  onClose: () => void
  onSaved: () => void
}): React.ReactElement {
  const [v, setV] = useState<AssetRow>({ ...initial })
  const [anchors, setAnchors] = useState((initial.anchorTokens ?? []).join('\n'))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const editing = Boolean(initial.id)

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [busy, onClose])

  const set = (patch: Partial<AssetRow>): void => setV((x) => ({ ...x, ...patch }))

  async function save(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const body: Record<string, unknown> = {
        name: v.name?.trim(),
        description: v.description ?? '',
        ...(kind !== 'style' ? { anchorTokens: anchors } : {}),
        ...(kind === 'location' ? { interior: v.interior ?? true } : {}),
        ...(kind === 'style' ? { negativePrompt: v.negativePrompt ?? null } : {}),
        ...(kind === 'character' ? { voiceId: v.voiceId ?? null, wardrobe: v.wardrobe ?? [] } : {}),
      }
      if (editing)
        await api(`/api/${PATH[kind]}/${initial.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      else
        await api(`/api/projects/${projectId}/${PATH[kind]}`, { method: 'POST', body: JSON.stringify(body) })
      onSaved()
    } catch (e) {
      // 报错留在对话框里，不关闭——关了人刚敲的内容就没了
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      await api(`/api/${PATH[kind]}/${initial.id}`, { method: 'DELETE' })
      onSaved()
    } catch (e) {
      // 三处引用都没有外键，服务端会告诉你还有谁在用它
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      role="dialog"
      aria-modal="true"
      aria-label={`${editing ? '编辑' : '新建'}${LABEL[kind]}`}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-lg"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)' }}
      >
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="text-[13px] font-medium">
            {editing ? '编辑' : '新建'}
            {LABEL[kind]}
          </div>
          <div className="flex-1" />
          {editing && (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="rounded-md px-2 py-1 text-[12px] disabled:opacity-40"
              style={{ border: '1px solid var(--border-strong)', color: 'var(--danger-text)' }}
            >
              删除
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[12px] disabled:opacity-40"
            style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !v.name?.trim()}
            title={v.name?.trim() ? '' : `${LABEL[kind]}要有名字`}
            className="rounded-md px-3 py-1 text-[12px] font-medium disabled:opacity-40"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>

        {err !== null && (
          <div className="px-4 pt-3 text-[12px]" style={{ color: 'var(--danger-text)' }}>
            ✕ {err}
          </div>
        )}

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
          <Field label="名字" required>
            <input
              value={v.name ?? ''}
              onChange={(e) => set({ name: e.target.value })}
              className={INPUT}
              style={INPUT_STYLE}
            />
          </Field>

          <Field
            label="描述"
            hint={
              kind === 'style'
                ? '整句进 prompt 的最后一句。例：cinematic, high contrast, cool shadows'
                : '进 prompt 的固定描述。写外观，不写剧情'
            }
          >
            <textarea
              value={v.description ?? ''}
              onChange={(e) => set({ description: e.target.value })}
              rows={2}
              className={`${INPUT} resize-none leading-6`}
              style={INPUT_STYLE}
            />
          </Field>

          {kind === 'location' && (
            <Field label="内外景" hint="决定 prompt 里是 indoors 还是 outdoors">
              <div className="flex gap-2">
                {[true, false].map((b) => (
                  <button
                    key={String(b)}
                    type="button"
                    onClick={() => set({ interior: b })}
                    className="rounded-md px-3 py-1 text-[12px]"
                    style={
                      (v.interior ?? true) === b
                        ? { background: 'var(--accent)', color: '#fff' }
                        : { border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }
                    }
                  >
                    {b ? '内景 indoors' : '外景 outdoors'}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {kind !== 'style' && (
            <Field
              label="锚点"
              hint="一行一个。跨镜头一致性的载体（ADR-0008）——每一镜都带着同一串进 prompt，模型才有机会画成同一个"
            >
              <textarea
                value={anchors}
                onChange={(e) => setAnchors(e.target.value)}
                rows={3}
                placeholder={'silver crescent pendant\nbeige trench coat'}
                className={`${INPUT} resize-none leading-6`}
                style={INPUT_STYLE}
              />
            </Field>
          )}

          {kind === 'style' && (
            <Field
              label="负向词"
              hint="OpenRouter 的统一请求体没有这个字段，走 passthrough；seedance 全系不支持会被忽略"
            >
              <input
                value={v.negativePrompt ?? ''}
                onChange={(e) => set({ negativePrompt: e.target.value })}
                placeholder="cartoon, watermark, text overlay"
                className={INPUT}
                style={INPUT_STYLE}
              />
            </Field>
          )}

          {kind === 'character' && (
            <>
              <Field label="音色 ID" hint="M3 的 TTS 会读它。现在填了不影响生成">
                <input
                  value={v.voiceId ?? ''}
                  onChange={(e) => set({ voiceId: e.target.value })}
                  className={INPUT}
                  style={INPUT_STYLE}
                />
              </Field>
              <WardrobeEditor value={v.wardrobe ?? []} onChange={(w) => set({ wardrobe: w })} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 服装。**只有文字，没有图。**
 *
 * 每套的 `description` 就是「这一场穿什么」进 prompt 的那段文字。选哪一套由
 * `scenes.state_in` 决定（PR-L），这里只负责有哪些可选。
 */
function WardrobeEditor({
  value,
  onChange,
}: {
  value: Outfit[]
  onChange: (v: Outfit[]) => void
}): React.ReactElement {
  const patch = (i: number, p: Partial<Outfit>): void =>
    onChange(value.map((o, k) => (k === i ? { ...o, ...p } : o)))
  return (
    <Field label="服装" hint="睡衣版 / 工作版 / 休闲版…。按场选，选哪套由场次的角色状态决定">
      <div className="flex flex-col gap-2">
        {value.map((o, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={o.name}
              onChange={(e) => patch(i, { name: e.target.value, id: e.target.value || o.id })}
              placeholder="睡衣版"
              className={`${INPUT} w-28 shrink-0`}
              style={INPUT_STYLE}
            />
            <input
              value={o.description}
              onChange={(e) => patch(i, { description: e.target.value })}
              placeholder="grey flannel pajamas, bare feet"
              className={`${INPUT} flex-1`}
              style={INPUT_STYLE}
            />
            <button
              type="button"
              onClick={() => onChange(value.filter((_, k) => k !== i))}
              className="rounded-md px-2 text-[12px]"
              style={{ border: '1px solid var(--border-strong)', color: 'var(--text-muted)' }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange([...value, { id: `outfit-${value.length + 1}`, name: '', description: '' }])
          }
          className="self-start rounded-md px-2 py-1 text-[12px]"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          + 加一套
        </button>
      </div>
    </Field>
  )
}

const INPUT = 'rounded-md px-2 py-1.5 text-[13px] outline-none'
const INPUT_STYLE = {
  background: 'var(--bg-base)',
  border: '1px solid var(--border)',
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
} as const

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
        {label}
        {required && <span style={{ color: 'var(--status-error)' }}> *</span>}
      </span>
      {children}
      {hint && (
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </span>
      )}
    </label>
  )
}
