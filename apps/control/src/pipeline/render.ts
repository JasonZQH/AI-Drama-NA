import { asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { s3Key } from '../storage/s3.js'

/**
 * 渲染路径（10-media-storage.md §2、03-pipeline.md §S7）。
 *
 * 控制面只负责：从 locked 的镜头生成 timeline，把 clip 清单交给 media worker，
 * 收回一个 storage key 建 asset。**字节流不经过这里**。
 */

export interface MediaWorkerClient {
  render(req: {
    request_id: string
    clips: { storage_key: string; trim_start_sec: number; trim_end_sec?: number; normalized_key: string }[]
    output_key: string
    quality: string
  }): Promise<{
    storage_key: string
    bytes: number
    sha256: string
    duration_sec: number
    width_px: number
    height_px: number
    fps: number
    normalized_reused: number
    normalized_built: number
  }>
}

/**
 * media worker 没起时抛这个，而不是 undici 的裸 `TypeError: fetch failed`。
 *
 * 区分「连不上」与「它回了个错」不是分类癖：前者是运维问题（服务没起、地址配错），
 * 后者是数据问题（clip 缺失、ffmpeg 失败）。路由层据此给 503 还是 409，
 * 而看到 503 的人知道该去起服务，看到 409 的人知道该去看这一集。
 */
export class MediaWorkerUnavailable extends Error {
  override readonly name = 'MediaWorkerUnavailable'
}

/** 一集 12 镜实测 4 秒级。60 秒是「它挂住了」而不是「它在忙」 */
const RENDER_TIMEOUT_MS = 60_000

/**
 * 把 fetch 的失败挖到能行动的那一层。
 *
 * Node 对 localhost 走 happy-eyeballs：同时试 `::1` 和 `127.0.0.1`，两边都失败时
 * `cause` 是一个 `AggregateError`——`String()` 它只得到「AggregateError」六个字母，
 * 真正的 `ECONNREFUSED` 在 `.errors[]` 里。少挖这一层，报错就等于没报。
 */
function describeCause(e: unknown): string {
  const cause = (e as { cause?: unknown }).cause ?? e
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    return [...new Set(cause.errors.map((x) => (x as { code?: string }).code ?? String(x)))].join(' / ')
  }
  const code = (cause as { code?: string }).code
  return code ?? String(cause)
}

export function httpMediaWorker(baseUrl: string): MediaWorkerClient {
  return {
    async render(req) {
      let res: Response
      try {
        res = await fetch(`${baseUrl}/v1/render`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
          // 渲染是同步等的（见 routes/api.ts 的注释）。没有超时的话 worker 挂住
          // 就等于这个 HTTP 请求永久挂住，而调用方连「它死了」都不知道
          signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
        })
      } catch (e) {
        /*
         * undici 对连不上一律抛 `TypeError: fetch failed`，真正的原因埋在 cause 里
         * （ECONNREFUSED / ENOTFOUND / …）。原样往上抛的话，运维在面板上看到的就是
         * 「fetch failed」四个字——既不知道是谁没起，也不知道该去哪台机器看。
         */
        throw new MediaWorkerUnavailable(
          `media worker 不可达（${baseUrl}）：${describeCause(e)}。` +
            `本机开发用 docker compose 起 media-worker，或检查 MEDIA_WORKER_URL。`,
        )
      }
      if (!res.ok) {
        throw new Error(`media worker ${res.status}: ${(await res.text()).slice(0, 500)}`)
      }
      return (await res.json()) as Awaited<ReturnType<MediaWorkerClient['render']>>
    },
  }
}

/**
 * 从已锁定的镜头生成 timeline 草稿。
 *
 * 不存在时按 locked shots 自动生成（06-api-spec.md §5）——用户不必先手动
 * 建时间线才能渲染。已存在则复用，避免覆盖人工调整过的顺序与 trim。
 */
export async function ensureTimeline(db: Db, episodeId: string): Promise<string> {
  const [existing] = await db
    .select()
    .from(s.timelines)
    .where(eq(s.timelines.episodeId, episodeId))
    .orderBy(asc(s.timelines.version))

  /*
   * **空的 timeline 要回填，不能直接复用。**
   *
   * 原来是「存在就返回」，于是在一个镜头都没锁定时调用过一次（比如误点渲染），
   * 就会留下一个 0 clip 的 timeline——此后每次渲染都复用它，`clips.length === 0`
   * 一路抛「没有已选定的镜头」，**这一集从此再也渲染不了**。以前要 curl 才够得着，
   * 面板加了渲染按钮之后一次误点就中招。
   *
   * 只回填空的：有 clip 的说明可能被人工调过顺序与 trim，那是要保住的。
   */
  if (existing) {
    const [c] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.timelineClips)
      .where(eq(s.timelineClips.timelineId, existing.id))
    if ((c?.n ?? 0) > 0) return existing.id
    await fillClips(db, existing.id, episodeId)
    return existing.id
  }

  const [tl] = await db
    .insert(s.timelines)
    .values({ episodeId, version: 1, status: 'draft' })
    .returning({ id: s.timelines.id })
  const timelineId = tl!.id
  await fillClips(db, timelineId, episodeId)
  return timelineId
}

/** 按 locked 镜头的顺序铺 clip。空 timeline 与新建 timeline 共用 */
async function fillClips(db: Db, timelineId: string, episodeId: string): Promise<void> {
  const shots = await db
    .select({
      id: s.shots.id,
      index: s.shots.index,
      takeId: s.shots.selectedTakeId,
      durationSec: s.shots.durationSec,
    })
    .from(s.shots)
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .where(eq(s.scenes.episodeId, episodeId))
    .orderBy(asc(s.shots.index))

  /*
   * **按镜头的意图时长裁剪，不是拿到多长播多长。**
   *
   * provider 的时长是**档位**不是数值：seedance 最低 4 秒，所以一个 2 秒的镜头
   * 拿回来的也是 4.04 秒的片子（`snapDuration` 的已知代价，钱照 4 秒付）。
   * 之前这里不写 `trimEndSec`，`outpoint` 就是空，媒体 worker 整段拼进去——
   * 真机实测：**一集 11 镜、目标 30 秒、成片 44.5 秒，偏差 +48%。**
   *
   * 后果不只是长了。整个时长规划层因此是装饰性的：分镜的 E3 判据守着 ±15%、
   * 面板显示「30.0s / 目标 30s」、确认弹窗按秒估价——而成片跟这些数一个都对不上。
   * 每个 2 秒的镜头实播 4 秒，节奏也被拖平。
   *
   * 裁掉的是**已经付过钱的尾巴**——那笔钱在 `snapDuration` 那一层就花掉了，
   * 这里留着它只会让成片不是你计划的那一集。人工调过 trim 的不受影响：
   * `ensureTimeline` 只回填空的 timeline。
   *
   * `outpoint` 是**源文件里的绝对时间**（concat demuxer 语义），自动回填时
   * `trimStartSec` 取默认值 0，所以就是 durationSec 本身。
   */
  const clips = shots
    .filter((x) => x.takeId !== null)
    .map((x, i) => ({
      timelineId,
      index: i + 1,
      takeId: x.takeId!,
      transition: 'cut' as const,
      trimEndSec: x.durationSec,
    }))

  if (clips.length > 0) await db.insert(s.timelineClips).values(clips)
}

export interface RenderOutcome {
  readonly renderJobId: string
  readonly assetId: string
  readonly storageKey: string
  readonly durationSec: number
  readonly normalizedReused: number
}

/**
 * 执行一次渲染。规范化产物的 key 按 take 派生并复用——这是「改一镜快速
 * 重渲染」成立的前提（10 §2.1）。
 */
export async function renderEpisode(
  deps: { db: Db; media: MediaWorkerClient },
  episodeId: string,
  opts: { quality?: 'preview' | 'final' } = {},
): Promise<RenderOutcome> {
  const { db } = deps

  const [ep] = await db
    .select({ projectId: s.episodes.projectId })
    .from(s.episodes)
    .where(eq(s.episodes.id, episodeId))
  if (!ep) throw new Error(`episode ${episodeId} 不存在`)

  const timelineId = await ensureTimeline(db, episodeId)

  const clips = await db
    .select({
      takeId: s.takes.id,
      storageKey: s.assets.storageKey,
      trimStart: s.timelineClips.trimStartSec,
      trimEnd: s.timelineClips.trimEndSec,
    })
    .from(s.timelineClips)
    .innerJoin(s.takes, eq(s.timelineClips.takeId, s.takes.id))
    .innerJoin(s.assets, eq(s.takes.assetId, s.assets.id))
    .where(eq(s.timelineClips.timelineId, timelineId))
    .orderBy(asc(s.timelineClips.index))

  if (clips.length === 0) {
    throw new Error('没有已选定的镜头，无可渲染的内容')
  }

  const [job] = await db
    .insert(s.renderJobs)
    .values({ timelineId, status: 'running', startedAt: new Date() })
    .returning({ id: s.renderJobs.id })
  const renderJobId = job!.id

  // 版本号取当前 render 次数 + 1，母版只增不改（约束 C5）
  const version = await nextVersion(db, timelineId)
  const outputKey = s3Key.master(ep.projectId, episodeId, version)

  try {
    const r = await deps.media.render({
      request_id: renderJobId,
      clips: clips.map((c) => ({
        storage_key: c.storageKey,
        trim_start_sec: Number(c.trimStart),
        ...(c.trimEnd === null ? {} : { trim_end_sec: Number(c.trimEnd) }),
        // 规范化缓存按 take 派生：同一条 take 在任何一次渲染里都复用同一份
        normalized_key: s3Key.normalized(ep.projectId, episodeId, c.takeId),
      })),
      output_key: outputKey,
      quality: opts.quality ?? 'preview',
    })

    const [asset] = await db
      .insert(s.assets)
      .values({
        projectId: ep.projectId,
        kind: 'master',
        storageKey: r.storage_key,
        mime: 'video/mp4',
        bytes: r.bytes,
        sha256: r.sha256,
        widthPx: r.width_px,
        heightPx: r.height_px,
        durationSec: String(r.duration_sec),
        fps: String(r.fps),
        producedBy: 'render',
      })
      .returning({ id: s.assets.id })

    await db
      .update(s.renderJobs)
      .set({ status: 'succeeded', outputAssetId: asset!.id, finishedAt: new Date() })
      .where(eq(s.renderJobs.id, renderJobId))

    await db.update(s.timelines).set({ status: 'rendered' }).where(eq(s.timelines.id, timelineId))
    await db.update(s.episodes).set({ status: 'assembled' }).where(eq(s.episodes.id, episodeId))

    return {
      renderJobId,
      assetId: asset!.id,
      storageKey: r.storage_key,
      durationSec: r.duration_sec,
      normalizedReused: r.normalized_reused,
    }
  } catch (e) {
    // ffmpeg 日志留档：渲染失败时能展开看，而不是只显示「渲染失败」
    await db
      .update(s.renderJobs)
      .set({
        status: 'failed',
        ffmpegLog: e instanceof Error ? e.message.slice(0, 8000) : String(e),
        finishedAt: new Date(),
      })
      .where(eq(s.renderJobs.id, renderJobId))
    throw e
  }
}

async function nextVersion(db: Db, timelineId: string): Promise<number> {
  const rows = await db
    .select({ id: s.renderJobs.id })
    .from(s.renderJobs)
    .where(eq(s.renderJobs.timelineId, timelineId))
  return rows.length // 已有 N 次渲染 → 这次是 v(N)，从 v0 起
}
