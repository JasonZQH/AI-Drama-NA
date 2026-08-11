# ADR-0001 · Monorepo 与 TypeScript / Python 语言分工

- **状态**：已接受
- **日期**：2026-08-10
- **相关**：`01-architecture.md`

## 背景

系统涉及三类工作：Web 界面、业务编排、模型推理与媒体处理。需要决定用几种语言、代码怎么组织。

## 决策

**单一 monorepo（pnpm workspaces + Turborepo），语言边界划在「业务 vs 计算」，而不是「前端 vs 后端」。**

- TypeScript：`apps/web`（Next.js）、`apps/control`（Fastify）、`packages/*`
- Python：`workers/video`、`workers/media`、`workers/eval`
- 二者只通过 HTTP 契约通信，类型真相源在 `packages/contracts`（zod → JSON Schema → pydantic）

## 理由

领域模型（Shot、Asset、JobStatus）在前端和业务层要用同一套类型。分成 TS 前端 + Python 后端的话，这些类型要写两遍且永远会漂移。用 TS 统一这两层，前端直接 import 后端的真实类型，配合 zod 一次定义得到类型、运行时校验、以及给 Python 的 JSON Schema。

而模型推理、OpenCV、FFmpeg 复杂滤镜、embedding 这些，Python 生态没有替代品。硬用 TS 会陷入绑定地狱。

Monorepo 的价值在于 contracts 包能被三方同时消费，且改接口时 CI 一次就能发现所有破坏点。

## 一个必须澄清的维度混淆

**monorepo / polyrepo 与 monolith / microservices 是正交的两个轴：**

- **monorepo / polyrepo** 决定**源码放在哪**
- **monolith / microservices** 决定**运行时怎么拆**

Google 与 Uber 都是 monorepo + 大规模微服务。本 ADR 只回答前者。

需要特别指出：**本项目从一开始就是跨语言、多进程的**——Next.js 前端、Fastify 控制面、Python 视频 worker（远程 GPU、独立镜像、跨网络）、媒体 worker、评测 worker，彼此只通过 HTTP 契约通信、各自独立部署与扩缩。选择 monorepo 并不意味着「不拆服务」，只意味着这些服务的源码放在同一个仓库里。

运行时拓扑的定性见 **ADR-0009**，跨进程协议选择见 **ADR-0010**。

## 备选与否决理由

| 方案 | 否决原因 |
|---|---|
| 全 Python（FastAPI + 模板/Gradio） | 前端体验受限，复杂交互界面（分镜网格、时间线）做不好 |
| 全 TypeScript | 视频模型推理在 Node 生态不可行 |
| 多仓库 | 接口漂移无法在 CI 捕获，本地联调要开多个仓库 |
| TS 前端 + Python 全后端 | 领域类型写两遍，这是最大的持续成本 |

## 后果

**正面**：类型端到端一致；前端不手写 API 类型；改接口有编译期保护。
**负面**：贡献者要装两套工具链；`contracts:build` 成为必须的构建前置步骤，忘了跑会出现困惑的类型错误。
**缓解**：`pnpm dev` 自动前置执行 contracts:build；CI 第一步就是它。
