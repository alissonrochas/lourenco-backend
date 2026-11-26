import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { RATE_LIMITER_CAPACITY, rateLimiter, resetRateLimiter } from '#services/rate_limiter'
import { baseUrl, getJson, postJson } from '#tests/helpers/api_client'

const password = 'OnlySyntheticTestPassword'
const email = 'rate-admin@example.test'
test.group('login limiter memory regression with real HTTP and isolated SQLite', (group) => {
  group.each.setup(async () => {
    assert.equal(
      (db.getRawConnection('sqlite')!.config as { connection: { filename: string } }).connection
        .filename,
      ':memory:'
    )
    for (const table of ['bookings', 'customers', 'sessions', 'users'])
      await db.from(table).delete()
    resetRateLimiter()
    return () => resetRateLimiter()
  })
  test('40 new emails after the IP refusal allocate no keys and cannot authenticate valid credentials', async () => {
    await User.create({ email, password, role: 'admin' })
    let cookie = ''
    for (let i = 0; i < 30; i++) {
      const result = await postJson(
        '/api/admin/login',
        { email: `wrong-${i}@example.test`, password },
        cookie
      )
      assert.equal(result.response.status, 401)
      cookie = result.cookie
    }
    assert.equal(rateLimiter.size, 31)
    const before = rateLimiter.size
    for (let i = 0; i < 40; i++) {
      const result = await postJson(
        '/api/admin/login',
        { email: `new-${i}@example.test`, password },
        cookie
      )
      cookie = result.cookie
      assert.equal(result.response.status, 429)
      const retry = Number(result.response.headers.get('retry-after'))
      assert.ok(retry > 0 && retry <= 900)
    }
    const valid = await postJson('/api/admin/login', { email, password }, cookie)
    assert.equal(valid.response.status, 429)
    assert.equal(rateLimiter.size, before)
    const session = await getJson('/api/admin/me', valid.cookie)
    assert.equal(session.status, 401)
  })
  test('five attempts per normalized IP/email are preserved while another email may authenticate', async () => {
    await User.create({ email, password, role: 'admin' })
    let cookie = ''
    for (let i = 0; i < 5; i++) {
      const result = await postJson(
        '/api/admin/login',
        { email, password: 'IncorrectSyntheticPassword' },
        cookie
      )
      cookie = result.cookie
      assert.equal(result.response.status, 401)
    }
    const blocked = await postJson(
      '/api/admin/login',
      { email: email.toUpperCase(), password },
      cookie
    )
    assert.equal(blocked.response.status, 429)
    assert.ok(Number(blocked.response.headers.get('retry-after')) > 0)
    const other = 'other-rate-admin@example.test'
    await User.create({ email: other, password, role: 'admin' })
    const login = await postJson('/api/admin/login', { email: other, password }, blocked.cookie)
    assert.equal(login.response.status, 200)
    const session = await getJson('/api/admin/me', login.cookie)
    assert.equal(session.status, 200)
  })
  test('real login, session, CSRF denial and logout continue working', async () => {
    await User.create({ email, password, role: 'admin' })
    const login = await postJson('/api/admin/login', { email, password })
    assert.equal(login.response.status, 200)
    const me = await getJson('/api/admin/me', login.cookie)
    assert.equal(me.status, 200)
    const missingCsrf = await fetch(`${baseUrl}/api/admin/logout`, {
      method: 'POST',
      headers: { Cookie: login.cookie },
    })
    assert.equal(missingCsrf.status, 403)
    const csrfError = (await missingCsrf.json()) as { code: string }
    assert.equal(csrfError.code, 'E_BAD_CSRF_TOKEN')
    const stillAuthenticated = await getJson('/api/admin/me', login.cookie)
    assert.equal(stillAuthenticated.status, 200)
    const logout = await postJson('/api/admin/logout', {}, login.cookie)
    assert.equal(logout.response.status, 200)
    const denied = await getJson('/api/admin/me', logout.cookie)
    assert.equal(denied.status, 401)
  })
  test('the production capacity stays bounded and every consumer refuses untracked traffic at saturation', async () => {
    assert.equal(RATE_LIMITER_CAPACITY, 10000)
    rateLimiter.check('still-blocked', 1, 60000)
    let admitted = 1
    for (let i = 0; i < 20000; i++)
      if (rateLimiter.check(`capacity-${i}`, 1, 60000).allowed) admitted++
    assert.equal(admitted, RATE_LIMITER_CAPACITY)
    assert.equal(rateLimiter.size, RATE_LIMITER_CAPACITY)
    const availability = await getJson('/api/availability?date=2099-01-01')
    assert.equal(availability.status, 429)
    const customer = await postJson('/api/customers', {
      name: 'Synthetic customer',
      phone: '0000000000',
    })
    assert.equal(customer.response.status, 429)
    const booking = await postJson(
      '/api/bookings',
      {
        serviceId: 1,
        localDate: '2099-01-01',
        startsAtMinute: 540,
        name: 'Synthetic customer',
        phone: '0000000000',
      },
      customer.cookie
    )
    assert.equal(booking.response.status, 429)
    const login = await postJson('/api/admin/login', { email, password }, booking.cookie)
    assert.equal(login.response.status, 429)
    for (const response of [availability, customer.response, booking.response, login.response]) {
      assert.ok(Number(response.headers.get('retry-after')) > 0)
      assert.ok(response.headers.get('content-type')?.includes('application/json'))
    }
    assert.equal(rateLimiter.size, RATE_LIMITER_CAPACITY)
    assert.equal(rateLimiter.check('still-blocked', 1, 60000).allowed, false)
    const bookings = await db.from('bookings')
    assert.equal(bookings.length, 0)
  })
})
