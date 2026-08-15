/**
 * zod schema → JSON Schema，供 Python worker 生成 pydantic 模型
 * （01-architecture.md §3：TypeScript 为唯一真相源）。
 *
 * 产物进版本库，CI 比对 git diff——改了 schema 没重新生成即失败。
 * 这是「三语言类型一致」这条保证的兑现点，是 CI 的第一步。
 *
 * 两处对文档的简化，都是为了少一个依赖：
 * - zod v4 内置 z.toJSONSchema()，不需要 zod-to-json-schema
 * - 本脚本是纯 JS 并读已编译的 dist，不需要 tsx（连带不需要给 esbuild
 *   开 postinstall 白名单）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// z 从 contracts 转出而非直接 import 'zod'：pnpm 下两份 zod 副本会让 instanceof 静默失效
import * as contracts from '../packages/contracts/dist/index.js'

const { z } = contracts

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'contracts', 'generated')

/** 只导出跨语言契约，不导出纯前端类型 */
const EXPORTED = [
  'GenerationRequest',
  'GenerationResult',
  'ProviderFailure',
  'ProviderProgress',
  'ProviderCapabilities',
  'ProviderHandle',
  'RefImage',
  'ShotIntent',
  'ContinuityState',
  'FaceSet',
  'BodyRef',
  'Outfit',
  'EvalPolicy',
  'EvalSummary',
  'StudioEvent',
]

mkdirSync(OUT_DIR, { recursive: true })

const $defs = {}
const missing = []

for (const name of EXPORTED) {
  const schema = contracts[name]
  if (!(schema instanceof z.ZodType)) {
    missing.push(name)
    continue
  }
  // io: 'input' —— Python 侧是请求的构造方，带 default 的字段对它应是可选的
  $defs[name] = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
}

if (missing.length > 0) {
  console.error(`✗ 这些名字不是 zod schema 或未从 contracts 导出: ${missing.join(', ')}`)
  process.exit(1)
}

writeFileSync(
  join(OUT_DIR, 'contracts.schema.json'),
  JSON.stringify(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $comment: '由 scripts/build-contracts.mjs 从 packages/contracts/src 生成，请勿手改',
      $defs,
    },
    null,
    2,
  ) + '\n',
)

// 枚举单独出一份：Python 侧常量必须与 TS 端逐字一致
const enums = {}
for (const [name, value] of Object.entries(contracts)) {
  if (value instanceof z.ZodEnum) enums[name] = value.options
}
writeFileSync(
  join(OUT_DIR, 'enums.json'),
  JSON.stringify({ $comment: '由 scripts/build-contracts.mjs 生成，请勿手改', enums }, null, 2) + '\n',
)

console.log(
  `✓ ${EXPORTED.length} 个 schema、${Object.keys(enums).length} 个枚举 → packages/contracts/generated/`,
)
