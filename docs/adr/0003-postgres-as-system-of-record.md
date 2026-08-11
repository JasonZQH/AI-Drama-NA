# ADR-0003 · Postgres 为唯一真相源，Redis 仅作队列

- **状态**：已接受
- **日期**：2026-08-10
- **相关**：`02-data-model.md`、`05-job-orchestration.md`

## 背景

系统有大量长时任务（几十秒到几分钟）、有金钱成本（每次生成几分到几美元）。需要决定任务状态存哪里。

## 决策

**Postgres 存所有业务状态与生成记账；Redis 只做 BullMQ 队列与临时进度缓存。Redis 数据可以随时丢失。**

控制面启动时执行 reconcile：从 Postgres 捞出所有非终态任务，重建 Redis 中的队列条目。

## 理由

一次生成可能花掉几美元。**这类状态不能只存在一个可以随时被 flush 的内存数据库里。** Redis 崩溃、被误清、内存淘汰策略触发，都会导致「钱花了但不知道花在哪」。

Postgres 还提供了 Redis 给不了的东西：`generation_jobs` 上的分析查询（每可用镜头成本、按 provider × shotType 的通过率）需要真正的 SQL，包括 `percentile_cont`、多表 join、时间窗口聚合。这些是路由决策的数据基础。

JSONB 让 provider 私有参数不需要频繁改表，同时可查询字段（provider_id、status、model_id）保持为真正的列并建索引。

## 备选与否决理由

| 方案 | 否决原因 |
|---|---|
| Redis 存任务状态 | 持久性不足；无法做分析查询 |
| SQLite | 单写者限制；worker 与 API 并发写会锁；无 JSONB 索引 |
| MongoDB | 需要跨表事务（job + take + asset 原子创建）；关系查询弱 |
| 事件溯源 | 对当前规模是过度设计 |

## 后果

**正面**：任务不会因进程重启丢失；分析能力强；事务保证 job/take/asset 一致创建。
**负面**：多一个必须运行的服务；写入延迟高于 Redis。
**缓解**：进度这类高频低价值更新只写 Redis 并经 SSE 广播，不写库；只有状态跃迁才落库。
