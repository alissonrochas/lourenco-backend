import { BaseModel, beforeSave, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import {
  InvalidCalendarExceptionError,
  isLocalCalendarDate,
  normalizeExceptionReason,
} from '#services/calendar_exception_rules'

export default class DateBlock extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare localDate: string

  @column({ consume: (value: number | boolean) => value === 1 || value === true })
  declare isBlocked: boolean

  @column()
  declare reason: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null

  @beforeSave()
  static validateCalendar(record: DateBlock) {
    if (!isLocalCalendarDate(record.localDate)) throw new InvalidCalendarExceptionError()
    record.reason = normalizeExceptionReason(record.reason)
  }
}
