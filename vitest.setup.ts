import net from 'node:net'
import { afterAll, beforeAll, expect } from 'vitest'

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

/**
 * **集成车道禁止碰夹具项目以外的数据。**
 *
 * 真实撞到过三次，一次比一次贵：
 *
 * 1. 一条 `db.delete(providerCredentials)` 把面板里存好的 key 删了；
 * 2. 夹具用 `orderBy(index).limit(1)` 跨项目挑镜头，改了别人的行；
 * 3. `api.int.test.ts` 的 cleanup 里一句 **`db.update(s.shots).set({...})` 漏了
 *    `where`**——每跑一次 `pnpm test:int`，全库每一个镜头都被抹成 `ready` /
 *    `selectedTakeId=null` / `attemptCount=0`。takes、generation_jobs、
 *    `updated_at` 全都不动，所以从数据上根本看不出是谁干的：片子还在，状态
 *    却退回了「待生成」。而 `resolveDependencies` 只看 status——用户一集
 *    $4.40 的成片就这么变成了「再点一次就重新付钱」。
 *
 * 三次都是**跑完之后**才发现，靠人肉 diff 找出来的。所以这道闸放在这里：
 * 每个 `*.int.test.ts` 跑完，对照夹具项目以外的镜头快照，变了就红。
 *
 * 只盯 `shots`：它是唯一「状态被改了但产物还在」因而肉眼看不出来的表。
 * 凭据那条已经有 stash/restore，takes/jobs 被删会直接报 FK。
 */
if (process.env['DATABASE_URL'] && expect.getState().testPath?.endsWith('.int.test.ts')) {
  const url = process.env['DATABASE_URL']
  const snap = async (): Promise<string> => {
    const pg = (await import('postgres')).default(url, { max: 1 })
    try {
      const rows = await pg`
        select sh.id, sh.status, coalesce(sh.selected_take_id::text, '-') as take, sh.attempt_count
        from shots sh
        join scenes sc on sc.id = sh.scene_id
        join episodes e on e.id = sc.episode_id
        join projects p on p.id = e.project_id
        where p.title not like 'DEMO%'
        order by sh.id`
      return rows.map((r) => `${r['id']} ${r['status']} ${r['take']} ${r['attempt_count']}`).join('\n')
    } finally {
      await pg.end()
    }
  }

  let before = ''
  beforeAll(async () => {
    before = await snap()
  })
  afterAll(async () => {
    const after = await snap()
    if (after === before) return
    const b = new Map(before.split('\n').map((l) => [l.split(' ')[0], l]))
    const changed = after
      .split('\n')
      .filter((l) => b.get(l.split(' ')[0]) !== l)
      .slice(0, 5)
    throw new Error(
      `集成测试改到了夹具项目以外的镜头（${changed.length} 行起）。` +
        `多半是某处 update/delete 漏了 where，或者夹具跨项目挑了行：\n` +
        changed.map((l) => `  now: ${l}\n  was: ${b.get(l.split(' ')[0]) ?? '(这一行是新增的)'}`).join('\n'),
    )
  })
}
