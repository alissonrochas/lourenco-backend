import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import BookingSetting from '#models/booking_setting'
import WeeklyOpeningHour from '#models/weekly_opening_hour'
import WeeklyBreak from '#models/weekly_break'
import WeeklySlotBlock from '#models/weekly_slot_block'
import type { BookingSettingsPatch } from '#validators/booking_settings'

export class InvalidBookingSettingsError extends Error {
  constructor() {
    super('Configuração semanal inválida.')
  }
}

type TransactionSource = {
  transaction<T>(callback: (trx: TransactionClientContract) => Promise<T>): Promise<T>
}

type ScheduleDay = {
  isActive: boolean
  opensAtMinute: number | null
  closesAtMinute: number | null
  breaks: Array<{ startsAtMinute: number; endsAtMinute: number; isActive: boolean }>
  slotBlocks: Array<{ startsAtMinute: number; isBlocked: boolean }>
}

// Validate the effective configuration, including fields preserved from the database.
export function assertValidScheduleDay(day: ScheduleDay) {
  const fail = () => {
    throw new InvalidBookingSettingsError()
  }
  const { opensAtMinute: opens, closesAtMinute: closes } = day
  if (opens === null || closes === null) {
    if (
      opens !== null ||
      closes !== null ||
      day.isActive ||
      day.breaks.some((item) => item.isActive) ||
      day.slotBlocks.some((item) => item.isBlocked)
    )
      fail()
    return
  }
  if (
    !Number.isInteger(opens) ||
    !Number.isInteger(closes) ||
    opens < 0 ||
    closes > 1440 ||
    opens >= closes ||
    opens % 60 !== 0 ||
    closes % 60 !== 0
  )
    fail()
  const activeBreaks = day.breaks
    .filter((item) => item.isActive)
    .sort((a, b) => a.startsAtMinute - b.startsAtMinute)
  let previousEnd = opens
  for (const item of activeBreaks) {
    if (
      item.startsAtMinute < opens ||
      item.endsAtMinute > closes ||
      item.startsAtMinute < previousEnd ||
      item.startsAtMinute >= item.endsAtMinute ||
      item.startsAtMinute % 60 !== 0 ||
      item.endsAtMinute % 60 !== 0
    )
      fail()
    previousEnd = item.endsAtMinute
  }
  for (const item of day.slotBlocks.filter((block) => block.isBlocked)) {
    if (
      item.startsAtMinute < opens ||
      item.startsAtMinute + 60 > closes ||
      item.startsAtMinute % 60 !== 0
    )
      fail()
  }
}

export default class BookingSettingsService {
  constructor(private database: TransactionSource = db) {}

  private async load(trx: TransactionClientContract) {
    const settings = await BookingSetting.find(1, { client: trx })
    const days = await WeeklyOpeningHour.query({ client: trx })
      .orderBy('weekday', 'asc')
      .preload('breaks', (query) => query.orderBy('startsAtMinute', 'asc').orderBy('id', 'asc'))
      .preload('slotBlocks', (query) => query.orderBy('startsAtMinute', 'asc'))
    return { settings, days }
  }

  read() {
    // A single read transaction keeps settings and children in the same snapshot.
    return this.database.transaction((trx) => this.load(trx))
  }

  update(payload: BookingSettingsPatch) {
    return this.database.transaction(async (trx) => {
      // The first statement is a write, even for an empty table. SQLite acquires
      // its writer lock before any configuration is read (also across processes).
      // No timestamp or business value is changed by this locking statement.
      await trx.from('booking_settings').where('id', 1).update({ id: 1 })
      const current = await this.load(trx)
      if (!current.settings) await BookingSetting.create({ id: 1 }, { client: trx })

      for (const patch of payload.days) {
        let day = current.days.find((item) => item.weekday === patch.weekday)
        if (!day) {
          day = new WeeklyOpeningHour()
          day.useTransaction(trx)
          day.merge({
            weekday: patch.weekday,
            isActive: false,
            opensAtMinute: null,
            closesAtMinute: null,
          })
          day.$setRelated('breaks', [])
          day.$setRelated('slotBlocks', [])
        }
        if (patch.isActive !== undefined) day.isActive = patch.isActive
        if (Object.hasOwn(patch, 'opensAtMinute')) day.opensAtMinute = patch.opensAtMinute ?? null
        if (Object.hasOwn(patch, 'closesAtMinute'))
          day.closesAtMinute = patch.closesAtMinute ?? null

        const breaks = day.breaks
        const blocks = day.slotBlocks
        if (patch.breaks !== undefined) {
          for (const item of breaks) item.isActive = false
          for (const input of patch.breaks) {
            let item = breaks.find((entry) => entry.startsAtMinute === input.startsAtMinute)
            if (!item) {
              item = new WeeklyBreak()
              item.useTransaction(trx)
              breaks.push(item)
            }
            item.merge({
              startsAtMinute: input.startsAtMinute,
              endsAtMinute: input.endsAtMinute,
              isActive: input.isActive,
            })
          }
        }
        if (patch.slotBlocks !== undefined) {
          for (const item of blocks) item.isBlocked = false
          for (const input of patch.slotBlocks) {
            let item = blocks.find((entry) => entry.startsAtMinute === input.startsAtMinute)
            if (!item) {
              item = new WeeklySlotBlock()
              item.useTransaction(trx)
              blocks.push(item)
            }
            item.merge({ startsAtMinute: input.startsAtMinute, isBlocked: input.isBlocked })
          }
        }
        // Explicitly supplied children must fit, even if marked inactive. Historical
        // inactive children are retained when opening hours shrink.
        for (const input of [...(patch.breaks ?? []), ...(patch.slotBlocks ?? [])]) {
          const end = 'endsAtMinute' in input ? input.endsAtMinute : input.startsAtMinute + 60
          if (
            day.opensAtMinute === null ||
            day.closesAtMinute === null ||
            input.startsAtMinute < day.opensAtMinute ||
            end > day.closesAtMinute ||
            input.startsAtMinute >= end ||
            input.startsAtMinute % 60 !== 0 ||
            end % 60 !== 0
          )
            throw new InvalidBookingSettingsError()
        }
        assertValidScheduleDay({
          isActive: day.isActive,
          opensAtMinute: day.opensAtMinute,
          closesAtMinute: day.closesAtMinute,
          breaks,
          slotBlocks: blocks,
        })
        await day.save()
        for (const item of breaks) {
          item.weeklyOpeningHourId = day.id
          await item.save()
        }
        for (const item of blocks) {
          item.weeklyOpeningHourId = day.id
          await item.save()
        }
      }
      return this.load(trx)
    })
  }
}
