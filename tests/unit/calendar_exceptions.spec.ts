import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { Database } from '@adonisjs/lucid/database'
import logger from '@adonisjs/core/services/logger'
import emitter from '@adonisjs/core/services/emitter'
import DateBlock from '#models/date_block'
import DateSlotBlock from '#models/date_slot_block'
import CalendarExceptionsService from '#services/calendar_exceptions_service'
import {
  calendarDayNumber,
  isLocalCalendarDate,
  InvalidCalendarExceptionError,
} from '#services/calendar_exception_rules'
import { saveCalendarExceptionValidator } from '#validators/calendar_exception'
import { createBookingsDatabase } from '#tests/helpers/bookings_database'
import { createCalendarDatabase } from '#tests/helpers/calendar_database'

const timestamp = '2026-11-25 00:00:00'
const invalidDates = [
  '2026-02-29',
  '1900-02-29',
  '2100-02-29',
  '2028-02-30',
  '2026-04-31',
  '2026-13-01',
  '2026-00-01',
  '2026-01-00',
  '0000-01-01',
  '10000-01-01',
  '2026-1-01',
  '2026-01-01T00:00:00Z',
  '2026-01-01\n',
]

test.group('local calendar rules', () => {
  test('validates actual Gregorian dates and leap centuries without parsing instants', () => {
    for (const date of ['0001-01-01', '9999-12-31', '2000-02-29', '2028-02-29', '2018-11-04'])
      assert.equal(isLocalCalendarDate(date), true, date)
    for (const date of [...invalidDates, '', null, 20260101])
      assert.equal(isLocalCalendarDate(date), false, String(date))
    assert.equal(calendarDayNumber('2028-03-01') - calendarDayNumber('2028-02-28'), 2)
    assert.equal(calendarDayNumber('2027-03-01') - calendarDayNumber('2027-02-28'), 1)
    assert.equal(calendarDayNumber('2027-01-01') - calendarDayNumber('2026-12-31'), 1)
    assert.throws(() => calendarDayNumber('2026-02-29'), InvalidCalendarExceptionError)
  })
})

test.group('calendar exception migration and models', () => {
  test('real migration applies, reverses and reapplies while preserving every prior table and record', async () => {
    const temporary = await createCalendarDatabase()
    try {
      const before = await temporary.existingState()
      await temporary.up()
      assert.equal(await temporary.client.schema.hasTable('date_blocks'), true)
      assert.equal(await temporary.client.schema.hasTable('date_slot_blocks'), true)
      await temporary.client
        .table('date_blocks')
        .insert({ local_date: '2026-12-25', created_at: timestamp })
      await temporary.client
        .table('date_slot_blocks')
        .insert({ local_date: '2026-12-25', starts_at_minute: 600, created_at: timestamp })
      assert.deepEqual(await temporary.existingState(), before)
      await temporary.down()
      assert.equal(await temporary.client.schema.hasTable('date_blocks'), false)
      assert.equal(await temporary.client.schema.hasTable('date_slot_blocks'), false)
      assert.deepEqual(await temporary.existingState(), before)
      await temporary.up()
      assert.deepEqual(await temporary.client.from('date_blocks'), [])
      assert.deepEqual(await temporary.client.from('date_slot_blocks'), [])
      assert.deepEqual(await temporary.existingState(), before)
    } finally {
      await temporary.cleanup()
    }
  })

  test('SQLite enforces real dates, required timestamps, boolean status and reason limits in both tables', async () => {
    const temporary = await createCalendarDatabase()
    try {
      await temporary.up()
      for (const table of ['date_blocks', 'date_slot_blocks']) {
        const row = {
          local_date: '2028-02-29',
          created_at: timestamp,
          ...(table === 'date_slot_blocks' ? { starts_at_minute: 600 } : {}),
        }
        for (const localDate of [...invalidDates, null])
          await assert.rejects(
            () =>
              temporary.client
                .table(table)
                .insert({ ...row, local_date: localDate })
                .exec(),
            /constraint/i
          )
        for (const status of [2, -1, 0.5, 'false', null])
          await assert.rejects(
            () =>
              temporary.client
                .table(table)
                .insert({ ...row, is_blocked: status })
                .exec(),
            /constraint/i
          )
        await assert.rejects(
          () =>
            temporary.client
              .table(table)
              .insert({ ...row, reason: 'a'.repeat(501) })
              .exec(),
          /constraint/i
        )
        await assert.rejects(
          () =>
            temporary.client
              .table(table)
              .insert({ ...row, created_at: null })
              .exec(),
          /constraint/i
        )
        await temporary.client.table(table).insert({ ...row, reason: 'a'.repeat(500) })
        const saved = await temporary.client.from(table).first()
        assert.equal(saved.is_blocked, 1)
        await assert.rejects(
          () => temporary.client.from(table).update({ local_date: '2026-02-29' }).exec(),
          /constraint/i
        )
        await assert.rejects(() => temporary.client.table(table).insert(row).exec(), /unique/i)
      }
    } finally {
      await temporary.cleanup()
    }
  })

  test('slot uniqueness is per date and only complete hour blocks 00:00 through 23:00 fit', async () => {
    const temporary = await createCalendarDatabase()
    try {
      await temporary.up()
      for (const starts of [-60, 1440, 1, 600.5, 'invalid', null])
        await assert.rejects(
          () =>
            temporary.client
              .table('date_slot_blocks')
              .insert({ local_date: '2026-12-25', starts_at_minute: starts, created_at: timestamp })
              .exec(),
          /constraint/i
        )
      for (const date of ['2026-12-25', '2026-12-26'])
        for (const starts of [0, 1380])
          await temporary.client
            .table('date_slot_blocks')
            .insert({ local_date: date, starts_at_minute: starts, created_at: timestamp })
      const records = await temporary.client.from('date_slot_blocks')
      assert.equal(records.length, 4)
      await assert.rejects(
        () => temporary.client.from('date_slot_blocks').update({ starts_at_minute: 601 }).exec(),
        /constraint/i
      )
    } finally {
      await temporary.cleanup()
    }
  })

  test('both Lucid models independently reject impossible dates and invalid reasons', async () => {
    const temporary = await createCalendarDatabase()
    try {
      await temporary.up()
      const trx = await temporary.client.transaction()
      try {
        for (const model of [DateBlock, DateSlotBlock]) {
          for (const localDate of invalidDates)
            await assert.rejects(
              () =>
                model.create(
                  { localDate, ...(model === DateSlotBlock ? { startsAtMinute: 600 } : {}) },
                  { client: trx }
                ),
              InvalidCalendarExceptionError
            )
          await assert.rejects(
            () =>
              model.create(
                {
                  localDate: '2028-02-29',
                  ...(model === DateSlotBlock ? { startsAtMinute: 600 } : {}),
                  reason: 'a'.repeat(501),
                },
                { client: trx }
              ),
            InvalidCalendarExceptionError
          )
        }
      } finally {
        await trx.rollback()
      }
    } finally {
      await temporary.cleanup()
    }
  })

  test('models preserve local date strings, map columns and update status without replacing IDs or createdAt', async () => {
    const temporary = await createCalendarDatabase()
    try {
      await temporary.up()
      const trx = await temporary.client.transaction()
      try {
        const wholeDay = await DateBlock.create(
          { localDate: '2018-11-04', isBlocked: true, reason: '  Folga  ' },
          { client: trx }
        )
        const slot = await DateSlotBlock.create(
          { localDate: '2018-11-04', startsAtMinute: 600, isBlocked: true },
          { client: trx }
        )
        for (const [record, table] of [
          [wholeDay, 'date_blocks'],
          [slot, 'date_slot_blocks'],
        ] as const) {
          await record.refresh()
          assert.equal(record.localDate, '2018-11-04')
          assert.equal(record.isBlocked, true)
          const row = await trx.from(table).where('id', record.id).first()
          assert.equal(row.local_date, record.localDate)
          assert.equal(row.is_blocked, 1)
          assert.equal(record.serialize().localDate, record.localDate)
          await trx.from(table).where('id', record.id).update({ updated_at: '2000-01-01 00:00:00' })
          await record.refresh()
          const createdAt = record.createdAt.toISO()
          record.isBlocked = false
          await record.save()
          await record.refresh()
          assert.equal(record.createdAt.toISO(), createdAt)
          assert.ok(record.updatedAt!.toMillis() > Date.parse('2000-01-01'))
          assert.equal(record.isBlocked, false)
        }
        assert.equal(wholeDay.reason, 'Folga')
        assert.equal(slot.reason, null)
        const row = await trx.from('date_slot_blocks').where('id', slot.id).first()
        assert.equal(row.starts_at_minute, 600)
      } finally {
        await trx.rollback()
      }
    } finally {
      await temporary.cleanup()
    }
  })

  test('an independent SQLite writer blocks the service before it reads or saves exceptions', async () => {
    const temporary = await createBookingsDatabase()
    let other: Database | undefined
    try {
      await temporary.up()
      await temporary.client.from('date_blocks').delete()
      other = new Database(
        {
          connection: 'concurrent',
          connections: {
            concurrent: {
              client: 'better-sqlite3',
              connection: temporary.client.getWriteClient().client.config.connection,
              useNullAsDefault: true,
              pool: { min: 1, max: 1 },
            },
          },
        },
        logger,
        emitter
      )
      const second = other.connection()
      await second.rawQuery('PRAGMA busy_timeout = 0')
      const service = new CalendarExceptionsService(second)
      const payload = await saveCalendarExceptionValidator.validate({
        localDate: '2026-12-25',
        dayBlock: { isBlocked: true },
      })
      const holder = await temporary.client.transaction()
      try {
        await holder.from('booking_settings').where('id', 1).update({ id: 1 })
        await assert.rejects(
          () => service.save(payload),
          (error: unknown) => (error as { code: string }).code.startsWith('SQLITE_BUSY')
        )
      } finally {
        await holder.rollback()
      }
      assert.deepEqual(await temporary.client.from('date_blocks'), [])
      const result = await service.save(payload)
      assert.equal(result.dateBlocks[0].isBlocked, true)
    } finally {
      await other?.manager.closeAll()
      await temporary.cleanup()
    }
  })
})
