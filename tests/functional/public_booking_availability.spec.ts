import assert from 'node:assert/strict'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import BookingAvailabilityService from '#services/booking_availability_service'
import WeeklyOpeningHour from '#models/weekly_opening_hour'
import WeeklyBreak from '#models/weekly_break'
import WeeklySlotBlock from '#models/weekly_slot_block'
import DateBlock from '#models/date_block'
import DateSlotBlock from '#models/date_slot_block'
import User from '#models/user'
import Customer from '#models/customer'
import { resetRateLimiter } from '#services/rate_limiter'
import { getJson, postJson, patchJson } from '#tests/helpers/api_client'

const date = '2026-12-25'
const path = `/api/availability?date=${date}`
let reference: DateTime
const fields = [
  'startsAtMinute',
  'endsAtMinute',
  'startsAtLocal',
  'endsAtLocal',
  'startsAtUtc',
  'endsAtUtc',
  'startOffsetMinutes',
  'endOffsetMinutes',
].sort()
type Body = {
  data: {
    localDate: string
    weekday: number
    timezone: string
    slotDurationMinutes: number
    slots: Array<Record<string, unknown>>
  }
  message?: string
}
async function json(response: Response, status = 200) {
  assert.equal(response.status, status)
  assert.ok(response.headers.get('content-type')?.includes('application/json'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return response.json() as Promise<Body>
}
async function read(suffix = path) {
  return json(await getJson(suffix))
}
async function open(weekday = 5) {
  return WeeklyOpeningHour.create({
    weekday,
    isActive: true,
    opensAtMinute: 540,
    closesAtMinute: 1080,
  })
}
async function snapshot() {
  const rows = []
  for (const table of [
    'booking_settings',
    'weekly_opening_hours',
    'weekly_breaks',
    'weekly_slot_blocks',
    'date_blocks',
    'date_slot_blocks',
  ])
    rows.push(await db.from(table).orderBy('id'))
  return rows
}
async function adminCookie() {
  const user = await User.create({
    email: 'availability-admin@example.test',
    password: 'TestPassword123',
    role: 'admin',
  })
  const result = await postJson('/api/admin/login', {
    email: user.email,
    password: 'TestPassword123',
  })
  assert.equal(result.response.status, 200)
  return result.cookie
}

test.group('public booking availability API', (group) => {
  group.each.setup(async () => {
    const config = db.getRawConnection('sqlite')?.config
    assert.equal(config?.client, 'better-sqlite3')
    assert.equal((config as { connection: { filename: string } }).connection.filename, ':memory:')
    for (const table of [
      'date_slot_blocks',
      'date_blocks',
      'weekly_slot_blocks',
      'weekly_breaks',
      'weekly_opening_hours',
      'booking_settings',
      'customers',
      'users',
    ])
      await db.from(table).delete()
    reference = DateTime.fromISO('2026-12-01T00:00:00Z')
    // Real service and real SQLite; only the clock is injected through the container.
    app.container.swap(
      BookingAvailabilityService,
      () => new BookingAvailabilityService(db, () => reference)
    )
    resetRateLimiter()
  })
  group.each.teardown(() => app.container.restore(BookingAvailabilityService))

  test('a visitor without cookies or CSRF reads an open future date in the stable public envelope', async () => {
    await open()
    const body = await read()
    assert.deepEqual(Object.keys(body), ['data'])
    assert.deepEqual(
      Object.keys(body.data).sort(),
      ['localDate', 'weekday', 'timezone', 'slotDurationMinutes', 'slots', 'policy'].sort()
    )
    assert.equal(body.data.localDate, date)
    assert.equal(body.data.weekday, 5)
    assert.equal(body.data.timezone, 'America/Sao_Paulo')
    assert.equal(body.data.slotDurationMinutes, 60)
    assert.deepEqual(
      body.data.slots.map((slot) => slot.startsAtMinute),
      [540, 600, 660, 720, 780, 840, 900, 960, 1020]
    )
    assert.deepEqual(Object.keys(body.data.slots[0]).sort(), fields)
    assert.equal(body.data.slots[0].startsAtLocal, `${date}T09:00:00.000`)
    assert.equal(body.data.slots[0].startsAtUtc, `${date}T12:00:00.000Z`)
  })

  test('closed and unconfigured days are successful empty results without database writes', async () => {
    const before = await snapshot()
    const absent = await read()
    assert.deepEqual(absent.data.slots, [])
    assert.deepEqual(await snapshot(), before)
    const day = await open()
    day.isActive = false
    await day.save()
    const closed = await read()
    assert.deepEqual(closed.data.slots, [])
  })

  test('weekly breaks, recurring slots and date slots combine with no duplicate calendar logic', async () => {
    const day = await open()
    await WeeklyBreak.create({
      weeklyOpeningHourId: day.id,
      startsAtMinute: 720,
      endsAtMinute: 780,
      isActive: true,
    })
    await WeeklySlotBlock.create({
      weeklyOpeningHourId: day.id,
      startsAtMinute: 600,
      isBlocked: true,
    })
    await DateSlotBlock.create({
      localDate: date,
      startsAtMinute: 900,
      isBlocked: true,
      reason: 'Private reason',
    })
    const result = await read()
    assert.deepEqual(
      result.data.slots.map((slot) => slot.startsAtMinute),
      [540, 660, 780, 840, 960, 1020]
    )
  })

  test('a whole-date block dominates released slots and a released date never opens a closed weekday', async () => {
    const day = await open()
    const block = await DateBlock.create({ localDate: date, isBlocked: true })
    await DateSlotBlock.create({ localDate: date, startsAtMinute: 600, isBlocked: false })
    const blocked = await read()
    assert.deepEqual(blocked.data.slots, [])
    block.isBlocked = false
    await block.save()
    const released = await read()
    assert.equal(released.data.slots.length, 9)
    day.isActive = false
    await day.save()
    const closed = await read()
    assert.deepEqual(closed.data.slots, [])
  })

  test('released date slots do not undo weekly pauses or blocks', async () => {
    const day = await open()
    await WeeklyBreak.create({
      weeklyOpeningHourId: day.id,
      startsAtMinute: 720,
      endsAtMinute: 780,
      isActive: true,
    })
    await WeeklySlotBlock.create({
      weeklyOpeningHourId: day.id,
      startsAtMinute: 600,
      isBlocked: true,
    })
    for (const startsAtMinute of [600, 720])
      await DateSlotBlock.create({ localDate: date, startsAtMinute, isBlocked: false })
    const body = await read()
    assert.equal(
      body.data.slots.some((slot) => slot.startsAtMinute === 600 || slot.startsAtMinute === 720),
      false
    )
  })

  test('past days and started slots return informative empty or future-only results with a controlled clock', async () => {
    await open()
    reference = DateTime.fromISO('2026-12-26T00:00:00Z')
    const past = await read()
    assert.deepEqual(past.data.slots, [])
    reference = DateTime.fromISO('2026-12-25T12:30:00Z')
    const today = await read()
    assert.equal(today.data.slots[0].startsAtMinute, 600)
    reference = DateTime.fromISO('2026-12-25T13:00:00Z')
    const exact = await read()
    assert.equal(exact.data.slots[0].startsAtMinute, 660)
  })

  test('leap dates within the public window are accepted and distant dates receive the documented policy error', async () => {
    reference = DateTime.fromISO('2028-02-01T12:00:00Z')
    await open(2) // 2028-02-29 is Tuesday.
    const leap = await read('/api/availability?date=2028-02-29')
    assert.equal(leap.data.localDate, '2028-02-29')
    assert.equal(leap.data.slots.length, 9)
    const future = await getJson('/api/availability?date=2099-12-25')
    assert.equal(future.status, 422)
    assert.equal(((await future.json()) as { code: string }).code, 'BOOKING_DATE_OUT_OF_RANGE')
  })

  test('invalid, missing, unknown, duplicated and structured query values produce JSON 422', async () => {
    for (const suffix of [
      '',
      '?date=',
      '?date=2026-02-29',
      '?date=1900-02-29',
      '?date=2028-02-30',
      '?date=2026-13-01',
      '?date=2026-1-01',
      '?date=2026-12-25T00:00:00Z',
      '?date=2026-12-25&serviceId=1',
      '?date=2026-12-25&now=2099-01-01',
      '?date=2026-12-25&date=2026-12-26',
      '?date=2026-12-25&date=2026-12-25',
      '?date=2026-12-25&%64ate=2026-12-26',
      '?date[]=2026-12-25',
      '?date[x]=2026-12-25',
      '?date=20261225',
      '?date=%202026-12-25',
      '?unknown=true',
      '?date=2026-12-25&__proto__[x]=1',
    ]) {
      await json(await getJson('/api/availability' + suffix, '', 'text/html'), 422)
    }
  })

  test('response contains no reasons, configuration IDs, customer, session or token fields', async () => {
    await open()
    await Customer.create({
      name: 'Private customer',
      phone: '71999991234',
      phoneNormalized: '71999991234',
    })
    await adminCookie()
    await DateSlotBlock.create({
      localDate: date,
      startsAtMinute: 600,
      isBlocked: true,
      reason: 'Private appointment reason',
    })
    const before = await snapshot()
    const body = await read()
    const encoded = JSON.stringify(body)
    for (const value of [
      'Private customer',
      '71999991234',
      'Private appointment reason',
      'availability-admin@example.test',
      'reason',
      'password',
      'session',
      'token',
      'createdAt',
      'updatedAt',
      '"id"',
    ])
      assert.equal(encoded.includes(value), false, value)
    for (const slot of body.data.slots) assert.deepEqual(Object.keys(slot).sort(), fields)
    assert.deepEqual(await snapshot(), before)
  })

  test('public results immediately follow actual administrative updates', async () => {
    const cookie = await adminCookie()
    const created = await patchJson(
      '/api/admin/booking-settings',
      { days: [{ weekday: 5, isActive: true, opensAtMinute: 540, closesAtMinute: 660 }] },
      cookie
    )
    assert.equal(created.response.status, 200)
    const first = await read()
    assert.equal(first.data.slots.length, 2)
    const blocked = await postJson(
      '/api/admin/calendar-exceptions',
      { localDate: date, dayBlock: { isBlocked: true } },
      cookie
    )
    assert.equal(blocked.response.status, 200)
    const closed = await read()
    assert.deepEqual(closed.data.slots, [])
    const released = await postJson(
      '/api/admin/calendar-exceptions',
      { localDate: date, dayBlock: { isBlocked: false } },
      cookie
    )
    assert.equal(released.response.status, 200)
    const restored = await read()
    assert.equal(restored.data.slots.length, 2)
  })

  test('the 61st query is 429 with Retry-After while catalogue, customer and admin endpoints remain independent', async () => {
    const cookie = await adminCookie()
    for (let attempt = 0; attempt < 60; attempt++) await json(await getJson(path))
    const response = await getJson(path)
    await json(response, 429)
    assert.ok(Number(response.headers.get('retry-after')) >= 1)
    assert.equal(response.headers.has('x-ratelimit-remaining'), false)
    const catalogue = await getJson('/api/services')
    assert.equal(catalogue.status, 200)
    const admin = await getJson('/api/admin/booking-settings', cookie)
    assert.equal(admin.status, 200)
    const customer = await postJson('/api/customers', { name: 'Cliente', phone: '71999992345' })
    assert.equal(customer.response.status, 200)
  })

  test('invalid queries also consume the availability budget', async () => {
    for (let attempt = 0; attempt < 60; attempt++)
      await json(await getJson('/api/availability'), 422)
    await json(await getJson(path), 429)
  })
})
