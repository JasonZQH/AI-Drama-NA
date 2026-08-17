import type { GenerationRequest, ProviderProgress, StudioEvent, VideoProvider } from '@ai-drama/contracts'
import { TERMINAL_JOB_STATUSES, isTerminalJobStatus } from '@ai-drama/contracts'
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm'
import type IORedis from 'ioredis'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { applyShotTransition } from '../pipeline/applyTransition.js'
import { release, tryAcquire } from './semaphore.js'
import { pollDelayMs, type Queues } from './queues.js'

/**
 * 编排：把 generation_jobs 的生命周期与队列串起来。
 *
 * 两条贯穿始终的规矩：
 *
 * 1. **提交即返回**（05-job-orchestration.md §7.5）。绝不在 BullMQ 的 job 里
 *    同步等生成完成——那会占满 worker 槽位、让 lock 续期依赖 event loop 让出，
 *    网络一抖任务就丢，而 GPU 上钱已经花了。提交完写库、立刻完成，
 *    进度交给自重排的轮询任务。
 *
 * 2. **Postgres 是真相源**（ADR-0003）。Redis 里的东西可以全丢，
 *    重启后从非终态记录重建。
 */

export interface OrchestratorDeps {
  readonly db: Db
  readonly redis: IORedis
  readonly queues: Queues
  readonly providers: readonly VideoProvider[]
  /** 每镜最大质量重试次数（03-pipeline.md §4 的 evalPolicy） */
  readonly maxAttempts: number
}

export const PROVIDER_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 认领悬空多久才判定为「提交期间进程死了」。
 *
 * 远大于一次 POST 的 RTT，又远小于人的耐心。判早了会把一个还活着的提交
 * 误判成悬空；判晚了镜头多卡一会儿——两害相权，误判的代价是重复计费，所以宁可判晚。
 * ponytail: 常量即校准旋钮。真 provider 的 submit p99 有数据后按实测调，别拍脑袋调小。
 */
export const CLAIM_STALE_MS = 10 * 60 * 1000

/**
 * 提交认领——本 PR 的全部要点。
 *
 * 把「这一行的花钱许可证」写进 Postgres，而不是靠「队列里至多一个条目」。
 * 后者做不到：orchestrator 的信号量重排本来就会 re-add 同一个 generationJobId，
 * reconcileOnBoot 也会在 worker 仍持有条目时再加一条，而 add() 没有去重。
 *
 * 单条 `UPDATE ... WHERE` 在 READ COMMITTED 下天然原子：并发的第二个认领者
 * 阻塞在行锁上，锁释放后重新求值 WHERE，此时 started_at 已非空，匹配 0 行。
 * 不需要显式事务、不需要 SELECT FOR UPDATE、不需要 advisory lock。
 *
 * 用已有的 started_at 列而不是新加一列：它此前的语义是「provider 受理的时刻」，
 * 前移一个 RTT 变成「我们开始提交的时刻」——这才是 job 表里 started_at 的通常
 * 含义，且唯一的消费者（reconcile 回填给 poll 的 submittedAt）只会让 15 分钟的
 * 超时判定早几秒触发。
 */
export async function claimForSubmit(db: Db, jobId: string): Promise<boolean> {
  const rows = await db
    .update(s.generationJobs)
    .set({ startedAt: new Date() })
    .where(
      and(
        eq(s.generationJobs.id, jobId),
        eq(s.generationJobs.status, 'queued'),
        isNull(s.generationJobs.startedAt),
        isNull(s.generationJobs.providerJobRef),
      ),
    )
    .returning({ id: s.generationJobs.id })
  return rows.length === 1
}

/**
 * 进度 → SSE。
 *
 * pct 缺省时补 0 而不是跳过：`stage` 单独也有价值——「加载模型中」配一条
 * 不动的 0% 条，是「系统在忙」；什么都不发，是「系统死了」。这两者在
 * 07 §2 R1 下是完全不同的两件事。
 */
async function publishProgress(
  deps: OrchestratorDeps,
  generationJobId: string,
  res: ProviderProgress,
): Promise<void> {
  const [row] = await deps.db
    .select({ shotId: s.generationJobs.shotId })
    .from(s.generationJobs)
    .where(eq(s.generationJobs.id, generationJobId))
  if (!row) return

  const event: StudioEvent = {
    type: 'job.progress',
    jobId: generationJobId,
    shotId: row.shotId,
    pct: res.progressPct ?? 0,
    ...(res.etaMs === undefined ? {} : { etaMs: res.etaMs }),
    ...(res.stage === undefined ? {} : { stage: res.stage }),
  }
  await deps.queues.notify.add('notify', { projectId: '', payload: event })
}

function providerOf(deps: OrchestratorDeps, id: string): VideoProvider {
  const p = deps.providers.find((x) => x.id === id)
  if (!p) throw new Error(`provider 不在池中：${id}`)
  return p
}

/**
 * q:generate 的 handler。
 *
 * 幂等由两层保证：provider 的 submit 契约（同 requestId 同 handle），
 * 以及 generation_jobs 的 UNIQUE(shot_id, attempt)。任何一层单独失效
 * 都不会导致重复计费。
 */
export async function handleGenerate(
  deps: OrchestratorDeps,
  data: { generationJobId: string },
): Promise<'submitted' | 'requeued' | 'skipped'> {
  const [job] = await deps.db
    .select()
    .from(s.generationJobs)
    .where(eq(s.generationJobs.id, data.generationJobId))
  if (!job) return 'skipped'

  // 已提交过的直接转轮询——崩溃恢复重放时会走到这里
  if (job.providerJobRef) {
    await enqueuePoll(deps, job.id, job.providerId, job.providerJobRef, Date.now())
    return 'skipped'
  }

  const provider = providerOf(deps, job.providerId)

  // provider 配额是跨进程的（§3 第 ② 层）。拿不到槽位就重排，不阻塞 worker
  const got = await tryAcquire(deps.redis, provider.id, provider.capabilities.maxConcurrent)
  if (!got) {
    await deps.queues.generate.add(
      'generate',
      { generationJobId: job.id, shotId: job.shotId },
      { delay: 2000 },
    )
    return 'requeued'
  }

  try {
    const req = buildRequest(job)
    const v = provider.validate(req)
    if (!v.ok) {
      // validate 不得有 IO（04 §7），所以走到这里一次网络调用都没发生过——
      // 这是全部五个失败入口里唯一一个**确知**没花钱的
      await fail(deps, job.id, 'invalid_output', `能力不匹配：${v.reason}`, ZERO_COST)
      return 'skipped'
    }

    // 认领在 validate 之后、submit 之前。拿不到就闭嘴走人——别人已经在花这笔钱了
    if (!(await claimForSubmit(deps.db, job.id))) return 'skipped'

    let handle
    try {
      handle = await provider.submit(req)
    } catch (e) {
      /*
       * 抛出时我们**分不清**「请求根本没发出去」和「发出去了但响应丢了」。
       * OpenRouter 的 POST 没有幂等键，所以既问不出来、也不能安全重放。
       *
       * 于是不释放认领，走一条不可重试的码停下来交给人（配 POST /shots/:id/reset）。
       * 代价是一次 ECONNREFUSED 也要人点一下；收益是绝不会自动付第二次钱。
       * 这个方向的错误便宜得多——真 provider 的第一笔重复扣费是查不回来的。
       * ponytail: 一刀切保守。等适配器能抛出带「请求是否已发出」的类型化错误再放宽。
       */
      /*
       * 按估算值记账，并标成估算。
       *
       * 记 0 会让预算闸门失效——这正是本 PR 要修的那个洞；记成真账则是
       * Ledger 在说谎，因为这笔钱可能压根没花出去。costEstimated 让两者都成立：
       * 闸门照样把它算进今日花费，报表能把它与真实计费分开显示。
       */
      await fail(
        deps,
        job.id,
        'submit_unknown',
        `提交结果未知，本行不再重投：${String(e)}`,
        estimatedCost(provider, job),
      )
      return 'skipped'
    }

    await deps.db
      .update(s.generationJobs)
      // startedAt 不再在这里写——它已经是上面那次认领的时刻
      .set({ status: 'submitted', providerJobRef: handle.externalId })
      .where(eq(s.generationJobs.id, job.id))

    await enqueuePoll(deps, job.id, provider.id, handle.externalId, handle.submittedAt)
    return 'submitted'
  } finally {
    // 槽位在提交完成后就释放：占用的是「并发提交数」，不是「并发生成数」。
    // provider 侧的真实并发由它自己的队列管，我们不该替它排队。
    await release(deps.redis, provider.id)
  }
}

function buildRequest(job: typeof s.generationJobs.$inferSelect): GenerationRequest {
  const params = job.params as Record<string, unknown>
  return {
    requestId: job.id,
    shotId: job.shotId,
    mode: job.mode,
    prompt: job.promptText,
    ...(job.negativeText ? { negativePrompt: job.negativeText } : {}),
    refImages: [],
    durationSec: Number(params['durationSec'] ?? 4),
    resolution: (params['resolution'] as '720p') ?? '720p',
    aspectRatio: (params['aspectRatio'] as '9:16') ?? '9:16',
    fps: Number(params['fps'] ?? 24),
    ...(job.seed === null ? {} : { seed: job.seed }),
    safetyProfile: 'standard',
    priority: 'normal',
    providerParams: (params['providerParams'] as Record<string, unknown>) ?? {},
  }
}

async function enqueuePoll(
  deps: OrchestratorDeps,
  generationJobId: string,
  providerId: string,
  externalId: string,
  submittedAt: number,
): Promise<void> {
  await deps.queues.poll.add(
    'poll',
    { generationJobId, providerId, externalId, submittedAt, pollCount: 0 },
    { delay: pollDelayMs(0) },
  )
}

/**
 * q:poll 的 handler —— **自重排**，不是常驻循环。
 *
 * 同一时刻内存里没有任何挂起的循环，只有 Redis 里的延时条目。
 * 几千个并行任务也不会压垮进程（§4）。
 */
export async function handlePoll(
  deps: OrchestratorDeps,
  data: {
    generationJobId: string
    providerId: string
    externalId: string
    submittedAt: number
    pollCount: number
  },
): Promise<'running' | 'succeeded' | 'failed' | 'timeout' | 'skipped'> {
  /*
   * 终态守卫：这一行已经结算过了就别再碰。
   *
   * 同一个 job 可以有不止一条轮询链——reconcileOnBoot 无条件为每个有
   * providerJobRef 的非终态行再 add 一条，而旧链是自重排的、不会自己消失。
   * 两条链先后越过超时判定时，后到的那条会把已经判 failed 的行改回 running，
   * 再一路写成 succeeded + accepted=true，而 failure_code 还留在行上——
   * Ledger 里就出现一行「既成功又失败」的自相矛盾记录，且被计入
   * usdPerAcceptedMicro 的分母（routes/stats.ts）。C4 那张表的价值全在于它不说谎。
   *
   * 一次 select 关掉下面所有写入口，比在三处 UPDATE 各挂一个谓词好懂。
   */
  // 读整行而不是只读 status：超时估算与后面取 shotId 都要用，反而少一次查询
  const [current] = await deps.db
    .select()
    .from(s.generationJobs)
    .where(eq(s.generationJobs.id, data.generationJobId))
  if (!current) return 'skipped'
  if (isTerminalJobStatus(current.status)) return 'skipped'

  const provider = providerOf(deps, data.providerId)
  const handle = { providerId: data.providerId, externalId: data.externalId, submittedAt: data.submittedAt }

  const res = await provider.poll(handle)

  if (res.status === 'running' || res.status === 'submitted') {
    if (Date.now() - data.submittedAt > PROVIDER_TIMEOUT_MS) {
      await provider.cancel(handle).catch(() => undefined)
      /*
       * 超时一定是花过钱的——任务在 provider 那边真的跑了十几分钟。
       * 而且 cancel 是 best-effort（失败被吞掉），所以它很可能还在继续跑、继续计费。
       * 只能按价目表估，标成估算。
       */
      await fail(
        deps,
        data.generationJobId,
        'timeout',
        `超过 ${PROVIDER_TIMEOUT_MS / 60000} 分钟未返回`,
        estimatedCost(provider, current),
      )
      return 'timeout'
    }
    await deps.db
      .update(s.generationJobs)
      .set({ status: 'running' })
      .where(eq(s.generationJobs.id, data.generationJobId))

    /*
     * 把 provider 报的进度转成 SSE。
     *
     * 这一步以前是缺的：poll() 返回的 progressPct / stage 被原地丢掉，于是
     * `job.progress` 这个事件从来没有人发过——契约里有、SSE 层专门为它写了
     * 节流、前端进度条在等它，整条路径却是死的。mock 跑得太快所以没人发现，
     * 但接上真 provider 后一次生成要几十秒到几分钟，进度条不动等于 R1 失效。
     */
    await publishProgress(deps, data.generationJobId, res)

    await deps.queues.poll.add(
      'poll',
      { ...data, pollCount: data.pollCount + 1 },
      { delay: pollDelayMs(data.pollCount + 1) },
    )
    return 'running'
  }

  if (res.status === 'failed') {
    /*
     * provider 报了就用它的真数；没报就估。
     *
     * 「没报」不等于「免费」——多数厂商对失败的生成照样计费，只是不在失败
     * 响应里带账单。这里的默认值必须是「估一个」，不是「记 0」。
     */
    const cost =
      res.costMicroUsd === undefined
        ? estimatedCost(provider, current)
        : { microUsd: res.costMicroUsd, estimated: false }
    await fail(deps, data.generationJobId, res.code, res.message, cost)
    return 'failed'
  }

  // 正面判定 succeeded 而不是靠排除法：ProviderProgress.status 是
  // 'submitted' | 'running' 两值枚举，上面那个 || 判断不足以让 TS 把它从
  // 联合里narrow 掉。宁可多一次显式检查，也不要靠穷举推断。
  if (res.status !== 'succeeded') return 'running'

  // 终态成功：转 ingest 下载/转存。控制面不在这里搬字节
  const projectId = await projectOfShot(deps.db, current.shotId)
  await deps.db
    .update(s.generationJobs)
    .set({
      status: 'downloading',
      costMicroUsd: res.costMicroUsd,
      /*
       * 成功路径同样要标。契约说得很清楚：provider 不回报成本时由适配器按
       * 价目表估算并标 providerMeta.costEstimated（04 §2）——这个标记此前
       * 被原地丢掉，于是「厂商回报的真实计费」与「适配器自己估的」在库里
       * 长得一模一样。M1 验收第 1 条要的正是「成本正确回填」。
       */
      costEstimated: res.providerMeta['costEstimated'] === true,
      latencyMs: Date.now() - data.submittedAt,
      ...(res.seedUsed === undefined ? {} : { seed: res.seedUsed }),
    })
    .where(eq(s.generationJobs.id, data.generationJobId))

  await deps.queues.ingest.add('ingest', {
    generationJobId: data.generationJobId,
    shotId: current.shotId,
    projectId,
    sourceUrl: res.outputUrl,
    ...(res.storageKey ? { storageKey: res.storageKey } : {}),
  })
  return 'succeeded'
}

async function projectOfShot(db: Db, shotId: string): Promise<string> {
  const rows = await db
    .select({ projectId: s.projects.id })
    .from(s.shots)
    .innerJoin(s.scenes, eq(s.shots.sceneId, s.scenes.id))
    .innerJoin(s.episodes, eq(s.scenes.episodeId, s.episodes.id))
    .innerJoin(s.projects, eq(s.episodes.projectId, s.projects.id))
    .where(eq(s.shots.id, shotId))
  const first = rows[0]
  if (!first) throw new Error(`找不到 shot ${shotId} 所属的 project`)
  return first.projectId
}

/**
 * 失败要做两件事，缺一条流水线就会卡住：
 * 1. 写 job 的失败记录（Ledger 要留痕，含失败的尝试——约束 C4）
 * 2. **推进镜头状态机**。曾经漏了这条，撞上失败的镜头永远停在 generating
 *
 * 状态机判定还能重试时会回到 ready，这里立刻再发一次 generate.requested，
 * 由它创建下一个 attempt——这就是 05 §5.2 的「换 seed / 参数 / provider」
 * 升级路径的驱动点。
 */
/**
 * 失败也要记账。
 *
 * `cost` 的三种取值对应三种事实，调用方必须想清楚自己是哪一种：
 * - `{ microUsd: n, estimated: false }` —— provider 回报的真实计费
 * - `{ microUsd: n, estimated: true }`  —— 我们按价目表估的（超时、结果未知）
 * - `ZERO_COST`                          —— 确知没花钱（请求根本没发出去）
 *
 * 不传等同于 ZERO_COST，但**别靠这个默认值**：真 provider 对失败、超时、
 * 取消照样计费，把它们当免费是 M0 遗留下来最贵的一个假设。
 */
interface FailureCost {
  readonly microUsd: number
  readonly estimated: boolean
}

const ZERO_COST: FailureCost = { microUsd: 0, estimated: false }

/** 按价目表估这一行的花费。用于 provider 没回报成本、或压根来不及回报的情形 */
function estimatedCost(provider: VideoProvider, job: typeof s.generationJobs.$inferSelect): FailureCost {
  return { microUsd: provider.estimateCost(buildRequest(job)), estimated: true }
}

async function fail(
  deps: OrchestratorDeps,
  generationJobId: string,
  code: NonNullable<(typeof s.generationJobs.$inferSelect)['failureCode']>,
  detail: string,
  cost: FailureCost = ZERO_COST,
): Promise<void> {
  const [job] = await deps.db
    .select({ shotId: s.generationJobs.shotId, providerId: s.generationJobs.providerId })
    .from(s.generationJobs)
    .where(eq(s.generationJobs.id, generationJobId))

  /*
   * 判死是**幂等**的：只有从非终态翻过去的那一次才推状态机。
   *
   * 没有这个守卫时，两条轮询链先后超时会各调一次 fail()，而每一次 fail() 都
   * 可能让状态机开一个新 attempt——一次真实超时能烧掉两三笔钱，并把
   * maxAttempts 提前耗光。行级认领对此完全无能为力，因为每一笔都是新行。
   */
  const claimed = await deps.db
    .update(s.generationJobs)
    .set({
      status: 'failed',
      failureCode: code,
      failureDetail: detail,
      finishedAt: new Date(),
      accepted: false,
      costMicroUsd: cost.microUsd,
      costEstimated: cost.estimated,
    })
    .where(
      and(
        eq(s.generationJobs.id, generationJobId),
        notInArray(s.generationJobs.status, [...TERMINAL_JOB_STATUSES]),
      ),
    )
    .returning({ id: s.generationJobs.id })
  if (claimed.length === 0) return

  if (!job) return

  /*
   * 用**这一行自己的** provider，而不是 providers[0]。
   *
   * 原来写死 providers[0] 有两个问题：重试会被静默改派到另一个 provider
   * （成本对比就没意义了），而且闸门下沉之后 estimateCost 也会用错家的价目表。
   * 池里找不到就退回 providers[0]——那是配置问题，不该让失败路径再抛一次。
   */
  const provider = deps.providers.find((p) => p.id === job.providerId) ?? deps.providers[0]
  if (!provider) return

  const tdeps = { db: deps.db, queues: deps.queues, provider, maxAttempts: deps.maxAttempts }
  const r = await applyShotTransition(tdeps, job.shotId, { type: 'attempt.failed', code })
  /*
   * 回到 ready 说明还能重试——立刻创建下一次尝试，不等人来点。
   *
   * 这一步现在会过预算闸门（闸门在 enqueue.generation 分支里）。被拦下时
   * 镜头停在 ready，人在面板上看得到，加额度后可以手动再发起——比原先
   * 「不问额度直接重投」安全，那正是「一次误操作烧穿预算」的主力路径之一。
   */
  if (r?.ok && r.next === 'ready') {
    await applyShotTransition(tdeps, job.shotId, { type: 'generate.requested' })
  }
}

/**
 * 崩溃恢复（§8）。控制面重启时把非终态任务捞回来：
 * 从未提交成功的重新入队（幂等键保证不会重复计费），已提交的恢复轮询而非重新提交。
 *
 * 幂等是这套逻辑成立的前提——所以它是 provider 契约测试的第一条。
 */
export async function reconcileOnBoot(
  deps: OrchestratorDeps,
): Promise<{ requeued: number; resumed: number; inFlight: number; inDoubt: number }> {
  const stuck = await deps.db
    .select()
    .from(s.generationJobs)
    .where(inArray(s.generationJobs.status, ['queued', 'submitted', 'running', 'downloading', 'evaluating']))

  let requeued = 0
  let resumed = 0
  let inFlight = 0
  let inDoubt = 0

  for (const job of stuck) {
    /*
     * 每行单独 try：这个函数跑在 app.listen 之前（server.ts）。加了写操作之后，
     * 一行历史坏数据不该让整个控制面起不来。
     */
    try {
      if (job.providerJobRef) {
        await deps.queues.poll.add('poll', {
          generationJobId: job.id,
          providerId: job.providerId,
          externalId: job.providerJobRef,
          submittedAt: job.startedAt?.getTime() ?? Date.now(),
          pollCount: 0,
        })
        resumed++
      } else if (!job.startedAt) {
        // 从未认领过，重新提交是安全的
        await deps.queues.generate.add('generate', { generationJobId: job.id, shotId: job.shotId })
        requeued++
      } else if (Date.now() - job.startedAt.getTime() < CLAIM_STALE_MS) {
        // 认领了但还没记账，且很新——多半有个 worker 正在 submit 里。别碰
        inFlight++
      } else {
        /*
         * 认领悬空：提交期间进程没了，**钱花没花不知道**。
         *
         * 重新入队等于可能付第二次；就这么留着等于镜头永远卡在 generating。
         * 两者之间选「停下来交给人」——submit_unknown 不可重试，人在面板上
         * 看到解释后用 POST /api/shots/:id/reset 决定要不要再来一次。
         */
        await fail(
          deps,
          job.id,
          'submit_unknown',
          '提交期间进程中断，是否已计费未知，需人工确认',
          estimatedCost(providerOf(deps, job.providerId), job),
        )
        inDoubt++
      }
    } catch (e) {
      console.error(`[reconcile] job ${job.id} 处理失败，跳过：`, e instanceof Error ? e.message : e)
    }
  }
  return { requeued, resumed, inFlight, inDoubt }
}
