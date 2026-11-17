import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import User from '#models/user'

export default class AdminAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const guard = ctx.auth.use('web')

    if (!guard.isAuthenticated) {
      return ctx.response.unauthorized({
        message: 'Não autenticado.',
      })
    }

    const user = await User.find(guard.user!.id)

    if (!user || user.role !== 'admin') {
      await guard.logout()

      return ctx.response.forbidden({
        message: 'Acesso permitido apenas para administradores.',
      })
    }

    return next()
  }
}
