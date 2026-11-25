import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import Service from '#models/service'
import User from '#models/user'
import Customer from '#models/customer'
import { resetRateLimiter } from '#services/rate_limiter'
import { getJson, patchJson, postJson } from '#tests/helpers/api_client'

const initial = { name: 'Corte', priceCents: 4500, durationMinutes: 45, isActive: true }
const fields = [
  'id',
  'name',
  'description',
  'priceCents',
  'durationMinutes',
  'isActive',
  'createdAt',
  'updatedAt',
].sort()

async function json(response: Response, status = 200) {
  assert.equal(response.status, status)
  assert.ok(response.headers.get('content-type')?.includes('application/json'))
  return response.json() as Promise<{ data: Array<Record<string, unknown>> }>
}

async function catalogue(cookie = '') {
  // No CSRF preparation or header: a public GET must work without either.
  const response = await getJson('/api/services', cookie)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await json(response)
  assert.deepEqual(Object.keys(body), ['data'])
  assert.ok(Array.isArray(body.data))
  return body
}

async function login() {
  const user = await User.create({
    fullName: 'Admin privado',
    email: 'public-services@example.test',
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

test.group('public service catalogue', (group) => {
  group.each.setup(async () => {
    const config = db.getRawConnection('sqlite')?.config
    assert.equal(db.primaryConnectionName, 'sqlite')
    assert.equal(config?.client, 'better-sqlite3')
    assert.equal((config as { connection: { filename: string } }).connection.filename, ':memory:')
    resetRateLimiter()
    await Service.query().delete()
    await Customer.query().delete()
    await User.query().delete()
  })

  test('a visitor without cookies or CSRF receives an empty data envelope', async () => {
    assert.deepEqual(await catalogue(), { data: [] })
  })

  test('only inactive services also produce an empty public catalogue', async () => {
    await Service.create({ ...initial, isActive: false })
    assert.deepEqual(await catalogue(), { data: [] })
  })

  test('visitors see only active services ordered by ascending ID', async () => {
    const first = await Service.create({ ...initial, name: 'Z Tesoura' })
    await Service.create({ ...initial, name: 'Serviço oculto', isActive: false })
    const last = await Service.create({ ...initial, name: 'A Barba' })
    for (let repeat = 0; repeat < 2; repeat++) {
      const body = await catalogue()
      assert.deepEqual(
        body.data.map((service) => service.id),
        [first.id, last.id]
      )
      assert.ok(body.data.every((service) => service.isActive === true))
      assert.equal(JSON.stringify(body).includes('Serviço oculto'), false)
    }
  })

  test('an administrator receives exactly the same public catalogue as a visitor', async () => {
    const cookie = await login()
    await Service.create(initial)
    await Service.create({ ...initial, isActive: false })
    assert.deepEqual(await catalogue(cookie), await catalogue())
  })

  test('the existing transformer exposes only the agreed camelCase service fields', async () => {
    const service = await Service.create({ ...initial, description: 'Acabamento' })
    const body = await catalogue()
    const data = body.data[0]
    assert.deepEqual(Object.keys(data).sort(), fields)
    assert.equal(data.id, service.id)
    assert.equal(data.name, initial.name)
    assert.equal(data.description, 'Acabamento')
    assert.equal(data.priceCents, initial.priceCents)
    assert.equal(data.durationMinutes, initial.durationMinutes)
    assert.equal(data.isActive, true)
    for (const key of ['createdAt', 'updatedAt']) {
      assert.equal(typeof data[key], 'string')
      assert.ok(!Number.isNaN(Date.parse(data[key] as string)))
    }
  })

  test('the public response never includes customer, user, session or booking information', async () => {
    await login()
    await Customer.create({
      name: 'Cliente confidencial',
      phone: '71999991234',
      phoneNormalized: '71999991234',
    })
    await Service.create({ ...initial, description: null })
    const body = await catalogue()
    assert.deepEqual(Object.keys(body.data[0]).sort(), fields)
    assert.equal(body.data[0].description, null)
    const encoded = JSON.stringify(body)
    for (const secret of [
      'Cliente confidencial',
      '71999991234',
      'Admin privado',
      'public-services@example.test',
      'password',
      'phoneNormalized',
      'session',
      'availability',
      'appointments',
    ]) {
      assert.equal(encoded.includes(secret), false, secret)
    }
  })

  test('administrative deactivation hides a service and reactivation restores the same record', async () => {
    const cookie = await login()
    const service = await Service.create(initial)
    const before = await catalogue()
    assert.deepEqual(
      before.data.map((item) => item.id),
      [service.id]
    )
    const disabled = await patchJson(
      `/api/admin/services/${service.id}`,
      { isActive: false },
      cookie
    )
    await json(disabled.response)
    assert.deepEqual(await catalogue(), { data: [] })
    const enabled = await patchJson(`/api/admin/services/${service.id}`, { isActive: true }, cookie)
    await json(enabled.response)
    const restored = await catalogue()
    assert.deepEqual(
      restored.data.map((item) => item.id),
      [service.id]
    )
    const services = await Service.all()
    assert.equal(services.length, 1)
  })

  test('administrative creation, listing and detail retain their contracts and protection', async () => {
    await json(await getJson('/api/admin/services'), 401)
    const cookie = await login()
    const created = await postJson('/api/admin/services', { ...initial, isActive: false }, cookie)
    assert.equal(created.response.status, 201)
    const createdBody = (await created.response.json()) as { data: { id: number } }
    const listed = await json(await getJson('/api/admin/services', cookie))
    assert.equal(listed.data.length, 1)
    assert.equal(listed.data[0].isActive, false)
    const shown = await json(await getJson(`/api/admin/services/${createdBody.data.id}`, cookie))
    assert.deepEqual(shown, createdBody)
    assert.deepEqual(await catalogue(cookie), { data: [] })
  })
})
