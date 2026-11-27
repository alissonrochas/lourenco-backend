import type { DateTime } from 'luxon'
import config from '#config/booking_policy'
import { BOOKING_TIMEZONE, validateAvailabilityInput } from '#services/booking_availability_engine'

export type PublicBookingWindow = {
  minDate: string
  maxDate: string
  timezone: typeof BOOKING_TIMEZONE
}
export class BookingHorizonError extends Error {
  constructor(public readonly policy: PublicBookingWindow) {
    super('Public booking date outside window')
  }
}
export class BookingQuotaError extends Error {}

/** Admission rules only: never restrict the internal calendar engine. */
export default class PublicBookingPolicy {
  constructor(
    readonly settings: Readonly<{ advanceDays: number; maxFutureBookings: number }> = config
  ) {
    if (
      !Number.isSafeInteger(settings.advanceDays) ||
      settings.advanceDays < 0 ||
      !Number.isSafeInteger(settings.maxFutureBookings) ||
      settings.maxFutureBookings < 1
    )
      throw new RangeError('Invalid public booking policy')
  }

  window(now: DateTime): PublicBookingWindow {
    const local = now.setZone(BOOKING_TIMEZONE)
    const minDate = local.toISODate()
    const maxDate = local.plus({ days: this.settings.advanceDays }).toISODate()
    if (!local.isValid || !minDate || !maxDate || !/^\d{4}-/.test(maxDate))
      throw new Error('Invalid public booking clock or horizon')
    return { minDate, maxDate, timezone: BOOKING_TIMEZONE }
  }

  assertDate(localDate: string, now: DateTime) {
    validateAvailabilityInput(localDate, now)
    const policy = this.window(now)
    if (localDate < policy.minDate || localDate > policy.maxDate)
      throw new BookingHorizonError(policy)
    return policy
  }
}

export function horizonResponse(error: BookingHorizonError) {
  return {
    code: 'BOOKING_DATE_OUT_OF_RANGE',
    message: 'Escolha uma data dentro do período de agendamento.',
    policy: error.policy,
  }
}
