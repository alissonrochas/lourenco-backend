import vine from '@vinejs/vine'
import { isLocalCalendarDate } from '#services/calendar_exception_rules'

const realDate = vine.createRule((value, _options, field) => {
  if (!isLocalCalendarDate(value)) field.report('Data local inválida.', 'localDate', field)
})
const queryShape = vine.createRule((value, _options, field) => {
  if (Object.keys(value as Record<string, unknown>).some((key) => key !== 'date')) {
    field.report('Parâmetro desconhecido.', 'availabilityQuery', field)
  }
})
export const publicAvailabilityValidator = vine.create(
  vine.object({ date: vine.string().use(realDate()) }).use(queryShape())
)
