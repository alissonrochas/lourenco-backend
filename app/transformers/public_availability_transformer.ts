import { BaseTransformer } from '@adonisjs/core/transformers'
import type { PublicBookingWindow } from '#services/public_booking_policy'
import type { AvailabilityResult } from '#services/booking_availability_engine'

export default class PublicAvailabilityTransformer extends BaseTransformer<
  AvailabilityResult & { policy: PublicBookingWindow }
> {
  toObject() {
    return {
      localDate: this.resource.localDate,
      weekday: this.resource.weekday,
      timezone: this.resource.timezone,
      slotDurationMinutes: this.resource.slotDurationMinutes,
      policy: {
        minDate: this.resource.policy.minDate,
        maxDate: this.resource.policy.maxDate,
        timezone: this.resource.policy.timezone,
      },
      slots: this.resource.slots.map((slot) => ({
        startsAtMinute: slot.startsAtMinute,
        endsAtMinute: slot.endsAtMinute,
        startsAtLocal: slot.startsAtLocal,
        endsAtLocal: slot.endsAtLocal,
        startsAtUtc: slot.startsAtUtc,
        endsAtUtc: slot.endsAtUtc,
        startOffsetMinutes: slot.startOffsetMinutes,
        endOffsetMinutes: slot.endOffsetMinutes,
      })),
    }
  }
}
