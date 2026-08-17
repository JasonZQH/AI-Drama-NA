import net from 'node:net'

/**
 * **测试车道禁止出网。**
 *
 * `vitest.config.ts` 已经把 `*_API_KEY` 从环境里摘掉了，但那只挡住「用配好的
 * key 花钱」，挡不住：写死在代码里的 key、名字不叫 `_API_KEY` 的变量
 * （`OPENROUTER_TOKEN`）、以及一个本该零 IO 的 `validate()` 偷偷发请求。
 * 而 `pnpm test` 是 CI 里最便宜的一条车道——不起容器、此前也没有任何出网限制，
 * 云适配器注册进契约套件的那一刻，它就是最可能悄悄计费的地方。
 *
 * 拦在 `net.Socket.prototype.connect` 而不是 undici 的 MockAgent：MockAgent
 * 只拦 undici / 全局 `fetch`，而 `@aws-sdk/client-s3` 走 `node:http`、
 * `postgres` 和 `ioredis` 走裸 `net`——那三个会被静默放行，恰好是集成测试里
 * 唯一真正建立连接的三个。`net` 这一层一次盖住全部，且不引入任何依赖。
 *
 * 放行 loopback：集成车道连的 Postgres / Redis / MinIO 都在 localhost
 * （CI 的 workflow 显式注入的也是 localhost）。unix socket 一并放行。
 *
 * `RECORD=1` 整个关掉——录制卡带那一次是唯一应该真的出网的场景。
 */

const LOOPBACK = new Set(['localhost', '::1', '::ffff:127.0.0.1'])

/** @returns 要检查的主机名；null = 不是 TCP（unix socket），直接放行 */
function hostOf(args: readonly unknown[]): string | null {
  const first = args[0]
  // connect(path, cb) —— unix socket
  if (typeof first === 'string') return null
  // connect(port, host?, cb?)
  if (typeof first === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost'
  if (typeof first === 'object' && first !== null) {
    const o = first as { host?: unknown; path?: unknown }
    if (typeof o.path === 'string') return null
    return typeof o.host === 'string' ? o.host : 'localhost'
  }
  return 'localhost'
}

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host)
}

if (process.env['RECORD'] !== '1') {
  const original = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const host = hostOf(args)
    if (host !== null && !isLoopback(host)) {
      throw new Error(
        `测试车道禁止出网：${host}。真 provider 的调用要么用录制回放，要么加 RECORD=1 显式放行（那一次会真的花钱）。`,
      )
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args)
  } as typeof net.Socket.prototype.connect
}
