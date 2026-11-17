import User from '#models/user'
import { loginValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'

export default class AdminAuthController {
  async login({ request, response, session }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)
    const user = await User.verifyCredentials(email, password)

    if (user.role !== 'admin') {
      return response.forbidden({
        message: 'Acesso permitido apenas para administradores.',
      })
    }

    session.put('admin_user', {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
    })

    return response.json({
      ok: true,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
    })
  }

  async me({ response, session }: HttpContext) {
    const adminUser = session.get('admin_user')

    if (!adminUser) {
      return response.unauthorized({
        message: 'Não autenticado.',
      })
    }

    return response.json({
      ok: true,
      user: adminUser,
    })
  }

  async logout({ response, session }: HttpContext) {
    session.forget('admin_user')

    return response.json({ ok: true })
  }
}
