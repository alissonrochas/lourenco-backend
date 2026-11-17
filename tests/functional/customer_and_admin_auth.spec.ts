import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import Customer from '#models/customer'
import User from '#models/user'

function getCookieHeader(response: Response) {
  const setCookie = response.headers.get('set-cookie')

  if (!setCookie) {
    return ''
  }

  return setCookie
    .split(/,(?=[^;,]+=[^;,]+)/)
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

test.group('customer registration and admin authorization', (group) => {
  group.each.setup(async () => {
    await Customer.query().delete()
    await User.query().delete()
  })

  test('it keeps customer registration public and does not create a user role', async () => {
    const response = await fetch('http://127.0.0.1:3333/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Lucas Silva',
        phone: '(11) 99999-1234',
        role: 'admin',
      }),
    })

    const payload = (await response.json()) as { name: string; phone: string }

    assert.equal(response.status, 201)
    assert.equal(payload.name, 'Lucas Silva')
    assert.equal(payload.phone, '(11) 99999-1234')
    assert.equal(await User.query().where('email', 'Lucas Silva').first(), null)
  })

  test('it rejects customer listing for unauthenticated users', async () => {
    const response = await fetch('http://127.0.0.1:3333/api/customers')

    assert.equal(response.status, 401)
  })

  test('it allows an admin to authenticate and list customers', async () => {
    await User.create({
      fullName: 'Gerente',
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
      role: 'admin',
    })

    await Customer.create({
      name: 'Lucas Silva',
      phone: '(11) 99999-1234',
    })

    const loginResponse = await fetch('http://127.0.0.1:3333/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@barbearia.com',
        password: 'SenhaForte123',
      }),
    })

    const loginPayload = (await loginResponse.json()) as {
      ok: boolean
      user: { email: string; role: 'admin' }
    }

    assert.equal(loginResponse.status, 200)
    assert.equal(loginPayload.ok, true)
    assert.equal(loginPayload.user.email, 'admin@barbearia.com')
    assert.equal(loginPayload.user.role, 'admin')

    const cookieHeader = getCookieHeader(loginResponse)
    assert.notEqual(cookieHeader, '')

    const listResponse = await fetch('http://127.0.0.1:3333/api/customers', {
      headers: { Cookie: cookieHeader },
    })

    const customers = (await listResponse.json()) as Array<{ name: string; phone: string }>

    assert.equal(listResponse.status, 200)
    assert.equal(customers.length, 1)
    assert.equal(customers[0].name, 'Lucas Silva')
  })

  test('it rejects login for a user with role user', async () => {
    await User.create({
      fullName: 'Usuário comum',
      email: 'usuario@barbearia.com',
      password: 'SenhaForte123',
      role: 'user',
    })

    const response = await fetch('http://127.0.0.1:3333/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'usuario@barbearia.com',
        password: 'SenhaForte123',
      }),
    })

    assert.equal(response.status, 403)
  })

  test('it denies access after an authenticated admin is changed to role user', async () => {
    const admin = await User.create({
      fullName: 'Gerente',
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
      role: 'admin',
    })

    const loginResponse = await fetch('http://127.0.0.1:3333/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@barbearia.com',
        password: 'SenhaForte123',
      }),
    })

    assert.equal(loginResponse.status, 200)

    const cookieHeader = getCookieHeader(loginResponse)
    admin.role = 'user'
    await admin.save()

    const response = await fetch('http://127.0.0.1:3333/api/customers', {
      headers: { Cookie: cookieHeader },
    })

    assert.equal(response.status, 403)
  })
})
