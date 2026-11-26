import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { test } from '@japa/runner'
import { HttpContextFactory, RequestFactory } from '@adonisjs/core/factories/http'
import AvailabilityRateLimitMiddleware from '#middleware/availability_rate_limit_middleware'
import { resetRateLimiter } from '#services/rate_limiter'

test.group('availability IP trust and budget', () => {
  test('untrusted peers cannot rotate arbitrary forwarded IP headers to escape the limiter', async () => {
    resetRateLimiter()
    try {
      let passed = 0
      const middleware = new AvailabilityRateLimitMiddleware()
      for (let attempt = 0; attempt < 61; attempt++) {
        const socket = new Socket()
        Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.7' })
        const native = new IncomingMessage(socket)
        native.url = '/api/availability?date=2026-12-25'
        native.method = 'GET'
        native.headers = {
          'x-forwarded-for': `198.51.100.${attempt}`,
          'x-real-ip': `192.0.2.${attempt}`,
        }
        const request = new RequestFactory()
          .merge({ req: native, config: { trustProxy: (address) => address === '127.0.0.1' } })
          .create()
        assert.equal(request.ip(), '203.0.113.7')
        const ctx = new HttpContextFactory().merge({ request }).create()
        await middleware.handle(ctx, async () => {
          passed++
        })
        if (attempt === 60) assert.equal(ctx.response.getStatus(), 429)
        socket.destroy()
      }
      assert.equal(passed, 60)
    } finally {
      resetRateLimiter()
    }
  })
})
