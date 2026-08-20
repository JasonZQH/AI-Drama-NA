import cors from '@fastify/cors'
import type IORedis from 'ioredis'
import Fastify, { type FastifyInstance } from 'fastify'
import { createDb } from './db/client.js'
import { buildProviderPool } from './providers/registry.js'
import { registerApi, type ApiDeps } from './routes/api.js'
import { registerErrorHandler } from './routes/errors.js'
import { registerSse } from './routes/sse.js'
import { registerStats } from './routes/stats.js'
import { createConnection, createQueues } from './queue/queues.js'
import { reconcileOnBoot } from './queue/orchestrator.js'
import { httpMediaWorker } from './pipeline/render.js'
import { Storage, storageFromEnv } from './storage/s3.js'

/**
 * 控制面：唯一拥有 Postgres 写权限的进程（ADR-0003 单写者）。
 */
export interface ServerDeps extends ApiDeps {
  /** 探活要真的碰一下库，不能只回 {ok:true} */
  readonly healthProbe: () => Promise<unknown>
  /** 每个 SSE 连接一个订阅者：ioredis 进入 subscribe 模式后不能再跑普通命令 */
  readonly makeSubscriber: () => IORedis
  /** 变更请求（非 GET）必须带 `x-api-key` 匹配它。见 guardWrites 的注释 */
  readonly apiKey: string
}

/**
 * 写路径闸门。**这是防「任意网页替你花钱」的那一道**。
 *
 * 攻击是实测走通过的：一个无 body、无 Content-Type 的
 * `POST /api/episodes/:id/generate-batch` 就能规划整集（202，11 镜，$0.77 预估）。
 *
 * 为什么 CORS 修不了它：CORS 管的是「JS 能不能读响应」，不是「请求发不发得出去」。
 * 上面那种请求是 **简单请求**——浏览器直接发，`no-cors` 下响应虽读不到，
 * 但服务端早就执行完了，钱已经花掉。把 origin 收成单一来源也拦不住这条。
 * 而它之所以是简单请求，是因为 `/generate` 压根不读 body（routes/api.ts），
 * `generate-batch` 的 `req.body ?? {}` 又让 `dryRun` 取默认值 false——直接真花钱。
 *
 * 唯一同时堵住它的是**要求一个自定义头**：自定义头强制浏览器先发预检，
 * 而预检会带上 Origin；配合收紧后的 CORS，恶意页面的预检过不了，
 * 真实请求根本不会发出。头的值是不是秘密，在默认配置下反而是次要的。
 *
 * **刻意只挡非 GET。** SSE 走 `EventSource`（apps/web/lib/events.tsx），
 * 浏览器 API 不支持自定义头，护 GET 会直接打断实时进度流。钱的边界全在
 * 非 GET 上，这一刀切在收益最高处。要连读也堵，得把 token 挪进 query param。
 *
 * OPTIONS 必须放行——那是 CORS 预检本身，挡掉它等于把合法前端也一起挡了。
 */
function guardWrites(app: FastifyInstance, apiKey: string): void {
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'OPTIONS') return
    if (req.headers['x-api-key'] === apiKey) return
    await reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '变更请求需要正确的 x-api-key' } })
  })
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
  })

  /*
   * origin 默认仍是 true（反射任意来源），因为开发时 Next 在 :3000、控制面在
   * :4000，本来就跨源，而端口是可配的。收紧要靠显式设 WEB_ORIGIN。
   *
   * 它不是钱的闸门（见 guardWrites），但它决定攻击是「盲打」还是「精确制导」：
   * origin: true 让 GET 响应跨域可读，恶意页面能先枚举出 project/episode/shot
   * 的 UUID 再开火。设了 WEB_ORIGIN 就只剩猜 UUID，不可行。
   */
  /*
   * `methods` 必须显式列全。不给的话 @fastify/cors 的默认值实测只有
   * `GET,HEAD,POST`——于是往这个 API 加任何别的方法，浏览器侧都是**静默坏的**：
   * 预检 204 通过、`access-control-allow-methods` 里没有它、真实请求根本不发出，
   * 服务端日志上一片干净，只有浏览器控制台里有一行 CORS 报错。
   *
   * P1 加 PATCH 时就踩了：端点写完、集成测试全绿（inject 不走 CORS）、
   * 面板上点保存却什么都没发生。
   */
  void app.register(cors, {
    origin: process.env['WEB_ORIGIN'] ?? true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-api-key'],
  })
  guardWrites(app, deps.apiKey)
  registerErrorHandler(app)

  app.get('/health', async () => {
    // 探活要真的碰一下库——只回 {ok:true} 的健康检查在数据库挂掉时依然是绿的
    await deps.healthProbe()
    return { ok: true, service: 'control' }
  })

  registerApi(app, deps)
  registerStats(app, deps)
  registerSse(app, { redisUrl: '', makeSubscriber: deps.makeSubscriber })

  return app
}

export async function main(): Promise<void> {
  const dbUrl = process.env['DATABASE_URL']
  const redisUrl = process.env['REDIS_URL']
  if (!dbUrl || !redisUrl) throw new Error('DATABASE_URL / REDIS_URL 未设置')

  /*
   * **必须 fail-fast，不能写成「设了才校验」。**
   *
   * 后者的默认配置仍然是全开，而全开正是这道闸门要防的场景——一个安全开关
   * 如果忘了配就自动失效，那它防的只是记得配的人。宁可起不来。
   */
  const apiKey = process.env['CONTROL_API_KEY']
  if (!apiKey) {
    throw new Error(
      'CONTROL_API_KEY 未设置。变更请求需要它才能通过（见 server.ts 的 guardWrites）；' +
        '本地开发在根 .env 里写一个任意值即可，例如 CONTROL_API_KEY=devlocal',
    )
  }

  const { db, client } = createDb(dbUrl)
  const queues = createQueues({ url: redisUrl })
  const storage = new Storage(storageFromEnv())
  const providers = buildProviderPool()
  const redis = createConnection(redisUrl)

  const app = buildServer({
    db,
    queues,
    storage,
    media: httpMediaWorker(process.env['MEDIA_WORKER_URL'] ?? 'http://localhost:8002'),
    providers,
    maxAttempts: 4,
    healthProbe: () => client`SELECT 1`,
    makeSubscriber: () => createConnection(redisUrl),
    apiKey,
  })

  // 重启时把非终态任务捞回来（05 §8）。幂等是这套逻辑成立的前提
  const r = await reconcileOnBoot({ db, redis, queues, providers, maxAttempts: 4 })
  app.log.info({ reconcile: r }, '崩溃恢复完成')

  /*
   * 默认只听 127.0.0.1。原本是 0.0.0.0，把攻击面从「开发机自己的浏览器」
   * 扩大到了「同一个局域网上的任何设备」——而这台机器上有能真花钱的凭证。
   * 要从手机或别的机器访问，显式设 CONTROL_HOST=0.0.0.0，那时 x-api-key
   * 的值才真正承担秘密的职责。
   */
  const port = Number(process.env['CONTROL_PORT'] ?? 4000)
  await app.listen({ port, host: process.env['CONTROL_HOST'] ?? '127.0.0.1' })
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
