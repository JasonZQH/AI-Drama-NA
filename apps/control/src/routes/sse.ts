import type { StudioEvent } from '@ai-drama/contracts'
import type { FastifyInstance } from 'fastify'
import type IORedis from 'ioredis'

/**
 * 实时进度（05-job-orchestration.md §7、06-api-spec.md §7）。
 *
 * 选 SSE 不选 WebSocket：进度是**单向广播**，SSE 够用且天然支持断线重连
 * 与 HTTP/2 多路复用，不需要维护双向连接的状态机。有交互需求（协同编辑）
 * 时再上 WS 不迟。
 */

export const EVENT_CHANNEL = 'studio:events'

/** 节流窗口：每个 job 的进度最多 1 秒 1 条，避免几十个任务同时刷把浏览器打爆 */
const PROGRESS_THROTTLE_MS = 1000

/** 中间层（Next.js dev 代理、反代）会因为长时间无字节而断连 */
const KEEPALIVE_MS = 20_000

export function publishEvent(redis: IORedis, event: StudioEvent): Promise<number> {
  return redis.publish(EVENT_CHANNEL, JSON.stringify(event))
}

/**
 * 服务端合并进度事件后再发。节流只作用于 job.progress——
 * 状态跃迁和错误必须逐条送达，丢一条 UI 就永远停在错的状态上。
 */
export function createThrottle(): (e: StudioEvent) => boolean {
  const lastSent = new Map<string, number>()
  return (e) => {
    if (e.type !== 'job.progress') return true
    const now = Date.now()
    const prev = lastSent.get(e.jobId) ?? 0
    if (now - prev < PROGRESS_THROTTLE_MS) return false
    lastSent.set(e.jobId, now)
    return true
  }
}

export function registerSse(
  app: FastifyInstance,
  deps: { redisUrl: string; makeSubscriber: () => IORedis },
): void {
  app.get('/api/projects/:id/events', async (req, reply) => {
    /**
     * CORS 头必须在这里手写。
     *
     * 直接 writeHead 到 reply.raw 会绕过 Fastify 的 reply 对象，于是
     * @fastify/cors 的 onSend 钩子根本没机会加 Access-Control-Allow-Origin。
     * curl 不校验 CORS，所以这个 bug 只有真用浏览器打开才会暴露。
     */
    const origin = req.headers.origin
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关掉 nginx 类中间层的缓冲，否则事件会被攒着不发
      'X-Accel-Buffering': 'no',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    })
    // writeHead 只设置响应头，Node 要等到有实际写入才发送——不 flush 的话
    // 客户端的 onopen 永远不触发，连接看起来像挂死。这是 SSE 的经典坑。
    reply.raw.flushHeaders()
    reply.raw.write(': connected\n\n')

    // 每个连接一个订阅者：ioredis 的连接进入 subscribe 模式后不能再跑普通命令
    const sub = deps.makeSubscriber()
    const shouldSend = createThrottle()

    await sub.subscribe(EVENT_CHANNEL)
    sub.on('message', (_ch, raw) => {
      try {
        const event = JSON.parse(raw) as StudioEvent
        if (!shouldSend(event)) return
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        // 单条坏消息不该拖垮整个连接
      }
    })

    const keepalive = setInterval(() => reply.raw.write(': keepalive\n\n'), KEEPALIVE_MS)

    const cleanup = (): void => {
      clearInterval(keepalive)
      void sub.quit()
    }
    req.raw.on('close', cleanup)
    reply.raw.on('error', cleanup)

    // 让 Fastify 知道响应由我们自己接管
    return reply
  })
}
