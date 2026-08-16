// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * 模块边界靠构建期强制，不靠自觉（01-architecture.md §5.2）。
 * 这里是第一层；第二层是 pnpm workspace 的包边界，第三层是 dependency-cruiser
 * ——后者等 apps/control 存在、有依赖方向可校验时再加。
 */
const boundaryRules = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['**/domain/internal/*'],
          message: 'domain 只能通过 index.ts 的公开导出访问（01-architecture.md §5.1）',
        },
        {
          group: ['@vidu/*', '@kling/*', '@volcengine/*', 'elevenlabs'],
          message: '厂商 SDK 只能出现在 providers/ 的适配器实现里（ADR-0002）',
        },
      ],
    },
  ],
}

/**
 * 断言防护。
 *
 * 起因是一个真实事故：`db.delete(x).where(sql`...` as never)` —— 那个 `as never`
 * 压掉了本该报错的类型检查，drizzle 于是把驱动的 Query 对象当成参数值，生成
 * `delete from "projects" where $1`，**不报错、count=0、一行没删**。
 * 唯一能在编译期拦住它的机制，被我亲手关掉了。
 *
 * `as any` 与 `<any>x` 已由 no-explicit-any 覆盖（实测确认）；这里补另外两种。
 * 需要逃生舱时用 eslint-disable-next-line 并写明理由——代价是必须说出口。
 */
const assertionRules = {
  'no-restricted-syntax': [
    'error',
    {
      selector: 'TSAsExpression > TSNeverKeyword',
      message:
        '禁止 `as never`：它会静默压制真实的类型错误。若确有必要，用 eslint-disable-next-line 并写明为什么这里是安全的。',
    },
    {
      selector: 'TSAsExpression > TSAsExpression > TSUnknownKeyword',
      message:
        '禁止 `as unknown as T` 双重断言：它绕过所有类型检查。先问「为什么类型对不上」，那通常才是真正的 bug。',
    },
  ],
}

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/.turbo/**', 'docs/**', '.venv/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 构建脚本跑在 Node 上。只声明真正用到的两个全局，不为此引入 globals 包
    files: ['**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    rules: {
      ...boundaryRules,
      ...assertionRules,
      // 控制面处理钱与长任务，隐式 any 会让状态机的错误悄悄溜过去（11-dev-setup.md §9）
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // domain/ 与状态机必须零 IO，才能被穷举测试而无需起数据库（01-architecture.md §5.1）。
    // shotMachine 在 pipeline/ 下（文档指定的位置），但它自称纯函数——这条得可执行。
    files: ['apps/control/src/domain/**', 'apps/control/src/pipeline/shotMachine.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/db/*', '**/db'], message: 'domain 必须零 IO，不得访问数据库层' },
            {
              group: ['**/providers/*'],
              message: 'domain 不得直接调用 provider，副作用由 Effect[] 返回给调用方',
            },
          ],
        },
      ],
    },
  },
)
