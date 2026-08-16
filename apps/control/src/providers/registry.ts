import type { VideoProvider } from '@ai-drama/contracts'
import { MockProvider } from './mock.js'

/**
 * Provider 池（04-provider-adapter.md §6）。
 *
 * `.env` 里没配的 provider 自动不进池子。开发默认只有 mock，
 * `DEFAULT_PROVIDER=mock` 强制指定，避免误刷云账单。
 *
 * 云 provider（Vidu / Kling / Jimeng）与 SelfHost 在 M1 / M2 接入——
 * 现在不建空的适配器类，没有实现的脚手架只会假装这里已经支持了。
 */
export function buildProviderPool(env: NodeJS.ProcessEnv = process.env): VideoProvider[] {
  return [MockProvider.fromEnv(env)]
}

export function resolveProvider(pool: VideoProvider[], id: string): VideoProvider | undefined {
  return pool.find((p) => p.id === id)
}
