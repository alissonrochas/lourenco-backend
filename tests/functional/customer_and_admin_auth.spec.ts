import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import Customer from '#models/customer'
import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'

test.group('customer registration and admin auth', (group) => {
  group.each.setup(async () => {
    await Customer.query().delete()
    await User.query().delete()
    await testUtils.httpServer().start()
  })
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

test('it authenticates the admin with valid credentials', async () => {
  await User.create({
    fullName: 'Gerente',
    email: 'admin@barbearia.com',
    password: 'SenhaForte123',
  })

  const response = await fetch('http://127.0.0.1:3333/api/admin/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
    }),
  })

  const payload = (await response.json()) as {
    ok: boolean
    user: { email: string }
  }

  assert.equal(response.status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.user.email, 'admin@barbearia.com')
})
