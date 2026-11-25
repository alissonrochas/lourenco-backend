import { BaseModel, column, hasMany } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import WeeklyBreak from '#models/weekly_break'
import WeeklySlotBlock from '#models/weekly_slot_block'

export default class WeeklyOpeningHour extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare weekday: number

  @column({ consume: (value: number | boolean) => value === 1 || value === true })
  declare isActive: boolean

  @column()
  declare opensAtMinute: number | null

  @column()
  declare closesAtMinute: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null

  @hasMany(() => WeeklyBreak)
  declare breaks: HasMany<typeof WeeklyBreak>

  @hasMany(() => WeeklySlotBlock)
  declare slotBlocks: HasMany<typeof WeeklySlotBlock>
}
