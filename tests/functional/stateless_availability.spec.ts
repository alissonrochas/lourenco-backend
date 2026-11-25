import assert from 'node:assert/strict'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import SessionMiddleware from '@adonisjs/session/session_middleware'
import { SessionMiddlewareFactory } from '@adonisjs/session/factories'
import BookingAvailabilityService from '#services/booking_availability_service'
import WeeklyOpeningHour from '#models/weekly_opening_hour'
import User from '#models/user'
import { resetRateLimiter } from '#services/rate_limiter'
import { getJson, postJson, patchJson, baseUrl } from '#tests/helpers/api_client'

const path = '/api/availability?date=2026-12-25'
let calls: { constructed: number; read: number; write: number; touch: number; destroy: number }
const zero = () => ({ constructed: 0, read: 0, write: 0, touch: 0, destroy: 0 })

async function verifyPublic(response: Response, status: number) {
  assert.equal(response.status, status)
  assert.ok(response.headers.get('content-type')?.includes('application/json'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.has('set-cookie'), false)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.ok(response.headers.get('strict-transport-security')?.includes('max-age='))
  assert.deepEqual(calls, zero())
  assert.deepEqual(await db.from('sessions').select('*'), [])
}

class UnavailableService extends BookingAvailabilityService {
  async calculate(): Promise<never> {
    throw new Error('private SQL failure for regression test')
  }
}

test.group('stateless availability with instrumented SQLite session store', (group) => {
  group.each.setup(async () => {
    const config = db.getRawConnection('sqlite')?.config
    assert.equal(config?.client, 'better-sqlite3')
    assert.equal((config as { connection: { filename: string } }).connection.filename, ':memory:')
    for (const table of [
      'sessions',
      'date_slot_blocks',
      'date_blocks',
      'weekly_slot_blocks',
      'weekly_breaks',
      'weekly_opening_hours',
      'booking_settings',
      'users',
    ])
      await db.from(table).delete()
    calls = zero()
    // Instrument the actual session middleware, with a real isolated SQLite store.
    // Public requests must not even construct the store, not just avoid INSERTs.
    const sessions = await new SessionMiddlewareFactory()
      .merge({
        config: {
          store: 'instrumented',
          cookieName: 'adonis-session',
          stores: {
            instrumented: () => {
              calls.constructed++
              return {
                async read(id: string) {
                  calls.read++
                  const row = await db.from('sessions').where('id', id).first()
                  return row ? JSON.parse(row.data) : null
                },
                async write(id: string, values: Record<string, unknown>) {
                  calls.write++
                  await db
                    .table('sessions')
                    .insert({ id, data: JSON.stringify(values), expires_at: '2099-01-01 00:00:00' })
                    .onConflict('id')
                    .merge()
                },
                async touch(id: string) {
                  calls.touch++
                  await db
                    .from('sessions')
                    .where('id', id)
                    .update({ expires_at: '2099-01-01 00:00:00' })
                },
                async destroy(id: string) {
                  calls.destroy++
                  await db.from('sessions').where('id', id).delete()
                },
              }
            },
          },
        },
      })
      .create()
    app.container.swap(SessionMiddleware, () => sessions)
    app.container.swap(
      BookingAvailabilityService,
      () => new BookingAvailabilityService(db, () => DateTime.fromISO('2026-01-01T00:00:00Z'))
    )
    resetRateLimiter()
  })
  group.each.teardown(() => {
    app.container.restore(SessionMiddleware)
    app.container.restore(BookingAvailabilityService)
  })

  test('200 never initializes, reads, writes or touches an anonymous session', async () => {
    await WeeklyOpeningHour.create({
      weekday: 5,
      isActive: true,
      opensAtMinute: 540,
      closesAtMinute: 660,
    })
    const response = await getJson(path)
    await verifyPublic(response, 200)
    const body = (await response.json()) as { data: { slots: unknown[] } }
    assert.equal(body.data.slots.length, 2)
  })

  test('422 never initializes or persists a session, even with Accept HTML', async () => {
    await verifyPublic(await getJson('/api/availability?date=2026-02-29', '', 'text/html'), 422)
  })

  test('429 is reached on request 61, before session or Shield initialization, with security headers', async () => {
    for (let attempt = 0; attempt < 60; attempt++) await verifyPublic(await getJson(path), 200)
    const response = await getJson(path)
    await verifyPublic(response, 429)
    assert.ok(Number(response.headers.get('retry-after')) >= 1)
    // No double limiting: requests 1-60 above were accepted, not just the first 30.
  })

  test('503 keeps JSON, security headers and zero session persistence', async () => {
    app.container.swap(BookingAvailabilityService, () => new UnavailableService())
    const response = await getJson(path)
    await verifyPublic(response, 503)
    const body = (await response.json()) as { message: string }
    assert.deepEqual(body, { message: 'Não foi possível consultar os horários. Tente novamente.' })
  })

  test('HEAD retains the original stateful middleware pipeline and route-level limiter', async () => {
    const first = await fetch(`${baseUrl}${path}`, { method: 'HEAD' })
    assert.equal(first.status, 200)
    assert.ok(first.headers.has('set-cookie'))
    assert.ok(calls.constructed > 0 && calls.write > 0)
    const rows = await db.from('sessions').select('*')
    assert.equal(rows.length, 1)
    for (let attempt = 1; attempt < 60; attempt++) {
      const response = await fetch(`${baseUrl}${path}`, { method: 'HEAD' })
      assert.equal(response.status, 200)
    }
    const limited = await fetch(`${baseUrl}${path}`, { method: 'HEAD' })
    assert.equal(limited.status, 429)
  })

  test('other GET routes retain sessions, and anonymous writes still require CSRF', async () => {
    const csrf = await getJson('/api/csrf')
    assert.equal(csrf.status, 200)
    assert.ok(csrf.headers.has('set-cookie'))
    assert.ok(calls.read > 0 && calls.write > 0)
    const before = await db.from('sessions').select('*')
    assert.equal(before.length, 1)
    for (const [url, method, data] of [
      ['/api/customers', 'POST', { name: 'Cliente', phone: '71999992345' }],
      ['/api/admin/login', 'POST', { email: 'test@example.test', password: 'TestPassword123' }],
      ['/api/admin/booking-settings', 'PATCH', { days: [{ weekday: 1, isActive: false }] }],
    ] as const) {
      const response = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(data),
      })
      assert.equal(response.status, 403)
      const body = (await response.json()) as { code: string }
      assert.equal(body.code, 'E_BAD_CSRF_TOKEN')
    }
  })

  test('real administrative login, session cookies, CSRF writes and logout work with persisted sessions', async () => {
    await User.create({
      email: 'stateless-admin@example.test',
      password: 'TestPassword123',
      role: 'admin',
    })
    const login = await postJson('/api/admin/login', {
      email: 'stateless-admin@example.test',
      password: 'TestPassword123',
    })
    assert.equal(login.response.status, 200)
    assert.ok(calls.write > 0)
    const me = await getJson('/api/admin/me', login.cookie)
    assert.equal(me.status, 200)
    const rows = await db.from('sessions').select('*')
    assert.ok(rows.length > 0)
    const counts = { ...calls }
    const publicRead = await getJson(path, login.cookie)
    assert.equal(publicRead.status, 200)
    assert.equal(publicRead.headers.has('set-cookie'), false)
    assert.deepEqual(calls, counts)
    assert.deepEqual(await db.from('sessions').select('*'), rows)
    const settings = await patchJson(
      '/api/admin/booking-settings',
      { days: [{ weekday: 5, isActive: true, opensAtMinute: 540, closesAtMinute: 660 }] },
      login.cookie
    )
    assert.equal(settings.response.status, 200)
    const logout = await postJson('/api/admin/logout', {}, settings.cookie)
    assert.equal(logout.response.status, 200)
    const expired = await getJson('/api/admin/me', login.cookie)
    assert.equal(expired.status, 401)
  })

  test('similar URLs are not treated as the named public availability route', async () => {
    for (const url of [
      '/api/availability-extra',
      '/api/availability/extra',
      '/api/admin/availability',
    ]) {
      const response = await getJson(url)
      assert.equal(response.status, 404)
    }
    const admin = await getJson('/api/admin/booking-settings')
    assert.equal(admin.status, 401)
    assert.ok(calls.read > 0)
    // Unrelated public GET still executes the original session/Shield chain.
    const catalogue = await getJson('/api/services')
    assert.equal(catalogue.status, 200)
    assert.ok(catalogue.headers.has('set-cookie'))
  })
})
