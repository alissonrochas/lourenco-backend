import { randomUUID } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'

const ids = new WeakMap<HttpContext, string>()
const codes = new Set([
  'SQLITE_ERROR',
  'SQLITE_BUSY',
  'SQLITE_BUSY_TIMEOUT',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_LOCKED',
  'SQLITE_LOCKED_SHAREDCACHE',
  'SQLITE_CONSTRAINT',
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_FOREIGNKEY',
  'SQLITE_CONSTRAINT_CHECK',
  'SQLITE_CONSTRAINT_NOTNULL',
  'E_UNABLE_TO_ACQUIRE_CONNECTION',
  'E_BAD_CSRF_TOKEN',
  'E_VALIDATION_ERROR',
  'E_ROUTE_NOT_FOUND',
  'E_UNAUTHORIZED_ACCESS',
  'E_INVALID_CREDENTIALS',
  'E_AUTHORIZATION_FAILURE',
])
export function requestId(ctx: HttpContext) {
  let id = ids.get(ctx)
  if (!id) {
    id = randomUUID()
    ids.set(ctx, id)
  }
  return id
}
export function safeError(error: unknown) {
  const value =
    error && typeof error === 'object' ? (error as { code?: unknown; status?: unknown }) : {}
  const code =
    typeof value.code === 'string' && codes.has(value.code) ? value.code : 'UNEXPECTED_ERROR'
  const status =
    typeof value.status === 'number' &&
    Number.isInteger(value.status) &&
    value.status >= 400 &&
    value.status <= 599
      ? value.status
      : 500
  return {
    type: code.startsWith('SQLITE_')
      ? 'database'
      : code === 'UNEXPECTED_ERROR'
        ? 'unexpected'
        : 'http',
    code,
    status,
  }
}
export function safeBindings(values: Record<string, unknown>) {
  // Retain only operational root bindings. Pino resets formatters on child();
  // config/logger.ts also redacts Adonis' caller-provided request_id binding.
  return typeof values.pid === 'number' ? { pid: values.pid } : {}
}
export function logHttpFailure(
  ctx: HttpContext,
  error: unknown,
  event:
    | 'http_exception'
    | 'availability_failure'
    | 'booking_failure'
    | 'admin_booking_failure' = 'http_exception'
) {
  const details = safeError(error)
  const method = ctx.request.method()
  const record = {
    event,
    failure: details,
    route: ctx.route?.pattern ?? 'unmatched',
    method: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'].includes(method)
      ? method
      : 'OTHER',
    requestId: requestId(ctx),
  }
  ctx.logger.log(details.status >= 500 ? 'error' : 'warn', record, 'HTTP request failed')
}
