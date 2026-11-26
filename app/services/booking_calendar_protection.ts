import { DateTime } from 'luxon'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import Booking from '#models/booking'
import {
  calculateBookingAvailability,
  localWeekday,
  type AvailabilityRules,
} from '#services/booking_availability_engine'
import type { CalendarExceptionInput } from '#validators/calendar_exception'

export class BookingCalendarConflictError extends Error {}

// Called only after the caller has acquired the shared SQLite writer lock.
// Protect ongoing and future confirmed reservations; historical ones remain history.
export async function protectWeeklyBookings(
  client: TransactionClientContract,
  weekday: number,
  rules: AvailabilityRules,
  now: DateTime
) {
  const bookings = await Booking.query({ client })
    .where('status', 'confirmed')
    .where('endsAtUtc', '>', now.toMillis())
    .select(['localDate', 'startsAtMinute', 'startsAtUtc'])
  for (const booking of bookings) {
    if (localWeekday(booking.localDate) !== weekday) continue
    // Calendar eligibility only, including an ongoing block. Never count its own occupancy.
    const result = calculateBookingAvailability(
      booking.localDate,
      rules,
      DateTime.fromMillis(booking.startsAtUtc - 1)
    )
    if (!result.slots.some((slot) => slot.startsAtMinute === booking.startsAtMinute))
      throw new BookingCalendarConflictError()
  }
}

export async function protectDateBookings(
  client: TransactionClientContract,
  input: CalendarExceptionInput,
  now: DateTime
) {
  const starts = (input.slotBlocks ?? [])
    .filter((slot) => slot.isBlocked)
    .map((slot) => slot.startsAtMinute)
  if (!input.dayBlock?.isBlocked && starts.length === 0) return
  const query = Booking.query({ client })
    .where('localDate', input.localDate)
    .where('status', 'confirmed')
    .where('endsAtUtc', '>', now.toMillis())
  if (!input.dayBlock?.isBlocked) query.whereIn('startsAtMinute', starts)
  if (await query.select('id').first()) throw new BookingCalendarConflictError()
}
