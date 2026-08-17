import type { FastifyInstance } from 'fastify'

/**
 * 统一错误体（06-api-spec.md §8）。
 * requestId 贯穿日志，报错时截图给出即可定位全链路。
 */
export const ERROR_CODES = {
  INVALID_STATE_TRANSITION: 400,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BUDGET_EXCEEDED: 402,
  RATE_LIMITED: 429,
  NO_PROVIDER_AVAILABLE: 503,
  /**
   * 我们依赖的某个进程不可达（media worker、将来的 GPU worker）。
   *
   * 与 CONFLICT 分开是因为处置动作完全不同：503 是「去把服务起起来」，
   * 409 是「这一集的数据有问题」。此前 media worker 没起时回的是
   * `409 CONFLICT: fetch failed`——两条信息都是错的。
   */
  DEPENDENCY_UNAVAILABLE: 503,
} as const

export type ErrorCode = keyof typeof ERROR_CODES

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * zod 的错误不在 Fastify 的错误类型里，但直接 `as` 过去是在压制信号。
 * 写成真正的类型守卫：既通过了断言防护（ADR-0011），也真的检查了形状。
 */
function hasZodIssues(e: unknown): e is { issues: unknown[] } {
  return typeof e === 'object' && e !== null && Array.isArray((e as { issues?: unknown }).issues)
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(ERROR_CODES[err.code]).send({
        error: { code: err.code, message: err.message, details: err.details ?? {}, requestId: req.id },
      })
    }

    // zod 校验失败：给字段级错误，前端才能定位到具体输入框
    if (hasZodIssues(err)) {
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: '入参校验失败',
          details: { issues: err.issues },
          requestId: req.id,
        },
      })
    }

    req.log.error({ err }, '未处理的错误')
    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
        details: {},
        requestId: req.id,
      },
    })
  })

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `${req.method} ${req.url} 不存在`,
        details: {},
        requestId: req.id,
      },
    }),
  )
}
