import { asc, eq } from 'drizzle-orm'
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

export function httpMediaWorker(baseUrl: string): MediaWorkerClient {
  return {
    async render(req) {
      const res = await fetch(`${baseUrl}/v1/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      })
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
  if (existing) return existing.id

  const [tl] = await db
    .insert(s.timelines)
    .values({ episodeId, version: 1, status: 'draft' })
    .returning({ id: s.timelines.id })
  const timelineId = tl!.id

  const shots = await db
    .select({ id: s.shots.id, index: s.shots.index, takeId: s.shots.selectedTakeId })
    .from(s.shots)
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .where(eq(s.scenes.episodeId, episodeId))
    .orderBy(asc(s.shots.index))

  const clips = shots
    .filter((x) => x.takeId !== null)
    .map((x, i) => ({ timelineId, index: i + 1, takeId: x.takeId!, transition: 'cut' as const }))

  if (clips.length > 0) await db.insert(s.timelineClips).values(clips)
  return timelineId
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
