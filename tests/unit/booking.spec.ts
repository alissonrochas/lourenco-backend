import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { Database } from '@adonisjs/lucid/database'
import logger from '@adonisjs/core/services/logger'
import emitter from '@adonisjs/core/services/emitter'
import Booking, { InvalidBookingTimeError } from '#models/booking'
import BookingAvailabilityService from '#services/booking_availability_service'
import { createBookingsDatabase } from '#tests/helpers/bookings_database'

const start = DateTime.fromISO('2026-12-28T12:00:00Z').toMillis()
const finish = start + 3600000
const timestamp = '2026-11-25 00:00:00'
const attributes = () => ({
  customerId: 1,
  serviceId: 1,
  startsAtUtc: start,
  endsAtUtc: finish,
  localDate: '2026-12-28',
  startsAtMinute: 540,
  serviceNameSnapshot: 'Corte preservado',
  servicePriceCentsSnapshot: 4500,
})
const row = (overrides: Record<string, unknown> = {}) => ({
  customer_id: 1,
  service_id: 1,
  starts_at_utc: start,
  ends_at_utc: finish,
  local_date: '2026-12-28',
  starts_at_minute: 540,
  service_name_snapshot: 'Corte preservado',
  service_price_cents_snapshot: 4500,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})
const cancelled = () => ({
  status: 'cancelled',
  cancelled_at_utc: start - 86400000,
  cancelled_by_user_id: 1,
  cancellation_reason: 'Cancelado pelo administrador',
})

async function isolated(
  run: (temporary: Awaited<ReturnType<typeof createBookingsDatabase>>) => Promise<void>
) {
  const temporary = await createBookingsDatabase()
  try {
    await temporary.up()
    await run(temporary)
  } finally {
    await temporary.cleanup()
  }
}
async function rejects(
  temporary: Awaited<ReturnType<typeof createBookingsDatabase>>,
  values: Record<string, unknown>
) {
  await assert.rejects(
    () => temporary.client.table('bookings').insert(row(values)).exec(),
    /constraint/i
  )
}

test.group('booking migration integrity', () => {
  test('real migration applies, rolls back and reapplies without changing any existing table or fixture', async () => {
    const temporary = await createBookingsDatabase()
    try {
      const before = await temporary.existingState()
      assert.equal(await temporary.client.schema.hasTable('bookings'), false)
      await temporary.up()
      await temporary.client.table('bookings').insert(row())
      assert.deepEqual(await temporary.existingState(), before)
      const indexes = await temporary.client.rawQuery('PRAGMA index_list(bookings)')
      assert.ok(
        indexes.some(
          (index: { name: string; unique: number; partial: number }) =>
            index.name === 'bookings_confirmed_start_unique' &&
            index.unique === 1 &&
            index.partial === 1
        )
      )
      await temporary.down()
      assert.equal(await temporary.client.schema.hasTable('bookings'), false)
      assert.deepEqual(await temporary.existingState(), before)
      await temporary.up()
      assert.deepEqual(await temporary.client.from('bookings'), [])
      assert.deepEqual(await temporary.existingState(), before)
    } finally {
      await temporary.cleanup()
    }
  })

  test('required columns, valid FKs and statuses are enforced by SQLite', async () => {
    await isolated(async (temporary) => {
      const pragma = await temporary.client.rawQuery('PRAGMA foreign_keys')
      assert.equal(pragma[0].foreign_keys, 1)
      for (const values of [
        { customer_id: 999999 },
        { service_id: 999999 },
        { customer_id: null },
        { service_id: null },
        { created_at: null },
        { updated_at: null },
        { starts_at_utc: null },
        { ends_at_utc: null },
        { status: null },
        { status: 'pending' },
        { status: 'CONFIRMED' },
      ])
        await rejects(temporary, values)
      await temporary.client.table('bookings').insert(row())
      const saved = await temporary.client.from('bookings').first()
      assert.equal(saved.status, 'confirmed')
      assert.equal(saved.cancelled_at_utc, null)
      assert.equal(saved.updated_at, timestamp)
    })
  })

  test('canonical integer UTC instants require an end exactly 60 minutes after start for every status', async () => {
    await isolated(async (temporary) => {
      for (const values of [
        { starts_at_utc: '2026-12-28T12:00:00Z' },
        { starts_at_utc: start + 0.5 },
        { starts_at_utc: Number.MAX_SAFE_INTEGER + 1 },
        { starts_at_utc: -62135596800001 },
        { ends_at_utc: start - 3600000 },
        { ends_at_utc: start },
        { ends_at_utc: start + 1800000 },
        { ends_at_utc: start + 7200000 },
        { ends_at_utc: finish + 0.5 },
        { ends_at_utc: 253402300800000 },
        { ...cancelled(), ends_at_utc: start + 1800000 },
      ])
        await rejects(temporary, values)
    })
  })

  test('real local calendar dates and hour-aligned local starts are constrained on insert and update', async () => {
    await isolated(async (temporary) => {
      for (const localDate of [
        '2026-02-29',
        '1900-02-29',
        '2028-02-30',
        '2026-04-31',
        '2026-13-01',
        '0000-01-01',
        '2026-1-01',
        '2026-12-28T00:00:00Z',
        null,
      ])
        await rejects(temporary, { local_date: localDate })
      for (const minute of [-60, 1440, 541, 540.5, 'invalid', null])
        await rejects(temporary, { starts_at_minute: minute })
      await temporary.client.table('bookings').insert(row({ local_date: '2028-02-29' }))
      await assert.rejects(
        () => temporary.client.from('bookings').update({ local_date: '2026-02-29' }).exec(),
        /constraint/i
      )
      await assert.rejects(
        () => temporary.client.from('bookings').update({ starts_at_minute: 541 }).exec(),
        /constraint/i
      )
    })
  })

  test('snapshot fields require a meaningful service name and a nonnegative safe integer price', async () => {
    await isolated(async (temporary) => {
      for (const name of [null, '', ' ', 'A', 'a'.repeat(121)])
        await rejects(temporary, { service_name_snapshot: name })
      for (const price of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'invalid'])
        await rejects(temporary, { service_price_cents_snapshot: price })
      await temporary.client.table('bookings').insert(row({ service_price_cents_snapshot: 0 }))
    })
  })

  test('partial UTC uniqueness rejects confirmed duplicates and accepts retained cancellations plus one new confirmation', async () => {
    await isolated(async (temporary) => {
      await temporary.client.table('bookings').insert(row())
      await assert.rejects(() => temporary.client.table('bookings').insert(row()).exec(), /unique/i)
      // Numeric text affinity still resolves to the same canonical integer key.
      await assert.rejects(
        () =>
          temporary.client
            .table('bookings')
            .insert(row({ starts_at_utc: String(start) }))
            .exec(),
        /unique/i
      )
      await temporary.client.from('bookings').update(cancelled())
      await temporary.client.table('bookings').insert(row())
      await temporary.client.table('bookings').insert(row(cancelled()))
      await rejects(temporary, {})
      const rows = await temporary.client.from('bookings').orderBy('id')
      assert.deepEqual(
        rows.map((record) => record.status),
        ['cancelled', 'confirmed', 'cancelled']
      )
      await assert.rejects(
        () =>
          temporary.client
            .from('bookings')
            .where('id', rows[0].id)
            .update({
              status: 'confirmed',
              cancelled_at_utc: null,
              cancelled_by_user_id: null,
              cancellation_reason: null,
            })
            .exec(),
        /unique/i
      )
    })
  })

  test('cancellation audit is complete only for cancelled rows and foreign keys preserve the actor', async () => {
    await isolated(async (temporary) => {
      for (const values of [
        { status: 'cancelled' },
        { ...cancelled(), cancelled_at_utc: null },
        { ...cancelled(), cancelled_at_utc: 'invalid' },
        { ...cancelled(), cancelled_by_user_id: null },
        { ...cancelled(), cancellation_reason: '' },
        { ...cancelled(), cancellation_reason: 'a'.repeat(501) },
        { cancelled_at_utc: start },
        { cancellation_reason: 'Unexpected audit' },
        { ...cancelled(), cancelled_by_user_id: 999999 },
      ])
        await rejects(temporary, values)
      await temporary.client.table('bookings').insert(row(cancelled()))
      await assert.rejects(
        () => temporary.client.from('users').where('id', 1).delete().exec(),
        /foreign key/i
      )
    })
  })

  test('customer and service deletion or primary-key changes never cascade to bookings', async () => {
    await isolated(async (temporary) => {
      await temporary.client.table('bookings').insert(row())
      for (const table of ['customers', 'services']) {
        await assert.rejects(
          () => temporary.client.from(table).where('id', 1).delete().exec(),
          /foreign key/i
        )
        await assert.rejects(
          () => temporary.client.from(table).where('id', 1).update({ id: 999999 }).exec(),
          /foreign key/i
        )
      }
      const bookings = await temporary.client.from('bookings')
      assert.equal(bookings.length, 1)
      assert.deepEqual(await temporary.client.rawQuery('PRAGMA foreign_key_check'), [])
    })
  })

  test('independent SQLite writers cannot commit two confirmations of the same UTC start', async () => {
    await isolated(async (temporary) => {
      const other = new Database(
        {
          connection: 'competing',
          connections: {
            competing: {
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
      try {
        const second = other.connection()
        await second.rawQuery('PRAGMA busy_timeout = 0')
        const first = await temporary.client.transaction()
        try {
          await first.table('bookings').insert(row())
          await assert.rejects(
            () => second.table('bookings').insert(row()).exec(),
            (error: unknown) => (error as { code: string }).code.startsWith('SQLITE_BUSY')
          )
          await first.commit()
        } finally {
          if (!first.isCompleted) await first.rollback()
        }
        await assert.rejects(() => second.table('bookings').insert(row()).exec(), /unique/i)
        const rows = await second.from('bookings')
        assert.equal(rows.length, 1)
      } finally {
        await other.manager.closeAll()
      }
    })
  })
})

test.group('Booking model persistence', () => {
  test('creates and reads through Lucid with customer/service relationships and camelCase mapping', async () => {
    await isolated(async (temporary) => {
      const trx = await temporary.client.transaction()
      try {
        const booking = await Booking.create(attributes(), { client: trx })
        await booking.refresh()
        assert.equal(booking.status, 'confirmed')
        assert.equal(booking.startsAtUtc, start)
        assert.equal(booking.endsAtUtc, finish)
        assert.ok(booking.createdAt.isValid && booking.updatedAt!.isValid)
        const loaded = await Booking.query({ client: trx })
          .where('id', booking.id)
          .preload('customer')
          .preload('service')
          .firstOrFail()
        assert.equal(loaded.customer.name, 'Cliente de teste')
        assert.equal(loaded.service.name, 'Corte preservado')
        const raw = await trx.from('bookings').where('id', booking.id).first()
        assert.equal(raw.customer_id, booking.customerId)
        assert.equal(raw.starts_at_utc, start)
        assert.equal(booking.serialize().startsAtUtc, start)
        assert.equal(booking.cancelledAtUtc, null)
      } finally {
        await trx.rollback()
      }
    })
  })

  test('model rejects local/UTC mismatches and unsafe boundaries that SQL cannot validate against IANA', async () => {
    await isolated(async (temporary) => {
      const trx = await temporary.client.transaction()
      try {
        for (const values of [
          { localDate: '2026-02-29' },
          { startsAtMinute: 541 },
          { startsAtMinute: 600 },
          { localDate: '2026-12-29' },
          { startsAtUtc: start + 60000, endsAtUtc: finish + 60000 },
          { endsAtUtc: start - 3600000 },
          { endsAtUtc: start + 1800000 },
          { startsAtUtc: start + 0.5, endsAtUtc: finish + 0.5 },
          {
            localDate: '2019-02-16',
            startsAtMinute: 1380,
            startsAtUtc: DateTime.fromISO('2019-02-17T01:00:00Z').toMillis(),
            endsAtUtc: DateTime.fromISO('2019-02-17T02:00:00Z').toMillis(),
          },
          {
            localDate: '2018-11-04',
            startsAtMinute: 0,
            startsAtUtc: DateTime.fromISO('2018-11-04T03:00:00Z').toMillis(),
            endsAtUtc: DateTime.fromISO('2018-11-04T04:00:00Z').toMillis(),
          },
        ])
          await assert.rejects(
            () => Booking.create({ ...attributes(), ...values }, { client: trx }),
            InvalidBookingTimeError
          )
        const rows = await trx.from('bookings')
        assert.deepEqual(rows, [])
      } finally {
        await trx.rollback()
      }
    })
  })

  test('service edits and deactivation preserve stored snapshots and personal data is not duplicated', async () => {
    await isolated(async (temporary) => {
      const trx = await temporary.client.transaction()
      try {
        const booking = await Booking.create(attributes(), { client: trx })
        await trx
          .from('services')
          .where('id', 1)
          .update({ name: 'Novo corte', price_cents: 9900, is_active: 0 })
        await booking.refresh()
        assert.equal(booking.serviceNameSnapshot, 'Corte preservado')
        assert.equal(booking.servicePriceCentsSnapshot, 4500)
        const columns = await trx.rawQuery('PRAGMA table_info(bookings)')
        assert.equal(
          columns.some((column: { name: string }) => /phone|customer_name/.test(column.name)),
          false
        )
      } finally {
        await trx.rollback()
      }
    })
  })

  test('a valid audit update preserves ID/createdAt and Lucid updates updatedAt without deleting history', async () => {
    await isolated(async (temporary) => {
      const trx = await temporary.client.transaction()
      try {
        const booking = await Booking.create(attributes(), { client: trx })
        await trx
          .from('bookings')
          .where('id', booking.id)
          .update({ updated_at: '2000-01-01 00:00:00' })
        await booking.refresh()
        const id = booking.id
        const createdAt = booking.createdAt.toISO()
        booking.merge({
          status: 'cancelled',
          cancelledAtUtc: start - 86400000,
          cancelledByUserId: 1,
          cancellationReason: 'Cancelamento de teste de persistência',
        })
        await booking.save()
        await booking.refresh()
        await booking.load('cancelledBy')
        assert.equal(booking.id, id)
        assert.equal(booking.createdAt.toISO(), createdAt)
        assert.ok(booking.updatedAt!.toMillis() > Date.parse('2000-01-01'))
        assert.equal(booking.cancelledBy.role, 'admin')
        const replacement = await Booking.create(attributes(), { client: trx })
        assert.notEqual(replacement.id, id)
        const rows = await trx.from('bookings')
        assert.equal(rows.length, 2)
      } finally {
        await trx.rollback()
      }
    })
  })

  test('engine slots map to canonical model instants including midnight/leap boundaries, without changing the engine', async () => {
    await isolated(async (temporary) => {
      const trx = await temporary.client.transaction()
      try {
        const service = new BookingAvailabilityService(temporary.client)
        const result = await service.calculate('2026-12-28', {
          now: DateTime.fromISO('2026-01-01T00:00:00Z'),
          client: trx,
        })
        const slot = result.slots[0]
        const booking = await Booking.create(
          {
            ...attributes(),
            localDate: slot.localDate,
            startsAtMinute: slot.startsAtMinute,
            startsAtUtc: DateTime.fromISO(slot.startsAtUtc).toMillis(),
            endsAtUtc: DateTime.fromISO(slot.endsAtUtc).toMillis(),
          },
          { client: trx }
        )
        assert.equal(booking.startsAtUtc, start)
        // Occupancy integration is deliberately not implemented: this remains eligible.
        const after = await service.calculate('2026-12-28', {
          now: DateTime.fromISO('2026-01-01T00:00:00Z'),
          client: trx,
        })
        assert.deepEqual(after, result)
        const leapStart = DateTime.fromISO('2028-03-01T02:00:00Z').toMillis()
        await Booking.create(
          {
            ...attributes(),
            localDate: '2028-02-29',
            startsAtMinute: 1380,
            startsAtUtc: leapStart,
            endsAtUtc: leapStart + 3600000,
          },
          { client: trx }
        )
      } finally {
        await trx.rollback()
      }
    })
  })
})
