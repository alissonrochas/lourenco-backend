import { createHash } from 'node:crypto'

type RateLimitEntry = { count: number; expiresAt: number }
type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number }

export const RATE_LIMITER_CAPACITY = 10_000
const SWEEP_INTERVAL_MS = 1_000

/** Fixed windows, bounded storage and no timers. Checks are synchronous per process. */
export class InMemoryRateLimiter {
  private entries = new Map<string, RateLimitEntry>()
  private nextSweepAt = 0
  private earliestExpiry = Infinity

  constructor(
    private capacity = RATE_LIMITER_CAPACITY,
    private clock: () => number = () => Date.now(),
    private sweepIntervalMs = SWEEP_INTERVAL_MS
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError('Rate limiter capacity must be a positive safe integer')
    if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 1)
      throw new RangeError('Rate limiter sweep interval must be a positive safe integer')
  }

  /** Aggregate diagnostics only: never expose keys or identities. */
  get size() {
    return this.entries.size
  }

  private sweep(now: number) {
    if (now < this.nextSweepAt) return
    this.earliestExpiry = Infinity
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
      else this.earliestExpiry = Math.min(this.earliestExpiry, entry.expiresAt)
    }
    this.nextSweepAt = now + this.sweepIntervalMs
  }

  check(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = this.clock()
    this.sweep(now)
    // Bound retained key bytes as well as entry count, even before payload validation.
    const digest = createHash('sha256').update(key).digest('hex')
    let existing = this.entries.get(digest)
    if (existing && existing.expiresAt <= now) {
      this.entries.delete(digest)
      existing = undefined
    }
    if (!existing) {
      if (this.entries.size >= this.capacity) {
        // Never evict a live counter: unknown keys fail closed until capacity returns.
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((this.earliestExpiry - now) / 1000)),
        }
      }
      this.entries.set(digest, { count: 1, expiresAt: now + windowMs })
      this.earliestExpiry = Math.min(this.earliestExpiry, now + windowMs)
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: Math.ceil(windowMs / 1000) }
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.expiresAt - now) / 1000))
    if (existing.count >= limit) return { allowed: false, remaining: 0, retryAfterSeconds }
    existing.count++
    return { allowed: true, remaining: limit - existing.count, retryAfterSeconds }
  }

  reset() {
    this.entries.clear()
    this.nextSweepAt = 0
    this.earliestExpiry = Infinity
  }
}

export const rateLimiter = new InMemoryRateLimiter()

export function checkRateLimit(key: string, limit: number, windowMs: number) {
  return rateLimiter.check(key, limit, windowMs)
}

export function resetRateLimiter() {
  rateLimiter.reset()
}
