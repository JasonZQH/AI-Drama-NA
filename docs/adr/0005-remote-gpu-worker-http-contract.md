# ADR-0005 · GPU Worker 用 HTTP 契约而非共享队列

- **状态**：已接受
- **日期**：2026-08-10
- **相关**：`09-python-worker.md`

## 背景

Python 生成 worker 运行在远程 GPU 机器上，需要与 Mac 上的 TypeScript 控制面通信。有两种主流做法：让 worker 直接消费同一个 Redis 队列，或者定义 HTTP 接口由控制面调用。

## 决策

**定义 HTTP Worker Contract（`/v1/generate`、`/v1/jobs/{id}`、`/v1/health` 等），控制面作为客户端调用。worker 不连 Redis，不连 Postgres。**

## 理由

**网络边界更干净。** GPU 机器可能在云上、在办公室、在朋友的机器上。让它连 Redis 意味着要暴露 Redis 端口或建立复杂的隧道，而 Redis 默认没有强认证。HTTP 只需要一个端口，且天然适合放在 Tailscale 私有网络里。

**worker 保持无状态无依赖。** 它不需要知道 Project/Shot/Episode 的存在，不需要数据库凭证。这让它可以被独立部署、独立测试、随时用 mock 引擎替换。安全上也更好——GPU 机器被攻破不会直接暴露业务数据库。

**统一了云 API 与自部署的形态。** `SelfHostProvider` 和 `ViduProvider` 在控制面眼里是同一个接口的两个实现，都是「提交 → 轮询 → 拿结果」。如果自部署走队列而云 API 走 HTTP，适配器层就要处理两种截然不同的模式。

**多 worker 扩展简单**：起第二台 GPU 就是加一个 URL 到 provider 池。

## 备选与否决理由

| 方案 | 否决原因 |
|---|---|
| worker 直连 Redis 队列 | 需暴露 Redis；worker 要懂业务模型；跨网络认证复杂 |
| gRPC | 二进制协议调试成本高；此处 QPS 极低，性能优势无意义 |
| worker 直连 Postgres | 违反单一写者原则；GPU 机器持有数据库凭证是安全风险 |
| 消息队列（RabbitMQ/NATS） | 又一个要运维的服务，收益不足以抵消复杂度 |

## 后果

**正面**：网络与安全边界清晰；worker 可独立部署与 mock；与云 provider 形态统一。
**负面**：需要轮询（多数 provider 不支持 webhook，本地开发也收不到公网回调）；控制面需承担重试与超时逻辑。
**缓解**：自重排的延时轮询任务，避免为每个任务开常驻循环（`05-job-orchestration.md` §4）；worker 侧 `/v1/health` 暴露队列深度与显存，让控制面做容量感知调度。
