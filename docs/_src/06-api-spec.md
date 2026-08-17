# 06 · 控制面 API 规范

> Status: Draft v1 · 2026-08-10 · Base URL: `http://localhost:4000` · 依赖：`02-data-model.md`

## 1. 约定

| 项 | 规则 |
|---|---|
| 风格 | REST + 资源嵌套；实时进度走 SSE |
| 格式 | JSON；时间一律 ISO-8601 UTC 字符串 |
| 校验 | 每个路由用 `packages/contracts` 的 zod schema 校验入参，校验失败返回 422 |
| 分页 | 游标分页 `?cursor=&limit=`，响应含 `nextCursor` |
| 幂等 | 所有会产生费用的 POST 支持 `Idempotency-Key` 头 |
| 错误 | 统一错误体（见 §8） |
| 认证 | **所有非 GET 请求必须带 `x-api-key: $CONTROL_API_KEY`**，否则 401。GET 与 SSE 不校验（见下） |

> **为什么是自定义头而不是 `Authorization: Bearer`，为什么只挡写路径。**
>
> 这道闸门防的是一条实测走通过的路径：任意网页发一个**无 body、无 Content-Type** 的
> `POST /api/episodes/:id/generate-batch` 就能规划整集并真的花钱。那是 CORS
> **简单请求**——浏览器直接发，`no-cors` 下响应虽读不到，但服务端已经执行完。
> 所以收紧 CORS origin 拦不住它；`/generate` 压根不读 body，`generate-batch` 的
> `req.body ?? {}` 又让 `dryRun` 取默认值 `false`，于是无头请求直接花钱。
>
> 唯一同时堵住的是**要求一个自定义头**：自定义头强制浏览器先发预检，
> 恶意来源的预检过不了，真实请求根本发不出去。用 `x-api-key` 而非
> `Authorization` 只是为了不与将来真正的用户认证抢语义。
>
> **GET 刻意放行**：SSE 走 `EventSource`，浏览器 API 不支持自定义头，
> 护 GET 会直接打断实时进度流。钱的边界全在非 GET 上。要连读也堵，
> 得把 token 挪进 query param，那是另一件事。
>
> 配套两个开关：`CONTROL_HOST` 默认 `127.0.0.1`（不上局域网）；
> `WEB_ORIGIN` 收紧 CORS——它不是钱的闸门，但决定攻击是「盲打」还是
> 「先跨域读 GET 枚举出 UUID 再精确制导」。

## 2. 项目与剧本

```
GET    /api/projects                      列表
POST   /api/projects                      创建 { title, synopsis?, aspectRatio?, language? }
GET    /api/projects/:id                  详情（含统计摘要）
PATCH  /api/projects/:id
DELETE /api/projects/:id                  软删除

GET    /api/projects/:id/episodes
POST   /api/projects/:id/episodes         { index, title?, logline? }
GET    /api/episodes/:id                  含 scenes + shots 树
PATCH  /api/episodes/:id                  { scriptMd?, hook?, cliffhanger?, status? }

GET    /api/episodes/:id/scenes
POST   /api/episodes/:id/scenes
PATCH  /api/scenes/:id
DELETE /api/scenes/:id
```

### LLM 辅助端点

这些端点封装 LLM 调用，返回**结构化结果**而非自由文本，前端拿到即可直接落库。

```
POST /api/ai/outline          { projectId, premise, episodeCount }
     → { episodes: [{ index, logline, hook, cliffhanger }] }

POST /api/ai/script           { episodeId, styleNotes? }
     → { scriptMd, scenes: [{ index, summary, locationName, timeOfDay, stateIn, stateOut }] }

POST /api/ai/shotlist         { sceneId, targetDurationSec? }
     → { shots: ShotIntent[] }         // 见 03-pipeline.md §S3 的 schema

POST /api/ai/prompt-preview   { shotId, providerId? }
     → { prompt, negativePrompt, refImages: [{ role, assetId }] }
```

`prompt-preview` 是**调试利器**：让人在花钱生成前先看清将要发出去的 prompt 长什么样。UI 的高级面板直接展示它。

## 3. 一致性资产

```
GET    /api/projects/:id/characters
POST   /api/projects/:id/characters       { name, description, voiceId? }
PATCH  /api/characters/:id                改 description 会 version++
PUT    /api/characters/:id/references     { faceSet, bodyRef, wardrobe }  三路参考资产（见 02-data-model.md §3.3）
DELETE /api/characters/:id

# locations / style-profiles 同构
GET    /api/projects/:id/locations
GET    /api/projects/:id/style-profiles
```

## 4. 镜头与生成

```
GET    /api/scenes/:id/shots
POST   /api/scenes/:id/shots              创建单个 shot（Shot Intent）
PATCH  /api/shots/:id                     改 intent；若已 locked 会重置为 ready
DELETE /api/shots/:id
POST   /api/shots/reorder                 { sceneId, orderedIds[] }
```

### 生成

```
POST /api/shots/:id/generate
Body: {
  providerHint?: string,
  overrides?: { seed?, durationSec?, resolution?, promptOverride? },
  count?: number                 // 一次生成 N 个候选，默认 1
}
→ 202 { generationJobIds: string[] }
```

```
POST /api/shots/:id/reset
→ 200 { shotId, status: 'ready' }
```

把判死的镜头拉回 `ready`（发 `manual.reset`）。`failed` 是终态，状态机只认
`manual.reset` / `intent.edited` 两个事件——没有这条路由，不可重试的失败在产品上
就等于「只能开 psql 手改」。它也是 `submit_unknown`（`05-job-orchestration.md` §5.3）
能够存在的前提：提交结果未知时系统故意停下来不自动重投，代价是必须给人一个一键继续的出口。

```
POST /api/episodes/:id/generate-batch
Body: {
  scope: 'all' | 'ready' | 'failed' | { shotIds: string[] },
  providerHint?: string,
  dryRun?: boolean               // 只返回计划与成本预估，不入队
}
→ 202 {
    planned: number,
    blocked: number,             // 因连续性依赖未解锁而暂缓（见 03-pipeline §6）
    estimatedCostMicroUsd: number,
    batchId: string
  }
```

`dryRun: true` 是**必须先用的**——它把「这批要花多少钱、有几个镜头会被依赖阻塞」先算出来。UI 上「生成整集」按钮的确认弹窗就靠它。

```
POST   /api/jobs/:id/cancel
POST   /api/batches/:id/cancel            取消整批未开始的任务
GET    /api/jobs/:id                      单个任务详情（含 provider 原始响应）
GET    /api/shots/:id/jobs                该镜头的所有生成尝试（Ledger 视图）
```

### 选片

```
GET    /api/shots/:id/takes
POST   /api/takes/:id/select              设为 shot.selectedTakeId，shot → locked
POST   /api/takes/:id/reject              → rejected
PATCH  /api/takes/:id                     { humanNote? }
```

## 5. 资产、音频与渲染

```
GET    /api/projects/:id/assets           ?kind=&cursor=&limit=
POST   /api/projects/:id/assets/upload    multipart，用于手工上传参考图
GET    /api/assets/:id                    元数据
GET    /api/assets/:id/content            302 → MinIO 预签名 URL（TTL 15min）
GET    /api/assets/:id/thumbnail          视频首帧缩略图，服务端缓存

POST   /api/episodes/:id/tts              为所有有台词的镜头合成配音
     → 202 { jobIds: string[] }

GET    /api/episodes/:id/timeline         当前 timeline（不存在则按 locked shots 自动生成草稿）
PUT    /api/episodes/:id/timeline         整体保存 clips 顺序与 trim
POST   /api/episodes/:id/render
Body: { quality?: 'preview' | 'final', burnSubtitles?: boolean }
     → 202 { renderJobId }
GET    /api/renders/:id                   { status, progressPct, outputAssetId?, ffmpegLog? }
```

## 6. 播放与统计

```
GET /api/watch/:episodeId                 播放清单
    → { title, index, masterAssetId, hlsUrl?, durationSec, subtitleUrl? }

GET /api/projects/:id/stats
    → {
        shots:  { total, locked, review, failed, generating },
        cost:   { todayMicroUsd, totalMicroUsd, byProvider: Record<string, number> },
        quality:{ firstPassRate, avgAttempts, byProvider: [...] },
        queue:  { depth, running }
      }
```

## 7. SSE

```
GET /api/projects/:id/events        Accept: text/event-stream
```

```
event: shot.status
data: {"shotId":"...","status":"review","ts":"2026-08-10T00:31:02Z"}

event: job.progress
data: {"jobId":"...","shotId":"...","pct":62,"etaMs":48000}

event: batch.progress
data: {"episodeId":"...","done":18,"total":24,"failed":1}
```

事件负载类型即 `05-job-orchestration.md` §7 的 `StudioEvent`。客户端用 `EventSource`，断线自带重连；服务端每 20s 发一次 `: keepalive` 注释帧防中间层超时断连。

## 8. 错误规范

```json
{
  "error": {
    "code": "BUDGET_EXCEEDED",
    "message": "Episode budget exhausted: $2.40 of $2.00 used",
    "details": { "limitMicroUsd": 2000000, "spentMicroUsd": 2400000 },
    "requestId": "req_01J..."
  }
}
```

| HTTP | code 示例 | 场景 |
|---|---|---|
| 400 | `INVALID_STATE_TRANSITION` | 对 draft 镜头调 generate |
| 402 | `BUDGET_EXCEEDED` | 预算闸门拦截 |
| 404 | `NOT_FOUND` | 资源不存在或已软删除 |
| 409 | `CONFLICT` | 并发改同一 shot（乐观锁 `updatedAt` 不匹配） |
| 422 | `VALIDATION_FAILED` | zod 校验失败，`details.issues` 给字段级错误 |
| 429 | `RATE_LIMITED` | 全局或 provider 限流 |
| 503 | `NO_PROVIDER_AVAILABLE` | 池内无健康且能力匹配的 provider |

`requestId` 贯穿日志，报错时截图给出即可定位全链路。

## 9. OpenAPI（**未实现**）

> ⚠️ 本节整节是目标态。实测：`GET /docs`、`/openapi.json`、`/documentation/json`
> 全部 404；`pnpm api:types` 不存在（`Command not found`）；`@fastify/swagger`
> 不在依赖里；`fastify-type-provider-zod` **装了但全仓零 import**，是笔挂账。
> 前端类型是手写的（`apps/web/lib/api.ts` 共 14 处）。

设想是：Fastify 挂 `@fastify/swagger`，schema 由 zod 转换（`fastify-type-provider-zod`），
开发环境 `GET /docs` 给 Swagger UI，`pnpm api:types` 生成前端客户端——
让 API 定义只有一处真相源。

**目前刻意不做。** 本文档承诺的路由有 53 条，实现了 22 条；给不存在的 API 生成
类型是给零调用方建基础设施。前端 14 处手写类型全在同一个文件里，改一次 API 改一处，
codegen 的净收益为负。等实现比例反过来了再说。
