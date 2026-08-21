import type { GenerationRequest, VideoProvider } from '@ai-drama/contracts'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import * as s from '../db/schema.js'
import { routeProvider } from '../providers/route.js'
import { createGenerationJob } from '../queue/ingest.js'
import type { Queues } from '../queue/queues.js'
import { budgetFromEnv, spentTodayForShot, type BudgetPolicy, type BudgetСheckResult } from './batch.js'
import { resolvePrompt } from './resolvePrompt.js'
import { transition, type ShotEvent } from './shotMachine.js'

/**
 * M1 只有 t2v。
 *
 * 另外三种 mode 都要视觉输入：i2v / ref2v 要参考图，extend 要末帧——而参考图
 * 通路的上下游都还不存在（三张资产表的图片列全空、没有上传端点、presignGet 签
 * 的是 S3_PUBLIC_ENDPOINT=localhost 云端取不到）。等 M2 一并接。
 *
 * 提出来是因为它此前在两处各写了一遍字面量：路由 probe 和真实请求。两处独立
 * 演化的话，路由就是在对一个与实际不符的请求做能力判断。
 */
const GENERATION_MODE = 't2v' as const

/**
 * 状态迁移的**唯一执行点**。
 *
 * 状态机本身是纯函数、只返回 Effect[]；这里负责把那些副作用真的做掉。
 * HTTP 路由与队列 handler 都必须走这里——曾经它只存在于 routes 里，
 * 于是 ingest 建完 take 没人推进状态机，镜头永远停在 generating。
 */

/**
 * 这里只用得上「往两个队列里塞东西」，所以只要这两个能力。
 *
 * 收窄不是洁癖：要整个 `Queues` 的话，测试里想换掉 `generate.add`（比如验
 * 「入队失败不该回滚已提交的迁移」）就只能写 `as unknown as Queues` ——
 * 而 eslint 明令禁止双重断言，它的提示恰好是「先问为什么类型对不上」。
 * 答案就是这个：依赖声明得比实际用到的宽。
 */
export interface TransitionQueues {
  readonly generate: Pick<Queues['generate'], 'add'>
  readonly notify: Pick<Queues['notify'], 'add'>
}

export interface TransitionDeps {
  readonly db: Db
  readonly queues: TransitionQueues
  /**
   * 整个池，不是单个 provider。
   *
   * 「选哪个」由 `routeProvider` 在这里决定，然后落进 `generation_jobs.provider_id`
   * ——Ledger 记的是「当时选了谁」，重放与恢复据此取回同一个实例。此前三个调用点
   * 各自传 `providers[0]`，等于「路由」这件事根本没有发生过。
   */
  readonly providers: readonly VideoProvider[]
  readonly maxAttempts: number
  /** 不传则读 env。测试要压低日限额时传它，不必去改 process.env */
  readonly budget?: BudgetPolicy
}

export type ApplyResult =
  | { readonly ok: true; readonly next: string }
  | {
      readonly ok: false
      /**
       * 两种拒绝要分开：状态机拒绝是 400（用户点错了），预算拒绝是 402
       * （用户没点错，是钱不够）。混成一种的话 UI 说不清该让人做什么。
       */
      readonly code: 'INVALID_TRANSITION' | 'BUDGET_EXCEEDED' | 'NO_PROVIDER'
      readonly reason: string
      readonly from: string
      readonly budget?: BudgetСheckResult
    }

/**
 * 一次迁移里所有要入队的东西。**必须等事务提交之后再发。**
 *
 * 在事务里发有两个问题，第二个更贵：
 * 1. 一次 Redis 往返被圈进了 Postgres 的行锁持有期，锁白白多握几毫秒；
 * 2. 事务如果回滚，队列条目**不会跟着回滚**——于是留下一条指向不存在的
 *    generation_jobs 行的任务。handleGenerate 读不到行只会 return 'skipped'，
 *    看起来无害，但它掩盖了「这次迁移其实失败了」这件事。
 */
type Pending = () => Promise<unknown>

export async function applyShotTransition(
  deps: TransitionDeps,
  shotId: string,
  event: ShotEvent,
): Promise<ApplyResult | null> {
  const pending: Pending[] = []

  /*
   * 整段包进一个事务，并对 shot 行加锁。
   *
   * 这里原本是「读状态 → 依次做副作用 → 最后写状态」的裸序列，中间没有任何
   * 边界。两个后果，都实际会发生：
   *
   * - **并发**：两个请求同时读到 status='ready'，双双通过状态机校验，各建一行
   *   generation_jobs——同一个镜头付两次钱。attempt 号来自 shots.attemptCount
   *   的无锁读-改-写，所以连 UNIQUE(shot_id, attempt) 都挡不住（拿到的是 N+1
   *   和 N+2 两个合法号）。撞成同一个号时唯一约束抛出的裸 pg 错又会变成 500。
   * - **中断**：崩在「建了 job 行」与「写 shot 状态」之间，会留下 job 已入队
   *   而 shot 仍是 ready 的半完成状态；下次 reconcileOnBoot 会替它真花一笔钱，
   *   而产物回来时 take.accepted 打在 ready 上会被状态机拒掉——钱花了，
   *   take 成孤儿。
   *
   * FOR UPDATE 让第二个事务阻塞在行锁上，等第一个提交后重新读到新状态，
   * 于是状态机干净地拒绝它（400 而不是 500，也不是第二笔钱）。
   */
  const result = await deps.db.transaction(async (tx): Promise<ApplyResult | null> => {
    const [row] = await tx.select().from(s.shots).where(eq(s.shots.id, shotId)).for('update')
    if (!row) return null

    /*
     * **attempt 号取自 `generation_jobs` 的最大值，不是 `shots.attempt_count`。**
     *
     * 唯一约束 `gj_shot_attempt_uq` 建在 `(shot_id, attempt)` 上，而计数器在
     * 另一张表——两者一旦漂开，下一次生成就会算出一个已经用过的号，插入时撞
     * 唯一约束抛裸 pg 错。
     *
     * 实测漂过：一个镜头 `attempt_count=0` 却已经有一条 `attempt=1` 的 job
     * （中间经过一次 ingest 失败与人工重新入队）。于是批量生成走到它时 500，
     * 而**整批剩下的 8 个镜头再没入队**——面板上什么都没显示。
     *
     * 在 FOR UPDATE 事务里读，所以并发拿不到同一个号。
     */
    const [maxAttempt] = await tx
      .select({ n: sql<number>`coalesce(max(${s.generationJobs.attempt}), 0)::int` })
      .from(s.generationJobs)
      .where(eq(s.generationJobs.shotId, shotId))

    const r = transition(
      {
        id: row.id,
        status: row.status,
        attemptCount: Math.max(row.attemptCount, maxAttempt?.n ?? 0),
        selectedTakeId: row.selectedTakeId,
      },
      event,
      { maxAttempts: deps.maxAttempts },
    )
    if (!r.ok) return { ok: false, code: 'INVALID_TRANSITION', reason: r.reason, from: row.status }

    for (const e of r.effects) {
      switch (e.type) {
        case 'enqueue.generation': {
          const params = {
            durationSec: Number(row.durationSec),
            resolution: '720p' as const,
            aspectRatio: '9:16' as const,
            fps: 24,
          }
          /*
           * prompt 在路由**之前**构建，两个理由：
           *
           * 1. `CostModel.unit` 允许 `per_token`。估算要看得见真 prompt，否则
           *    对按 token 计价的 provider，闸门读到的是一个空串的价钱。
           * 2. probe 与真实请求用同一个 prompt，路由才不是在对一个假请求做能力
           *    判断。此前 probe 的 prompt 恒为 ''，两者从一开始就不是一回事。
           */
          /*
           * 取数 + 拼装抽到了 `resolvePrompt`——`POST /api/ai/prompt-preview`
           * 要回答的是同一个问题（花钱之前先看清将要发出去的是什么）。预览另写
           * 一份就是 PR-J 修掉的那类 bug 的翻版：两份会漂，而漂了之后预览显示的
           * 和真实发出去的不是一回事，那比没有预览更坏。
           */
          const built = await resolvePrompt(tx, e.shotId)
          if (!built) throw new Error(`shot ${e.shotId} 在事务里消失了`)

          const probe: GenerationRequest = {
            requestId: '00000000-0000-4000-8000-000000000000',
            shotId: e.shotId,
            mode: GENERATION_MODE,
            prompt: built.prompt,
            refImages: [],
            safetyProfile: row.safetyProfile,
            priority: 'normal',
            providerParams: {},
            ...params,
          }

          /*
           * 路由：**这里是全系统唯一决定「用哪个 provider」的地方。**
           *
           * 此前三个调用点各自传 `providers[0]`，等于路由这件事根本没发生过；
           * 而池里一旦出现第二个 provider，`shots.provider_hint` 那一列仍会是零读取。
           *
           * 失败历史从库里查：本镜在哪些 provider 上被 content_filtered 过。
           * 那是不可重试的码——同 prompt 在同一家必然再被拒（05 §5.3），所以
           * 把它们排到最后。查询在事务里，和下面的预算闸门看到同一份快照。
           */
          const filteredRows = await tx
            .selectDistinct({ providerId: s.generationJobs.providerId })
            .from(s.generationJobs)
            .where(
              and(
                eq(s.generationJobs.shotId, e.shotId),
                eq(s.generationJobs.failureCode, 'content_filtered'),
              ),
            )
          const routed = routeProvider(deps.providers, {
            providerHint: row.providerHint,
            filteredBy: filteredRows.map((x) => x.providerId),
            probe,
          })
          if (!routed) {
            return {
              ok: false,
              code: 'NO_PROVIDER',
              from: row.status,
              reason: '池内没有能力匹配的 provider',
            }
          }
          const provider = routed.provider

          /*
           * 预算闸门就在这里，而不是在三个 caller 各写一遍。
           *
           * `enqueue.generation` 是全系统唯一的花钱入口：单镜 API、批量生成、
           * 以及 fail() 里自动创建的下一次 attempt 全都经过它。此前闸门只挂在
           * 批量路由上，后两条完全裸奔——一个镜头失败重试 4 次不过任何闸门。
           *
           * 注意估算用的是**路由选出来的那家**的价目表，不是 `providers[0]` 的——
           * 否则 dryRun 的数与实际扣费不是一回事，M1 验收第 2 条（误差 <20%）无从谈起。
           */
          const estimate = provider.estimateCost(probe)
          const policy = deps.budget ?? budgetFromEnv()
          const spent = await spentTodayForShot(tx, e.shotId)
          if (spent + estimate > policy.dailyLimitMicroUsd && policy.onExceed === 'block') {
            return {
              ok: false,
              code: 'BUDGET_EXCEEDED',
              from: row.status,
              reason: `预估 ${estimate} + 已花 ${spent} 超过日限 ${policy.dailyLimitMicroUsd}（微美元）`,
              budget: {
                dailyLimitMicroUsd: policy.dailyLimitMicroUsd,
                spentTodayMicroUsd: spent,
                wouldExceed: true,
                onExceed: policy.onExceed,
              },
            }
          }

          const jobId = await createGenerationJob(tx, {
            shotId: e.shotId,
            attempt: e.attempt,
            providerId: provider.id,
            // 此前硬编码 'mock-v1'——ledger 里每一笔真实花费的模型名都会是 mock 的，
            // 而 gj_analytics_idx 正是按 (provider_id, model_id) 建的
            modelId: provider.modelId,
            mode: GENERATION_MODE,
            promptText: built.prompt,
            /*
             * 负向词来自 style_profiles，此前这一列没有任何写入方。
             * OpenRouter 的请求体没有 negative_prompt，适配器忽略即可；
             * M2 的 ComfyUI 体系里它有效。列已经在，写它不花钱。
             */
            ...(built.negativePrompt ? { negativeText: built.negativePrompt } : {}),
            params: {
              ...params,
              // 此前 buildRequest 把 safetyProfile 写死 'standard'，而路由 probe
              // 用的是 row.safetyProfile——同一次生成，路由看到的和真实请求不一致
              safetyProfile: row.safetyProfile,
              /*
               * 景别单独传给适配器，不再指望它从 prompt 里正则出来。
               *
               * mock 的 fixturePathFor 原本靠 `\bcu\b` 这类正则匹配 prompt，
               * 之所以能工作纯粹因为老 promptText 是 `${action}, ${shotType}`
               * 拼串。换成散文 prompt 后所有镜头会静默退回 ms.mp4，而且没有
               * 任何测试会失败。providerParams 是契约里写明的 adapter-only
               * 逃生舱（04 §2），这正是它的用途。
               */
              providerParams: { shotType: row.shotType },
            },
            /*
             * **重试换 seed。**
             *
             * 05 §5.2 开篇就写着「同样的参数重试毫无意义，必须改变输入」，而此前
             * 每次重试用的是完全相同的 seed / prompt / provider——一个镜头会以同一组
             * 参数连撞 4 次然后判死，四笔钱买同一个结果。
             *
             * 这里只做第一级（换 seed）。「强化 prompt」要等 prompt-kit（P2），
             * 「换 provider」要等池里真有第二个可选项——但那两级的钩子已经在了：
             * 上面的 routeProvider 会自动规避被 content_filtered 过的家。
             */
            ...(e.attempt > 1 ? { seed: Math.floor(Math.random() * 2 ** 31) } : {}),
            /*
             * **在途预留**：建行的同时就把估算值记进成本。
             *
             * `spentTodayForShot` 求和的就是这一列，所以排队中的任务立刻开始
             * 占额度，不必新建表或计数器。任务落终态时真实计费会覆盖它
             * （成功走 handlePoll、失败走 fail()，两条都已经在写这一列）；
             * 能力校验不通过写 0，等于把预留退回去。
             *
             * 没有它，闸门只看得见「已结算」的钱：一次批量把 12 个镜头全排进去
             * 时账面仍是 0，闸门形同虚设。
             */
            costMicroUsd: estimate,
            costEstimated: true,
          })
          pending.push(() =>
            deps.queues.generate.add('generate', { generationJobId: jobId, shotId: e.shotId }),
          )
          await tx.update(s.shots).set({ attemptCount: e.attempt }).where(eq(s.shots.id, e.shotId))
          break
        }
        case 'set.selectedTake':
          await tx.update(s.takes).set({ status: 'selected' }).where(eq(s.takes.id, e.takeId))
          await tx.update(s.shots).set({ selectedTakeId: e.takeId }).where(eq(s.shots.id, e.shotId))
          /*
           * **accepted 的唯一写 true 的地方。**
           *
           * 它的含义是「这次生成被选中」，不是「这次生成出了片子」——后者是
           * ingest 从前写的，会让 usdPerAcceptedMicro 的分母变成成功生成数，
           * 于是重试越多每可用镜头成本越低（见 ingest.ts 的注释）。
           *
           * 一条语句同时点亮选中的、熄灭其余的：改选时旧的必须跟着灭，
           * 否则分母只增不减，而 review 态下改选是常规操作。
           */
          await tx
            .update(s.generationJobs)
            .set({
              accepted: sql`${s.generationJobs.id} = (select ${s.takes.jobId} from ${s.takes} where ${s.takes.id} = ${e.takeId})`,
            })
            .where(eq(s.generationJobs.shotId, e.shotId))
          break
        case 'clear.selectedTake':
          await tx.update(s.shots).set({ selectedTakeId: null }).where(eq(s.shots.id, e.shotId))
          // 选择被撤销（redo / 改 intent），accepted 跟着灭——否则这一镜在
          // 分母里留着一个已经不算数的名额，而它的 take 已经被 archive.takes 归档
          await tx
            .update(s.generationJobs)
            .set({ accepted: false })
            .where(eq(s.generationJobs.shotId, e.shotId))
          break
        case 'archive.takes':
          // 归档而非删除：系统永不自动销毁已经花钱生成的东西（03 §7）
          await tx
            .update(s.takes)
            .set({ status: 'archived' })
            .where(and(eq(s.takes.shotId, e.shotId), eq(s.takes.status, 'candidate')))
          break
        case 'publish':
          pending.push(() => deps.queues.notify.add('notify', { payload: e.event }))
          break
      }
    }

    await tx.update(s.shots).set({ status: r.next, updatedAt: new Date() }).where(eq(s.shots.id, shotId))
    return { ok: true, next: r.next }
  })

  /*
   * 提交之后才入队。残留窗口是「提交成功但入队失败」——此时 job 行是 queued
   * 且 provider_job_ref 为空，reconcileOnBoot 的第一个分支正好负责把它捞回来
   * 重新入队。所以这里不需要 outbox 表：崩溃恢复那条路径已经在承担这个职责。
   */
  for (const run of pending) await run()

  return result
}
