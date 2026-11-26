import vine from '@vinejs/vine'
import type { Infer } from '@vinejs/vine/types'
import { calendarDayNumber, isLocalCalendarDate } from '#services/calendar_exception_rules'

const realDate = vine.createRule((value, _options, field) => {
  if (!isLocalCalendarDate(value)) field.report('Data local inválida.', 'localDate', field)
})
const queryShape = vine.createRule((value, _options, field) => {
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['from', 'to', 'page', 'perPage'].includes(key)))
    field.report('Parâmetro desconhecido.', 'bookingQuery', field)
  if (isLocalCalendarDate(input.from) && isLocalCalendarDate(input.to)) {
    const difference = calendarDayNumber(input.to) - calendarDayNumber(input.from)
    if (difference < 0 || difference >= 31)
      field.report('Consulte até 31 dias inclusivos.', 'bookingRange', field)
  }
})
const boundedInteger = vine.createRule((value, options: { max: number }, field) => {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > options.max
  )
    field.report('Inteiro positivo inválido.', 'boundedInteger', field)
})
const reasonShape = vine.createRule((value, _options, field) => {
  if (Object.keys(value as object).some((key) => key !== 'reason'))
    field.report('Campos não permitidos.', 'cancellationShape', field)
})
export const adminBookingsQueryValidator = vine.create(
  vine
    .object({
      from: vine.string().use(realDate()),
      to: vine.string().use(realDate()),
      page: vine
        .string()
        .use(boundedInteger({ max: 10000 }))
        .optional(),
      perPage: vine
        .string()
        .use(boundedInteger({ max: 100 }))
        .optional(),
    })
    .use(queryShape())
)
export const adminBookingIdValidator = vine.create({
  id: vine.string().use(boundedInteger({ max: Number.MAX_SAFE_INTEGER })),
})
export const cancelBookingValidator = vine.create(
  vine.object({ reason: vine.string().trim().minLength(1).maxLength(500) }).use(reasonShape())
)
export type AdminBookingsQuery = Infer<typeof adminBookingsQueryValidator>
