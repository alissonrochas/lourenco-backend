import Customer from '#models/customer'
import { createCustomerValidator } from '#validators/customer'
import type { HttpContext } from '@adonisjs/core/http'

export default class CustomersController {
  async index({ response }: HttpContext) {
    const customers = await Customer.query().orderBy('created_at', 'desc')

    return response.json(customers)
  }

  async store({ request, response }: HttpContext) {
    const payload = await request.validateUsing(createCustomerValidator)

    try {
      const customer = await Customer.create(payload)
      return response.created(customer)
    } catch (error: any) {
      if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return response.conflict({
          message: 'Este telefone já está cadastrado para outro cliente.',
        })
      }

      throw error
    }
  }
}
