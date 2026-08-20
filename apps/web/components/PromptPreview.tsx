'use client'

import { api } from '@/lib/api'
import { useCallback, useEffect, useState } from 'react'

/**
 * 「这一镜**下一次**会发出去什么」。
 *
 * 对应 `06-api-spec.md:108` 的 `prompt-preview`，那里写着它是**调试利器**：
 * 让人在花钱生成前先看清将要发出去的 prompt 长什么样。
 *
 * 放在镜头抽屉里而不是单独一页：想看它的时刻，人就在这个镜头上。此前这一格的
 * 空态是「这个镜头还没有任何生成尝试，所以没有 prompt 可看」——而**恰恰是没生成
 * 过的时候最需要看**。
 *
 * 预览与真实生成走服务端同一个 `resolvePrompt`，不是前端另拼一份。
 */

interface Preview {
  prompt: string
  negativePrompt: string | null
  overridden: boolean
  inputs: {
    characters: { name: string; description: string; anchorTokens: string[] }[]
    location: { description: string; interior: boolean; anchorTokens: string[] } | null
    style: { description: string; negativePrompt: string | null } | null
    timeOfDay: string | null
  }
}

export function PromptPreview({ shotId }: { shotId: string }): React.ReactElement {
  const [p, setP] = useState<Preview | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      setP(await api<Preview>('/api/ai/prompt-preview', { method: 'POST', body: JSON.stringify({ shotId }) }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [shotId])

  useEffect(() => {
    void load()
  }, [load])

  if (err)
    return (
      <div className="rounded-md p-2 text-[12px]" style={{ color: 'var(--danger-text)' }}>
        ✕ 预览失败：{err}
      </div>
    )
  if (!p)
    return (
      <div className="p-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        …
      </div>
    )

  const missing = [
    p.inputs.characters.length === 0 ? '角色' : null,
    p.inputs.location ? null : '地点',
    p.inputs.style ? null : '风格',
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          下一次会发出去的（不花钱、不入队）
        </span>
        {p.overridden && (
          <span
            className="rounded-sm px-1.5 py-0.5 text-[10px]"
            style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}
          >
            人工旁路 · 拼装已跳过
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-sm px-1.5 py-0.5 text-[11px]"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          重算
        </button>
      </div>

      <pre
        className="whitespace-pre-wrap rounded-md p-2.5 font-mono text-[12px] leading-5"
        style={{ background: 'var(--bg-inset)', border: '1px solid var(--border)' }}
      >
        {p.prompt}
      </pre>

      {p.negativePrompt && (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          负向词 <code className="font-mono">{p.negativePrompt}</code>
          <span className="ml-1">· 来自 style_profiles，seedance 全系不支持会被忽略</span>
        </div>
      )}

      {/*
        缺哪一路资产要说出来。空着不是错误——空镜没有角色是合法的——但
        「风格没挂上」这种是配置问题，不说的话人只会觉得 prompt 怎么这么短。
      */}
      {missing.length > 0 && (
        <div className="text-[11px]" style={{ color: 'var(--status-review)' }}>
          ⚠ 没有取到{missing.join(' / ')}
          {!p.inputs.style && '（风格要先在项目上挂 styleProfileId 才会进 prompt）'}
        </div>
      )}
    </div>
  )
}
