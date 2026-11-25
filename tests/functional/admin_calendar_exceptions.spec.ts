import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import DateBlock from '#models/date_block'
import DateSlotBlock from '#models/date_slot_block'
import User from '#models/user'
import Customer from '#models/customer'
import WeeklyOpeningHour from '#models/weekly_opening_hour'
import { resetRateLimiter } from '#services/rate_limiter'
import { baseUrl, getJson, postJson } from '#tests/helpers/api_client'

const path = '/api/admin/calendar-exceptions'
const date = '2026-12-25'
const query = `${path}?from=2026-12-01&to=2026-12-31`
type RecordData = {
  id: number
  localDate: string
  isBlocked: boolean
  reason: string | null
  createdAt: string
  updatedAt: string
  startsAtMinute?: number
}
type Body = {
  data: { dateBlocks: RecordData[]; slotBlocks: RecordData[] }
  message?: string
  code?: string
}
async function json(response: Response, status = 200) {
  assert.equal(response.status, status)
  assert.ok(response.headers.get('content-type')?.includes('application/json'))
  if ([200, 422, 409].includes(status))
    assert.equal(response.headers.get('cache-control'), 'no-store')
  return response.json() as Promise<Body>
}
async function save(input: unknown, cookie: string, status = 200) {
  const result = await postJson(path, input, cookie)
  assert.equal(result.response.status, status, JSON.stringify(input))
  return json(result.response, status)
}
async function login() {
  const user = await User.create({
    fullName: 'Admin privado',
    email: 'calendar-admin@example.test',
    password: 'TestPassword123',
    role: 'admin',
  })
  const result = await postJson('/api/admin/login', {
    email: user.email,
    password: 'TestPassword123',
  })
  assert.equal(result.response.status, 200)
  return { user, cookie: result.cookie }
}
async function snapshot() {
  return {
    days: await db.from('date_blocks').orderBy('id'),
    slots: await db.from('date_slot_blocks').orderBy('id'),
  }
}

test.group('administrative calendar exceptions API', (group) => {
  group.each.setup(async () => {
    const config = db.getRawConnection('sqlite')?.config
    assert.equal(config?.client, 'better-sqlite3')
    assert.equal((config as { connection: { filename: string } }).connection.filename, ':memory:')
    await DateSlotBlock.query().delete()
    await DateBlock.query().delete()
    await Customer.query().delete()
    await User.query().delete()
    resetRateLimiter()
  })

  for (const method of ['GET', 'POST']) {
    test(`${method} requires a session`, async () => {
      const result =
        method === 'GET'
          ? { response: await getJson(query) }
          : await postJson(path, { localDate: date, dayBlock: { isBlocked: true } })
      await json(result.response, 401)
      assert.deepEqual(await snapshot(), { days: [], slots: [] })
    })
    test(`${method} rejects a session whose administrator role was revoked`, async () => {
      const { user, cookie } = await login()
      user.role = 'user'
      await user.save()
      const result =
        method === 'GET'
          ? { response: await getJson(query, cookie) }
          : await postJson(path, { localDate: date, dayBlock: { isBlocked: true } }, cookie)
      await json(result.response, 403)
      assert.deepEqual(await snapshot(), { days: [], slots: [] })
    })
  }

  test('GET returns an empty envelope without creating any configuration', async () => {
    const { cookie } = await login()
    const before = await db.from('booking_settings').select('*')
    assert.deepEqual(await json(await getJson(query, cookie)), {
      data: { dateBlocks: [], slotBlocks: [] },
    })
    assert.deepEqual(await snapshot(), { days: [], slots: [] })
    assert.deepEqual(await db.from('booking_settings').select('*'), before)
  })

  test('an administrator blocks, releases and reactivates the same full-date record', async () => {
    const { cookie } = await login()
    const first = await save(
      { localDate: date, dayBlock: { isBlocked: true, reason: '  Feriado  ' } },
      cookie
    )
    const original = first.data.dateBlocks[0]
    assert.equal(original.reason, 'Feriado')
    assert.equal(original.localDate, date)
    const released = await save({ localDate: date, dayBlock: { isBlocked: false } }, cookie)
    assert.equal(released.data.dateBlocks[0].id, original.id)
    assert.equal(released.data.dateBlocks[0].createdAt, original.createdAt)
    assert.equal(released.data.dateBlocks[0].isBlocked, false)
    assert.equal(released.data.dateBlocks[0].reason, 'Feriado')
    const reactivated = await save({ localDate: date, dayBlock: { isBlocked: true } }, cookie)
    assert.equal(reactivated.data.dateBlocks[0].id, original.id)
    assert.equal(reactivated.data.dateBlocks.length, 1)
  })

  test('several hours are independently blocked and released without changing omitted slots', async () => {
    const { cookie } = await login()
    const first = await save(
      {
        localDate: date,
        slotBlocks: [600, 840, 960].map((startsAtMinute) => ({ startsAtMinute, isBlocked: true })),
      },
      cookie
    )
    assert.deepEqual(
      first.data.slotBlocks.map((slot) => slot.startsAtMinute),
      [600, 840, 960]
    )
    const released = await save(
      {
        localDate: date,
        slotBlocks: [{ startsAtMinute: 840, isBlocked: false, reason: 'Liberado' }],
      },
      cookie
    )
    assert.deepEqual(
      released.data.slotBlocks.map((slot) => slot.isBlocked),
      [true, false, true]
    )
    assert.deepEqual(
      released.data.slotBlocks.map((slot) => [slot.id, slot.createdAt]),
      first.data.slotBlocks.map((slot) => [slot.id, slot.createdAt])
    )
    const other = await save(
      { localDate: '2026-12-26', slotBlocks: [{ startsAtMinute: 600, isBlocked: true }] },
      cookie
    )
    assert.equal(other.data.slotBlocks[0].localDate, '2026-12-26')
  })

  test('a released slot cannot undo a full-day block and releasing a day preserves slot blocks', async () => {
    const { cookie } = await login()
    await save(
      {
        localDate: date,
        dayBlock: { isBlocked: true },
        slotBlocks: [{ startsAtMinute: 600, isBlocked: true }],
      },
      cookie
    )
    const dayClosed = await save(
      { localDate: date, slotBlocks: [{ startsAtMinute: 600, isBlocked: false }] },
      cookie
    )
    assert.equal(dayClosed.data.dateBlocks[0].isBlocked, true)
    assert.equal(dayClosed.data.slotBlocks[0].isBlocked, false)
    await save({ localDate: date, slotBlocks: [{ startsAtMinute: 600, isBlocked: true }] }, cookie)
    const dayReleased = await save({ localDate: date, dayBlock: { isBlocked: false } }, cookie)
    assert.equal(dayReleased.data.slotBlocks[0].isBlocked, true)
  })

  test('exceptions can be stored on closed or unconfigured days without changing weekly rules', async () => {
    const { cookie } = await login()
    const before = await WeeklyOpeningHour.all()
    const response = await save(
      {
        localDate: date,
        dayBlock: { isBlocked: false },
        slotBlocks: [
          { startsAtMinute: 1380, isBlocked: true },
          { startsAtMinute: 0, isBlocked: true },
        ],
      },
      cookie
    )
    assert.equal(response.data.slotBlocks.length, 2)
    const after = await WeeklyOpeningHour.all()
    assert.deepEqual(
      after.map((day) => day.serialize()),
      before.map((day) => day.serialize())
    )
  })

  test('idempotent repeated writes preserve IDs, timestamps and record counts', async () => {
    const { cookie } = await login()
    const input = {
      localDate: date,
      dayBlock: { isBlocked: true },
      slotBlocks: [{ startsAtMinute: 600, isBlocked: true, reason: 'Pausa' }],
    }
    await save(input, cookie)
    for (const table of ['date_blocks', 'date_slot_blocks'])
      await db
        .from(table)
        .update({ created_at: '2000-01-01 00:00:00', updated_at: '2000-01-02 00:00:00' })
    const before = await snapshot()
    for (let repeat = 0; repeat < 2; repeat++) await save(input, cookie)
    assert.deepEqual(await snapshot(), before)
  })

  test('reason omission preserves it, while null and trimmed empty strings remove it', async () => {
    const { cookie } = await login()
    for (const reason of ['a'.repeat(500), null, '  ', '  Folga  ']) {
      const result = await save(
        {
          localDate: date,
          dayBlock: { isBlocked: true, reason },
          slotBlocks: [{ startsAtMinute: 600, isBlocked: true, reason }],
        },
        cookie
      )
      const expected = reason?.trim() || null
      assert.equal(result.data.dateBlocks[0].reason, expected)
      assert.equal(result.data.slotBlocks[0].reason, expected)
    }
  })

  test('actual leap dates and local dates near historic timezone transitions are unchanged', async () => {
    const { cookie } = await login()
    for (const localDate of [
      '2000-02-29',
      '2028-02-29',
      '2018-11-04',
      '0001-01-01',
      '9999-12-31',
    ]) {
      const result = await save({ localDate, dayBlock: { isBlocked: true } }, cookie)
      assert.equal(result.data.dateBlocks[0].localDate, localDate)
    }
  })

  test('invalid dates, types, hours and duplicate slots reject the entire request', async () => {
    const { cookie } = await login()
    const cases: unknown[] = [
      {},
      { localDate: date },
      { localDate: date, slotBlocks: [] },
      ...[
        '2026-02-29',
        '1900-02-29',
        '2028-02-30',
        '2026-04-31',
        '0000-01-01',
        '2026-13-01',
        '2026-1-01',
        '2026-12-25T00:00:00Z',
        `${date}extra`,
      ].map((localDate) => ({ localDate, dayBlock: { isBlocked: true } })),
      { localDate: 20261225, dayBlock: { isBlocked: true } },
      { localDate: date, dayBlock: null },
      { localDate: date, slotBlocks: null },
      ...[null, 'true', 1].map((isBlocked) => ({ localDate: date, dayBlock: { isBlocked } })),
      ...[-60, 1440, 601, 600.5, '600', null].map((startsAtMinute) => ({
        localDate: date,
        dayBlock: { isBlocked: true },
        slotBlocks: [{ startsAtMinute, isBlocked: true }],
      })),
      {
        localDate: date,
        slotBlocks: [
          { startsAtMinute: 600, isBlocked: true },
          { startsAtMinute: 600, isBlocked: false },
        ],
      },
      { localDate: date, dayBlock: { isBlocked: true, reason: 'a'.repeat(501) } },
      { localDate: date, dayBlock: { isBlocked: true, reason: 1 } },
      { localDate: date, slotBlocks: [{ startsAtMinute: 600, isBlocked: null }] },
    ]
    for (const input of cases) {
      await save(input, cookie, 422)
      assert.deepEqual(await snapshot(), { days: [], slots: [] }, JSON.stringify(input))
    }
  })

  test('internal fields and unknown properties are rejected without mass assignment', async () => {
    const { cookie } = await login()
    for (const extra of [
      { id: 1 },
      { createdAt: '1900-01-01' },
      { timezone: 'UTC' },
      { customerId: 1 },
    ])
      await save({ localDate: date, dayBlock: { isBlocked: true }, ...extra }, cookie, 422)
    await save({ localDate: date, dayBlock: { isBlocked: true, id: 1 } }, cookie, 422)
    await save(
      {
        localDate: date,
        slotBlocks: [{ startsAtMinute: 600, isBlocked: true, updatedAt: '1900-01-01' }],
      },
      cookie,
      422
    )
    assert.deepEqual(await snapshot(), { days: [], slots: [] })
  })

  test('range reads are inclusive, deterministic and include released records only within the period', async () => {
    const { cookie } = await login()
    for (const localDate of ['2026-12-31', '2026-12-01', '2027-01-01'])
      await save(
        {
          localDate,
          dayBlock: { isBlocked: false },
          slotBlocks: [
            { startsAtMinute: 960, isBlocked: true },
            { startsAtMinute: 600, isBlocked: false },
          ],
        },
        cookie
      )
    const before = await snapshot()
    const result = await json(await getJson(query, cookie))
    assert.deepEqual(
      result.data.dateBlocks.map((row) => row.localDate),
      ['2026-12-01', '2026-12-31']
    )
    assert.deepEqual(
      result.data.slotBlocks.map((row) => [row.localDate, row.startsAtMinute]),
      [
        ['2026-12-01', 600],
        ['2026-12-01', 960],
        ['2026-12-31', 600],
        ['2026-12-31', 960],
      ]
    )
    assert.deepEqual(await snapshot(), before)
  })

  test('range validation enforces 93 inclusive calendar days and real dates', async () => {
    const { cookie } = await login()
    await json(await getJson(`${path}?from=2028-01-01&to=2028-04-02`, cookie))
    await json(await getJson(`${path}?from=2028-02-29&to=2028-02-29`, cookie))
    for (const suffix of [
      '',
      '?from=2026-12-01',
      '?from=2028-01-01&to=2028-04-03',
      '?from=2026-12-31&to=2026-12-01',
      '?from=2026-02-29&to=2026-03-01',
      '?from=2026-12-01&to=2026-12-01&unknown=1',
    ])
      await json(await getJson(path + suffix, cookie), 422)
  })

  test('responses whitelist administrative exception fields without customer or session data', async () => {
    const { cookie } = await login()
    await Customer.create({
      name: 'Cliente privado',
      phone: '71999991234',
      phoneNormalized: '71999991234',
    })
    const body = await save(
      {
        localDate: date,
        dayBlock: { isBlocked: true, reason: 'Motivo administrativo privado' },
        slotBlocks: [{ startsAtMinute: 600, isBlocked: true }],
      },
      cookie
    )
    assert.deepEqual(Object.keys(body), ['data'])
    assert.deepEqual(Object.keys(body.data).sort(), ['dateBlocks', 'slotBlocks'])
    assert.deepEqual(
      Object.keys(body.data.dateBlocks[0]).sort(),
      ['id', 'localDate', 'isBlocked', 'reason', 'createdAt', 'updatedAt'].sort()
    )
    assert.deepEqual(
      Object.keys(body.data.slotBlocks[0]).sort(),
      ['id', 'localDate', 'isBlocked', 'reason', 'createdAt', 'updatedAt', 'startsAtMinute'].sort()
    )
    for (const privateValue of [
      'Cliente privado',
      '71999991234',
      'calendar-admin@example.test',
      'password',
      'phoneNormalized',
      'session',
    ])
      assert.equal(JSON.stringify(body).includes(privateValue), false)
    const publicServices = await jsonPublic(await getJson('/api/services'))
    assert.equal(JSON.stringify(publicServices).includes('Motivo administrativo privado'), false)
    await json(await getJson(query, '', 'text/html'), 401)
  })

  test('POST needs valid CSRF and JSON errors remain JSON with Accept HTML', async () => {
    const { cookie } = await login()
    for (const token of [undefined, 'invalid-token']) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': cookie,
      }
      if (token) headers['X-XSRF-TOKEN'] = token
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ localDate: date, dayBlock: { isBlocked: true } }),
      })
      const body = await json(response, 403)
      assert.equal(body.code, 'E_BAD_CSRF_TOKEN')
    }
    const invalid = await postJson(path, {}, cookie, 'text/html')
    await json(invalid.response, 422)
    await json(await getJson(path, cookie, 'text/html'), 422)
    assert.deepEqual(await snapshot(), { days: [], slots: [] })
  })

  test('a later integrity conflict rolls back the day and earlier slots with controlled JSON 409', async () => {
    const { cookie } = await login()
    await db.rawQuery(
      "CREATE TRIGGER test_calendar_conflict BEFORE INSERT ON date_slot_blocks WHEN NEW.starts_at_minute = 960 BEGIN SELECT RAISE(ABORT, 'private SQL detail'); END"
    )
    try {
      const result = await save(
        {
          localDate: date,
          dayBlock: { isBlocked: true },
          slotBlocks: [
            { startsAtMinute: 600, isBlocked: true },
            { startsAtMinute: 960, isBlocked: true },
          ],
        },
        cookie,
        409
      )
      assert.equal(JSON.stringify(result).includes('private SQL detail'), false)
      assert.deepEqual(await snapshot(), { days: [], slots: [] })
    } finally {
      await db.rawQuery('DROP TRIGGER test_calendar_conflict')
    }
  })

  test('concurrent requests preserve uniqueness and independent slots on the same date', async () => {
    const { cookie } = await login()
    const results = await Promise.all(
      [600, 600, 960].map((startsAtMinute) =>
        postJson(
          path,
          {
            localDate: date,
            dayBlock: { isBlocked: true },
            slotBlocks: [{ startsAtMinute, isBlocked: true }],
          },
          cookie
        )
      )
    )
    for (const result of results) await json(result.response)
    const records = await snapshot()
    assert.equal(records.days.length, 1)
    assert.deepEqual(records.slots.map((row) => row.starts_at_minute).sort(), [600, 960])
  })
})

async function jsonPublic(response: Response) {
  assert.equal(response.status, 200)
  return response.json()
}
