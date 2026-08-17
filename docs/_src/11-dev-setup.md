# 11 · 本地开发环境搭建

> Status: Draft v1 · 2026-08-10 · 目标环境：macOS (Apple Silicon) + 可选远程 GPU

## 1. 前置要求

| 工具 | 版本 | 安装 |
|---|---|---|
| Node.js | ≥ 22 LTS | `brew install node` 或 fnm |
| pnpm | ≥ 9 | `corepack enable && corepack prepare pnpm@latest --activate` |
| Docker Desktop | 最新 | 用于 postgres / redis / minio / media worker |
| Python | 3.11 | 仅当本地开发 worker 时需要 |
| uv | 最新 | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| ffmpeg | ≥ 7 | `brew install ffmpeg`（宿主机备用，主路径走 docker） |

Apple Silicon 注意：Docker 镜像统一用 `linux/arm64`，MinIO 与 Postgres 官方都有 arm64 版本，不需要 Rosetta。

## 2. 五分钟启动（无 GPU、无 API key）

```bash
git clone <repo> ai-drama-studio && cd ai-drama-studio
pnpm install
cp .env.example .env                    # 默认即 mock provider，无需任何 key
docker compose --env-file .env -f infra/docker-compose.yml up -d
pnpm build                              # ← 必须在 migrate 之前
pnpm db:migrate
pnpm db:seed                            # demo project：1 集 / 12 镜 / 2 角色
pnpm dev                                # 起依赖 + web:3000 + control:4000 + 队列 worker，退出时停容器
```

三处容易踩的地方，都是实测过的：

- **`pnpm build` 必须排在 `db:migrate` 之前。** `db:migrate` 跑的是 `dist/db/migrate.js`，而 `dist/` 不进版本库——全新 clone 直接跑迁移会得到 `MODULE_NOT_FOUND`。这份文档此前的顺序是反的。
- **`docker compose` 要带 `--env-file .env`。** compose 默认读的是**它自己目录**（`infra/`）下的 `.env`，那里没有，于是 `${POSTGRES_PORT:-5432}` 一律取默认值；而根 `.env` 里的 `DATABASE_URL` 可能写着别的端口，容器与应用就对不上。`pnpm dev` 内部已经带了这个参数。
- **`.env` 里必须有 `CONTROL_API_KEY`**，否则控制面起不来（`06-api-spec.md` §1 的写路径闸门）。`cp .env.example .env` 已经带上了。

打开 `http://localhost:3000`，进入 demo 项目 → 分镜页 → 「生成整集」→ 十几秒后就能看到 mock 视频填充进卡片，走完 review → timeline → 渲染 → 播放的全链路。

**这一步跑通是 M0 的验收标准。** 它证明状态机、队列、SSE、存储、渲染这条主干是通的，而这一切都不需要 GPU 或云账号。

## 3. 环境变量

```bash
# ── 核心 ──
DATABASE_URL=postgresql://drama:drama@localhost:5432/drama
REDIS_URL=redis://localhost:6379
CONTROL_PORT=4000
NEXT_PUBLIC_API_BASE=http://localhost:4000

# 写路径闸门：所有非 GET 请求要带 `x-api-key: <此值>`（06-api-spec.md §1）。
# **不设它控制面起不来**——一个忘了配就自动失效的安全开关，防的只是记得配的人。
CONTROL_API_KEY=devlocal
# CONTROL_HOST=0.0.0.0                # 默认只听 127.0.0.1，要从别的设备访问才打开
# WEB_ORIGIN=http://localhost:3000    # 收紧 CORS，不设则反射任意来源

# ── 存储（见 09-python-worker.md §5.1 的双 endpoint 说明）──
S3_BUCKET=drama
S3_ACCESS_KEY=adminlocal
S3_SECRET_KEY=adminlocal123
S3_INTERNAL_ENDPOINT=http://localhost:9000     # 控制面自用
S3_PUBLIC_ENDPOINT=http://localhost:9000       # 签发给 worker/浏览器；用远程 GPU 时改 Tailscale IP
S3_FORCE_PATH_STYLE=true

# ── Worker 寻址（端口见 09-python-worker.md §2）──
MEDIA_WORKER_URL=http://localhost:8002          # FFmpeg 规范化/拼接/字幕，M0 起就要用
# EVAL_WORKER_URL=http://localhost:8003         # 自动评测，M6 启用

# ── Provider ──
DEFAULT_PROVIDER=mock
MOCK_FAILURE_RATE=0.15                          # 让重试逻辑在开发期就被触发
MOCK_SEED_DETERMINISTIC=0                       # 置 1：同 seed 返回同一条 fixture，快照测试用
# VIDU_API_KEY=
# KLING_API_KEY=
# JIMENG_API_KEY=
# SELFHOST_VIDEO_URL=http://100.x.y.z:8001
# SELFHOST_MODEL=wan2.2-ti2v-5b

# ── LLM（剧本/分镜）──
# ANTHROPIC_API_KEY=
LLM_MODEL=claude-sonnet-4-5

# ── TTS ──
TTS_PROVIDER=mock
# ELEVENLABS_API_KEY=

# ── 预算闸门（重要）──
BUDGET_DAILY_MICRO_USD=5000000                  # $5/天，防误操作烧钱
BUDGET_ON_EXCEED=block

# ── 并发 ──
MAX_GLOBAL_CONCURRENT=32
```

> `MOCK_FAILURE_RATE=0.15` 是刻意的。开发期不遇到失败，重试和错误 UI 就永远没被真正测试过，等接真 provider 时会集中爆发。

## 4. docker-compose

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: drama, POSTGRES_PASSWORD: drama, POSTGRES_DB: drama }
    ports: ["5432:5432"]
    volumes: ["./.data/pg:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL","pg_isready -U drama"]
      interval: 5s

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    command: redis-server --appendonly yes
    volumes: ["./.data/redis:/data"]

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: adminlocal, MINIO_ROOT_PASSWORD: adminlocal123 }
    ports: ["9000:9000","9001:9001"]
    volumes: ["./.data/minio:/data"]

  minio-init:
    image: minio/mc:latest
    depends_on: [minio]
    entrypoint: >
      /bin/sh -c "
      until mc alias set local http://minio:9000 adminlocal adminlocal123; do sleep 1; done;
      mc mb -p local/drama; mc anonymous set download local/drama/public; exit 0"

  media-worker:
    build: ./workers/media
    ports: ["8002:8002"]
    environment:
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: adminlocal
      S3_SECRET_KEY: adminlocal123
    depends_on: [minio]
```

MinIO 控制台 `http://localhost:9001`（adminlocal / adminlocal123）可以直接浏览生成的文件，调试媒体问题时非常有用。

## 5. 常用脚本

> **以根 `package.json` 为准。** 下表是照抄，不是设计意图——此前这里列过
> `api:types`、`db:studio`、`worker:video:mock` 三条**不存在**的命令，以及
> `contracts:build` / `db:*` / `dev` 五条与实际实现不符的写法。照着跑必然报
> `Command not found`。改脚本时记得同步这里。

| 命令 | 做什么 |
|---|---|
| `pnpm dev` | 起依赖容器 + web + control + worker，**Ctrl+C 时停容器**（`scripts/dev.sh`） |
| `pnpm dev:app` | 只起应用，不碰容器。两个终端并行时用它 |
| `pnpm build` | 全量构建。`control` 跑 `dist`，所以 migrate/seed/dev 之前都要先构建 |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | CI 门禁的前三道 |
| `pnpm test` | 单测，排除 `*.int.test.ts` |
| `pnpm test:int` | 集成测试，打真实 Postgres / Redis / MinIO |
| `pnpm contracts:build` | zod → JSON Schema → 给 Python 的生成物。**改了 contracts 必须重跑并提交**，CI 有同步门禁 |
| `pnpm db:generate` | 改了 `schema.ts` 之后生成迁移文件 |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` | 迁移 / 灌 demo 数据 / 清库重来 |

文档站另有一条不在 `package.json` 里：`python3 scripts/build-docs.py`
把 `docs/_src/*.md` 渲染成 HTML。**改了 `_src` 必须重跑并提交生成物**，CI 同样有门禁。

`contracts:build` 必须在 `dev` 之前跑一次，也应挂在 CI 的第一步——它是三语言类型一致的保证（`01-architecture.md` §3）。

## 6. 接入真实云 Provider（M1）

```bash
VIDU_API_KEY=vd_xxx
DEFAULT_PROVIDER=vidu
BUDGET_DAILY_MICRO_USD=2000000     # 先设 $2，确认计费符合预期再放宽
```

第一次务必这样做：

1. 单镜头生成（不要批量），确认产物、成本、时长都正确回填。
2. 去洞察页确认 `costMicroUsd` 有值且量级合理。
3. 用 `dryRun: true` 跑一次批量，核对预估成本。
4. 再放开批量。

**不要跳过 dryRun 直接批量。** 24 个镜头 × 3 次重试 × 单价失误 10 倍 = 一个不愉快的账单。

## 7. 接入远程 GPU（M2）

### 7.1 联网

```bash
# 两端都装 Tailscale
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
tailscale ip -4        # 记下 Mac 与 GPU 各自的 100.x 地址
```

### 7.2 启动 worker

```bash
# GPU 机器上
docker run -d --gpus all -p 8001:8001 \
  -v /data/models:/models \
  -e PRELOAD_MODELS=wan2.2-ti2v-5b \
  -e MAX_CONCURRENT=1 \
  -e IDLE_SHUTDOWN_MIN=30 \
  --name adv-video ai-drama/video-worker:latest
```

### 7.3 Mac 侧配置（关键一步）

```bash
SELFHOST_VIDEO_URL=http://100.GPU.IP:8001
S3_PUBLIC_ENDPOINT=http://100.MAC.IP:9000     # ★ 必须改成 Mac 的 Tailscale IP
```

`S3_PUBLIC_ENDPOINT` 忘了改是**最常见的失败**：控制面签出 `http://localhost:9000/...` 的预签名 URL，GPU 机器上的 `localhost` 是它自己，上传必然 404 或连接拒绝。症状是 worker 日志报上传失败但生成本身成功。

### 7.4 联调检查清单

```bash
curl http://100.GPU.IP:8001/v1/health        # 从 Mac 上能通？
curl http://100.MAC.IP:9000/minio/health/live # 从 GPU 机器上能通？
```

两条都通了再提交第一个任务，能省掉大量猜测。

## 8. 排错速查

| 症状 | 原因 | 处理 |
|---|---|---|
| 任务一直 `queued` | worker 进程没起 | `pnpm dev` 是否包含 worker 入口；查 Redis 连接 |
| 任务 `submitted` 后不动 | 轮询任务未入队 | 查 `q:poll` 队列深度；看 `05-job-orchestration.md` §4 |
| worker 生成成功但没有 take | 上传失败 | 查 `S3_PUBLIC_ENDPOINT`（见 §7.3） |
| 浏览器视频 403 | 预签名过期 | 缩短前端缓存或延长 TTL |
| 拼接后音画不同步 | 有 clip 缺音轨 | 规范化时补静音轨（`10-media-storage.md` §2.2） |
| 拼接后画面拉伸 | SAR 不一致 | 规范化时 `setsar=1` |
| 成本报表为空 | provider 未回填成本 | 检查适配器的估算兜底逻辑 |
| SSE 断连 | 中间层超时 | 确认 keepalive 帧；关闭 Next.js dev 代理缓冲 |
| Postgres 连接耗尽 | worker 与 API 共用连接池 | 分别配置 pool size，worker 侧调小 |

## 9. 代码质量基线

```
TypeScript  strict: true，禁用 any（eslint 报错级）
Python      ruff + mypy strict
提交前      lint-staged: eslint --fix + prettier + ruff format
CI          contracts:build → typecheck → test → build
测试重点     ① 状态机纯函数穷举 ② provider 契约测试 ③ 队列幂等与恢复
```

状态机与幂等这两块必须有测试——它们的 bug 在开发期几乎不可见，在生产上会表现为「莫名其妙多扣了钱」或「任务卡死」，事后极难排查。
