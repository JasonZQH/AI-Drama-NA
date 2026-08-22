import { asc, eq, inArray, sql } from 'drizzle-orm'
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
    if ((c?.n ?? 0) > 0) {
      await reconcileClips(db, existing.id, episodeId)
      return existing.id
    }
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
/**
 * **时间线是「已锁定镜头 + 它们当前选中的 take」的投影，只有顺序与 trim 归人。**
 *
 * `ensureTimeline` 原来是「非空就原样复用」，理由是别覆盖人工调过的顺序与 trim。
 * 那条理由现在还成立，但它顺带保住了**已经不对的 take 引用**：
 *
 * 真机实测撞到的——第 8、9 镜的地点配错了（人在门外、背景是屋内），改完地点重新
 * 生成、重新选片之后，时间线里那两条 clip **仍然指着已归档的旧 take**。再点渲染，
 * 出来的还是旧画面，**而且不报错**。人会以为是模型没听话，实际是渲染读了一份
 * 陈旧的投影。
 *
 * 这与 `hidden_anchors` 存事件不存投影是同一课：**能算出来的东西不要存两份。**
 * 这里存的那一份（顺序、trim）是人给的、算不出来，所以留着；take 引用是算得出来
 * 的，所以每次渲染前对齐。
 *
 * 三件事，都只动 take 引用，不动顺序与 trim：
 * 1. 指向的 take 与镜头当前选中的不一致 → 改指过去
 * 2. 镜头已经不再锁定（selectedTakeId 为空）→ 删掉那条 clip
 * 3. 新锁定的镜头还不在时间线里 → 按 index 追加
 */
async function reconcileClips(db: Db, timelineId: string, episodeId: string): Promise<void> {
  const shots = await db
    .select({ id: s.shots.id, index: s.shots.index, takeId: s.shots.selectedTakeId })
    .from(s.shots)
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .where(eq(s.scenes.episodeId, episodeId))
    .orderBy(asc(s.shots.index))

  const clips = await db
    .select({ id: s.timelineClips.id, index: s.timelineClips.index, takeId: s.timelineClips.takeId })
    .from(s.timelineClips)
    .where(eq(s.timelineClips.timelineId, timelineId))

  // clip → 它属于哪一镜（经 takes.shot_id，因为 clip 只认 take）
  const clipTakeIds = clips.map((c) => c.takeId).filter((x): x is string => x !== null)
  const takeOwner = new Map(
    clipTakeIds.length === 0
      ? []
      : (
          await db
            .select({ takeId: s.takes.id, shotId: s.takes.shotId })
            .from(s.takes)
            .where(inArray(s.takes.id, clipTakeIds))
        ).map((t) => [t.takeId, t.shotId] as const),
  )

  const wanted = new Map(shots.filter((x) => x.takeId !== null).map((x) => [x.id, x.takeId!]))
  const covered = new Set<string>()

  for (const c of clips) {
    const shotId = c.takeId === null ? undefined : takeOwner.get(c.takeId)
    const want = shotId === undefined ? undefined : wanted.get(shotId)
    if (want === undefined) {
      // 这一镜不再锁定：留着就是把一段作废的素材拼进成片
      await db.delete(s.timelineClips).where(eq(s.timelineClips.id, c.id))
      continue
    }
    if (shotId !== undefined) covered.add(shotId)
    if (want !== c.takeId)
      await db.update(s.timelineClips).set({ takeId: want }).where(eq(s.timelineClips.id, c.id))
  }

  // 新锁定的镜头补进去。index 接在现有最大值之后——**不重排**，顺序归人
  let next = Math.max(0, ...clips.map((c) => c.index))
  const missing = shots.filter((x) => x.takeId !== null && !covered.has(x.id))
  if (missing.length > 0)
    await db.insert(s.timelineClips).values(
      missing.map((x) => ({
        timelineId,
        index: ++next,
        takeId: x.takeId!,
        transition: 'cut' as const,
      })),
    )
}

async function fillClips(db: Db, timelineId: string, episodeId: string): Promise<void> {
  const shots = await db
    .select({ id: s.shots.id, index: s.shots.index, takeId: s.shots.selectedTakeId })
    .from(s.shots)
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .where(eq(s.scenes.episodeId, episodeId))
    .orderBy(asc(s.shots.index))

  /*
   * **不按 `shots.duration_sec` 自动裁剪。**
   *
   * 一度这么做过，理由是「成片 44.5 秒而目标 30 秒」。真机看帧之后撤掉了：
   * 模型是**按拿到的时长编排动作的**，尾巴不是冗余是落点。实测两例——
   *
   * - 计划 2 秒那一镜：t=2.0 她还举着钥匙在头顶，**钥匙落到桌上是 t=4.0 的事**
   * - 计划 3 秒那一镜：dolly 跑满 4 秒才到位，裁到 3 秒等于推到一半停住
   *
   * 两次都把那一镜唯一的剧情动作切掉了。**长度对不上的根因在上游**：
   * seedance 最短 4 秒，而分镜可以规划 2 秒——规划了一段买不到的片子。
   * 那要在分镜层挡（按 provider 档位约束每镜时长），不是在这里拿剪刀补。
   *
   * `trim_end_sec` 这一列留给**人工**在时间线上调——那时人是看着画面剪的。
   */
  const clips = shots
    .filter((x) => x.takeId !== null)
    .map((x, i) => ({ timelineId, index: i + 1, takeId: x.takeId!, transition: 'cut' as const }))

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
