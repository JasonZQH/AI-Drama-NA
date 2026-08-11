# ADR-0010 · 跨进程用 HTTP/JSON 而非 gRPC

- **状态**：已接受
- **日期**：2026-08-11
- **相关**：ADR-0005、ADR-0009、`09-python-worker.md`

## 背景

ADR-0005 已确定 GPU worker 走 HTTP 契约而非共享队列，但对「HTTP vs gRPC」只给了一句结论。gRPC 常被认为能提供更强的边界约束与更好的跨语言代码生成，值得单独论证。

**先划清适用范围**：控制面内部的 `domain / pipeline / providers / routes` 是**同进程函数调用**，既不走 HTTP 也不走 gRPC。给同进程模块加网络协议，是用分布式的代价买本地已有的东西——失去类型安全的直接调用、完整堆栈与单步调试，换来序列化开销和一整套故障模式。模块边界的强制手段见 `01-architecture.md` §5。

因此本 ADR 只讨论一处：**控制面 ↔ Python worker**。

## 决策

**跨进程通信统一用 HTTP/JSON，不引入 gRPC。**

## 理由

**一、只覆盖三跳中的一跳，却引入第二套协议栈。**

| 跳 | 协议 | 是否可换 gRPC |
|---|---|---|
| 浏览器 ↔ 控制面 | HTTP + SSE | ❌ 浏览器不原生支持 gRPC，需 grpc-web + 代理 |
| 控制面 ↔ Python worker | HTTP | ✅ 唯一可换的一跳 |
| worker ↔ ComfyUI | HTTP/JSON（`/prompt`、`/ws`、`/history`） | ❌ ComfyUI 只说 HTTP（ADR-0006） |

结果是同一个 worker 进程里同时说两种协议。

**二、可调试性在远程 GPU 场景下权重极高。** `curl http://100.x.y.z:8001/v1/health` 在任何机器上都能跑，不需要 grpcurl、不需要本地有 proto 文件、不需要版本对齐。worker 跑在别人的机器上、跨 Tailscale、按小时收费——**出问题时能否一行命令查清楚，比协议优雅重要得多。**

**三、QPS 不是瓶颈。** gRPC 的性能优势在高频小请求。本系统是每分钟几个请求、每个耗时几十秒到几分钟、传的是 URL 而非二进制数据。序列化开销相对一次视频生成可忽略。

## 关于「proto 更利于 AI coding agent 判断边界」

这个观察的方向成立——声明式、与实现物理分离、单一用途的契约文件确实更容易被正确理解。**但 `packages/contracts` 已经在扮演这个角色，且信息密度更高。**

```ts
// zod：业务约束可读
durationSec: z.number().min(1).max(15),
mode: z.enum(['t2v','i2v','ref2v','extend']),
refImages: z.array(z.object({
  role: z.enum(['character','location','style','first_frame','last_frame']),
  url:  z.string().url(),
})).default([]),
```

```proto
// proto3：只有类型
double duration_sec = 3;
string mode = 4;                 // 取值范围？必填？未知
repeated RefImage ref_images = 5;
```

proto3 **没有 required/optional 语义**（一切皆 optional）、没有数值范围、没有字符串格式约束、没有 refinement。`z.number().min(1).max(15)` 传达的信息，`double` 一个字都没有。

补充两点：TypeScript 在编码模型中的表示质量显著高于 proto；引入 proto 会导致**三套 schema 语言**（zod → TS、JSON Schema → Python、proto → 线上），或者放弃 zod——而放弃 zod 就丢了 Fastify 依赖的运行时校验（ADR-0001）。

**结论：让边界对 agent 可读，靠的是可执行的约束而非描述性协议。** 具体四条见 `01-architecture.md` §5.3。

## 唯一的犹豫点

gRPC 的 **server streaming** 用于推送 worker 进度，确实比轮询优雅。但：轮询已设计成自重排延时任务，内存中无挂起循环（`05-job-orchestration.md` §4）；ComfyUI 侧本来就是 WebSocket + `/history` 双轨。为一个已解决的问题引入协议栈不划算。

## 重新评估的触发条件

- worker 数量达到几十个，且需要**双向流式控制**（实时中断、动态调参）
- 出现跨语言服务数量激增、codegen 收益显著超过运维成本的场景

届时**不需要重构领域逻辑**——只是把 `SelfHostProvider` 这个适配器换一个实现。这正是 ADR-0002（Provider 适配器）与 ADR-0005（HTTP 契约）预留的余地。
