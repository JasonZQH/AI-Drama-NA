# ADR-0012 · M1 接 OpenRouter，M2 增 ComfyUI，两者并存于同一 provider 池

- **状态**：已接受
- **日期**：2026-08-17
- **相关**：`ADR-0002`（适配器层）、`ADR-0005`（Worker Contract）、`ADR-0006`（ComfyUI 作为推理执行器）、`04-provider-adapter.md`、`09-python-worker.md`

## 背景

ADR-0006 已经定了「自部署用 ComfyUI」。但它没有回答一个更前面的问题：**第一个真实 provider 应该是谁。**

三条路今天都摆在桌上，容易被混为一谈：

| | 谁的 GPU | 怎么付钱 | 我们要写什么 |
|---|---|---|---|
| **A · OpenRouter** | 别人的 | 按次 | ~200 行 HTTP 适配器 |
| **B · ComfyUI + Partner Nodes credits** | 别人的 | 按次 **+ 一层平台** | ComfyUI 翻译层，跑的还是别人的闭源模型 |
| **C · ComfyUI + 自己/租的 GPU 跑开源权重** | 自己的 | 按小时 | 翻译层 + 工作流 + 权重 + 容器 + 节点固版 |

B 常被误认成「自部署」。它不是——ComfyUI Desktop 本体永远免费开源，需要订阅的是 Partner Nodes 的 credits，那是通过 Comfy 的平台去调 Veo / Kling 这类**闭源**模型，官方明说 "Pricing matches the original price for each API"。

## 决策

**M1 只注册 OpenRouter。M2 增加基于 ComfyUI 的 `SelfHostProvider`。两者并存于同一个 provider 池，由 `routeProvider` 逐镜头选择。**

**否决路线 B。** 它与 A 抢同一个位置（别人的 GPU、按次付费），但集成更重、多一层平台抽成、且成本归因更差——`generation_jobs` 那张 Ledger 要的是每次生成的真实计费，OpenRouter 原生回报 `usage.cost`。

## 理由

### 编排层已经完成，且与 provider 无关

```
编排层  queue/ + pipeline/（不含测试）   3474 行   ← 已交付
适配器  mock + route + registry            401 行   ← 换 provider 只换这里
```

那 3474 行是「12 个镜头怎么排队、失败怎么重试换 seed、钱怎么记、超预算怎么拦、take 怎么选、崩溃怎么恢复」。**ComfyUI 一行都替代不了**——它是一个全局串行队列加图编辑器，不认识镜头、集、预算、take。

选哪个 provider 都不改变这个事实。这正是 ADR-0002 建适配器层的全部理由，M1 是它的第一次兑现。

### OpenRouter 先行，因为 M1 的意义是「用真钱验记账管道」

M1 验收五条全部关于成本正确性（回填非空、估算误差 <20%、CI 不烧钱、`usdPerAccepted` 有真数、mock 可回退）。这要求真实账单，而 OpenRouter 提供的是最短路径：一把 key、一个 host、原生 `usage.cost`、零基础设施。

先走 C 的话，第一笔真实成本数据要等 GPU 机器、权重、容器、工作流全部就位，且拿到的是 GPU 小时数而非每次计费——**折算口径本身就成了新的不确定性**，反而验不了记账管道。

### 但 ComfyUI 不是「更便宜的选项」，是 L2 内容的唯一选项

`04-provider-adapter.md` §5 规则 2 已经写死：`safetyProfile = 'mature'` 只路由到 `serverSideContentFilter === false` 的 provider——**即自部署**。

所以对 L2 内容，「自部署是否更便宜」这个问题不成立：没有云对照价。成本分析在那里要回答的是「怎么让它不失控」。

而对非成人内容，2026-08 的实测价格是：RunPod 4090 Community $0.34/hr、一集 12 镜一次唤醒 ≈ **$0.082/可用镜头**，云地板（OpenRouter `seedance-1.5-pro` 无音）≈ **$0.212/可用镜头**。纯算力自部署赢 2.6 倍，且对 GPU 单价 ±50%、生成耗时 ±50% 的九宫格全部成立。

**但把运维人力计入后翻转**：`回本量 = (存储 + 运维) / (云单价 − 自部署单价)`。按 $200/月运维计，对云地板需 **~128 集/月**才回本；对 kling-std 档（delta $0.604）只需 **~28 集/月**。

结论：**两条独立的成本模型，不要合成一条。** 非成人内容按产量和对标档位决定；L2 内容无从比较。

## 必须接受的约束

1. **RunPod 对 L2 是禁区。** ToS（2026-03-24）§6 明文禁 "pornography or **graphic adult content**"，§8 附 "as determined by us"，后果是 immediate termination + **permanent platform ban**——权重卷与账号同生共死。而 RunPod 恰好是最便宜、工具链最全的那家。主流厂里唯一没有泛成人禁令的是 **CoreWeave**（AUP 只禁 CSAM 与 NCII）。Modal（"indecent or obscene" + "media-serving platform services" 双钩子）与 Novita（与 RunPod 逐字相同的 boilerplate，**不构成 plan B**）同样排除。

   ⇒ **分两阶段**：阶段 1 用 RunPod 跑非成人测试素材验管道；阶段 2 前必须拿到 CoreWeave 合同或书面豁免。

2. **主力模型是 Wan2.2 I2V-A14B，不是 TI2V-5B。** `03-pipeline.md` §5 的「末帧接首帧」依赖 FLF2V，而 **5B 没有 FLF2V 档**；`lightx2v/Wan2.2-Lightning` 的 `TI2V-5B-4steps` 至今仍在 TODO 未发布。好消息是显存口径可以放宽：官方 repack 的 `fp8_scaled` 每 expert 14.3GB、逐 expert 加载，**24–32GB 卡即可，不需要 H100**。

3. **最敏感的参数不是 GPU 价，是审美通过率 `a`。** `a` 从 0.5 掉到 0.33，每可用镜头成本 +51%，比 GPU 单价 +50% 更狠——**而它是整个成本模型里唯一零来源的纯猜参数**。在测出 `a` 之前，换卡换供应商都是次要矛盾。

4. **部署形态保持 ADR-0005 的路线 A**（`workers/video` FastAPI 拥有 ComfyUI）。让控制面直连 ComfyUI 的路线 B **不会让代码变少，只会让它搬家到更差的位置**：产物搬运没人做了（ComfyUI 无预签名 PUT 能力）、supervisor 职责无家可归、失去 `ENGINE=mock` 的 Mac 契约验证，且要把一个未鉴权即可 RCE 的服务放上 tailnet。若将来仍要走 B，必须为「ComfyUI 只监听 127.0.0.1」另开一条偏离 ADR。

## 备选与否决理由

| 方案 | 否决原因 |
|---|---|
| **ComfyUI Partner Nodes credits**（路线 B） | 与 OpenRouter 抢同一个位置，但集成更重、多一层平台抽成、成本归因更差。ADR-0006 选 ComfyUI 选的是开源权重那条路，不是这条 |
| **直接跳到自部署，跳过 M1 云 provider** | 第一笔真实成本数据要等全套基础设施就位，且拿到的是 GPU 小时数而非每次计费；同时失去 ADR-0002 立论所需的「云 vs 自部署同口径对照组」 |
| **直连各厂 SDK（Kling / Vidu / Runway）** | 每家一套鉴权、一套错误码、一套计费口径。OpenRouter 一把 key 覆盖多模型且原生回报成本，M1 阶段不值得为单价差异付这个集成成本 |
| **LTX-2.5**（快 5.7× 且自带音轨） | AUP（2026-03-30）逐字禁性内容，**且适用范围明写涵盖 on-premises deployments**；更危险的是竞品条款——Lightricks 自家就是 LTX Studio，与本项目同类 |
| **SkyReels-V3** | 唯一不可替代的能力是 A2V 的 200 秒长口播，本项目每镜 4 秒用不上；非原生，要引入大型第三方节点 |
| **H100 做常驻 worker** | ADR-0006 硬约束 ① 单任务串行 ⇒ 吞吐优势兑现不了。$1.99 的 H100 PCIe 在 12 镜/唤醒下是 $0.285/镜，$0.34 的 4090 是 $0.082。**便宜的卡跑慢一点，比贵的卡跑快一点更省** |

## 后果

**正面**：M1 用最短路径拿到真实成本数据；适配器层第一次被两个真实实现验证；L2 内容的路径明确且有据。

**负面**：M2 之前 mature 内容无法生成——`ShotDrawer` 现在对 `content_filtered` 给的补救建议「改用 self-host provider 生成」在 M1 期间指向一个不存在的 provider，需在 UI 上标注。

**未决**：`a`（审美通过率）、`T_gen`（A14B 在 4090/5090 上的实际秒数）、A14B fp8_scaled 在 24GB 卡上能否稳定运行——这三条决定 M2 的机型与成本模型，必须实测，不接受外推。`09-python-worker.md` §4 与 §5.3 已按本 ADR 更新。
