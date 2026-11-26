import vine from '@vinejs/vine'
import type { Infer } from '@vinejs/vine/types'
import { isLocalCalendarDate } from '#services/calendar_exception_rules'
import { isValidPhone } from '#services/phone'

const realDate = vine.createRule((value, _options, field) => {
  if (!isLocalCalendarDate(value)) field.report('Data local inválida.', 'localDate', field)
})
const fullHour = vine.createRule((value, _options, field) => {
  if (typeof value !== 'number' || value % 60 !== 0)
    field.report('Informe uma hora cheia.', 'fullHour', field)
})
const phone = vine.createRule((value, _options, field) => {
  if (typeof value !== 'string' || !isValidPhone(value))
    field.report('Telefone inválido.', 'phone', field)
})
const shape = vine.createRule((value, _options, field) => {
  const allowed = ['serviceId', 'localDate', 'startsAtMinute', 'name', 'phone']
  if (Object.keys(value as object).some((key) => !allowed.includes(key)))
    field.report('Campos não permitidos.', 'bookingShape', field)
})

export const createBookingValidator = vine.create(
  vine
    .object({
      serviceId: vine
        .number({ strict: true })
        .withoutDecimals()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER),
      localDate: vine.string().use(realDate()),
      startsAtMinute: vine
        .number({ strict: true })
        .withoutDecimals()
        .min(0)
        .max(1380)
        .use(fullHour()),
      name: vine.string().trim().minLength(2).maxLength(120),
      phone: vine
        .string()
        .trim()
        .minLength(8)
        .maxLength(30)
        .regex(/^[0-9()+\-\s]+$/)
        .use(phone()),
    })
    .use(shape())
)
export type CreateBookingInput = Infer<typeof createBookingValidator>
