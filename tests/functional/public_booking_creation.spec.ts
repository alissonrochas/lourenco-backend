import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { DateTime, Settings } from 'luxon'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import BookingCreationService from '#services/booking_creation_service'
import BookingAvailabilityService from '#services/booking_availability_service'
import Booking from '#models/booking'
import Customer from '#models/customer'
import Service from '#models/service'
import User from '#models/user'
import WeeklyOpeningHour from '#models/weekly_opening_hour'
import WeeklyBreak from '#models/weekly_break'
import WeeklySlotBlock from '#models/weekly_slot_block'
import DateBlock from '#models/date_block'
import DateSlotBlock from '#models/date_slot_block'
import { resetRateLimiter } from '#services/rate_limiter'
import { baseUrl, getJson, postJson, patchJson, mergeCookies } from '#tests/helpers/api_client'

const date = '2026-12-28'
const path = '/api/bookings'
let now: DateTime
let originalClock: () => number
let service: Service
const input = () => ({
  serviceId: service.id,
  localDate: date,
  startsAtMinute: 540,
  name: 'Cliente Exemplo',
  phone: '(71) 99999-9999',
})
type BookingResponse = {
  data: {
    id: number
    serviceName: string
    priceCents: number
    status: string
    localDate: string
    startsAtMinute: number
    startsAtLocal: string
    endsAtLocal: string
    timezone: string
    slotDurationMinutes: number
  }
  message?: string
}
async function submit(data: unknown = input(), status = 201) {
  const result = await postJson(path, data, '', 'text/html')
  assert.equal(result.response.status, status)
  assert.equal(result.response.headers.get('cache-control'), 'no-store')
  assert.ok(result.response.headers.get('content-type')?.includes('application/json'))
  return result.response.json() as Promise<BookingResponse>
}
async function count(table: string) {
  const row = await db.from(table).count('* as total').first()
  return Number(row.total)
}
async function clear() {
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
class FailureService extends BookingCreationService {
  async create(): Promise<never> {
    throw new Error('SELECT private_phone password secret.sqlite3')
  }
}
class BusyService extends BookingCreationService {
  async create(): Promise<never> {
    throw Object.assign(new Error('private SQL'), { code: 'SQLITE_BUSY' })
  }
}
class UniqueService extends BookingCreationService {
  async create(): Promise<never> {
    throw Object.assign(new Error('private SQL'), { code: 'SQLITE_CONSTRAINT_UNIQUE' })
  }
}

test.group('public booking creation', (group) => {
  group.each.setup(async () => {
    assert.equal(app.config.get('database.connections.sqlite.connection.filename'), ':memory:')
    await clear()
    resetRateLimiter()
    originalClock = Settings.now
    now = DateTime.fromISO('2026-12-01T00:00:00Z')
    Settings.now = () => now.toMillis()
    app.container.swap(BookingCreationService, () => new BookingCreationService(db, () => now))
    app.container.swap(
      BookingAvailabilityService,
      () => new BookingAvailabilityService(db, () => now)
    )
    service = await Service.create({
      name: 'Corte de teste',
      description: null,
      priceCents: 4500,
      durationMinutes: 45,
      isActive: true,
    })
    await WeeklyOpeningHour.create({
      weekday: 1,
      isActive: true,
      opensAtMinute: 540,
      closesAtMinute: 1080,
    })
  })
  group.each.teardown(async () => {
    Settings.now = originalClock
    app.container.restore(BookingCreationService)
    app.container.restore(BookingAvailabilityService)
    await clear()
  })

  test('anonymous creation returns an explicit confirmation and server-owned snapshots and UTC instants', async () => {
    const body = await submit()
    assert.deepEqual(Object.keys(body), ['data'])
    assert.deepEqual(
      Object.keys(body.data).sort(),
      [
        'id',
        'serviceName',
        'priceCents',
        'localDate',
        'startsAtMinute',
        'startsAtLocal',
        'endsAtLocal',
        'timezone',
        'slotDurationMinutes',
        'status',
      ].sort()
    )
    assert.equal(body.data.serviceName, service.name)
    assert.equal(body.data.priceCents, 4500)
    assert.equal(body.data.status, 'confirmed')
    assert.equal(body.data.startsAtLocal, `${date}T09:00:00.000-03:00`)
    assert.equal(body.data.endsAtLocal, `${date}T10:00:00.000-03:00`)
    assert.equal(body.data.timezone, 'America/Sao_Paulo')
    assert.equal(body.data.slotDurationMinutes, 60)
    const booking = await Booking.findOrFail(body.data.id)
    assert.equal(booking.startsAtUtc, DateTime.fromISO(`${date}T12:00:00Z`).toMillis())
    assert.equal(booking.endsAtUtc - booking.startsAtUtc, 3600000)
    assert.equal(await count('customers'), 1)
    assert.equal(await count('bookings'), 1)
    const customer = await Customer.findOrFail(booking.customerId)
    assert.equal(customer.phoneNormalized, '71999999999')
    const encoded = JSON.stringify(body)
    for (const field of [
      'phone',
      'customerId',
      'serviceId',
      'createdAt',
      'updatedAt',
      'cancelled',
      'session',
      'password',
      input().name,
    ])
      assert.equal(encoded.includes(field), false, field)
  })

  test('equivalent phones reuse a customer without exposing or overwriting their name', async () => {
    const customer = await Customer.create({
      name: 'Nome privado original',
      phone: '71999999999',
      phoneNormalized: '71999999999',
    })
    const body = await submit()
    assert.equal(await count('customers'), 1)
    const booking = await Booking.findOrFail(body.data.id)
    assert.equal(booking.customerId, customer.id)
    await customer.refresh()
    assert.equal(customer.name, 'Nome privado original')
    assert.equal(JSON.stringify(body).includes(customer.name), false)
    await submit({ ...input(), startsAtMinute: 600, phone: '71999999999' })
    assert.equal(await count('customers'), 1)
  })

  test('legacy NULL-normalized exact phones are reused and duplicate legacy records are preserved', async () => {
    const canonical = await Customer.create({
      name: 'Legado privado',
      phone: '71999999999',
      phoneNormalized: null,
    })
    const duplicate = await Customer.create({
      name: 'Duplicado preservado',
      phone: '(71)99999-9999',
      phoneNormalized: null,
    })
    const body = await submit()
    const booking = await Booking.findOrFail(body.data.id)
    assert.equal(booking.customerId, canonical.id)
    assert.equal(await count('customers'), 2)
    await canonical.refresh()
    assert.equal(canonical.phoneNormalized, null)
    assert.ok(await Customer.find(duplicate.id))
  })

  test('inactive and missing services reject atomically with the same generic response', async () => {
    service.isActive = false
    await service.save()
    const inactive = await submit(input(), 422)
    const missing = await submit({ ...input(), serviceId: 9999999 }, 422)
    assert.deepEqual(inactive, missing)
    assert.equal(await count('customers'), 0)
    assert.equal(await count('bookings'), 0)
  })

  test('closed days reject reservations without leaving a newly created customer', async () => {
    await submit({ ...input(), localDate: '2026-12-29' }, 409)
    await db.from('weekly_opening_hours').update({ is_active: 0 })
    await submit(input(), 409)
    assert.equal(await count('customers'), 0)
    assert.equal(await count('bookings'), 0)
  })

  test('weekly breaks, recurring blocks and date-slot blocks prevent confirmation', async () => {
    const day = await WeeklyOpeningHour.findByOrFail('weekday', 1)
    await WeeklyBreak.create({
      weeklyOpeningHourId: day.id,
      startsAtMinute: 600,
      endsAtMinute: 660,
      isActive: true,
    })
    await WeeklySlotBlock.create({
      weeklyOpeningHourId: day.id,
      startsAtMinute: 660,
      isBlocked: true,
    })
    await DateSlotBlock.create({
      localDate: date,
      startsAtMinute: 720,
      isBlocked: true,
      reason: 'Motivo privado',
    })
    for (const startsAtMinute of [600, 660, 720]) await submit({ ...input(), startsAtMinute }, 409)
    assert.equal(await count('customers'), 0)
  })

  test('whole-date block dominates released slots and cannot be overridden by a public payload', async () => {
    await DateBlock.create({ localDate: date, isBlocked: true, reason: 'Privado' })
    await DateSlotBlock.create({ localDate: date, startsAtMinute: 540, isBlocked: false })
    await submit(input(), 409)
    assert.equal(await count('bookings'), 0)
  })

  test('past and already-started slots are rejected using the server clock', async () => {
    for (const reference of [`${date}T12:00:00Z`, `${date}T12:30:00Z`, '2027-01-01T00:00:00Z']) {
      now = DateTime.fromISO(reference)
      await submit(input(), reference.startsWith('2027') ? 422 : 409)
    }
    assert.equal(await count('customers'), 0)
  })

  test('invalid dates, types, phone/name sizes and non-hour starts are rejected', async () => {
    const invalid = [
      { localDate: '2026-02-29' },
      { localDate: '1900-02-29' },
      { localDate: '2028-02-30' },
      { localDate: '2026-2-01' },
      { localDate: `${date}T00:00:00Z` },
      { localDate: null },
      { startsAtMinute: 541 },
      { startsAtMinute: -60 },
      { startsAtMinute: 1440 },
      { startsAtMinute: 540.5 },
      { startsAtMinute: '540' },
      { startsAtMinute: null },
      { serviceId: '1' },
      { serviceId: 0 },
      { serviceId: 1.5 },
      { serviceId: null },
      { serviceId: Number.MAX_SAFE_INTEGER + 1 },
      { name: 'a' },
      { name: 'a'.repeat(121) },
      { name: null },
      { name: ['Cliente'] },
      { phone: '123' },
      { phone: 'abc71999999999' },
      { phone: null },
      { phone: 71999999999 },
    ]
    for (const patch of invalid) {
      resetRateLimiter()
      await submit({ ...input(), ...patch }, 422)
    }
    await submit({}, 422)
    assert.equal(await count('customers'), 0)
    assert.equal(await count('bookings'), 0)
  })

  test('real leap dates within the horizon are accepted and customer name follows the existing trim rules', async () => {
    now = DateTime.fromISO('2028-02-01T12:00:00Z')
    await WeeklyOpeningHour.create({
      weekday: 2,
      isActive: true,
      opensAtMinute: 540,
      closesAtMinute: 600,
    })
    await submit({ ...input(), localDate: '2028-02-29', name: '  Cliente Trim  ' })
    const customer = await Customer.firstOrFail()
    assert.equal(customer.name, 'Cliente Trim')
  })

  test('unknown fields and attempts to set internal data are rejected instead of assigned', async () => {
    for (const field of [
      'id',
      'customerId',
      'priceCents',
      'serviceNameSnapshot',
      'servicePriceCentsSnapshot',
      'status',
      'durationMinutes',
      'endsAtUtc',
      'createdAt',
      'cancelledAtUtc',
      'cancelledByUserId',
      'cancellationReason',
      'role',
      'timezone',
      'phoneNormalized',
    ]) {
      resetRateLimiter()
      await submit({ ...input(), [field]: 'injected' }, 422)
    }
    assert.equal(await count('customers'), 0)
    assert.equal(await count('bookings'), 0)
  })

  test('repeated confirmations conflict without revealing the occupier and rollback new customers', async () => {
    await submit()
    const body = await submit({ ...input(), name: 'Outro cliente', phone: '71988888888' }, 409)
    assert.deepEqual(Object.keys(body), ['message'])
    assert.equal(JSON.stringify(body).includes('71999999999'), false)
    assert.equal(await count('bookings'), 1)
    assert.equal(await count('customers'), 1)
  })

  test('service edits do not rewrite the original booking snapshots', async () => {
    const first = await submit()
    service.merge({ name: 'Preço novo', priceCents: 9900 })
    await service.save()
    const second = await submit({ ...input(), startsAtMinute: 600 })
    assert.equal(second.data.serviceName, 'Preço novo')
    assert.equal(second.data.priceCents, 9900)
    const booking = await Booking.findOrFail(first.data.id)
    assert.equal(booking.serviceNameSnapshot, 'Corte de teste')
    assert.equal(booking.servicePriceCentsSnapshot, 4500)
  })

  test('GET excludes confirmed occupancy, retains cancelled slots and exposes no booking or contact data', async () => {
    const first = await submit()
    const response = await getJson(`/api/availability?date=${date}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.has('set-cookie'), false)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = (await response.json()) as { data: { slots: Array<{ startsAtMinute: number }> } }
    assert.equal(
      body.data.slots.some((slot) => slot.startsAtMinute === 540),
      false
    )
    const encoded = JSON.stringify(body)
    for (const privateField of [
      'customerId',
      'serviceId',
      'serviceName',
      'priceCents',
      'phone',
      'reason',
      '"id"',
      input().name,
    ])
      assert.equal(encoded.includes(privateField), false)
    const user = await User.create({
      email: 'audit@example.test',
      password: 'TestPassword123',
      role: 'admin',
    })
    const booking = await Booking.findOrFail(first.data.id)
    booking.merge({
      status: 'cancelled',
      cancelledAtUtc: now.toMillis(),
      cancelledByUserId: user.id,
      cancellationReason: 'Privado',
    })
    await booking.save()
    const available = await getJson(`/api/availability?date=${date}`)
    const restored = (await available.json()) as typeof body
    assert.equal(
      restored.data.slots.some((slot) => slot.startsAtMinute === 540),
      true
    )
    await submit()
    assert.equal(await count('bookings'), 2)
  })

  test('POST without a valid CSRF token is rejected and GET exemption does not cover creation', async () => {
    for (const token of ['', 'invalid']) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-XSRF-TOKEN': token,
        },
        body: JSON.stringify(input()),
      })
      assert.equal(response.status, 403)
    }
    assert.equal(await count('bookings'), 0)
    assert.equal(await count('customers'), 0)
  })

  test('creation accepts JSON only and does not merge query parameters into the validated body', async () => {
    const prime = await getJson('/api/csrf')
    const cookie = mergeCookies('', prime)
    const token = cookie.split(/;\s*/).find((part) => part.startsWith('XSRF-TOKEN='))!
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Cookie': cookie,
        'X-XSRF-TOKEN': decodeURIComponent(token.slice('XSRF-TOKEN='.length)),
      },
      body: new URLSearchParams(
        Object.entries(input()).map(([key, value]) => [key, String(value)])
      ),
    })
    assert.equal(response.status, 422)
    assert.deepEqual(await response.json(), { message: 'Envie uma reserva JSON válida.' })
    const queryOnly = await postJson(
      `${path}?serviceId=${service.id}&localDate=${date}&startsAtMinute=540&name=Cliente&phone=71999999999`,
      {}
    )
    assert.equal(queryOnly.response.status, 422)
    assert.equal(await count('customers'), 0)
    assert.equal(await count('bookings'), 0)
  })

  test('creation and lookup have independent rate budgets with Retry-After and no-store', async () => {
    for (let index = 0; index < 60; index++) {
      const response = await getJson(`/api/availability?date=${date}`)
      assert.equal(response.status, 200)
    }
    const lookupLimited = await getJson(`/api/availability?date=${date}`)
    assert.equal(lookupLimited.status, 429)
    await submit()
    for (let index = 1; index < 10; index++) await submit({}, 422)
    const limited = await postJson(path, input())
    assert.equal(limited.response.status, 429)
    assert.equal(limited.response.headers.get('cache-control'), 'no-store')
    assert.ok(Number(limited.response.headers.get('retry-after')) >= 1)
    const customer = await postJson('/api/customers', {
      name: 'Cliente separado',
      phone: '71977777777',
    })
    assert.equal(customer.response.status, 200)
    const catalogue = await getJson('/api/services')
    assert.equal(catalogue.status, 200)
  })

  test('unexpected errors are generic even with HTML Accept; busy and unique errors are controlled', async () => {
    app.container.swap(BookingCreationService, () => new FailureService())
    assert.deepEqual(await submit(input(), 500), {
      message: 'Não foi possível confirmar a reserva.',
    })
    app.container.swap(BookingCreationService, () => new BusyService())
    assert.deepEqual(await submit(input(), 503), {
      message: 'Não foi possível confirmar a reserva. Tente novamente.',
    })
    app.container.swap(BookingCreationService, () => new UniqueService())
    assert.deepEqual(await submit(input(), 409), {
      message: 'Horário indisponível. Consulte os horários novamente.',
    })
    assert.equal(await count('customers'), 0)
  })

  test('admin session remains valid across anonymous booking and public availability requests', async () => {
    const user = await User.create({
      email: 'booking-admin@example.test',
      password: 'TestPassword123',
      role: 'admin',
    })
    const login = await postJson('/api/admin/login', {
      email: user.email,
      password: 'TestPassword123',
    })
    assert.equal(login.response.status, 200)
    const created = await postJson(path, input(), login.cookie)
    assert.equal(created.response.status, 201)
    const publicResponse = await getJson(`/api/availability?date=${date}`, created.cookie)
    assert.equal(publicResponse.headers.has('set-cookie'), false)
    const me = await getJson('/api/admin/me', created.cookie)
    assert.equal(me.status, 200)
    const logout = await postJson('/api/admin/logout', {}, created.cookie)
    assert.equal(logout.response.status, 200)
    const loggedOut = await getJson('/api/admin/me', logout.cookie)
    assert.equal(loggedOut.status, 401)
  })
  test('authenticated calendar edits reject affected confirmations with JSON 409 and rollback all changes', async () => {
    await submit()
    const admin = await User.create({
      email: 'calendar-guard@example.test',
      password: 'TestPassword123',
      role: 'admin',
    })
    const login = await postJson('/api/admin/login', {
      email: admin.email,
      password: 'TestPassword123',
    })
    assert.equal(login.response.status, 200)
    const before = await db.from('weekly_opening_hours').orderBy('id')
    const weekly = await patchJson(
      '/api/admin/booking-settings',
      {
        days: [
          { weekday: 2, isActive: false },
          { weekday: 1, isActive: false },
        ],
      },
      login.cookie,
      'text/html'
    )
    assert.equal(weekly.response.status, 409)
    assert.equal(weekly.response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Object.keys((await weekly.response.json()) as object), ['message'])
    assert.deepEqual(await db.from('weekly_opening_hours').orderBy('id'), before)
    for (const patch of [
      { dayBlock: { isBlocked: true } },
      {
        slotBlocks: [
          { startsAtMinute: 600, isBlocked: true },
          { startsAtMinute: 540, isBlocked: true },
        ],
      },
    ]) {
      const blocked = await postJson(
        '/api/admin/calendar-exceptions',
        { localDate: date, ...patch },
        login.cookie,
        'text/html'
      )
      assert.equal(blocked.response.status, 409)
      assert.equal(blocked.response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(Object.keys((await blocked.response.json()) as object), ['message'])
      assert.deepEqual(await db.from('date_blocks'), [])
      assert.deepEqual(await db.from('date_slot_blocks'), [])
    }
    const unrelated = await postJson(
      '/api/admin/calendar-exceptions',
      { localDate: date, slotBlocks: [{ startsAtMinute: 600, isBlocked: true }] },
      login.cookie
    )
    assert.equal(unrelated.response.status, 200)
    const release = await postJson(
      '/api/admin/calendar-exceptions',
      { localDate: date, slotBlocks: [{ startsAtMinute: 540, isBlocked: false }] },
      login.cookie
    )
    assert.equal(release.response.status, 200)
    const booking = await Booking.firstOrFail()
    assert.equal(booking.status, 'confirmed')
    assert.equal(booking.startsAtMinute, 540)
    assert.equal(await count('bookings'), 1)
  })
})
