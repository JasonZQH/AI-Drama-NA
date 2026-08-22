import { Worker } from 'bullmq'
import { TERMINAL_JOB_STATUSES } from '@ai-drama/contracts'
import { and, eq, notInArray } from 'drizzle-orm'
import { createDb, type Db } from './db/client.js'
import * as s from './db/schema.js'
import { LivePool, subscribeProviderChanges } from './providers/pool.js'
import { applyShotTransition } from './pipeline/applyTransition.js'
import { handleIngest } from './queue/ingest.js'
import { handleGenerate, handlePoll } from './queue/orchestrator.js'
import { QUEUE, QUEUE_PREFIX, createConnection, createQueues } from './queue/queues.js'
import { publishEvent } from './routes/sse.js'
import { Storage, storageFromEnv } from './storage/s3.js'

/**
 * 队列消费者入口（01-architecture.md §3：与控制面同代码不同入口）。
 *
 * 三层限流的第 ①③ 层用 BullMQ 的 concurrency 实现，第 ② 层（provider 配额）
 * 是跨进程的 Redis 信号量，在 handleGenerate 里（05-job-orchestration.md §3）。
 *
 * maxStalledCount 必须调高：默认是 1，一次 stall 就直接判失败，而这里的任务
 * 动辄几十秒到几分钟（§7.5）。
 */
const dbUrl = process.env['DATABASE_URL']
const redisUrl = process.env['REDIS_URL']
if (!dbUrl || !redisUrl) throw new Error('DATABASE_URL / REDIS_URL 未设置')

const { db } = createDb(dbUrl, 5)
const redis = createConnection(redisUrl)
const pub = createConnection(redisUrl)
const queues = createQueues({ url: redisUrl })
const storage = new Storage(storageFromEnv())

/*
 * 池子按库里的密钥建（PR-D 把密钥搬进了库），并订阅变更——控制面那边存完一把
 * 新 key，这个进程不重启也能跟上。`providers` 数组引用不变，只换内容，所以
 * 下面 `deps` 与两处 `applyShotTransition` 的写法一行都不用改。
 */
const pool = new LivePool(db)
await pool.refresh()
const providers = pool.providers
await subscribeProviderChanges(
  createConnection(redisUrl),
  pool,
  (ids) => console.log('[worker] provider 池已重建：', ids.join('、')),
  (e) => console.error('[worker] 收到凭据变更但重建失败', e),
)

const deps = { db, redis, queues, providers, maxAttempts: 4 }

const base = {
  connection: { url: redisUrl },
  prefix: QUEUE_PREFIX,
  maxStalledCount: 5,
}

const globalConcurrency = Number(process.env['MAX_GLOBAL_CONCURRENT'] ?? 32)

/**
 * **提交串行，默认一次一个。**
 *
 * 别的队列（轮询、ingest、渲染）不花钱；`generate` 每一条都是一笔真钱。
 * FIFO + 并发 1 ⇒ 按入队顺序提交，而 `generate-batch` 按 `shots.index` 入队，
 * 所以提交顺序就是镜头顺序。
 *
 * **但它只串了提交，没串生成。** 云 provider 是异步的：`submit` 拿到 handle 就
 * 返回（实测 2–3 秒），真正的等待在 `poll` 队列，而那里的并发仍是
 * `MAX_GLOBAL_CONCURRENT`。真机时间戳：10 镜提交间隔 2–3 秒（串行），十个却在
 * 同一分钟里跑完（并发）。
 *
 * 所以它挡不住「第一个失败就别发后面的」——失败在 poll 阶段才浮现，那时十个
 * 早就都提交、都计费了。要做到那件事需要一个**按集的顺序器**（镜 N 到终态之后
 * 才提交镜 N+1），那是另一段编排逻辑，不是一个常量。
 *
 * 它现在真正买到的是：提交不再瞬时打爆，且失败发生时后面的还在队列里没走完。
 */
const generateConcurrency = Number(process.env['MAX_GENERATE_CONCURRENT'] ?? 1)

const workers = [
  new Worker(QUEUE.generate, (job) => handleGenerate(deps, job.data), {
    ...base,
    concurrency: generateConcurrency,
    // 令牌桶，防瞬时打爆
    limiter: { max: 32, duration: 1000 },
  }),

  new Worker(QUEUE.poll, (job) => handlePoll(deps, job.data), {
    ...base,
    concurrency: globalConcurrency,
  }),

  // IO 密集，可以比生成高得多
  new Worker(
    QUEUE.ingest,
    (job) =>
      handleIngest(
        {
          db,
          storage,
          // 取产物可能要鉴权（OpenRouter 的 unsigned_urls 要 Authorization）。
          // 不传这个池子的话下载一直 401，而钱已经花了
          providers,
          // 断掉这条回调，镜头会永远停在 generating
          onTakeAccepted: (shotId, takeId) =>
            applyShotTransition({ db, queues, providers, maxAttempts: 4 }, shotId, {
              type: 'take.accepted',
              takeId,
            }),
        },
        job.data,
      ),
    {
      ...base,
      concurrency: 20,
    },
  ),

  // 把状态事件转成 Redis pub/sub，SSE 端从那里转发给浏览器
  new Worker(
    QUEUE.notify,
    async (job) => {
      const payload = (job.data as { payload?: unknown }).payload
      if (payload) await publishEvent(pub, payload as Parameters<typeof publishEvent>[1])
    },
    { ...base, concurrency: 10 },
  ),
]

for (const w of workers) {
  w.on('failed', (job, err) => {
    console.error(`[${w.name}] job ${job?.id} 失败:`, err.message)
    /*
     * **ingest 用尽重试之后要落库。**
     *
     * 此前它只往 stdout 写一行：`generation_jobs` 永远停在 `downloading`、
     * 镜头永远停在 `generating`、面板永远转圈——而**钱已经花了**。
     * 真钱实测撞到的正是这个：产物 401，面板上什么都看不出来。
     *
     * `attemptsMade >= 上限` 才算终结，中途那几次重试不该把行改脏。
     */
    if (w.name === QUEUE.ingest && job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void failIngest(db, (job.data as { generationJobId?: string }).generationJobId, err.message)
    }
  })
}

console.log(`worker 就绪：${workers.map((w) => w.name).join(' / ')}`)

/** 优雅退出：停止接新任务，等在途完成（09-python-worker.md §7 同一原则） */
async function shutdown(): Promise<void> {
  console.log('收到退出信号，等待在途任务…')
  await Promise.all(workers.map((w) => w.close()))
  await queues.close()
  redis.disconnect()
  pub.disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

/**
 * ingest 彻底失败：把 `generation_jobs` 从 `downloading` 推到 `failed`，
 * 并把镜头交还给人。
 *
 * 用契约里现成的 `download_failed`（注释写着「产物已生成，只是没搬回来」）。
 * 它**在 `RETRYABLE` 白名单里**，所以镜头回到 `ready` 等人再点，而不是判死。
 *
 * ⚠️ 这对「网络抖了一下」是对的，对「鉴权配错了」是错的——后者再点一次会
 * **再花一次钱**拿到同一个 401。所以 `failureDetail` 必须把原因说全，让人在
 * 点之前看得见。真要按原因分流，那是给 `download_failed` 再拆一个不可重试的
 * 兄弟码，不是现在做的事。
 *
 * 这里不退款也不删 job：钱确实花了，Ledger 不说谎（约束 C4）。
 */
async function failIngest(db: Db, generationJobId: string | undefined, detail: string): Promise<void> {
  if (!generationJobId) return
  try {
    const [row] = await db
      .update(s.generationJobs)
      .set({
        status: 'failed',
        failureCode: 'download_failed',
        failureDetail: detail.slice(0, 500),
      })
      .where(
        and(
          eq(s.generationJobs.id, generationJobId),
          // 终态守卫：迟到的失败不该改写已经结算的行
          notInArray(s.generationJobs.status, [...TERMINAL_JOB_STATUSES]),
        ),
      )
      .returning({ shotId: s.generationJobs.shotId })
    if (!row) return
    await applyShotTransition({ db, queues, providers, maxAttempts: 4 }, row.shotId, {
      type: 'attempt.failed',
      code: 'download_failed',
    })
  } catch (e) {
    console.error('[ingest] 落库失败状态时又失败了:', e)
  }
}
