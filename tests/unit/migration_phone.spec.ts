import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { Database } from '@adonisjs/lucid/database'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import emitter from '@adonisjs/core/services/emitter'
import { getPhoneNormalizationAssignments } from '#database/migrations/1795452000000_add_normalized_phone_to_customers'

async function createTemporaryCustomersDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'lourenco-phone-migration-'))
  const migrationsDirectory = join(directory, 'migrations')
  mkdirSync(migrationsDirectory)
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
  // The runner discovers this entrypoint, which imports the actual project migration.
  const migrationUrl = import.meta
    .resolve('#database/migrations/1795452000000_add_normalized_phone_to_customers')
  writeFileSync(
    join(migrationsDirectory, '1795452000000_add_normalized_phone_to_customers.js'),
    `export { default } from ${JSON.stringify(migrationUrl)}\n`
  )

  // A separate Database instance never registers or uses the development connection.
  const database = new Database(
    {
      connection: 'migration_test',
      connections: {
        migration_test: {
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

  try {
    // Only the legacy table is a fixture. The real migration creates the new column/index.
    await client.schema.createTable('customers', (table) => {
      table.increments('id')
      table.string('name').notNullable()
      table.string('phone').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
    })
  } catch (error) {
    await cleanup()
    throw error
  }

  return {
    client,
    cleanup,
    async migrate(direction: 'up' | 'down') {
      const runner = new MigrationRunner(database, app, { direction })
      await runner.run()
      assert.ifError(runner.error)
      assert.equal(runner.status, 'completed')
      assert.equal(Object.keys(runner.migratedFiles).length, 1)
      assert.equal(Object.values(runner.migratedFiles)[0].status, 'completed')
    },
  }
}

const legacyCustomers = [
  {
    id: 1,
    name: 'Cliente Um',
    phone: '(11) 99999-1234',
    created_at: '2026-11-24',
    updated_at: null,
  },
  {
    id: 2,
    name: 'Cliente Dois',
    phone: '11999991234',
    created_at: '2026-11-24',
    updated_at: null,
  },
  {
    id: 3,
    name: 'Inválido',
    phone: '---',
    created_at: '2026-11-24',
    updated_at: null,
  },
  {
    id: 4,
    name: 'Cliente Três',
    phone: '(21) 98888-7777',
    created_at: '2026-11-24',
    updated_at: null,
  },
  {
    id: 5,
    name: 'Curto',
    phone: '123',
    created_at: '2026-11-24',
    updated_at: null,
  },
  {
    id: 6,
    name: 'Longo',
    phone: '1234567890123456',
    created_at: '2026-11-24',
    updated_at: null,
  },
]

test.group('normalized customer phone migration', () => {
  test('it identifies equivalent, invalid and duplicate old phones', () => {
    assert.deepEqual(getPhoneNormalizationAssignments(legacyCustomers), [
      { id: 1, phoneNormalized: '11999991234' },
      { id: 4, phoneNormalized: '21988887777' },
    ])
  })

  test('it runs the real migration and preserves legacy clients and their original data', async () => {
    const temporary = await createTemporaryCustomersDatabase()

    try {
      await temporary.client.table('customers').insert(legacyCustomers)
      assert.equal(await temporary.client.schema.hasColumn('customers', 'phone_normalized'), false)

      await temporary.migrate('up')

      const rows = await temporary.client.from('customers').select('*').orderBy('id', 'asc')
      assert.deepEqual(
        rows,
        legacyCustomers.map((customer) => ({
          ...customer,
          phone_normalized:
            customer.id === 1 ? '11999991234' : customer.id === 4 ? '21988887777' : null,
        }))
      )
      const migrationRecords = await temporary.client.from('adonis_schema').select('*')
      assert.equal(migrationRecords.length, 1)
    } finally {
      await temporary.cleanup()
    }
  })

  test('it rolls the real migration back without losing clients and can apply it again', async () => {
    const temporary = await createTemporaryCustomersDatabase()

    try {
      await temporary.client.table('customers').insert(legacyCustomers)
      await temporary.migrate('up')
      assert.equal(await temporary.client.schema.hasColumn('customers', 'phone_normalized'), true)

      await temporary.migrate('down')

      assert.equal(await temporary.client.schema.hasColumn('customers', 'phone_normalized'), false)
      assert.deepEqual(
        await temporary.client.from('customers').select('*').orderBy('id', 'asc'),
        legacyCustomers
      )
      assert.deepEqual(await temporary.client.from('adonis_schema').select('*'), [])
      await temporary.migrate('up')
      const customer = await temporary.client.from('customers').where('id', 1).first()
      assert.equal(customer.phone_normalized, '11999991234')
    } finally {
      await temporary.cleanup()
    }
  })

  test('the index created by the real migration rejects new normalized duplicates', async () => {
    const temporary = await createTemporaryCustomersDatabase()

    try {
      await temporary.client.table('customers').insert(legacyCustomers)
      await temporary.migrate('up')

      await assert.rejects(
        () =>
          temporary.client
            .table('customers')
            .insert({
              name: 'Duplicado',
              phone: '(11) 99999-1234',
              phone_normalized: '11999991234',
              created_at: '2026-11-24',
            })
            .exec(),
        { code: 'SQLITE_CONSTRAINT_UNIQUE' }
      )
      await temporary.client.table('customers').insert({
        name: 'Novo cliente',
        phone: '31977776666',
        phone_normalized: '31977776666',
        created_at: '2026-11-24',
      })
      const customers = await temporary.client.from('customers').select('id')
      assert.equal(customers.length, 7)
    } finally {
      await temporary.cleanup()
    }
  })
})
