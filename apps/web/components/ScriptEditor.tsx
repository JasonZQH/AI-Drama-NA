'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

/**
 * 一集的剧本正文（`episodes.script_md`）。
 *
 * 这一列从第一版迁移起就存在，但**零写入方零读取方**——于是整条流水线的
 * 起点只有 `title / logline / hook / cliffhanger` 四个短句，加起来不到 200 字。
 * 在那上面做分镜等于让模型自己编情节，而人无处干预。
 *
 * 做成抽屉不是页面：它是「偶尔编辑、常态只读」的东西，占一个常驻页面不值当，
 * 而分镜要用它的时候人就在分集页上。
 */
export function ScriptEditor({
  episodeId,
  initial,
  brief,
  onSaved,
  onClose,
}: {
  episodeId: string
  initial: string
  /** 戏剧目标三行。它们拼成 `episodeBrief` 进分镜提示词——见 callShotlist.ts */
  brief: { logline: string | null; hook: string | null; cliffhanger: string | null }
  onSaved: (scriptMd: string) => void
  onClose: () => void
}): React.ReactElement {
  const [text, setText] = useState(initial)
  const [b, setB] = useState(brief)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dirty =
    text !== initial ||
    b.logline !== brief.logline ||
    b.hook !== brief.hook ||
    b.cliffhanger !== brief.cliffhanger

  // Esc 关闭。改过没存时不关——手滑丢一整集剧本是不可接受的
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !dirty) onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [dirty, onClose])

  async function save(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      await api(`/api/episodes/${episodeId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          scriptMd: text,
          logline: b.logline,
          hook: b.hook,
          cliffhanger: b.cliffhanger,
        }),
      })
      onSaved(text)
      onClose()
    } catch (e) {
      // 失败必须可操作，且**不要关抽屉**——关了文本就没了
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      role="dialog"
      aria-modal="true"
      aria-label="剧本"
    >
      {/*
        **`h-[85vh]` 不是 `max-h-`。** 里面的 textarea 是 `flex-1`，而 flex-1
        只在父容器有确定高度时才有东西可填——用 max-h 的话父容器按内容收缩，
        textarea 就塌成两三行（实测：一整集 672 字的剧本只露出两行）。
        剧本是这个抽屉唯一的内容，吃满高度是对的。
      */}
      <div
        className="flex h-[85vh] w-full max-w-3xl flex-col rounded-lg"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)' }}
      >
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="text-[13px] font-medium">剧本</div>
          <div className="tnum text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {text.length} 字{dirty ? ' · 未保存' : ''}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[12px] disabled:opacity-40"
            style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
          >
            {dirty ? '放弃修改' : '关闭'}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !dirty}
            className="rounded-md px-3 py-1 text-[12px] font-medium disabled:opacity-40"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>

        {err !== null && (
          <div className="px-4 py-2 text-[12px]" style={{ color: 'var(--danger-text)' }}>
            ✕ {err}
          </div>
        )}

        {/*
          **戏剧目标三行。** 这三列 S1 就写好落库了，而在这之前面板上**没有任何
          写入口**——只有建集对话框能填 logline，hook / cliffhanger 只能 curl。
          而它们现在正是 `episodeBrief` 的来源：不填的话，模型拿到的是一份不知道
          要往哪儿走的剧本。
        */}
        <div
          className="flex flex-col gap-2 px-4 pb-3 pt-1"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          {(
            [
              ['logline', '一句话', '她回到一座已经不认识她的城市'],
              ['hook', '钩子', '前 3 秒要留住人的那件事'],
              ['cliffhanger', '悬念', '这一集结尾把人钉在下一集的那件事'],
            ] as const
          ).map(([k, label, ph]) => (
            <label key={k} className="grid grid-cols-[52px_1fr] items-baseline gap-x-3">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {label}
              </span>
              <input
                value={b[k] ?? ''}
                onChange={(e) => setB((x) => ({ ...x, [k]: e.target.value }))}
                placeholder={ph}
                className="w-full rounded-md px-2 py-1 text-[13px] outline-none"
                style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                }}
              />
            </label>
          ))}
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            这三行会拼成 &lt;episode&gt; 进分镜提示词——它们是这一集的戏剧目标，剧本是过程
          </span>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder="把这一集的剧本粘进来。分镜会读它——不填的话模型只能看到 logline 和 hook，得自己编情节。"
          className="min-h-0 flex-1 resize-none rounded-b-lg p-4 text-[13px] leading-6 outline-none"
          style={{ background: 'transparent', color: 'var(--text-primary)', fontFamily: 'inherit' }}
        />
      </div>
    </div>
  )
}
