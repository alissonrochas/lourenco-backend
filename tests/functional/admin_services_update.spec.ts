import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import Service from '#models/service'
import Customer from '#models/customer'
import User from '#models/user'
import { resetRateLimiter } from '#services/rate_limiter'
import { baseUrl, patchJson, postJson } from '#tests/helpers/api_client'

const initial = {
  name: 'Corte original',
  description: 'Descrição original',
  priceCents: 4500,
  durationMinutes: 45,
  isActive: true,
}
const fields = ['id', ...Object.keys(initial), 'createdAt', 'updatedAt'].sort()

async function jsonResponse(response: Response, status: number) {
  assert.equal(response.status, status)
  assert.ok(response.headers.get('content-type')?.includes('application/json'))
  const body = (await response.json()) as Record<string, unknown>
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body))
  return body
}

async function fixture() {
  const user = await User.create({
    fullName: 'Administrador',
    email: 'service-update@example.test',
    password: 'TestPassword123',
    role: 'admin',
  })
  const login = await postJson('/api/admin/login', {
    email: user.email,
    password: 'TestPassword123',
  })
  await jsonResponse(login.response, 200)
  const service = await Service.create(initial)
  await service.refresh()
  return { user, cookie: login.cookie, service }
}

async function update(id: number | string, data: unknown, cookie: string, status = 200) {
  const before = await Service.query().orderBy('id', 'asc')
  const { response } = await patchJson(`/api/admin/services/${id}`, data, cookie)
  const after = await Service.query().orderBy('id', 'asc')
  assert.deepEqual(
    after.map((service) => service.id),
    before.map((service) => service.id)
  )
  const body = await jsonResponse(response, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return body
}

async function snapshot() {
  const services = await Service.query().orderBy('id', 'asc')
  return services.map((service) => service.serialize())
}

test.group('administrative services partial update', (group) => {
  group.each.setup(async () => {
    assert.equal(db.primaryConnectionName, 'sqlite')
    const config = db.getRawConnection('sqlite')?.config
    assert.equal(config?.client, 'better-sqlite3')
    assert.equal((config as { connection: { filename: string } }).connection.filename, ':memory:')
    resetRateLimiter()
    await Service.query().delete()
    await Customer.query().delete()
    await User.query().delete()
  })

  test('an administrator can partially update a service with an explicit response whitelist', async () => {
    const { cookie, service } = await fixture()
    const before = service.serialize()
    const body = await update(service.id, { name: '  Corte atualizado  ' }, cookie)
    assert.deepEqual(Object.keys(body), ['data'])
    const data = body.data as Record<string, unknown>
    assert.deepEqual(Object.keys(data).sort(), fields)
    assert.equal(data.name, 'Corte atualizado')
    for (const key of [
      'id',
      'description',
      'priceCents',
      'durationMinutes',
      'isActive',
      'createdAt',
    ]) {
      assert.deepEqual(data[key], before[key])
    }
    await service.refresh()
    assert.equal(service.name, 'Corte atualizado')
    assert.equal(typeof data.isActive, 'boolean')
    assert.equal(typeof data.updatedAt, 'string')
    assert.ok(!Number.isNaN(Date.parse(data.updatedAt as string)))
    assert.equal(JSON.stringify(body).includes('service-update@example.test'), false)
    assert.equal(JSON.stringify(body).includes('password'), false)
  })

  test('a visitor cannot update a service even with valid CSRF', async () => {
    const service = await Service.create(initial)
    const before = await snapshot()
    const { response } = await patchJson(`/api/admin/services/${service.id}`, { name: 'Alterado' })
    const body = await jsonResponse(response, 401)
    assert.equal(body.message, 'Não autenticado.')
    assert.deepEqual(await snapshot(), before)
  })

  test('a session that lost its administrative role cannot update a service', async () => {
    const { cookie, service, user } = await fixture()
    user.role = 'user'
    await user.save()
    const before = await snapshot()
    const { response } = await patchJson(
      `/api/admin/services/${service.id}`,
      { isActive: false },
      cookie
    )
    const body = await jsonResponse(response, 403)
    assert.equal(body.message, 'Acesso permitido apenas para administradores.')
    assert.deepEqual(await snapshot(), before)
  })

  test('missing and invalid CSRF tokens prevent authenticated PATCH writes', async () => {
    const { cookie, service } = await fixture()
    const before = await snapshot()
    for (const token of [undefined, 'invalid-token']) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': cookie,
      }
      if (token) headers['X-XSRF-TOKEN'] = token
      const response = await fetch(`${baseUrl}/api/admin/services/${service.id}`, {
        method: 'PATCH',
        redirect: 'manual',
        headers,
        body: JSON.stringify({ isActive: false }),
      })
      const body = await jsonResponse(response, 403)
      assert.equal(body.code, 'E_BAD_CSRF_TOKEN')
      assert.deepEqual(await snapshot(), before)
    }
  })

  test('price and duration change without resetting omitted fields', async () => {
    const { cookie, service } = await fixture()
    await update(service.id, { priceCents: 5500, durationMinutes: 60 }, cookie)
    await service.refresh()
    assert.equal(service.priceCents, 5500)
    assert.equal(service.durationMinutes, 60)
    assert.equal(service.name, initial.name)
    assert.equal(service.description, initial.description)
    assert.equal(service.isActive, true)
  })

  test('deactivation preserves the service and omitted status remains inactive', async () => {
    const { cookie, service } = await fixture()
    const disabled = await update(service.id, { isActive: false }, cookie)
    assert.equal((disabled.data as Record<string, unknown>).isActive, false)
    await update(service.id, { priceCents: 0 }, cookie)
    await service.refresh()
    assert.equal(service.isActive, false)
    assert.equal(service.priceCents, 0)
    const services = await Service.all()
    assert.deepEqual(
      services.map((item) => item.id),
      [service.id]
    )
  })

  test('an inactive service can be reactivated', async () => {
    const { cookie, service } = await fixture()
    service.isActive = false
    await service.save()
    const body = await update(service.id, { isActive: true }, cookie)
    assert.equal((body.data as Record<string, unknown>).isActive, true)
    await service.refresh()
    assert.equal(service.isActive, true)
  })

  for (const description of [null, '', ' \n\t ']) {
    test(`description ${JSON.stringify(description)} explicitly removes the persisted description`, async () => {
      const { cookie, service } = await fixture()
      const body = await update(service.id, { description }, cookie)
      assert.equal((body.data as Record<string, unknown>).description, null)
      await service.refresh()
      assert.equal(service.description, null)
      assert.equal(service.name, initial.name)
    })
  }

  test('nonempty descriptions are trimmed and omission preserves null', async () => {
    const { cookie, service } = await fixture()
    await update(service.id, { description: '  Acabamento  ' }, cookie)
    await service.refresh()
    assert.equal(service.description, 'Acabamento')
    await update(service.id, { description: null }, cookie)
    await update(service.id, { name: 'Outro corte' }, cookie)
    await service.refresh()
    assert.equal(service.description, null)
  })

  test('inclusive numeric and text limits are accepted', async () => {
    const { cookie, service } = await fixture()
    for (const patch of [
      { name: 'AB', description: 'a'.repeat(1000), priceCents: 0, durationMinutes: 5 },
      { name: 'a'.repeat(120), priceCents: Number.MAX_SAFE_INTEGER, durationMinutes: 480 },
    ]) {
      const body = await update(service.id, patch, cookie)
      const data = body.data as Record<string, unknown>
      for (const [key, value] of Object.entries(patch)) assert.equal(data[key], value)
    }
  })

  test('invalid values including explicit null are rejected without changing any record', async () => {
    const { cookie, service } = await fixture()
    const before = await snapshot()
    const invalid: Array<[string, unknown]> = [
      ['name', null],
      ['name', ''],
      ['name', ' '],
      ['name', ' A '],
      ['name', 'a'.repeat(121)],
      ['name', 1],
      ['description', 'a'.repeat(1001)],
      ['description', 1],
      ['description', {}],
      ['priceCents', null],
      ['priceCents', -1],
      ['priceCents', 1.5],
      ['priceCents', Number.MAX_SAFE_INTEGER + 1],
      ['priceCents', '4500'],
      ['priceCents', true],
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
    for (const [key, value] of invalid) {
      const body = await update(
        service.id,
        { name: 'Alteração rejeitada', [key]: value },
        cookie,
        422
      )
      assert.equal(body.message, 'Dados do serviço inválidos.')
      assert.ok(Array.isArray(body.errors))
      assert.equal('data' in body, false)
      assert.deepEqual(await snapshot(), before, `${key}=${String(value)}`)
    }
  })

  test('empty patches and patches with only noneditable fields receive JSON 422', async () => {
    const { cookie, service } = await fixture()
    const before = await snapshot()
    for (const patch of [
      {},
      { id: 123 },
      { createdAt: '1900-01-01', updatedAt: '1900-01-01' },
      { unknown: true },
    ]) {
      const body = await update(service.id, patch, cookie, 422)
      assert.ok(Array.isArray(body.errors))
      assert.deepEqual(await snapshot(), before)
    }
  })

  test('missing and malformed identifiers return JSON 404 without creating records', async () => {
    const { cookie } = await fixture()
    const before = await snapshot()
    for (const id of ['999999', 'abc', '0', '-1', '1.5', '9007199254740992', '1%20OR%201%3D1']) {
      const body = await update(id, { name: 'Alterado' }, cookie, 404)
      assert.deepEqual(body, { message: 'Serviço não encontrado.' })
      assert.deepEqual(await snapshot(), before)
    }
  })

  test('IDs, timestamps and internal fields never reach the model or response', async () => {
    const { cookie, service } = await fixture()
    const other = await Service.create({ ...initial, name: 'Outro serviço' })
    await other.refresh()
    const otherBefore = other.serialize()
    const createdAt = service.createdAt.toISO()
    const body = await update(
      service.id,
      {
        name: 'Nome permitido',
        id: other.id,
        createdAt: '1900-01-01',
        updatedAt: '1900-01-01',
        created_at: '1900-01-01',
        updated_at: '1900-01-01',
        price_cents: 1,
        duration_minutes: 480,
        is_active: false,
        role: 'admin',
        userId: 1,
        password: 'private',
        $attributes: { id: other.id },
      },
      cookie
    )
    const data = body.data as Record<string, unknown>
    assert.deepEqual(Object.keys(data).sort(), fields)
    assert.equal(data.id, service.id)
    assert.equal(data.createdAt, createdAt)
    assert.notEqual(data.updatedAt, '1900-01-01')
    await service.refresh()
    assert.equal(service.name, 'Nome permitido')
    assert.equal(service.priceCents, initial.priceCents)
    assert.equal(service.durationMinutes, initial.durationMinutes)
    assert.equal(service.isActive, true)
    await other.refresh()
    assert.deepEqual(other.serialize(), otherBefore)
    const services = await Service.query().orderBy('id', 'asc')
    assert.deepEqual(
      services.map((item) => item.id),
      [service.id, other.id]
    )
  })

  test('Lucid preserves createdAt and advances updatedAt on a persisted change', async () => {
    const { cookie, service } = await fixture()
    // A historical timestamp avoids sleeps and SQLite second-precision timing races.
    await db.from('services').where('id', service.id).update({
      created_at: '2000-01-01 00:00:00',
      updated_at: '2000-01-02 00:00:00',
    })
    await service.refresh()
    const createdAt = service.createdAt.toISO()
    const updatedAt = service.updatedAt!.toMillis()
    const body = await update(service.id, { name: 'Atualizado hoje' }, cookie)
    const data = body.data as Record<string, unknown>
    assert.equal(data.createdAt, createdAt)
    assert.ok(Date.parse(data.updatedAt as string) > updatedAt)
    await service.refresh()
    assert.equal(service.createdAt.toISO(), createdAt)
    assert.ok(service.updatedAt!.toMillis() > updatedAt)
  })

  test('validation and missing-service errors stay JSON even with Accept HTML', async () => {
    const { cookie, service } = await fixture()
    const invalid = await patchJson(`/api/admin/services/${service.id}`, {}, cookie, 'text/html')
    await jsonResponse(invalid.response, 422)
    const missing = await patchJson(
      '/api/admin/services/999999',
      { name: 'Corte' },
      cookie,
      'text/html'
    )
    await jsonResponse(missing.response, 404)
  })
})
