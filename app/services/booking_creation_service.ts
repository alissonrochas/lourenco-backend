import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import Booking from '#models/booking'
import Customer from '#models/customer'
import Service from '#models/service'
import BookingAvailabilityService from '#services/booking_availability_service'
import PublicBookingPolicy, { BookingQuotaError } from '#services/public_booking_policy'
import { normalizePhone } from '#services/phone'
import type { CreateBookingInput } from '#validators/booking'

export class BookingSlotUnavailableError extends Error {}
export class BookingServiceUnavailableError extends Error {}

type TransactionSource = {
  transaction<T>(callback: (trx: TransactionClientContract) => Promise<T>): Promise<T>
}

export default class BookingCreationService {
  constructor(
    private database: TransactionSource = db,
    private clock: () => DateTime = () => DateTime.utc(),
    private availability = new BookingAvailabilityService(database),
    private policy = new PublicBookingPolicy()
  ) {}

  async create(input: CreateBookingInput) {
    return this.database.transaction(async (client) => {
      // Acquire SQLite's writer lock BEFORE any decisive read, even without settings.
      // Shared with calendar writers; no value/timestamp changes and no process mutex.
      await client.from('booking_settings').where('id', 1).update({ id: 1 })
      const now = this.clock()
      this.policy.assertDate(input.localDate, now)
      const phone = normalizePhone(input.phone)
      // Count by identity, not just the customer selected below. Legacy NULL rows
      // remain separate records; normalize their stored phones without rewriting them.
      const future = () =>
        client
          .from('bookings as b')
          .join('customers as c', 'c.id', 'b.customer_id')
          .where('b.status', 'confirmed')
          .where('b.starts_at_utc', '>', now.toMillis())
      const canonical = await future()
        .where('c.phone_normalized', phone)
        .count('* as total')
        .first()
      let total = Number(canonical.total)
      if (total < this.policy.settings.maxFutureBookings) {
        const legacy = await future()
          .whereNull('c.phone_normalized')
          .select('c.id', 'c.phone')
          .groupBy('c.id', 'c.phone')
          .count('* as total')
        for (const row of legacy)
          if (normalizePhone(row.phone) === phone) total += Number(row.total)
      }
      if (total >= this.policy.settings.maxFutureBookings) throw new BookingQuotaError()
      let customer = await Customer.query({ client }).where('phoneNormalized', phone).first()
      if (!customer) {
        // Respect the original unique phone index for legacy NULL-normalized rows.
        // Never merge legacy duplicates or rewrite an existing person's name/phone.
        customer = await Customer.query({ client }).where('phone', phone).first()
      }
      if (!customer)
        customer = await Customer.create(
          { name: input.name, phone, phoneNormalized: phone },
          { client }
        )
      const service = await Service.query({ client })
        .where('id', input.serviceId)
        .where('isActive', true)
        .first()
      if (!service) throw new BookingServiceUnavailableError()
      // Capture time after acquiring the lock, not before waiting for another writer.
      const result = await this.availability.calculate(input.localDate, {
        client,
        now,
      })
      const slot = result.slots.find(
        (candidate) => candidate.startsAtMinute === input.startsAtMinute
      )
      if (!slot) throw new BookingSlotUnavailableError()
      return Booking.create(
        {
          customerId: customer.id,
          serviceId: service.id,
          localDate: slot.localDate,
          startsAtMinute: slot.startsAtMinute,
          startsAtUtc: DateTime.fromISO(slot.startsAtUtc).toMillis(),
          endsAtUtc: DateTime.fromISO(slot.endsAtUtc).toMillis(),
          status: 'confirmed',
          serviceNameSnapshot: service.name,
          servicePriceCentsSnapshot: service.priceCents,
        },
        { client }
      )
    })
  }
}
