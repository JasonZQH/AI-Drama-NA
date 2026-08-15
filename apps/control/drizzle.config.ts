import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://drama:drama@localhost:5432/drama',
  },
  // 迁移文件进版本库，禁止手改线上库（02-data-model.md §9）
  strict: true,
  verbose: true,
})
