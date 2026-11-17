import env from '#start/env'
import User from '#models/user'
import { BaseSeeder } from '@adonisjs/lucid/seeders'

export default class AdminSeeder extends BaseSeeder {
  async run() {
    const email = env.get('ADMIN_EMAIL')
    const password = env.get('ADMIN_PASSWORD')

    if (!email || !password) {
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be configured before seeding the administrator')
    }

    const existingUser = await User.findBy('email', email)

    if (existingUser) {
      existingUser.role = 'admin'
      await existingUser.save()
      return
    }

    await User.create({
      fullName: 'Gerente',
      email,
      password,
      role: 'admin',
    })
  }
}
