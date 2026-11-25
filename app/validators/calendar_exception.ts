import vine from '@vinejs/vine'
import type { Infer } from '@vinejs/vine/types'
import { calendarDayNumber, isLocalCalendarDate } from '#services/calendar_exception_rules'

const realDate = vine.createRule((value, _options, field) => {
  if (!isLocalCalendarDate(value)) field.report('Data local inválida.', 'localDate', field)
})
const date = () => vine.string().use(realDate())
const reason = () => vine.string().trim().maxLength(500).nullable().optional()
const queryShape = vine.createRule((value, _options, field) => {
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['from', 'to'].includes(key)))
    field.report('Consulta inválida.', 'calendarRange', field)
  if (isLocalCalendarDate(input.from) && isLocalCalendarDate(input.to)) {
    const difference = calendarDayNumber(input.to) - calendarDayNumber(input.from)
    if (difference < 0 || difference >= 93)
      field.report('Consulte até 93 dias inclusivos.', 'calendarRange', field)
  }
})
const writeShape = vine.createRule((value, _options, field) => {
  const input = value as Record<string, unknown>
  const report = () =>
    field.report('Exceção inválida ou campos não permitidos.', 'calendarException', field)
  const keys = (record: Record<string, unknown>, allowed: string[]) => {
    if (
      Object.keys(record).some(
        (key) => !allowed.includes(key) || (record[key] === null && key !== 'reason')
      )
    )
      report()
  }
  keys(input, ['localDate', 'dayBlock', 'slotBlocks'])
  if (
    !Object.hasOwn(input, 'dayBlock') &&
    (!Array.isArray(input.slotBlocks) || input.slotBlocks.length === 0)
  )
    report()
  if (input.dayBlock && typeof input.dayBlock === 'object' && !Array.isArray(input.dayBlock))
    keys(input.dayBlock as Record<string, unknown>, ['isBlocked', 'reason'])
  if (Array.isArray(input.slotBlocks)) {
    const starts = new Set<unknown>()
    for (const item of input.slotBlocks) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      keys(item, ['startsAtMinute', 'isBlocked', 'reason'])
      if (starts.has(item.startsAtMinute)) report()
      starts.add(item.startsAtMinute)
    }
  }
})
const hour = vine.createRule((value, _options, field) => {
  if (typeof value === 'number' && value % 60 !== 0)
    field.report('Informe uma hora cheia.', 'fullHour', field)
})

export const calendarExceptionsQueryValidator = vine.create(
  vine.object({ from: date(), to: date() }).use(queryShape())
)
export const saveCalendarExceptionValidator = vine.create(
  vine
    .object({
      localDate: date(),
      dayBlock: vine
        .object({ isBlocked: vine.boolean({ strict: true }), reason: reason() })
        .optional(),
      slotBlocks: vine
        .array(
          vine.object({
            startsAtMinute: vine
              .number({ strict: true })
              .withoutDecimals()
              .min(0)
              .max(1380)
              .use(hour()),
            isBlocked: vine.boolean({ strict: true }),
            reason: reason(),
          })
        )
        .maxLength(24)
        .optional(),
    })
    .use(writeShape())
)
export type CalendarExceptionInput = Infer<typeof saveCalendarExceptionValidator>
