import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import User from '#models/user'

export default class AdminAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const adminUser = ctx.session.get('admin_user')

    if (!adminUser?.id) {
      return ctx.response.unauthorized({
        message: 'Não autenticado.',
      })
    }

    const user = await User.find(adminUser.id)

    if (!user || user.role !== 'admin') {
      ctx.session.forget('admin_user')

      return ctx.response.forbidden({
        message: 'Acesso permitido apenas para administradores.',
      })
    }

    return next()
  }
}
