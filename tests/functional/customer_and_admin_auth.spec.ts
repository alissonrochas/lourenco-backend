import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import Customer from '#models/customer'
import User from '#models/user'
import { resetRateLimiter } from '#services/rate_limiter'

const baseUrl = 'http://127.0.0.1:3333'
const publicRegistrationResponse = { message: 'Solicitação recebida.' }

function parseSetCookies(response: Response) {
  const headerWithMultipleValues = response.headers as Headers & { getSetCookie?: () => string[] }
  const setCookies =
    headerWithMultipleValues.getSetCookie?.() ??
    (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : [])

  const cookies = new Map<string, string>()

  for (const setCookie of setCookies) {
    const pair = setCookie.split(';')[0]
    const separator = pair.indexOf('=')

    if (separator !== -1) {
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
  }

  return cookies
}

function mergeCookieHeaders(existing: string, response: Response) {
  const cookies = new Map<string, string>()

  for (const item of existing.split(/;\s*/)) {
    const separator = item.indexOf('=')

    if (separator !== -1) {
      cookies.set(item.slice(0, separator), item.slice(separator + 1))
    }
  }

  for (const [name, value] of parseSetCookies(response)) {
    cookies.set(name, value)
  }

  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ')
}

function getCookieValue(cookieHeader: string, name: string) {
  const item = cookieHeader.split(/;\s*/).find((cookie) => cookie.startsWith(`${name}=`))

  return item?.slice(name.length + 1)
}

async function primeCsrf(existingCookie = '') {
  const response = await fetch(`${baseUrl}/api/csrf`, {
    headers: existingCookie ? { Cookie: existingCookie } : undefined,
  })

  const cookieHeader = mergeCookieHeaders(existingCookie, response)
  const xsrfToken = getCookieValue(cookieHeader, 'XSRF-TOKEN')

  assert.notEqual(xsrfToken, undefined)

  return { cookieHeader, xsrfToken: xsrfToken! }
}

async function postJson(path: string, body: unknown, existingCookie = '') {
  const csrf = await primeCsrf(existingCookie)
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': csrf.cookieHeader,
      'X-XSRF-TOKEN': csrf.xsrfToken,
    },
    body: JSON.stringify(body),
  })

  const cookieHeader = mergeCookieHeaders(csrf.cookieHeader, response)

  return { response, cookieHeader }
}

test.group('customer registration and admin authorization', (group) => {
  group.each.setup(async () => {
    resetRateLimiter()
    await Customer.query().delete()
    await User.query().delete()
  })

  test('it keeps customer registration public and does not create a user role', async () => {
    const { response } = await postJson('/api/customers', {
      name: 'Lucas Silva',
      phone: '(11) 99999-1234',
      role: 'admin',
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), publicRegistrationResponse)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('location'), null)

    const customer = await Customer.findByOrFail('phoneNormalized', '11999991234')
    assert.equal(customer.name, 'Lucas Silva')
    assert.equal(customer.phone, '11999991234')
    assert.equal(await User.query().where('email', 'Lucas Silva').first(), null)
  })

  test('it rejects customer listing for unauthenticated users', async () => {
    const response = await fetch(`${baseUrl}/api/customers`)

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

    const { response: loginResponse, cookieHeader } = await postJson('/api/admin/login', {
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
    })

    const loginPayload = (await loginResponse.json()) as {
      ok: boolean
      user: { email: string; role: 'admin' }
    }

    assert.equal(loginResponse.status, 200)
    assert.equal(loginPayload.ok, true)
    assert.equal(loginPayload.user.email, 'admin@barbearia.com')
    assert.equal(loginPayload.user.role, 'admin')
    assert.notEqual(cookieHeader, '')

    const listResponse = await fetch(`${baseUrl}/api/customers`, {
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

    const { response } = await postJson('/api/admin/login', {
      email: 'usuario@barbearia.com',
      password: 'SenhaForte123',
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

    const { response: loginResponse, cookieHeader } = await postJson('/api/admin/login', {
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
    })

    assert.equal(loginResponse.status, 200)

    admin.role = 'user'
    await admin.save()

    const response = await fetch(`${baseUrl}/api/customers`, {
      headers: { Cookie: cookieHeader },
    })

    assert.equal(response.status, 403)
  })

  test('it rejects invalid admin credentials', async () => {
    await User.create({
      fullName: 'Gerente',
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
      role: 'admin',
    })

    const { response } = await postJson('/api/admin/login', {
      email: 'admin@barbearia.com',
      password: 'SenhaIncorreta123',
    })

    assert.equal(response.status, 401)
  })

  test('it rejects login for an unknown account', async () => {
    const { response } = await postJson('/api/admin/login', {
      email: 'desconhecido@barbearia.com',
      password: 'SenhaForte123',
    })

    assert.equal(response.status, 401)
  })

  test('it invalidates the old cookie after logout', async () => {
    await User.create({
      fullName: 'Gerente',
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
      role: 'admin',
    })

    const { response: loginResponse, cookieHeader: oldCookie } = await postJson(
      '/api/admin/login',
      {
        email: 'admin@barbearia.com',
        password: 'SenhaForte123',
      }
    )

    assert.equal(loginResponse.status, 200)

    const { response: logoutResponse } = await postJson('/api/admin/logout', {}, oldCookie)

    assert.equal(logoutResponse.status, 200)

    const meResponse = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Cookie: oldCookie },
    })

    assert.equal(meResponse.status, 401)
  })

  test('it regenerates the session id after login', async () => {
    await User.create({
      fullName: 'Gerente',
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
      role: 'admin',
    })

    const guest = await primeCsrf()
    const guestSessionId = getCookieValue(guest.cookieHeader, 'adonis-session')

    const { response: loginResponse, cookieHeader: authenticatedCookie } = await postJson(
      '/api/admin/login',
      {
        email: 'admin@barbearia.com',
        password: 'SenhaForte123',
      },
      guest.cookieHeader
    )

    const authenticatedSessionId = getCookieValue(authenticatedCookie, 'adonis-session')

    assert.equal(loginResponse.status, 200)
    assert.notEqual(authenticatedSessionId, guestSessionId)

    const oldGuestResponse = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Cookie: guest.cookieHeader },
    })

    assert.equal(oldGuestResponse.status, 401)
  })

  test('it exposes the authenticated admin identity through me', async () => {
    await User.create({
      fullName: 'Gerente',
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
      role: 'admin',
    })

    const { response: loginResponse, cookieHeader } = await postJson('/api/admin/login', {
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
    })

    assert.equal(loginResponse.status, 200)

    const meResponse = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Cookie: cookieHeader },
    })

    assert.equal(meResponse.status, 200)
  })

  test('it denies dashboard access to a common user session', async () => {
    await User.create({
      fullName: 'Usuário comum',
      email: 'usuario@barbearia.com',
      password: 'SenhaForte123',
      role: 'user',
    })

    const { response } = await postJson('/login', {
      email: 'usuario@barbearia.com',
      password: 'SenhaForte123',
    })

    assert.equal(response.status, 403)
  })

  test('it does not expose the public signup route', async () => {
    const response = await fetch(`${baseUrl}/signup`, {
      redirect: 'manual',
    })

    assert.equal(response.status, 404)
  })

  test('it rejects a POST without a valid CSRF token', async () => {
    const response = await fetch(`${baseUrl}/api/customers`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Sem CSRF',
        phone: '(11) 97777-0000',
      }),
    })

    assert.equal(response.status, 403)
    assert.equal(response.headers.get('content-type')?.includes('application/json'), true)
  })

  test('it returns the same minimal response for new and equivalent existing phones', async () => {
    const first = await postJson('/api/customers', {
      name: 'Cliente Um',
      phone: '(11) 99999-1234',
    })
    const original = await Customer.findByOrFail('phoneNormalized', '11999991234')
    await original.refresh()
    const originalData = original.serialize()

    const duplicate = await postJson('/api/customers', {
      name: 'Nome enviado por outra pessoa',
      phone: '11999991234',
    })

    assert.equal(first.response.status, 200)
    assert.equal(duplicate.response.status, first.response.status)
    assert.deepEqual(await first.response.json(), publicRegistrationResponse)
    assert.deepEqual(await duplicate.response.json(), publicRegistrationResponse)
    for (const header of ['content-type', 'content-length', 'cache-control', 'location']) {
      assert.equal(first.response.headers.get(header), duplicate.response.headers.get(header))
    }
    assert.equal(duplicate.response.headers.get('cache-control'), 'no-store')
    assert.equal(duplicate.response.headers.get('location'), null)

    const customers = await Customer.all()
    assert.equal(customers.length, 1)
    assert.deepEqual(customers[0].serialize(), originalData)
  })

  test('it does not reveal a stored customer or use the supplied phone as authorization', async () => {
    const original = await Customer.create({
      name: 'Nome privado do cliente',
      phone: '21988887777',
      phoneNormalized: '21988887777',
    })
    await original.refresh()
    const originalData = original.serialize()
    const { response } = await postJson('/api/customers', {
      name: 'Tentativa de substituição',
      phone: '(21) 98888-7777',
      id: original.id,
      phoneNormalized: '31977776666',
      role: 'admin',
    })

    assert.equal(response.status, 200)
    // Exact equality rejects extra fields such as ID, name, phones, timestamps or tokens.
    assert.deepEqual(await response.json(), publicRegistrationResponse)
    assert.equal(response.headers.get('location'), null)
    await original.refresh()
    assert.deepEqual(original.serialize(), originalData)
    assert.deepEqual(await User.all(), [])

    const listing = await fetch(`${baseUrl}/api/customers`)
    assert.equal(listing.status, 401)
  })

  test('it preserves a legacy phone with NULL normalization without disclosing a conflict', async () => {
    const original = await Customer.create({
      name: 'Cliente antigo',
      phone: '11977776666',
      phoneNormalized: null,
    })
    await original.refresh()
    const originalData = original.serialize()
    const { response } = await postJson('/api/customers', {
      name: 'Nome diferente',
      phone: '(11) 97777-6666',
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), publicRegistrationResponse)
    await original.refresh()
    assert.deepEqual(original.serialize(), originalData)
    const customers = await Customer.all()
    assert.equal(customers.length, 1)
  })

  test('it handles concurrent equivalent submissions privately without creating duplicates', async () => {
    const phones = ['(31) 97777-6666', '31977776666', '(31) 97777 6666', '31 97777-6666']
    const results = await Promise.all(
      phones.map((phone, index) =>
        postJson('/api/customers', {
          name: `Cliente concorrente ${index}`,
          phone,
        })
      )
    )

    for (const { response } of results) {
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), publicRegistrationResponse)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('location'), null)
    }
    const customers = await Customer.all()
    assert.equal(customers.length, 1)
    assert.equal(customers[0].phone, '31977776666')
    assert.equal(customers[0].phoneNormalized, '31977776666')
  })

  test('it rejects invalid normalized phone lengths', async () => {
    const { response } = await postJson('/api/customers', {
      name: 'Cliente Inválido',
      phone: '---123---',
    })

    assert.equal(response.status, 422)
  })

  test('it rate limits repeated customer submissions', async () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const { response } = await postJson('/api/customers', {
        name: `Cliente ${attempt}`,
        phone: '(11) 98888-0000',
      })

      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), publicRegistrationResponse)
    }

    const { response } = await postJson('/api/customers', {
      name: 'Cliente bloqueado',
      phone: '(11) 98888-0000',
    })

    assert.equal(response.status, 429)
    assert.notEqual(response.headers.get('retry-after'), null)
  })

  test('it rate limits repeated administrative login attempts', async () => {
    await User.create({
      fullName: 'Gerente',
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
      role: 'admin',
    })

    for (let attempt = 1; attempt <= 5; attempt++) {
      const { response } = await postJson('/api/admin/login', {
        email: 'admin@barbearia.com',
        password: 'SenhaErrada123',
      })

      assert.equal(response.status, 401)
    }

    const { response } = await postJson('/api/admin/login', {
      email: 'admin@barbearia.com',
      password: 'SenhaForte123',
    })

    assert.equal(response.status, 429)
  })
})
