import {
  calendarTag,
  StaleCalendarError,
  InvalidCalendarPreconditionError,
} from '#services/calendar_precondition'
import { BookingCalendarConflictError } from '#services/booking_calendar_protection'
import type { HttpContext } from '@adonisjs/core/http'
import { errors } from '@vinejs/vine'
import BookingSettingsService, {
  InvalidBookingSettingsError,
} from '#services/booking_settings_service'
import BookingSettingsTransformer from '#transformers/booking_settings_transformer'
import { updateBookingSettingsValidator } from '#validators/booking_settings'

export default class AdminBookingSettingsController {
  private service = new BookingSettingsService()

  private async respond(
    ctx: HttpContext,
    operation: () => ReturnType<BookingSettingsService['read']>
  ) {
    ctx.response.header('Cache-Control', 'no-store')
    try {
      return await ctx.serialize(BookingSettingsTransformer.transform(await operation()))
    } catch (error) {
      if (error instanceof InvalidCalendarPreconditionError)
        return ctx.response.unprocessableEntity({ message: 'Revisão de calendário inválida.' })
      if (error instanceof StaleCalendarError)
        return ctx.response.conflict({
          message: 'O calendário foi alterado por outra operação. Recarregue antes de salvar.',
        })
      if (
        error instanceof errors.E_VALIDATION_ERROR ||
        error instanceof InvalidBookingSettingsError
      ) {
        return ctx.response.unprocessableEntity({ message: 'Configuração semanal inválida.' })
      }
      if (error instanceof BookingCalendarConflictError)
        return ctx.response.conflict({
          message:
            'A alteração conflita com reservas confirmadas. Resolva as reservas antes de alterar o calendário.',
        })
      const code = (error as { code?: string }).code ?? ''
      if (
        code.startsWith('SQLITE_CONSTRAINT') ||
        code.startsWith('SQLITE_BUSY') ||
        code.startsWith('SQLITE_LOCKED')
      ) {
        return ctx.response.conflict({
          message: 'Conflito ao salvar a configuração. Recarregue e tente novamente.',
        })
      }
      throw error
    }
  }

  index(ctx: HttpContext) {
    return this.respond(ctx, async () => {
      const result = await this.service.read()
      ctx.response.header('ETag', calendarTag(result, 'weekly'))
      return result
    })
  }

  update(ctx: HttpContext) {
    return this.respond(ctx, async () => {
      const payload = await ctx.request.validateUsing(updateBookingSettingsValidator, {
        data: ctx.request.body(),
      })
      const result = await this.service.update(payload, ctx.request.header('if-match'))
      ctx.response.header('ETag', calendarTag(result, 'weekly'))
      return result
    })
  }
}
