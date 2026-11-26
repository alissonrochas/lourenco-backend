import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import Booking from '#models/booking'
import Customer from '#models/customer'
import Service from '#models/service'
import BookingAvailabilityService from '#services/booking_availability_service'
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
    private availability = new BookingAvailabilityService(database)
  ) {}

  async create(input: CreateBookingInput) {
    return this.database.transaction(async (client) => {
      // Acquire SQLite's writer lock BEFORE any decisive read, even without settings.
      // Shared with calendar writers; no value/timestamp changes and no process mutex.
      await client.from('booking_settings').where('id', 1).update({ id: 1 })
      const phone = normalizePhone(input.phone)
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
        now: this.clock(),
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
