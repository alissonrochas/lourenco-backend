type RateLimitEntry = {
  count: number
  expiresAt: number
}

const entries = new Map<string, RateLimitEntry>()

export function checkRateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now()
  const existing = entries.get(key)

  if (!existing || existing.expiresAt <= now) {
    entries.set(key, { count: 1, expiresAt: now + windowMs })
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: Math.ceil(windowMs / 1000) }
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.expiresAt - now) / 1000))
    return { allowed: false, remaining: 0, retryAfterSeconds }
  }

  existing.count += 1
  entries.set(key, existing)

  return {
    allowed: true,
    remaining: Math.max(0, limit - existing.count),
    retryAfterSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
  }
}

export function resetRateLimiter() {
  entries.clear()
}
