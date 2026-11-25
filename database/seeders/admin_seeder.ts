import env from '#start/env'
import User from '#models/user'
import { BaseSeeder } from '@adonisjs/lucid/seeders'

export default class AdminSeeder extends BaseSeeder {
  async run() {
    const email = env.get('ADMIN_EMAIL')

    if (!email) {
      throw new Error('ADMIN_EMAIL must be configured to seed an administrator')
    }

    const existingUser = await User.findBy('email', email)

    if (existingUser) {
      if (existingUser.role !== 'admin') {
        throw new Error(
          'An existing user already owns ADMIN_EMAIL; refusing to promote it to admin'
        )
      }

      return
    }

    const password = env.get('ADMIN_PASSWORD')

    if (!password || password.length < 8) {
      throw new Error('ADMIN_PASSWORD must contain at least 8 characters')
    }

    await User.create({
      fullName: 'Gerente',
      email,
      password,
      role: 'admin',
    })
  }
}
