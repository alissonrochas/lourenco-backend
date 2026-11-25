import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { Database } from '@adonisjs/lucid/database'
import logger from '@adonisjs/core/services/logger'
import emitter from '@adonisjs/core/services/emitter'
import BookingSettingsService, {
  assertValidScheduleDay,
  InvalidBookingSettingsError,
} from '#services/booking_settings_service'
import { updateBookingSettingsValidator } from '#validators/booking_settings'
import { createScheduleDatabase } from '#tests/helpers/schedule_database'

const day = { isActive: true, opensAtMinute: 540, closesAtMinute: 1080, breaks: [], slotBlocks: [] }
const pause = { startsAtMinute: 720, endsAtMinute: 780, isActive: true }

test.group('weekly configuration effective validation', () => {
  test('closed unconfigured days and complete boundary blocks are valid', () => {
    assertValidScheduleDay({ ...day, isActive: false, opensAtMinute: null, closesAtMinute: null })
    assertValidScheduleDay({
      ...day,
      opensAtMinute: 0,
      closesAtMinute: 1440,
      slotBlocks: [{ startsAtMinute: 1380, isBlocked: true }],
    })
  })
  test('active or partly configured days require valid opening hours', () => {
    for (const input of [
      { ...day, opensAtMinute: null },
      { ...day, closesAtMinute: 540 },
      { ...day, opensAtMinute: 541 },
    ]) {
      assert.throws(() => assertValidScheduleDay(input), InvalidBookingSettingsError)
    }
  })
  test('active breaks cannot overlap or escape opening hours; adjacent breaks may touch', () => {
    assertValidScheduleDay({
      ...day,
      breaks: [pause, { ...pause, startsAtMinute: 780, endsAtMinute: 840 }],
    })
    for (const breaks of [
      [pause, { ...pause, endsAtMinute: 840 }],
      [{ ...pause, startsAtMinute: 480 }],
    ]) {
      assert.throws(() => assertValidScheduleDay({ ...day, breaks }), InvalidBookingSettingsError)
    }
    assertValidScheduleDay({ ...day, breaks: [{ ...pause, startsAtMinute: 0, isActive: false }] })
  })
  test('only blocked complete slots must fit and releasing one does not open the day', () => {
    assert.throws(
      () =>
        assertValidScheduleDay({ ...day, slotBlocks: [{ startsAtMinute: 1080, isBlocked: true }] }),
      InvalidBookingSettingsError
    )
    assertValidScheduleDay({
      ...day,
      isActive: false,
      opensAtMinute: null,
      closesAtMinute: null,
      slotBlocks: [{ startsAtMinute: 1080, isBlocked: false }],
    })
  })
})

test.group('weekly configuration transactions', () => {
  test('read on an empty temporary database does not create settings or days', async () => {
    const temporary = await createScheduleDatabase()
    try {
      await temporary.up()
      const service = new BookingSettingsService(temporary.client)
      const result = await service.read()
      assert.equal(result.settings, null)
      assert.deepEqual(result.days, [])
      assert.deepEqual(await temporary.client.from('booking_settings'), [])
      assert.deepEqual(await temporary.client.from('weekly_opening_hours'), [])
    } finally {
      await temporary.cleanup()
    }
  })

  test('a writer on an independent SQLite connection prevents stale reads and partial writes', async () => {
    const temporary = await createScheduleDatabase()
    let other: Database | undefined
    try {
      await temporary.up()
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
      const service = new BookingSettingsService(second)
      const payload = await updateBookingSettingsValidator.validate({
        days: [{ weekday: 1, isActive: true, opensAtMinute: 540, closesAtMinute: 1080 }],
      })
      const holder = await temporary.client.transaction()
      try {
        // Lock while the singleton is still absent: zero-row UPDATE must lock too.
        await holder.from('booking_settings').where('id', 1).update({ id: 1 })
        await assert.rejects(
          () => service.update(payload),
          (error: unknown) => (error as { code: string }).code.startsWith('SQLITE_BUSY')
        )
      } finally {
        await holder.rollback()
      }
      assert.deepEqual(await temporary.client.from('weekly_opening_hours'), [])
      const saved = await service.update(payload)
      assert.equal(saved.days[0].opensAtMinute, 540)
      assert.equal(saved.settings?.slotDurationMinutes, 60)
    } finally {
      await other?.manager.closeAll()
      await temporary.cleanup()
    }
  })
})
