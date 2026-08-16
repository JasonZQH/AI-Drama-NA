import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq'
import IORedis from 'ioredis'

/**
 * 队列拓扑（05-job-orchestration.md §2）。
 *
 * 拆成多队列而不是一个大队列，理由是**并发度需求完全不同**：
 * q:generate 受 provider 配额约束（可能只有 4），q:ingest 是 IO 密集（可以 20），
 * q:render 是 CPU 密集（等于核数）。混在一起就只能取最小值，浪费吞吐。
 *
 * Redis 里的任务可以丢——重启后从 Postgres 的非终态记录重建（§8）。
 * 反过来不行：永远不要把价值几美元的任务状态只存在 Redis 里（ADR-0003）。
 */

/**
 * BullMQ 6 不允许队列名含 `:`（那是它自己的 key 分隔符），所以名字用裸词、
 * 命名空间走 prefix。**Redis 里看到的 key 仍然是文档写的 `q:generate:*`**，
 * 只是构造方式不同。
 */
export const QUEUE_PREFIX = 'q'

export const QUEUE = {
  generate: 'generate',
  poll: 'poll',
  ingest: 'ingest',
  eval: 'eval',
  notify: 'notify',
} as const

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE]

/**
 * `q:render` 要到 media worker 存在时才有消费者（PR 11），现在不定义——
 * 没有消费者的队列只会让人以为这里已经支持了。`q:tts` 同理，留到 M3。
 */

export interface GenerateJobData {
  readonly generationJobId: string
  readonly shotId: string
}

export interface PollJobData {
  readonly generationJobId: string
  readonly providerId: string
  readonly externalId: string
  readonly submittedAt: number
  readonly pollCount: number
}

export interface IngestJobData {
  readonly generationJobId: string
  readonly shotId: string
  readonly projectId: string
  readonly sourceUrl: string
  readonly storageKey?: string
}

export interface EvalJobData {
  readonly takeId: string
  readonly assetStorageKey: string
}

export interface NotifyJobData {
  readonly projectId: string
  readonly payload: unknown
}

/**
 * `maxRetriesPerRequest: null` 是 BullMQ 对连接的硬要求；同时把重连策略
 * 写死，避免 Redis 抖动时静默放弃（05 §7.5）。
 */
export function createConnection(url: string): IORedis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  })
}

/**
 * 基础设施重试的默认值：网络抖动、502、超时——**同参数重放是合理的**。
 * 它不增加 shots.attemptCount，也不写新的 generation_jobs 行，
 * 语义上还是同一次生成尝试（05 §5.1）。
 *
 * 与之相对的「生成质量重试」由状态机驱动，每次产生新的 job 行（§5.2）。
 * 这两者混淆是这一层最容易写错的地方。
 */
export const INFRA_RETRY: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
}

export interface Queues {
  readonly generate: Queue<GenerateJobData>
  readonly poll: Queue<PollJobData>
  readonly ingest: Queue<IngestJobData>
  readonly eval: Queue<EvalJobData>
  readonly notify: Queue<NotifyJobData>
  close(): Promise<void>
}

export function createQueues(connection: ConnectionOptions): Queues {
  const opts = { connection, prefix: QUEUE_PREFIX, defaultJobOptions: INFRA_RETRY }
  const generate = new Queue<GenerateJobData>(QUEUE.generate, opts)
  const poll = new Queue<PollJobData>(QUEUE.poll, opts)
  const ingest = new Queue<IngestJobData>(QUEUE.ingest, opts)
  const evalQ = new Queue<EvalJobData>(QUEUE.eval, opts)
  const notify = new Queue<NotifyJobData>(QUEUE.notify, opts)

  return {
    generate,
    poll,
    ingest,
    eval: evalQ,
    notify,
    async close() {
      await Promise.all([generate.close(), poll.close(), ingest.close(), evalQ.close(), notify.close()])
    },
  }
}

/**
 * 轮询退避：3s → 5s → 8s → … 上限 30s（05 §4）。
 *
 * 关键在于**不要为每个任务开常驻循环**——一集十几个镜头、多集并行就是几百个
 * 循环，Redis 连接和 CPU 都会被吃掉。改成自重排的延时任务后，同一时刻内存里
 * 没有任何挂起的循环，只有 Redis 里的延时条目。
 */
export function pollDelayMs(pollCount: number): number {
  return Math.min(3000 * Math.pow(1.4, pollCount), 30_000)
}
