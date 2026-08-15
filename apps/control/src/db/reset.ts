import { createDb } from './client.js'

/**
 * 把库清回全新状态。
 *
 * **必须同时删 drizzle schema**：迁移记录表在那里，只删 public 会让迁移器
 * 认为 0000 已应用过——于是 migrate 报「完成」，而一张表都没建。这个坑
 * 静默且极具误导性，所以 reset 独立成一条命令，不要手写 DROP SCHEMA。
 */
const url = process.env['DATABASE_URL']
if (!url) throw new Error('DATABASE_URL 未设置')
if (process.env['NODE_ENV'] === 'production') throw new Error('拒绝在 production 执行 reset')

const { client } = createDb(url, 1)
await client`DROP SCHEMA IF EXISTS public CASCADE`
await client`DROP SCHEMA IF EXISTS drizzle CASCADE`
await client`CREATE SCHEMA public`
await client.end()
console.log('✓ 数据库已重置（public + drizzle 两个 schema）')
