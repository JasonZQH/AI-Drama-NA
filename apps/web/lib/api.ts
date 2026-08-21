/*
 * **必须用点号取，不能用 `process.env['NEXT_PUBLIC_...']`。**
 *
 * Next 对 `NEXT_PUBLIC_*` 是**编译期字面量替换**，而它只匹配点号形式。写成
 * 方括号时不会被替换，浏览器里 `process` 根本不存在（实测 `typeof process`
 * 是 undefined），于是整个表达式恒为 `undefined`。
 *
 * 这两个变量都踩过，而症状完全不同：
 * - `API` 恒取兜底值。本机开发恰好就是 4000，所以看起来一直是对的——
 *   换端口或部署到别处就会静默连错主机。
 * - `x-api-key` 恒为空串（bundle 里编译成字面量 `"x-api-key":""`），于是
 *   面板的**每一个写操作**都被控制面判 401。开箱即坏，且只在点按钮时才发现。
 */
export const API = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000'

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
  /*
   * 变更请求要带 x-api-key（控制面 server.ts 的 guardWrites）。
   *
   * 注意上面那条注释描述的「无 body 的 POST 不设 content-type」——那恰好就是
   * CORS 简单请求的形态，也正是任意网页能替你花钱的那条路径。加上这个自定义头
   * 之后浏览器会强制先发预检，恶意来源的预检过不了，真实请求根本不会发出。
   * GET 不带，因为 EventSource 设不了头，护 GET 会打断 SSE。
   */
  const isWrite = (init?.method ?? 'GET') !== 'GET'
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      // 点号形式，理由见文件顶部 API 的注释——方括号会编译成空串，所有写操作 401
      ...(isWrite ? { 'x-api-key': process.env.NEXT_PUBLIC_CONTROL_API_KEY ?? '' } : {}),
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
  cameraMove: string | null
  emotion: string | null
  action: string
  dialogue: string | null
  durationSec: string
  status: string
  selectedTakeId: string | null
  attemptCount: number
  sceneId: string
}

export interface EpisodeTree {
  episode: {
    id: string
    index: number
    title: string | null
    /** 分镜的输入。列一直有，写入口到 P1 才补上 */
    scriptMd: string | null
    targetDurationSec: number
    /** 端点一直在返回整行，页面要靠它渲染项目侧边栏 */
    projectId: string
  }
  /** 端点返回的是整行；`locationId` 此前漏在类型里，而它是地点进 prompt 的唯一通路 */
  scenes: {
    id: string
    index: number
    summary: string | null
    timeOfDay: string | null
    locationId: string | null
  }[]
  /** 最近一次成功渲染的成片。null = 还没渲染过 */
  master: { assetId: string; finishedAt: string } | null
  shots: {
    shot: Shot
    takeCount: number
    costMicroUsd: number
    mockCostMicroUsd: number
    /** 封面用：选中的 take 优先，否则最后一次生成的产物。null = 还没出过片 */
    posterAssetId: string | null
  }[]
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

// ── 管理面板的聚合类型（对应 apps/control/src/routes/stats.ts）──

export interface Overview {
  totals: {
    projects: number
    shots: number
    costMicroUsd: number
    /** 其中由 mock provider 产生的部分。等于 costMicroUsd 时全是演示数据 */
    mockCostMicroUsd: number
    usdPerAcceptedMicro: number | null
  }
  attention: { failedShots: number; pendingReview: number }
  queue: { running: number; queued: number }
  budget: { spentTodayMicroUsd: number; dailyLimitMicroUsd: number }
  /** M4 接投放回传时填充，届时前端卡片位置与类型都不用改 */
  distribution: null | { spendMicroUsd: number; impressions: number; installs: number }
  revenue: null | { grossMicroUsd: number; roi: number }
}

export type RangeKey = '30d' | '3m' | '6m' | '1y' | 'all'

export const RANGE_LABEL: Record<RangeKey, string> = {
  '30d': '30 天',
  '3m': '3 个月',
  '6m': '6 个月',
  '1y': '1 年',
  all: '全部',
}

export interface TimeseriesPoint {
  at: string
  costMicroUsd: number
  mockCostMicroUsd: number
  attempts: number
  accepted: number
  firstPass: number
}

export interface Timeseries {
  range: RangeKey
  granularity: 'day' | 'week' | 'month'
  points: TimeseriesPoint[]
}

export interface ProjectSummary {
  id: string
  title: string
  synopsis: string | null
  status: string
  episodes: number
  shots: number
  locked: number
  costMicroUsd: number
  mockCostMicroUsd: number
}

export interface EpisodeSummary {
  /** 有没有渲染出成片。分集列表据此给「看成片」入口 */
  hasMaster: boolean
  id: string
  index: number
  title: string | null
  logline: string | null
  status: string
  targetDurationSec: number
  shots: number
  locked: number
  review: number
  costMicroUsd: number
  mockCostMicroUsd: number
}

export interface AttentionItem {
  shotId: string
  shotIndex: number
  status: string
  action: string
  episodeId: string
  episodeIndex: number
  episodeTitle: string | null
  projectId: string
  projectTitle: string
}

export interface ProjectAssets {
  characters: {
    id: string
    name: string
    description: string
    voiceId: string | null
    version: number
    lockedAt: string | null
    faceSet: unknown
    bodyRef: unknown
    wardrobe: unknown[]
    anchorTokens: string[]
    prohibitedChanges: string[]
  }[]
  locations: { id: string; name: string; description: string; interior: boolean; lockedAt: string | null }[]
  styles: { id: string; name: string; description: string; negativePrompt: string | null }[]
}

export interface JobRow {
  id: string
  attempt: number
  providerId: string
  modelId: string
  status: string
  promptText: string
  negativeText: string | null
  seed: number | null
  costMicroUsd: number | null
  /** true = 这笔是按价目表估的，不是 provider 回报的真实计费（超时、提交结果未知等） */
  costEstimated: boolean | null
  latencyMs: number | null
  accepted: boolean | null
  failureCode: string | null
  failureDetail: string | null
  createdAt: string
}
