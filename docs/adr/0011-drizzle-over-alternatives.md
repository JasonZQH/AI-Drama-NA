# ADR-0011 · 数据层用 Drizzle，裸 SQL 校验留给 SafeQL

- **状态**：已接受
- **日期**：2026-08-15
- **相关**：`02-data-model.md`、ADR-0003、ADR-0010

## 背景

Drizzle 在此前的文档里只出现过五次，全是顺带提及（`02` 的文件头、`01` 的目录树、README 技术栈表、`11` 的两条脚本），**从未论证过**。而 BullMQ、gRPC、微服务这些同量级的决定各有一篇 ADR。ORM 选型会渗透进每一行数据访问代码，这个缺口不合格。

触发这次补论证的是一个真实事故：seed 声称幂等却跑两次翻倍。根因是 `createDb` 返回的 postgres.js 客户端叫 `sql`，与 drizzle 的 `sql` 模板标签同名，`.where(sql\`...\`)` 静默拿到了错的那个，生成 `delete from "projects" where $1`——**不报错、count=0、一行没删**。

## 决策

**继续用 Drizzle（`drizzle-orm` + `drizzle-kit`）承担 schema 定义、迁移生成与常规查询。裸 SQL 的类型校验推迟到 M1，届时引入 SafeQL。**

## 理由

### 只有 Drizzle 同时满足三条约束

| 约束 | Drizzle | Kysely | Prisma / TypeORM / MikroORM |
|---|---|---|---|
| ① schema 类型接上 contracts 的 zod | `$type<ShotStatus>()` ✅ | `ColumnType<ShotStatus>` ✅ | ❌ 各自的 DSL/装饰器成为第二真相源 |
| ② 迁移从 schema 差异生成、SQL 进版本库 | `drizzle-kit generate` ✅ | ❌ **设计上拒绝** | 🔶 有，但绑在自己的 DSL 上 |
| ③ 不挡裸 SQL | ✅ | ✅ | ❌ 弱项 |

**约束 ② 是决定性的。** Kysely 不是「暂时没做 diff 生成」，是设计上不做：官方 `FileMigrationProvider` 的扩展名白名单**不收 `.sql`**，文档要求迁移「frozen in time」并用 `Kysely<any>`。补救要引入 Atlas（Go 二进制 + HCL），那是第二个真相源，也违反「单人开发不引入需专职维护的东西」。

### 引发这次评估的那个坑，换库拿不到任何收益

实测：把 postgres.js 的 `sql` 片段传进 Kysely 的 `.where()`，编译出 `delete from "generation_jobs" where $1`，**与 Drizzle 逐字节相同**，同样不报错、`numDeletedRows=0n`、行数不变。

这是**所有 query builder 的共性面**，不是 Drizzle 的缺陷。且 Drizzle 1.0 也没修（对 1.0.0-rc.4 复现，输出一致）。

真正让它溜过去的是 `as never` 压掉了类型错误——所以缓解措施是 eslint 规则（本 ADR 同批落地），不是换库。

### Prisma 的 DSL 是 ADR-0010 拒绝 proto 的同一类问题，且更严重

`.prisma` 文件会成为第二个 schema 声明源，切断 `zod → JSON Schema → pydantic` 这条主线。proto 只影响线路格式，`.prisma` 直接和 zod 争夺**进程内领域类型**的所有权。另：Prisma 至今无法把外部 TS 类型绑到列上（issue #7081 自 2021 年 open）。

### 「zod schema → DB schema」这条理想路线目前不存在可用实现

对本项目最理想的形态是让 contracts 成为唯一真相源、DB schema 由它派生。实查结果：zodgres（停更 2025-08，周下载 17）、@datazod/zod-sql（停更 2025-05，周下载 33）、zod-pg（活跃但方向相反，DB → zod）。16 张表压在这类包上是单人开发最不该做的赌。

## 备选与否决理由

| 方案 | 否决原因 |
|---|---|
| **Kysely** | 设计上不做 schema diff 迁移，补救需引入 Atlas 作第二真相源。且实测连本项目踩的 `sql` 撞名坑都一模一样 |
| **Prisma 7** | `.prisma` DSL 成为第二 schema 真相源；无法绑外部 TS 类型到列；裸 SQL 是弱项 |
| **TypeORM 1.1** | decorator/entity 模型让真相源变成装饰器类。（注：它已结束多年的 0.3.x，值得知道，但不改变结论） |
| **MikroORM 7** | 唯一真正接近的——`$type<T>()` 存在，`em.getKysely()` 写分析查询体验甚至更好。但要为单写者控制面买下 Identity Map + Unit of Work 的认知成本 |
| **裸 SQL + 手写类型** | 手写行类型的漂移不是理论问题：实测在本仓库断言一个不存在的列 + 全部列类型写错，`tsc` 完全通过。而 Ledger 查询里 `count(*)→string`、`numeric→string` 正是必错处，错了就是算钱静默出错 |
| **pgtyped** | 实质停更（17 个月无发布，近 100 次提交只有 13 次是人写的），且 peer `typescript: 3.1 - 5` 会把项目钉死在 TS 5 |

## 后果

**正面**：schema 即类型源且接得上 contracts；迁移自动生成并进版本库；不挡裸 SQL，Ledger 分析查询可直接手写。

**负面**（逐条都是已核实的事实，不粉饰）：
- 稳定线 `0.45.2` 自 2026-03-27 冻结，至今 4.6 个月无更新；全部开发火力在 `1.0.0-rc`（rc.5 于 2026-08-12）。`^0.45.2` 的 caret 锁在 `<0.46.0`，**永远拿不到 1.0**
- 1.0 已处 RC 状态 17 个月，无 GA 日期；1378 个 open issue，新开:关闭约 2:1
- 1.0 会改迁移文件结构（取消 `journal.json`、按文件夹重组、迁移表加列），届时是一次真实迁移
- query builder 固有的静默失败面：除本次踩到的 `sql` 撞名外，还有 `.where(and(...))` 在条件全为 `undefined` 时**生成无 WHERE 子句的全表删除**，且类型完全干净（已实测复现）

**缓解**：
- eslint 禁 `as never` 与 `as unknown as T`（`eslint.config.js` 的 `assertionRules`），堵掉让第一类事故成立的那道口子
- `createDb` 返回的原始客户端命名为 `client` 而非 `sql`，从源头消除同名冲突
- 涉及删改的 `.where()` 一律不接受可能为 `undefined` 的条件——这条目前靠 review，M1 有真实业务查询后应做成 lint 规则

## 关于 SafeQL：本阶段不引入，M1 引入

`@ts-safeql/eslint-plugin` 在 lint 期把裸 SQL 送到真 Postgres 上 prepare（只发 Parse + Describe，**不发 Bind/Execute**，故不执行查询），并结合 libpg-query 的 AST 与系统目录内省推出结果类型。它能补上 Drizzle 结构性给不了的东西：`db.execute<T>()` 的泛型今天是**无校验断言**——实测断言一个不存在的表和列，`tsc` 退出码 0。

**为何推迟到 M1**：M0 尚无任何裸查询，Ledger 分析查询在 M1 洞察页才落地，收益此时为零。而代价是实打实的——lint 从此依赖可达的 Postgres（连不上是全线报错，没有降级）、`databaseUrl` 模式下 schema 缓存不失效（改表后须重启 ESLint server）、影子库不自动清理、周下载 21k vs drizzle 18M。

**届时必须先处理的两个已知盲区**（实测）：
- `percentile_cont(...) WITHIN GROUP (...)` 被推成 `unknown | null`（它主动跳过所有参数签名含 `ORDER BY` 的函数），需写成 `(...)::float8`
- `nullif(a, b)` 被推成 `boolean` —— 这是**错的类型而非 unknown**，比推不出来更危险，需显式 cast

## 重新评估的触发条件

满足任意两条即重新评估数据层：

1. Drizzle 1.0 发布 GA，且迁移路径清晰（届时应尽早迁——迁移文件越少越便宜）
2. 稳定线冻结超过 12 个月，或仓库出现明确的维护中断信号
3. 因 query builder 的静默失败面导致的生产事故累计 ≥2 次（本次为第 1 次）
4. 出现「zod schema → DB schema → 迁移」的成熟实现（周下载 ≥10k 且维护活跃），使 contracts 能真正成为唯一真相源
5. 需要 Drizzle 表达不了的 Postgres 特性，且掉裸 SQL 的比例超过一半
