# 07 · 前端设计系统

> Status: Draft v1 · 2026-08-10 · 适用：`apps/web` + `packages/ui`
> 注：原计划用 `/frontentdesign` skill，该 skill 在当前环境不可用，本文为自建规范。若后续引入该 skill，以其输出覆盖本文的令牌部分，结构与组件清单可保留。

## 1. 这是什么类型的界面

不是内容网站，是**生产工具**——同类参照是 DaVinci Resolve、Linear、Vercel Dashboard，而不是 Netflix。这个定位决定了三条基本取向：

1. **暗色优先**。用户长时间盯着视频缩略图，浅色背景会干扰对画面明暗的判断。视频工具没有浅色的传统是有原因的。
2. **信息密度高于呼吸感**。一屏要能看到 24 个镜头的状态，而不是 6 个大卡片。留白服务于分组，不服务于美观。
3. **状态与成本永远可见**。这是花真钱的工具。任何时候用户都应该能立刻回答「现在有多少任务在跑、今天花了多少」。

## 2. 三条硬规则

这三条比任何视觉细节都重要，违反了界面就不可用：

**R1 · 进度必须可读。** 生成任务耗时几十秒到几分钟。任何超过 2 秒的操作都必须有真实进度（百分比 + ETA），不能只是转圈。转圈在这里等于「系统卡死」。

**R2 · 花钱操作必须二次确认且显示金额。** 「生成整集」这类按钮，确认弹窗上必须写清「18 个镜头，预估 $3.60」。永远不要让用户在不知道价格的情况下点下去。

**R3 · 失败必须可操作。** 报错不能只说「生成失败」。要说明失败码、是否可重试、以及一个明确的下一步按钮（重试 / 改 prompt / 换 provider）。

## 3. 色彩令牌

暗色为主模式，浅色为可选。以 CSS 变量定义在 `packages/ui/src/tokens.css`。

### 3.1 表面与文字

| 角色 | Dark（默认） | Light | 用途 |
|---|---|---|---|
| `--bg-base` | `#0c0c0e` | `#fafaf9` | 页面底 |
| `--bg-surface` | `#151518` | `#ffffff` | 卡片、面板 |
| `--bg-raised` | `#1d1d21` | `#f4f4f2` | 悬浮层、下拉、模态 |
| `--bg-inset` | `#09090b` | `#f0f0ee` | 输入框、代码块、视频容器 |
| `--border` | `#2a2a30` | `#e2e1dc` | 常规描边 |
| `--border-strong` | `#3a3a42` | `#c9c8c1` | 强调描边、分隔 |
| `--text-primary` | `#f2f2f0` | `#0b0b0b` | 正文 |
| `--text-secondary` | `#a1a1aa` | `#52514e` | 次要说明 |
| `--text-muted` | `#6b6b75` | `#8a8984` | 标签、时间戳 |

### 3.2 品牌与强调

| 角色 | Dark | Light |
|---|---|---|
| `--accent` | `#3987e5` | `#2a78d6` |
| `--accent-hover` | `#4d95ea` | `#1f68c0` |
| `--accent-subtle` | `#16233a` | `#eef4fc` |
| `--accent-text` | `#7db3f0` | `#1f68c0` |

### 3.3 状态色（语义固定，禁止挪用）

状态色只表达状态，**永远不要拿来当装饰色或图表系列色**。

| 状态 | Dark | Light | 语义 |
|---|---|---|---|
| `--status-idle` | `#6b6b75` | `#8a8984` | draft / ready，未开始 |
| `--status-running` | `#3987e5` | `#2a78d6` | generating / rendering |
| `--status-review` | `#c98500` | `#eda100` | 待人工处理 |
| `--status-success` | `#0ca30c` | `#006300` | locked / succeeded |
| `--status-error` | `#e66767` | `#d03b3b` | failed |
| `--status-cancelled` | `#4a4a52` | `#b0afa8` | cancelled / skipped |

**每个状态色必须配一个图标或文字标签**——只靠颜色区分对色觉障碍用户不可用，何况 running 和 accent 是同一个蓝。

### 3.4 图表系列色

数据图表（成本趋势、provider 对比）用固定顺序的分类色板，**按 provider 身份分配，不按排名分配**——筛选后剩下的系列不能变色，否则用户会误读。

```
1 蓝 #3987e5   2 橙 #d95926   3 青 #199e70   4 黄 #c98500
5 品红 #d55181  6 绿 #008300   7 紫 #9085e9   8 红 #e66767
```

超过 8 个 provider 时归入「其他」，不生成新颜色。

## 4. 排版

系统字体栈，不引入 Web Font（工具类应用，加载速度优先于字体个性）：

```css
--font-sans: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
```

| Token | Size / Line | 用途 |
|---|---|---|
| `--text-2xs` | 11 / 16 | 徽章、角标 |
| `--text-xs` | 12 / 18 | 元数据、时间戳 |
| `--text-sm` | 13 / 20 | **界面默认字号** |
| `--text-base` | 15 / 24 | 正文、剧本编辑器 |
| `--text-lg` | 18 / 26 | 区块标题 |
| `--text-xl` | 24 / 32 | 页面标题 |
| `--text-stat` | 28 / 34 | 统计数字 |

**所有数字必须用 `font-variant-numeric: tabular-nums`**——成本、时长、进度百分比在列表里跳动时不能左右抖动。

## 5. 间距与圆角

4px 基准栅格：`--space-1: 4px` 到 `--space-12: 48px`。

圆角克制：`--radius-sm: 4px`（徽章、输入）、`--radius-md: 6px`（按钮、卡片）、`--radius-lg: 10px`（面板、模态）。视频缩略图用 `--radius-sm`，大圆角会让画面显得不专业。

阴影只用两级，暗色模式下靠边框而非阴影建立层次：
```css
--shadow-raised:  0 2px 8px rgba(0,0,0,.4);
--shadow-overlay: 0 8px 32px rgba(0,0,0,.6);
```

## 6. 组件清单

`packages/ui` 提供，按 Studio 的实际需要设计，不做通用组件库。

### 6.1 状态与进度

**`<StatusPill>`** — 状态胶囊，圆点 + 文字，绝不只有颜色。
```
● Ready    ◐ Generating 62%    ⚑ Review 3    ✓ Locked    ✕ Failed
```
`generating` 态圆点带脉冲动画；`review` 态显示待选数量。

**`<ProgressBar variant="determinate|indeterminate">`** — 优先 determinate。indeterminate 只在「已提交但 provider 未回报进度」的短暂窗口使用，且必须配文字说明当前阶段（"已提交，等待 provider 排队"）。

**`<CostMeter>`** — 常驻顶栏。今日花费 / 预算，接近上限时进度条转 `--status-review`，超限转 `--status-error`。
```
今日 $2.14 / $5.00  ▓▓▓▓▓▓░░░░ 43%
```

**`<QueueIndicator>`** — 顶栏，`⚡ 6 running · 18 queued`，点击展开队列面板。

### 6.2 内容

**`<ShotCard>`** — 最核心的组件，网格里出现几十次。结构自上而下：
```
┌──────────────────────┐
│ ┌──────────────────┐ │  ← 缩略图 9:16，悬停自动播放静音预览
│ │   [视频首帧]      │ │     右上角 StatusPill
│ │              ● 3 │ │     右下角 take 数量徽章
│ └──────────────────┘ │
│ #12 · CU · 4.0s      │  ← 序号 · 景别 · 时长（tabular-nums）
│ 林夏抬头看向门口      │  ← action，两行截断
│ 🔵 vidu  $0.08       │  ← provider 徽章 + 本镜累计成本
└──────────────────────┘
```
状态用左侧 3px 色条强化，扫视时能一眼看出整屏分布。

**`<TakeComparer>`** — 同一镜头多个候选并排对比，同步播放/暂停/进度条。选片是高频操作，快捷键 `1..9` 直选，`Enter` 确认。

**`<TimelineStrip>`** — 水平时间线，clip 宽度正比于时长，下方两条细轨显示配音与字幕覆盖情况。支持拖拽排序与边缘拖拽 trim。

**`<AssetGrid>`** — 虚拟滚动网格（`@tanstack/react-virtual`）。资产可能几千个，必须虚拟化。

**`<PromptInspector>`** — 折叠面板，展示最终 prompt、负向词、参考图缩略、seed、provider 参数。可复制、可覆盖。这是 R3 的落地：失败时用户第一件事就是看这里。

### 6.3 反馈

**`<ConfirmSpend>`** — 花钱确认弹窗（R2）。必须显示：影响镜头数、预估成本、provider、当前剩余预算。确认按钮文案是「生成 18 个镜头（约 $3.60）」而不是「确定」。

**`<FailureCard>`** — 失败卡片（R3）。失败码 + 人话解释 + 可操作按钮组。例：
```
✕ 内容被 provider 过滤
   该 prompt 被 vidu 的内容策略拒绝。重试同样会被拒。
   [修改 Intent]  [换 self-host 生成]  [跳过此镜]
```

**`<Toast>`** — 只用于「成功且无需后续动作」的短反馈。失败一律用 FailureCard 或 inline 错误，不用 toast——toast 会消失，错误信息不能消失。

## 7. 交互模式

**乐观入队。** 点「生成」立刻把卡片切到 `generating` 并插入队列面板，不等服务端 201。失败再回滚并提示。

**批量选择。** 镜头网格支持框选、`Shift` 连选、`Cmd/Ctrl` 点选，底部浮出批量操作条（批量生成 / 批量换 provider / 批量跳过）。

**键盘优先。** 选片和审片是重复几百次的操作，必须能脱离鼠标：

| 键 | 动作 |
|---|---|
| `J / K` | 上一个 / 下一个镜头 |
| `Space` | 播放 / 暂停预览 |
| `1..9` | 选中第 N 个 take |
| `Enter` | 确认选片并跳到下一个待审镜头 |
| `R` | 重新生成当前镜头 |
| `X` | 拒绝当前 take |
| `Shift + X` | 拒绝全部 take 并重新生成（花钱，触发 ConfirmSpend） |
| `S` | 跳过此镜（shot → `skipped`） |
| `Cmd/Ctrl + Enter` | 生成整集（触发 ConfirmSpend） |
| `?` | 快捷键帮助 |

**长任务不阻塞导航。** 任何生成任务开始后用户都能自由切页，进度由顶栏 QueueIndicator 与 SSE 维持。绝不出现「请勿关闭此页面」。

## 8. 可访问性底线

- 所有状态色配图标/文字，不依赖颜色单独传意。
- 正文对比度 ≥ 4.5:1，大字与图标 ≥ 3:1。
- 焦点环 `2px solid var(--accent)` + `2px` 偏移，不许 `outline: none`。
- 视频缩略图的自动播放预览一律静音，且尊重 `prefers-reduced-motion`（该设置下改为悬停显示静态首帧）。
- 队列与进度变更通过 `aria-live="polite"` 播报。

## 9. 技术选型

| 项 | 选择 | 理由 | 现状 |
|---|---|---|---|
| 样式 | Tailwind CSS v4 + CSS 变量令牌 | 令牌集中，类名就地，暗浅色一处切换 | ✅ 已在用 |
| 组件基座 | Radix UI Primitives | 无样式、可访问性到位，不背设计包袱 | ⛔ 未装 · 当前是手写组件 |
| 图标 | Lucide | 覆盖全、线性风格统一 | ⛔ 未装 · 当前用 Unicode 字形 |
| 表格/虚拟化 | TanStack Table + Virtual | 资产与 Ledger 列表需要 | ⚠️ 只装了 Virtual，Table 未装 |
| 图表 | Recharts | 成本与质量趋势，配 §3.4 色板 | ⛔ 未装 · 当前是 `TrendChart.tsx` 的内联 SVG |
| 状态 | TanStack Query（服务端态）+ Zustand（UI 态） | 严格区分两类状态，不混用 | ⛔ 两个都未装 · 当前是 `useState` + SSE Context |
| 播放器 | 原生 `<video>` + hls.js | 不引入重播放器，母版是标准 MP4/HLS | ⚠️ 原生 `<video>` ✅；hls.js 未装（HLS 属 M5）|
| 表单 | React Hook Form + zod resolver | 与 contracts 的 schema 直接复用 | ⛔ 未装 · 目前没有需要校验的表单 |
| **动画** | **GSAP + @gsap/react** | 面板的描线与过渡 | ✅ **已在用，但此前本表没写** |


> **「现状」列是 2026-08 实测的。** 标 ⛔ 的六项当前一个都没装，能力由手写实现顶着——
> 这不是欠债，是有意为之：面板只有五个页面，为它引六个库不划算。选型表保留下来
> 是因为它记录的是「真要引的时候引哪个、为什么」，而不是「已经引了」。
> 反过来 GSAP 是唯一一个**在用却没被文档记录**的运行时依赖，这次补上。

## 10. 目录约定

```
apps/web/
├─ app/
│  ├─ (studio)/
│  │  ├─ projects/[id]/
│  │  │  ├─ script/          剧本
│  │  │  ├─ storyboard/      分镜网格（主战场）
│  │  │  ├─ assets/          角色/场景/风格
│  │  │  ├─ review/          选片
│  │  │  ├─ timeline/        剪辑
│  │  │  └─ insights/        成本与质量
│  │  └─ layout.tsx          顶栏（CostMeter + QueueIndicator）+ 侧栏
│  └─ (watch)/watch/[episodeId]/
├─ components/               页面级组合组件
└─ lib/
   ├─ api.ts                 由 OpenAPI 生成的客户端
   └─ events.ts              SSE 订阅与事件分发
```

`packages/ui` 放纯展示、无数据依赖的组件；`apps/web/components` 放绑定了 API 的组合组件。这条边界要守住，否则 UI 包会被业务逻辑污染。
