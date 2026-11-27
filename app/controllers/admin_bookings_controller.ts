import { internalServerError } from '#services/http_response_policy'
import { logHttpFailure } from '#services/safe_http_logging'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { errors } from '@vinejs/vine'
import AdminBookingService, {
  AdminBookingConflictError,
  AdminBookingForbiddenError,
  AdminBookingNotFoundError,
} from '#services/admin_booking_service'
import AdminBookingTransformer from '#transformers/admin_booking_transformer'
import {
  adminBookingsQueryValidator,
  adminBookingIdValidator,
  cancelBookingValidator,
} from '#validators/admin_booking'

@inject()
export default class AdminBookingsController {
  constructor(private service: AdminBookingService) {}

  private failure(ctx: HttpContext, error: unknown) {
    if (error instanceof errors.E_VALIDATION_ERROR)
      return ctx.response.unprocessableEntity({
        message: 'Intervalo, identificador ou motivo inválido.',
      })
    if (error instanceof AdminBookingNotFoundError)
      return ctx.response.notFound({ message: 'Reserva não encontrada.' })
    if (error instanceof AdminBookingForbiddenError)
      return ctx.response.forbidden({ message: 'Acesso permitido apenas para administradores.' })
    if (error instanceof AdminBookingConflictError)
      return ctx.response.conflict({
        message: 'Somente reservas confirmadas ainda não iniciadas podem ser canceladas.',
      })
    const code = (error as { code?: string })?.code ?? ''
    if (
      code.startsWith('SQLITE_BUSY') ||
      code.startsWith('SQLITE_LOCKED') ||
      code === 'E_UNABLE_TO_ACQUIRE_CONNECTION'
    )
      return ctx.response.serviceUnavailable({
        message: 'Gestão de reservas temporariamente indisponível. Tente novamente.',
      })
    if (code.startsWith('SQLITE_CONSTRAINT'))
      return ctx.response.conflict({
        message: 'Conflito ao atualizar a reserva. Recarregue e tente novamente.',
      })
    // Do not log SQL, bindings, phone numbers or cancellation reasons.
    logHttpFailure(ctx, error, 'admin_booking_failure')
    return ctx.response.internalServerError(internalServerError)
  }

  async index(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    try {
      const raw = new URLSearchParams(ctx.request.parsedUrl.query)
      const allowed = ['from', 'to', 'page', 'perPage']
      if ([...raw.keys()].some((key) => !allowed.includes(key) || raw.getAll(key).length !== 1))
        return ctx.response.unprocessableEntity({
          message: 'Intervalo, identificador ou motivo inválido.',
        })
      const input = await ctx.request.validateUsing(adminBookingsQueryValidator, {
        data: ctx.request.qs(),
      })
      const result = await this.service.list(input)
      const payload = await ctx.serialize(AdminBookingTransformer.transform(result.bookings))
      return ctx.response.ok({ ...payload, meta: result.meta })
    } catch (error) {
      return this.failure(ctx, error)
    }
  }

  async cancel(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    try {
      const params = await adminBookingIdValidator.validate({ id: ctx.params.id })
      const input = await ctx.request.validateUsing(cancelBookingValidator, {
        data: ctx.request.body(),
      })
      const booking = await this.service.cancel(
        Number(params.id),
        input.reason,
        ctx.auth.use('web').user!.id
      )
      return await ctx.serialize(AdminBookingTransformer.transform(booking))
    } catch (error) {
      return this.failure(ctx, error)
    }
  }
}
