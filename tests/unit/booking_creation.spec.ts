import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { Database } from '@adonisjs/lucid/database'
import logger from '@adonisjs/core/services/logger'
import emitter from '@adonisjs/core/services/emitter'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import BookingCreationService, {
  BookingSlotUnavailableError,
  BookingServiceUnavailableError,
} from '#services/booking_creation_service'
import BookingAvailabilityService from '#services/booking_availability_service'
import BookingSettingsService from '#services/booking_settings_service'
import CalendarExceptionsService from '#services/calendar_exceptions_service'
import { BookingCalendarConflictError } from '#services/booking_calendar_protection'
import { createBookingsDatabase } from '#tests/helpers/bookings_database'

const now = DateTime.fromISO('2026-12-01T00:00:00Z')
const input = {
  serviceId: 1,
  localDate: '2026-12-28',
  startsAtMinute: 540,
  name: 'Novo cliente',
  phone: '71999999999',
}

type Temporary = Awaited<ReturnType<typeof createBookingsDatabase>>
async function isolated(
  run: (temporary: Temporary, service: BookingCreationService) => Promise<void>
) {
  // Lucid's dateTime prepare helper resolves the model's connection name just
  // to obtain the SQL date format. Reuse the configured SQLite alias in this
  // independent manager; no application connection is registered or mutated.
  const temporary = await createBookingsDatabase('sqlite')
  try {
    await temporary.up()
    await run(temporary, new BookingCreationService(temporary.client, () => now))
  } finally {
    await temporary.cleanup()
  }
}
function independent(temporary: Temporary) {
  return new Database(
    {
      connection: 'other',
      connections: {
        other: {
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
async function rows(temporary: Temporary) {
  return {
    customers: await temporary.client.from('customers').orderBy('id'),
    bookings: await temporary.client.from('bookings').orderBy('id'),
  }
}

test.group('atomic public booking creation in isolated SQLite', () => {
  test('writer lock is the first statement and all relevant reads and inserts share one transaction', async () => {
    await isolated(async (temporary, service) => {
      const queries: Array<{ sql: string; __knexTxId?: string }> = []
      const observe = (query: { sql: string; __knexTxId?: string }) => queries.push(query)
      const knex = temporary.client.getWriteClient()
      knex.on('query', observe)
      try {
        await service.create(input)
      } finally {
        knex.off('query', observe)
      }
      const business = queries.filter((query) => /^(select|insert|update)\b/i.test(query.sql))
      assert.match(
        business[0].sql,
        /^update [`"]booking_settings[`"] set [`"]id[`"] = \? where [`"]id[`"] = \?/i
      )
      assert.equal(new Set(business.map((query) => query.__knexTxId)).size, 1)
      assert.ok(business.every((query) => typeof query.__knexTxId === 'string'))
      assert.ok(business.some((query) => /^select.*bookings/i.test(query.sql)))
    })
  })

  test('unavailable service and calendar conflicts rollback customer insertion and preserve prior rows', async () => {
    await isolated(async (temporary, service) => {
      const before = await rows(temporary)
      await assert.rejects(
        () => service.create({ ...input, serviceId: 99999 }),
        BookingServiceUnavailableError
      )
      assert.deepEqual(await rows(temporary), before)
      await assert.rejects(
        () => service.create({ ...input, startsAtMinute: 600 }),
        BookingSlotUnavailableError
      )
      assert.deepEqual(await rows(temporary), before)
    })
  })

  test('a genuine database constraint failure after customer insertion rolls back the entire transaction', async () => {
    await isolated(async (temporary, service) => {
      // Inject a database failure at the actual booking write, not a fake successful insert.
      await temporary.client.rawQuery(
        "CREATE TRIGGER fail_booking BEFORE INSERT ON bookings BEGIN SELECT RAISE(ABORT, 'test-only rollback'); END"
      )
      const before = await rows(temporary)
      await assert.rejects(() => service.create(input), /test-only rollback/)
      assert.deepEqual(await rows(temporary), before)
    })
  })

  test('unique constraint remains the final barrier even if an adapter supplies stale availability', async () => {
    await isolated(async (temporary, service) => {
      const stale = await new BookingAvailabilityService(temporary.client).calculate(
        input.localDate,
        { now }
      )
      await service.create(input)
      class StaleAvailability extends BookingAvailabilityService {
        async calculate() {
          return stale
        }
      }
      const brokenAdapter = new BookingCreationService(
        temporary.client,
        () => now,
        new StaleAvailability()
      )
      const before = await rows(temporary)
      await assert.rejects(
        () => brokenAdapter.create({ ...input, phone: '71977777777' }),
        (error: unknown) => (error as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
      )
      assert.deepEqual(await rows(temporary), before)
    })
  })

  test('two independent connections cannot confirm the same slot and contention never leaves partial customers', async () => {
    await isolated(async (temporary) => {
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
      let heldTransaction: TransactionClientContract | undefined
      const source = {
        transaction<T>(callback: (client: TransactionClientContract) => Promise<T>) {
          return temporary.client.transaction(async (client) => {
            const result = await callback(client)
            heldTransaction = client
            locked() // Booking exists but is not committed; the SQLite lock is held.
            await proceed
            return result
          })
        },
      }
      const first = new BookingCreationService(source, () => now).create(input)
      try {
        await held
        assert.equal(heldTransaction?.isCompleted, false)
        const contender = new BookingCreationService(second, () => now)
        await assert.rejects(
          () => contender.create({ ...input, phone: '71977777777' }),
          (error: unknown) => (error as { code: string }).code.startsWith('SQLITE_BUSY')
        )
        const calendar = new CalendarExceptionsService(second, () => now)
        const settings = new BookingSettingsService(second, () => now)
        await assert.rejects(
          () => calendar.save({ localDate: input.localDate, dayBlock: { isBlocked: true } }),
          (error: unknown) => (error as { code: string }).code.startsWith('SQLITE_BUSY')
        )
        await assert.rejects(
          () => settings.update({ days: [{ weekday: 1, isActive: false }] }),
          (error: unknown) => (error as { code: string }).code.startsWith('SQLITE_BUSY')
        )
        release()
        await first
        await assert.rejects(
          () => calendar.save({ localDate: input.localDate, dayBlock: { isBlocked: true } }),
          BookingCalendarConflictError
        )
        await assert.rejects(
          () => settings.update({ days: [{ weekday: 1, isActive: false }] }),
          BookingCalendarConflictError
        )
        await assert.rejects(
          () => contender.create({ ...input, phone: '71977777777' }),
          BookingSlotUnavailableError
        )
        const state = await rows(temporary)
        assert.equal(state.bookings.length, 1)
        assert.equal(state.customers.length, 2) // One preserved fixture plus the winner.
        assert.equal(
          state.customers.some((customer) => customer.phone === '71977777777'),
          false
        )
      } finally {
        release()
        await first
        await other.manager.closeAll()
      }
    })
  })

  test('a calendar writer holding an empty-settings lock prevents booking reads, then the committed block is respected', async () => {
    await isolated(async (temporary, service) => {
      await temporary.client.from('booking_settings').delete()
      const other = independent(temporary)
      const second = other.connection()
      await temporary.client.rawQuery('PRAGMA busy_timeout = 0')
      const holder = await second.transaction()
      try {
        await holder.from('booking_settings').where('id', 1).update({ id: 1 })
        await holder.table('date_slot_blocks').insert({
          local_date: input.localDate,
          starts_at_minute: 540,
          is_blocked: 1,
          created_at: '2026-01-01 00:00:00',
        })
        await assert.rejects(
          () => service.create(input),
          (error: unknown) => (error as { code: string }).code.startsWith('SQLITE_BUSY')
        )
        await holder.commit()
        await assert.rejects(() => service.create(input), BookingSlotUnavailableError)
        const state = await rows(temporary)
        assert.equal(state.bookings.length, 0)
        assert.equal(state.customers.length, 1)
        assert.deepEqual(await temporary.client.from('booking_settings'), [])
      } finally {
        if (!holder.isCompleted) await holder.rollback()
        await other.manager.closeAll()
      }
    })
  })

  test('future bookings prevent weekly closure, shrinkage, pauses and recurring blocks with full rollback', async () => {
    await isolated(async (temporary, service) => {
      const booking = await service.create(input)
      const settings = new BookingSettingsService(temporary.client, () => now)
      for (const patch of [
        { weekday: 1, isActive: false },
        { weekday: 1, opensAtMinute: 660, slotBlocks: [] },
        { weekday: 1, breaks: [{ startsAtMinute: 540, endsAtMinute: 600, isActive: true }] },
        { weekday: 1, slotBlocks: [{ startsAtMinute: 540, isBlocked: true }] },
      ]) {
        const before = await temporary.existingState()
        await assert.rejects(() => settings.update({ days: [patch] }), BookingCalendarConflictError)
        assert.deepEqual(await temporary.existingState(), before)
      }
      await settings.update({
        days: [
          { weekday: 2, isActive: false },
          { weekday: 1, closesAtMinute: 1140 },
        ],
      })
      const saved = await temporary.client.from('bookings').where('id', booking.id).first()
      assert.equal(saved.status, 'confirmed')
      assert.equal(saved.starts_at_utc, booking.startsAtUtc)
    })
  })

  test('date blocks protect confirmed bookings, allow unrelated slots and releases, and rollback multi-item payloads', async () => {
    await isolated(async (temporary, service) => {
      await service.create(input)
      const exceptions = new CalendarExceptionsService(temporary.client, () => now)
      const before = await temporary.existingState()
      for (const patch of [
        { localDate: input.localDate, dayBlock: { isBlocked: true } },
        {
          localDate: input.localDate,
          slotBlocks: [
            { startsAtMinute: 660, isBlocked: true },
            { startsAtMinute: 540, isBlocked: true },
          ],
        },
      ]) {
        await assert.rejects(() => exceptions.save(patch), BookingCalendarConflictError)
        assert.deepEqual(await temporary.existingState(), before)
      }
      await exceptions.save({
        localDate: input.localDate,
        dayBlock: { isBlocked: false },
        slotBlocks: [
          { startsAtMinute: 660, isBlocked: true },
          { startsAtMinute: 540, isBlocked: false },
        ],
      })
      const preserved = await rows(temporary)
      assert.equal(preserved.bookings.length, 1)
    })
  })

  test('ongoing bookings remain protected; cancelled and fully past bookings do not prevent calendar edits', async () => {
    await isolated(async (temporary, service) => {
      const booking = await service.create(input)
      const ongoing = () => DateTime.fromMillis(booking.startsAtUtc + 1800000)
      await assert.rejects(
        () =>
          new BookingSettingsService(temporary.client, ongoing).update({
            days: [{ weekday: 1, isActive: false }],
          }),
        BookingCalendarConflictError
      )
      await assert.rejects(
        () =>
          new CalendarExceptionsService(temporary.client, ongoing).save({
            localDate: input.localDate,
            dayBlock: { isBlocked: true },
          }),
        BookingCalendarConflictError
      )
      await new CalendarExceptionsService(temporary.client, () =>
        DateTime.fromMillis(booking.endsAtUtc)
      ).save({ localDate: input.localDate, dayBlock: { isBlocked: true } })
      await temporary.client.from('date_blocks').where('local_date', input.localDate).delete()
      // A model returned after commit must not fall back to the application's
      // default connection when this fixture uses an independent database manager.
      await temporary.client.from('bookings').where('id', booking.id).update({
        status: 'cancelled',
        cancelled_at_utc: now.toMillis(),
        cancelled_by_user_id: 1,
        cancellation_reason: 'Teste isolado',
      })
      const stored = await temporary.client.from('bookings').where('id', booking.id).first()
      assert.equal(stored.status, 'cancelled')
      await new BookingSettingsService(temporary.client, () => now).update({
        days: [{ weekday: 1, isActive: false }],
      })
      const cancelled = await rows(temporary)
      assert.equal(cancelled.bookings[0].status, 'cancelled')
    })
  })

  test('availability keeps calendar and occupancy on the same read snapshot across independent commits', async () => {
    await isolated(async (temporary, service) => {
      await temporary.client.rawQuery('PRAGMA journal_mode = WAL')
      const other = independent(temporary)
      const reader = await other.connection().transaction()
      try {
        await reader.from('weekly_opening_hours').select('id')
        await service.create(input)
        const availability = new BookingAvailabilityService(temporary.client)
        const old = await availability.calculate(input.localDate, { now, client: reader })
        assert.equal(
          old.slots.some((slot) => slot.startsAtMinute === 540),
          true
        )
        const current = await availability.calculate(input.localDate, { now })
        assert.equal(
          current.slots.some((slot) => slot.startsAtMinute === 540),
          false
        )
      } finally {
        await reader.rollback()
        await other.manager.closeAll()
      }
    })
  })
})
