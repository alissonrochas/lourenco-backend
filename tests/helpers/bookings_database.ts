import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '@adonisjs/lucid/database'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import emitter from '@adonisjs/core/services/emitter'

const existingMigrations = [
  '1732333200000_create_customers_table',
  '1761885935168_create_users_table',
  '1763400000000_add_role_to_users',
  '1794952394110_create_sessions_table',
  '1795452000000_add_normalized_phone_to_customers',
  '1795564800000_create_services_table',
  '1795651200000_create_booking_schedule_tables',
  '1795737600000_create_calendar_exception_tables',
]
const bookingsMigration = '1795824000000_create_bookings_table'

export async function createBookingsDatabase(connectionName = 'bookings_test') {
  const directory = mkdtempSync(join(tmpdir(), 'lourenco-bookings-'))
  const migrationsDirectory = join(directory, 'migrations')
  mkdirSync(migrationsDirectory)
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))

  function exposeMigration(name: string) {
    const url = import.meta.resolve(`#database/migrations/${name}`)
    writeFileSync(
      join(migrationsDirectory, `${name}.js`),
      `export { default } from ${JSON.stringify(url)}\n`
    )
  }

  for (const migration of existingMigrations) exposeMigration(migration)

  // No connection from the application's database manager is registered or changed.
  const database = new Database(
    {
      connection: connectionName,
      connections: {
        [connectionName]: {
          client: 'better-sqlite3',
          connection: { filename: join(directory, 'test.sqlite3') },
          useNullAsDefault: true,
          migrations: { paths: [migrationsDirectory], naturalSort: true },
          schemaGeneration: { enabled: false },
        },
      },
    },
    logger,
    emitter
  )
  const client = database.connection()
  const cleanup = async () => {
    await database.manager.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }

  async function migrate(direction: 'up' | 'down', expectedFiles: number) {
    const runner = new MigrationRunner(
      database,
      app,
      direction === 'down' ? { direction, step: 1 } : { direction }
    )
    await runner.run()
    assert.ifError(runner.error)
    assert.equal(runner.status, 'completed')
    assert.equal(Object.keys(runner.migratedFiles).length, expectedFiles)
    for (const migration of Object.values(runner.migratedFiles)) {
      assert.equal(migration.status, 'completed')
    }
  }

  try {
    await migrate('up', existingMigrations.length)
    const pragma = await client.rawQuery('PRAGMA foreign_keys')
    assert.equal(pragma[0].foreign_keys, 1)
    const createdAt = '2026-11-25 00:00:00'
    await client.table('customers').insert({
      id: 1,
      name: 'Cliente de teste',
      phone: '71988880000',
      phone_normalized: '71988880000',
      created_at: createdAt,
      updated_at: null,
    })
    await client.table('users').insert({
      id: 1,
      full_name: 'Administrador de teste',
      email: 'services-migration@example.test',
      password: 'test-only-not-a-real-password',
      role: 'admin',
      created_at: createdAt,
      updated_at: null,
    })
    await client.table('sessions').insert({
      id: 'services-test-session',
      data: '{}',
      user_id: '1',
      expires_at: '2030-01-01 00:00:00',
    })
    await client.table('services').insert({
      id: 1,
      name: 'Corte preservado',
      price_cents: 4500,
      duration_minutes: 45,
      is_active: 1,
      created_at: createdAt,
      updated_at: null,
    })
    await client.table('booking_settings').insert({ created_at: createdAt })
    await client.table('weekly_opening_hours').insert({
      id: 1,
      weekday: 1,
      is_active: 1,
      opens_at_minute: 540,
      closes_at_minute: 1080,
      created_at: createdAt,
    })
    await client.table('weekly_breaks').insert({
      weekly_opening_hour_id: 1,
      starts_at_minute: 720,
      ends_at_minute: 780,
      created_at: createdAt,
    })
    await client
      .table('weekly_slot_blocks')
      .insert({ weekly_opening_hour_id: 1, starts_at_minute: 600, created_at: createdAt })
    await client
      .table('date_blocks')
      .insert({ local_date: '2026-12-25', reason: 'Feriado de teste', created_at: createdAt })
    await client
      .table('date_slot_blocks')
      .insert({ local_date: '2026-12-28', starts_at_minute: 900, created_at: createdAt })
    // Only now make the additive migration discoverable, as a separate batch.
    exposeMigration(bookingsMigration)
  } catch (error) {
    await cleanup()
    throw error
  }

  return {
    client,
    cleanup,
    up: () => migrate('up', 1),
    down: () => migrate('down', 1),
    async existingState() {
      const tables = [
        'customers',
        'users',
        'sessions',
        'services',
        'booking_settings',
        'weekly_opening_hours',
        'weekly_breaks',
        'weekly_slot_blocks',
        'date_blocks',
        'date_slot_blocks',
      ]
      return {
        rows: await Promise.all(
          tables.map((table) => client.from(table).select('*').orderBy('id', 'asc'))
        ),
        schema: await client
          .from('sqlite_master')
          .select('type', 'name', 'tbl_name', 'sql')
          .whereIn('tbl_name', tables)
          .orderBy('name', 'asc'),
      }
    },
  }
}
