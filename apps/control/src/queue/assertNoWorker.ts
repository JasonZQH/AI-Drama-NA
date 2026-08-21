import type { Queues } from './queues.js'

/**
 * 集成测试的前置条件：**没有 worker 在跑**。
 *
 * 有 worker 连着的话，测试入队的任务会被它**立刻消费掉**，于是断言「队列里有
 * 这条」全部失败——而失败信息是 `expected false to be true`，看不出任何线索。
 *
 * 实测撞到过：开着 `pnpm dev`（它同时起控制面与 worker）跑 `pnpm test:int`，
 * 三条用例红，其中一条是 BullMQ 的金丝雀，看起来像原生模块坏了。
 *
 * 这个前提此前只写在对话里，代码与文档里一个字都没有。现在让它自己说话。
 */
export async function assertNoWorker(queues: Queues): Promise<void> {
  const workers = await queues.generate.getWorkers()
  if (workers.length === 0) return
  throw new Error(
    `有 ${workers.length} 个 worker 连在 Redis 上，集成测试跑不了——它们会把测试入队的任务立刻消费掉，` +
      `失败信息会是没头没脑的「expected false to be true」。\n` +
      `先停掉 worker（在跑 pnpm dev 的话整个停掉，或只留控制面：node apps/control/dist/server.js），再重跑。`,
  )
}
