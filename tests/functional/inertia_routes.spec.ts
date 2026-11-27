import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { resetRateLimiter } from '#services/rate_limiter'
import { baseUrl, getJson, postJson } from '#tests/helpers/api_client'

async function inertiaPage(path: string, cookie = '') {
  const headers = { 'Accept': 'text/html', 'X-Inertia': 'true', 'Cookie': cookie }
  let response = await fetch(`${baseUrl}${path}`, { redirect: 'manual', headers })
  // Follow Inertia's real asset-version negotiation, without disabling it in the app.
  if (response.status === 409 && response.headers.has('x-inertia-version')) {
    const version = response.headers.get('x-inertia-version')!
    assert.ok(version)
    assert.equal(new URL(response.headers.get('x-inertia-location')!, baseUrl).pathname, path)
    response = await fetch(`${baseUrl}${path}`, {
      redirect: 'manual',
      headers: { ...headers, 'X-Inertia-Version': version },
    })
  }
  return response
}

test.group('legacy Inertia routes remain available without public signup', (group) => {
  group.each.setup(() => {
    assert.equal(
      (db.getRawConnection('sqlite')!.config as { connection: { filename: string } }).connection
        .filename,
      ':memory:'
    )
    resetRateLimiter()
    return () => resetRateLimiter()
  })

  test('home and login still return their real Inertia page contracts', async () => {
    for (const [path, component] of [
      ['/', 'home'],
      ['/login', 'auth/login'],
    ]) {
      const response = await inertiaPage(path)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-inertia'), 'true')
      const page = (await response.json()) as {
        component: string
        props: { preferences: { theme: string } }
      }
      assert.equal(page.component, component)
      assert.equal(page.props.preferences.theme, 'light')
    }
  })

  test('dashboard protection and legacy administrator login/logout keep their existing behavior', async () => {
    const guest = await inertiaPage('/dashboard')
    assert.equal(guest.status, 401)
    const user = await User.create({
      email: 'inertia-r08@example.test',
      password: 'R08OnlyTestPassword',
      role: 'admin',
    })
    try {
      const login = await postJson('/login', { email: user.email, password: 'R08OnlyTestPassword' })
      assert.equal(login.response.status, 302)
      assert.equal(new URL(login.response.headers.get('location')!, baseUrl).pathname, '/dashboard')
      const dashboard = await inertiaPage('/dashboard', login.cookie)
      assert.equal(dashboard.status, 200)
      assert.equal(((await dashboard.json()) as { component: string }).component, 'dashboard')
      const me = await getJson('/api/admin/me', login.cookie)
      assert.equal(me.status, 200)
      const logout = await postJson('/logout', {}, login.cookie)
      assert.equal(logout.response.status, 302)
      assert.equal(new URL(logout.response.headers.get('location')!, baseUrl).pathname, '/login')
      const denied = await getJson('/api/admin/me', logout.cookie)
      assert.equal(denied.status, 401)
    } finally {
      await user.delete()
    }
  })

  test('signup remains unrouted and cannot create accounts through the legacy URLs', async () => {
    const before = await db.from('users').select('*').orderBy('id')
    for (const path of ['/signup', '/register', '/new-account']) {
      const read = await getJson(path)
      assert.equal(read.status, 404)
      const write = await postJson(path, {
        fullName: 'Synthetic account',
        email: 'never-created-r08@example.test',
        password: 'R08OnlyTestPassword',
        passwordConfirmation: 'R08OnlyTestPassword',
      })
      assert.equal(write.response.status, 404)
    }
    assert.deepEqual(await db.from('users').select('*').orderBy('id'), before)
  })
})
