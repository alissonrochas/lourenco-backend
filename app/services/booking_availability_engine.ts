import { DateTime } from 'luxon'
import { calendarDayNumber, isLocalCalendarDate } from '#services/calendar_exception_rules'

export const BOOKING_TIMEZONE = 'America/Sao_Paulo' as const
export const BOOKING_SLOT_MINUTES = 60 as const

export class InvalidAvailabilityInputError extends Error {
  constructor() {
    super('Data local ou instante de referência inválido.')
  }
}

export type AvailabilityRules = {
  weekly: { isActive: boolean; opensAtMinute: number | null; closesAtMinute: number | null } | null
  breaks: ReadonlyArray<{ startsAtMinute: number; endsAtMinute: number; isActive: boolean }>
  weeklySlotBlocks: ReadonlyArray<{ startsAtMinute: number; isBlocked: boolean }>
  dateBlocked: boolean
  dateSlotBlocks: ReadonlyArray<{ startsAtMinute: number; isBlocked: boolean }>
}
export type AvailabilitySlot = {
  localDate: string
  startsAtMinute: number
  endsAtMinute: number
  startsAtLocal: string
  endsAtLocal: string
  startsAtUtc: string
  endsAtUtc: string
  startOffsetMinutes: number
  endOffsetMinutes: number
}
export type AvailabilityResult = {
  localDate: string
  weekday: number
  timezone: typeof BOOKING_TIMEZONE
  slotDurationMinutes: typeof BOOKING_SLOT_MINUTES
  slots: AvailabilitySlot[]
}

export function validateAvailabilityInput(localDate: string, now: DateTime) {
  if (!isLocalCalendarDate(localDate) || !DateTime.isDateTime(now) || !now.isValid)
    throw new InvalidAvailabilityInputError()
}

export function localWeekday(localDate: string) {
  if (!isLocalCalendarDate(localDate)) throw new InvalidAvailabilityInputError()
  return ((calendarDayNumber(localDate) - 1) % 7) + 1
}

function localBoundary(localDate: string, minute: number): DateTime | null {
  const [year, month, day] = localDate.split('-').map(Number)
  // UTC here is ONLY a neutral calendar for advancing 24:00 to the next date.
  // It is never interpreted as the actual instant of the requested local boundary.
  const calendar = DateTime.fromObject({ year, month, day }, { zone: 'UTC' }).plus({
    days: minute === 1440 ? 1 : 0,
  })
  if (!calendar.isValid || calendar.year > 9999) return null
  const hour = minute === 1440 ? 0 : minute / 60
  const local = DateTime.fromObject(
    {
      year: calendar.year,
      month: calendar.month,
      day: calendar.day,
      hour,
      minute: 0,
      second: 0,
      millisecond: 0,
    },
    { zone: BOOKING_TIMEZONE }
  )
  // Luxon normally normalizes nonexistent times. Reject rather than silently move
  // a slot; also reject both interpretations of ambiguous local boundaries.
  if (
    !local.isValid ||
    local.year !== calendar.year ||
    local.month !== calendar.month ||
    local.day !== calendar.day ||
    local.hour !== hour ||
    local.minute !== 0 ||
    local.getPossibleOffsets().length !== 1
  )
    return null
  return local
}

/** Pure calculation: no database, system clock, HTTP, service catalogue or mutation. */
export function calculateBookingAvailability(
  localDate: string,
  rules: AvailabilityRules,
  now: DateTime
): AvailabilityResult {
  validateAvailabilityInput(localDate, now)
  const result: AvailabilityResult = {
    localDate,
    weekday: localWeekday(localDate),
    timezone: BOOKING_TIMEZONE,
    slotDurationMinutes: BOOKING_SLOT_MINUTES,
    slots: [],
  }
  const weekly = rules.weekly
  if (!weekly?.isActive || rules.dateBlocked) return result
  const opens = weekly.opensAtMinute
  const closes = weekly.closesAtMinute
  if (
    opens === null ||
    closes === null ||
    !Number.isInteger(opens) ||
    !Number.isInteger(closes) ||
    opens < 0 ||
    closes > 1440 ||
    opens >= closes ||
    opens % 60 !== 0 ||
    closes % 60 !== 0
  )
    return result
  const blockedMinutes = new Set(
    [...rules.weeklySlotBlocks, ...rules.dateSlotBlocks]
      .filter((block) => block.isBlocked)
      .map((block) => block.startsAtMinute)
  )
  for (
    let startMinute = opens;
    startMinute + BOOKING_SLOT_MINUTES <= closes;
    startMinute += BOOKING_SLOT_MINUTES
  ) {
    const endMinute = startMinute + BOOKING_SLOT_MINUTES
    if (
      blockedMinutes.has(startMinute) ||
      rules.breaks.some(
        (pause) =>
          pause.isActive && startMinute < pause.endsAtMinute && endMinute > pause.startsAtMinute
      )
    )
      continue
    const start = localBoundary(localDate, startMinute)
    const end = localBoundary(localDate, endMinute)
    if (
      !start ||
      !end ||
      end.toMillis() - start.toMillis() !== 60 * 60 * 1000 ||
      start.toMillis() <= now.toMillis()
    )
      continue
    result.slots.push({
      localDate,
      startsAtMinute: startMinute,
      endsAtMinute: endMinute,
      startsAtLocal: start.toISO({ includeOffset: false })!,
      endsAtLocal: end.toISO({ includeOffset: false })!,
      startsAtUtc: start.toUTC().toISO()!,
      endsAtUtc: end.toUTC().toISO()!,
      startOffsetMinutes: start.offset,
      endOffsetMinutes: end.offset,
    })
  }
  result.slots.sort(
    (left, right) =>
      DateTime.fromISO(left.startsAtUtc).toMillis() - DateTime.fromISO(right.startsAtUtc).toMillis()
  )
  return result
}
