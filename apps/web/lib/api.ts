export const API = process.env['NEXT_PUBLIC_API_BASE'] ?? 'http://localhost:4000'

/** 统一错误体（06-api-spec.md §8）。requestId 贯穿日志，报错时给出即可定位全链路 */
export interface ApiErrorBody {
  error: { code: string; message: string; details: Record<string, unknown>; requestId: string }
}

export class ApiCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
    readonly requestId: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // content-type 只在真有 body 时设。无 body 的 POST 带着这个头会被 Fastify
  // 以「Body cannot be empty when content-type is set to 'application/json'」拒绝
  const hasBody = init?.body !== undefined && init.body !== null
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null
    const e = body?.error
    throw new ApiCallError(
      e?.code ?? 'UNKNOWN',
      e?.message ?? `${res.status} ${res.statusText}`,
      e?.details ?? {},
      e?.requestId ?? '',
    )
  }
  return res.json() as Promise<T>
}

export const assetUrl = (assetId: string): string => `${API}/api/assets/${assetId}/content`

/** 微美元 → 人读的金额。成本以整数微美元存储，浮点算钱迟早出问题 */
export function usd(microUsd: number | null | undefined): string {
  if (microUsd === null || microUsd === undefined) return '—'
  return `$${(microUsd / 1_000_000).toFixed(2)}`
}

export interface Shot {
  id: string
  index: number
  shotType: string
  action: string
  dialogue: string | null
  durationSec: string
  status: string
  selectedTakeId: string | null
  attemptCount: number
  sceneId: string
}

export interface EpisodeTree {
  episode: { id: string; index: number; title: string | null; targetDurationSec: number }
  scenes: { id: string; index: number; summary: string | null; timeOfDay: string | null }[]
  shots: { shot: Shot; takeCount: number; costMicroUsd: number }[]
}

export interface DryRunPlan {
  planned: number
  blocked: number
  skipped: number
  estimatedCostMicroUsd: number
  budget: {
    dailyLimitMicroUsd: number
    spentTodayMicroUsd: number
    wouldExceed: boolean
    onExceed: string
  }
}

export interface TakeRow {
  take: { id: string; status: string; createdAt: string }
  asset: { id: string; durationSec: string | null }
  job: { providerId: string; seed: number | null; costMicroUsd: number | null; attempt: number }
}
