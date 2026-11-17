import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

export default class AdminAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const adminUser = ctx.session.get('admin_user')

    if (!adminUser) {
      return ctx.response.unauthorized({
        message: 'Não autenticado.',
      })
    }

    ctx.state = ctx.state || {}
    ctx.state.admin = adminUser
    return next()
  }
}
