import type { VideoProvider } from '@ai-drama/contracts'
import { MockProvider } from './mock.js'
import { OpenRouterProvider } from './openrouter.js'

/**
 * Provider 池（04-provider-adapter.md §6）。
 *
 * `.env` 里没配的 provider 自动不进池子——没有 `OPENROUTER_API_KEY` 时
 * `poolFromEnv` 返回空数组，于是「Mac 上无 GPU 无 key 跑通全链路」照旧成立。
 * 自部署在 M2（`adr/0012`）。
 *
 * **池的单位是 `(provider, model)`**：`OPENROUTER_VIDEO_MODELS` 里每个 model
 * 一个条目，id 形如 `openrouter:google/veo-3.1-lite`。成本归因按 model 切
 * （`gj_analytics_idx` 就是按 `(provider_id, model_id)` 建的），合成一个条目
 * 就没法回答「哪个模型的每可用镜头成本更低」——而那是选型的核心问题。
 *
 * 池是**有序的**：路由器在没有 `providerHint`、也没有失败历史可规避时取第一个。
 * `DEFAULT_PROVIDER` 决定谁排第一。
 */
export function buildProviderPool(env: NodeJS.ProcessEnv = process.env): VideoProvider[] {
  const pool: VideoProvider[] = [MockProvider.fromEnv(env), ...OpenRouterProvider.poolFromEnv(env)]

  /*
   * `DEFAULT_PROVIDER` 此前是**死配置**：`.env.example` 与四份文档里都有它，
   * registry 的注释还写着它「强制指定，避免误刷云账单」——而全仓没有一行代码读它。
   * 池子里出现第一个云 provider 的那一刻，那句注释就从「描述不存在的行为」
   * 变成真实的花钱风险。
   *
   * 现在的语义很窄，也只该这么窄：**把它排到第一位**。它不是白名单
   * （那会让人以为设了它就绝对不会用别家，而 providerHint 仍然可以覆盖），
   * 只是「没有别的信号时用谁」。
   */
  const preferred = env['DEFAULT_PROVIDER']
  if (preferred) {
    const i = pool.findIndex((p) => p.id === preferred)
    if (i > 0) pool.unshift(...pool.splice(i, 1))
  }

  return pool
}

/**
 * 按 id 取回实例。**全系统只此一处**——此前 orchestrator 里另有一份
 * `providers.find(x => x.id === id)`，两套查找各自演化是迟早的事。
 *
 * 崩溃恢复与轮询都靠它：`generation_jobs.provider_id` 记的是「当时选了谁」，
 * 重放时必须拿回同一个实例，否则会拿别家的 poll 去问这家的任务。
 */
export function resolveProvider(pool: readonly VideoProvider[], id: string): VideoProvider | undefined {
  return pool.find((p) => p.id === id)
}
