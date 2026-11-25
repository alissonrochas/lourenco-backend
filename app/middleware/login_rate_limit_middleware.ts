import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { checkRateLimit } from '#services/rate_limiter'

export default class LoginRateLimitMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const ip = ctx.request.ip()
    const email = String(ctx.request.input('email') || '')
      .trim()
      .toLowerCase()
    const ipResult = checkRateLimit(`login-ip:${ip}`, 30, 15 * 60 * 1000)
    const emailResult = checkRateLimit(`login-email:${ip}:${email}`, 5, 15 * 60 * 1000)
    const result = !ipResult.allowed ? ipResult : emailResult

    if (!result.allowed) {
      ctx.response.header('Retry-After', String(result.retryAfterSeconds))
      return ctx.response.tooManyRequests({
        message: 'Muitas tentativas de login. Tente novamente em alguns minutos.',
      })
    }

    ctx.response.header('X-RateLimit-Remaining', String(result.remaining))
    return next()
  }
}
