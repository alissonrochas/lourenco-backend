import User from '#models/user'
import { BaseSeeder } from '@adonisjs/lucid/seeders'

export default class AdminSeeder extends BaseSeeder {
  async run() {
    const existingUser = await User.findBy('email', 'admin@barbearia.com')

    if (!existingUser) {
      await User.create({
        fullName: 'Gerente',
        email: 'admin@barbearia.com',
        password: 'SenhaForte123',
      })
    }
  }
}
