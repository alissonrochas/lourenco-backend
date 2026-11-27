import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { DateTime, Settings } from 'luxon'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import Booking from '#models/booking'
import Customer from '#models/customer'
import Service from '#models/service'
import WeeklyOpeningHour from '#models/weekly_opening_hour'
import AdminBookingService from '#services/admin_booking_service'
import BookingCreationService from '#services/booking_creation_service'
import BookingAvailabilityService from '#services/booking_availability_service'
import { resetRateLimiter } from '#services/rate_limiter'
import { baseUrl, getJson, postJson, patchJson } from '#tests/helpers/api_client'

const date = '2026-12-28'
const path = '/api/admin/bookings'
const query = `${path}?from=${date}&to=${date}`
let now: DateTime
let originalClock: () => number
let user: User
let service: Service
let cookie: string
const cancelPath = (id: number | string) => `${path}/${id}/cancel`
async function create(minute = 540, localDate = date, phone = '71999999999') {
  // Persist historical administrative fixtures directly: these may predate public limits.
  const customer = await Customer.firstOrCreate(
    { phoneNormalized: phone },
    { name: 'Cliente privado', phone }
  )
  const start = DateTime.fromISO(`${localDate}T00:00:00`, { zone: 'America/Sao_Paulo' }).plus({
    minutes: minute,
  })
  return Booking.create({
    customerId: customer.id,
    serviceId: service.id,
    localDate,
    startsAtMinute: minute,
    startsAtUtc: start.toMillis(),
    endsAtUtc: start.plus({ hours: 1 }).toMillis(),
    status: 'confirmed',
    serviceNameSnapshot: service.name,
    servicePriceCentsSnapshot: service.priceCents,
  })
}
type Entry = {
  id: number
  customer: { name: string; phone: string }
  serviceName: string
  priceCents: number
  startsAtLocal: string
  endsAtLocal: string
  status: string
  cancellation: { cancelledAtUtc: number; cancelledByUserId: number; reason: string } | null
}
type ListResponse = {
  data: Entry[]
  meta: { page: number; perPage: number; total: number; lastPage: number }
}
type AvailabilityResponse = { data: { slots: Array<{ startsAtMinute: number }> } }
async function json<T = Record<string, unknown>>(response: Response, status = 200) {
  assert.equal(response.status, status)
  assert.ok(response.headers.get('content-type')?.includes('application/json'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return response.json() as Promise<T>
}
async function list(suffix = query) {
  return json<ListResponse>(await getJson(suffix, cookie, 'text/html'))
}
async function cancel(
  id: number | string,
  body: unknown = { reason: 'Cancelamento solicitado' },
  status = 200
) {
  const result = await postJson(cancelPath(id), body, cookie, 'text/html')
  return json<{ data: Entry }>(result.response, status)
}
async function stored(id: number) {
  return db.from('bookings').where('id', id).first()
}
async function cleanup() {
  for (const table of [
    'bookings',
    'date_slot_blocks',
    'date_blocks',
    'weekly_slot_blocks',
    'weekly_breaks',
    'weekly_opening_hours',
    'booking_settings',
    'customers',
    'services',
    'users',
  ])
    await db.from(table).delete()
}
class Failure extends AdminBookingService {
  async list(): Promise<never> {
    throw new Error('SELECT phone secret.sqlite3 password')
  }
  async cancel(): Promise<never> {
    throw new Error('private phone audit SQL')
  }
}
class Busy extends AdminBookingService {
  async cancel(): Promise<never> {
    throw Object.assign(new Error('private SQL'), { code: 'SQLITE_BUSY' })
  }
}

test.group('administrative booking management', (group) => {
  group.each.setup(async () => {
    assert.equal(app.config.get('database.connections.sqlite.connection.filename'), ':memory:')
    await cleanup()
    resetRateLimiter()
    originalClock = Settings.now
    now = DateTime.fromISO('2026-12-01T12:00:00Z')
    Settings.now = () => now.toMillis()
    app.container.swap(AdminBookingService, () => new AdminBookingService(db, () => now))
    app.container.swap(BookingCreationService, () => new BookingCreationService(db, () => now))
    app.container.swap(
      BookingAvailabilityService,
      () => new BookingAvailabilityService(db, () => now)
    )
    user = await User.create({
      email: 'booking-management@example.test',
      password: 'TestPassword123',
      role: 'admin',
    })
    service = await Service.create({
      name: 'Corte histórico',
      description: null,
      priceCents: 4500,
      durationMinutes: 30,
      isActive: true,
    })
    await WeeklyOpeningHour.create({
      weekday: 1,
      isActive: true,
      opensAtMinute: 540,
      closesAtMinute: 1080,
    })
    const login = await postJson('/api/admin/login', {
      email: user.email,
      password: 'TestPassword123',
    })
    assert.equal(login.response.status, 200)
    cookie = login.cookie
  })
  group.each.teardown(async () => {
    Settings.now = originalClock
    app.container.restore(AdminBookingService)
    app.container.restore(BookingCreationService)
    app.container.restore(BookingAvailabilityService)
    await cleanup()
  })

  test('empty list has a stable paginated envelope and does not write data', async () => {
    const before = await db.from('booking_settings')
    assert.deepEqual(await list(), {
      data: [],
      meta: { page: 1, perPage: 50, total: 0, lastPage: 1 },
    })
    assert.deepEqual(await db.from('booking_settings'), before)
  })

  test('confirmed and cancelled bookings expose only explicit administrative data and historical snapshots', async () => {
    const booking = await create()
    const second = await create(600)
    await cancel(second.id)
    service.merge({ name: 'Catálogo atualizado', priceCents: 9900, isActive: false })
    await service.save()
    const body = await list()
    assert.equal(body.data.length, 2)
    assert.deepEqual(
      Object.keys(body.data[0]).sort(),
      [
        'id',
        'customer',
        'serviceName',
        'priceCents',
        'localDate',
        'startsAtMinute',
        'startsAtLocal',
        'endsAtLocal',
        'timezone',
        'slotDurationMinutes',
        'status',
        'cancellation',
      ].sort()
    )
    assert.equal(body.data[0].id, booking.id)
    assert.deepEqual(body.data[0].customer, { name: 'Cliente privado', phone: '71999999999' })
    assert.equal(body.data[0].serviceName, 'Corte histórico')
    assert.equal(body.data[0].priceCents, 4500)
    assert.equal(body.data[0].startsAtLocal, `${date}T09:00:00.000-03:00`)
    assert.equal(body.data[0].endsAtLocal, `${date}T10:00:00.000-03:00`)
    assert.equal(body.data[0].cancellation, null)
    assert.equal(body.data[1].status, 'cancelled')
    assert.deepEqual(body.data[1].cancellation, {
      cancelledAtUtc: now.toMillis(),
      cancelledByUserId: user.id,
      reason: 'Cancelamento solicitado',
    })
    for (const key of [
      'password',
      'phoneNormalized',
      'session',
      'token',
      'booking-management@example.test',
    ])
      assert.equal(JSON.stringify(body).includes(key), false)
  })

  test('local date filters are inclusive, preserve both statuses and sort by UTC then ID across pages', async () => {
    const later = await create(600)
    const earlier = await create(540)
    await cancel(earlier.id)
    const replacement = await create(540)
    await create(540, '2027-01-04')
    const body = await list(`${query}&perPage=2`)
    assert.deepEqual(
      body.data.map((item: { id: number }) => item.id),
      [earlier.id, replacement.id]
    )
    assert.deepEqual(body.meta, { page: 1, perPage: 2, total: 3, lastPage: 2 })
    const second = await list(`${query}&perPage=2&page=2`)
    assert.deepEqual(
      second.data.map((item: { id: number }) => item.id),
      [later.id]
    )
    const empty = await list(`${query}&perPage=2&page=3`)
    assert.deepEqual(empty.data, [])
    const range = await list(`${path}?from=2026-12-28&to=2027-01-04`)
    assert.equal(range.data.length, 4)
  })

  test('invalid, missing, unknown, repeated, structured and excessive query parameters are rejected', async () => {
    for (const suffix of [
      '',
      '?from=2026-02-29&to=2026-03-01',
      '?from=1900-02-29&to=1900-03-01',
      '?from=2026-12-28&to=2026-12-27',
      '?from=2026-12-01&to=2027-01-01',
      '?from=2026-1-01&to=2026-01-02',
      `?from=${date}&to=${date}&status=confirmed`,
      `?from=${date}&to=${date}&from=${date}`,
      `?from=${date}&to=${date}&%66rom=${date}`,
      `?from[]=${date}&to=${date}`,
      `?from=${date}&to=${date}&page=1&page=1`,
      `?from=${date}&to=${date}&perPage=10&perPage=20`,
      ...['0', '-1', '1.5', '01', '10001', 'abc', ''].map(
        (page) => `?from=${date}&to=${date}&page=${page}`
      ),
      ...['0', '101', '1.5', '01', ''].map(
        (perPage) => `?from=${date}&to=${date}&perPage=${perPage}`
      ),
    ])
      await json(await getJson(path + suffix, cookie, 'text/html'), 422)
    const leap = await list(`${path}?from=2028-02-29&to=2028-03-30&perPage=100`)
    assert.equal(leap.meta.perPage, 100)
  })

  test('anonymous, ordinary and revoked administrators cannot read or cancel bookings', async () => {
    const booking = await create()
    const anonymousList = await getJson(query)
    assert.equal(anonymousList.status, 401)
    const anonymous = await postJson(cancelPath(booking.id), { reason: 'Motivo' })
    assert.equal(anonymous.response.status, 401)
    user.role = 'user'
    await user.save()
    const revokedList = await getJson(query, cookie)
    assert.equal(revokedList.status, 403)
    const revoked = await postJson(cancelPath(booking.id), { reason: 'Motivo' }, cookie)
    assert.ok([401, 403].includes(revoked.response.status))
    const ordinary = await User.create({
      email: 'ordinary@example.test',
      password: 'TestPassword123',
      role: 'user',
    })
    const login = await postJson('/api/admin/login', {
      email: ordinary.email,
      password: 'TestPassword123',
    })
    assert.equal(login.response.status, 403)
    const confirmed = await stored(booking.id)
    assert.equal(confirmed.status, 'confirmed')
  })

  test('valid cancellation records complete server-owned audit and preserves all original references and snapshots', async () => {
    const booking = await create()
    const before = await stored(booking.id)
    const customers = await db.from('customers')
    now = now.plus({ days: 1 })
    const body = await cancel(booking.id, { reason: '  Solicitado pelo cliente  ' })
    assert.equal(body.data.status, 'cancelled')
    assert.deepEqual(body.data.cancellation, {
      cancelledAtUtc: now.toMillis(),
      cancelledByUserId: user.id,
      reason: 'Solicitado pelo cliente',
    })
    const after = await stored(booking.id)
    for (const key of [
      'id',
      'customer_id',
      'service_id',
      'starts_at_utc',
      'ends_at_utc',
      'local_date',
      'starts_at_minute',
      'service_name_snapshot',
      'service_price_cents_snapshot',
      'created_at',
    ])
      assert.equal(after[key], before[key], key)
    assert.notEqual(after.updated_at, before.updated_at)
    assert.deepEqual(await db.from('customers'), customers)
    const bookings = await db.from('bookings')
    assert.equal(bookings.length, 1)
  })

  test('repeated cancellation is 200 and preserves the first actor, time, reason and updatedAt even after the slot ends', async () => {
    const booking = await create()
    await cancel(booking.id)
    const before = await stored(booking.id)
    const other = await User.create({
      email: 'other-admin@example.test',
      password: 'TestPassword123',
      role: 'admin',
    })
    const login = await postJson('/api/admin/login', {
      email: other.email,
      password: 'TestPassword123',
    })
    cookie = login.cookie
    now = DateTime.fromISO('2027-01-01T00:00:00Z')
    const body = await cancel(booking.id, { reason: 'Outro motivo' })
    assert.equal(body.data.cancellation!.cancelledByUserId, user.id)
    assert.deepEqual(await stored(booking.id), before)
  })

  test('started, ongoing and ended confirmed bookings cannot be cancelled', async () => {
    const booking = await create()
    const before = await stored(booking.id)
    for (const millis of [
      booking.startsAtUtc,
      booking.startsAtUtc + 1800000,
      booking.endsAtUtc,
      booking.endsAtUtc + 1,
    ]) {
      now = DateTime.fromMillis(millis)
      await cancel(booking.id, { reason: 'Motivo' }, 409)
      assert.deepEqual(await stored(booking.id), before)
    }
  })

  test('reason must be nonblank text up to 500 characters and internal fields are rejected', async () => {
    const booking = await create()
    for (const body of [
      {},
      { reason: '' },
      { reason: '  ' },
      { reason: null },
      { reason: 123 },
      { reason: [] },
      { reason: 'a'.repeat(501) },
      ...[
        'id',
        'status',
        'customerId',
        'serviceId',
        'cancelledAtUtc',
        'cancelledByUserId',
        'cancellationReason',
        'updatedAt',
      ].map((key) => ({ reason: 'Motivo', [key]: 1 })),
    ])
      await cancel(booking.id, body, 422)
    const confirmed = await stored(booking.id)
    assert.equal(confirmed.status, 'confirmed')
    await cancel(booking.id, { reason: 'a'.repeat(500) })
  })

  test('invalid IDs return 422 and a valid missing ID returns JSON 404', async () => {
    for (const id of ['0', '-1', '01', '1.5', 'abc', '9007199254740992'])
      await cancel(id, { reason: 'Motivo' }, 422)
    await cancel(999999, { reason: 'Motivo' }, 404)
  })

  test('authenticated cancellation still requires a valid CSRF token', async () => {
    const booking = await create()
    for (const token of ['', 'invalid']) {
      const response = await fetch(`${baseUrl}${cancelPath(booking.id)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Cookie': cookie,
          'X-XSRF-TOKEN': token,
        },
        body: JSON.stringify({ reason: 'Motivo' }),
      })
      assert.equal(response.status, 403)
    }
    const confirmed = await stored(booking.id)
    assert.equal(confirmed.status, 'confirmed')
  })

  test('real insert/update failure rolls back audit atomically and never exposes SQL or customer data', async () => {
    const booking = await create()
    const before = await stored(booking.id)
    await db.rawQuery(
      "CREATE TRIGGER fail_admin_cancel BEFORE UPDATE ON bookings BEGIN SELECT RAISE(ABORT, 'private SQL phone'); END"
    )
    try {
      const body = await cancel(booking.id, { reason: 'Motivo privado' }, 409)
      assert.deepEqual(Object.keys(body), ['message'])
      assert.equal(JSON.stringify(body).includes('SQL'), false)
      assert.deepEqual(await stored(booking.id), before)
    } finally {
      await db.rawQuery('DROP TRIGGER fail_admin_cancel')
    }
  })

  test('cancelled slot reappears privately and a new public booking preserves cancellation history', async () => {
    const booking = await create()
    const before = await getJson(`/api/availability?date=${date}`)
    const occupied = (await before.json()) as { data: { slots: Array<{ startsAtMinute: number }> } }
    assert.equal(
      occupied.data.slots.some((slot) => slot.startsAtMinute === 540),
      false
    )
    await cancel(booking.id, { reason: 'Motivo administrativo privado' })
    const response = await getJson(`/api/availability?date=${date}`)
    assert.equal(response.headers.has('set-cookie'), false)
    const available = await json<AvailabilityResponse>(response)
    assert.equal(
      available.data.slots.some((slot: { startsAtMinute: number }) => slot.startsAtMinute === 540),
      true
    )
    for (const text of [
      'Cliente privado',
      '71999999999',
      'Motivo administrativo privado',
      'cancelledByUserId',
    ])
      assert.equal(JSON.stringify(available).includes(text), false)
    const replacement = await postJson('/api/bookings', {
      serviceId: service.id,
      localDate: date,
      startsAtMinute: 540,
      name: 'Outro cliente',
      phone: '71988888888',
    })
    assert.equal(replacement.response.status, 201)
    const confirmation = await replacement.response.json()
    assert.equal(JSON.stringify(confirmation).includes('Cliente privado'), false)
    const bookings = await db.from('bookings')
    assert.equal(bookings.length, 2)
    const cancelled = await stored(booking.id)
    assert.equal(cancelled.status, 'cancelled')
  })

  test('cancellation never opens a closed or blocked slot or a past date, and preserves calendar protections', async () => {
    const booking = await create()
    const refused = await postJson(
      '/api/admin/calendar-exceptions',
      { localDate: date, dayBlock: { isBlocked: true } },
      cookie
    )
    assert.equal(refused.response.status, 409)
    await cancel(booking.id)
    const closed = await patchJson(
      '/api/admin/booking-settings',
      { days: [{ weekday: 1, isActive: false }] },
      cookie
    )
    assert.equal(closed.response.status, 200)
    let response = await getJson(`/api/availability?date=${date}`)
    let body = await json<AvailabilityResponse>(response)
    assert.deepEqual(body.data.slots, [])
    await patchJson(
      '/api/admin/booking-settings',
      { days: [{ weekday: 1, isActive: true }] },
      cookie
    )
    const blocked = await postJson(
      '/api/admin/calendar-exceptions',
      { localDate: date, slotBlocks: [{ startsAtMinute: 540, isBlocked: true }] },
      cookie
    )
    assert.equal(blocked.response.status, 200)
    response = await getJson(`/api/availability?date=${date}`)
    body = await json<AvailabilityResponse>(response)
    assert.equal(
      body.data.slots.some((slot: { startsAtMinute: number }) => slot.startsAtMinute === 540),
      false
    )
    now = DateTime.fromMillis(booking.startsAtUtc)
    await postJson(
      '/api/admin/calendar-exceptions',
      { localDate: date, slotBlocks: [{ startsAtMinute: 540, isBlocked: false }] },
      cookie
    )
    response = await getJson(`/api/availability?date=${date}`)
    body = await json<AvailabilityResponse>(response)
    assert.equal(
      body.data.slots.some((slot: { startsAtMinute: number }) => slot.startsAtMinute === 540),
      false
    )
  })

  test('unexpected errors and temporary contention use generic JSON responses', async () => {
    app.container.swap(AdminBookingService, () => new Failure())
    assert.deepEqual(await json(await getJson(query, cookie, 'text/html'), 500), {
      message: 'Não foi possível concluir a operação.',
    })
    assert.deepEqual(await cancel(1, { reason: 'Motivo' }, 500), {
      message: 'Não foi possível concluir a operação.',
    })
    app.container.swap(AdminBookingService, () => new Busy())
    await cancel(1, { reason: 'Motivo' }, 503)
  })
})
