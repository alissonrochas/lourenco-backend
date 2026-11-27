import {
  BookingHorizonError,
  BookingQuotaError,
  horizonResponse,
} from '#services/public_booking_policy'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { errors } from '@vinejs/vine'
import BookingCreationService, {
  BookingServiceUnavailableError,
  BookingSlotUnavailableError,
} from '#services/booking_creation_service'
import { createBookingValidator } from '#validators/booking'
import PublicBookingTransformer from '#transformers/public_booking_transformer'

@inject()
export default class BookingsController {
  constructor(private bookings: BookingCreationService) {}

  async store(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    try {
      if (!ctx.request.is(['application/json']))
        return ctx.response.unprocessableEntity({ message: 'Envie uma reserva JSON válida.' })
      const input = await ctx.request.validateUsing(createBookingValidator, {
        data: ctx.request.body(),
      })
      const booking = await this.bookings.create(input)
      ctx.response.status(201)
      return await ctx.serialize(PublicBookingTransformer.transform(booking))
    } catch (error) {
      if (error instanceof BookingHorizonError)
        return ctx.response.unprocessableEntity(horizonResponse(error))
      if (error instanceof BookingQuotaError)
        return ctx.response.unprocessableEntity({
          code: 'PUBLIC_BOOKING_NOT_ACCEPTED',
          message:
            'Não foi possível concluir a reserva pelo site. Entre em contato com a barbearia.',
        })
      if (
        error instanceof errors.E_VALIDATION_ERROR ||
        error instanceof BookingServiceUnavailableError
      )
        return ctx.response.unprocessableEntity({
          message: 'Dados inválidos ou serviço indisponível.',
        })
      const code = (error as { code?: string })?.code
      if (error instanceof BookingSlotUnavailableError || code === 'SQLITE_CONSTRAINT_UNIQUE')
        return ctx.response.conflict({
          message: 'Horário indisponível. Consulte os horários novamente.',
        })
      if (
        code?.startsWith('SQLITE_BUSY') ||
        code?.startsWith('SQLITE_LOCKED') ||
        code === 'E_UNABLE_TO_ACQUIRE_CONNECTION'
      )
        return ctx.response.serviceUnavailable({
          message: 'Não foi possível confirmar a reserva. Tente novamente.',
        })
      // Do not log the driver error: SQL/bindings may contain personal information.
      ctx.logger.error('Falha inesperada ao criar reserva')
      return ctx.response.internalServerError({ message: 'Não foi possível confirmar a reserva.' })
    }
  }
}
