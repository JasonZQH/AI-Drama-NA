import { defineConfig } from 'vitest/config'

/**
 * 让测试进程看得见仓库根的 `.env`。
 *
 * **这不是便利，是修一个 works-on-my-machine 的洞。** 集成测试连库时的兜底
 * 值原本是硬编码的，vitest 又不像 `node --env-file-if-exists` 那样读 `.env`
 * （实测：探针变量在测试里是 `undefined`）。于是 `pnpm test:int` 能不能跑，
 * 取决于硬编码值是否恰好等于这台机器的端口——在开发机上它碰巧相等，所以
 * 一直是绿的；全新 clone 按 README 起的 Postgres 在另一个端口，必然连不上。
 *
 * CI 之所以从没暴露这件事，是因为 workflow 里显式注入了 `DATABASE_URL`，
 * 兜底分支从未被执行过。
 *
 * `process.loadEnvFile` 是 Node 20.12+ 的内置能力，不引入 dotenv 依赖。
 * 已存在的环境变量优先级更高——CI 的显式注入仍然覆盖 `.env`。
 */
try {
  process.loadEnvFile('.env')
} catch {
  // 没有 .env 是正常的（CI 就没有）。此时用进程环境里已有的值
}

/**
 * 上面那句把整个 `.env` 灌进测试进程，**包括会计费的 API key**。
 *
 * 这不是假设的风险：`buildProviderPool(env = process.env)` 的默认参数就是
 * `process.env`，任何走默认路径的构造都会拿到一个真实计费的适配器。而
 * `pnpm test` 恰恰是 CI 里最便宜、不起容器、也没有任何出网限制的那条车道。
 * OpenRouter 尤其危险——一把 key 解锁全部视频模型。
 *
 * 所以默认把它们摘掉。只有显式 `RECORD=1`（录制卡带那一次）才放行，
 * 那是唯一应该真的花钱的场景。
 */
if (process.env['RECORD'] !== '1') {
  for (const k of Object.keys(process.env)) {
    if (/_API_KEY$/.test(k)) delete process.env[k]
  }
}

export default defineConfig({
  // 摘掉 key 只挡住「用配好的 key 花钱」；出网拦截挡的是写死的 key、名字不同的
  // 变量、以及本该零 IO 的 validate() 偷发请求。理由见 vitest.setup.ts
  test: { setupFiles: ['./vitest.setup.ts'] },
})
