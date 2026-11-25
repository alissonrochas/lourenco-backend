import { BaseTransformer } from '@adonisjs/core/transformers'
import type BookingSetting from '#models/booking_setting'
import type WeeklyOpeningHour from '#models/weekly_opening_hour'

type Resource = { settings: BookingSetting | null; days: WeeklyOpeningHour[] }

export default class BookingSettingsTransformer extends BaseTransformer<Resource> {
  toObject() {
    return {
      timezone: this.resource.settings?.timezone ?? 'America/Sao_Paulo',
      slotDurationMinutes: this.resource.settings?.slotDurationMinutes ?? 60,
      days: Array.from({ length: 7 }, (_, index) => {
        const weekday = index + 1
        const day = this.resource.days.find((entry) => entry.weekday === weekday)
        return {
          weekday,
          isConfigured:
            day !== undefined && day.opensAtMinute !== null && day.closesAtMinute !== null,
          isActive: day?.isActive ?? false,
          opensAtMinute: day?.opensAtMinute ?? null,
          closesAtMinute: day?.closesAtMinute ?? null,
          breaks: (day?.breaks ?? []).map((item) => ({
            startsAtMinute: item.startsAtMinute,
            endsAtMinute: item.endsAtMinute,
            isActive: item.isActive,
          })),
          slotBlocks: (day?.slotBlocks ?? []).map((item) => ({
            startsAtMinute: item.startsAtMinute,
            isBlocked: item.isBlocked,
          })),
        }
      }),
    }
  }
}
