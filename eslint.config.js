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
      // 控制面处理钱与长任务，隐式 any 会让状态机的错误悄悄溜过去（11-dev-setup.md §9）
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // domain/ 必须零 IO，才能被穷举测试而无需起数据库（01-architecture.md §5.1）
    files: ['apps/control/src/domain/**'],
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
