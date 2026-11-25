import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { checkRateLimit } from '#services/rate_limiter'

export default class CustomerRateLimitMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const ip = ctx.request.ip()
    const key = `customer-ip:${ip}`
    const result = checkRateLimit(key, 20, 60 * 1000)

    if (!result.allowed) {
      ctx.response.header('Retry-After', String(result.retryAfterSeconds))
      return ctx.response.tooManyRequests({
        message: 'Muitas tentativas de cadastro. Aguarde antes de tentar novamente.',
      })
    }

    ctx.response.header('X-RateLimit-Remaining', String(result.remaining))
    return next()
  }
}
