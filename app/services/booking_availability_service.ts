import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import WeeklyOpeningHour from '#models/weekly_opening_hour'
import WeeklyBreak from '#models/weekly_break'
import WeeklySlotBlock from '#models/weekly_slot_block'
import Booking from '#models/booking'
import PublicBookingPolicy from '#services/public_booking_policy'
import DateBlock from '#models/date_block'
import DateSlotBlock from '#models/date_slot_block'
import {
  calculateBookingAvailability,
  localWeekday,
  validateAvailabilityInput,
  type AvailabilityRules,
} from '#services/booking_availability_engine'

type TransactionSource = {
  transaction<T>(callback: (trx: TransactionClientContract) => Promise<T>): Promise<T>
}
export type AvailabilityOptions = { now?: DateTime; client?: TransactionClientContract }

export default class BookingAvailabilityService {
  constructor(
    private database: TransactionSource = db,
    private clock: () => DateTime = () => DateTime.utc()
  ) {}

  /** Public admission boundary; internal callers retain unrestricted calendar reads. */
  async calculatePublic(localDate: string) {
    const now = this.clock()
    const policy = new PublicBookingPolicy().assertDate(localDate, now)
    const result = await this.calculate(localDate, { now })
    return { ...result, policy }
  }

  async calculate(localDate: string, options: AvailabilityOptions = {}) {
    const now = options.now ?? this.clock()
    validateAvailabilityInput(localDate, now)
    const read = async (client: TransactionClientContract) => {
      const weekly = await WeeklyOpeningHour.query({ client })
        .where('weekday', localWeekday(localDate))
        .select(['id', 'isActive', 'opensAtMinute', 'closesAtMinute'])
        .first()
      const rules: AvailabilityRules = {
        weekly,
        breaks: [],
        weeklySlotBlocks: [],
        dateBlocked: false,
        dateSlotBlocks: [],
      }
      if (!weekly?.isActive || weekly.opensAtMinute === null || weekly.closesAtMinute === null)
        return calculateBookingAvailability(localDate, rules, now)
      const dateBlock = await DateBlock.query({ client })
        .where('localDate', localDate)
        .where('isBlocked', true)
        .select('id')
        .first()
      rules.dateBlocked = dateBlock !== null
      if (!rules.dateBlocked) {
        rules.breaks = await WeeklyBreak.query({ client })
          .where('weeklyOpeningHourId', weekly.id)
          .where('isActive', true)
          .select(['startsAtMinute', 'endsAtMinute', 'isActive'])
        rules.weeklySlotBlocks = await WeeklySlotBlock.query({ client })
          .where('weeklyOpeningHourId', weekly.id)
          .where('isBlocked', true)
          .select(['startsAtMinute', 'isBlocked'])
        rules.dateSlotBlocks = await DateSlotBlock.query({ client })
          .where('localDate', localDate)
          .where('isBlocked', true)
          .select(['startsAtMinute', 'isBlocked'])
      }
      const result = calculateBookingAvailability(localDate, rules, now)
      if (result.slots.length === 0) return result
      // Calendar and occupancy share the same snapshot, including uncommitted writes.
      // Select only UTC starts (no identity, customer, audit or administrative fields).
      const occupied = await Booking.query({ client })
        .where('status', 'confirmed')
        .whereIn(
          'startsAtUtc',
          result.slots.map((slot) => DateTime.fromISO(slot.startsAtUtc).toMillis())
        )
        .select('startsAtUtc')
      const starts = new Set(occupied.map((booking) => booking.startsAtUtc))
      return {
        ...result,
        slots: result.slots.filter(
          (slot) => !starts.has(DateTime.fromISO(slot.startsAtUtc).toMillis())
        ),
      }
    }
    // An external transaction is neither committed nor rolled back by this service.
    return options.client ? read(options.client) : this.database.transaction(read)
  }
}
