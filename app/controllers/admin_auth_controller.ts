import User from '#models/user'
import { loginValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'

export default class AdminAuthController {
  async login({ request, response, auth }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)

    let user: User

    try {
      user = await User.verifyCredentials(email, password)
    } catch (_error) {
      return response.unauthorized({
        message: 'Credenciais inválidas.',
      })
    }

    if (user.role !== 'admin') {
      return response.forbidden({
        message: 'Acesso permitido apenas para administradores.',
      })
    }

    await auth.use('web').login(user)

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

  async me({ response, auth }: HttpContext) {
    const guard = auth.use('web')

    if (!guard.isAuthenticated) {
      return response.unauthorized({
        message: 'Não autenticado.',
      })
    }

    const user = await User.find(guard.user!.id)

    if (!user || user.role !== 'admin') {
      await guard.logout()

      return response.forbidden({
        message: 'Acesso permitido apenas para administradores.',
      })
    }

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

  async logout({ response, auth, session }: HttpContext) {
    await auth.use('web').logout()
    session.clear()
    session.regenerate()

    return response.json({ ok: true })
  }
}
