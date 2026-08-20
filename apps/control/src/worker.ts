import { Worker } from 'bullmq'
import { createDb } from './db/client.js'
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

const workers = [
  new Worker(QUEUE.generate, (job) => handleGenerate(deps, job.data), {
    ...base,
    concurrency: globalConcurrency,
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
