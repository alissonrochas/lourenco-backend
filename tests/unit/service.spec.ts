import assert from 'node:assert/strict'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import Service from '#models/service'
import { createServicesDatabase } from '#tests/helpers/services_database'

function serviceRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Corte',
    price_cents: 4500,
    duration_minutes: 45,
    created_at: '2026-11-25 00:00:00',
    ...overrides,
  }
}

test.group('services migration', () => {
  test('it applies and reverses the real migration without changing existing tables or data', async () => {
    const temporary = await createServicesDatabase()
    try {
      const original = await temporary.existingState()
      assert.equal(await temporary.client.schema.hasTable('services'), false)
      await temporary.up()
      assert.equal(await temporary.client.schema.hasTable('services'), true)
      assert.deepEqual(await temporary.existingState(), original)
      await temporary.client.table('services').insert(serviceRow())
      await temporary.down()
      assert.equal(await temporary.client.schema.hasTable('services'), false)
      assert.deepEqual(await temporary.existingState(), original)
      await temporary.up()
      const services = await temporary.client.from('services').select('*')
      assert.deepEqual(services, [])
      assert.deepEqual(await temporary.existingState(), original)
    } finally {
      await temporary.cleanup()
    }
  })

  test('it creates the primary key, required columns, optional description and active default', async () => {
    const temporary = await createServicesDatabase()
    try {
      await temporary.up()
      const columns = await temporary.client.rawQuery('PRAGMA table_info(services)')
      assert.deepEqual(
        columns.map((column: { name: string }) => column.name),
        [
          'id',
          'name',
          'description',
          'price_cents',
          'duration_minutes',
          'is_active',
          'created_at',
          'updated_at',
        ]
      )
      assert.equal(columns.find((column: { name: string }) => column.name === 'id').pk, 1)
      await temporary.client.table('services').insert(serviceRow())
      const row = await temporary.client.from('services').first()
      assert.equal(typeof row.id, 'number')
      assert.equal(row.is_active, 1)
      assert.equal(row.description, null)
      assert.equal(row.updated_at, null)
    } finally {
      await temporary.cleanup()
    }
  })

  test('it enforces nonnegative safe integer prices on insert and update at the database level', async () => {
    const temporary = await createServicesDatabase()
    try {
      await temporary.up()
      for (const price of [-1, 12.5, 'invalid', null, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(
          () =>
            temporary.client
              .table('services')
              .insert(serviceRow({ price_cents: price }))
              .exec(),
          /constraint/i
        )
      }
      for (const price of [0, 4500, Number.MAX_SAFE_INTEGER]) {
        await temporary.client.table('services').insert(serviceRow({ price_cents: price }))
      }
      const services = await temporary.client.from('services').select('*').orderBy('id', 'asc')
      assert.deepEqual(
        services.map((row) => row.price_cents),
        [0, 4500, Number.MAX_SAFE_INTEGER]
      )
      await assert.rejects(
        () =>
          temporary.client
            .from('services')
            .where('id', services[0].id)
            .update({ price_cents: -1 })
            .exec(),
        /constraint/i
      )
      const unchanged = await temporary.client.from('services').where('id', services[0].id).first()
      assert.equal(unchanged.price_cents, 0)
    } finally {
      await temporary.cleanup()
    }
  })

  test('it accepts durations 5 through 480 including 45 minutes and rejects other stored values', async () => {
    const temporary = await createServicesDatabase()
    try {
      await temporary.up()
      for (const duration of [0, 4, 481, 5.5, 'invalid', null]) {
        await assert.rejects(
          () =>
            temporary.client
              .table('services')
              .insert(serviceRow({ duration_minutes: duration }))
              .exec(),
          /constraint/i
        )
      }
      for (const duration of [5, 45, 480]) {
        await temporary.client.table('services').insert(serviceRow({ duration_minutes: duration }))
      }
      const services = await temporary.client.from('services').select('*').orderBy('id', 'asc')
      assert.deepEqual(
        services.map((row) => row.duration_minutes),
        [5, 45, 480]
      )
      await assert.rejects(
        () =>
          temporary.client
            .from('services')
            .where('id', services[0].id)
            .update({ duration_minutes: 481 })
            .exec(),
        /constraint/i
      )
    } finally {
      await temporary.cleanup()
    }
  })

  test('it enforces nonempty names, required timestamps and boolean status values', async () => {
    const temporary = await createServicesDatabase()
    try {
      await temporary.up()
      for (const name of [null, '', '   ']) {
        await assert.rejects(
          () => temporary.client.table('services').insert(serviceRow({ name })).exec(),
          /constraint/i
        )
      }
      for (const isActive of [2, -1, 0.5, 'true', null]) {
        await assert.rejects(
          () =>
            temporary.client
              .table('services')
              .insert(serviceRow({ is_active: isActive }))
              .exec(),
          /constraint/i
        )
      }
      await assert.rejects(
        () =>
          temporary.client
            .table('services')
            .insert(serviceRow({ created_at: null }))
            .exec(),
        /constraint/i
      )
      // Neither names nor descriptions introduce uniqueness rules in this phase.
      await temporary.client
        .table('services')
        .insert(serviceRow({ description: 'Corte com tesoura', is_active: 0 }))
      await temporary.client
        .table('services')
        .insert(serviceRow({ description: null, is_active: 1 }))
      const services = await temporary.client.from('services').select('*').orderBy('id', 'asc')
      assert.deepEqual(
        services.map((row) => row.is_active),
        [0, 1]
      )
      assert.equal(services[0].description, 'Corte com tesoura')
    } finally {
      await temporary.cleanup()
    }
  })
})

test.group('Service model', () => {
  test('it maps camelCase fields, nullable description, default status and automatic timestamps', async () => {
    const temporary = await createServicesDatabase()
    try {
      await temporary.up()
      // Lucid binds instance operations to an explicit transaction client.
      const transaction = await temporary.client.transaction()
      try {
        const service = await Service.create(
          { name: 'Corte', priceCents: 4500, durationMinutes: 45 },
          { client: transaction }
        )
        await service.refresh()
        assert.ok(service.id > 0)
        assert.equal(service.description, null)
        assert.equal(service.isActive, true)
        assert.ok(DateTime.isDateTime(service.createdAt) && service.createdAt.isValid)
        assert.ok(DateTime.isDateTime(service.updatedAt) && service.updatedAt.isValid)
        const row = await transaction.from('services').where('id', service.id).first()
        assert.equal(row.price_cents, 4500)
        assert.equal(row.duration_minutes, 45)
        assert.equal(row.is_active, 1)
        const serialized = service.serialize()
        assert.deepEqual(
          Object.keys(serialized).sort(),
          [
            'id',
            'name',
            'description',
            'priceCents',
            'durationMinutes',
            'isActive',
            'createdAt',
            'updatedAt',
          ].sort()
        )
        assert.equal(serialized.isActive, true)
        assert.equal(serialized.priceCents, 4500)
      } finally {
        await transaction.rollback()
      }
    } finally {
      await temporary.cleanup()
    }
  })

  test('it persists edits and deactivation, preserving createdAt and updating updatedAt', async () => {
    const temporary = await createServicesDatabase()
    try {
      await temporary.up()
      const transaction = await temporary.client.transaction()
      try {
        const service = await Service.create(
          {
            name: 'Corte',
            description: 'Original',
            priceCents: 4500,
            durationMinutes: 45,
            isActive: true,
          },
          { client: transaction }
        )
        await transaction
          .from('services')
          .where('id', service.id)
          .update({ updated_at: '2000-01-01 00:00:00' })
        await service.refresh()
        const createdAt = service.createdAt.toISO()
        const previousUpdate = service.updatedAt!.toMillis()
        service.merge({
          name: 'Corte e barba',
          description: 'Atualizado',
          priceCents: 7000,
          durationMinutes: 60,
          isActive: false,
        })
        await service.save()
        const reloaded = await Service.findOrFail(service.id, { client: transaction })
        assert.equal(reloaded.name, 'Corte e barba')
        assert.equal(reloaded.description, 'Atualizado')
        assert.equal(reloaded.priceCents, 7000)
        assert.equal(reloaded.durationMinutes, 60)
        assert.equal(reloaded.isActive, false)
        assert.equal(reloaded.createdAt.toISO(), createdAt)
        assert.ok(reloaded.updatedAt!.toMillis() > previousUpdate)
        const row = await transaction.from('services').where('id', service.id).first()
        assert.equal(row.is_active, 0)
        service.isActive = true
        await service.save()
        await service.refresh()
        assert.equal(service.isActive, true)
      } finally {
        await transaction.rollback()
      }
    } finally {
      await temporary.cleanup()
    }
  })

  test('it preserves database constraints when values are written through the model', async () => {
    const temporary = await createServicesDatabase()
    try {
      await temporary.up()
      const transaction = await temporary.client.transaction()
      try {
        await assert.rejects(
          () =>
            Service.create(
              { name: 'Inválido', priceCents: -1, durationMinutes: 30 },
              { client: transaction }
            ),
          /constraint/i
        )
        await assert.rejects(
          () =>
            Service.create(
              { name: 'Inválido', priceCents: 4500, durationMinutes: 4 },
              { client: transaction }
            ),
          /constraint/i
        )
        const freeService = await Service.create(
          { name: 'Gratuito', priceCents: 0, durationMinutes: 5 },
          { client: transaction }
        )
        await freeService.refresh()
        assert.equal(freeService.priceCents, 0)
        assert.equal(freeService.durationMinutes, 5)
      } finally {
        await transaction.rollback()
      }
    } finally {
      await temporary.cleanup()
    }
  })
})
