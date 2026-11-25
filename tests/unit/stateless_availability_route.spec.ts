import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { HttpContextFactory, RouterFactory } from '@adonisjs/core/factories/http'
import {
  isStatelessAvailability,
  PUBLIC_AVAILABILITY_ROUTE,
} from '#middleware/availability_state_middleware'

test.group('stateless availability route identity', () => {
  test('requires GET and the exact matched route name and pattern', () => {
    for (const [method, pattern, name, expected] of [
      ['GET', '/api/availability', PUBLIC_AVAILABILITY_ROUTE, true],
      ['HEAD', '/api/availability', PUBLIC_AVAILABILITY_ROUTE, false],
      ['POST', '/api/availability', PUBLIC_AVAILABILITY_ROUTE, false],
      ['PUT', '/api/availability', PUBLIC_AVAILABILITY_ROUTE, false],
      ['PATCH', '/api/availability', PUBLIC_AVAILABILITY_ROUTE, false],
      ['DELETE', '/api/availability', PUBLIC_AVAILABILITY_ROUTE, false],
      ['GET', '/api/availability-extra', PUBLIC_AVAILABILITY_ROUTE, false],
      ['GET', '/api/availability/extra', PUBLIC_AVAILABILITY_ROUTE, false],
      ['GET', '/api/admin/booking-settings', PUBLIC_AVAILABILITY_ROUTE, false],
      ['GET', '/api/availability', 'other.route', false],
    ] as const) {
      const router = new RouterFactory().create()
      router.get(pattern, () => {}).as(name)
      router.commit()
      const matched = router.match(pattern, 'GET', false)
      assert.ok(matched)
      const ctx = new HttpContextFactory().merge({ method, url: pattern }).create()
      ctx.route = matched.route
      assert.equal(isStatelessAvailability(ctx), expected, `${method} ${pattern} ${name}`)
    }
    const unmatched = new HttpContextFactory().create()
    unmatched.route = undefined
    assert.equal(isStatelessAvailability(unmatched), false)
  })
})
