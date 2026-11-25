import assert from 'node:assert/strict'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import { Database } from '@adonisjs/lucid/database'
import logger from '@adonisjs/core/services/logger'
import emitter from '@adonisjs/core/services/emitter'
import BookingAvailabilityService from '#services/booking_availability_service'
import { InvalidAvailabilityInputError } from '#services/booking_availability_engine'
import { createCalendarDatabase } from '#tests/helpers/calendar_database'

const date = '2026-12-28' // Monday: the isolated fixture has 09:00-18:00, lunch and a 10:00 block.
const now = DateTime.fromISO('2026-01-01T00:00:00Z')
const baseline = [540, 660, 780, 840, 900, 960, 1020]

async function availableStarts(service: BookingAvailabilityService) {
  const result = await service.calculate(date, { now })
  return result.slots.map((slot) => slot.startsAtMinute)
}

async function withDatabase(
  run: (
    temporary: Awaited<ReturnType<typeof createCalendarDatabase>>,
    service: BookingAvailabilityService
  ) => Promise<void>
) {
  const temporary = await createCalendarDatabase()
  try {
    await temporary.up()
    await run(temporary, new BookingAvailabilityService(temporary.client))
  } finally {
    await temporary.cleanup()
  }
}

test.group('booking availability persistence', () => {
  test('reads only the matching ISO weekday and ignores service duration and catalogue status', async () => {
    await withDatabase(async (temporary, service) => {
      const first = await service.calculate(date, { now })
      assert.equal(first.weekday, 1)
      assert.deepEqual(
        first.slots.map((slot) => slot.startsAtMinute),
        baseline
      )
      await temporary.client.from('services').update({ duration_minutes: 480, is_active: 0 })
      assert.deepEqual(await service.calculate(date, { now }), first)
      const friday = await service.calculate('2026-12-25', { now })
      assert.deepEqual(friday.slots, [])
    })
  })

  test('inactive and unconfigured persisted days remain closed despite released date exceptions', async () => {
    await withDatabase(async (temporary, service) => {
      await temporary.client.from('weekly_opening_hours').update({ is_active: 0 })
      await temporary.client
        .table('date_blocks')
        .insert({ local_date: date, is_blocked: 0, created_at: '2026-01-01 00:00:00' })
      assert.deepEqual(await availableStarts(service), [])
      await temporary.client
        .from('weekly_opening_hours')
        .update({ opens_at_minute: null, closes_at_minute: null })
      assert.deepEqual(await availableStarts(service), [])
    })
  })

  test('combines stored breaks, weekly blocks and date exceptions while ignoring inactive flags', async () => {
    await withDatabase(async (temporary, service) => {
      await temporary.client.table('date_slot_blocks').insert({
        local_date: date,
        starts_at_minute: 900,
        is_blocked: 1,
        reason: 'Private calendar reason',
        created_at: '2026-01-01 00:00:00',
      })
      let result = await service.calculate(date, { now })
      assert.deepEqual(
        result.slots.map((slot) => slot.startsAtMinute),
        [540, 660, 780, 840, 960, 1020]
      )
      assert.equal(JSON.stringify(result).includes('Private calendar reason'), false)
      await temporary.client.from('date_slot_blocks').update({ is_blocked: 0 })
      assert.deepEqual(await availableStarts(service), baseline)
      await temporary.client.from('weekly_breaks').update({ is_active: 0 })
      await temporary.client.from('weekly_slot_blocks').update({ is_blocked: 0 })
      result = await service.calculate(date, { now })
      assert.deepEqual(
        result.slots.map((slot) => slot.startsAtMinute),
        [540, 600, 660, 720, 780, 840, 900, 960, 1020]
      )
    })
  })

  test('whole-date closure dominates released slots and releasing it preserves other blockers', async () => {
    await withDatabase(async (temporary, service) => {
      await temporary.client
        .table('date_blocks')
        .insert({ local_date: date, is_blocked: 1, created_at: '2026-01-01 00:00:00' })
      await temporary.client.table('date_slot_blocks').insert({
        local_date: date,
        starts_at_minute: 600,
        is_blocked: 0,
        created_at: '2026-01-01 00:00:00',
      })
      assert.deepEqual(await availableStarts(service), [])
      await temporary.client.from('date_blocks').update({ is_blocked: 0 })
      assert.deepEqual(await availableStarts(service), baseline)
    })
  })

  test('calculation performs no writes and at most five selects in one transaction regardless of slot count', async () => {
    await withDatabase(async (temporary, service) => {
      await temporary.client.from('booking_settings').delete()
      const before = await temporary.existingState()
      const queries: Array<{ sql: string; __knexTxId?: string }> = []
      const observe = (query: { sql: string; __knexTxId?: string }) => queries.push(query)
      const knex = temporary.client.getWriteClient()
      knex.on('query', observe)
      try {
        await service.calculate(date, { now })
      } finally {
        knex.off('query', observe)
      }
      assert.equal(
        queries.some((query) =>
          /^\s*(insert|update|delete|replace|create|alter|drop)\b/i.test(query.sql)
        ),
        false
      )
      const selects = queries.filter((query) => /^select\b/i.test(query.sql))
      assert.equal(selects.length, 5)
      assert.equal(new Set(selects.map((query) => query.__knexTxId)).size, 1)
      assert.ok(selects.every((query) => typeof query.__knexTxId === 'string'))
      assert.equal(
        selects.some((query) => /reason|customers|sessions|users|\bservices\b/.test(query.sql)),
        false
      )
      assert.deepEqual(await temporary.existingState(), before)
      assert.deepEqual(await temporary.client.from('date_blocks'), [])
      assert.deepEqual(await temporary.client.from('date_slot_blocks'), [])
    })
  })

  test('uses uncommitted settings in an external transaction without closing or committing it', async () => {
    await withDatabase(async (temporary, service) => {
      const trx = await temporary.client.transaction()
      try {
        await trx.from('weekly_opening_hours').update({ opens_at_minute: 480 })
        const result = await service.calculate(date, { now, client: trx })
        assert.equal(result.slots[0].startsAtMinute, 480)
        assert.equal(trx.isCompleted, false)
        const rows = await trx.from('weekly_opening_hours').select('*')
        assert.equal(rows[0].opens_at_minute, 480)
      } finally {
        await trx.rollback()
      }
      assert.deepEqual(await availableStarts(service), baseline)
    })
  })

  test('reuses a coherent SQLite snapshot while another connection commits weekly and date changes', async () => {
    await withDatabase(async (temporary, service) => {
      await temporary.client.rawQuery('PRAGMA journal_mode = WAL')
      const other = new Database(
        {
          connection: 'snapshot_writer',
          connections: {
            snapshot_writer: {
              client: 'better-sqlite3',
              connection: temporary.client.getWriteClient().client.config.connection,
              useNullAsDefault: true,
            },
          },
        },
        logger,
        emitter
      )
      const trx = await temporary.client.transaction()
      try {
        // Pin the reader snapshot before the independent writer commits both changes.
        await trx.from('weekly_opening_hours').select('id')
        await other.transaction(async (writer) => {
          await writer.from('weekly_opening_hours').update({ is_active: 0 })
          await writer
            .table('date_blocks')
            .insert({ local_date: date, is_blocked: 1, created_at: '2026-01-01 00:00:00' })
        })
        const result = await service.calculate(date, { now, client: trx })
        assert.deepEqual(
          result.slots.map((slot) => slot.startsAtMinute),
          baseline
        )
        assert.equal(trx.isCompleted, false)
      } finally {
        await trx.rollback()
        await other.manager.closeAll()
      }
      const latest = await service.calculate(date, { now })
      assert.deepEqual(latest.slots, [])
    })
  })

  test('captures an injected clock once and validates input before any query', async () => {
    await withDatabase(async (temporary) => {
      let calls = 0
      const service = new BookingAvailabilityService(temporary.client, () => {
        calls++
        return now
      })
      await service.calculate(date)
      assert.equal(calls, 1)
      await service.calculate(date, { now })
      assert.equal(calls, 1)
    })
    const failOnQuery = new BookingAvailabilityService({
      transaction: async () => {
        throw new Error('unexpected database query')
      },
    })
    await assert.rejects(
      () => failOnQuery.calculate('2026-02-29', { now }),
      InvalidAvailabilityInputError
    )
    await assert.rejects(
      () => failOnQuery.calculate(date, { now: DateTime.invalid('invalid test instant') }),
      InvalidAvailabilityInputError
    )
  })
})
