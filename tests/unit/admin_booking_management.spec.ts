import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { Database } from '@adonisjs/lucid/database'
import logger from '@adonisjs/core/services/logger'
import emitter from '@adonisjs/core/services/emitter'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import AdminBookingService, {
  AdminBookingConflictError,
  AdminBookingForbiddenError,
} from '#services/admin_booking_service'
import BookingCreationService from '#services/booking_creation_service'
import { createBookingsDatabase } from '#tests/helpers/bookings_database'

const now = DateTime.fromISO('2026-12-01T00:00:00Z')
const input = {
  serviceId: 1,
  localDate: '2026-12-28',
  startsAtMinute: 540,
  name: 'Cliente isolado',
  phone: '71999999999',
}
type Temporary = Awaited<ReturnType<typeof createBookingsDatabase>>
async function isolated(run: (temporary: Temporary) => Promise<void>) {
  // Same SQLite alias for Lucid's date formatter, with an independent database manager.
  const temporary = await createBookingsDatabase('sqlite')
  try {
    await temporary.up()
    await run(temporary)
  } finally {
    await temporary.cleanup()
  }
}
function independent(temporary: Temporary) {
  return new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
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
}

test.group('administrative booking persistence and concurrency', () => {
  test('list uses at most three SELECTs in one snapshot regardless of rows and only loads customer contact', async () => {
    await isolated(async (temporary) => {
      const creation = new BookingCreationService(temporary.client, () => now)
      for (const startsAtMinute of [540, 660, 780])
        await creation.create({ ...input, startsAtMinute, phone: `7199999${startsAtMinute}` })
      const queries: Array<{ sql: string; __knexTxId?: string }> = []
      const observe = (query: { sql: string; __knexTxId?: string }) => queries.push(query)
      const knex = temporary.client.getWriteClient()
      knex.on('query', observe)
      let result
      try {
        result = await new AdminBookingService(temporary.client).list({
          from: input.localDate,
          to: input.localDate,
        })
      } finally {
        knex.off('query', observe)
      }
      assert.equal(result.bookings.length, 3)
      assert.equal(result.meta.total, 3)
      const selects = queries.filter((query) => /^select\b/i.test(query.sql))
      assert.equal(selects.length, 3)
      assert.equal(new Set(selects.map((query) => query.__knexTxId)).size, 1)
      assert.equal(selects.filter((query) => /from [`"]customers[`"]/.test(query.sql)).length, 1)
      assert.equal(
        selects.some((query) =>
          /password|phone_normalized|sessions|from [`"]services[`"]/.test(query.sql)
        ),
        false
      )
    })
  })

  test('local date filtering includes a 23:00 booking whose UTC instant is on the following date', async () => {
    await isolated(async (temporary) => {
      await temporary.client.from('weekly_opening_hours').update({ closes_at_minute: 1440 })
      const booking = await new BookingCreationService(temporary.client, () => now).create({
        ...input,
        startsAtMinute: 1380,
      })
      assert.equal(
        DateTime.fromMillis(booking.startsAtUtc, { zone: 'utc' }).toISODate(),
        '2026-12-29'
      )
      const service = new AdminBookingService(temporary.client)
      const included = await service.list({ from: '2026-12-28', to: '2026-12-28' })
      assert.equal(included.meta.total, 1)
      const excluded = await service.list({ from: '2026-12-29', to: '2026-12-29' })
      assert.equal(excluded.meta.total, 0)
    })
  })

  test('writer lock precedes all cancellation reads and a real failure rolls back every audit field', async () => {
    await isolated(async (temporary) => {
      const booking = await new BookingCreationService(temporary.client, () => now).create(input)
      const before = await temporary.client.from('bookings').where('id', booking.id).first()
      await temporary.client.rawQuery(
        "CREATE TRIGGER cancel_failure BEFORE UPDATE ON bookings BEGIN SELECT RAISE(ABORT, 'test cancellation rollback'); END"
      )
      const sql: Array<{ sql: string; __knexTxId?: string }> = []
      const observe = (query: { sql: string; __knexTxId?: string }) => sql.push(query)
      const knex = temporary.client.getWriteClient()
      knex.on('query', observe)
      try {
        await assert.rejects(
          () =>
            new AdminBookingService(temporary.client, () => now).cancel(
              booking.id,
              'Motivo isolado',
              1
            ),
          /test cancellation rollback/
        )
      } finally {
        knex.off('query', observe)
      }
      const statements = sql.filter((query) => /^(select|update)\b/i.test(query.sql))
      assert.match(statements[0].sql, /^update [`"]booking_settings[`"] set/)
      assert.equal(new Set(statements.map((query) => query.__knexTxId)).size, 1)
      assert.deepEqual(
        await temporary.client.from('bookings').where('id', booking.id).first(),
        before
      )
    })
  })

  test('an admin revoked before the writer transaction cannot mutate audit even with a valid actor ID', async () => {
    await isolated(async (temporary) => {
      const booking = await new BookingCreationService(temporary.client, () => now).create(input)
      await temporary.client.from('users').where('id', 1).update({ role: 'user' })
      await assert.rejects(
        () => new AdminBookingService(temporary.client, () => now).cancel(booking.id, 'Motivo', 1),
        AdminBookingForbiddenError
      )
      const row = await temporary.client.from('bookings').where('id', booking.id).first()
      assert.equal(row.status, 'confirmed')
      assert.equal(row.cancelled_at_utc, null)
    })
  })

  test('clock is captured after the writer lock and started bookings reject without audit', async () => {
    await isolated(async (temporary) => {
      const booking = await new BookingCreationService(temporary.client, () => now).create(input)
      let locked = false
      const source = {
        transaction<T>(callback: (client: TransactionClientContract) => Promise<T>) {
          return temporary.client.transaction(async (client) => {
            await client.from('booking_settings').where('id', 1).update({ id: 1 })
            locked = true
            return callback(client)
          })
        },
      }
      const service = new AdminBookingService(source, () => {
        assert.equal(locked, true)
        return DateTime.fromMillis(booking.startsAtUtc)
      })
      await assert.rejects(() => service.cancel(booking.id, 'Motivo', 1), AdminBookingConflictError)
      const row = await temporary.client.from('bookings').where('id', booking.id).first()
      assert.equal(row.status, 'confirmed')
    })
  })

  test('two connections serialize cancellation, competing retry and replacement without losing the first audit', async () => {
    await isolated(async (temporary) => {
      const creation = new BookingCreationService(temporary.client, () => now)
      const booking = await creation.create(input)
      const other = independent(temporary)
      const second = other.connection()
      await second.rawQuery('PRAGMA busy_timeout = 0')
      let release!: () => void
      let locked!: () => void
      const held = new Promise<void>((resolve) => {
        locked = resolve
      })
      const proceed = new Promise<void>((resolve) => {
        release = resolve
      })
      const source = {
        transaction<T>(callback: (client: TransactionClientContract) => Promise<T>) {
          return temporary.client.transaction(async (client) => {
            const result = await callback(client)
            locked()
            await proceed
            return result
          })
        },
      }
      const pending = new AdminBookingService(source, () => now).cancel(
        booking.id,
        'Primeiro motivo',
        1
      )
      try {
        await held
        const retry = new AdminBookingService(second, () => now.plus({ days: 1 }))
        await assert.rejects(
          () => retry.cancel(booking.id, 'Outro motivo', 1),
          (error: unknown) => (error as { code: string }).code.startsWith('SQLITE_BUSY')
        )
        const replacement = new BookingCreationService(second, () => now)
        await assert.rejects(
          () => replacement.create({ ...input, phone: '71977777777' }),
          (error: unknown) => (error as { code: string }).code.startsWith('SQLITE_BUSY')
        )
        release()
        await pending
        const repeated = await retry.cancel(booking.id, 'Outro motivo', 1)
        assert.equal(repeated.cancellationReason, 'Primeiro motivo')
        assert.equal(repeated.cancelledAtUtc, now.toMillis())
        await replacement.create({ ...input, phone: '71977777777' })
        const rows = await second.from('bookings').orderBy('id')
        assert.equal(rows.length, 2)
        assert.equal(rows[0].status, 'cancelled')
        assert.equal(rows[1].status, 'confirmed')
        assert.equal(rows[0].starts_at_utc, rows[1].starts_at_utc)
        assert.deepEqual(await second.rawQuery('PRAGMA foreign_key_check'), [])
        await assert.rejects(
          () => second.from('customers').where('id', booking.customerId).delete(),
          (error: unknown) =>
            (error as { code: string }).code === 'SQLITE_CONSTRAINT_TRIGGER' &&
            (error as Error).message.endsWith('FOREIGN KEY constraint failed')
        )
        await assert.rejects(
          () => second.from('services').where('id', booking.serviceId).delete(),
          (error: unknown) =>
            (error as { code: string }).code === 'SQLITE_CONSTRAINT_TRIGGER' &&
            (error as Error).message.endsWith('FOREIGN KEY constraint failed')
        )
      } finally {
        release()
        await pending
        await other.manager.closeAll()
      }
    })
  })

  test('a list does not mix counts or statuses with independent cancellation and replacement commits', async () => {
    await isolated(async (temporary) => {
      const booking = await new BookingCreationService(temporary.client, () => now).create(input)
      await temporary.client.rawQuery('PRAGMA journal_mode = WAL')
      const other = independent(temporary)
      const source = {
        transaction<T>(callback: (client: TransactionClientContract) => Promise<T>) {
          return temporary.client.transaction(async (client) => {
            await client.from('bookings').select('id') // Pin the reader's snapshot.
            await new AdminBookingService(other.connection(), () => now).cancel(
              booking.id,
              'Motivo',
              1
            )
            await new BookingCreationService(other.connection(), () => now).create(input)
            return callback(client)
          })
        },
      }
      try {
        const original = await new AdminBookingService(source).list({
          from: input.localDate,
          to: input.localDate,
        })
        assert.equal(original.meta.total, 1)
        assert.equal(original.bookings.length, 1)
        assert.equal(original.bookings[0].status, 'confirmed')
        const current = await new AdminBookingService(temporary.client).list({
          from: input.localDate,
          to: input.localDate,
        })
        assert.equal(current.meta.total, 2)
        assert.deepEqual(
          current.bookings.map((row) => row.status),
          ['cancelled', 'confirmed']
        )
      } finally {
        await other.manager.closeAll()
      }
    })
  })
})
