import { BaseModel, beforeSave, belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { DateTime } from 'luxon'
import Customer from '#models/customer'
import Service from '#models/service'
import User from '#models/user'
import { isLocalCalendarDate, calendarDayNumber } from '#services/calendar_exception_rules'
import { BOOKING_TIMEZONE } from '#services/booking_availability_engine'

export class InvalidBookingTimeError extends Error {
  constructor() {
    super('Instantes e horário local da reserva são inconsistentes.')
  }
}
export type BookingStatus = 'confirmed' | 'cancelled'

export default class Booking extends BaseModel {
  @column({ isPrimary: true }) declare id: number
  @column() declare customerId: number
  @column() declare serviceId: number
  @column() declare startsAtUtc: number
  @column() declare endsAtUtc: number
  @column() declare localDate: string
  @column() declare startsAtMinute: number
  @column() declare status: BookingStatus
  @column() declare serviceNameSnapshot: string
  @column() declare servicePriceCentsSnapshot: number
  @column() declare cancelledAtUtc: number | null
  @column() declare cancelledByUserId: number | null
  @column() declare cancellationReason: string | null
  @column.dateTime({ autoCreate: true }) declare createdAt: DateTime
  @column.dateTime({ autoCreate: true, autoUpdate: true }) declare updatedAt: DateTime

  @belongsTo(() => Customer) declare customer: BelongsTo<typeof Customer>
  @belongsTo(() => Service) declare service: BelongsTo<typeof Service>
  @belongsTo(() => User, { foreignKey: 'cancelledByUserId' }) declare cancelledBy: BelongsTo<
    typeof User
  >

  @beforeSave()
  static validateLocalTime(record: Booking) {
    const fail = () => {
      throw new InvalidBookingTimeError()
    }
    if (
      !isLocalCalendarDate(record.localDate) ||
      !Number.isSafeInteger(record.startsAtUtc) ||
      !Number.isSafeInteger(record.endsAtUtc) ||
      record.endsAtUtc - record.startsAtUtc !== 3600000 ||
      !Number.isInteger(record.startsAtMinute) ||
      record.startsAtMinute < 0 ||
      record.startsAtMinute > 1380 ||
      record.startsAtMinute % 60 !== 0
    )
      fail()
    const start = DateTime.fromMillis(record.startsAtUtc, { zone: BOOKING_TIMEZONE })
    const end = DateTime.fromMillis(record.endsAtUtc, { zone: BOOKING_TIMEZONE })
    const endDate = end.toISODate()
    if (
      !start.isValid ||
      !end.isValid ||
      start.toISODate() !== record.localDate ||
      start.hour * 60 + start.minute !== record.startsAtMinute ||
      start.second !== 0 ||
      start.millisecond !== 0 ||
      end.second !== 0 ||
      end.millisecond !== 0 ||
      !isLocalCalendarDate(endDate) ||
      start.getPossibleOffsets().length !== 1 ||
      end.getPossibleOffsets().length !== 1
    )
      fail()
    // Match the engine's conservative policy: unique local boundaries and exactly
    // one local wall hour AND one elapsed UTC hour, including closing at 24:00.
    if (
      (calendarDayNumber(endDate!) - calendarDayNumber(record.localDate)) * 1440 +
        end.hour * 60 +
        end.minute !==
      record.startsAtMinute + 60
    )
      fail()
  }
}
