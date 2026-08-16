import type IORedis from 'ioredis'

/**
 * Provider 级并发信号量（05-job-orchestration.md §3 第 ② 层）。
 *
 * 三层限流里，全局闸门与项目配额可以用 BullMQ 的 concurrency 实现，
 * 但 **provider 配额必须跨进程有效**——同一个 vidu 配额要被所有 worker
 * 进程共享，否则起两个 worker 就等于把配额翻倍，直接触发对方限流。
 *
 * 用 Redis 计数器 + TTL 兜底：持有者崩溃时槽位靠 TTL 自动归还，
 * 不会永久泄漏。TTL 要显著长于单次生成耗时（几十秒到几分钟）。
 */

const SLOT_TTL_SEC = 900 // 15 分钟，远长于最慢的一次生成

function key(providerId: string): string {
  return `sem:provider:${providerId}`
}

/**
 * 尝试占一个槽位。拿不到返回 false，调用方应稍后重排而不是阻塞——
 * 阻塞会占住 BullMQ 的 worker 槽位，那是 §7.5 明确要避免的。
 */
export async function tryAcquire(redis: IORedis, providerId: string, limit: number): Promise<boolean> {
  const k = key(providerId)
  const n = await redis.incr(k)
  if (n === 1) await redis.expire(k, SLOT_TTL_SEC)
  if (n <= limit) return true
  await redis.decr(k) // 超了立刻还回去
  return false
}

export async function release(redis: IORedis, providerId: string): Promise<void> {
  const k = key(providerId)
  // 用 Lua 保证不会减到负数：重复 release 或 TTL 已过期时计数可能已是 0
  await redis.eval(
    `local n = tonumber(redis.call('GET', KEYS[1]) or '0')
     if n > 0 then return redis.call('DECR', KEYS[1]) end
     return 0`,
    1,
    k,
  )
}

export async function inFlight(redis: IORedis, providerId: string): Promise<number> {
  return Number((await redis.get(key(providerId))) ?? 0)
}

/** 测试与运维用：把某个 provider 的计数清零 */
export async function reset(redis: IORedis, providerId: string): Promise<void> {
  await redis.del(key(providerId))
}
