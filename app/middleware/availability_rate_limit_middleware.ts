import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { checkRateLimit } from '#services/rate_limiter'

export default class AvailabilityRateLimitMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    ctx.response.header('Cache-Control', 'no-store')
    // Delegate proxy trust to Adonis/TRUST_PROXY; never read an IP header directly.
    const result = checkRateLimit(`availability-ip:${ctx.request.ip()}`, 60, 60 * 1000)
    if (!result.allowed) {
      ctx.response.header('Retry-After', String(result.retryAfterSeconds))
      return ctx.response.tooManyRequests({
        message: 'Muitas consultas. Aguarde antes de tentar novamente.',
      })
    }
    return next()
  }
}
