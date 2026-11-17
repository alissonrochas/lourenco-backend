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

test.group('customer registration and admin auth', (group) => {
  group.each.setup(async () => {
    await Customer.query().delete()
    await User.query().delete()
  })

  test('it registers a customer with name and phone', async () => {
    const response = await fetch('http://127.0.0.1:3333/api/customers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Lucas Silva',
        phone: '(11) 99999-1234',
      }),
    })

    const payload = (await response.json()) as { name: string; phone: string }

    assert.equal(response.status, 201)
    assert.equal(payload.name, 'Lucas Silva')
    assert.equal(payload.phone, '(11) 99999-1234')
  })

  test('it rejects customer listing for unauthenticated users', async () => {
    const response = await fetch('http://127.0.0.1:3333/api/customers')

    assert.equal(response.status, 401)
  })

  test('it authenticates the admin and allows customer listing', async () => {
    await User.create({
      fullName: 'Gerente',
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
    })

    await Customer.create({
      name: 'Lucas Silva',
      phone: '(11) 99999-1234',
    })

    const loginResponse = await fetch('http://127.0.0.1:3333/api/admin/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'admin@barbearia.com',
        password: 'SenhaForte123',
      }),
    })

    const loginPayload = (await loginResponse.json()) as {
      ok: boolean
      user: { email: string }
    }

    assert.equal(loginResponse.status, 200)
    assert.equal(loginPayload.ok, true)
    assert.equal(loginPayload.user.email, 'admin@barbearia.com')

    const cookieHeader = getCookieHeader(loginResponse)
    assert.notEqual(cookieHeader, '')

    const listResponse = await fetch('http://127.0.0.1:3333/api/customers', {
      headers: {
        Cookie: cookieHeader,
      },
    })

    const customers = (await listResponse.json()) as Array<{ name: string; phone: string }>

    assert.equal(listResponse.status, 200)
    assert.equal(customers.length, 1)
    assert.equal(customers[0].name, 'Lucas Silva')
  })
})
