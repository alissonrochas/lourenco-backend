import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { LoggerFactory } from '@adonisjs/logger/factories'
import type { LoggerConfig } from '@adonisjs/logger/types'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import ContainerBindingsMiddleware from '#middleware/container_bindings_middleware'
import ServicesController from '#controllers/services_controller'
import BookingAvailabilityService from '#services/booking_availability_service'
import { resetRateLimiter } from '#services/rate_limiter'
import { internalServerError } from '#services/http_response_policy'
import User from '#models/user'
import { baseUrl, getJson, postJson } from '#tests/helpers/api_client'

const markers = [
  '559999999999991',
  'r09-client-unique@example.invalid',
  'R09_TOKEN_ONLY_SYNTHETIC',
  'R09_COOKIE_ONLY_SYNTHETIC',
  'R09_SQL_BINDING_ONLY_SYNTHETIC',
  'R09_PASSWORD_ONLY_SYNTHETIC',
]
const logs: string[] = []
async function sqlFailure(): Promise<never> {
  try {
    await db
      .from('customers')
      .whereRaw('r09_missing_column IN (?, ?, ?, ?, ?, ?)', markers)
      .select('*')
  } catch (error) {
    // Prove this is an actual SQLite exception whose raw message leaks every canary.
    assert.ok(error instanceof Error)
    for (const marker of markers) assert.ok(error.message.includes(marker))
    throw error
  }
  throw new Error('Expected SQLite failure')
}
class FaultController extends ServicesController {
  async index(ctx: HttpContext): Promise<never> {
    ctx.response.header('Cache-Control', 'public, max-age=86400')
    ctx.response.header('Expires', 'Fri, 01 Jan 2038 00:00:00 GMT')
    ctx.response.header('CDN-Cache-Control', 'public, max-age=86400')
    ctx.response.header('Surrogate-Control', 'max-age=86400')
    return sqlFailure()
  }
}
class FaultAvailability extends BookingAvailabilityService {
  async calculate(): Promise<never> {
    return sqlFailure()
  }
}
async function json(response: Response, status: number) {
  assert.equal(response.status, status)
  assert.ok(response.headers.get('content-type')?.includes('application/json'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  for (const name of ['Expires', 'CDN-Cache-Control', 'Surrogate-Control']) {
    assert.equal(response.headers.get(name), null)
  }
  return response.json() as Promise<{ code?: string; errors?: unknown[] }>
}
function noMarkers(value: string) {
  for (const marker of markers)
    assert.ok(!value.includes(marker), `Leaked synthetic marker: ${marker}`)
}
function checkLogs(route: string, response: Response) {
  assert.ok(logs.length > 0, 'Actual logger must retain a diagnostic event')
  noMarkers(logs.join('\n'))
  const entry = JSON.parse(logs.at(-1)!)
  assert.equal(entry.failure.code, 'SQLITE_ERROR')
  assert.equal(entry.failure.type, 'database')
  assert.equal(entry.route, route)
  assert.equal(entry.method, 'GET')
  assert.match(entry.requestId, /^[0-9a-f-]{36}$/)
  assert.equal(entry.requestId, response.headers.get('x-request-id'))
  assert.equal(entry.msg, 'HTTP request failed')
}
async function login(role = 'admin') {
  const user = await User.create({
    email: `r09-${role}@example.test`,
    password: 'SyntheticPasswordOnly',
    role,
  })
  const result = await postJson(
    '/api/admin/login',
    { email: user.email, password: 'SyntheticPasswordOnly' },
    '',
    'text/html'
  )
  await json(result.response, role === 'admin' ? 200 : 403)
  return { user, cookie: result.cookie }
}

test.group('API privacy, HTTP negotiation and private cache', (group) => {
  group.each.setup(async () => {
    assert.equal(app.config.get('database.connections.sqlite.connection.filename'), ':memory:')
    resetRateLimiter()
    for (const table of ['bookings', 'customers', 'users']) await db.from(table).delete()
    logs.length = 0
    const config = app.config.get<LoggerConfig>('logger.loggers.app')
    const logger = new LoggerFactory()
      .merge({
        ...config,
        enabled: true,
        level: 'trace',
        transport: undefined,
        destination: undefined,
      })
      .pushLogsTo(logs)
      .create()
    app.container.swap(ContainerBindingsMiddleware, () => ({
      handle(ctx: HttpContext, next: NextFn) {
        // Capture the real logger pipeline, including Adonis' untrusted child binding.
        ctx.logger = logger.child({ request_id: ctx.request.id() })
        return new ContainerBindingsMiddleware().handle(ctx, next)
      },
    }))
  })
  group.each.teardown(() => {
    app.container.restoreAll()
    resetRateLimiter()
  })

  for (const accept of ['text/html', 'application/json', '*/*']) {
    test(`real SQLite 500 is private JSON with Accept ${accept}`, async () => {
      app.container.swap(ServicesController, () => new FaultController())
      const response = await fetch(`${baseUrl}/api/services?probe=${markers[1]}`, {
        headers: {
          'Accept': accept,
          'Authorization': `Bearer ${markers[2]}`,
          'Cookie': `probe=${markers[3]}`,
          'X-Request-Id': markers[2],
          'X-Inertia': 'true',
          'X-Inertia-Version': markers[4],
        },
      })
      assert.deepEqual(await json(response, 500), internalServerError)
      noMarkers(JSON.stringify([...response.headers]))
      checkLogs('/api/services', response)
    })
  }

  test('controller-handled SQLite 503 also uses safe operational logs', async () => {
    app.container.swap(
      BookingAvailabilityService,
      () => new FaultAvailability(db, () => DateTime.fromISO('2026-12-01T12:00:00Z'))
    )
    const response = await getJson('/api/availability?date=2026-12-28', '', 'text/html')
    assert.deepEqual(await json(response, 503), {
      message: 'Não foi possível consultar os horários. Tente novamente.',
    })
    noMarkers(JSON.stringify([...response.headers]))
    checkLogs('/api/availability', response)
  })

  for (const accept of ['text/html', 'application/json']) {
    test(`API 404 and validation 422 stay JSON with Accept ${accept}`, async () => {
      const missing = await getJson(`/api/missing-${markers[2]}`, '', accept)
      assert.deepEqual(await json(missing, 404), {
        code: 'NOT_FOUND',
        message: 'Recurso não encontrado.',
      })
      const invalid = await postJson('/api/admin/login', {}, '', accept)
      const body = await json(invalid.response, 422)
      assert.ok(Array.isArray(body.errors))
      assert.equal(invalid.response.headers.get('location'), null)
      noMarkers(JSON.stringify(body))
    })
  }

  test('Inertia version headers do not turn API success into an asset redirect', async () => {
    const response = await fetch(`${baseUrl}/api/services`, {
      headers: { 'Accept': 'text/html', 'X-Inertia': 'true', 'X-Inertia-Version': 'old-version' },
    })
    assert.equal(response.status, 200)
    assert.ok(response.headers.get('content-type')?.includes('application/json'))
    assert.equal(response.headers.get('x-inertia-location'), null)
  })

  test('anonymous private endpoints and pre-controller CSRF failures are no-store', async () => {
    for (const path of [
      '/api/admin/me',
      '/api/customers',
      '/api/admin/services',
      '/api/admin/bookings?from=2026-12-28&to=2026-12-28',
      '/api/admin/booking-settings',
      '/api/admin/calendar-exceptions?from=2026-12-28&to=2026-12-28',
    ]) {
      await json(await getJson(path, '', 'text/html'), 401)
    }
    for (const path of ['/api/admin/login', '/api/admin/logout', '/api/admin/services']) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Accept': 'text/html', 'Content-Type': 'application/json' },
        body: '{}',
      })
      const body = await json(response, 403)
      assert.equal(body.code, 'E_BAD_CSRF_TOKEN')
    }
  })

  test('authenticated reads, errors, login, logout and revoked access prohibit storage', async () => {
    const { user, cookie } = await login()
    for (const path of [
      '/api/admin/me',
      '/api/customers',
      '/api/admin/services',
      '/api/admin/bookings?from=2026-12-28&to=2026-12-28',
      '/api/admin/booking-settings',
      '/api/admin/calendar-exceptions?from=2026-12-28&to=2026-12-28',
    ]) {
      await json(await getJson(path, cookie, 'text/html'), 200)
    }
    await json(await getJson('/api/admin/services/999999', cookie, 'text/html'), 404)
    const invalid = await postJson('/api/admin/services', {}, cookie, 'text/html')
    await json(invalid.response, 422)
    const settings = await getJson('/api/admin/booking-settings', cookie)
    assert.ok(settings.headers.get('etag'), 'Calendar If-Match validator must survive no-store')
    user.role = 'user'
    await user.save()
    await json(await getJson('/api/admin/me', cookie), 403)
    user.role = 'admin'
    await user.save()
    const renewed = await postJson('/api/admin/login', {
      email: user.email,
      password: 'SyntheticPasswordOnly',
    })
    const logout = await postJson('/api/admin/logout', {}, renewed.cookie)
    await json(logout.response, 200)
    await json(await getJson('/api/admin/me', logout.cookie), 401)
  })

  test('non-administrator login and rate-limited authentication remain private JSON', async () => {
    await login('user')
    let response: Response | undefined
    for (let index = 0; index < 7; index++) {
      const attempt = await postJson(
        '/api/admin/login',
        { email: 'r09-unknown@example.test', password: 'SyntheticPasswordOnly' },
        '',
        'text/html'
      )
      response = attempt.response
      if (response.status === 429) break
      await json(response, 401)
    }
    assert.ok(response)
    await json(response, 429)
    assert.ok(Number(response.headers.get('retry-after')) > 0)
  })
  test('disposable HTTP intermediary never reuses private responses across sessions', async () => {
    const { cookie } = await login()
    let forwarded = 0
    let cached: { status: number; body: string } | undefined
    const proxy = createServer(async (request, response) => {
      try {
        if (cached) {
          response.writeHead(cached.status).end(cached.body)
          return
        }
        forwarded++
        const upstream = await getJson('/api/admin/me', request.headers.cookie ?? '', 'text/html')
        const body = await upstream.text()
        const cacheControl = upstream.headers.get('cache-control') ?? ''
        // Deliberately simple test intermediary: an explicitly cacheable response
        // may be reused; no-store must always prohibit that storage.
        if (!cacheControl.includes('no-store') && /public|max-age=/.test(cacheControl)) {
          cached = { status: upstream.status, body }
        }
        response
          .writeHead(upstream.status, {
            'Cache-Control': cacheControl,
            'Content-Type': 'application/json',
          })
          .end(body)
      } catch {
        response.writeHead(502).end()
      }
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    try {
      const address = proxy.address()
      assert.ok(address && typeof address !== 'string')
      const url = `http://127.0.0.1:${address.port}/api/admin/me`
      await json(await fetch(url, { headers: { Cookie: cookie } }), 200)
      await json(await fetch(url), 401)
      await json(await fetch(url, { headers: { Cookie: cookie } }), 200)
      assert.equal(cached, undefined)
      assert.equal(forwarded, 3)
    } finally {
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
