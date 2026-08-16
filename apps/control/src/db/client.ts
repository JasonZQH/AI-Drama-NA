import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

/**
 * 只有控制面进程可写 Postgres（ADR-0003 单写者）。
 * worker 与 API 共用连接池会耗尽连接，两侧分别配 max（11-dev-setup.md §8）。
 *
 * 返回的原始客户端刻意叫 `client` 而不是 `sql`：drizzle 也导出一个 `sql`
 * 模板标签，两者同名会让 `.where(sql\`...\`)` 静默拿到错误的那个——条件被
 * 忽略、DELETE 变成不删、UPDATE 变成不更，且不报错。这个坑踩过一次。
 */
export function createDb(url: string, max = 10) {
  const client = postgres(url, { max })
  return { db: drizzle(client, { schema }), client }
}

export type Db = ReturnType<typeof createDb>['db']
