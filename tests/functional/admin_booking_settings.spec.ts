import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import BookingSetting from '#models/booking_setting'
import WeeklyOpeningHour from '#models/weekly_opening_hour'
import WeeklyBreak from '#models/weekly_break'
import WeeklySlotBlock from '#models/weekly_slot_block'
import User from '#models/user'
import Customer from '#models/customer'
import { resetRateLimiter } from '#services/rate_limiter'
import { baseUrl, getJson, patchJson, postJson } from '#tests/helpers/api_client'

const path = '/api/admin/booking-settings'
const monday = { weekday: 1, isActive: true, opensAtMinute: 540, closesAtMinute: 1080 }
const pause = { startsAtMinute: 720, endsAtMinute: 780, isActive: true }
const block = { startsAtMinute: 600, isBlocked: true }
type Day = typeof monday & {
  isConfigured: boolean
  breaks: (typeof pause)[]
  slotBlocks: (typeof block)[]
}
type Payload = {
  data: { timezone: string; slotDurationMinutes: number; days: Day[] }
  message?: string
}

async function responseJson(response: Response, status = 200) {
  assert.equal(response.status, status)
  assert.ok(response.headers.get('content-type')?.includes('application/json'))
  const payload = (await response.json()) as Payload
  if (status === 200 || status === 422 || status === 409)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  return payload
}
async function read(cookie = '') {
  return responseJson(await getJson(path, cookie))
}
async function patch(days: unknown, cookie: string, status = 200) {
  const result = await patchJson(path, { days }, cookie)
  return responseJson(result.response, status)
}
async function login() {
  const user = await User.create({
    fullName: 'Administrador',
    email: 'booking-admin@example.test',
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
  const result = []
  for (const table of [
    'booking_settings',
    'weekly_opening_hours',
    'weekly_breaks',
    'weekly_slot_blocks',
  ]) {
    result.push(await db.from(table).orderBy('id', 'asc'))
  }
  return result
}
async function configured(cookie: string) {
  return patch([{ ...monday, breaks: [pause], slotBlocks: [block] }], cookie)
}

test.group('administrative weekly booking settings API', (group) => {
  group.each.setup(async () => {
    const config = db.getRawConnection('sqlite')?.config
    assert.equal(config?.client, 'better-sqlite3')
    assert.equal((config as { connection: { filename: string } }).connection.filename, ':memory:')
    for (const model of [
      WeeklySlotBlock,
      WeeklyBreak,
      WeeklyOpeningHour,
      BookingSetting,
      Customer,
      User,
    ])
      await model.query().delete()
    resetRateLimiter()
  })

  for (const method of ['GET', 'PATCH']) {
    test(`${method} rejects a visitor`, async () => {
      const { response } =
        method === 'GET'
          ? { response: await getJson(path) }
          : await patchJson(path, { days: [monday] })
      await responseJson(response, 401)
      assert.deepEqual(await snapshot(), [[], [], [], []])
    })
    test(`${method} rejects a session after administrative permission is revoked`, async () => {
      const { user, cookie } = await login()
      user.role = 'user'
      await user.save()
      const { response } =
        method === 'GET'
          ? { response: await getJson(path, cookie) }
          : await patchJson(path, { days: [monday] }, cookie)
      await responseJson(response, 403)
      assert.deepEqual(await snapshot(), [[], [], [], []])
    })
  }

  test('empty GET returns seven closed unconfigured ISO days and never writes', async () => {
    const { cookie } = await login()
    for (let repeat = 0; repeat < 2; repeat++) {
      const body = await read(cookie)
      assert.deepEqual(Object.keys(body), ['data'])
      assert.equal(body.data.timezone, 'America/Sao_Paulo')
      assert.equal(body.data.slotDurationMinutes, 60)
      assert.deepEqual(
        body.data.days,
        Array.from({ length: 7 }, (_, index) => ({
          weekday: index + 1,
          isConfigured: false,
          isActive: false,
          opensAtMinute: null,
          closesAtMinute: null,
          breaks: [],
          slotBlocks: [],
        }))
      )
      assert.deepEqual(await snapshot(), [[], [], [], []])
    }
  })

  test('an administrator configures a day, pauses and blocks using the fixed settings', async () => {
    const { cookie } = await login()
    const body = await configured(cookie)
    assert.deepEqual(body.data.days[0], {
      ...monday,
      isConfigured: true,
      breaks: [pause],
      slotBlocks: [block],
    })
    assert.equal(body.data.days.length, 7)
    assert.deepEqual(await read(cookie), body)
    const settings = await BookingSetting.findOrFail(1)
    assert.equal(settings.slotDurationMinutes, 60)
  })

  test('deactivating and reactivating preserves hours, intervals, IDs and creation timestamps', async () => {
    const { cookie } = await login()
    await configured(cookie)
    const before = await snapshot()
    await patch([{ weekday: 1, isActive: false }], cookie)
    const closed = await read(cookie)
    assert.equal(closed.data.days[0].isActive, false)
    assert.equal(closed.data.days[0].opensAtMinute, 540)
    assert.deepEqual(closed.data.days[0].breaks, [pause])
    assert.deepEqual(closed.data.days[0].slotBlocks, [block])
    await patch([{ weekday: 1, isActive: true }], cookie)
    const after = await snapshot()
    for (const [table, beforeRows] of before.entries()) {
      assert.deepEqual(
        after[table].map((row) => [row.id, row.created_at]),
        beforeRows.map((row) => [row.id, row.created_at])
      )
    }
  })

  test('omitted days and child arrays remain unchanged when opening hours change', async () => {
    const { cookie } = await login()
    await configured(cookie)
    await patch([{ ...monday, weekday: 2 }], cookie)
    const tuesday = await WeeklyOpeningHour.findByOrFail('weekday', 2)
    const before = tuesday.serialize()
    const body = await patch([{ weekday: 1, opensAtMinute: 480, closesAtMinute: 1140 }], cookie)
    assert.equal(body.data.days[0].opensAtMinute, 480)
    assert.equal(body.data.days[0].closesAtMinute, 1140)
    assert.deepEqual(body.data.days[0].breaks, [pause])
    assert.deepEqual(body.data.days[0].slotBlocks, [block])
    await tuesday.refresh()
    assert.deepEqual(tuesday.serialize(), before)
  })

  test('break lists edit by starting minute and deactivate removed items without deleting them', async () => {
    const { cookie } = await login()
    await configured(cookie)
    const original = await WeeklyBreak.firstOrFail()
    const createdAt = original.createdAt.toISO()
    await patch(
      [
        {
          weekday: 1,
          breaks: [
            { ...pause, endsAtMinute: 840 },
            { startsAtMinute: 900, endsAtMinute: 960, isActive: true },
          ],
        },
      ],
      cookie
    )
    await original.refresh()
    assert.equal(original.endsAtMinute, 840)
    assert.equal(original.createdAt.toISO(), createdAt)
    const body = await patch([{ weekday: 1, breaks: [] }], cookie)
    assert.equal(body.data.days[0].breaks.length, 2)
    assert.ok(body.data.days[0].breaks.every((item) => item.isActive === false))
    const rows = await WeeklyBreak.all()
    assert.equal(rows.length, 2)
    await patch([{ weekday: 1, breaks: [pause] }], cookie)
    await original.refresh()
    assert.equal(original.isActive, true)
  })

  test('released and omitted blocks are retained and do not override a closed day or a pause', async () => {
    const { cookie } = await login()
    await configured(cookie)
    const original = await WeeklySlotBlock.firstOrFail()
    const body = await patch(
      [
        {
          weekday: 1,
          isActive: false,
          slotBlocks: [
            { ...block, isBlocked: false },
            { startsAtMinute: 720, isBlocked: false },
          ],
        },
      ],
      cookie
    )
    assert.equal(body.data.days[0].isActive, false)
    assert.deepEqual(body.data.days[0].breaks, [pause])
    assert.ok(body.data.days[0].slotBlocks.every((item) => item.isBlocked === false))
    await patch([{ weekday: 1, slotBlocks: [block] }], cookie)
    await original.refresh()
    assert.equal(original.isBlocked, true)
    await patch([{ weekday: 1, slotBlocks: [] }], cookie)
    await original.refresh()
    assert.equal(original.isBlocked, false)
    const rows = await WeeklySlotBlock.all()
    assert.equal(rows.length, 2)
  })

  test('shrinking hours rejects preserved active children but permits their explicit deactivation', async () => {
    const { cookie } = await login()
    await configured(cookie)
    const before = await snapshot()
    await patch([{ weekday: 1, opensAtMinute: 840 }], cookie, 422)
    assert.deepEqual(await snapshot(), before)
    const body = await patch(
      [{ weekday: 1, opensAtMinute: 840, breaks: [], slotBlocks: [] }],
      cookie
    )
    assert.equal(body.data.days[0].opensAtMinute, 840)
    assert.equal(body.data.days[0].breaks[0].isActive, false)
    assert.equal(body.data.days[0].slotBlocks[0].isBlocked, false)
  })

  test('an unconfigured day can be saved closed but cannot be activated without both hours', async () => {
    const { cookie } = await login()
    const closed = await patch([{ weekday: 7, isActive: false }], cookie)
    assert.equal(closed.data.days[6].isConfigured, false)
    await patch([{ weekday: 7, isActive: true }], cookie, 422)
    await patch([{ weekday: 7, opensAtMinute: 540 }], cookie, 422)
    await patch([{ weekday: 7, isActive: true, opensAtMinute: 0, closesAtMinute: 1440 }], cookie)
  })

  test('invalid types, hours, duplicates and child configurations return JSON 422 atomically', async () => {
    const { cookie } = await login()
    await configured(cookie)
    const before = await snapshot()
    const badDays: unknown[][] = [
      [],
      [null],
      [{ weekday: 0, isActive: false }],
      [{ weekday: 8, isActive: false }],
      [{ weekday: '1', isActive: false }],
      [{ weekday: 1 }],
      [{ weekday: 1, isActive: null }],
      [{ weekday: 1, isActive: 'false' }],
      [{ weekday: 1, isActive: 0 }],
      [{ weekday: 1, opensAtMinute: '540' }],
      [{ weekday: 1, opensAtMinute: -60 }],
      [{ weekday: 1, closesAtMinute: 1500 }],
      [{ weekday: 1, opensAtMinute: 541 }],
      [{ weekday: 1, closesAtMinute: 1081 }],
      [{ weekday: 1, opensAtMinute: 540.5 }],
      [{ weekday: 1, opensAtMinute: 1080 }],
      [{ weekday: 1, closesAtMinute: 540 }],
      [{ weekday: 1, opensAtMinute: null }],
      [{ weekday: 1, opensAtMinute: null, closesAtMinute: null }],
      [{ weekday: 1, breaks: null }],
      [{ weekday: 1, slotBlocks: null }],
      [{ weekday: 1, breaks: [{ ...pause, endsAtMinute: 721 }] }],
      [
        {
          weekday: 1,
          breaks: [pause, { startsAtMinute: 720, endsAtMinute: 840, isActive: false }],
        },
      ],
      [{ weekday: 1, breaks: [pause, { startsAtMinute: 720, endsAtMinute: 840, isActive: true }] }],
      [
        {
          weekday: 1,
          breaks: [
            { ...pause, endsAtMinute: 900 },
            { startsAtMinute: 840, endsAtMinute: 960, isActive: true },
          ],
        },
      ],
      [{ weekday: 1, breaks: [{ ...pause, startsAtMinute: 480 }] }],
      [{ weekday: 1, breaks: [{ ...pause, endsAtMinute: 1140 }] }],
      [{ weekday: 1, breaks: [{ ...pause, isActive: null }] }],
      [{ weekday: 1, breaks: [{ ...pause, isActive: 'true' }] }],
      [{ weekday: 1, slotBlocks: [block, block] }],
      [{ weekday: 1, slotBlocks: [{ ...block, startsAtMinute: 1080 }] }],
      [{ weekday: 1, slotBlocks: [{ ...block, startsAtMinute: 1440 }] }],
      [{ weekday: 1, slotBlocks: [{ ...block, startsAtMinute: 601 }] }],
      [{ weekday: 1, slotBlocks: [{ ...block, isBlocked: null }] }],
      [{ weekday: 1, slotBlocks: [{ ...block, isBlocked: 1 }] }],
      [
        { weekday: 1, isActive: false },
        { weekday: 1, isActive: true },
      ],
    ]
    for (const days of badDays) {
      const body = await patch(days, cookie, 422)
      assert.equal(body.message, 'Configuração semanal inválida.')
      assert.deepEqual(await snapshot(), before, JSON.stringify(days))
    }
  })

  test('adjacent active breaks and overlapping inactive breaks are permitted', async () => {
    const { cookie } = await login()
    await patch(
      [
        {
          ...monday,
          breaks: [
            pause,
            { startsAtMinute: 780, endsAtMinute: 840, isActive: true },
            { startsAtMinute: 660, endsAtMinute: 840, isActive: false },
          ],
        },
      ],
      cookie
    )
  })

  test('unknown fields and internal IDs or timestamps are rejected at every level', async () => {
    const { cookie } = await login()
    const before = await snapshot()
    for (const extra of [
      { timezone: 'UTC' },
      { slotDurationMinutes: 30 },
      { id: 99 },
      { createdAt: '1900-01-01' },
      { arbitrary: true },
    ]) {
      const result = await patchJson(path, { days: [monday], ...extra }, cookie)
      await responseJson(result.response, 422)
    }
    for (const day of [
      { ...monday, id: 99 },
      { ...monday, updatedAt: '1900-01-01' },
      { ...monday, breaks: [{ ...pause, id: 1 }] },
      { ...monday, slotBlocks: [{ ...block, weeklyOpeningHourId: 1 }] },
    ])
      await patch([day], cookie, 422)
    assert.deepEqual(await snapshot(), before)
  })

  test('empty and unknown-only payloads fail with JSON even when Accept requests HTML', async () => {
    const { cookie } = await login()
    for (const data of [{}, { unknown: true }, { days: null }, { days: [] }]) {
      const result = await patchJson(path, data, cookie, 'text/html')
      await responseJson(result.response, 422)
    }
    const response = await getJson(path, cookie, 'text/html')
    await responseJson(response)
  })

  test('a later invalid day rolls back earlier changes and initial global settings creation', async () => {
    const { cookie } = await login()
    await patch(
      [monday, { ...monday, weekday: 2, breaks: [{ ...pause, startsAtMinute: 480 }] }],
      cookie,
      422
    )
    assert.deepEqual(await snapshot(), [[], [], [], []])
  })

  test('CSRF missing or invalid blocks authenticated PATCH without writes', async () => {
    const { cookie } = await login()
    for (const token of [undefined, 'invalid-token']) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': cookie,
      }
      if (token) headers['X-XSRF-TOKEN'] = token
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ days: [monday] }),
      })
      const body = await responseJson(response, 403)
      assert.equal((body as unknown as { code: string }).code, 'E_BAD_CSRF_TOKEN')
      assert.deepEqual(await snapshot(), [[], [], [], []])
    }
  })

  test('integrity errors are controlled JSON 409 responses and roll back the entire write', async () => {
    const { cookie } = await login()
    await db.rawQuery(
      "CREATE TRIGGER test_settings_conflict BEFORE INSERT ON weekly_breaks BEGIN SELECT RAISE(ABORT, 'private database detail'); END"
    )
    try {
      const body = await patch([{ ...monday, breaks: [pause] }], cookie, 409)
      assert.equal(JSON.stringify(body).includes('private database detail'), false)
      assert.equal(JSON.stringify(body).includes('SQLITE'), false)
      assert.deepEqual(await snapshot(), [[], [], [], []])
    } finally {
      await db.rawQuery('DROP TRIGGER test_settings_conflict')
    }
  })

  test('responses whitelist the contract and idempotent patches preserve all timestamps', async () => {
    const { cookie } = await login()
    await configured(cookie)
    // Historical values make unintended timestamp writes observable without sleeps.
    for (const table of [
      'booking_settings',
      'weekly_opening_hours',
      'weekly_breaks',
      'weekly_slot_blocks',
    ]) {
      await db
        .from(table)
        .update({ created_at: '2000-01-01 00:00:00', updated_at: '2000-01-02 00:00:00' })
    }
    const before = await snapshot()
    const body = await configured(cookie)
    assert.deepEqual(await snapshot(), before)
    assert.deepEqual(Object.keys(body.data).sort(), ['days', 'slotDurationMinutes', 'timezone'])
    for (const day of body.data.days) {
      assert.deepEqual(
        Object.keys(day).sort(),
        [
          'weekday',
          'isConfigured',
          'isActive',
          'opensAtMinute',
          'closesAtMinute',
          'breaks',
          'slotBlocks',
        ].sort()
      )
      for (const item of day.breaks)
        assert.deepEqual(
          Object.keys(item).sort(),
          ['startsAtMinute', 'endsAtMinute', 'isActive'].sort()
        )
      for (const item of day.slotBlocks)
        assert.deepEqual(Object.keys(item).sort(), ['startsAtMinute', 'isBlocked'].sort())
    }
    const encoded = JSON.stringify(body)
    for (const secret of [
      'booking-admin@example.test',
      'password',
      'phone',
      'session',
      'createdAt',
      'updatedAt',
      'weeklyOpeningHourId',
    ])
      assert.equal(encoded.includes(secret), false)
  })

  test('null clears both hours only when the day is closed and its effective children are disabled', async () => {
    const { cookie } = await login()
    await configured(cookie)
    const body = await patch(
      [
        {
          weekday: 1,
          isActive: false,
          opensAtMinute: null,
          closesAtMinute: null,
          breaks: [],
          slotBlocks: [],
        },
      ],
      cookie
    )
    assert.equal(body.data.days[0].isConfigured, false)
    assert.equal(body.data.days[0].isActive, false)
    assert.equal(body.data.days[0].opensAtMinute, null)
    assert.equal(body.data.days[0].closesAtMinute, null)
    assert.equal(body.data.days[0].breaks[0].isActive, false)
    assert.equal(body.data.days[0].slotBlocks[0].isBlocked, false)
    await patch([{ weekday: 1, isActive: true }], cookie, 422)
  })

  test('concurrent patches never persist a mixed invalid configuration', async () => {
    const { cookie } = await login()
    await configured(cookie)
    const results = await Promise.all([
      patchJson(
        path,
        { days: [{ weekday: 1, opensAtMinute: 840, breaks: [], slotBlocks: [] }] },
        cookie
      ),
      patchJson(path, { days: [{ weekday: 1, breaks: [pause] }] }, cookie),
    ])
    for (const result of results) assert.ok([200, 422, 409].includes(result.response.status))
    const body = await read(cookie)
    const day = body.data.days[0]
    for (const item of day.breaks.filter((entry) => entry.isActive))
      assert.ok(item.startsAtMinute >= day.opensAtMinute && item.endsAtMinute <= day.closesAtMinute)
  })
})
