import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import app from '@adonisjs/core/services/app'
import SessionMiddleware from '@adonisjs/session/session_middleware'
import ShieldMiddleware from '@adonisjs/shield/shield_middleware'
import type { ShieldConfig } from '@adonisjs/shield/types'
import InitializeAuthMiddleware from '@adonisjs/auth/initialize_auth_middleware'
import SilentAuthMiddleware from '#middleware/silent_auth_middleware'
import AvailabilityRateLimitMiddleware from '#middleware/availability_rate_limit_middleware'

export const PUBLIC_AVAILABILITY_ROUTE = 'public.bookingAvailability'

// Adonis sets ctx.route from the matched route BEFORE executing router middleware.
// Route identity cannot be chosen via a client header, query or URL prefix.
export function isStatelessAvailability(ctx: HttpContext) {
  return (
    ctx.request.method() === 'GET' &&
    ctx.route?.name === PUBLIC_AVAILABILITY_ROUTE &&
    ctx.route.pattern === '/api/availability'
  )
}

export class AvailabilitySessionMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (!isStatelessAvailability(ctx)) {
      const original = await ctx.containerResolver.make(SessionMiddleware)
      return original.handle(ctx, next)
    }
    // Check the budget exactly once, before session, Shield or auth initialization.
    let allowed = false
    const limited = await new AvailabilityRateLimitMiddleware().handle(ctx, async () => {
      allowed = true
    })
    const config = app.config.get<ShieldConfig>('shield')
    const encryptionManager = await ctx.containerResolver.make('encryption')
    const encryption = encryptionManager.use()
    // New configuration/instance, never mutate the shared Shield configuration.
    // CSRF is irrelevant ONLY for this matched GET; other guards still run on 429.
    const statelessShield = new ShieldMiddleware(
      { ...config, csrf: { ...config.csrf, enabled: false } },
      encryption
    )
    let output: unknown
    await statelessShield.handle(ctx, async () => {
      if (allowed) output = await next()
    })
    return allowed ? output : limited
  }
}

export class AvailabilityShieldMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (isStatelessAvailability(ctx)) return next()
    const original = await ctx.containerResolver.make(ShieldMiddleware)
    return original.handle(ctx, next)
  }
}

export class AvailabilityInitializeAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (isStatelessAvailability(ctx)) return next()
    const original = await ctx.containerResolver.make(InitializeAuthMiddleware)
    return original.handle(ctx, next)
  }
}

export class AvailabilitySilentAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (isStatelessAvailability(ctx)) return next()
    const original = await ctx.containerResolver.make(SilentAuthMiddleware)
    return original.handle(ctx, next)
  }
}

// The GET was already limited above. HEAD (automatically matched by Adonis)
// retains the original stateful pipeline AND its route-level rate limit.
export class AvailabilityRouteRateLimitMiddleware {
  handle(ctx: HttpContext, next: NextFn) {
    if (isStatelessAvailability(ctx)) return next()
    return new AvailabilityRateLimitMiddleware().handle(ctx, next)
  }
}
