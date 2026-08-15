# ai-drama-studio

本地优先的 AI 短剧生产系统：**输入一个故事，输出可播放的分集短剧成片**。

它既是生产工具（Studio），也是播放器（Player）。第一阶段的目标不是商业化，而是把「文本 → 可播放视频」这条主干在本地完整跑通，并让主干的每一环都可替换、可观测、可计价。

```
故事 → 分集 → 分场 → 分镜 → 资产 → 批量生成 → 评测选片 → 配音字幕 → 拼接 → 播放
```

## 现状

📄 **设计阶段** · 文档已完成，代码尚未开始。下一步是 M0 骨架（见 [`docs/12-roadmap.html`](docs/12-roadmap.html)）。

## 技术选型速览

| 层 | 选型 | 位置 |
|---|---|---|
| Web | Next.js 15 · TypeScript · Tailwind v4 · Radix | Mac |
| 控制面 | Fastify · TypeScript · Drizzle | Mac |
| 状态 | PostgreSQL 16（真相源）· Redis（BullMQ 队列） | Mac / docker |
| 存储 | MinIO（S3 兼容） | Mac / docker |
| 视频生成 | Python · FastAPI · Wan2.2 / HunyuanVideo | **远程 GPU** |
| 媒体处理 | Python · FFmpeg | Mac / docker |

三条核心约束：

1. **生成后端可替换** —— 一切藏在 Provider 适配器后，业务代码不认识任何厂商。
2. **无 GPU 也能跑通全链路** —— `MockProvider` 是一等公民，不是玩具。
3. **一切生成留痕** —— 每次尝试（含失败）都写 Generation Ledger：参数、种子、耗时、成本、是否采用。

## 快速开始（无 GPU / 无 API key）

```bash
pnpm install
cp .env.example .env                    # 默认 mock provider
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate && pnpm db:seed         # demo: 1 集 / 12 镜 / 2 角色
pnpm dev                                # web:3000 · control:4000
```

打开 `http://localhost:3000` → demo 项目 → 分镜页 →「生成整集」，十几秒后可走完 生成 → 选片 → 渲染 → 播放 全流程。详见 [`docs/11-dev-setup.html`](docs/11-dev-setup.html)。

## 文档

文档已渲染为带设计的 HTML —— 打开 **[`docs/index.html`](docs/index.html)** 作为入口（支持深浅色切换、目录跟随、跨篇互链；流程图与架构图为 Mermaid 矢量渲染，随主题重绘）。Markdown 源保留在 `docs/_src/`，改完运行 `python3 scripts/build-docs.py` 重新生成。

**先读这三篇**：`00-overview`（范围与术语）→ `01-architecture`（架构全貌）→ `12-roadmap`（从哪开始动手）。

| 文档 | 内容 |
|---|---|
| [00-overview](docs/00-overview.html) | 范围定义、设计约束、术语表 |
| [01-architecture](docs/01-architecture.html) | 三平面架构、进程拓扑、目录结构 |
| [02-data-model](docs/02-data-model.html) | 数据库 schema、状态枚举、Generation Ledger |
| [03-pipeline](docs/03-pipeline.html) | 八阶段流水线（含 S8 素材层）、镜头状态机、评测分层、连续性策略 |
| [04-provider-adapter](docs/04-provider-adapter.html) | 生成后端统一契约与路由器 |
| [05-job-orchestration](docs/05-job-orchestration.html) | 队列、并发、轮询、重试、成本记账、崩溃恢复 |
| [06-api-spec](docs/06-api-spec.html) | 控制面 REST + SSE API |
| [07-design-system](docs/07-design-system.html) | 前端设计系统：色彩、排版、组件、交互模式 |
| [08-screen-specs](docs/08-screen-specs.html) | 七个页面的布局与交互规格 |
| [09-python-worker](docs/09-python-worker.html) | Worker Contract、模型选型、远程 GPU 部署 |
| [10-media-storage](docs/10-media-storage.html) | S3 存储、FFmpeg 拼接、TTS、HLS、容量估算 |
| [11-dev-setup](docs/11-dev-setup.html) | 环境搭建、环境变量、排错速查 |
| [12-roadmap](docs/12-roadmap.html) | M0–M6 里程碑与验收标准 |
| [13-character-assets](docs/13-character-assets.html) | 角色资产三路分离、参考图机制、单镜头 prompt 三阶段 |

**架构决策记录**

| ADR | 决策 |
|---|---|
| [0001](docs/adr/0001-monorepo-and-language-split.md) | Monorepo；语言边界划在「业务 vs 计算」 |
| [0002](docs/adr/0002-provider-adapter-over-direct-sdk.md) | Provider 适配器而非直连 SDK |
| [0003](docs/adr/0003-postgres-as-system-of-record.md) | Postgres 为真相源，Redis 仅作队列 |
| [0004](docs/adr/0004-s3-compatible-storage-from-day-one.md) | 从第一天用 S3 兼容存储 |
| [0005](docs/adr/0005-remote-gpu-worker-http-contract.md) | GPU worker 用 HTTP 契约而非共享队列 |
| [0006](docs/adr/0006-comfyui-over-diffusers.md) | 推理执行层用 ComfyUI 而非 diffusers |
| [0007](docs/adr/0007-bullmq-over-temporal.md) | 编排留在 BullMQ，写明 Temporal 迁移触发条件 |
| [0008](docs/adr/0008-character-asset-separation.md) | 角色资产按 face / body / wardrobe 三路分离 |
| [0009](docs/adr/0009-modular-monolith-not-microservices.md) | 模块化单体 + 无状态计算 worker，不上微服务 |
| [0010](docs/adr/0010-http-over-grpc.md) | 跨进程用 HTTP/JSON 而非 gRPC |
| [0011](docs/adr/0011-drizzle-over-alternatives.md) | 数据层用 Drizzle，裸 SQL 校验留给 SafeQL |

## 里程碑

| | 目标 | 关键验收 |
|---|---|---|
| **M0** | 骨架跑通（假生成、真流程） | 无 GPU 无 key，5 分钟跑通全链路 |
| **M1** | 接入云 API | 成本可见，dryRun 预估误差 <20% |
| **M2** | 远程 GPU 自部署 | 云 API 与自部署同口径成本对比 |
| **M3** | 音频与成片 | 一集（10–25 镜）带配音字幕成片，改一镜重渲染 <30s |
| **M4** | 素材产线（曝光优先） | 一键产出 L2/L1/L0 三版；自动切出 ≥40 条钩子概念 |
| **M5** | 端到端闭环 | 连续 5 集角色一致性可接受 |
| **M6** | 质量与成本优化 | 每可用镜头成本下降 ≥20% |

## 本阶段明确不做

支付与订阅、多用户、CDN 分发、内容审核闸门、移动 App、Kubernetes。数据模型里留了字段和钩子（见 `02-data-model.md` §10），但不实现。
