import { assertCalendarPrecondition, calendarTag } from '#services/calendar_precondition'
import { DateTime } from 'luxon'
import { protectDateBookings } from '#services/booking_calendar_protection'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import DateBlock from '#models/date_block'
import DateSlotBlock from '#models/date_slot_block'
import type { CalendarExceptionInput } from '#validators/calendar_exception'
import { normalizeExceptionReason } from '#services/calendar_exception_rules'

type TransactionSource = {
  transaction<T>(callback: (trx: TransactionClientContract) => Promise<T>): Promise<T>
}

export default class CalendarExceptionsService {
  constructor(
    private database: TransactionSource = db,
    private clock: () => DateTime = () => DateTime.utc()
  ) {}

  private async load(trx: TransactionClientContract, from: string, to: string) {
    const dateBlocks = await DateBlock.query({ client: trx })
      .whereBetween('localDate', [from, to])
      .orderBy('localDate', 'asc')
    const slotBlocks = await DateSlotBlock.query({ client: trx })
      .whereBetween('localDate', [from, to])
      .orderBy('localDate', 'asc')
      .orderBy('startsAtMinute', 'asc')
    return { dateBlocks, slotBlocks }
  }

  read(from: string, to: string) {
    return this.database.transaction((trx) => this.load(trx, from, to))
  }

  save(input: CalendarExceptionInput, expected?: string) {
    return this.database.transaction(async (trx) => {
      // Same writer-lock strategy as weekly settings, including an absent singleton.
      await trx.from('booking_settings').where('id', 1).update({ id: 1 })
      if (expected !== undefined) {
        const current = await this.load(trx, input.localDate, input.localDate)
        assertCalendarPrecondition(
          expected,
          calendarTag(current, `dates:${input.localDate}:${input.localDate}`)
        )
      }
      await protectDateBookings(trx, input, this.clock())
      if (input.dayBlock) {
        let record = await DateBlock.query({ client: trx })
          .where('localDate', input.localDate)
          .first()
        if (!record) {
          record = new DateBlock()
          record.useTransaction(trx)
          record.localDate = input.localDate
        }
        record.isBlocked = input.dayBlock.isBlocked
        if (Object.hasOwn(input.dayBlock, 'reason'))
          record.reason = normalizeExceptionReason(input.dayBlock.reason)
        await record.save()
      }
      for (const slot of input.slotBlocks ?? []) {
        let record = await DateSlotBlock.query({ client: trx })
          .where('localDate', input.localDate)
          .where('startsAtMinute', slot.startsAtMinute)
          .first()
        if (!record) {
          record = new DateSlotBlock()
          record.useTransaction(trx)
          record.localDate = input.localDate
          record.startsAtMinute = slot.startsAtMinute
        }
        record.isBlocked = slot.isBlocked
        if (Object.hasOwn(slot, 'reason')) record.reason = normalizeExceptionReason(slot.reason)
        await record.save()
      }
      return this.load(trx, input.localDate, input.localDate)
    })
  }
}
