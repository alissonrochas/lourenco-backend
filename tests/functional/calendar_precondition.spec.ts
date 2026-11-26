import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import User from '#models/user'
import { resetRateLimiter } from '#services/rate_limiter'
import { baseUrl, getJson, mergeCookies, postJson } from '#tests/helpers/api_client'

const weekly = '/api/admin/booking-settings'
const dates = '/api/admin/calendar-exceptions'
const date = '2028-02-29'
async function login() {
  await User.create({ email: 'revision@example.test', password: 'RevisionTest123', role: 'admin' })
  const result = await postJson('/api/admin/login', {
    email: 'revision@example.test',
    password: 'RevisionTest123',
  })
  assert.equal(result.response.status, 200)
  return result.cookie
}
async function write(path: string, body: unknown, cookie: string, tag: string) {
  const prime = await getJson('/api/csrf', cookie)
  cookie = mergeCookies(cookie, prime)
  const token = cookie.split(/;\s*/).find((c) => c.startsWith('XSRF-TOKEN='))!
  return fetch(`${baseUrl}${path}`, {
    method: path === weekly ? 'PATCH' : 'POST',
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': decodeURIComponent(token.slice(11)),
      'If-Match': tag,
    },
    body: JSON.stringify(body),
  })
}
async function snapshot() {
  return Promise.all(
    [
      'weekly_opening_hours',
      'weekly_breaks',
      'weekly_slot_blocks',
      'date_blocks',
      'date_slot_blocks',
      'bookings',
    ].map((t) => db.from(t).orderBy('id'))
  )
}
async function tagOf(path: string, cookie: string) {
  const response = await getJson(path, cookie)
  return response.headers.get('etag')!
}
async function statusOf(response: Promise<Response>) {
  const result = await response
  return result.status
}
test.group('calendar optimistic preconditions inside writer transaction', (group) => {
  group.each.setup(async () => {
    resetRateLimiter()
    assert.equal(
      (db.getRawConnection('sqlite')!.config as { connection: { filename: string } }).connection
        .filename,
      ':memory:'
    )
    for (const t of [
      'bookings',
      'date_slot_blocks',
      'date_blocks',
      'weekly_slot_blocks',
      'weekly_breaks',
      'weekly_opening_hours',
      'booking_settings',
      'customers',
      'sessions',
      'users',
    ])
      await db.from(t).delete()
  })
  test('GET tags are stable without creating settings or exposing snapshot content', async () => {
    const cookie = await login()
    const before = await snapshot()
    for (const path of [weekly, `${dates}?from=${date}&to=${date}`]) {
      const first = await getJson(path, cookie)
      const second = await getJson(path, cookie)
      assert.equal(first.status, 200)
      assert.match(first.headers.get('etag')!, /^"[a-f0-9]{64}"$/)
      assert.equal(first.headers.get('etag'), second.headers.get('etag'))
      assert.equal(first.headers.get('cache-control'), 'no-store')
    }
    assert.deepEqual(await snapshot(), before)
    const settings = await db.from('booking_settings')
    assert.equal(settings.length, 0)
  })
  test('weekly stale edit returns controlled 409 and leaves all data untouched', async () => {
    const cookie = await login()
    const tag = await tagOf(weekly, cookie)
    const body = {
      days: [{ weekday: 1, isActive: true, opensAtMinute: 540, closesAtMinute: 1080 }],
    }
    const saved = await write(weekly, body, cookie, tag)
    assert.equal(saved.status, 200)
    assert.notEqual(saved.headers.get('etag'), tag)
    assert.equal(await tagOf(weekly, cookie), saved.headers.get('etag'))
    const before = await snapshot()
    const stale = await write(weekly, { days: [{ weekday: 1, isActive: false }] }, cookie, tag)
    assert.equal(stale.status, 409)
    assert.equal(stale.headers.get('cache-control'), 'no-store')
    const error = (await stale.json()) as { message: string }
    assert.match(error.message, /outra operação/)
    assert.deepEqual(await snapshot(), before)
  })
  test('date revision is scoped to one selected date, not a range or another day', async () => {
    const cookie = await login()
    const tag = await tagOf(`${dates}?from=${date}&to=${date}`, cookie)
    const wrong = await write(
      dates,
      { localDate: '2028-03-01', dayBlock: { isBlocked: true } },
      cookie,
      tag
    )
    assert.equal(wrong.status, 409)
    const saved = await write(
      dates,
      { localDate: date, dayBlock: { isBlocked: true, reason: 'Privado' } },
      cookie,
      tag
    )
    assert.equal(saved.status, 200)
    assert.equal(await tagOf(`${dates}?from=${date}&to=${date}`, cookie), saved.headers.get('etag'))
    const before = await snapshot()
    assert.equal(
      await statusOf(
        write(dates, { localDate: date, dayBlock: { isBlocked: false } }, cookie, tag)
      ),
      409
    )
    assert.deepEqual(await snapshot(), before)
  })
  for (const tag of ['*', 'W/"abc"', 'invalid'])
    test(`malformed precondition ${tag} is rejected without writes`, async () => {
      const cookie = await login()
      const before = await snapshot()
      assert.equal(
        await statusOf(write(weekly, { days: [{ weekday: 1, isActive: false }] }, cookie, tag)),
        422
      )
      assert.deepEqual(await snapshot(), before)
    })
  test('two real HTTP writers with the same revision cannot silently overwrite each other', async () => {
    const cookie = await login()
    const tag = await tagOf(`${dates}?from=${date}&to=${date}`, cookie)
    const responses = await Promise.all(
      ['A', 'B'].map((reason) =>
        write(dates, { localDate: date, dayBlock: { isBlocked: true, reason } }, cookie, tag)
      )
    )
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409])
    const rows = await db.from('date_blocks')
    assert.equal(rows.length, 1)
    assert.ok(['A', 'B'].includes(rows[0].reason))
  })
  test('CORS allows the precondition and exposes only its revision header addition', async () => {
    const response = await fetch(`${baseUrl}${weekly}`, {
      method: 'OPTIONS',
      headers: {
        'Origin': env
          .get('CORS_ALLOWED_ORIGINS')
          .split(',')
          .map((origin) => origin.trim())
          .find(Boolean)!,
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'content-type,if-match,x-xsrf-token',
      },
    })
    assert.equal(response.status, 204)
    assert.match(response.headers.get('access-control-allow-headers')!.toLowerCase(), /if-match/)
  })
})
