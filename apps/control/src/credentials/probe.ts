/**
 * 密钥探测。**不花钱**——`GET /api/v1/key` 只回这把 key 自己的额度与用量。
 *
 * 存在的理由是「配了 key 却不知道对不对」这件事：现在的流程是编辑 `.env`、
 * 重启两个进程、然后去点一次真实生成，用**一次计费调用**来确认 key 有效。
 * 那既慢又贵，而且失败时分不清是 key 错了还是别的环节坏了。
 *
 * 官方响应形状（2026-08-20 实测确认）：
 *
 * ```json
 * { "data": { "label": "...", "limit": null, "limit_remaining": null,
 *             "usage": 12.34, "usage_daily": 0.5, "is_free_tier": false } }
 * ```
 *
 * 无效 key 回 **401** + `{"error":{"message":"User not found.","code":401}}`。
 */

const BASE_URL = 'https://openrouter.ai/api/v1'
const TIMEOUT_MS = 15_000

export interface ProbeOk {
  readonly ok: true
  readonly label: string | null
  /** 信用额度上限，null = 不限 */
  readonly limitUsd: number | null
  readonly remainingUsd: number | null
  readonly usedUsd: number
  readonly usedTodayUsd: number
  readonly isFreeTier: boolean
}

export interface ProbeBad {
  readonly ok: false
  /** `invalid` = 这把 key 不对；`unreachable` = 网络/服务问题，与 key 无关 */
  readonly kind: 'invalid' | 'unreachable'
  readonly detail: string
}

export type ProbeResult = ProbeOk | ProbeBad

interface KeyResponse {
  data?: {
    label?: string
    limit?: number | null
    limit_remaining?: number | null
    usage?: number
    usage_daily?: number
    is_free_tier?: boolean
  }
  error?: { message?: string }
}

/**
 * `invalid` 与 `unreachable` 必须分开，因为处置动作完全相反：前者是「换一把
 * key」，后者是「等一会儿再试」。混成一种的话，OpenRouter 抽风时会让人把一把
 * 好 key 删掉重配。这也是调用方决定「拒绝保存」还是「存下并标注未验证」的依据。
 */
export async function probeOpenRouter(apiKey: string, baseUrl = BASE_URL): Promise<ProbeResult> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/key`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, kind: 'unreachable', detail: `连不上 OpenRouter：${describe(e)}` }
  }

  const text = await res.text()
  if (res.status === 401 || res.status === 403) {
    const msg = safeJson(text)?.error?.message ?? text.slice(0, 200)
    return { ok: false, kind: 'invalid', detail: `OpenRouter 拒绝了这把 key：${msg}` }
  }
  if (!res.ok)
    return { ok: false, kind: 'unreachable', detail: `OpenRouter HTTP ${res.status}：${text.slice(0, 200)}` }

  const d = safeJson(text)?.data
  if (!d) return { ok: false, kind: 'unreachable', detail: `响应里没有 data：${text.slice(0, 200)}` }

  return {
    ok: true,
    label: d.label ?? null,
    limitUsd: d.limit ?? null,
    remainingUsd: d.limit_remaining ?? null,
    usedUsd: d.usage ?? 0,
    usedTodayUsd: d.usage_daily ?? 0,
    isFreeTier: d.is_free_tier ?? false,
  }
}

function safeJson(text: string): KeyResponse | null {
  try {
    return JSON.parse(text) as KeyResponse
  } catch {
    return null
  }
}

/**
 * happy-eyeballs 会把真正的原因（ECONNREFUSED / ENOTFOUND）藏进 `AggregateError`
 * 的 `errors[]`，只看外层 message 得到的是没用的 "fetch failed"。
 * 这个仓库为 media worker 已经踩过一次同样的坑。
 */
function describe(e: unknown): string {
  // `fetch failed` 是外层 TypeError，真原因在 cause 上——照抄 render.ts 的 describeCause
  const cause = (e as { cause?: unknown }).cause ?? e
  if (cause instanceof AggregateError && cause.errors.length > 0)
    return [...new Set(cause.errors.map((x) => (x as { code?: string }).code ?? String(x)))].join(' / ')
  const code = (cause as { code?: string }).code
  return code ?? String(cause)
}
