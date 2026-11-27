import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { LoggerFactory } from '@adonisjs/logger/factories'
import type { LoggerConfig } from '@adonisjs/logger/types'
import { safeError } from '#services/safe_http_logging'

test('configured logger sanitizes raw errors and removes request data and child bindings', () => {
  const marker = 'R09_SECRET_SYNTHETIC'
  const logs: string[] = []
  const config = app.config.get<LoggerConfig>('logger.loggers.app')
  const logger = new LoggerFactory()
    .merge({ ...config, enabled: true, transport: undefined, destination: undefined })
    .pushLogsTo(logs)
    .create()
  const error = Object.assign(new Error(`SQL query phone ${marker}`), {
    code: 'SQLITE_CONSTRAINT_UNIQUE',
    bindings: [marker],
    sql: marker,
    cause: new Error(marker),
  })
  logger.child({ request_id: marker, email: marker }).error(
    {
      err: error,
      error,
      request: { body: marker },
      headers: { cookie: marker },
      body: marker,
      password: marker,
      token: marker,
      phone: marker,
      email: marker,
      sql: marker,
      bindings: [marker],
    },
    'Safe fixed event'
  )
  assert.equal(logs.length, 1)
  assert.ok(!logs[0].includes(marker))
  const record = JSON.parse(logs[0])
  assert.deepEqual(record.err, { type: 'database', code: 'SQLITE_CONSTRAINT_UNIQUE', status: 500 })
  assert.equal(record.msg, 'Safe fixed event')
})

test('safe exception metadata uses exact code and status allowlists', () => {
  assert.deepEqual(
    safeError({
      code: 'SQLITE_ERROR_private-input',
      status: 999,
      message: 'secret',
      name: 'secret',
    }),
    { type: 'unexpected', code: 'UNEXPECTED_ERROR', status: 500 }
  )
  assert.deepEqual(safeError({ code: 'E_BAD_CSRF_TOKEN', status: 403 }), {
    type: 'http',
    code: 'E_BAD_CSRF_TOKEN',
    status: 403,
  })
  assert.deepEqual(safeError(null), { type: 'unexpected', code: 'UNEXPECTED_ERROR', status: 500 })
})
