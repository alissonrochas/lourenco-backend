import { BaseTransformer } from '@adonisjs/core/transformers'
import type { AvailabilityResult } from '#services/booking_availability_engine'

export default class PublicAvailabilityTransformer extends BaseTransformer<AvailabilityResult> {
  toObject() {
    return {
      localDate: this.resource.localDate,
      weekday: this.resource.weekday,
      timezone: this.resource.timezone,
      slotDurationMinutes: this.resource.slotDurationMinutes,
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
