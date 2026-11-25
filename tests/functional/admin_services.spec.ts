import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import Service from '#models/service'
import Customer from '#models/customer'
import User from '#models/user'
import { resetRateLimiter } from '#services/rate_limiter'
import { baseUrl, getJson, postJson } from '#tests/helpers/api_client'

const serviceFields = [
  'id',
  'name',
  'description',
  'priceCents',
  'durationMinutes',
  'isActive',
  'createdAt',
  'updatedAt',
].sort()
const validData = { name: 'Corte', priceCents: 4500, durationMinutes: 45 }

type ServiceData = {
  id: number
  name: string
  description: string | null
  priceCents: number
  durationMinutes: number
  isActive: boolean
  createdAt: string
  updatedAt: string | null
}

function assertService(data: ServiceData) {
  assert.deepEqual(Object.keys(data).sort(), serviceFields)
  assert.equal(typeof data.id, 'number')
  assert.equal(typeof data.isActive, 'boolean')
  assert.equal(Number.isSafeInteger(data.priceCents), true)
  assert.equal(Number.isInteger(data.durationMinutes), true)
  assert.equal(typeof data.createdAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(data.createdAt)))
  assert.equal(typeof data.updatedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(data.updatedAt!)))
}

async function jsonResponse(response: Response, status: number) {
  assert.equal(response.status, status)
  assert.ok(response.headers.get('content-type')?.includes('application/json'))
  const payload: unknown = await response.json()
  assert.ok(payload !== null && typeof payload === 'object' && !Array.isArray(payload))
  return payload as Record<string, unknown>
}

async function loginAdmin() {
  const user = await User.create({
    fullName: 'Administrador privado',
    email: 'admin-services@example.test',
    password: 'TestPassword123',
    role: 'admin',
  })
  const login = await postJson('/api/admin/login', {
    email: user.email,
    password: 'TestPassword123',
  })
  await jsonResponse(login.response, 200)
  return { user, cookie: login.cookie }
}

async function servicesRequest(operation: 'list' | 'show' | 'create', cookie = '') {
  if (operation === 'create') {
    const { response } = await postJson('/api/admin/services', validData, cookie)
    return response
  }
  return getJson(operation === 'list' ? '/api/admin/services' : '/api/admin/services/1', cookie)
}

test.group('administrative services API', (group) => {
  group.each.setup(async () => {
    // Fail closed if the runner was not configured with the disposable database.
    assert.equal(db.primaryConnectionName, 'sqlite')
    const connection = db.getRawConnection('sqlite')?.config
    assert.equal(connection?.client, 'better-sqlite3')
    assert.equal(
      (connection as { connection: { filename: string } }).connection.filename,
      ':memory:'
    )
    resetRateLimiter()
    await Service.query().delete()
    await Customer.query().delete()
    await User.query().delete()
  })

  for (const operation of ['list', 'show', 'create'] as const) {
    test(`it denies ${operation} to an unauthenticated visitor`, async () => {
      const response = await servicesRequest(operation)
      const payload = await jsonResponse(response, 401)
      assert.equal(payload.message, 'Não autenticado.')
      assert.deepEqual(await Service.all(), [])
    })

    test(`it denies ${operation} when a valid session loses its administrative role`, async () => {
      const { user, cookie } = await loginAdmin()
      user.role = 'user'
      await user.save()
      const response = await servicesRequest(operation, cookie)
      const payload = await jsonResponse(response, 403)
      assert.equal(payload.message, 'Acesso permitido apenas para administradores.')
      assert.deepEqual(await Service.all(), [])
    })
  }

  test('it lists an empty catalogue in the data envelope for an administrator', async () => {
    const { cookie } = await loginAdmin()
    const payload = await jsonResponse(await getJson('/api/admin/services', cookie), 200)
    assert.deepEqual(payload, { data: [] })
  })

  test('it lists active and inactive services in deterministic ID order with only allowed fields', async () => {
    const { cookie } = await loginAdmin()
    await Customer.create({
      name: 'Cliente privado',
      phone: '71999991234',
      phoneNormalized: '71999991234',
    })
    const first = await Service.create({ ...validData, name: 'Z Corte', isActive: false })
    const second = await Service.create({ ...validData, name: 'A Barba', isActive: true })
    for (let request = 0; request < 2; request++) {
      const response = await getJson('/api/admin/services', cookie)
      const payload = (await jsonResponse(response, 200)) as { data: ServiceData[] }
      assert.deepEqual(Object.keys(payload), ['data'])
      assert.deepEqual(
        payload.data.map((service) => service.id),
        [first.id, second.id]
      )
      assert.deepEqual(
        payload.data.map((service) => service.isActive),
        [false, true]
      )
      payload.data.forEach(assertService)
      const body = JSON.stringify(payload)
      assert.equal(body.includes('Cliente privado'), false)
      assert.equal(body.includes('admin-services@example.test'), false)
      assert.equal(body.includes('password'), false)
    }
  })

  test('it creates a service with trimmed fields, default active status and a 201 data envelope', async () => {
    const { cookie } = await loginAdmin()
    const { response } = await postJson(
      '/api/admin/services',
      {
        ...validData,
        name: '  Corte com tesoura  ',
        description: '  Acabamento incluído  ',
      },
      cookie
    )
    const payload = (await jsonResponse(response, 201)) as { data: ServiceData }
    assert.deepEqual(Object.keys(payload), ['data'])
    assertService(payload.data)
    assert.equal(payload.data.name, 'Corte com tesoura')
    assert.equal(payload.data.description, 'Acabamento incluído')
    assert.equal(payload.data.isActive, true)
    assert.equal(payload.data.priceCents, 4500)
    assert.equal(payload.data.durationMinutes, 45)
    const persisted = await Service.findOrFail(payload.data.id)
    assert.equal(persisted.isActive, true)
    assert.equal(persisted.name, 'Corte com tesoura')
    const shown = await jsonResponse(
      await getJson(`/api/admin/services/${payload.data.id}`, cookie),
      200
    )
    assert.deepEqual(shown, payload)
  })

  test('it normalizes omitted, null, empty and whitespace descriptions to null and preserves false status', async () => {
    const { cookie } = await loginAdmin()
    for (const description of [undefined, null, '', '  \n\t  ']) {
      const { response } = await postJson(
        '/api/admin/services',
        {
          ...validData,
          description,
          isActive: false,
        },
        cookie
      )
      const payload = (await jsonResponse(response, 201)) as { data: ServiceData }
      assertService(payload.data)
      assert.equal(payload.data.description, null)
      assert.equal(payload.data.isActive, false)
      const persisted = await Service.findOrFail(payload.data.id)
      assert.equal(persisted.description, null)
      assert.equal(persisted.isActive, false)
    }
  })

  test('it accepts the inclusive numeric and text boundaries', async () => {
    const { cookie } = await loginAdmin()
    for (const data of [
      { name: 'AB', description: 'a'.repeat(1000), priceCents: 0, durationMinutes: 5 },
      { name: 'a'.repeat(120), priceCents: Number.MAX_SAFE_INTEGER, durationMinutes: 480 },
    ]) {
      const { response } = await postJson('/api/admin/services', data, cookie)
      const payload = (await jsonResponse(response, 201)) as { data: ServiceData }
      assertService(payload.data)
      assert.equal(payload.data.priceCents, data.priceCents)
      assert.equal(payload.data.durationMinutes, data.durationMinutes)
    }
  })

  test('it rejects invalid values with JSON 422 responses and does not persist any service', async () => {
    const { cookie } = await loginAdmin()
    const invalidCases: Array<[string, unknown]> = [
      ['name', undefined],
      ['name', null],
      ['name', ''],
      ['name', ' '],
      ['name', ' A '],
      ['name', 'a'.repeat(121)],
      ['name', 123],
      ['description', 'a'.repeat(1001)],
      ['description', 123],
      ['description', {}],
      ['priceCents', undefined],
      ['priceCents', null],
      ['priceCents', -1],
      ['priceCents', 1.5],
      ['priceCents', Number.MAX_SAFE_INTEGER + 1],
      ['priceCents', '4500'],
      ['priceCents', true],
      ['durationMinutes', undefined],
      ['durationMinutes', null],
      ['durationMinutes', 4],
      ['durationMinutes', 481],
      ['durationMinutes', 5.5],
      ['durationMinutes', '30'],
      ['isActive', null],
      ['isActive', 'false'],
      ['isActive', 0],
      ['isActive', 1],
    ]
    for (const [field, value] of invalidCases) {
      const { response } = await postJson(
        '/api/admin/services',
        { ...validData, [field]: value },
        cookie
      )
      assert.equal(response.status, 422, `${field}=${String(value)}`)
      const payload = await jsonResponse(response, 422)
      assert.equal(payload.message, 'Dados do serviço inválidos.', `${field}=${String(value)}`)
      assert.ok(Array.isArray(payload.errors))
      assert.equal('data' in payload, false)
      assert.deepEqual(await Service.all(), [])
    }
  })

  test('it returns JSON errors even when Accept requests HTML', async () => {
    const { cookie } = await loginAdmin()
    const invalid = await postJson(
      '/api/admin/services',
      { ...validData, name: '' },
      cookie,
      'text/html'
    )
    await jsonResponse(invalid.response, 422)
    await jsonResponse(await getJson('/api/admin/services/999999', cookie, 'text/html'), 404)
  })

  test('it shows an inactive service by ID without a csrf header', async () => {
    const { cookie } = await loginAdmin()
    const service = await Service.create({ ...validData, description: null, isActive: false })
    const payload = (await jsonResponse(
      await getJson(`/api/admin/services/${service.id}`, cookie),
      200
    )) as { data: ServiceData }
    assert.deepEqual(Object.keys(payload), ['data'])
    assertService(payload.data)
    assert.equal(payload.data.id, service.id)
    assert.equal(payload.data.isActive, false)
  })

  test('it returns JSON 404 for missing or invalid IDs', async () => {
    const { cookie } = await loginAdmin()
    for (const id of ['999999', 'abc', '0', '-1', '1.5', '9007199254740992', '1%20OR%201%3D1']) {
      const payload = await jsonResponse(await getJson(`/api/admin/services/${id}`, cookie), 404)
      assert.deepEqual(payload, { message: 'Serviço não encontrado.' })
    }
  })

  test('it ignores request IDs and timestamps without changing existing records or leaking extra fields', async () => {
    const { cookie } = await loginAdmin()
    const original = await Service.create({ ...validData, name: 'Original', isActive: false })
    await original.refresh()
    const before = original.serialize()
    const { response } = await postJson(
      '/api/admin/services',
      {
        ...validData,
        id: original.id,
        createdAt: '1900-01-01',
        updatedAt: '1900-01-01',
        created_at: '1900-01-01',
        updated_at: '1900-01-01',
        price_cents: 1,
        duration_minutes: 480,
        is_active: false,
        role: 'admin',
        userId: 1,
        password: 'not-a-real-password',
      },
      cookie
    )
    const payload = (await jsonResponse(response, 201)) as { data: ServiceData }
    assertService(payload.data)
    assert.notEqual(payload.data.id, original.id)
    assert.equal(payload.data.priceCents, validData.priceCents)
    assert.equal(payload.data.durationMinutes, validData.durationMinutes)
    assert.equal(payload.data.isActive, true)
    assert.ok(Date.parse(payload.data.createdAt) > Date.parse('1900-01-01'))
    assert.ok(Date.parse(payload.data.updatedAt!) > Date.parse('1900-01-01'))
    await original.refresh()
    assert.deepEqual(original.serialize(), before)
    const services = await Service.all()
    assert.equal(services.length, 2)
  })

  test('it rejects authenticated writes without valid CSRF and never creates a record', async () => {
    const { cookie } = await loginAdmin()
    for (const token of [undefined, 'invalid-token']) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': cookie,
      }
      if (token) headers['X-XSRF-TOKEN'] = token
      const response = await fetch(`${baseUrl}/api/admin/services`, {
        method: 'POST',
        redirect: 'manual',
        headers,
        body: JSON.stringify(validData),
      })
      const payload = await jsonResponse(response, 403)
      assert.equal(payload.code, 'E_BAD_CSRF_TOKEN')
      assert.deepEqual(await Service.all(), [])
    }
  })
})
