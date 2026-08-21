'use client'

import { PageHeader } from '@/components/Shell'
import { api, ApiCallError } from '@/lib/api'
import { useCallback, useEffect, useState } from 'react'

/**
 * provider 密钥。
 *
 * 在这之前配 key 的流程是：编辑 `.env` → 重启**两个**进程 → 点一次**真实计费**
 * 的生成来确认它对不对。这一页把前两步搬进面板，并用一次**免费**的探测
 * （OpenRouter 的 `GET /api/v1/key`）替掉第三步。
 *
 * ## 页面上永远不出现明文
 *
 * `guardWrites` 只守非 GET，所以 `GET /api/keys` 是不设防的——任何能碰到
 * :4000 的东西都读得到它。服务端只回 `last4`，这一页也只显示 `last4`。
 * 输入框里敲进去的那一次是明文唯一存在的时刻，提交完就丢。
 *
 * ## 存完两条链路都立刻生效（PR-E）
 *
 * 分镜（LLM）那条**每次请求现取密钥**；视频那条靠 `LivePool`——控制面存完先重建
 * 自己的池子，再经 Redis 广播给 worker，两个进程都不用重启。
 *
 * 但**重建可能失败**（Redis 挂了、库读不到），那时密钥已经存下了、池子却是旧的。
 * 服务端如实回报 `reload.ok`，这一页据此提示要不要手工重启——不假装总是成功。
 */

interface Credential {
  provider: string
  envVar: string
  source: 'db' | 'env' | 'none'
  label: string | null
  last4: string | null
  verifiedAt: string | null
  updatedAt: string | null
}

interface Probe {
  ok: boolean
  kind?: 'invalid' | 'unreachable'
  detail?: string
  label?: string | null
  limitUsd?: number | null
  remainingUsd?: number | null
  usedUsd?: number
  usedTodayUsd?: number
  isFreeTier?: boolean
  /** 账户余额。与「key 有效」是两件事——没充钱的 key 在 /key 上完全健康 */
  account?: { totalCredits: number; totalUsage: number; remaining: number } | null
}

interface Reload {
  ok: boolean
  detail?: string
}

interface KeysResponse {
  credentials: Credential[]
  runtime: { providers: string[]; credentialSecretConfigured: boolean; videoModels: string[] }
}

const usd = (v: number | null | undefined): string =>
  v === null || v === undefined ? '不限' : `$${v.toFixed(2)}`

export function KeysView(): React.ReactElement {
  const [data, setData] = useState<KeysResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<Probe | null>(null)
  const [reload, setReload] = useState<Reload | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      setData(await api<KeysResponse>('/api/keys'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    document.title = '密钥 · ai-drama-studio'
  }, [])

  const or = data?.credentials.find((c) => c.provider === 'openrouter') ?? null
  const loadedInRuntime = data?.runtime.providers.some((p) => p.startsWith('openrouter:')) ?? false
  /**
   * 有密钥、但跑着的进程里没有这一家。
   *
   * PR-E 之后正常情况下不该出现——存完会自动重建。还出现就是**重建失败**
   * （Redis 挂了、或这个进程根本没接热更新），那时确实要手工重启。
   */
  /** 一个模型都没列 = 就算有 key，视频池也必然是空的（poolFromEnv 直接返回 []） */
  const noModels = (data?.runtime.videoModels.length ?? 0) === 0
  const hasKey = or !== null && or.source !== 'none'
  /**
   * 有密钥、池里却没有这一家，而且**已经列了模型**——那才是「重建没成功」。
   * 没列模型时是另一回事，处置完全不同（去 .env 加一行，不是重启）。
   */
  const stale = hasKey && !loadedInRuntime && !noModels

  async function save(force = false): Promise<void> {
    setBusy(true)
    setErr(null)
    setProbe(null)
    try {
      const r = await api<{ probe: Probe; reload: Reload }>('/api/keys', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'openrouter',
          key: draft.trim(),
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(force ? { force: true } : {}),
        }),
      })
      setProbe(r.probe)
      setReload(r.reload)
      setDraft('') // 明文在内存里多留一秒都没有必要
      await load()
    } catch (e) {
      if (e instanceof ApiCallError) {
        setErr(e.message)
        // 「连不上」与「key 不对」处置相反：前者可以强存，后者不行
        setProbe({ ok: false, kind: e.code === 'DEPENDENCY_UNAVAILABLE' ? 'unreachable' : 'invalid' })
      } else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function recheck(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      setProbe((await api<{ probe: Probe }>('/api/keys/openrouter/probe', { method: 'POST' })).probe)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      await api('/api/keys/openrouter', { method: 'DELETE' })
      setProbe(null)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="密钥" subtitle="provider 凭据。明文只在你敲进去的那一刻存在，页面与接口都只回末四位">
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md px-2 py-1 text-[12px]"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          刷新
        </button>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {err && (
          <Note tone="error">
            ✕ {err}
            {/* 「连不上」是可以强存的，「key 不对」不行——按钮只在前者出现 */}
            {probe?.kind === 'unreachable' && draft.trim() !== '' && (
              <button
                type="button"
                onClick={() => void save(true)}
                disabled={busy}
                className="ml-2 rounded-sm px-2 py-0.5 text-[11px]"
                style={{ border: '1px solid var(--border-strong)' }}
              >
                仍然保存
              </button>
            )}
          </Note>
        )}

        {data && !data.runtime.credentialSecretConfigured && (
          <Note tone="warn">
            ⚠ 没有配 <code className="font-mono">CREDENTIAL_SECRET</code>，密钥存不进来。在仓库根的{' '}
            <code className="font-mono">.env</code> 里加一行随机串（
            <code className="font-mono">openssl rand -hex 32</code>）再重启控制面。
            <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
              不配就不存——明文落库等于每一份数据库备份都是一次泄露。
            </span>
          </Note>
        )}

        {reload && !reload.ok && (
          <Note tone="warn">
            ⚠ 密钥已存好，但<strong>池子没能自动重建</strong>
            {reload.detail ? `：${reload.detail}` : ''}。
            <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
              分镜生成不受影响（它每次请求现取密钥）；视频生成要手工重启控制面与 worker。
            </span>
          </Note>
        )}

        {/*
          这一条曾经被 stale 那条误诊过：只看到「有密钥但池里没有 openrouter」，
          于是让人去重启——而没列模型的话重启一百次也不会有。
        */}
        {hasKey && noModels && (
          <Note tone="warn">
            ⚠ 有密钥，但<strong>没有列出任何视频模型</strong>，所以视频 provider 池是空的。
            <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
              在仓库根的 <code className="font-mono">.env</code> 里加一行，例如{' '}
              <code className="font-mono">OPENROUTER_VIDEO_MODELS=bytedance/seedance-2.0</code>
              ，再重启控制面与 worker。<strong>分镜生成不受影响</strong>——它不走 provider 池。
            </span>
          </Note>
        )}

        {stale && (
          <Note tone="warn">
            ⚠ 有密钥，但<strong>跑着的进程里没有这一家</strong>。
            <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
              正常情况下存完会自动重建；还是这样说明重建没成功，或这个进程没接热更新——重启控制面与 worker。
            </span>
          </Note>
        )}

        <Card title="OpenRouter">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
            <Row k="当前来源">
              {or?.source === 'db' ? (
                <span>面板（数据库）</span>
              ) : or?.source === 'env' ? (
                <span>
                  <code className="font-mono">.env</code> 的 {or.envVar}
                </span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>还没有配</span>
              )}
            </Row>
            {or?.last4 && (
              <Row k="密钥">
                <code className="font-mono">sk-or-v1-••••{or.last4}</code>
                {or.label && <span className="ml-2 text-[11px]">{or.label}</span>}
              </Row>
            )}
            {or?.verifiedAt && <Row k="上次验证">{new Date(or.verifiedAt).toLocaleString('zh-CN')}</Row>}
            <Row k="运行中的 provider">
              {data ? (
                data.runtime.providers.length > 0 ? (
                  <code className="font-mono text-[11px]">{data.runtime.providers.join('、')}</code>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>无</span>
                )
              ) : (
                '…'
              )}
            </Row>
          </dl>

          {probe && (
            <div className="mt-3 rounded-md p-2 text-[12px]" style={{ background: 'var(--bg-base)' }}>
              {probe.ok ? (
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <span style={{ color: 'var(--status-ok, var(--accent))' }}>✓ 这把 key 有效</span>
                    {probe.account ? (
                      <span>
                        账户余额 <strong>{usd(probe.account.remaining)}</strong>
                        <span style={{ color: 'var(--text-muted)' }}>
                          （充值 {usd(probe.account.totalCredits)} · 已用 {usd(probe.account.totalUsage)}）
                        </span>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>账户余额取不到</span>
                    )}
                    <span style={{ color: 'var(--text-muted)' }}>
                      key 限额 {usd(probe.limitUsd)} · 今日 {usd(probe.usedTodayUsd)}
                    </span>
                  </div>
                  {/*
                    余额为 0 时「key 有效」是真的但没用——第一次真实生成会 402。
                    `GET /api/v1/key` 看不到余额（limit: null 只表示这把 key 没有
                    单独限额），所以不专门查一次 /credits 的话，面板会显示
                    「✓ 有效 · 剩余 不限」然后让人一头撞上 402。
                  */}
                  {probe.account && probe.account.remaining <= 0 && (
                    <span style={{ color: 'var(--status-error)' }}>
                      ✕ 账户余额为 0——key 是好的，但任何一次真实生成都会被拒（402）。先去 OpenRouter 充值。
                    </span>
                  )}
                  {probe.account && probe.account.remaining > 0 && probe.account.remaining < 1 && (
                    <span style={{ color: 'var(--status-review)' }}>
                      ⚠ 余额不足 $1。一集视频的账单是 $2–11，一次分镜约 $0.003。
                    </span>
                  )}
                </div>
              ) : (
                <span style={{ color: 'var(--danger-text)' }}>
                  ✕ {probe.kind === 'invalid' ? 'key 无效' : '连不上 OpenRouter'}
                  {probe.detail ? ` — ${probe.detail}` : ''}
                </span>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {or?.source === 'db' ? '换一把新的' : '粘贴密钥'}
              </span>
              <input
                type="password"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="sk-or-v1-..."
                autoComplete="off"
                spellCheck={false}
                className="rounded-md px-2 py-1.5 font-mono text-[13px] outline-none"
                style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                备注（可选）
              </span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="个人账号"
                className="rounded-md px-2 py-1.5 text-[13px] outline-none"
                style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                }}
              />
            </label>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || draft.trim().length < 8}
                title={draft.trim().length < 8 ? '先粘贴一把密钥' : '会先验一次再存，无效的直接拒收'}
                className="rounded-md px-3 py-1 text-[12px] font-medium disabled:opacity-40"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                {busy ? '验证中…' : '验证并保存'}
              </button>
              {or?.source === 'db' && (
                <>
                  <button
                    type="button"
                    onClick={() => void recheck()}
                    disabled={busy}
                    title="重新查一次额度。不花钱"
                    className="rounded-md px-3 py-1 text-[12px] disabled:opacity-40"
                    style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
                  >
                    查额度
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove()}
                    disabled={busy}
                    title={`删掉之后回落到 .env 的 ${or.envVar}`}
                    className="rounded-md px-3 py-1 text-[12px] disabled:opacity-40"
                    style={{ border: '1px solid var(--border-strong)', color: 'var(--danger-text)' }}
                  >
                    删除
                  </button>
                </>
              )}
            </div>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              保存前会用 OpenRouter 的 <code className="font-mono">GET /api/v1/key</code> 验一次—— 它只回这把
              key 自己的额度与用量，<strong>不产生任何费用</strong>。 无效的 key 直接拒收，
              而不是存下来等下一次花钱时才发现。 存好之后<strong>两条链路都立刻生效</strong>，控制面与 worker
              都不用重启。
            </p>
          </div>
        </Card>
      </div>
    </>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section
      className="rounded-md p-3"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <h2 className="mb-2 text-[13px] font-medium">{title}</h2>
      {children}
    </section>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }): React.ReactElement {
  return (
    <>
      <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
      <dd>{children}</dd>
    </>
  )
}

function Note({ tone, children }: { tone: 'error' | 'warn'; children: React.ReactNode }): React.ReactElement {
  const color = tone === 'error' ? 'var(--status-error)' : 'var(--status-review)'
  return (
    <div
      className="rounded-md px-3 py-2 text-[12px]"
      style={{ background: 'var(--bg-surface)', border: `1px solid ${color}` }}
    >
      {children}
    </div>
  )
}
