import { describe, expect, it } from 'vitest'
import { isLoopback } from './vitest.setup.js'

/**
 * 守卫自己的守卫。
 *
 * 出网拦截是一条 monkeypatch，坏掉的方式很安静：patch 没装上、host 解析走错
 * 分支、或者哪天有人把 setupFiles 删了——三种都不会让任何用例变红，而代价要
 * 到云适配器注册进契约套件、CI 开始悄悄计费时才被发现。
 */
describe('测试车道出网拦截', () => {
  const enabled = process.env['RECORD'] !== '1'

  it.runIf(enabled)('拦下非 loopback 的出站连接', async () => {
    const err: unknown = await fetch('https://example.com').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err, 'fetch 竟然成功了——拦截没装上').not.toBeNull()
    // undici 把底层错误包成 'fetch failed'，真正的原因在 cause 里。
    // 只断言「rejects」不够：网络本来就不通时也 reject，那样这条永远绿。
    const chain = [err, (err as { cause?: unknown }).cause].map(String).join(' | ')
    expect(chain).toMatch(/禁止出网/)
  })

  it('loopback 判定：容器都在 localhost，不能误伤集成车道', () => {
    for (const h of ['localhost', '127.0.0.1', '127.0.0.53', '::1']) expect(isLoopback(h)).toBe(true)
    for (const h of ['example.com', 'openrouter.ai', '1.2.3.4', '10.0.0.1']) {
      expect(isLoopback(h)).toBe(false)
    }
  })
})
