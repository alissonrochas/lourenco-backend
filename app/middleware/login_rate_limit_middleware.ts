import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { checkRateLimit } from '#services/rate_limiter'

export default class LoginRateLimitMiddleware {
  private limited(ctx: HttpContext, retryAfterSeconds: number) {
    ctx.response.header('Retry-After', String(retryAfterSeconds))
    return ctx.response.tooManyRequests({
      message: 'Muitas tentativas de login. Tente novamente em alguns minutos.',
    })
  }

  async handle(ctx: HttpContext, next: NextFn) {
    const ip = ctx.request.ip()
    const ipResult = checkRateLimit(`login-ip:${ip}`, 30, 15 * 60 * 1000)
    if (!ipResult.allowed) return this.limited(ctx, ipResult.retryAfterSeconds)

    // Do not even read/normalize the email once the IP budget has been refused.
    const email = String(ctx.request.input('email') || '')
      .trim()
      .toLowerCase()
    const emailResult = checkRateLimit(`login-email:${ip}:${email}`, 5, 15 * 60 * 1000)
    if (!emailResult.allowed) return this.limited(ctx, emailResult.retryAfterSeconds)

    ctx.response.header('X-RateLimit-Remaining', String(emailResult.remaining))
    return next()
  }
}
