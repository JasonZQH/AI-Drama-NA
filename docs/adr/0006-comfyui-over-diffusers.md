# ADR-0006 · 生成后端用 ComfyUI 而非直接写 diffusers

- **状态**：已接受（取代 `09-python-worker.md` v1 中的 diffusers 方案）
- **日期**：2026-08-10
- **相关**：`04-provider-adapter.md`、`09-python-worker.md`

## 背景

Python 生成 worker 需要一个推理执行层。v1 设计是直接用 diffusers 写 pipeline 代码，每个模型实现一个 `VideoEngine`。另一个选项是把 ComfyUI 作为无头服务跑在 worker 内部，worker 通过 HTTP 提交工作流 JSON。

## 决策

**worker 内部用 ComfyUI 作为推理执行器，worker 自身作为其唯一对外接口。**

ComfyUI 只监听 `127.0.0.1`，不暴露给控制面，更不暴露公网。工作流以 **API 格式 JSON** 作为版本化工件进版本库，worker 在提交时注入参数。

## 理由

**性能不是取舍点，甚至反向。** diffusers 官方 issue #12645 实测同参数下 diffusers 2.39 it/s、ComfyUI 2.7 it/s。ComfyUI 自建了一套激进的模型加载 / 量化 / offload / attention 调度层，并对每个新模型手工优化；diffusers 抽象层更厚。HTTP + JSON 的往返是毫秒级，相对分钟级的视频生成可忽略。

**生态差距是决定性的。** Wan2.2 全系（含 **FLF2V 首尾帧**）、**Wan Animate 2**（2026-08-08 原生上线，参考角色 + 驱动表演 → 一致动画，`WanAnimate2Cache` 可将生成时间减半）、HunyuanVideo 1.5 均为官方原生节点。这两项直接命中本项目最难的两个问题——`03-pipeline.md` §5 的末帧接首帧、以及跨镜头角色一致性。用 diffusers 意味着长期承担「追上游」的固定成本，而 2026 年视频模型的迭代速度让这个成本很高。

**协作边界。** 效果迭代可在 GUI 中完成、导出 API JSON 提 PR，不必修改 Python 代码。diffusers 路线下每一次视觉调整都要占用工程排期。

## 必须接受的三条硬约束

这三条是架构级事实，不是可调参数，已逐条查证：

1. **单一全局队列、串行执行。** 单实例吞吐 = 1 ÷ 单任务耗时，无 batching、无请求级并发（issue #12082 至今 open）。节点级并行同样没有（discussion #3683，维护者称需重写执行模型）。
2. **单实例不支持多 GPU 并行。** 唯一路径是 `--cuda-device N` + 多进程，代价是模型在每张卡各存一份。

   > **2026-08-17 更正**：本条结论成立，但原文引的 issue #11050 是错的——它的标题是 "MultiGPU node native and built-in support"，诉求是把第三方 ComfyUI-MultiGPU 的 **VRAM/RAM 分层 offload** 内置，不是「一实例并行吃两卡」。后者根本没有对应 issue。官方参数也不是 `CUDA_VISIBLE_DEVICES` 而是 `--cuda-device`（`cli_args.py`："Set the ids of cuda devices this instance will use"）。
   >
   > 顺带一个红利：显式 `--cuda-device` 锁单卡天然规避了 [#15255](https://github.com/comfyanonymous/ComfyUI/issues/15255)（dynamic VRAM 多卡 OOM 回归，2026-08-03 提、2026-08-16 仍在更新、56 条评论、仅多卡触发）。「1 GPU = 1 ComfyUI」这条架构选择在这里意外地省了一次事故。
3. **零鉴权。** `comfy/cli_args.py` 中不存在任何 auth / api-key / token 参数；`--tls-*` 是传输加密、`--multi-user` 是存储隔离，都不是鉴权。

   > **2026-08-17 更正——原文的 CVE 部分严重过时，风险等级比写的高一档。**
   >
   > 除 2024 年那三条（CVE-2024-21574/21575/21576，Manager 依赖安装可达 RCE）与伪装自定义节点窃取凭据事件外：
   >
   > - 2026 年 core **自身** 4 条 advisory（CVE-2026-56670/56671/56672/56673，CVSS 7.5–8.2），**全部影响 `< 0.28.0`**
   > - **CVE-2026-68771：未鉴权 RCE，CVSS 9.8**——`LoadTrainingDataset` 的 `torch.load` 未设 `weights_only`，`POST /upload/image` 接 `POST /prompt` 即可利用
   > - 2026-04 出现针对 1000+ 暴露实例的挖矿僵尸网络战役
   >
   > 两条推论写进纪律：**`COMFY_REF` 的安全下限是 `≥ 0.28.0`**（不是偏好，是修复线）；**pin 版本等于冻结漏洞面**，因此固版纪律必须配一条安全更新通道——订阅本仓库的 GitHub Security Advisories，给「CVE 触发的版本 bump」一条不走常规评审的快车道，Critical SLA 7 天。

**这三条与本项目的架构天然兼容**：视频大模型单次推理本就吃满一张卡，「1 GPU = 1 ComfyUI = 1 worker、横向扩展」是最自然的模型；鉴权与限流本就设计在控制面（`05-job-orchestration.md`）。

## 长期最大风险：可复现性

比性能和并发更致命的是**自定义节点版本地狱**——它是沉默的，半年后突然跑不起来。官方无 Docker 镜像（文档明确声明），60,000+ 社区节点互不保证向后兼容，依赖会互相覆盖。

强制纪律：
- ComfyUI 本体 pin 到 release tag（安全下限见上文硬约束 ③）
- **不要用 `--front-end-version` 固版**

  > **2026-08-17 更正：这条建议原本是反的。** 不传该参数才走 `default_frontend_path()`——用 `requirements.txt` 里的 `comfyui-frontend-package==<精确版本>`，零网络。传了反而在启动时打 GitHub API 拉 release 并下载 `dist.zip`，**且失败时静默降级**（`frontend_management.py` 记一行 `Failed to initialize frontend` 后回退默认前端）。对一个把「部署单元是镜像 digest」写进本 ADR 的项目，这正好是反向的。彻底断网用 `--front-end-root`。
  >
  > 判定：**断网起容器，ComfyUI 正常起，日志无 `Failed to initialize frontend`。**

- **每个自定义节点 pin 到 commit SHA**，白名单控制在 10 个以内

  > **2026-08-17 补充：这条降级为条件触发，v1 的目标是 0 个自定义节点。** 本项目需要的能力今天全在 core 里——`comfy_extras/nodes_wan.py` 已含 `WanFirstLastFrameToVideo`、`WanAnimate2ToVideo`、`WanAnimate2Cache`、`WanSoundImageToVideo`；显存也不需要 GGUF 节点，官方 repack 的 `fp8_scaled` 每 expert 14.3GB 走 core `UNETLoader` 即可。所以生产运行时只传 `--disable-all-custom-nodes`，**不传** `--whitelist-custom-nodes`。真要装第一个节点时再引入 `comfy-lock.yaml` / `cm-cli save-snapshot`（两者官方均自述 beta / 不完整），**现在一行都不要引入**。
- 部署单元是**镜像 digest**，不是 tag
- 生产运行时 `--disable-all-custom-nodes --whitelist-custom-nodes ...` + `--disable-manager-ui` + `--disable-api-nodes`
- 工作流 JSON 进 git，与镜像 tag 绑定

## 备选与否决理由

| 方案 | 否决原因 |
|---|---|
| 直接写 diffusers | 视频模型 pipeline 滞后且功能不全（首尾帧、多 LoRA、block offload 需自缝）；插帧/上采样/面部修复要逐个集成；显存优化要自调 |
| Replicate cog-comfyui | 节点与模型受白名单限制；视频大模型单价对量产不友好 |
| Comfy Cloud | 2026-03 出 beta，但 Workflow API 部署仍是 forthcoming，不能作为生产后端 |
| Comfy Deploy / ViewComfy | 引入又一层平台依赖；参数暴露与版本管理本项目自建成本可控 |

## 后果

**正面**：新模型 day-0 可用；效果链路（插帧、上采样、LoRA、参考图）开箱即得；效果迭代与代码解耦。
**负面**：多一个进程要管；可复现性靠纪律而非工具保证；显存管理是黑盒且跨版本行为会变（2026 年 #14076 等一批 OOM/缓存回归 issue 仍 open）。
**缓解**：worker 实现 `09-python-worker.md` §3.2「运行时防护」的五条（`/system_stats` 显存 canary、周期性 `/free`、每 N 任务计划性重启、OOM 后重启进程而非重试请求、按模型分池调度）。

## 一条重要的边界

**插帧、上采样、编码不要放进 ComfyUI。** 它们是确定性后处理，放在 worker 自己的代码里更好测试、可用更便宜的算力，且不占用串行队列里稀缺的大显存时间。ComfyUI 只负责扩散生成这一段。
