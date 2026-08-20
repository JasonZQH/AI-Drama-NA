import type IORedis from 'ioredis'
import type { VideoProvider } from '@ai-drama/contracts'
import type { Db } from '../db/client.js'
import { ENV_VAR, resolveKey } from '../credentials/store.js'
import { buildProviderPool } from './registry.js'

/**
 * 可热更新的 provider 池（PR-E）。
 *
 * PR-D 把密钥搬进了库，但 `buildProviderPool()` 在 `server.ts` 与 `worker.ts`
 * 里各建一次、**都在开机时**——所以面板里存完 key 之后视频链路要重启两个进程
 * 才认。这个类把「重建」变成一次调用。
 *
 * ## 数组引用不变，只换内容
 *
 * `providers` 这个数组**从头到尾是同一个对象**，refresh 只是原地清空再填。
 * 于是 `ApiDeps` / `TransitionDeps` / `OrchestratorDeps` 三个接口、以及全部
 * 调用点一行都不用改——它们本来就是「用的时候才读」：
 *
 * - `routeProvider(deps.providers, …)`（applyTransition）
 * - `resolveProvider(deps.providers, id)`（orchestrator）
 * - `deps.providers[0]`（generate-batch 的 dryRun）
 *
 * ponytail: 稳定引用 + 可变内容。代价是「这个数组会在你脚下变」不写出来没人
 * 猜得到，所以这段注释就是它的说明书。真需要不可变语义时，把三个接口的
 * `providers` 改成 `() => readonly VideoProvider[]` 的 thunk——那是更大的 diff，
 * 但每个调用点会显式地表达「我现在要读一次」。
 */
export class LivePool {
  /** **稳定引用。** 拿去传给各 deps，内容由 refresh 原地替换 */
  readonly providers: VideoProvider[] = []

  constructor(
    private readonly db: Db,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * 按库里的密钥重建池子。
   *
   * 密钥经 `resolveKey`（库优先、`.env` 回落）取出来之后**注入一份 env 副本**
   * 再交给 `buildProviderPool`——那个函数保持同步、纯粹、只认 env，这样它原有的
   * 单测一条都不用改。
   *
   * 不需要在 `key === null` 时把 env 里那一项摘掉：`resolveKey` **自己就会回落
   * 到 `env[ENV_VAR]`**，所以它返回 null 就意味着那里也没有。第一版写了一个
   * `else delete env[...]` 的分支，变异测试把它删掉之后一条用例都没红——因为它
   * provably 走不到。
   */
  async refresh(): Promise<readonly string[]> {
    const key = await resolveKey(this.db, 'openrouter', this.env)
    const env = key ? { ...this.env, [ENV_VAR.openrouter]: key } : this.env

    const next = buildProviderPool(env)
    this.providers.length = 0
    this.providers.push(...next)
    return this.providers.map((p) => p.id)
  }
}

/**
 * 跨进程失效通知。
 *
 * **单开一个频道，不复用 `studio:events`。** 那条是给浏览器的 SSE 用的、
 * 有一个受契约约束的事件联合类型；往里塞一个只有服务端进程关心的内部信号，
 * 等于让每个浏览器标签都收到一条它看不懂的消息，也让契约多一个零消费者的成员
 * （PR-2 刚删掉三个那样的）。
 */
export const PROVIDERS_CHANNEL = 'studio:providers-changed'

export function publishProvidersChanged(redis: IORedis): Promise<number> {
  return redis.publish(PROVIDERS_CHANNEL, '1')
}

/**
 * 订阅并在收到通知时重建池子。返回取消订阅的函数。
 *
 * `ioredis` 的连接一旦进入 subscribe 模式就不能再跑普通命令，所以这里必须用
 * 一条**专用连接**（与 `sse.ts` 每个 SSE 连接一个订阅者是同一条约束）。
 */
export async function subscribeProviderChanges(
  sub: IORedis,
  pool: LivePool,
  /** 重建成功时回调，拿到新的 id 列表。两个进程都用它打一行日志——不打的话
   *  「worker 到底跟上没有」是不可观测的，而这正是这套机制唯一要证明的事 */
  onRefreshed: (ids: readonly string[]) => void = () => {},
  onError: (e: unknown) => void = () => {},
): Promise<() => Promise<void>> {
  await sub.subscribe(PROVIDERS_CHANNEL)
  const handler = (channel: string): void => {
    if (channel !== PROVIDERS_CHANNEL) return
    void pool.refresh().then(onRefreshed).catch(onError)
  }
  sub.on('message', handler)
  return async () => {
    sub.off('message', handler)
    await sub.unsubscribe(PROVIDERS_CHANNEL)
  }
}
