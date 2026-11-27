import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { Database } from '@adonisjs/lucid/database'
import logger from '@adonisjs/core/services/logger'
import emitter from '@adonisjs/core/services/emitter'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import PublicBookingPolicy, {
  BookingHorizonError,
  BookingQuotaError,
} from '#services/public_booking_policy'
import BookingCreationService from '#services/booking_creation_service'
import BookingAvailabilityService from '#services/booking_availability_service'
import AdminBookingService from '#services/admin_booking_service'
import Booking from '#models/booking'
import Customer from '#models/customer'
import { createBookingsDatabase } from '#tests/helpers/bookings_database'

const policy = new PublicBookingPolicy()
const now = DateTime.fromISO('2026-12-01T12:00:00Z')
const input = {
  serviceId: 1,
  localDate: '2026-12-28',
  startsAtMinute: 540,
  name: 'Synthetic contact',
  phone: '71999999999',
}
type Temporary = Awaited<ReturnType<typeof createBookingsDatabase>>
async function isolated(run: (temp: Temporary, create: BookingCreationService) => Promise<void>) {
  const temp = await createBookingsDatabase('sqlite')
  try {
    await temp.up()
    await run(temp, new BookingCreationService(temp.client, () => now))
  } finally {
    await temp.cleanup()
  }
}
async function snapshot(temp: Temporary) {
  return {
    customers: await temp.client.from('customers').orderBy('id'),
    bookings: await temp.client.from('bookings').orderBy('id'),
  }
}
async function contact(
  temp: Temporary,
  values: { name: string; phone: string; phoneNormalized: string | null }
) {
  return temp.client.transaction((client) => Customer.create(values, { client }))
}
async function seed(temp: Temporary, customerId: number, date: string, minute: number) {
  const start = DateTime.fromISO(`${date}T00:00:00`, { zone: 'America/Sao_Paulo' }).plus({
    minutes: minute,
  })
  return temp.client.transaction((client) =>
    Booking.create(
      {
        customerId,
        serviceId: 1,
        localDate: date,
        startsAtMinute: minute,
        startsAtUtc: start.toMillis(),
        endsAtUtc: start.plus({ hours: 1 }).toMillis(),
        status: 'confirmed',
        serviceNameSnapshot: 'Historical snapshot',
        servicePriceCentsSnapshot: 1000,
      },
      { client }
    )
  )
}
function independent(temp: Temporary) {
  return new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: temp.client.getWriteClient().client.config.connection,
          useNullAsDefault: true,
          pool: { min: 1, max: 1 },
        },
      },
    },
    logger,
    emitter
  )
}
function heldSource(temp: Temporary) {
  let release!: () => void
  let reached!: () => void
  const held = new Promise<void>((r) => {
    reached = r
  })
  const gate = new Promise<void>((r) => {
    release = r
  })
  const source = {
    transaction<T>(callback: (trx: TransactionClientContract) => Promise<T>) {
      return temp.client.transaction(async (trx) => {
        const result = await callback(trx)
        reached()
        await gate
        return result
      })
    },
  }
  return { source, held, release: () => release() }
}

test.group('public booking policy calendar', () => {
  for (const [reference, min, max] of [
    ['2026-11-10T12:00:00Z', '2026-11-10', '2026-12-10'],
    ['2026-12-20T12:00:00Z', '2026-12-20', '2027-01-19'],
    ['2028-01-30T12:00:00Z', '2028-01-30', '2028-02-29'],
    ['2028-02-29T12:00:00Z', '2028-02-29', '2028-03-30'],
    ['2026-12-02T02:59:59Z', '2026-12-01', '2026-12-31'],
    ['2026-12-02T03:00:00Z', '2026-12-02', '2027-01-01'],
    ['2018-11-04T03:00:00Z', '2018-11-04', '2018-12-04'],
  ])
    test(`inclusive local window at ${reference}`, () => {
      const instant = DateTime.fromISO(reference)
      assert.deepEqual(policy.window(instant), {
        minDate: min,
        maxDate: max,
        timezone: 'America/Sao_Paulo',
      })
      policy.assertDate(min, instant)
      policy.assertDate(max, instant)
      for (const outside of [
        DateTime.fromISO(min).minus({ days: 1 }).toISODate()!,
        DateTime.fromISO(max).plus({ days: 1 }).toISODate()!,
      ])
        assert.throws(() => policy.assertDate(outside, instant), BookingHorizonError)
    })
  test('server settings are configurable and invalid clocks/configurations fail closed', () => {
    assert.equal(
      new PublicBookingPolicy({ advanceDays: 15, maxFutureBookings: 1 }).window(now).maxDate,
      '2026-12-16'
    )
    assert.throws(
      () => new PublicBookingPolicy({ advanceDays: -1, maxFutureBookings: 2 }),
      RangeError
    )
    assert.throws(
      () => new PublicBookingPolicy({ advanceDays: 30, maxFutureBookings: 0 }),
      RangeError
    )
    assert.throws(() => policy.assertDate(input.localDate, DateTime.invalid('test')))
    assert.throws(() => policy.assertDate('2026-02-29', now))
  })
})

test.group('public booking quota on isolated real SQLite', () => {
  test('two services share the same quota, equivalent formatting cannot bypass it and refusal preserves every row', async () =>
    isolated(async (temp, service) => {
      await service.create(input)
      await temp.client.table('services').insert({
        id: 2,
        name: 'Other service',
        price_cents: 5000,
        duration_minutes: 60,
        is_active: 1,
        created_at: '2026-12-01',
      })
      await service.create({
        ...input,
        serviceId: 2,
        startsAtMinute: 660,
        phone: '(71) 99999-9999',
      })
      const before = await snapshot(temp)
      await assert.rejects(
        () => service.create({ ...input, startsAtMinute: 780 }),
        BookingQuotaError
      )
      assert.deepEqual(await snapshot(temp), before)
    }))
  test('legacy NULL-normalized duplicates count together with the canonical row without merging or creating a customer', async () =>
    isolated(async (temp, service) => {
      const legacy = await contact(temp, {
        name: 'Legacy',
        phone: '(71) 99999-9999',
        phoneNormalized: null,
      })
      const duplicate = await contact(temp, {
        name: 'Other legacy',
        phone: '71 99999 9999',
        phoneNormalized: null,
      })
      await seed(temp, legacy.id, '2027-02-01', 540)
      await seed(temp, duplicate.id, '2027-02-01', 660)
      const before = await snapshot(temp)
      await assert.rejects(() => service.create(input), BookingQuotaError)
      assert.deepEqual(await snapshot(temp), before)
      await temp.client.from('bookings').where('customer_id', duplicate.id).delete()
      await service.create(input)
      const after = await snapshot(temp)
      assert.deepEqual(after.customers.slice(0, before.customers.length), before.customers)
      await assert.rejects(
        () => service.create({ ...input, startsAtMinute: 660 }),
        BookingQuotaError
      )
    }))
  test('cancelled and already-started confirmations do not consume quota; future historical bookings outside the horizon do', async () =>
    isolated(async (temp, service) => {
      const customer = await contact(temp, {
        name: 'Contact',
        phone: input.phone,
        phoneNormalized: input.phone,
      })
      await seed(temp, customer.id, '2026-12-01', 480) // began before now (09:00 local)
      await seed(temp, customer.id, '2026-12-01', 540) // begins exactly now
      const cancelled = await seed(temp, customer.id, '2026-12-28', 660)
      await new AdminBookingService(temp.client, () => now).cancel(cancelled.id, 'First audit', 1)
      await seed(temp, customer.id, '2027-05-01', 540)
      const before = await snapshot(temp)
      await service.create(input)
      await assert.rejects(
        () => service.create({ ...input, startsAtMinute: 780 }),
        BookingQuotaError
      )
      const after = await snapshot(temp)
      assert.deepEqual(after.bookings.slice(0, before.bookings.length), before.bookings)
    }))
  test('international prefix semantics stay unchanged and configuration is used for the quota', async () =>
    isolated(async (temp, service) => {
      await service.create(input)
      await service.create({ ...input, startsAtMinute: 660 })
      await service.create({ ...input, startsAtMinute: 780, phone: `55${input.phone}` })
      const strict = new BookingCreationService(
        temp.client,
        () => now,
        undefined,
        new PublicBookingPolicy({ advanceDays: 30, maxFutureBookings: 1 })
      )
      await assert.rejects(
        () => strict.create({ ...input, startsAtMinute: 840, phone: `55${input.phone}` }),
        BookingQuotaError
      )
    }))
  test('outside dates fail before any customer or booking write while the internal engine stays unrestricted', async () =>
    isolated(async (temp, service) => {
      const before = await snapshot(temp)
      await assert.rejects(
        () => service.create({ ...input, localDate: '2099-12-28' }),
        BookingHorizonError
      )
      assert.deepEqual(await snapshot(temp), before)
      const internal = await new BookingAvailabilityService(temp.client, () => now).calculate(
        '2099-12-28'
      )
      assert.equal(internal.localDate, '2099-12-28')
    }))
  test('captures time once after the lock and uses the same instant for horizon, quota and availability', async () =>
    isolated(async (temp) => {
      let clockCalls = 0
      const queries: string[] = []
      const knex = temp.client.getWriteClient()
      const observe = (query: { sql: string }) => queries.push(query.sql)
      knex.on('query', observe)
      try {
        const service = new BookingCreationService(temp.client, () => {
          clockCalls++
          assert.match(
            queries.find((sql) => /^update/i.test(sql))!,
            /booking_settings/
          )
          return now
        })
        await service.create(input)
        assert.equal(clockCalls, 1)
      } finally {
        knex.off('query', observe)
      }
    }))
  test('two independent simultaneous writers for different slots cannot exceed the last quota position', async () =>
    isolated(async (temp, service) => {
      await service.create(input)
      const other = independent(temp)
      const held = heldSource(temp)
      const first = new BookingCreationService(held.source, () => now).create({
        ...input,
        startsAtMinute: 660,
      })
      try {
        await held.held
        const second = other.connection()
        await second.rawQuery('PRAGMA busy_timeout = 0')
        const contender = new BookingCreationService(second, () => now)
        await assert.rejects(
          () => contender.create({ ...input, startsAtMinute: 780 }),
          (error: unknown) => (error as { code: string }).code.startsWith('SQLITE_BUSY')
        )
        held.release()
        await first
        await assert.rejects(
          () => contender.create({ ...input, startsAtMinute: 780 }),
          BookingQuotaError
        )
        const state = await snapshot(temp)
        assert.equal(state.bookings.length, 2)
        assert.equal(state.customers.length, 2)
      } finally {
        held.release()
        await first
        await other.manager.closeAll()
      }
    }))
  for (const cancelFirst of [true, false])
    test(`creation and cancellation follow SQLite commit order (cancel first: ${cancelFirst})`, async () =>
      isolated(async (temp, service) => {
        const booking = await service.create(input)
        if (cancelFirst) await service.create({ ...input, startsAtMinute: 660 })
        const held = heldSource(temp)
        const other = independent(temp)
        const first = cancelFirst
          ? new AdminBookingService(held.source, () => now).cancel(booking.id, 'First audit', 1)
          : new BookingCreationService(held.source, () => now).create({
              ...input,
              startsAtMinute: 660,
            })
        try {
          await held.held
          const second = other.connection()
          await second.rawQuery('PRAGMA busy_timeout = 0')
          const operation = () =>
            cancelFirst
              ? new BookingCreationService(second, () => now).create({
                  ...input,
                  startsAtMinute: 780,
                })
              : new AdminBookingService(second, () => now).cancel(booking.id, 'First audit', 1)
          await assert.rejects(operation, (error: unknown) =>
            (error as { code: string }).code.startsWith('SQLITE_BUSY')
          )
          held.release()
          await first
          await operation()
          const cancelled = await temp.client.from('bookings').where('id', booking.id).first()
          assert.equal(cancelled.status, 'cancelled')
          assert.equal(cancelled.cancellation_reason, 'First audit')
          const active = await temp.client.from('bookings').where('status', 'confirmed')
          assert.equal(active.length, cancelFirst ? 2 : 1)
        } finally {
          held.release()
          await first
          await other.manager.closeAll()
        }
      }))
})
