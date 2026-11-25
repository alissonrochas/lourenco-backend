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
]
const servicesMigration = '1795564800000_create_services_table'

export async function createServicesDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'lourenco-services-'))
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
      connection: 'services_test',
      connections: {
        services_test: {
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
    // Only now make the additive migration discoverable, as a separate batch.
    exposeMigration(servicesMigration)
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
      const tables = ['customers', 'users', 'sessions']
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
