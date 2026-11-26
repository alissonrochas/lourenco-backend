import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import {
  InMemoryRateLimiter,
  checkRateLimit,
  rateLimiter,
  resetRateLimiter,
} from '#services/rate_limiter'
import LoginRateLimitMiddleware from '#middleware/login_rate_limit_middleware'

test.group('bounded in-memory rate limiter', () => {
  test('preserves fixed-window counters, boundaries and rounded Retry-After', () => {
    let now = 0
    const limiter = new InMemoryRateLimiter(10, () => now)
    assert.deepEqual(limiter.check('key', 2, 1500), {
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 2,
    })
    now = 500
    assert.deepEqual(limiter.check('key', 2, 1500), {
      allowed: true,
      remaining: 0,
      retryAfterSeconds: 1,
    })
    now = 1499
    assert.deepEqual(limiter.check('key', 2, 1500), {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 1,
    })
    now = 1500
    assert.deepEqual(limiter.check('key', 2, 1500), {
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 2,
    })
  })
  test('sweeps expired keys when unrelated traffic arrives, without changing active counters', () => {
    let now = 0
    const limiter = new InMemoryRateLimiter(20, () => now)
    for (let i = 0; i < 10; i++) limiter.check(`expired-${i}`, 1, 1000)
    limiter.check('active', 2, 10000)
    now = 1000
    assert.equal(limiter.check('unrelated', 1, 10000).allowed, true)
    assert.equal(limiter.size, 2)
    assert.equal(limiter.check('active', 2, 10000).remaining, 0)
    assert.equal(limiter.check('active', 2, 10000).allowed, false)
  })
  test('does not evict active blocked counters at capacity and rejects untracked keys', () => {
    const limiter = new InMemoryRateLimiter(2, () => 0)
    limiter.check('blocked', 1, 60000)
    limiter.check('other', 2, 900000)
    for (let i = 0; i < 100; i++) assert.equal(limiter.check(`new-${i}`, 50, 60000).allowed, false)
    assert.equal(limiter.size, 2)
    assert.equal(limiter.check('blocked', 1, 60000).allowed, false)
    assert.equal(limiter.check('other', 2, 900000).remaining, 0)
    assert.equal(limiter.check('other', 2, 900000).allowed, false)
  })
  test('recovers capacity on expiration and reports its earliest expiry without sliding it', () => {
    let now = 0
    const limiter = new InMemoryRateLimiter(2, () => now)
    limiter.check('short', 1, 60000)
    limiter.check('long', 1, 900000)
    now = 1500
    assert.equal(limiter.check('new', 1, 60000).retryAfterSeconds, 59)
    now = 60000
    assert.equal(limiter.check('new', 1, 60000).allowed, true)
    assert.equal(limiter.size, 2)
    assert.equal(limiter.check('long', 1, 900000).allowed, false)
  })
  test('fails conservatively between sweeps and permits the same expired key to renew immediately', () => {
    let now = 0
    const limiter = new InMemoryRateLimiter(1, () => now)
    limiter.check('short', 1, 500)
    now = 500
    assert.equal(limiter.check('unknown', 1, 500).allowed, false)
    assert.equal(limiter.check('short', 1, 500).allowed, true)
    assert.equal(limiter.size, 1)
    now = 1000
    assert.equal(limiter.check('unknown', 1, 500).allowed, true)
  })
  test('controls a 20000-key flood and collects the whole expired population', () => {
    let now = 0
    const limiter = new InMemoryRateLimiter(128, () => now)
    let allowed = 0
    for (let i = 0; i < 20000; i++) if (limiter.check(`load-${i}`, 1, 1000).allowed) allowed++
    assert.equal(allowed, 128)
    assert.equal(limiter.size, 128)
    assert.equal(limiter.check('load-0', 1, 1000).allowed, false)
    now = 1000
    assert.equal(limiter.check('new-window', 1, 1000).allowed, true)
    assert.equal(limiter.size, 1)
  })
  test('stores fixed-size digests while preserving identity and namespaces for large inputs', () => {
    const limiter = new InMemoryRateLimiter(2, () => 0)
    const large = 'x'.repeat(100000)
    assert.equal(limiter.check(`login:${large}`, 1, 60000).allowed, true)
    assert.equal(limiter.check(`login:${large}`, 1, 60000).allowed, false)
    assert.equal(limiter.check(`booking:${large}`, 1, 60000).allowed, true)
    assert.equal(limiter.size, 2)
    assert.equal(limiter.check('third', 1, 60000).allowed, false)
  })
  test('concurrent promise callers cannot overspend a shared process budget', async () => {
    const limiter = new InMemoryRateLimiter(10, () => 0)
    const results = await Promise.all(
      Array.from({ length: 500 }, async () => limiter.check('shared', 30, 60000))
    )
    assert.equal(results.filter((r) => r.allowed).length, 30)
    assert.equal(limiter.size, 1)
  })
  test('reset clears entries and sweep metadata; independent instances do not share budgets', () => {
    const first = new InMemoryRateLimiter(1, () => 0)
    const second = new InMemoryRateLimiter(1, () => 0)
    first.check('a', 1, 60000)
    assert.equal(second.check('a', 1, 60000).allowed, true)
    first.reset()
    assert.equal(first.size, 0)
    assert.equal(first.check('b', 1, 60000).allowed, true)
  })
  test('rejects invalid storage configuration', () => {
    for (const capacity of [0, -1, 1.5, Infinity])
      assert.throws(() => new InMemoryRateLimiter(capacity), RangeError)
    assert.throws(() => new InMemoryRateLimiter(1, () => 0, 0), RangeError)
  })
})

test.group('login budget ordering', (group) => {
  group.each.setup(() => {
    resetRateLimiter()
    return () => resetRateLimiter()
  })
  test('a blocked IP neither reads email, allocates a key, nor runs authentication', async () => {
    for (let i = 0; i < 30; i++) checkRateLimit('login-ip:synthetic', 30, 900000)
    const before = rateLimiter.size
    let authenticated = 0
    const headers: Record<string, string> = {}
    const ctx = {
      request: {
        ip: () => 'synthetic',
        input: () => {
          throw new Error('Blocked email was read')
        },
      },
      response: {
        header: (name: string, value: string) => {
          headers[name] = value
        },
        tooManyRequests: () => 429,
      },
    } as unknown as HttpContext
    const middleware = new LoginRateLimitMiddleware()
    for (let i = 0; i < 100; i++)
      assert.equal(
        await middleware.handle(ctx, async () => {
          authenticated++
        }),
        429
      )
    assert.equal(authenticated, 0)
    assert.equal(rateLimiter.size, before)
    assert.ok(Number(headers['Retry-After']) >= 899 && Number(headers['Retry-After']) <= 900)
  })
  test('blocked IP does not increment an existing email counter', async () => {
    checkRateLimit('login-email:synthetic:existing@example.test', 5, 900000)
    for (let i = 0; i < 30; i++) checkRateLimit('login-ip:synthetic', 30, 900000)
    const ctx = {
      request: { ip: () => 'synthetic', input: () => 'existing@example.test' },
      response: { header: () => {}, tooManyRequests: () => 429 },
    } as unknown as HttpContext
    await new LoginRateLimitMiddleware().handle(ctx, async () => {
      throw new Error('Authenticated')
    })
    assert.equal(
      checkRateLimit('login-email:synthetic:existing@example.test', 5, 900000).remaining,
      3
    )
  })
})
