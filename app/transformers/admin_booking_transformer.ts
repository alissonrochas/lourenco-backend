import { BaseTransformer } from '@adonisjs/core/transformers'
import { DateTime } from 'luxon'
import type Booking from '#models/booking'
import { BOOKING_TIMEZONE, BOOKING_SLOT_MINUTES } from '#services/booking_availability_engine'

export default class AdminBookingTransformer extends BaseTransformer<Booking> {
  toObject() {
    const booking = this.resource
    return {
      id: booking.id,
      customer: { name: booking.customer.name, phone: booking.customer.phone },
      serviceName: booking.serviceNameSnapshot,
      priceCents: booking.servicePriceCentsSnapshot,
      localDate: booking.localDate,
      startsAtMinute: booking.startsAtMinute,
      startsAtLocal: DateTime.fromMillis(booking.startsAtUtc, { zone: BOOKING_TIMEZONE }).toISO(),
      endsAtLocal: DateTime.fromMillis(booking.endsAtUtc, { zone: BOOKING_TIMEZONE }).toISO(),
      timezone: BOOKING_TIMEZONE,
      slotDurationMinutes: BOOKING_SLOT_MINUTES,
      status: booking.status,
      cancellation:
        booking.status === 'cancelled'
          ? {
              cancelledAtUtc: booking.cancelledAtUtc,
              cancelledByUserId: booking.cancelledByUserId,
              reason: booking.cancellationReason,
            }
          : null,
    }
  }
}
