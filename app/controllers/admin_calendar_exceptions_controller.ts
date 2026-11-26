import {
  calendarTag,
  StaleCalendarError,
  InvalidCalendarPreconditionError,
} from '#services/calendar_precondition'
import { BookingCalendarConflictError } from '#services/booking_calendar_protection'
import type { HttpContext } from '@adonisjs/core/http'
import { errors } from '@vinejs/vine'
import CalendarExceptionsService from '#services/calendar_exceptions_service'
import { InvalidCalendarExceptionError } from '#services/calendar_exception_rules'
import CalendarExceptionsTransformer from '#transformers/calendar_exceptions_transformer'
import {
  calendarExceptionsQueryValidator,
  saveCalendarExceptionValidator,
} from '#validators/calendar_exception'

export default class AdminCalendarExceptionsController {
  private service = new CalendarExceptionsService()
  private async respond(
    ctx: HttpContext,
    operation: () => ReturnType<CalendarExceptionsService['read']>
  ) {
    ctx.response.header('Cache-Control', 'no-store')
    try {
      return await ctx.serialize(CalendarExceptionsTransformer.transform(await operation()))
    } catch (error) {
      if (error instanceof InvalidCalendarPreconditionError)
        return ctx.response.unprocessableEntity({ message: 'Revisão de calendário inválida.' })
      if (error instanceof StaleCalendarError)
        return ctx.response.conflict({
          message: 'O calendário foi alterado por outra operação. Recarregue antes de salvar.',
        })
      if (
        error instanceof errors.E_VALIDATION_ERROR ||
        error instanceof InvalidCalendarExceptionError
      )
        return ctx.response.unprocessableEntity({
          message: 'Exceção ou intervalo de calendário inválido.',
        })
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
      )
        return ctx.response.conflict({
          message: 'Conflito na configuração do calendário. Recarregue e tente novamente.',
        })
      throw error
    }
  }
  index(ctx: HttpContext) {
    return this.respond(ctx, async () => {
      const query = await ctx.request.validateUsing(calendarExceptionsQueryValidator, {
        data: ctx.request.qs(),
      })
      const result = await this.service.read(query.from, query.to)
      ctx.response.header('ETag', calendarTag(result, `dates:${query.from}:${query.to}`))
      return result
    })
  }
  store(ctx: HttpContext) {
    return this.respond(ctx, async () => {
      const input = await ctx.request.validateUsing(saveCalendarExceptionValidator, {
        data: ctx.request.body(),
      })
      const result = await this.service.save(input, ctx.request.header('if-match'))
      ctx.response.header(
        'ETag',
        calendarTag(result, `dates:${input.localDate}:${input.localDate}`)
      )
      return result
    })
  }
}
