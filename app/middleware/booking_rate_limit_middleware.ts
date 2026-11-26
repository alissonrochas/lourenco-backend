import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { checkRateLimit } from '#services/rate_limiter'

export default class BookingRateLimitMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    ctx.response.header('Cache-Control', 'no-store')
    const result = checkRateLimit(`booking-ip:${ctx.request.ip()}`, 10, 60 * 1000)
    if (!result.allowed) {
      ctx.response.header('Retry-After', String(result.retryAfterSeconds))
      return ctx.response.tooManyRequests({
        message: 'Muitas tentativas. Aguarde antes de tentar novamente.',
      })
    }
    return next()
  }
}
