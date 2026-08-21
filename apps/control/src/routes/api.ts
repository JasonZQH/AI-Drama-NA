import { ShotStatus, TERMINAL_JOB_STATUSES, TimeOfDay } from '@ai-drama/contracts'
import { and, desc, eq, notInArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { budgetFromEnv, planBatch } from '../pipeline/batch.js'
import { MediaWorkerUnavailable, renderEpisode, type MediaWorkerClient } from '../pipeline/render.js'
import {
  MODEL as SHOTLIST_MODEL,
  ShotlistRejected,
  callShotlist,
  systemPrompt,
  type ShotlistInput,
  type ShotlistOutcome,
} from '../pipeline/callShotlist.js'
import { toIntent } from '@ai-drama/contracts'
import {
  DURATION_TOLERANCE,
  MAX_CAST_PER_SHOT,
  SAME_SHOT_TYPE_RUN,
  SHOT_COUNT,
  targetOutOfReach,
} from '../pipeline/shotlist.js'
import { resolvePrompt } from '../pipeline/resolvePrompt.js'
import { CAMERA_MOVE_PROSE, SHOT_TYPE_PROSE, TIME_OF_DAY_PROSE } from '../pipeline/prompt.js'
import { applyShotTransition } from '../pipeline/applyTransition.js'
import type { ShotEvent } from '../pipeline/shotMachine.js'
import type { Queues } from '../queue/queues.js'
import type { Storage } from '../storage/s3.js'
import { ApiError } from './errors.js'
import { CredentialSecretMissing } from '../credentials/crypto.js'
import { probeOpenRouter, type ProbeResult } from '../credentials/probe.js'
import {
  ENV_VAR,
  resolveKey,
  deleteCredential,
  listCredentials,
  upsertCredential,
  type ProviderId,
} from '../credentials/store.js'
import type { VideoProvider } from '@ai-drama/contracts'

export interface ApiDeps {
  readonly db: Db
  readonly media: MediaWorkerClient
  readonly queues: Queues
  readonly storage: Storage
  readonly providers: readonly VideoProvider[]
  readonly maxAttempts: number
  /**
   * 分镜生成。**默认走 env 里的 key**，注入是给集成测试用的 seam——真去打
   * OpenRouter 的话每跑一次 CI 就是一次真实计费。
   */
  readonly shotlist?: ShotlistFn
  /**
   * 密钥探测。同样是 seam：不注入的话 `POST /api/keys` 会真的打
   * openrouter.ai，而「无效 key 直接拒收」正是这组端点最该被守住的行为，
   * 不能因为出网被拦就测不到。
   */
  readonly probeKey?: (key: string) => Promise<ProbeResult>
  /**
   * 凭据变更之后重建 provider 池，并广播给别的进程（PR-E）。
   *
   * 不传的话密钥只对**每次请求现取**的那条链路（分镜）生效，视频那条仍要重启
   * ——那正是 PR-D 的状态。`server.ts` 会把它接上。
   */
  readonly onCredentialsChanged?: () => Promise<void>
}

export type ShotlistFn = (input: ShotlistInput) => Promise<ShotlistOutcome>

/**
 * 没配 key 时给的是 **503 + 可行动的报错**，不是 500「fetch failed」。
 *
 * 同一类坑这个仓库踩过一次：media worker 没起时回的是 `409 CONFLICT: fetch
 * failed`——状态码和文案两条信息都是错的，看到的人不知道该去做什么。
 *
 * **密钥每次请求现取**（库优先、`.env` 回落），不是开机读一次。所以在面板的
 * 「密钥」页存完一把 key，分镜生成**立刻**就能用，不需要重启。
 *
 * 视频那条链路不一样：`buildProviderPool()` 在 `server.ts` 与 `worker.ts` 里
 * 各建一次、都在开机时，所以视频 provider 仍然要重启才认新 key。这个差异在
 * `GET /api/keys` 的 `runtime.providers` 里能看出来，PR-E 再统一。
 */
function shotlistFromDb(db: Db): ShotlistFn {
  return async (input) => {
    const apiKey = await resolveKeyOr503(db, 'openrouter')
    return callShotlist(input, { apiKey })
  }
}

const Uuid = z.object({ id: z.string().uuid() })

/**
 * 非法迁移回 400、超预算回 402；真正的执行在 pipeline/applyTransition，
 * 路由与队列共用同一个执行点。
 *
 * 两种拒绝必须分开：状态机拒绝是「你点错了」，预算拒绝是「你没点错，是钱不够」。
 * 混成一种的话 UI 说不清该让人做什么——前者要改状态，后者要加额度。
 */
async function applyTransition(deps: ApiDeps, shotId: string, event: ShotEvent): Promise<{ next: string }> {
  const r = await applyShotTransition(
    { db: deps.db, queues: deps.queues, providers: deps.providers, maxAttempts: deps.maxAttempts },
    shotId,
    event,
  )
  if (r === null) throw new ApiError('NOT_FOUND', `shot ${shotId} 不存在`)
  if (!r.ok) {
    if (r.code === 'BUDGET_EXCEEDED') throw new ApiError('BUDGET_EXCEEDED', r.reason, { ...r.budget })
    /*
     * 池里没有能力匹配的 provider 不是「用户点错了」，是「这套部署当前做不到」。
     * 此前它落成 400 INVALID_STATE_TRANSITION，而 errors.ts 里的
     * NO_PROVIDER_AVAILABLE(503) 从建好起零使用。
     *
     * 这条在 M1 期间是真会被打到的：mature 镜头只能路由到
     * serverSideContentFilter===false 的 provider，而池里（mock 之外）只有
     * OpenRouter，它有服务端过滤。见 issue #15。
     */
    if (r.code === 'NO_PROVIDER') throw new ApiError('NO_PROVIDER_AVAILABLE', r.reason, { from: r.from })
    throw new ApiError('INVALID_STATE_TRANSITION', r.reason, { from: r.from, event: event.type })
  }
  return { next: r.next }
}

/** 空串落 NULL：库里 '' 和 NULL 混着存，后面每个读取方都要各写一遍兜底 */
const blankToNull = (v: string | null | undefined): string | null | undefined =>
  v === undefined || v === null ? (v as null | undefined) : v.trim() === '' ? null : v.trim()

/**
 * 下一个编号 = `max(index) + 1`。
 *
 * 不让人手填：`episodes_project_index_uq` / `scenes_episode_index_uq` 都是唯一
 * 约束，手填就是把撞号变成用户的问题。两个并发创建会算出同一个数——那由唯一
 * 约束兜底，比让人自己数靠谱。
 */
async function nextEpisodeIndex(db: Db, projectId: string): Promise<number> {
  const [r] = await db
    .select({ max: sql<number>`coalesce(max(${s.episodes.index}), 0)::int` })
    .from(s.episodes)
    .where(eq(s.episodes.projectId, projectId))
  return (r?.max ?? 0) + 1
}

async function nextSceneIndex(db: Db, episodeId: string): Promise<number> {
  const [r] = await db
    .select({ max: sql<number>`coalesce(max(${s.scenes.index}), 0)::int` })
    .from(s.scenes)
    .where(eq(s.scenes.episodeId, episodeId))
  return (r?.max ?? 0) + 1
}

/**
 * 花过钱的东西不给删。
 *
 * `projects → episodes → scenes → shots` 全链路 cascade，一条 DELETE 能把已经
 * 生成、已经计费的 takes 与 assets 一起带走，而系统的规矩是**永不自动销毁字节**
 * （03 §7）。所以闸门是「这棵子树下有没有过 generation_jobs」，错误里带上金额。
 *
 * 只挡「花过钱」不挡「有镜头」：分镜生歪了想重来是正常操作，那时还没花钱。
 */
async function refuseIfSpent(db: Db, scope: { projectId?: string; episodeId?: string }): Promise<void> {
  const where = scope.projectId
    ? eq(s.episodes.projectId, scope.projectId)
    : eq(s.episodes.id, scope.episodeId!)
  const [r] = await db
    .select({
      jobs: sql<number>`count(*)::int`,
      spent: sql<number>`coalesce(sum(${s.generationJobs.costMicroUsd}), 0)::bigint`,
    })
    .from(s.generationJobs)
    .innerJoin(s.shots, eq(s.generationJobs.shotId, s.shots.id))
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
    .where(where)
  if ((r?.jobs ?? 0) > 0)
    throw new ApiError(
      'CONFLICT',
      `这里已经产生过 ${r?.jobs} 次生成（累计 $${((Number(r?.spent) || 0) / 1_000_000).toFixed(2)}）。删除会连同已计费的 take 与产物一起销毁，本系统不自动销毁字节。要真的删，先手工清掉这些 generation_jobs。`,
      { jobs: r?.jobs, spentMicroUsd: Number(r?.spent) || 0 },
    )
}

const sceneBody = z.object({
  summary: z.string().nullish(),
  timeOfDay: TimeOfDay.nullish(),
  locationId: z.string().uuid().nullish(),
})

const scenePatch = (b: z.infer<typeof sceneBody>): Record<string, unknown> => ({
  ...(b.summary === undefined ? {} : { summary: blankToNull(b.summary) }),
  ...(b.timeOfDay === undefined ? {} : { timeOfDay: b.timeOfDay ?? null }),
  ...(b.locationId === undefined ? {} : { locationId: b.locationId ?? null }),
})

/**
 * 取密钥明文，没有就给可行动的 503。
 *
 * 报错文案与分镜端点那条保持同一个形状：说清缺什么、去哪儿加、加完做什么。
 * 「没配 key」不是入参错误，是这套部署当前做不到——所以是 503 不是 4xx。
 */
async function resolveKeyOr503(db: Db, provider: ProviderId): Promise<string> {
  const key = await resolveKey(db, provider)
  if (!key)
    throw new ApiError(
      'DEPENDENCY_UNAVAILABLE',
      `没有 ${provider} 的密钥。在面板的「密钥」页存一把，或在仓库根的 .env 里加上 ${ENV_VAR[provider]}=... 再重启控制面。`,
    )
  return key
}

/**
 * 重建本进程的池子并广播。**吞掉异常**：密钥已经落库了，重载失败不该让调用方
 * 以为存失败——但要如实回报，页面据此决定要不要提示重启。
 */
async function reloadProviders(
  deps: ApiDeps,
  req: { log: { error: (o: unknown, m: string) => void } },
): Promise<{ ok: boolean; detail?: string }> {
  if (!deps.onCredentialsChanged) return { ok: false, detail: '本进程没有接热更新，需要重启才生效' }
  try {
    await deps.onCredentialsChanged()
    return { ok: true }
  } catch (e) {
    req.log.error({ err: e }, 'provider 池重建失败')
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { db } = deps

  app.get('/api/projects', async () => ({
    projects: await db.select().from(s.projects).orderBy(desc(s.projects.createdAt)),
  }))

  app.get('/api/projects/:id', async (req) => {
    const { id } = Uuid.parse(req.params)
    const [p] = await db.select().from(s.projects).where(eq(s.projects.id, id))
    if (!p) throw new ApiError('NOT_FOUND', `project ${id} 不存在`)
    const episodes = await db
      .select()
      .from(s.episodes)
      .where(eq(s.episodes.projectId, id))
      .orderBy(s.episodes.index)
    return { project: p, episodes }
  })

  /** 分镜页的数据源：一集的场次 + 镜头 + 每镜的 take 数（08 §2） */
  /**
   * ── 作者侧写入路径（P0）────────────────────────────────────────────────
   *
   * 在这之前 `projects` / `scenes` / `characters` / `locations` /
   * `style_profiles` **五张表的唯一写入方都是 `db/seed.ts`**——系统能跑一部剧，
   * 但造不出一部剧。规律是「机器产出的表都有写入方，人要创作的表都没有」。
   *
   * 这一组补上「开一部新剧」需要的三张：project → episode → scene。
   *
   * ## 编号一律自动分配，不让人手填
   *
   * `episodes_project_index_uq` / `scenes_episode_index_uq` 都是唯一约束，手填
   * 就是把撞号变成用户的问题。取 `max(index) + 1`，在事务里算——两个并发创建
   * 会算出同一个数，靠唯一约束兜底比靠运气好。
   *
   * **不做重排。** 场次顺序即叙事顺序，改序要动一整段编号，而拖拽 UI 与批量
   * 重编号是另一件事。现在删了重建即可。
   */
  app.post('/api/projects', async (req, reply) => {
    /*
     * **只收 title 与 synopsis。**
     *
     * P0-A 这里还收过 `aspectRatio` 与 `language`——两个都能写进库、都出现在
     * API 出参里，而**没有任何东西读它们**：画幅在 `applyTransition.ts:133`、
     * `batch.ts:151`、`orchestrator.ts:217` 三处各自硬编码 `'9:16'`；语言的
     * 消费者是 M3 的 TTS，还不存在。
     *
     * 收一个存了不生效的参数，比不收更坏：它看起来是个开关。列保留（有默认值，
     * 删它要一次迁移换不来任何东西），等真的要支持横屏或多语言时，那时接的是
     * 「读它的那条路径」，不是「写它的这个入口」。
     */
    const body = z
      .object({
        title: z.string().trim().min(1, '项目要有名字'),
        synopsis: z.string().trim().optional(),
      })
      .parse(req.body ?? {})

    const [row] = await db
      .insert(s.projects)
      .values({
        title: body.title,
        ...(body.synopsis ? { synopsis: body.synopsis } : {}),
      })
      .returning()
    return reply.status(201).send({ project: row })
  })

  /**
   * `styleProfileId` 在这里可写：风格要进 prompt，靠的是
   * `projects.style_profile_id` 这一跳（`applyTransition.ts` 的 leftJoin）。
   * 不回填的话风格建了也不会出现在任何一条 prompt 里——seed 就是用第二条
   * UPDATE 补的这一步。
   */
  app.patch('/api/projects/:id', async (req) => {
    const { id } = Uuid.parse(req.params)
    const body = z
      .object({
        title: z.string().trim().min(1).optional(),
        synopsis: z.string().nullish(),
        styleProfileId: z.string().uuid().nullish(),
      })
      .parse(req.body ?? {})

    const patch = {
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.synopsis === undefined ? {} : { synopsis: blankToNull(body.synopsis) }),
      ...(body.styleProfileId === undefined ? {} : { styleProfileId: body.styleProfileId ?? null }),
    }
    if (Object.keys(patch).length === 0) {
      const [row] = await db.select().from(s.projects).where(eq(s.projects.id, id))
      if (!row) throw new ApiError('NOT_FOUND', `project ${id} 不存在`)
      return { project: row }
    }
    const [row] = await db.update(s.projects).set(patch).where(eq(s.projects.id, id)).returning()
    if (!row) throw new ApiError('NOT_FOUND', `project ${id} 不存在`)
    return { project: row }
  })

  app.post('/api/projects/:id/episodes', async (req, reply) => {
    const { id } = Uuid.parse(req.params)
    const body = z
      .object({
        title: z.string().trim().optional(),
        logline: z.string().trim().optional(),
        hook: z.string().trim().optional(),
        cliffhanger: z.string().trim().optional(),
        scriptMd: z.string().optional(),
        targetDurationSec: z.number().int().min(10).max(600).optional(),
      })
      .parse(req.body ?? {})

    const [proj] = await db.select({ id: s.projects.id }).from(s.projects).where(eq(s.projects.id, id))
    if (!proj) throw new ApiError('NOT_FOUND', `project ${id} 不存在`)

    const [row] = await db
      .insert(s.episodes)
      .values({
        projectId: id,
        index: await nextEpisodeIndex(db, id),
        ...(body.title ? { title: body.title } : {}),
        ...(body.logline ? { logline: body.logline } : {}),
        ...(body.hook ? { hook: body.hook } : {}),
        ...(body.cliffhanger ? { cliffhanger: body.cliffhanger } : {}),
        ...(body.scriptMd ? { scriptMd: body.scriptMd } : {}),
        ...(body.targetDurationSec ? { targetDurationSec: body.targetDurationSec } : {}),
      })
      .returning()
    return reply.status(201).send({ episode: row })
  })

  /**
   * 删除。**花过钱的东西不给删。**
   *
   * `projects → episodes → scenes → shots` 全链路 cascade，一条 DELETE 能把
   * 已经生成、已经计费的 takes 和 assets 一起带走。而系统的规矩是永不自动销毁
   * 字节（03 §7）——所以闸门放在这里：**只要这棵子树下有过 generation_jobs，
   * 就拒绝**，错误里带上花了多少钱。
   *
   * 只挡「花过钱」不挡「有镜头」：分镜生歪了想重来是正常操作，那时还没花钱。
   */
  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = Uuid.parse(req.params)
    await refuseIfSpent(db, { projectId: id })
    const [row] = await db.delete(s.projects).where(eq(s.projects.id, id)).returning({ id: s.projects.id })
    if (!row) throw new ApiError('NOT_FOUND', `project ${id} 不存在`)
    return reply.status(204).send()
  })

  app.delete('/api/episodes/:id', async (req, reply) => {
    const { id } = Uuid.parse(req.params)
    await refuseIfSpent(db, { episodeId: id })
    const [row] = await db.delete(s.episodes).where(eq(s.episodes.id, id)).returning({ id: s.episodes.id })
    if (!row) throw new ApiError('NOT_FOUND', `episode ${id} 不存在`)
    return reply.status(204).send()
  })

  /*
   * ── provider 凭据（PR-D）──────────────────────────────────────────────
   *
   * 在这之前配 key 的流程是：编辑 `.env` → 重启**两个**进程（`server.ts` 与
   * `worker.ts` 各建一次 provider 池）→ 点一次**真实计费**的生成来确认它对不对。
   *
   * ## 三条安全约束，它们决定了这组端点长什么样
   *
   * 1. **`GET` 是不设防的**（`guardWrites` 只守非 GET），所以 `GET /api/keys`
   *    只回掩码信息，明文一个字符都不出库。
   * 2. **明文不落库**：AES-256-GCM，密钥来自 `CREDENTIAL_SECRET`。没配就**拒绝
   *    存**，不静默降级成明文。
   * 3. **存之前先验**：无效的 key 直接拒收，而不是存下来等下一次花钱时才发现。
   *
   * ## 这一版不是热更新，页面上要说清楚
   *
   * provider 池是开机建的。所以 `GET /api/keys` 同时回 `runtime.providers`
   * ——跑着的进程实际加载了什么。库里存了 key 而 runtime 里没有 openrouter，
   * 就是「还没重启」，这个差异直接摆出来，不让人猜。
   */
  const PROVIDERS: readonly ProviderId[] = ['openrouter']
  const asProvider = (v: string): ProviderId => {
    if (!PROVIDERS.includes(v as ProviderId))
      throw new ApiError('VALIDATION_FAILED', `不认识的 provider「${v}」，目前只支持 ${PROVIDERS.join('、')}`)
    return v as ProviderId
  }

  app.get('/api/keys', async () => {
    const rows = await listCredentials(db)
    const byProvider = new Map(rows.map((r) => [r.provider, r]))
    return {
      credentials: PROVIDERS.map((p) => {
        const row = byProvider.get(p)
        return {
          provider: p,
          envVar: ENV_VAR[p],
          /** 'db' = 面板里存过；'env' = 只有 .env 里有；'none' = 两处都没有 */
          source: row ? 'db' : process.env[ENV_VAR[p]] ? 'env' : 'none',
          label: row?.label ?? null,
          last4: row?.last4 ?? null,
          verifiedAt: row?.verifiedAt ?? null,
          updatedAt: row?.updatedAt ?? null,
        }
      }),
      runtime: {
        /*
         * 跑着的进程实际加载了哪些 (provider, model)。与上面的 credentials
         * 对照就能看出「存了但还没重启」——这一版不是热更新，差异要能一眼看见。
         */
        providers: deps.providers.map((x) => x.id),
        credentialSecretConfigured: Boolean(process.env['CREDENTIAL_SECRET']?.trim()),
        /**
         * 有 key 也不一定进得了池：`OpenRouterProvider.poolFromEnv` 要求
         * `OPENROUTER_VIDEO_MODELS` 里**列出具体模型**，空的就直接返回 `[]`。
         *
         * 不把这一位报出去的话，面板只能看到「有密钥但池里没有 openrouter」，
         * 于是给出「重启控制面与 worker」——而重启一百次也不会有。这是 PR-E
         * 那条警告的真实误诊，实测撞到了。
         */
        videoModels: (process.env['OPENROUTER_VIDEO_MODELS'] ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      },
    }
  })

  /**
   * 存一把 key。**先验后存**：
   *
   * - key 不对（401/403）→ 422 拒收。存一把用不了的 key 只会把发现问题的时机
   *   推迟到下一次花钱。
   * - 连不上 OpenRouter → 503 而不是 422。这两种混成一种的话，OpenRouter 抽风
   *   时会让人把一把好 key 删掉重配。
   * - `force: true` 可以跳过「连不上」那道（离线先存着），但**跳不过「key 不对」**。
   */
  app.post('/api/keys', async (req, reply) => {
    const body = z
      .object({
        provider: z.string(),
        key: z.string().trim().min(8, 'key 太短，不像是一把真的密钥'),
        label: z.string().trim().optional(),
        force: z.boolean().default(false),
      })
      .parse(req.body ?? {})
    const provider = asProvider(body.provider)

    const probe = await (deps.probeKey ?? probeOpenRouter)(body.key)
    if (!probe.ok && probe.kind === 'invalid')
      throw new ApiError('VALIDATION_FAILED', probe.detail, { kind: 'invalid' })
    if (!probe.ok && !body.force)
      throw new ApiError(
        'DEPENDENCY_UNAVAILABLE',
        `${probe.detail}。确认这把 key 没问题的话，可以带 force 强制保存。`,
        {
          kind: probe.kind,
        },
      )

    try {
      const row = await upsertCredential(db, {
        provider,
        key: body.key,
        label: body.label ?? null,
        verified: probe.ok,
      })
      // 池子重建 + 广播。失败不该让「已经存好的密钥」看起来像没存上
      const reload = await reloadProviders(deps, req)
      return reply.status(201).send({ credential: row, probe, reload })
    } catch (e) {
      // 没配 CREDENTIAL_SECRET 是配置问题，不是入参问题——422 会让人去改 body
      if (e instanceof CredentialSecretMissing) throw new ApiError('DEPENDENCY_UNAVAILABLE', e.message)
      throw e
    }
  })

  /** 重新探测已存的那把。用来回答「我的额度还剩多少」 */
  app.post('/api/keys/:provider/probe', async (req) => {
    const provider = asProvider(z.object({ provider: z.string() }).parse(req.params).provider)
    const key = await resolveKeyOr503(db, provider)
    const probe = await (deps.probeKey ?? probeOpenRouter)(key)
    if (probe.ok)
      await db
        .update(s.providerCredentials)
        .set({ verifiedAt: new Date() })
        .where(eq(s.providerCredentials.provider, provider))
    return { probe }
  })

  /**
   * 删掉一把密钥会让池子里少掉这一家的全部 (provider, model) 条目，而**正在飞的
   * job 是按 `provider_id` 回查池子的**（`orchestrator.ts` 的 `providerOf`，
   * 找不到就抛「provider 不在池中」）。所以有在飞的任务时拒绝删。
   *
   * 换一把（POST）不受这条限制：provider id 只由 `(家, 模型)` 决定，与密钥无关，
   * 换 key 之后池子里还是那几个 id，飞行中的 job 照样查得到。
   */
  app.delete('/api/keys/:provider', async (req, reply) => {
    const provider = asProvider(z.object({ provider: z.string() }).parse(req.params).provider)

    const [busy] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.generationJobs)
      .where(
        and(
          sql`${s.generationJobs.providerId} like ${provider + ':%'}`,
          notInArray(s.generationJobs.status, [...TERMINAL_JOB_STATUSES]),
        ),
      )
    if ((busy?.n ?? 0) > 0)
      throw new ApiError(
        'CONFLICT',
        `还有 ${busy?.n} 个 ${provider} 的任务在飞。删掉密钥会让它们查不到 provider 而卡死——等它们跑完，或先取消掉再删。`,
        { inFlight: busy?.n },
      )

    if (!(await deleteCredential(db, provider)))
      throw new ApiError('NOT_FOUND', `没有存过 ${provider} 的凭据`)
    await reloadProviders(deps, req)
    return reply.status(204).send()
  })

  /**
   * ── 提示词检视（PR-K）──────────────────────────────────────────────────
   *
   * 「基础 prompt 在哪里配置」的答案目前是「在代码里」。这一组不改变那件事，
   * 但让它**看得见**——不用读 TypeScript 就知道系统到底发出去什么。
   *
   * 两个端点分别对应两条链路：
   * - `GET /api/prompts` —— 底座：分镜的 system prompt、视频 prompt 的三张散文
   *   映射表与装配规则、以及判据常量。全部标注「改它要动哪个文件」。
   * - `POST /api/ai/prompt-preview` —— 单镜实际会发出去的那一份。这是
   *   `06-api-spec.md:108` 设计好但一直没实现的那个「调试利器」：**花钱之前
   *   先看清将要发出去的 prompt 长什么样**。
   *
   * 预览与真实生成**走同一行代码**（`resolvePrompt`）。另写一份取数逻辑就是
   * PR-J 刚修掉的那类 bug 的翻版：两份会漂，而漂了之后预览显示的和真实发出去的
   * 不是一回事，那比没有预览更坏——人会照着一份假的去调措辞。
   */
  app.get('/api/prompts', async () => {
    /*
     * system prompt 是输入的函数（场次数、目标时长会插进去）。所以要么给一组
     * 有代表性的默认值，要么用真实的一集。这里给默认值并**如实标出来**，
     * 免得人以为看到的就是他那一集会发出去的东西。
     */
    const sample = { scenes: 3, targetDurationSec: 75 }
    return {
      shotlist: {
        model: SHOTLIST_MODEL,
        source: 'apps/control/src/pipeline/callShotlist.ts · systemPrompt()',
        renderedWith: sample,
        system: systemPrompt({
          scriptMd: '',
          synopsis: null,
          targetDurationSec: sample.targetDurationSec,
          scenes: Array.from({ length: sample.scenes }, () => ({ summary: null, timeOfDay: null })),
          characters: [],
        }),
        /** 硬规则里的数字全部取自这里，不再另写一遍（PR-J） */
        criteria: {
          source: 'apps/control/src/pipeline/shotlist.ts',
          shotCount: SHOT_COUNT,
          durationTolerancePct: DURATION_TOLERANCE * 100,
          maxCastPerShot: MAX_CAST_PER_SHOT,
          sameShotTypeRun: SAME_SHOT_TYPE_RUN,
        },
      },
      video: {
        source: 'apps/control/src/pipeline/prompt.ts · buildPrompt()',
        /** 景别/运镜/时段的缩写对模型不是词，要展开成散文 */
        prose: { shotType: SHOT_TYPE_PROSE, cameraMove: CAMERA_MOVE_PROSE, timeOfDay: TIME_OF_DAY_PROSE },
        assembly: [
          '第一句：景别, 运镜, 角色（同位语，不用冒号——冒号是 Veo 的台词语法）, 动作, 情绪',
          '第二句：indoors/outdoors, 地点描述 + 锚点, 时段（地点文本已含该词则跳过）',
          '第三句：风格描述',
          'dialogue 刻意不进 prompt——它驱动 TTS，带引号的台词会诱导模型把字 render 进画面',
        ],
        /** 负向词不在统一请求体里，各家参数名不同，见 openrouterModels 的快照 */
        negativeFrom: 'style_profiles.negative_prompt',
      },
    }
  })

  /**
   * 单镜预览。**不花钱、不入队、不写任何东西。**
   *
   * `overridden: true` 表示这一镜走了 `shots.prompt_override` 的人工旁路，
   * 拼装被完全跳过——那时 `inputs` 里的资产是查出来的，但没有一个进了 prompt。
   */
  app.post('/api/ai/prompt-preview', async (req) => {
    const { shotId } = z.object({ shotId: z.string().uuid() }).parse(req.body ?? {})
    const r = await resolvePrompt(db, shotId)
    if (!r) throw new ApiError('NOT_FOUND', `shot ${shotId} 不存在`)
    return r
  })

  app.get('/api/episodes/:id', async (req) => {
    const { id } = Uuid.parse(req.params)
    const [ep] = await db.select().from(s.episodes).where(eq(s.episodes.id, id))
    if (!ep) throw new ApiError('NOT_FOUND', `episode ${id} 不存在`)

    const scenes = await db.select().from(s.scenes).where(eq(s.scenes.episodeId, id)).orderBy(s.scenes.index)
    const shots = await db
      .select({
        shot: s.shots,
        takeCount: sql<number>`(select count(*) from ${s.takes} where ${s.takes.shotId} = ${s.shots.id} and ${s.takes.status} = 'candidate')::int`,
        costMicroUsd: sql<number>`(select coalesce(sum(${s.generationJobs.costMicroUsd}), 0) from ${s.generationJobs} where ${s.generationJobs.shotId} = ${s.shots.id})::bigint`,
        // mock 的钱不是真花的钱，界面要能把这两者分开标（见 routes/stats.ts）
        mockCostMicroUsd: sql<number>`(select coalesce(sum(${s.generationJobs.costMicroUsd}), 0) from ${s.generationJobs} where ${s.generationJobs.shotId} = ${s.shots.id} and ${s.generationJobs.providerId} = 'mock')::bigint`,
      })
      .from(s.shots)
      .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
      .where(eq(s.scenes.episodeId, id))
      .orderBy(s.shots.index)

    return { episode: ep, scenes, shots }
  })

  /**
   * 编辑一集的文本层（06-api-spec.md §3 已设计的形状）。
   *
   * **`script_md` 此前是一列孤儿**：从第一版迁移（`0000_nice_marrow.sql:47`）起就
   * 存在，零写入方、零读取方、seed 也留空。于是整条流水线的起点只有
   * `title / logline / hook / cliffhanger` 四个短句，加起来不到 200 字——
   * 在那上面做分镜等于让模型自己编情节，而人无处干预。
   *
   * **只更新显式给出的键。** 不传 = 不动，传 `''` = 清空（`.nullish()` 与
   * `undefined` 的区别在这里是有意义的：前端清空输入框要能真的清掉）。
   * 全空 body 是合法的 no-op，不该 400——PATCH 的语义就是「改我给的这些」。
   */
  app.patch('/api/episodes/:id', async (req) => {
    const { id } = Uuid.parse(req.params)
    const body = z
      .object({
        title: z.string().nullish(),
        logline: z.string().nullish(),
        hook: z.string().nullish(),
        cliffhanger: z.string().nullish(),
        scriptMd: z.string().nullish(),
        targetDurationSec: z.number().int().min(10).max(600).optional(),
      })
      .parse(req.body ?? {})

    // 空串落 NULL：库里 '' 和 NULL 混着存，后面每个读取方都要各写一遍兜底
    const blank = (v: string | null | undefined): string | null | undefined =>
      v === undefined || v === null ? (v as null | undefined) : v.trim() === '' ? null : v
    const patch = {
      ...(body.title === undefined ? {} : { title: blank(body.title) }),
      ...(body.logline === undefined ? {} : { logline: blank(body.logline) }),
      ...(body.hook === undefined ? {} : { hook: blank(body.hook) }),
      ...(body.cliffhanger === undefined ? {} : { cliffhanger: blank(body.cliffhanger) }),
      ...(body.scriptMd === undefined ? {} : { scriptMd: blank(body.scriptMd) }),
      ...(body.targetDurationSec === undefined ? {} : { targetDurationSec: body.targetDurationSec }),
    }

    if (Object.keys(patch).length === 0) {
      const [ep] = await db.select().from(s.episodes).where(eq(s.episodes.id, id))
      if (!ep) throw new ApiError('NOT_FOUND', `episode ${id} 不存在`)
      return { episode: ep }
    }

    const [ep] = await db.update(s.episodes).set(patch).where(eq(s.episodes.id, id)).returning()
    if (!ep) throw new ApiError('NOT_FOUND', `episode ${id} 不存在`)
    return { episode: ep }
  })

  /**
   * 剧本 → 分镜（`03-pipeline.md` S3 的落库端点）。
   *
   * 在此之前 `shots` 的唯一写入方是 `db/seed.ts` 的硬编码 12 镜夹具——整条
   * 流水线的起点是一份写死的数据。
   *
   * ## 三个前置条件都在调模型之前查
   *
   * 每一条都比「让模型试一次再失败」便宜，而且报错能说清该去做什么。已有
   * shots 那条尤其要紧：重新生成会让既有的 takes / generation_jobs 连带失效，
   * 而那些是**真花过钱**的产物。要重来就先显式删，不给一个手滑就清空的入口。
   *
   * ## 明确不做的两件事
   *
   * 不接 `generation_jobs`、不接预算闸门。`generation_jobs.shot_id` 是 NOT NULL
   * 且外键指向 shots，分镜阶段还没有 shot；而闸门守的是 $2+ 的视频钱，这里是
   * $0.003。
   *
   * ponytail: `usage.cost` 只随响应返回、不落账。要按文本模型出成本报表时再建
   * 一张表——现在建就是为一个不存在的报表付表结构的成本。
   */
  app.post('/api/episodes/:id/shotlist', async (req, reply) => {
    const { id } = Uuid.parse(req.params)

    const [ep] = await db.select().from(s.episodes).where(eq(s.episodes.id, id))
    if (!ep) throw new ApiError('NOT_FOUND', `episode ${id} 不存在`)

    const script = ep.scriptMd?.trim()
    if (!script)
      throw new ApiError(
        'VALIDATION_FAILED',
        '这一集还没有剧本。先在分集页的「剧本」里粘一段进去（PATCH /api/episodes/:id 的 scriptMd），再生成分镜。',
      )

    /*
     * 目标时长本身可不可能被满足——在花那两轮 LLM 之前问。不问的话报错是
     * 「总时长不对」，人读不出真正的原因是这一集的目标时长压根不可达。
     * `episodes.target_duration_sec` 没有 CHECK，PATCH 也放到 600。
     */
    const unreachable = targetOutOfReach(ep.targetDurationSec)
    if (unreachable) throw new ApiError('VALIDATION_FAILED', unreachable)

    const sceneRows = await db
      .select()
      .from(s.scenes)
      .where(eq(s.scenes.episodeId, id))
      .orderBy(s.scenes.index)
    if (sceneRows.length === 0)
      throw new ApiError('CONFLICT', '这一集没有场次。分镜是按场次切的，先建场次再生成分镜。')

    const [existing] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.shots)
      .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
      .where(eq(s.scenes.episodeId, id))
    if ((existing?.n ?? 0) > 0)
      throw new ApiError(
        'CONFLICT',
        `这一集已经有 ${existing?.n} 个镜头了。重新生成会让既有的 takes 和已计费的 generation_jobs 全部失效——要重来请先显式删掉这些镜头。`,
        { shots: existing?.n },
      )

    const [proj] = await db.select().from(s.projects).where(eq(s.projects.id, ep.projectId))
    const characters = await db
      .select({ id: s.characters.id, name: s.characters.name, description: s.characters.description })
      .from(s.characters)
      .where(eq(s.characters.projectId, ep.projectId))

    const run = deps.shotlist ?? shotlistFromDb(db)
    let out: ShotlistOutcome
    try {
      out = await run({
        scriptMd: script,
        synopsis: proj?.synopsis ?? null,
        targetDurationSec: ep.targetDurationSec,
        scenes: sceneRows.map((sc) => ({ summary: sc.summary, timeOfDay: sc.timeOfDay })),
        characters: characters.map((c) => ({ name: c.name, description: c.description })),
      })
    } catch (e) {
      // 模型不肯就范 ≠ 系统坏了。422 带上校验原文，人能直接看出是哪一条没过
      if (e instanceof ShotlistRejected)
        throw new ApiError('VALIDATION_FAILED', e.message, { errors: [...e.errors] })
      throw e
    }

    /** 名字写错时立刻炸，不要静默塞一个空 uuid 进库（照 `seed.ts` 的 castIds） */
    const byName = new Map(characters.map((c) => [c.name, c.id]))
    const castIds = (names: readonly string[]): string[] =>
      names.map((nm) => {
        const cid = byName.get(nm)
        if (!cid) throw new ApiError('VALIDATION_FAILED', `模型返回了不存在的角色名 ${nm}`)
        return cid
      })

    // index 跨场**全集连续**，照 seed.ts 的 ++n。scenes 已按 index 排好序
    let n = 0
    const rows = out.draft.scenes.flatMap((sc, si) =>
      sc.shots.map((sh) => {
        const i = toIntent(sh)
        return {
          sceneId: sceneRows[si]!.id,
          index: ++n,
          shotType: i.shotType,
          cameraMove: i.cameraMove,
          action: i.action,
          emotion: i.emotion ?? null,
          dialogue: i.dialogue ?? null,
          // 列是 numeric(4,1)。显式取整，别让 Postgres 悄悄替你截
          durationSec: i.durationSec.toFixed(1),
          characterIds: castIds(i.characterNames),
        }
      }),
    )

    // 一个事务：要么整集落库，要么一行都不落。半集分镜比没有分镜更难收拾
    await db.transaction(async (tx) => {
      await tx.insert(s.shots).values(rows)
    })

    return reply.status(201).send({
      shots: rows.length,
      scenes: out.draft.scenes.length,
      repaired: out.repaired,
      warnings: out.warnings,
      costUsd: out.costUsd,
    })
  })

  /**
   * 场次。**分镜的输入**——`POST /api/episodes/:id/shotlist` 第一件事就是查它，
   * 没有场次直接 409（分镜是按场次切的，模型不该自己发明结构）。
   *
   * 在这之前 `scenes` 表只有 `db/seed.ts` 在写，所以「新建一部剧然后生成分镜」
   * 这条路是断的。
   */
  app.post('/api/episodes/:id/scenes', async (req, reply) => {
    const { id } = Uuid.parse(req.params)
    const body = sceneBody.parse(req.body ?? {})

    const [ep] = await db.select({ id: s.episodes.id }).from(s.episodes).where(eq(s.episodes.id, id))
    if (!ep) throw new ApiError('NOT_FOUND', `episode ${id} 不存在`)

    const [row] = await db
      .insert(s.scenes)
      .values({
        episodeId: id,
        index: await nextSceneIndex(db, id),
        ...scenePatch(body),
      })
      .returning()
    return reply.status(201).send({ scene: row })
  })

  app.patch('/api/scenes/:id', async (req) => {
    const { id } = Uuid.parse(req.params)
    const patch = scenePatch(sceneBody.parse(req.body ?? {}))
    if (Object.keys(patch).length === 0) {
      const [row] = await db.select().from(s.scenes).where(eq(s.scenes.id, id))
      if (!row) throw new ApiError('NOT_FOUND', `scene ${id} 不存在`)
      return { scene: row }
    }
    const [row] = await db.update(s.scenes).set(patch).where(eq(s.scenes.id, id)).returning()
    if (!row) throw new ApiError('NOT_FOUND', `scene ${id} 不存在`)
    return { scene: row }
  })

  /**
   * 删场次会 cascade 掉它下面的镜头。有镜头就拒——分镜是整集一次生成的，
   * 删掉中间一场会让剩下的镜头编号出现空洞，而 `orderBy(shots.index)` 正是
   * 剪辑时间线的拼接顺序。要改结构就整集重来。
   */
  app.delete('/api/scenes/:id', async (req, reply) => {
    const { id } = Uuid.parse(req.params)
    const [n] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.shots)
      .where(eq(s.shots.sceneId, id))
    if ((n?.n ?? 0) > 0)
      throw new ApiError(
        'CONFLICT',
        `这一场下面有 ${n?.n} 个镜头，删掉会连它们一起删，并让全集镜号出现空洞。要改结构请先删掉这一集的全部镜头再重新分镜。`,
        { shots: n?.n },
      )
    const [row] = await db.delete(s.scenes).where(eq(s.scenes.id, id)).returning({ id: s.scenes.id })
    if (!row) throw new ApiError('NOT_FOUND', `scene ${id} 不存在`)
    return reply.status(204).send()
  })

  app.post('/api/shots/:id/generate', async (req, reply) => {
    const { id } = Uuid.parse(req.params)
    const r = await applyTransition(deps, id, { type: 'generate.requested' })
    return reply.status(202).send({ shotId: id, status: r.next })
  })

  /**
   * 把判死的镜头拉回 ready。
   *
   * `failed` 是终态，状态机只接受 `manual.reset` / `intent.edited` 两个事件把它
   * 唤醒（pipeline/shotMachine.ts），而在这条路由之前**没有任何接口发得出它们**——
   * 于是「失败」在产品上等于「只能开 psql 手改」。
   *
   * 这条路由是 `submit_unknown` 能存在的前提：提交结果未知时系统故意停下来
   * 不自动重投（绝不自动付第二次钱），代价是必须给人一个一键继续的出口。
   */
  app.post('/api/shots/:id/reset', async (req) => {
    const { id } = Uuid.parse(req.params)
    const r = await applyTransition(deps, id, { type: 'manual.reset' })
    return { shotId: id, status: r.next }
  })

  /**
   * 「生成整集」。**dryRun 是必须先用的**——它把「这批要花多少钱、有几个镜头
   * 会被依赖阻塞」先算出来，UI 的确认弹窗就靠它（06 §4）。
   */
  app.post('/api/episodes/:id/generate-batch', async (req, reply) => {
    const { id } = Uuid.parse(req.params)
    const body = z.object({ dryRun: z.boolean().default(false) }).parse(req.body ?? {})

    const provider = deps.providers[0]
    if (!provider) throw new ApiError('NO_PROVIDER_AVAILABLE', '池内没有可用的 provider')

    const plan = await planBatch(db, id, provider, budgetFromEnv())

    if (body.dryRun) {
      return {
        planned: plan.runnable.length,
        blocked: plan.blocked.length,
        skipped: plan.skipped.length,
        estimatedCostMicroUsd: plan.estimatedCostMicroUsd,
        budget: plan.budget,
      }
    }

    // 超限时 block 会让批量入队直接失败并在 UI 弹出，而不是安静地烧钱（05 §6）
    if (plan.budget.wouldExceed && plan.budget.onExceed === 'block') {
      throw new ApiError(
        'BUDGET_EXCEEDED',
        `预估 ${plan.estimatedCostMicroUsd} + 已花 ${plan.budget.spentTodayMicroUsd} 超过日限 ${plan.budget.dailyLimitMicroUsd}（微美元）`,
        { ...plan.budget, estimatedCostMicroUsd: plan.estimatedCostMicroUsd },
      )
    }

    const batchId = randomUUID()
    for (const shotId of plan.runnable) {
      await applyTransition(deps, shotId, { type: 'generate.requested' })
    }

    return reply.status(202).send({
      batchId,
      planned: plan.runnable.length,
      blocked: plan.blocked.length,
      estimatedCostMicroUsd: plan.estimatedCostMicroUsd,
    })
  })

  app.get('/api/shots/:id/takes', async (req) => {
    const { id } = Uuid.parse(req.params)
    const takes = await db
      .select({ take: s.takes, asset: s.assets, job: s.generationJobs })
      .from(s.takes)
      .innerJoin(s.assets, eq(s.takes.assetId, s.assets.id))
      .innerJoin(s.generationJobs, eq(s.takes.jobId, s.generationJobs.id))
      .where(eq(s.takes.shotId, id))
      .orderBy(desc(s.takes.createdAt))
    return { takes }
  })

  app.post('/api/takes/:id/select', async (req) => {
    const { id } = Uuid.parse(req.params)
    const [take] = await db.select().from(s.takes).where(eq(s.takes.id, id))
    if (!take) throw new ApiError('NOT_FOUND', `take ${id} 不存在`)
    const r = await applyTransition(deps, take.shotId, { type: 'take.selected', takeId: id })
    return { shotId: take.shotId, status: r.next, selectedTakeId: id }
  })

  app.post('/api/takes/:id/reject', async (req) => {
    const { id } = Uuid.parse(req.params)
    const [take] = await db.select().from(s.takes).where(eq(s.takes.id, id))
    if (!take) throw new ApiError('NOT_FOUND', `take ${id} 不存在`)
    await db.update(s.takes).set({ status: 'rejected' }).where(eq(s.takes.id, id))

    const [remaining] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.takes)
      .where(and(eq(s.takes.shotId, take.shotId), eq(s.takes.status, 'candidate')))

    // 全部拒绝才触发重试升级；还有候选就停留在 review
    if ((remaining?.n ?? 0) === 0) {
      const r = await applyTransition(deps, take.shotId, { type: 'takes.allRejected' })
      return { shotId: take.shotId, status: r.next, remaining: 0 }
    }
    return { shotId: take.shotId, status: 'review', remaining: remaining?.n ?? 0 }
  })

  /**
   * 渲染本集（06-api-spec.md §5）。
   * 控制面只把 clip 清单交给 media worker，字节流不经过这里。
   *
   * **200 而不是 202**：`renderEpisode` 从头到尾 await media worker，返回时母版
   * 已经落库，响应体里带着 assetId / storageKey——那是完成的形状，不是 Accepted 的。
   * 此前回 202 是句谎话：调用方以为要去轮询，而根本没有可轮询的端点
   * （`GET /api/renders/:id` 文档里有、代码里没有）。
   *
   * 真做成异步是有代价的：要建 q:render、拆 worker、补轮询端点。M1 不碰渲染，
   * 真异步现在没有需求方，所以选「让代码别说谎」而不是「把谎话实现出来」。
   * 一集 12 镜的渲染实测 4 秒级，同步等得住。
   */
  app.post('/api/episodes/:id/render', async (req) => {
    const { id } = Uuid.parse(req.params)
    const body = z.object({ quality: z.enum(['preview', 'final']).default('preview') }).parse(req.body ?? {})
    try {
      return await renderEpisode({ db, media: deps.media }, id, { quality: body.quality })
    } catch (e) {
      // 连不上是运维问题（503，去起服务），其余是数据问题（409，去看这一集）
      if (e instanceof MediaWorkerUnavailable) throw new ApiError('DEPENDENCY_UNAVAILABLE', e.message)
      throw new ApiError('CONFLICT', e instanceof Error ? e.message : String(e))
    }
  })

  /** 播放清单。有母版就放母版，没有就退回逐镜连播（M0 允许两种都存在） */
  app.get('/api/watch/:id', async (req) => {
    const { id } = Uuid.parse(req.params)
    const [ep] = await db.select().from(s.episodes).where(eq(s.episodes.id, id))
    if (!ep) throw new ApiError('NOT_FOUND', `episode ${id} 不存在`)

    const [master] = await db
      .select({ asset: s.assets, finishedAt: s.renderJobs.finishedAt })
      .from(s.renderJobs)
      .innerJoin(s.assets, eq(s.renderJobs.outputAssetId, s.assets.id))
      .innerJoin(s.timelines, eq(s.renderJobs.timelineId, s.timelines.id))
      .where(and(eq(s.timelines.episodeId, id), eq(s.renderJobs.status, 'succeeded')))
      .orderBy(desc(s.renderJobs.finishedAt))
      .limit(1)

    return {
      title: ep.title,
      index: ep.index,
      masterAssetId: master?.asset.id ?? null,
      durationSec: master?.asset.durationSec ? Number(master.asset.durationSec) : null,
    }
  })

  /** Generation Ledger 视图：一个镜头的全部生成尝试，含失败的（C4） */
  app.get('/api/shots/:id/jobs', async (req) => {
    const { id } = Uuid.parse(req.params)
    return {
      jobs: await db
        .select()
        .from(s.generationJobs)
        .where(eq(s.generationJobs.shotId, id))
        .orderBy(s.generationJobs.attempt),
    }
  })

  /** 302 到预签名 URL。**控制面绝不代理媒体字节流**（10 §1.2） */
  app.get('/api/assets/:id/content', async (req, reply) => {
    const { id } = Uuid.parse(req.params)
    const [asset] = await db.select().from(s.assets).where(eq(s.assets.id, id))
    if (!asset) throw new ApiError('NOT_FOUND', `asset ${id} 不存在`)
    return reply.redirect(await deps.storage.presignGet(asset.storageKey, 900), 302)
  })

  /** 洞察页与顶栏 CostMeter 的数据源（08 §6、07 §6.1） */
  app.get('/api/projects/:id/stats', async (req) => {
    const { id } = Uuid.parse(req.params)
    const policy = budgetFromEnv()

    const byStatus = await db
      .select({ status: s.shots.status, n: sql<number>`count(*)::int` })
      .from(s.shots)
      .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
      .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
      .where(eq(s.episodes.projectId, id))
      .groupBy(s.shots.status)

    const [cost] = await db
      .select({
        total: sql<string>`coalesce(sum(${s.generationJobs.costMicroUsd}), 0)`,
        attempts: sql<number>`count(*)::int`,
        accepted: sql<number>`count(*) filter (where ${s.generationJobs.accepted})::int`,
      })
      .from(s.generationJobs)
      .innerJoin(s.shots, eq(s.generationJobs.shotId, s.shots.id))
      .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
      .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
      .where(eq(s.episodes.projectId, id))

    const shots = Object.fromEntries(ShotStatus.options.map((k) => [k, 0])) as Record<string, number>
    for (const r of byStatus) shots[r.status] = r.n

    const accepted = cost?.accepted ?? 0
    const totalMicroUsd = Number(cost?.total ?? 0)

    return {
      shots,
      cost: {
        totalMicroUsd,
        // CostMeter 的分母。目前来自全局 env，按项目区分见 issue #9
        dailyLimitMicroUsd: policy.dailyLimitMicroUsd,
      },
      quality: {
        attempts: cost?.attempts ?? 0,
        accepted,
        // 每可用镜头成本——比「每秒多少钱」有意义得多，它把重试率算了进去
        usdPerAcceptedMicro: accepted > 0 ? Math.round(totalMicroUsd / accepted) : null,
      },
    }
  })
}
