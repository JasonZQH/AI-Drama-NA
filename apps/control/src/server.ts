import Fastify from 'fastify'
import { createDb } from './db/client.js'

/**
 * 控制面：唯一拥有 Postgres 写权限的进程（ADR-0003 单写者）。
 * M0 只起骨架与健康检查；路由在后续 PR 加。
 */
export function buildServer(deps: { db: ReturnType<typeof createDb> }) {
  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } })

  app.get('/health', async () => {
    // 探活要真的碰一下库——只回 {ok:true} 的健康检查在数据库挂掉时依然是绿的
    await deps.db.client`SELECT 1`
    return { ok: true, service: 'control' }
  })

  return app
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')

if (isEntrypoint) {
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('DATABASE_URL 未设置')

  const deps = { db: createDb(url) }
  const app = buildServer(deps)
  const port = Number(process.env['CONTROL_PORT'] ?? 4000)

  app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
    app.log.error(err)
    process.exit(1)
  })
}
