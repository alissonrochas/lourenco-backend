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

    // A public submission does not prove ownership of this phone number.
    // Existing customer data must never be returned or overwritten here.
    if (!existing) {
      try {
        await Customer.create({
          ...payload,
          phone: phoneNormalized,
          phoneNormalized,
        })
      } catch (error) {
        const code = (error as { code?: string })?.code
        if (code !== 'SQLITE_CONSTRAINT_UNIQUE') {
          throw error
        }

        // Another request may have inserted this phone after our lookup.
        // Also respect the original phone index for legacy rows with a NULL normalized phone.
        const duplicate = await Customer.query()
          .where('phoneNormalized', phoneNormalized)
          .orWhere('phone', phoneNormalized)
          .first()

        if (!duplicate) {
          throw error
        }
      }
    }

    response.header('Cache-Control', 'no-store')
    return response.ok({ message: 'Solicitação recebida.' })
  }
}
