'use client'

import { api, usd } from '@/lib/api'
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
  /** 路由**真正会选中的那一家**的报价。null = 池里没有能力匹配的 provider */
  estimate: { providerId: string; modelId: string; costMicroUsd: number } | null
  /** `shots.provider_hint`。null = 自动路由，而自动路由会选中池里第一个（mock） */
  providerHint: string | null
  pool: { id: string; modelId: string; costMicroUsd: number | null }[]
  inputs: {
    characters: { name: string; description: string; anchorTokens: string[] }[]
    location: { description: string; interior: boolean; anchorTokens: string[] } | null
    style: { description: string; negativePrompt: string | null } | null
    timeOfDay: string | null
    /** 到这一镜为止已经不在角色身上的锚点。少一个词看起来最像 bug，所以要能看见 */
    hiddenTraits: string[]
  }
}

export function PromptPreview({
  shotId,
  canGenerate,
  onGenerated,
  ownEvents,
  onChanged,
}: {
  shotId: string
  /** 只有 ready 的镜头能生成。别的状态下不给按钮，省得点了才被状态机拒 */
  canGenerate: boolean
  onGenerated: () => void
  /**
   * **本镜自己报的**那些移除（`shots.hidden_anchors`），不是投影。
   *
   * 勾选框显示的是投影（到这一镜为止哪些不在了），但写回去只能写本镜的事件——
   * 前面某一镜标掉的东西，要去那一镜取消。两者混起来的话，用户会以为自己在
   * 这一镜取消了，实际什么都没发生。
   */
  ownEvents: readonly string[]
  onChanged: () => void
}): React.ReactElement {
  const [p, setP] = useState<Preview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

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

  async function setHint(providerHint: string | null): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      await api(`/api/shots/${shotId}/provider`, {
        method: 'PATCH',
        body: JSON.stringify({ providerHint }),
      })
      await load() // 重算报价——换一家价钱完全不同
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function generate(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      await api(`/api/shots/${shotId}/generate`, { method: 'POST' })
      setConfirming(false)
      onGenerated()
    } catch (e) {
      // 超预算是 402、池里没匹配是 503——原样显示，两者处置不同
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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

  /**
   * **锚点开关：勾掉的那一项从这一镜起不再拼进 prompt。**
   *
   * 用勾选不用手打，理由是硬的：`hiddenAnchors` 的匹配是**逐字精确**的，
   * 而拦逐字写错的那条 lint（E6）只跑在 LLM 输出上——`PATCH /api/shots/:id`
   * 绕过它。手打一个错字不会报错，只会静默无效：prompt 里那件道具照旧在，
   * 而人以为自己已经把它去掉了。那正是这个功能要修的 bug 换了个入口。
   *
   * 只列本镜出场角色的锚点：别人的锚点本来就不会进这一镜的 prompt。
   */
  const allAnchors = p.inputs.characters.flatMap((c) => c.anchorTokens)
  const hidden = new Set(p.inputs.hiddenTraits.map((h) => h.toLowerCase()))

  async function toggleAnchor(token: string): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      /*
       * 只写**本镜**的事件，不写累计集。投影由服务端按 index 聚合前序算，
       * 所以取消勾选时要判断这一项是不是本镜报的——是前面某一镜报的话，
       * 得去那一镜取消，这里给一句话说清楚，而不是静默无效。
       */
      const own = new Set(ownEvents.map((x) => x.toLowerCase()))
      if (hidden.has(token.toLowerCase()) && !own.has(token.toLowerCase())) {
        setErr(`「${token}」是前面某一镜标掉的。要让它回来，去那一镜取消勾选。`)
        return
      }
      const next = own.has(token.toLowerCase())
        ? ownEvents.filter((x) => x.toLowerCase() !== token.toLowerCase())
        : [...ownEvents, token]
      await api(`/api/shots/${shotId}`, { method: 'PATCH', body: JSON.stringify({ hiddenAnchors: next }) })
      onChanged()
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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
      {/*
        生成入口。**价钱写在按钮上**——「花钱之前先看清将要发出去的是什么」，
        价钱是那句话的另一半。此前面板上只有集级的「生成整集」，单镜没有入口，
        而空态文案却写着「对本镜点生成」。
      */}
      {/*
        **选 provider。**
        路由的第一优先级是 `shots.provider_hint`；没有它就取池里第一个，而
        `buildProviderPool` 把 mock 排在最前。也就是说配好真 key 之后点生成
        **仍然只走 mock**——产出假视频、一分钱不花，而没有任何地方说明为什么。

        默认留在 mock 是有意的：**默认不花钱**。要花钱得显式选。
      */}
      {canGenerate && p.pool.length > 1 && (
        <label className="flex flex-col gap-1 text-[11px]">
          <span style={{ color: 'var(--text-secondary)' }}>用哪个 provider</span>
          <select
            value={p.providerHint ?? ''}
            onChange={(e) => void setHint(e.target.value || null)}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[12px] outline-none"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}
          >
            <option value="">自动（会选中 {p.pool[0]?.id}）</option>
            {p.pool.map((x) => (
              <option key={x.id} value={x.id} disabled={x.costMicroUsd === null}>
                {x.id}
                {x.costMicroUsd === null ? '（能力不匹配）' : ` · ${usd(x.costMicroUsd)}`}
              </option>
            ))}
          </select>
          {p.providerHint === null && (
            <span style={{ color: 'var(--text-muted)' }}>
              不选就走自动路由，而自动会选中 mock——假视频，不花钱
            </span>
          )}
        </label>
      )}

      {canGenerate && p.estimate && (
        <div className="flex flex-col gap-2">
          {confirming ? (
            <>
              <div className="text-[12px]" style={{ color: 'var(--status-review)' }}>
                这一镜会<strong>真的花掉 {usd(p.estimate.costMicroUsd)}</strong>
                <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
                  （{p.estimate.modelId}）
                </span>
              </div>
              {/* 按钮各自成块、不换行——挤在文字同一行时中文会被折成两行 */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void generate()}
                  disabled={busy}
                  className="whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
                  style={{ background: 'var(--accent)', color: '#fff' }}
                >
                  {busy ? '提交中…' : '确定，生成'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  className="whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] disabled:opacity-40"
                  style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
                >
                  取消
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirming(true)}
                title={`${p.estimate.providerId} · 按取整后的时长计价`}
                className="whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] font-medium"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                生成本镜 · {usd(p.estimate.costMicroUsd)}
              </button>
              <span className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {p.estimate.modelId}
              </span>
            </div>
          )}
        </div>
      )}

      {canGenerate && !p.estimate && (
        <div className="text-[11px]" style={{ color: 'var(--status-review)' }}>
          ⚠ 池里没有能力匹配的 provider——检查密钥页的 OPENROUTER_VIDEO_MODELS
        </div>
      )}

      {missing.length > 0 && (
        <div className="text-[11px]" style={{ color: 'var(--status-review)' }}>
          ⚠ 没有取到{missing.join(' / ')}
          {!p.inputs.style && '（风格要先在项目上挂 styleProfileId 才会进 prompt）'}
        </div>
      )}

      {allAnchors.length > 0 && (
        <div
          className="rounded-md p-2"
          style={{ background: 'var(--bg-inset)', border: '1px solid var(--border)' }}
        >
          <div className="mb-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            锚点 · 取消勾选 = 从这一镜起不再出现
          </div>
          <div className="flex flex-col gap-1">
            {allAnchors.map((a) => {
              const off = hidden.has(a.toLowerCase())
              return (
                <label key={a} className="flex cursor-pointer items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={!off}
                    disabled={busy}
                    onChange={() => void toggleAnchor(a)}
                  />
                  <span
                    style={{
                      color: off ? 'var(--text-muted)' : 'var(--text-primary)',
                      textDecoration: off ? 'line-through' : 'none',
                    }}
                  >
                    {a}
                  </span>
                  {off && !ownEvents.some((x) => x.toLowerCase() === a.toLowerCase()) && (
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      前面某一镜标的
                    </span>
                  )}
                </label>
              )
            })}
          </div>
          <div className="mt-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            剧情把东西拿走之后，锚点会从一致性手段变成自相矛盾——同一句 prompt
            里既有它在身上、又有把它拿走的动作。
          </div>
        </div>
      )}
    </div>
  )
}
