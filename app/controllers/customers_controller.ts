import Customer from '#models/customer'
import { createCustomerValidator } from '#validators/customer'
import { isValidPhone, normalizePhone } from '#services/phone'
import type { HttpContext } from '@adonisjs/core/http'

export default class CustomersController {
  async index({ response }: HttpContext) {
    const customers = await Customer.query().orderBy('created_at', 'desc')

    return response.json(customers)
  }

  async store({ request, response }: HttpContext) {
    const payload = await request.validateUsing(createCustomerValidator)

    if (!isValidPhone(payload.phone)) {
      return response.unprocessableEntity({
        message: 'Informe um telefone válido com 10 a 15 dígitos.',
      })
    }

    const phoneNormalized = normalizePhone(payload.phone)
    const existing = await Customer.findBy('phoneNormalized', phoneNormalized)

    if (existing) {
      return response.conflict({
        message: 'Este telefone já está cadastrado para outro cliente.',
      })
    }

    try {
      const customer = await Customer.create({
        ...payload,
        phone: phoneNormalized,
        phoneNormalized,
      })
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
