import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client.js'

const url = process.env['DATABASE_URL']
if (!url) throw new Error('DATABASE_URL 未设置')

const { db, client } = createDb(url, 1)
await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname })
await client.end()
console.log('✓ 迁移完成')
