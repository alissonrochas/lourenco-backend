import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import WeeklyOpeningHour from '#models/weekly_opening_hour'

export default class WeeklyBreak extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare weeklyOpeningHourId: number

  @column()
  declare startsAtMinute: number

  @column()
  declare endsAtMinute: number

  @column({ consume: (value: number | boolean) => value === 1 || value === true })
  declare isActive: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null

  @belongsTo(() => WeeklyOpeningHour)
  declare weeklyOpeningHour: BelongsTo<typeof WeeklyOpeningHour>
}
