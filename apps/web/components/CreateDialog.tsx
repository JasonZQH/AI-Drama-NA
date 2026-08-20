'use client'

import { useEffect, useState } from 'react'

/**
 * 新建记录的对话框。
 *
 * 存在的理由是它在 P0 里要用三遍（项目 / 分集，随后是场次与三路资产），且每次
 * 都是同一件事：几个字段 → POST → 拿到新 id 跳过去。**不做通用表单引擎**——
 * 字段类型只有 text / textarea / number 三种，够用就停。
 *
 * 编号（`index`）刻意不在这里出现：它由服务端取 `max + 1`，让人手填就是把撞
 * 唯一约束变成用户的问题。
 */

export interface Field {
  readonly key: string
  readonly label: string
  readonly kind?: 'text' | 'textarea' | 'number'
  readonly placeholder?: string
  readonly required?: boolean
  readonly initial?: string
  /** 说明为什么要填它。空着能省一句废话，但缺省值的后果要说清楚 */
  readonly hint?: string
}

export function CreateDialog({
  title,
  fields,
  submitLabel = '创建',
  onSubmit,
  onClose,
}: {
  title: string
  fields: readonly Field[]
  submitLabel?: string
  onSubmit: (values: Record<string, string>) => Promise<void>
  onClose: () => void
}): React.ReactElement {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])),
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const missing = fields.filter((f) => f.required && values[f.key]?.trim() === '')

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [busy, onClose])

  async function submit(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      await onSubmit(values)
    } catch (e) {
      // 报错留在对话框里，不关闭——关掉的话人刚敲的内容就没了
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
      aria-label={title}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)' }}
      >
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="text-[13px] font-medium">{title}</div>
          <div className="flex-1" />
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
            onClick={() => void submit()}
            disabled={busy || missing.length > 0}
            title={missing.length > 0 ? `还要填：${missing.map((f) => f.label).join('、')}` : ''}
            className="rounded-md px-3 py-1 text-[12px] font-medium disabled:opacity-40"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {busy ? '创建中…' : submitLabel}
          </button>
        </div>

        {err !== null && (
          <div className="px-4 pt-3 text-[12px]" style={{ color: 'var(--danger-text)' }}>
            ✕ {err}
          </div>
        )}

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {f.label}
                {f.required && <span style={{ color: 'var(--status-error)' }}> *</span>}
              </span>
              {f.kind === 'textarea' ? (
                <textarea
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder ?? ''}
                  rows={3}
                  spellCheck={false}
                  className="resize-none rounded-md p-2 text-[13px] leading-6 outline-none"
                  style={{
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                    fontFamily: 'inherit',
                  }}
                />
              ) : (
                <input
                  type={f.kind === 'number' ? 'number' : 'text'}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder ?? ''}
                  spellCheck={false}
                  className="rounded-md px-2 py-1.5 text-[13px] outline-none"
                  style={{
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                  }}
                />
              )}
              {f.hint && (
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {f.hint}
                </span>
              )}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
