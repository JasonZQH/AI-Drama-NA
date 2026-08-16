# M1 实现流程

**目标**：同一条链路吐出真实视频，并且知道每个可用镜头花了多少钱。

M0 证明了管线能跑通。M1 要证明它接上真钱之后仍然成立——成本可归因、质量可度量、provider 可替换。

本文基于对 dev 分支（`ea5cd43`）的实测调研，不是对路线图的复述。每条结论都带 `file:line`。

---

## 0. 先纠正三条前提

路线图六项里有三项被认为「M0 已完成」。实测只完成了一项半。这个偏差会直接导致 M1 漏排工作量。

| # | 交付 | 认知 | 实测 |
|---|---|---|---|
| 2 | 预算闸门 + dryRun | 已完成 | **部分**。闸门只挂在 3 个花钱入口中的 1 个 |
| 3 | 产物转存 + sha256 | 已完成 | **未完成**。sha256 只覆盖本地路径 |
| 4 | 洞察页 v1 | 已完成 | **口径错误**。三个数都在，`accepted` 语义是错的 |

### 0.1 转存：远程下载根本没写

```ts
// queue/ingest.ts:92-97
function localPathOf(sourceUrl: string): string {
  if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://')) {
    throw new Error(`远程 URL 的下载在 M1 接入云 provider 时实现：${sourceUrl}`)
  }
  return sourceUrl.replace(/^file:\/\//, '')
}
```

代码自己写明了这是 M1 的活。sha256 存在（`storage/s3.ts` 的 `putFile`），但只在「已经有本地文件」之后。云 provider 返回的是 http(s) URL，走到这一行直接抛。

### 0.2 `accepted` 的语义是错的——这条最贵

```ts
// queue/ingest.ts:81-84    每一次生成成功都写 accepted: true
await deps.db.update(s.generationJobs)
  .set({ status: 'succeeded', accepted: true, finishedAt: new Date() })
```

而人工选片（`pipeline/applyTransition.ts:63-66`）只改 `takes.status = 'selected'` 与 `shots.selectedTakeId`，**从不回写 `generationJobs.accepted`**。`fail()` 写 `accepted: false`（`orchestrator.ts:291`）。

净效果：`accepted` 实际含义是「这次生成出片了」，不是「这次生成被采用了」。于是

- `usdPerAcceptedMicro`（`stats.ts:110`、`api.ts:272`）= 总花费 ÷ **成功生成数**。重试越多分母越大，这个数字越好看——与它想表达的意思正好相反。
- `firstPass`（`stats.ts:142`）= `accepted and attempt = 1`，实为「首次尝试出了片」，不是一次通过率。

M1 验收第 4 条要的就是这个数；04 §5 第 4 步的路由排序也要它。**口径不改，这条验收拿到的是系统性偏低的假数。**

修法是一行位置调整：`accepted` 改在 `set.selectedTake` 时写，`ingest` 不再写。同时 `takes.allRejected` 路径要把该 shot 的所有 job 置 `accepted: false`。

---

## 1. 真正的前置：止血

比「provider 路由器」更靠前的，是一批**今天就已经坏、但因为 mock 不花钱所以 M0 五条验收不可能暴露**的花钱路径。它们必须在第一把真 key 进 `.env` 之前落地。

### 1.1 `submit()` 会被重放最多 3 次

```ts
// queue/queues.ts:88-93
export const INFRA_RETRY: JobsOptions = { attempts: 3, backoff: {...} }
// queue/queues.ts:105 —— 挂在所有队列上，含 q:generate
const opts = { connection, prefix: QUEUE_PREFIX, defaultJobOptions: INFRA_RETRY }
```

```ts
// queue/orchestrator.ts:114-120
const handle = await provider.submit(req)      // ← 钱在这一行花掉
await deps.db.update(s.generationJobs).set({ providerJobRef: handle.externalId, ... })  // ← 记账在这一行
await enqueuePoll(...)                          // ← Redis 抖动也会抛
```

`submit()` 之后的任何抛出都会让 BullMQ 原样重放整个 handler，重放时 `providerJobRef` 仍是 null（`:88` 的检查通不过），于是再提交一次。云 API 的 429 / 502 / socket hang up 都会抛，其中「HTTP 响应超时但服务端已受理」是最常见的一种。

`orchestrator.ts:73-75` 的注释把安全性押在「provider 的 submit 契约」上，而这一层唯一的证据是 `contract.spec.ts:43-50`——它 `const p = make()` 建一个实例连提两次，命中的是 `mock.ts:99` 那张进程内 `Map`。**云 provider 若不自带 idempotency key，这条契约测试会绿着通过，钱照扣两遍。**

**修法**：`q:generate` 单独设 `attempts: 1`。花钱的 handler 不该做基础设施重试——该重试的是 poll，不是 submit。

### 1.2 控制面重启 = 同一行 job 被并发提交两次

`reconcileOnBoot` 只在控制面进程跑（`server.ts:69`）；worker 是另一个进程（`worker.ts`）且不跑 reconcile，重启瞬间队列里必然还有 waiting/delayed/active 的条目。所有 `queues.*.add()` 都不带 `jobId`，BullMQ 没有任何去重。

结果：同一 `generationJobId` 被两个 worker 槽位并发处理，两边都读到 `providerJobRef = null`（`:88` 的检查不是原子的），两边都调 `submit`。`:115` 的 UPDATE 后写者胜出，先提交那个的 `externalId` 被覆盖——它不会被轮询、不会被 cancel、不会被超时逻辑看到，一路跑完一路计费，最后在系统里完全查不到。

`UNIQUE(shot_id, attempt)` 对此毫无作用：自始至终只有一行。

**修法**：`add('generate', data, { jobId: generationJobId })`。BullMQ 按 jobId 天然去重。两行。

### 1.3 失败与超时不记成本

```ts
// queue/orchestrator.ts:284-293  fail() 的 set()
{ status: 'failed', failureCode, failureDetail, finishedAt, accepted: false }
```

没有 `costMicroUsd`。全仓 `costMicroUsd` 的唯一写入点是 `orchestrator.ts:235`（成功分支）。

真 provider 对失败、超时、取消的生成照样计费——算力已经消耗。`timeout` 是可重试码（`enums.ts:108`），超时阈值 15 分钟，`maxAttempts = 4`。一个镜头可以产生 4 笔真实扣费、账面 4 个 NULL。而唯一的预算闸门读的正是这些值（`batch.ts:74` `spentToday`）。

**日限额永远不会触发。** mock 的失败不花钱，所以 M0 不可能测出这条。

**修法**：`fail()` 写入成本。provider 契约补一条：失败结果也要报成本（不报则按价目表估算）。这需要扩 `ProviderFailure`，加 `costMicroUsd?: number`。

### 1.4 预算闸门只覆盖 3 个入口中的 1 个

唯一的闸门在 `routes/api.ts:112`，且是双重条件——只在 `dryRun=false` **且** `onExceed === 'block'` 时生效。`BUDGET_ON_EXCEED=warn` 会让这唯一的闸门也消失。

不过闸门的三个入口全部经过**同一个执行点**：

```
POST /api/shots/:id/generate       ─┐
POST /api/episodes/:id/generate-batch ─┼→ applyShotTransition → enqueue.generation 分支
orchestrator.fail() 的自动重试      ─┘   (pipeline/applyTransition.ts:44-59)
                                          └→ createGenerationJob (queue/ingest.ts:120，全仓唯一 INSERT)
```

**修法**：闸门下沉到 `enqueue.generation` 分支之前。一处，三条路径一次覆盖。不要在三个 caller 各加一遍。

附带两个已知弱点，M1 可以接受但要写进注释：`spentToday` 是按 project 当日汇总（不是按 episode），且是循环前一次性 pre-check——两个并发 batch 请求可以同时通过（TOCTOU）。

### 1.5 block / warn 不是张力，是两个闸门被当成了一个

- `08-screen-specs.md` §2：「超预算时确认按钮变红但**不禁用**——是警告不是家长控制」
- M1 验收第 3 条：「预算超限被 `block` 拦下，UI 明确提示」

这两句描述的是不同模式，`batch.ts:31` 的 `onExceed` 已经把两种模式都建模了，并且已经在 dryRun 响应里返回。问题是前端没读它：

```tsx
// apps/web/components/ConfirmSpend.tsx:88-96
<button disabled={busy || plan.planned === 0}   // ← 只看 busy，不看 onExceed
        style={{ background: over ? 'var(--status-error)' : 'var(--accent)' }}>
```

而服务端默认 `block`（`batch.ts:42`）。**今天这已经是一条死路交互**：用户点一个可点的红按钮，拿到 402。mock 太便宜（$0.08/4s，12 镜约 $1，日限 $5）所以没人撞到。

**修法**：`ConfirmSpend` 读 `plan.budget.onExceed`——`warn` 下按钮可点带红色警告，`block` 下禁用并说明「超出日预算，去设置里调整」。两份文档同时变成真的，零新概念。

另：`apps/control/src/pipeline/README.md:44` 写着 "Exceeding the budget warns, it does not forbid"，与代码默认行为相反，是错的，一并改掉。

### 1.6 让上面全部可验：mock 加「失败也计费」

P0 的四条修改如果只能等真 provider 才能验，那就等于没验。MockProvider 加一个开关（失败时也返回成本），P0 的每一条都能在现有 M0 链路上跑出来。

---

## 2. Provider 路由器

### 2.1 现状：只有一处需要改

「选哪个 provider」写进 `generation_jobs.provider_id` 的值只有 3 个来源，全部是 `providers[0]`：

| 位置 | 代码 |
|---|---|
| `routes/api.ts:31` | `providerId: deps.providers[0]!.id` |
| `queue/orchestrator.ts:299` | `providerId: deps.providers[0]?.id ?? 'mock'` |
| `worker.ts:64` | `providerId: providers[0]!.id` |

三者都经 `TransitionDeps.providerId` 落到 `ingest.ts:120` 这条唯一 INSERT。

**这个形状是对的，不要动它。** Ledger 记录「当时选了谁」，而 `orchestrator.ts:64` 的 `providerOf()` 在 submit/poll 时按 `job.providerId` 反查实例——重放与恢复都能拿回同一个 provider。这正是崩溃恢复能成立的原因。

所以路由器的改动是：把 `TransitionDeps.providerId: string` 换成一个解析函数。三个调用点传同一个 router。

同一个对象字面量里还写死了另外几项（`applyTransition.ts:49-56`）：`modelId: 'mock-v1'`、`mode: 't2v'`、`resolution: '720p'`。`modelId` 尤其要一起解决——M1 验收要「成本可归因」，而 ledger 里每一笔真实花费的模型名都会是 `mock-v1`，`gj_analytics_idx` 按 `(providerId, modelId)` 建的索引直接失效。

### 2.2 M1 只做 04 §5 的第 1、3、5 步

| 步骤 | M1 | 理由 |
|---|---|---|
| 1 硬约束过滤 | ✅ | `shots.provider_hint`（`schema.ts:141`）已存在，零读取。免费的一半 |
| 2 mature 只路由到无服务端过滤 | ❌ | M1 池子里没有自部署，没有对象。留位置，见 issue #15 |
| 3 失败规避 | ✅ | 在某家被 `content_filtered` 过就排到最后 |
| 4 统计排序 | ❌ | 依赖 `usd_per_accepted` 物化视图（不存在），且样本不足 30 必走退化分支 |
| 5 预算闸门 | ✅ | 已在 §1.4 下沉到统一执行点，路由器不重复实现 |

**不要建 `RoutingContext` / `ProviderPriors` / 物化视图。** 第 4 步在 M1 期间 100% 走退化分支——建一个只会返回「固定优先级」的统计管道，是给一个不存在的输入建基础设施。等 M1 跑完有了真实样本再说。

### 2.3 health 过滤：用失败计数，不用主动探测

04 §5 第 1 步含「筛掉 `health()` 不健康的」。主动探测意味着每次路由决策一次网络调用。

更省的做法：Redis 里存 per-provider 的连续失败计数（`queue/semaphore.ts` 已经有现成的 Redis 计数器模式可抄），超阈值的排到最后。由已经在发生的 poll 失败驱动，零额外网络调用，且比周期性探测更贴近「这家现在能不能用」。

`registry.ts:17` 的 `resolveProvider` 是第二套查找实现，只被测试引用（`orchestrator.ts:64` 自己又写了一遍）。路由器落地时删掉其中一个。

### 2.4 `DEFAULT_PROVIDER` 是死配置

```ts
// providers/registry.ts:8   注释
 * `DEFAULT_PROVIDER=mock` 强制指定，避免误刷云账单。
// providers/registry.ts:13-15   实现
export function buildProviderPool(env = process.env): VideoProvider[] {
  return [MockProvider.fromEnv(env)]      // ← env 里的 DEFAULT_PROVIDER 从未被读
}
```

全仓无任何代码读这个变量（唯一核验为 CONFIRMED 的断言）。池子里出现第一个云 provider 的那一刻，这句注释就从「描述不存在的行为」变成真实的花钱风险。

### 2.5 顺带：`.env` 会漏进「不烧钱」的 test 车道 ✅ 已修

`vitest.config.ts:19` 无条件 `process.loadEnvFile('.env')`，对 `pnpm test` 与 `pnpm test:int` 一视同仁。而 `registry.ts:13` 的默认参数就是 `process.env`。开发者一旦在 `.env` 填上真 key，`pnpm test`（CI 里最便宜、无任何 env 注入的那条车道）的进程里就有可用凭证。

现有测试给不了保护：`mock.test.ts:78/83/89` 全部显式传 env，从没覆盖默认参数那条路径。

OpenRouter 让这条从「以后再说」变成必须——一把 key 解锁全部视频模型。已在 `vitest.config.ts` 里于 `loadEnvFile` 之后删掉所有 `*_API_KEY`，`RECORD=1` 时放行（录制卡带是唯一该花钱的场景）。

实测：默认 lane `KEYS=[]` 且 `S3_BUCKET=drama` 仍在（其他 `.env` 变量不受影响，集成测试的端口修复保住）；`RECORD=1` 时 key 放行。

---

## 3. prompt-kit 与参考图通路

### 3.1 输入齐了，输出没有落点

三路资产的表都在（`characters` / `locations` / `style_profiles`），但**唯一读取点是只读统计接口** `stats.ts:238-243`，终点是 UI 齐备度展示。不通向 `GenerationRequest`。

真正的断点比想象的靠上游。不是 `buildRequest`，是 `applyTransition.ts:44-58`——唯一的 job 创建点把 `mode` 写死 `t2v`、prompt 只拼 `${action}, ${shotType}`、params 不含任何参考图字段。`buildRequest` 即使想读也无处可读。

三条断头路：

| 列 | 状态 | M1 是否接线 |
|---|---|---|
| `generation_jobs.input_asset_ids` | 全仓零读写。且是裸 `uuid[]`，装不下 `RefImageRole` 与 `weight` | ✅ 要改 schema |
| `generation_jobs.negative_text` | `orchestrator.ts:136` 读它，但 `createGenerationJob` 没有这个参数，无人写 | ❌ 见下 |
| `characters.platform_bindings` | 零消费者 | ❌ 见下 |

`input_asset_ids` 是要动 migration 的 schema 变更——`RefImage` 的语义核心是 `role`（character / location / style / first_frame / last_frame）和 `weight`，`uuid[]` 把两个都丢了。而 04 §4 的整个设计前提就是「用语义 role 而不是数组下标」。**越晚改代价越大，建议在 M1 一并做掉。**

另外两条 **M1 不接**，理由都来自 §5.4 的 OpenRouter 实况：

- `negative_text`：OpenRouter 的请求体没有 `negative_prompt`。接一条线通到不存在的下游是纯浪费。保留列，注释写明为什么空着，等 M2 自部署（ComfyUI 体系负向词有效）再接。
- `platform_bindings`：OpenRouter 的 `input_references` 是统一 schema 下的扁平数组，不是各家的 role routing，没有绑定信息可取。issue #11 因此不阻塞 M1。

### 3.2 签 URL 需要改函数签名

`RefImage.url` 要求预签名 URL（`contracts/src/provider.ts:16`），`presignGet` 是 async（`storage/s3.ts:105`）。而 `buildRequest`（`orchestrator.ts:129`）是同步纯函数，`OrchestratorDeps`（`:24-31`）里根本没有 `Storage`。

`worker.ts:28` 已经 `new Storage(storageFromEnv())`，但 `:31` 的 `deps` 把它漏在外面。改动是：`buildRequest` 改 async + `OrchestratorDeps` 注入 `Storage`。

key 规范已经有了没人用：`storage/s3.ts:120` 的 `s3Key.ref(projectId, characterId, assetId)`。

### 3.3 一个会静默坏掉的耦合

```ts
// providers/mock.ts:260-266
export function fixturePathFor(req: GenerationRequest): string {
  const kinds = ['establishing', 'ecu', 'ots', 'pov', 'cu', 'ms', 'ws'] as const
  const kind = kinds.find((k) => new RegExp(`\\b${k}\\b`).test(req.prompt.toLowerCase())) ?? 'ms'
```

它之所以现在能工作，纯粹因为 `applyTransition.ts:51` 把 promptText 拼成 `${action}, ${shotType}`。换成 prompt-kit 的散文 prompt 后，所有镜头都退回 `ms.mp4`，**且没有任何测试会失败**。prompt-kit 落地时要么把 shotType 单独传给 mock，要么接受 fixture 选择退化并明确记录。

### 3.4 Prompt Lint（issue #18）：M1 内没有执行点

`s.shots` 的唯一 insert 在 `db/seed.ts:180`。API 里没有任何 POST/PUT/PATCH 能创建或编辑镜头。所以 13 §4.5 要求的「在分镜阶段拦截」在 M1 内**没有地方可挂**——唯一能挂的位置是 `createGenerationJob` 之前，那已经是「花钱前一刻」，拦下来只能整镜失败，不能让人改。

**建议**：M1 只交付 lint 的**纯函数与单测**（无 IO，输入 Shot Intent + prompt，输出告警列表），执行点留到镜头编辑接口存在时。这样规则本身经过验证，接上去只是接线。不要为了给 lint 找执行点而在 M1 造一个镜头编辑接口。

顺带一条口径问题：13 §4.5 称 ≤10 秒「三处同口径」，实测只有两处半——`shot.ts:24` 是 `min(1).max(10)`，`schema.ts:159` 的 CHECK 是 `> 0 AND <= 10`（0.5 秒能进库过不了 zod），而 `GenerationRequest` 从来没被 `.parse()` 过（`orchestrator.ts:130-146` 直接返回对象字面量），provider 边界上那条 zod 约束是装饰性的。

---

## 4. 契约测试：接云之前必须先修

**这一节的每一条都要在云适配器写第一行之前完成**，否则「CI 不烧钱」在第一次加 provider 时就破。

### 4.1 整套契约现在跑两遍（实测）

```
$ npx vitest run apps/control/src/providers
Test Files  2 passed (2)      Tests  28 passed (28)
```

28 = 9 条契约 × 2 + 10 条 mock 专有。`contract.spec.ts:141` 在模块顶层调 `runContractSuite('MockProvider', fast)`，而 `mock.test.ts:3` 又 `import { makeRequest } from './contract.spec.js'`——vitest 把被 import 模块里注册的 `describe` 算进 importing 文件。

接云之后是三个具体问题：新 provider 的注册点自然写在 `contract.spec.ts`，任何复用 `makeRequest` 的新文件（`vidu.test.ts` 是最自然的写法）都会把云套件再跑一遍，record 模式下真实调用与账单翻倍；卡带的 interceptor 是一次性消费的，第二次必然 miss；miss 之后若无显式 net-disable，请求会真的打出去。

**修法**：把 `makeRequest` 挪到单独模块，或把 `runContractSuite('MockProvider')` 的调用移进 `mock.test.ts`。

### 4.2 `drain()` 的 5 秒 deadline 短一个数量级

```ts
// providers/contract.spec.ts:31-39
async function drain(p, handle, maxMs = 5000) {
  const deadline = Date.now() + maxMs
  for (;;) {
    const r = await p.poll(handle)
    if (r.status !== 'running' && r.status !== 'submitted') return r
    if (Date.now() > deadline) throw new Error('轮询超时')   // ← 无 try/finally，无 cancel
    await new Promise((r) => setTimeout(r, 10))
  }
}
```

五个调用点全用默认值。仓库自己的数字就说明不够：`mock.ts:167` 意味着 4 秒片要 32 秒；`mock.ts:69` 注释写真机首次加载 14B 权重要 60–90 秒；`queues.ts:132` 的生产轮询退避上限是 30 秒——单次间隔就超过整个 deadline。

后果分三层：

- **录制侧**：`:111`「成本非空」与 `:122`「事前估算与事后计费同量级」永远录不到 succeeded 的响应，卡带里只有 running。而这两条恰恰是 M1「成本可归因」与「误差 < 20%」的验收点。
- **钱侧**：抛出后无 cancel，云端那次生成一路跑完一路计费，本地什么都没拿到。每跑一次录制就重复烧一遍。
- **回放侧**：10ms sleep 是墙钟，5000/10 = 500 次迭代封顶；卡带超过约 500 条交互就永远回放不完。

**修法**：deadline 提参、加 `try/finally` 里的 cancel、回放模式下用假时钟而非墙钟。

### 4.3 两条错误映射用例：一条硬失败，一条假绿

```ts
// contract.spec.ts:84-97  与 :99-109
providerParams: { mock: { failFirstAttempt: 'content_filtered' } }   // ← 唯一读取方 mock.ts:156
```

`runContractSuite` 没留注入形参，真实 provider 无法触发。实测（用一个忽略 `providerParams` 的 provider 跑该套件）：

- `content_filtered` 那条**硬失败**——`:91` 有无条件的 `expect(r.status).toBe('failed')`。
- `provider_error` 那条**假绿**——唯一断言 `expect(r.retryable).toBe(true)` 裹在 `if (r.status === 'failed')` 里，云端任务成功则 if 不进，零断言通过。

后者危害更大：云适配器的 retryable 映射会拿到一个从未验证过的绿灯，而 `FailureCode` 的 retryable 决策是状态机依赖的。

**修法**：`runContractSuite(name, make, hooks)` 加一个失败注入 hook，由各适配器用自己的方式实现（云 provider 用卡带里的错误响应）。同时套件缺 `quota_exceeded`（限流 / 429）的用例——04 §7 要求的一档。

### 4.4 「validate 不发起调用」的证据对云 provider 是空的

```ts
// contract.spec.ts:67-70
const before = (await p.health()).queueDepth
p.validate(tooLong)
expect((await p.health()).queueDepth).toBe(before)
```

`queueDepth` 在 `provider.ts:133` 是 `.optional()`。云适配器合法地不返回它（多数云 API 也确实给不出账号级队列深度），此时断言退化成 `expect(undefined).toBe(undefined)`，恒真。就算返回了，账号全局的 queueDepth 会被任何并发任务改变，反而引入 flake。而且这条为了证明「没发网络调用」，自己发了两次网络调用。

**修法**：改用录制回放库的「无未匹配请求」断言（nock 的 `assertNoPendingInterceptors` / `disableNetConnect`）——那才是「没发网络调用」的真证据。

### 4.5 「能力声明一致」会遗弃 4 个计费任务

`:52-58` 遍历 `p.capabilities.modes`，每个 mode 提交一次，之后既不 drain 也不 cancel。mock 声明 4 个 mode。一轮录制约 9 次真实生成，其中只有 1 次会被 cancel。

更硬的问题：`makeRequest` 从不设 `refImages`（默认 `[]`），而 `i2v` / `ref2v` 零参考图会被云端 400 拒掉。`mock.ts:125-135` 的 validate 只检查数量上界，从不校验「i2v/ref2v 必须至少一张」。**这条用例对真 provider 是必挂的**——而它是判断「适配器声明的能力是不是真的」的唯一关卡。

**修法**：按 mode 构造合法请求体；validate 补下界校验。

### 4.6 CI 车道的选择

`pnpm test`（`package.json:13`）排除 `**/*.int.test.ts`；`pnpm test:int`（`:22`）用 `int.test.ts` 做文件名过滤。回放型云测试不需要容器，天然属于 `test` 车道——方向对。

两个陷阱：
- `test` 车道没有任何出网拦截，`vitest.config.ts:24` 返回的是空 `defineConfig({})`，没有 `setupFiles` 可以挂 net-disable。要加。
- 别把回放测试命名成 `vidu.replay.int.test.ts`——会被踢进 `ci.yml` 那个要起三个容器、`needs: db` 排最后的 integration 车道。

---

## 5. 云适配器：OpenRouter

**决策：云 provider 只走 OpenRouter，不直连任何厂商。** [视频生成 API 于 2026-04-16 上线](https://openrouter.ai/blog/announcements/video-generation/)，异步 job 模型。

### 5.1 契约对齐度

| `VideoProvider` | OpenRouter |
|---|---|
| `submit()` | `POST /api/v1/videos` → `{ id, polling_url, status: 'pending' }` |
| `poll()` | `GET /api/v1/videos/{id}` → `pending \| in_progress \| completed \| failed` |
| `cancel()` | 文档未列——**需在 P5 实测**，缺失则超时路径只能靠自然结束（见 §5.5） |
| `capabilities` | `GET /api/v1/videos/models` 返回每个模型的支持参数 |
| `costMicroUsd` | **`usage.cost` 原生回报**（另有 `is_byok`） |
| `providerParams` 逃生舱 | 请求体的 `provider` 对象，passthrough |
| `t2v / i2v / ref2v` | `prompt` / `frame_images` / `input_references` |
| `supportsAudio` | `generate_audio` |
| `seed` / `resolution` / `aspectRatio` / `durationSec` | `seed` / `resolution` / `aspect_ratio` / `duration` |

选它的三条实质理由，都不是「省事」：

1. **`usage.cost` 让「绝不返回 null 成本」由厂商满足**。验收第 1 条「成本正确回填」不再依赖价目表估算，验收第 2 条的 <20% 误差有了真实对照物。
2. **一个 HTTP host**。录制回放（§4）对着一个 host 做，比 N 套厂商 SDK 简单一个量级。且不引入任何 vendor SDK——用 `fetch` 即可，`eslint.config.js` 的 `no-restricted-imports` 不用动。
3. **一把 key 覆盖后续的 LLM**（issue #6）。但那属于剧本产线，**不并入 M1**。

### 5.2 池的单位是 (provider, model)，不是 provider

capabilities 在 OpenRouter 上是 **per-model** 的：Veo 3.1 有音频、Wan 没有，时长与分辨率上限各不相同。若整个 OpenRouter 是一个 provider 一套 capabilities，路由器就分不出 Veo 和 Wan——04 §5 第 1 步的能力过滤直接失效。

**做法：一个 `OpenRouterProvider` 类，按 `OPENROUTER_VIDEO_MODELS` 里配置的每个 model 实例化一次**，`id = 'openrouter:google/veo-3.1'`。

零契约改动，顺手解决三件事：

- 路由器的能力过滤第一次有了真实对象——带 `dialogue` 的镜头可以路由到 `generate_audio` 的模型，issue #15 的第 2 条（`supportsAudio` 路由无落点）在 M1 内就能兑现。
- `generation_jobs.model_id` 拿到真值，`applyTransition.ts:49` 的 `'mock-v1'` 硬编码自然消失，`gj_analytics_idx` 的 `(provider_id, model_id)` 索引第一次有意义。
- `providerOf()`（`orchestrator.ts:64`）的按 id 反查不用改。

`serverSideContentFilter` 对所有 OpenRouter 模型都是 `true`（全托管），所以 04 §5 规则 2（mature 只路由到无服务端过滤的）在 M1 内仍然没有对象——与 §2.2 的判断一致，留位置不实现。

### 5.3 幂等只能由我们这侧保证

**OpenRouter 的 `POST /api/v1/videos` 没有幂等键**（`X-OpenRouter-Idempotency-Key` 只出现在 webhook 回调，用于投递去重）。

这把 §1.1 与 §1.2 从「应该做」变成**硬前置**：

- `q:generate` 必须 `attempts: 1`——`submit()` 之后的任何抛出都是一次真实重复计费，没有任何厂商侧兜底。
- `queues.generate.add()` 必须带 `jobId: generationJobId`。

同时修正 §5.4 里我原本提的做法：契约测试**不能**加一条「跨实例幂等」硬断言——OpenRouter 必挂。改成让适配器声明幂等由谁保证（`idempotency: 'provider' | 'orchestrator'`），套件按声明分支：声明 `provider` 的跑跨实例断言，声明 `orchestrator` 的断言「同 requestId 二次 submit 会抛」，由编排层的去重负责不走到那一步。

P5 期间值得实测一次：很多 API 支持未文档化的 `Idempotency-Key` 头。若支持则收益很大，但不要把计划押在上面。

### 5.4 三处对不上，要改计划

**没有 `negative_prompt`。** 契约的 `negativePrompt`（`provider.ts:28`）、DB 的 `negative_text`（`schema.ts:288`）、`style_profiles.negativePrompt` 在 OpenRouter 上全部落空。

这反过来印证了 13 §4.5 的判断——「把禁写规则做成 lint，比依赖 negative_prompt 字段有效得多」「国产闭源视频模型的负向提示词能力普遍弱于 SD 体系」。**所以 §3.1 里「补 negativeText 的写入方」从 M1 删掉**：给一个不存在的下游接线，是纯浪费。保留列，注释写明为什么空着。

**`extend` 无对应字段。** `capabilities.modes` = `['t2v','i2v','ref2v']`。这是好事——「能力声明一致」那条契约测试（§4.5）第一次有实际意义，因为终于有一个 provider 不是四个 mode 全支持。

**`PlatformBindings` 的前提被削弱。** OpenRouter 的 `input_references` 是统一 schema 下的扁平数组，不是各家的 role routing。而 ADR-0008 明说「三路分离的收益来自平台侧的 role routing」。M1 走 OpenRouter 意味着这份收益要到 M2 自部署才兑现——issue #11 因此不再是 M1 的阻塞项，但 ADR-0008 的收益论证需要在 M2 重新检验。

### 5.5 `cancel` 与超时

文档没有列取消端点。若确实没有，§1.3 提到的超时路径（`orchestrator.ts:186` 的 best-effort cancel）就永远是 no-op——任务会跑完并计全费，而我们已经判它失败并开了下一次 attempt。

**P5 必须先实测 cancel 是否存在**，结果决定两件事之一：有，则正常映射；没有，则 `PROVIDER_TIMEOUT_MS` 命中后不能立刻开下一次 attempt，要先等旧任务自然终结并把成本记进去，否则两个任务同时计费而账上只有一份。

### 5.6 四条义务里，两条被 OpenRouter 改写

`providers/README.md` 写明的四条中：

**「绝不返回 null 成本」** —— 由 `usage.cost` 满足。但注意单位：OpenRouter 报的是美元浮点（`0.25`），我们存整数微美元。`Math.round(cost * 1e6)`，在适配器边界转换一次，别让浮点漏进业务层（02 §1 第 5 条）。

**「`submit` 必须幂等」** —— 见 §5.3，做不到，改由编排层保证。这是与 M0 假设最大的一处偏离，`providers/README.md` 那段要一并改写。

### 5.7 `providerMeta` 被丢弃，「真钱 vs 估算」在库里无法区分

`handlePoll` 成功分支（`orchestrator.ts:231-247`）只落库 `costMicroUsd` / `seedUsed` / `status` / `latencyMs`。`providerMeta` 被原地丢弃，`generation_jobs` 也没有存它的列。

顺带被丢的还有 `widthPx` / `heightPx` / `durationSec` / `fps`——`assets` 表明明有这四列（`schema.ts:255-258`），而 `ingest.ts:59-67` 的 insert 不写，恒为 NULL。

面板现有的「真钱 vs mock」区分完全依赖 `provider_id = 'mock'` 这一个判据，硬编码在四处（`stats.ts:44,138`、`api.ts:72`、`ShotDrawer.tsx:417,530`）。M1 接真 provider 后，**「厂商回报的真实计费」与「适配器按价目表估算」仍然无处区分**——而 M1 验收第 1 条要的正是「成本正确回填」。

**修法**：`generation_jobs` 加一个 `cost_estimated boolean` 列。一个布尔，直接回答这个问题。不要为此加整个 `providerMeta` jsonb——等真的需要存厂商调试信息时再说。同时 ingest 补写 assets 的四个媒体元数据列。

### 5.8 估算精度：验收第 2 条会倒逼它

`contract.spec.ts:128` 已经断言误差 < 20%，但见 §4.2——这条对真 provider 永远跑不到 succeeded。

另一侧，`planBatch` 的估算用的是合成请求（`batch.ts:112-131`）：12 个字段有 10 个硬编码，只有 `durationSec` 取自真实 shot 且影响金额。`safetyProfile` 最实质——`shots` 表逐镜头存了这一列（`schema.ts:140`），估算时被无视。且整批只用一个 provider 估算，不读 `shots.provider_hint`。

当前不产生可观测偏差（`MockProvider.estimateCost` 只按 `durationSec` 计价，且池里只有一个 provider），但路由器落地后就会。**路由器与批量估算要用同一条路径**——每个 shot 先路由再估算，否则 dryRun 的数与实际扣费不是一回事，验收第 2 条无法成立。

---

## 6. 执行顺序

每一阶段都标了是否需要真 key。**只有 P5 需要。**

| 阶段 | 内容 | 需要云账号 | 关键产出 |
|---|---|---|---|
| ~~P-1 环境~~ | ✅ **已完成**：§2.5 key 隔离、`apps/web` 读根 `.env`、`scripts/dev.sh` 退出停容器 | ❌ | 见 §9 |
| **P0 止血** | §1.1–1.6 + §0.2 的 `accepted` 口径 | ❌ | 花钱路径在 mock 下就可观测、可拦截 |
| **P1 路由器** | §2 | ❌ | `providerHint` / 失败规避 / 统一闸门 |
| **P2 prompt-kit** | §3.1–3.3 + lint 纯函数（§3.4） | ❌ | 参考图通路打通，`input_asset_ids` migration |
| **P3 转存** | §0.1 远程下载 + sha256 + 大小上限 + 超时 | ❌ | 本地起 HTTP server 即可验 |
| **P4 契约套件整修** | §4 全部 + 录制回放骨架（先对本地 mock HTTP） | ❌ | CI 不烧钱的前提 |
| **P5 OpenRouter 适配器** | §5 + **一次**真实录制 + 验收 | ✅ | M1 五条验收 |

**为什么不按路线图的 1→6 顺序**：路线图的 1（云适配器）排在最前，但它是唯一需要真钱的一项。把它排到最后，前五个阶段全部可以在没有任何云凭证的机器上完成并验证——而且 P0 修完之前接真 key 是不安全的（§1.1–1.4 的四条叠加，一次误操作的花费上限实际是无穷）。

**P0 与 P1 可以合并成一个 PR** 如果闸门下沉与路由器都改 `TransitionDeps`——两者动的是同一个签名，分开改会撞两次。

---

## 7. 验收条款的可验性

| # | 验收 | 可验性 | 依赖 |
|---|---|---|---|
| 1 | 单镜头生成成功，成本正确回填且量级合理 | OpenRouter 原生回报 `usage.cost`，只需 §5.7 的 `cost_estimated` 列把它与 mock 的估算分开 | P5 |
| 2 | dryRun 预估与实际花费误差 < 20% | 需先做 §4.2（drain deadline）与 §5.8（估算走路由路径），否则测不到 | P1 + P4 |
| 3 | 预算超限被 block 拦下，UI 明确提示 | 需先做 §1.4（下沉）与 §1.5（前端读 `onExceed`）。当前是死路交互 | P0 |
| 4 | seed 那一集（12 镜）的真实一次通过率有数据 | **需先做 §0.2**，否则拿到的是系统性偏低的假数 | P0 |
| 5 | 切回 `DEFAULT_PROVIDER=mock` 仍完全可用 | 需先做 §2.4（这个变量现在无人读）与 §2.5（`.env` 漏进 test 车道） | P1 |

**五条里有四条的前置在 P0/P1，不在云适配器。**

---

## 8. 明确不纳入 M1

| 不做 | 理由 |
|---|---|
| `usd_per_accepted` 物化视图 / `ProviderPriors` / 04 §5 第 4 步 | 样本不足 30 必走退化分支，M1 期间 100% 如此。给不存在的输入建基础设施 |
| 04 §5 第 2 步（mature 路由） | 池子里没有自部署，没有对象。留位置，issue #15 |
| Prompt Lint 的执行点 | 镜头编辑接口不存在（`shots` 唯一写入方是 seed）。只交付纯函数 + 单测，issue #18 |
| issue #6（LLM provider 契约）/ #7（图像生成模式） | 属于剧本页与资产产线，与「视频 provider 接真钱」是两件事。混进来会让 M1 验收失焦 |
| 项目级预算存储（issue #9） | M1 用全局 env 够了。按项目区分等有第二个项目再说 |
| `PlatformBindings`（issue #11） | OpenRouter 的 `input_references` 是扁平数组，没有 role routing 绑定可存。M2 自部署时再看 |
| `negative_text` 接线 | OpenRouter 无 `negative_prompt` 字段（§5.4）。M2 的 ComfyUI 体系才有效 |
| webhook 回调（`callback_url`） | 需要公网地址，而 `q:poll` 自重排那套已经跑通。YAGNI |

---

## 9. 已落地的环境约束

> 三条在规划期间就做掉了，因为它们是后续所有阶段的地基，且都只有几行。

**所有 API key 只在根 `.env` 管理，子包一律不放。** 原本已基本成立（`apps/control` 用 `--env-file-if-exists=../../.env`，`workers/media` 由 compose 注入），但 `apps/web` 是漏的——`next dev` 在 `apps/web/` 里跑，Next 只从自己目录找 `.env`，那里没有。所以 `NEXT_PUBLIC_API_BASE` 从未生效，一直走 `api.ts:1` 与 `next.config.ts:6` 的硬编码兜底；改一次 `CONTROL_PORT` 就会静默坏掉。已改成与 `apps/control` 同一个 idiom（实测：不带该参数时探针为 `undefined`，带上后读到根 `.env` 的值）。

**`pnpm test` 不该有能力花钱。** 见 §2.5。

**退出时停容器。** `scripts/dev.sh`：起依赖 → `trap ... EXIT` → `turbo run dev --parallel`。Ctrl+C（SIGINT）、正常退出、崩溃退出三种情况都触发（已实测前两种）。用 `stop` 不用 `down`——保留容器与 `./.data`，重启只付健康检查的时间。两个终端并行时用 `KEEP_INFRA=1` 起后来的那个，避免第二个 Ctrl+C 把基础设施从第一个脚下抽走。原 `turbo run dev --parallel` 保留为 `pnpm dev:app`（不碰容器）。

**为什么不上 Makefile**：这仓库的入口全部是 pnpm script，CI 直接调 `pnpm lint` / `pnpm test` / `docker compose`。加 make 就有了第二套编排而 CI 不会用它，两边必然漂移。真正需要的只有一句 `trap`。

---

## 附：本文的核验方法

8 条关于代码库的事实断言各由一个独立 agent 试图证伪，7 条判 PARTIAL（主体成立、细节有误，均已按修正表述写入本文），1 条判 CONFIRMED（§2.4 `DEFAULT_PROVIDER` 死配置）。另有 4 个视角（钱 / 幂等崩溃 / CI 录制回放 / prompt-kit 接缝）做缺口扫描，findings 已并入对应章节。

标注「实测」的结论均为在本机运行验证，非静态阅读推断。OpenRouter 的接口细节取自其官方文档（`/docs/guides/overview/multimodal/video-generation`），**尚未对真实端点验证过**——§5.5 的 `cancel` 是否存在、§5.3 的未文档化 `Idempotency-Key` 是否支持，两条都标记为 P5 必须实测。
