import { BaseTransformer } from '@adonisjs/core/transformers'
import { DateTime } from 'luxon'
import type Booking from '#models/booking'
import { BOOKING_TIMEZONE, BOOKING_SLOT_MINUTES } from '#services/booking_availability_engine'

export default class PublicBookingTransformer extends BaseTransformer<Booking> {
  toObject() {
    const booking = this.resource
    const start = DateTime.fromMillis(booking.startsAtUtc, { zone: BOOKING_TIMEZONE })
    const end = DateTime.fromMillis(booking.endsAtUtc, { zone: BOOKING_TIMEZONE })
    return {
      id: booking.id,
      serviceName: booking.serviceNameSnapshot,
      priceCents: booking.servicePriceCentsSnapshot,
      localDate: booking.localDate,
      startsAtMinute: booking.startsAtMinute,
      startsAtLocal: start.toISO(),
      endsAtLocal: end.toISO(),
      timezone: BOOKING_TIMEZONE,
      slotDurationMinutes: BOOKING_SLOT_MINUTES,
      status: booking.status,
    }
  }
}
