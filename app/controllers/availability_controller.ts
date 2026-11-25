import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { errors } from '@vinejs/vine'
import BookingAvailabilityService from '#services/booking_availability_service'
import { InvalidAvailabilityInputError } from '#services/booking_availability_engine'
import { publicAvailabilityValidator } from '#validators/booking_availability'
import PublicAvailabilityTransformer from '#transformers/public_availability_transformer'

@inject()
export default class AvailabilityController {
  constructor(private availability: BookingAvailabilityService) {}

  async index(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    // Reject repeated keys before query-parser normalization, even identical ones.
    const query = new URLSearchParams(ctx.request.parsedUrl.query)
    if (query.getAll('date').length !== 1 || [...query.keys()].some((key) => key !== 'date')) {
      return ctx.response.unprocessableEntity({
        message: 'Informe uma única data válida no formato YYYY-MM-DD.',
      })
    }
    try {
      const input = await ctx.request.validateUsing(publicAvailabilityValidator, {
        data: ctx.request.qs(),
      })
      const result = await this.availability.calculate(input.date)
      return await ctx.serialize(PublicAvailabilityTransformer.transform(result))
    } catch (error) {
      if (
        error instanceof errors.E_VALIDATION_ERROR ||
        error instanceof InvalidAvailabilityInputError
      ) {
        return ctx.response.unprocessableEntity({
          message: 'Informe uma única data válida no formato YYYY-MM-DD.',
        })
      }
      ctx.logger.error({ err: error }, 'Falha ao consultar disponibilidade')
      return ctx.response.serviceUnavailable({
        message: 'Não foi possível consultar os horários. Tente novamente.',
      })
    }
  }
}
