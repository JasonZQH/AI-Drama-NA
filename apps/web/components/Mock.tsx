/**
 * mock 数据标记。
 *
 * 面板上的 `$0.65` 和真实账单上的 `$0.65` 长得一模一样。不标出来就是在撒谎，
 * 而「每可用镜头成本」这类数字是会被拿去做决策的——M0 全部由 mock provider
 * 生成，成本是固定档位的假数，一次通过率也是注入的确定性结果。
 *
 * 判据由后端给（`mockCostMicroUsd`），不在前端猜。
 */
export function MockChip({ partial }: { partial?: boolean }): React.ReactElement {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-sm px-1 text-[10px] leading-4 tracking-wide"
      style={{
        background: 'color-mix(in srgb, var(--status-review) 18%, transparent)',
        color: 'var(--status-review)',
        border: '1px solid color-mix(in srgb, var(--status-review) 35%, transparent)',
      }}
      title={
        partial ? '部分数据来自 mock provider，成本非真实计费' : '数据来自 mock provider，成本非真实计费'
      }
    >
      {partial ? '含 MOCK' : 'MOCK'}
    </span>
  )
}

/** 全部 / 部分 / 没有 mock 成分。total 为 0 时不标——没有花费就没有可误读的数字 */
export function mockLevel(totalMicroUsd: number, mockMicroUsd: number): 'none' | 'partial' | 'all' {
  if (totalMicroUsd <= 0 || mockMicroUsd <= 0) return 'none'
  return mockMicroUsd >= totalMicroUsd ? 'all' : 'partial'
}

/** 成本 + 自动 mock 标记。所有显示金额的地方都走它，免得漏标 */
export function Cost({
  microUsd,
  mockMicroUsd,
  className,
}: {
  microUsd: number
  mockMicroUsd?: number
  className?: string
}): React.ReactElement {
  const level = mockLevel(microUsd, mockMicroUsd ?? 0)
  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ''}`}>
      <span className="tnum">${(microUsd / 1_000_000).toFixed(2)}</span>
      {level !== 'none' && <MockChip {...(level === 'partial' ? { partial: true } : {})} />}
    </span>
  )
}
