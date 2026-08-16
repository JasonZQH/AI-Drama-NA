import cors from '@fastify/cors'
import type IORedis from 'ioredis'
import Fastify, { type FastifyInstance } from 'fastify'
import { createDb } from './db/client.js'
import { buildProviderPool } from './providers/registry.js'
import { registerApi, type ApiDeps } from './routes/api.js'
import { registerErrorHandler } from './routes/errors.js'
import { registerSse } from './routes/sse.js'
import { createConnection, createQueues } from './queue/queues.js'
import { reconcileOnBoot } from './queue/orchestrator.js'
import { Storage, storageFromEnv } from './storage/s3.js'

/**
 * 控制面：唯一拥有 Postgres 写权限的进程（ADR-0003 单写者）。
 */
export interface ServerDeps extends ApiDeps {
  /** 探活要真的碰一下库，不能只回 {ok:true} */
  readonly healthProbe: () => Promise<unknown>
  /** 每个 SSE 连接一个订阅者：ioredis 进入 subscribe 模式后不能再跑普通命令 */
  readonly makeSubscriber: () => IORedis
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
  })

  void app.register(cors, { origin: true })
  registerErrorHandler(app)

  app.get('/health', async () => {
    // 探活要真的碰一下库——只回 {ok:true} 的健康检查在数据库挂掉时依然是绿的
    await deps.healthProbe()
    return { ok: true, service: 'control' }
  })

  registerApi(app, deps)
  registerSse(app, { redisUrl: '', makeSubscriber: deps.makeSubscriber })

  return app
}

export async function main(): Promise<void> {
  const dbUrl = process.env['DATABASE_URL']
  const redisUrl = process.env['REDIS_URL']
  if (!dbUrl || !redisUrl) throw new Error('DATABASE_URL / REDIS_URL 未设置')

  const { db, client } = createDb(dbUrl)
  const queues = createQueues({ url: redisUrl })
  const storage = new Storage(storageFromEnv())
  const providers = buildProviderPool()
  const redis = createConnection(redisUrl)

  const app = buildServer({
    db,
    queues,
    storage,
    providers,
    maxAttempts: 4,
    healthProbe: () => client`SELECT 1`,
    makeSubscriber: () => createConnection(redisUrl),
  })

  // 重启时把非终态任务捞回来（05 §8）。幂等是这套逻辑成立的前提
  const r = await reconcileOnBoot({ db, redis, queues, providers, maxAttempts: 4 })
  app.log.info({ reconcile: r }, '崩溃恢复完成')

  const port = Number(process.env['CONTROL_PORT'] ?? 4000)
  await app.listen({ port, host: '0.0.0.0' })
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
