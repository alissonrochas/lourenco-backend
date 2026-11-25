export class InvalidCalendarExceptionError extends Error {
  constructor() {
    super('Exceção de calendário inválida.')
  }
}

const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
const monthLengths = (year: number) => [
  31,
  leap(year) ? 29 : 28,
  31,
  30,
  31,
  30,
  31,
  31,
  30,
  31,
  30,
  31,
]

// Calendar dates are strings, never instants. No Date parsing or timezone conversion.
export function isLocalCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false
  const [year, month, day] = value.split('-').map(Number)
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= monthLengths(year)[month - 1]
}

export function calendarDayNumber(value: string) {
  if (!isLocalCalendarDate(value)) throw new InvalidCalendarExceptionError()
  const [year, month, day] = value.split('-').map(Number)
  const previousYear = year - 1
  return (
    365 * previousYear +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400) +
    monthLengths(year)
      .slice(0, month - 1)
      .reduce((total, length) => total + length, 0) +
    day
  )
}

export function normalizeExceptionReason(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.trim().length > 500)
    throw new InvalidCalendarExceptionError()
  return value.trim() || null
}
