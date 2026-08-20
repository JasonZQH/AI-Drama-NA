# 06 · 控制面 API 规范

> Status: Draft v1 · 2026-08-10 · Base URL: `http://localhost:4000` · 依赖：`02-data-model.md`

## 1. 约定

| 项 | 规则 |
|---|---|
| 风格 | REST + 资源嵌套；实时进度走 SSE |
| 格式 | JSON；时间一律 ISO-8601 UTC 字符串 |
| 校验 | ⚠️ 422 与统一错误体 ✅ 成立，但 schema 是**各路由文件里就地写的 `z.object`**，不是来自 `packages/contracts`（那里根本没有 HTTP 入参 schema）。且并非每个路由都校验——多条只解析 `:id`，body 与 query 基本不校验 |
| 分页 | ⛔ 未实现。全仓零 `cursor`；`GET /api/projects` 全量返回，`/api/attention` 写死 `limit 50`。等真有几百个项目再说 |
| 幂等 | ⛔ HTTP 层未实现——没有任何路由读 `Idempotency-Key`。**防重复付费在队列层**：每行 `generation_jobs` 至多 submit 一次（`queue/orchestrator.ts` 的 `claimForSubmit`），结果未知时停下不自动重投（`05` §5.3）。HTTP 幂等键是目标态 |
| 错误 | ✅ 统一错误体（见 §8） |
| 认证 | ✅ **所有非 GET 请求必须带 `x-api-key: $CONTROL_API_KEY`**，否则 401。GET、SSE 与 CORS 预检的 `OPTIONS` 不校验（见下） |

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

## 1.1 承诺与实现的总账

> **本文承诺 53 条路由，控制面实际注册 22 条，而 53 条里真正被服务的只有 17 条。**
> 差额不是「还没写完」那么简单——有 5 条已实现的路由本文一个字没提，另有 10 条
> 路径对得上但**签名或语义不符**。核验方式：起真控制面 `app.printRoutes()` 打路由表，
> 再对每条承诺 `app.inject()` 实测状态码与响应体。

| 状态 | 条数 | 说明 |
|---|---|---|
| ✅ 签名相符 | 7 | 照着文档调就能用 |
| ⚠️ 已实现但不符 | 10 | 路径对，但 body / query / 响应形状与文档不同——**照着文档调会静默拿到别的东西** |
| ⛔ 未实现 | 36 | 实测 404 |
| 📋 已实现但本文没写 | 5 | 见 §6.1 |

十条「不符」的具体差异（这些最容易踩）：

| 端点 | 差在哪 |
|---|---|
| `GET /api/projects/:id` | 不含统计摘要，实为 `{ project, episodes }`；统计在 `/stats` |
| `GET /api/episodes/:id` | 返回三个**平铺数组**不是嵌套树；shots 每项额外带 `takeCount` / 成本 |
| `POST /api/shots/:id/generate` | **body 完全不解析**（`providerHint` / `overrides` / `count` 静默忽略）；响应是 `{ shotId, status }` 不是 `{ generationJobIds }` |
| `POST /api/episodes/:id/generate-batch` | 只解析 `dryRun`；`scope` / `providerHint` 传了不报错也不生效；`dryRun:true` 回 **200** 且形状不同；`batchId` 不落库 |
| `POST /api/takes/:id/reject` | 不止改 take——拒掉**最后一个**候选会带动镜头走状态机；响应里的 `status` 是镜头状态 |
| `GET /api/projects/:id/assets` | **路径被 §3 的一致性资产占用**，返回 `{ characters, locations, styles }`；`?kind=&cursor=&limit=` 全不解析。媒体资产列表没有端点 |
| `GET /api/watch/:episodeId` | `hlsUrl`（M5）与 `subtitleUrl`（M3）**永远不出现** |
| `GET /api/projects/:id/stats` | 四段形状**全部**与文档不同，且没有 `queue` 段（跨项目的在 `/api/stats/overview`）|
| `GET /api/projects/:id/events` | **`:id` 不做过滤**——这个频道是全量广播，路径里的 id 只是历史形状 |
| `POST /api/episodes/:id/render` | 见 §5：同步，回 200 不是 202 |

> **为什么不逐条在下面标 ⛔。** 36 条未实现的散落在 §2–§5，逐行加标记会让代码块
> 读不下去，而且每次实现一条就要改两处（代码块 + 这张表）。总账集中在这里，
> 下面各节保持「目标 API 长什么样」的可读性——需要知道某条能不能用，回来查这张表。

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

POST /api/episodes/:id/shotlist                              // 已实现
     → 201 { shots, scenes, repaired, warnings, costUsd }
     // 整集一次生成，不按场。E2/E3/W1 全是集级量，逐场必须把累计秒数喂回去
     // ——那是手搓一个整集上下文只是分了 N 次付钱，而整集重来只要 $0.003。
     // 输入全部从库里取（script_md + project.synopsis + scenes + characters），
     // 没有请求体。前置：有剧本、有场次、还没有镜头、目标时长可达。

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
POST   /api/episodes/:id/render           ✅ 已实现
Body: { quality?: 'preview' | 'final' }   （burnSubtitles 未实现）
     → 200 { renderJobId, assetId, storageKey, durationSec, normalizedReused }
GET    /api/renders/:id                   ⛔ 未实现，见下
```

**渲染是同步的，回 200 不是 202。** `renderEpisode` 从头到尾 await media worker，
返回时母版已经落库——响应体里带着 `assetId` / `storageKey`，那是完成的形状。

此前这里写 202 且列了一个轮询端点，两条都不成立：调用方以为要去轮询，而
`GET /api/renders/:id` 代码里根本不存在。真做成异步要建 `q:render`、拆 worker、
补轮询端点，而 M1 不碰渲染、真异步没有需求方——所以选「让代码别说谎」，
而不是「把谎话实现出来」。一集 12 镜的渲染实测 4 秒级，同步等得住。

批量渲染 N 集时的背压问题等真有 N 集再说；`progressPct` 同理（要额外解析
ffmpeg 的进度管道，而现在没人看这个数）。

> **控制面在渲染途中重启**会留下停在 `running` 的 `render_jobs`，而
> `GET /api/watch/:id` 只认 `succeeded` 的母版，于是那一集在面板上永远转圈。
> `reconcileOnBoot` 现在会把这类孤儿判失败并写明原因。与生成不同，这里没有
> 「可能已计费」的两难——重渲染不花钱，且母版只增不改（约束 C5），直接让人重来即可。

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

### 6.1 管理面板端点（✅ 已实现，此前未写入本文档）

```
GET /api/stats/overview                   跨项目总览：totals / attention / queue / budget
                                          （distribution 与 revenue 恒为 null，M4 接投放回传时填充）
GET /api/stats/timeseries  ?range=30d|3m|6m|1y|all   成本与通过率时间序列，粒度由区间自动推导
GET /api/projects/summary                 项目列表 + 集数/镜头/locked/成本聚合（避免前端 N+1）
GET /api/attention                        跨项目待办：failed 与 review 的镜头（写死 limit 50）
GET /api/events                           SSE 全量广播，管理面板一条连接分发给各标签
```

> 每个成本聚合都同时给出 `mockCostMicroUsd`——mock provider 的钱不是真花的钱，
> 界面必须能把两者分开标。同理 `cost_estimated`：超时与「提交结果未知」记的是
> 按价目表估的数，不是 provider 回报的真实计费（`05` §6.1）。

## 7. SSE

```
GET /api/projects/:id/events        Accept: text/event-stream
```

```
event: shot.status
data: {"shotId":"...","status":"review","ts":"2026-08-10T00:31:02Z"}

event: job.progress
data: {"jobId":"...","shotId":"...","pct":62,"etaMs":48000,"stage":"denoising"}

event: error
data: {"shotId":"...","code":"content_filtered","message":"..."}
```

> ⚠️ 路径里的 `:id` **不参与过滤**——`GET /api/events` 与 `GET /api/projects/:id/events`
> 共用同一个 handler，频道从来就是全量广播（`routes/sse.ts`）。按项目筛选目前在客户端做。

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
