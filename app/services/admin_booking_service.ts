import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import Booking from '#models/booking'
import User from '#models/user'
import type { AdminBookingsQuery } from '#validators/admin_booking'

export class AdminBookingNotFoundError extends Error {}
export class AdminBookingConflictError extends Error {}
export class AdminBookingForbiddenError extends Error {}

type TransactionSource = {
  transaction<T>(callback: (client: TransactionClientContract) => Promise<T>): Promise<T>
}
export default class AdminBookingService {
  constructor(
    private database: TransactionSource = db,
    private clock: () => DateTime = () => DateTime.utc()
  ) {}

  list(input: AdminBookingsQuery) {
    return this.database.transaction(async (client) => {
      const page = Number(input.page ?? 1)
      const perPage = Number(input.perPage ?? 50)
      const count = await client
        .from('bookings')
        .whereBetween('local_date', [input.from, input.to])
        .count('* as total')
        .first()
      const total = Number(count.total)
      const bookings = await Booking.query({ client })
        .whereBetween('localDate', [input.from, input.to])
        .orderBy('startsAtUtc', 'asc')
        .orderBy('id', 'asc')
        .offset((page - 1) * perPage)
        .limit(perPage)
        .preload('customer', (query) => query.select(['id', 'name', 'phone']))
      return {
        bookings,
        meta: { page, perPage, total, lastPage: Math.max(1, Math.ceil(total / perPage)) },
      }
    })
  }

  cancel(id: number, reason: string, administratorId: number) {
    return this.database.transaction(async (client) => {
      // Same SQLite writer serialization as booking creation and calendar edits.
      await client.from('booking_settings').where('id', 1).update({ id: 1 })
      // Recheck current authority under the writer lock, not an ID supplied by the body.
      const administrator = await User.query({ client })
        .where('id', administratorId)
        .where('role', 'admin')
        .select('id')
        .first()
      if (!administrator) throw new AdminBookingForbiddenError()
      const booking = await Booking.query({ client })
        .where('id', id)
        .preload('customer', (query) => query.select(['id', 'name', 'phone']))
        .first()
      if (!booking) throw new AdminBookingNotFoundError()
      // A valid retry returns the first audit, even if its original time is now past.
      if (booking.status === 'cancelled') return booking
      const now = this.clock()
      if (!now.isValid) throw new Error('Invalid cancellation clock')
      if (booking.status !== 'confirmed' || booking.startsAtUtc <= now.toMillis())
        throw new AdminBookingConflictError()
      booking.merge({
        status: 'cancelled',
        cancelledAtUtc: now.toMillis(),
        cancelledByUserId: administrator.id,
        cancellationReason: reason,
      })
      await booking.save()
      return booking
    })
  }
}
