import { z } from 'zod'

/**
 * 评测分层的意义是**便宜的检查先跑**——T0 用几毫秒挡掉的东西，
 * 不该浪费 VLM 的钱（03-pipeline.md §4）。
 *
 * MVP 只实现 T0 + T4（技术校验 + 人工选片）；T1–T3 的表结构与接口
 * 在 M6 之前留空跑通，避免后期改数据模型。
 */
export const EvalPolicy = z.object({
  t0: z.object({
    requireDecodable: z.boolean().default(true),
    durationToleranceSec: z.number().nonnegative().default(0.5),
    maxBlackFrameRatio: z.number().min(0).max(1).default(0.1),
  }),
  t2: z.object({
    identitySimMin: z.number().min(0).max(1).default(0.72),
    styleSimMin: z.number().min(0).max(1).default(0.65),
  }),
  t3: z.object({
    intentMatchMin: z.number().min(0).max(1).default(0.7),
  }),
  maxAttemptsPerShot: z.number().int().positive().default(4),
})
export type EvalPolicy = z.infer<typeof EvalPolicy>

export const defaultEvalPolicy: EvalPolicy = {
  t0: { requireDecodable: true, durationToleranceSec: 0.5, maxBlackFrameRatio: 0.1 },
  t2: { identitySimMin: 0.72, styleSimMin: 0.65 },
  t3: { intentMatchMin: 0.7 },
  maxAttemptsPerShot: 4,
}

/**
 * takes.evalSummary 的 jsonb 载荷。文档只声明了字段名未给结构（见 issue #4），
 * 这是最小可用定义：够回答「过没过、卡在哪一层、哪几项没过」。
 */
export const EvalSummary = z.object({
  passed: z.boolean(),
  /** 已跑到的最高层，0..4 */
  highestTierRun: z.number().int().min(0).max(4),
  failedChecks: z.array(z.string()).default([]),
  /** checkName → score，仅记录有数值的检查 */
  scores: z.record(z.string(), z.number()).default({}),
})
export type EvalSummary = z.infer<typeof EvalSummary>
