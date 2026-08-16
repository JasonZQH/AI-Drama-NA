#!/bin/sh
# 起依赖 → 起应用 → 退出时停容器。
#
# 为什么是 shell 脚本而不是 Makefile：这仓库的入口全部是 pnpm script，CI 直接调
# `pnpm lint` / `pnpm test` / `docker compose`。再加一套 make 就是第二套编排，
# 而 CI 不会用它——两边必然漂移。这里真正需要的只有一句 trap。
#
# 为什么是 stop 而不是 down：down 会删掉容器，下次要重建；stop 保留容器与
# ./.data，重启只付健康检查的时间。数据本来就在卷里，删容器不会更干净。
set -e

# 下面的路径全部相对仓库根（--env-file .env 尤其）。pnpm 会在根目录执行，
# 但直接 `sh scripts/dev.sh` 时 CWD 可能是别处，那样只会得到一个难懂的报错。
cd "$(dirname "$0")/.."

# --env-file 指向根 .env：compose 默认读的是 compose 文件所在目录（infra/）下的
# .env，那里没有，于是 ${POSTGRES_PORT:-5432} 一律取默认值——而根 .env 里的
# DATABASE_URL 写的是 5433。不加这个参数，容器起在 5432、应用连 5433，必然连不上。
# 这也是「所有配置只在根 .env」这条规矩在 compose 这一层的落点。
C="docker compose --env-file .env -f infra/docker-compose.yml"

# 一次性任务不能进 --wait 列表：容器退出会被判定为失败，即使 exit 0。
# 与 .github/workflows/ci.yml 同一口径。
$C up -d --wait postgres redis minio
$C run --rm minio-init >/dev/null

# 同时开两个终端时（比如另一个跑 dev:worker），第二个 Ctrl+C 会把基础设施
# 从第一个脚下抽走。那种场景用 KEEP_INFRA=1 起后来的那个。
if [ -z "$KEEP_INFRA" ]; then
  trap '$C stop' EXIT   # Ctrl+C（SIGINT）与正常退出、崩溃退出都走这里
fi

turbo run dev --parallel
