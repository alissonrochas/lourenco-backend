import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import BookingCreationService from '#services/booking_creation_service'
import BookingAvailabilityService from '#services/booking_availability_service'
import WeeklyOpeningHour from '#models/weekly_opening_hour'
import Service from '#models/service'
import Customer from '#models/customer'
import Booking from '#models/booking'
import User from '#models/user'
import { resetRateLimiter } from '#services/rate_limiter'
import { getJson, postJson, baseUrl } from '#tests/helpers/api_client'

let now: DateTime
let service: Service
const input = () => ({
  serviceId: service.id,
  localDate: '2026-12-28',
  startsAtMinute: 540,
  name: 'Synthetic public contact',
  phone: '(71) 99999-9999',
})
async function submit(patch: Record<string, unknown> = {}, status = 201) {
  const result = await postJson('/api/bookings', { ...input(), ...patch })
  assert.equal(result.response.status, status)
  assert.equal(result.response.headers.get('cache-control'), 'no-store')
  assert.ok(result.response.headers.get('content-type')?.includes('application/json'))
  return result
}
async function rows() {
  return {
    customers: await db.from('customers').orderBy('id'),
    bookings: await db.from('bookings').orderBy('id'),
  }
}

test.group('public booking admission HTTP contract and privacy', (group) => {
  group.each.setup(async () => {
    assert.equal(app.config.get('database.connections.sqlite.connection.filename'), ':memory:')
    for (const table of [
      'bookings',
      'date_slot_blocks',
      'date_blocks',
      'weekly_slot_blocks',
      'weekly_breaks',
      'weekly_opening_hours',
      'booking_settings',
      'sessions',
      'customers',
      'services',
      'users',
    ])
      await db.from(table).delete()
    resetRateLimiter()
    now = DateTime.fromISO('2026-12-01T12:00:00Z')
    app.container.swap(BookingCreationService, () => new BookingCreationService(db, () => now))
    app.container.swap(
      BookingAvailabilityService,
      () => new BookingAvailabilityService(db, () => now)
    )
    service = await Service.create({
      name: 'Synthetic service',
      priceCents: 4500,
      durationMinutes: 60,
      isActive: true,
    })
    for (let weekday = 1; weekday <= 7; weekday++)
      await WeeklyOpeningHour.create({
        weekday,
        isActive: true,
        opensAtMinute: 540,
        closesAtMinute: 1080,
      })
  })
  group.each.teardown(() => {
    app.container.restore(BookingCreationService)
    app.container.restore(BookingAvailabilityService)
  })
  test('today and the last inclusive date share public policy metadata; begun slots remain unavailable', async () => {
    for (const date of ['2026-12-01', '2026-12-31']) {
      const response = await getJson(`/api/availability?date=${date}`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.has('set-cookie'), false)
      const body = (await response.json()) as {
        data: { policy: object; slots: Array<{ startsAtMinute: number }> }
      }
      assert.deepEqual(body.data.policy, {
        minDate: '2026-12-01',
        maxDate: '2026-12-31',
        timezone: 'America/Sao_Paulo',
      })
      if (date === '2026-12-01')
        assert.equal(
          body.data.slots.some((s) => s.startsAtMinute <= 540),
          false
        )
      await submit({ localDate: date, startsAtMinute: 600 })
    }
    await submit({ localDate: '2026-12-01', startsAtMinute: 540, phone: '71977777777' }, 409)
  })
  test('past and beyond-window dates return identical stable date errors from GET and POST without partial data', async () => {
    for (const localDate of ['2026-11-30', '2027-01-01', '2099-12-28']) {
      const before = await rows()
      const read = await getJson(`/api/availability?date=${localDate}`)
      assert.equal(read.status, 422)
      assert.equal(read.headers.get('cache-control'), 'no-store')
      assert.equal(read.headers.has('set-cookie'), false)
      const write = await submit({ localDate }, 422)
      const error = await write.response.json()
      assert.deepEqual(error, await read.json())
      assert.deepEqual(error, {
        code: 'BOOKING_DATE_OUT_OF_RANGE',
        message: 'Escolha uma data dentro do período de agendamento.',
        policy: { minDate: '2026-12-01', maxDate: '2026-12-31', timezone: 'America/Sao_Paulo' },
      })
      assert.deepEqual(await rows(), before)
    }
  })
  test('third booking uses a generic private 422 with no Retry-After and no change in stored rows', async () => {
    await submit()
    const other = await Service.create({
      name: 'Other service',
      priceCents: 8000,
      durationMinutes: 60,
      isActive: true,
    })
    await submit({ startsAtMinute: 600, serviceId: other.id, phone: '71999999999' })
    const before = await rows()
    const refused = await submit({ startsAtMinute: 660 }, 422)
    assert.equal(refused.response.headers.has('retry-after'), false)
    assert.deepEqual(await refused.response.json(), {
      code: 'PUBLIC_BOOKING_NOT_ACCEPTED',
      message: 'Não foi possível concluir a reserva pelo site. Entre em contato com a barbearia.',
    })
    assert.deepEqual(await rows(), before)
    // Availability is not personalized: this free slot remains visible to everyone.
    const read = await getJson('/api/availability?date=2026-12-28')
    const body = (await read.json()) as { data: { slots: Array<{ startsAtMinute: number }> } }
    assert.ok(body.data.slots.some((s) => s.startsAtMinute === 660))
    assert.equal(JSON.stringify(body).includes('71999999999'), false)
    assert.equal(JSON.stringify(body).includes('customer'), false)
  })
  test('simultaneous HTTP requests for different slots confirm only the last quota position', async () => {
    await submit()
    const results = await Promise.all(
      [600, 660].map((startsAtMinute) => postJson('/api/bookings', { ...input(), startsAtMinute }))
    )
    assert.deepEqual(results.map((result) => result.response.status).sort(), [201, 422])
    for (const result of results) {
      assert.equal(result.response.headers.get('cache-control'), 'no-store')
      if (result.response.status === 422)
        assert.deepEqual(await result.response.json(), {
          code: 'PUBLIC_BOOKING_NOT_ACCEPTED',
          message:
            'Não foi possível concluir a reserva pelo site. Entre em contato com a barbearia.',
        })
    }
    const state = await rows()
    assert.equal(state.bookings.length, 2)
    assert.equal(state.customers.length, 1)
  })
  test('legacy NULL duplicates with future bookings beyond the horizon refuse without exposing or rewriting contacts', async () => {
    for (const [phone, minute] of [
      ['(71)99999-9999', 540],
      ['71 99999 9999', 600],
    ] as const) {
      const contact = await Customer.create({
        name: 'Private historical identity',
        phone,
        phoneNormalized: null,
      })
      const start = DateTime.fromISO('2027-05-03T00:00:00', { zone: 'America/Sao_Paulo' }).plus({
        minutes: minute,
      })
      await Booking.create({
        customerId: contact.id,
        serviceId: service.id,
        localDate: '2027-05-03',
        startsAtMinute: minute,
        startsAtUtc: start.toMillis(),
        endsAtUtc: start.plus({ hours: 1 }).toMillis(),
        status: 'confirmed',
        serviceNameSnapshot: 'Historical',
        servicePriceCentsSnapshot: 3000,
      })
    }
    const before = await rows()
    const refused = await submit({}, 422)
    assert.deepEqual(
      Object.keys((await refused.response.json()) as Record<string, unknown>).sort(),
      ['code', 'message']
    )
    assert.deepEqual(await rows(), before)
  })
  test('cancellation frees quota, preserves history and first audit, and administrative authentication remains required', async () => {
    const first = await submit()
    const booking = ((await first.response.json()) as { data: { id: number } }).data
    await submit({ startsAtMinute: 600 })
    await submit({ startsAtMinute: 660 }, 422)
    const anonymous = await postJson(`/api/admin/bookings/${booking.id}/cancel`, {
      reason: 'Cannot authenticate',
    })
    assert.equal(anonymous.response.status, 401)
    await User.create({
      email: 'policy-admin@example.test',
      password: 'OnlyTestPassword123',
      role: 'admin',
    })
    const login = await postJson('/api/admin/login', {
      email: 'policy-admin@example.test',
      password: 'OnlyTestPassword123',
    })
    assert.equal(login.response.status, 200)
    const cancel = await postJson(
      `/api/admin/bookings/${booking.id}/cancel`,
      { reason: 'First audit' },
      login.cookie
    )
    assert.equal(cancel.response.status, 200)
    const repeated = await postJson(
      `/api/admin/bookings/${booking.id}/cancel`,
      { reason: 'Second reason' },
      cancel.cookie
    )
    assert.equal(repeated.response.status, 200)
    await submit({ startsAtMinute: 660 })
    const stored = await Booking.findOrFail(booking.id)
    assert.equal(stored.status, 'cancelled')
    assert.equal(stored.cancellationReason, 'First audit')
    const state = await rows()
    assert.equal(state.bookings.length, 3)
  })
  test('CSRF and ten-attempt IP budget still precede policy; eleven attempts cannot bypass either', async () => {
    const noCsrf = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input()),
    })
    assert.equal(noCsrf.status, 403)
    for (let i = 0; i < 10; i++) await submit({ localDate: '2099-01-01' }, 422)
    const limited = await submit({}, 429)
    assert.ok(Number(limited.response.headers.get('retry-after')) > 0)
    assert.deepEqual(await rows(), { customers: [], bookings: [] })
  })
})
