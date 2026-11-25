import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import BookingSetting from '#models/booking_setting'
import WeeklyOpeningHour from '#models/weekly_opening_hour'
import WeeklyBreak from '#models/weekly_break'
import WeeklySlotBlock from '#models/weekly_slot_block'
import { createScheduleDatabase } from '#tests/helpers/schedule_database'

type TemporaryDatabase = Awaited<ReturnType<typeof createScheduleDatabase>>
const timestamp = '2026-11-25 00:00:00'
const tables = ['booking_settings', 'weekly_opening_hours', 'weekly_breaks', 'weekly_slot_blocks']
const dayRow = (overrides: Record<string, unknown> = {}) => ({
  weekday: 1,
  is_active: 1,
  opens_at_minute: 540,
  closes_at_minute: 1080,
  created_at: timestamp,
  ...overrides,
})
const breakRow = (id: number, overrides: Record<string, unknown> = {}) => ({
  weekly_opening_hour_id: id,
  starts_at_minute: 720,
  ends_at_minute: 780,
  created_at: timestamp,
  ...overrides,
})
const blockRow = (id: number, overrides: Record<string, unknown> = {}) => ({
  weekly_opening_hour_id: id,
  starts_at_minute: 900,
  created_at: timestamp,
  ...overrides,
})

async function withDatabase(run: (temporary: TemporaryDatabase) => Promise<void>) {
  const temporary = await createScheduleDatabase()
  try {
    await temporary.up()
    await run(temporary)
  } finally {
    await temporary.cleanup()
  }
}

async function insertDay(temporary: TemporaryDatabase) {
  const [id] = await temporary.client.table('weekly_opening_hours').insert(dayRow())
  return id as number
}

async function rejectInsert(
  temporary: TemporaryDatabase,
  table: string,
  row: Record<string, unknown>
) {
  await assert.rejects(
    () => temporary.client.table(table).insert(row).exec(),
    /constraint|datatype mismatch/i
  )
}

test.group('booking schedule migration integrity', () => {
  test('real migration applies, rolls back and reapplies while preserving prior tables and data', async () => {
    const temporary = await createScheduleDatabase()
    try {
      const before = await temporary.existingState()
      for (const table of tables) assert.equal(await temporary.client.schema.hasTable(table), false)
      await temporary.up()
      for (const table of tables) {
        assert.equal(await temporary.client.schema.hasTable(table), true)
        assert.deepEqual(await temporary.client.from(table).select('*'), [])
      }
      await temporary.client.table('booking_settings').insert({ created_at: timestamp })
      const id = await insertDay(temporary)
      await temporary.client.table('weekly_breaks').insert(breakRow(id))
      await temporary.client.table('weekly_slot_blocks').insert(blockRow(id))
      assert.deepEqual(await temporary.existingState(), before)
      await temporary.down()
      for (const table of tables) assert.equal(await temporary.client.schema.hasTable(table), false)
      assert.deepEqual(await temporary.existingState(), before)
      await temporary.up()
      for (const table of tables)
        assert.deepEqual(await temporary.client.from(table).select('*'), [])
      assert.deepEqual(await temporary.existingState(), before)
    } finally {
      await temporary.cleanup()
    }
  })

  test('global settings default deterministically and cannot contain a second agenda', async () => {
    await withDatabase(async (temporary) => {
      await temporary.client.table('booking_settings').insert({ created_at: timestamp })
      const row = await temporary.client.from('booking_settings').first()
      assert.equal(row.id, 1)
      assert.equal(row.timezone, 'America/Sao_Paulo')
      assert.equal(row.slot_duration_minutes, 60)
      for (const id of [1, 2, 0, -1, 1.5]) {
        await rejectInsert(temporary, 'booking_settings', { id, created_at: timestamp })
      }
      await assert.rejects(
        () => temporary.client.from('booking_settings').update({ id: 2 }).exec(),
        /constraint/i
      )
    })
  })

  test('timezone and slot duration constraints reject inserts and updates outside the MVP', async () => {
    await withDatabase(async (temporary) => {
      for (const timezone of ['UTC', 'America/Bahia', '', null]) {
        await rejectInsert(temporary, 'booking_settings', { timezone, created_at: timestamp })
      }
      for (const duration of [0, 30, 90, 60.5, 'invalid', null]) {
        await rejectInsert(temporary, 'booking_settings', {
          slot_duration_minutes: duration,
          created_at: timestamp,
        })
      }
      await temporary.client.table('booking_settings').insert({ created_at: timestamp })
      for (const patch of [{ timezone: 'UTC' }, { slot_duration_minutes: 30 }]) {
        await assert.rejects(
          () => temporary.client.from('booking_settings').update(patch).exec(),
          /constraint/i
        )
      }
    })
  })

  test('weekdays accept ISO 1 through 7 and reject duplicates and invalid values', async () => {
    await withDatabase(async (temporary) => {
      for (const weekday of [0, 8, 1.5, 'invalid', null]) {
        await rejectInsert(temporary, 'weekly_opening_hours', dayRow({ weekday }))
      }
      for (let weekday = 1; weekday <= 7; weekday++) {
        await temporary.client.table('weekly_opening_hours').insert(dayRow({ weekday }))
        await rejectInsert(temporary, 'weekly_opening_hours', dayRow({ weekday }))
      }
      const rows = await temporary.client.from('weekly_opening_hours').orderBy('weekday', 'asc')
      assert.deepEqual(
        rows.map((row) => row.weekday),
        [1, 2, 3, 4, 5, 6, 7]
      )
    })
  })

  test('inactive days may omit both times but cannot become active until configured', async () => {
    await withDatabase(async (temporary) => {
      const [id] = await temporary.client
        .table('weekly_opening_hours')
        .insert({ weekday: 1, created_at: timestamp })
      const day = await temporary.client.from('weekly_opening_hours').where('id', id).first()
      assert.equal(day.is_active, 0)
      assert.equal(day.opens_at_minute, null)
      assert.equal(day.closes_at_minute, null)
      await assert.rejects(
        () =>
          temporary.client
            .from('weekly_opening_hours')
            .where('id', id)
            .update({ is_active: 1 })
            .exec(),
        /constraint/i
      )
      await temporary.client
        .from('weekly_opening_hours')
        .where('id', id)
        .update({ is_active: 1, opens_at_minute: 0, closes_at_minute: 1440 })
      await temporary.client.from('weekly_opening_hours').where('id', id).update({ is_active: 0 })
      const closed = await temporary.client.from('weekly_opening_hours').where('id', id).first()
      assert.equal(closed.opens_at_minute, 0)
      assert.equal(closed.closes_at_minute, 1440)
    })
  })

  test('opening hours reject null pairs, reversed times, out-of-day values and non-hour boundaries', async () => {
    await withDatabase(async (temporary) => {
      for (const patch of [
        { opens_at_minute: null },
        { closes_at_minute: null },
        { opens_at_minute: null, closes_at_minute: null },
        { opens_at_minute: 1080, closes_at_minute: 540 },
        { opens_at_minute: 540, closes_at_minute: 540 },
        { opens_at_minute: -60 },
        { closes_at_minute: 1500 },
        { opens_at_minute: 1440 },
        { closes_at_minute: 0 },
        { opens_at_minute: 541 },
        { closes_at_minute: 1081 },
        { opens_at_minute: 540.5 },
        { closes_at_minute: 'invalid' },
        { is_active: 0, opens_at_minute: null },
      ])
        await rejectInsert(temporary, 'weekly_opening_hours', dayRow(patch))
      await temporary.client
        .table('weekly_opening_hours')
        .insert(dayRow({ opens_at_minute: 1380, closes_at_minute: 1440 }))
      await assert.rejects(
        () =>
          temporary.client.from('weekly_opening_hours').update({ closes_at_minute: 1439 }).exec(),
        /constraint/i
      )
    })
  })

  test('multiple recurring breaks persist for one day with an indexed foreign key', async () => {
    await withDatabase(async (temporary) => {
      const id = await insertDay(temporary)
      await temporary.client
        .table('weekly_breaks')
        .insert([
          breakRow(id, { is_active: 1 }),
          breakRow(id, { starts_at_minute: 900, ends_at_minute: 960, is_active: 0 }),
        ])
      const rows = await temporary.client.from('weekly_breaks').orderBy('starts_at_minute', 'asc')
      assert.deepEqual(
        rows.map((row) => [row.starts_at_minute, row.ends_at_minute, row.is_active]),
        [
          [720, 780, 1],
          [900, 960, 0],
        ]
      )
      const indexes = await temporary.client.rawQuery('PRAGMA index_list(weekly_breaks)')
      assert.ok(
        indexes.some((index: { name: string }) => index.name.includes('weekly_opening_hour_id'))
      )
    })
  })

  test('breaks reject invalid boundaries, fractions and nulls even when inactive', async () => {
    await withDatabase(async (temporary) => {
      const id = await insertDay(temporary)
      for (const patch of [
        { starts_at_minute: -60 },
        { ends_at_minute: 1500 },
        { starts_at_minute: 1440 },
        { starts_at_minute: 780 },
        { ends_at_minute: 720 },
        { ends_at_minute: 0 },
        { starts_at_minute: 721 },
        { ends_at_minute: 781 },
        { starts_at_minute: 720.5 },
        { starts_at_minute: null },
        { ends_at_minute: null },
        { ends_at_minute: 'invalid' },
        { is_active: 0, ends_at_minute: 720 },
      ])
        await rejectInsert(temporary, 'weekly_breaks', breakRow(id, patch))
      await temporary.client
        .table('weekly_breaks')
        .insert(breakRow(id, { starts_at_minute: 0, ends_at_minute: 1440 }))
      await assert.rejects(
        () => temporary.client.from('weekly_breaks').update({ ends_at_minute: 1439 }).exec(),
        /constraint/i
      )
    })
  })

  test('slot blocks are unique by day and hour but the same hour may exist on different days', async () => {
    await withDatabase(async (temporary) => {
      const id = await insertDay(temporary)
      const [other] = await temporary.client
        .table('weekly_opening_hours')
        .insert(dayRow({ weekday: 2 }))
      await temporary.client.table('weekly_slot_blocks').insert(blockRow(id))
      await rejectInsert(temporary, 'weekly_slot_blocks', blockRow(id))
      await temporary.client.table('weekly_slot_blocks').insert(blockRow(other as number))
      await temporary.client
        .table('weekly_slot_blocks')
        .insert(blockRow(id, { starts_at_minute: 960 }))
      await assert.rejects(
        () =>
          temporary.client
            .from('weekly_slot_blocks')
            .where('weekly_opening_hour_id', id)
            .where('starts_at_minute', 960)
            .update({ starts_at_minute: 900 })
            .exec(),
        /constraint/i
      )
      const rows = await temporary.client.from('weekly_slot_blocks').select('*')
      assert.equal(rows.length, 3)
      assert.equal(rows[0].is_blocked, 1)
    })
  })

  test('slot blocks accept midnight and 23:00 but reject 24:00 and non-hour values', async () => {
    await withDatabase(async (temporary) => {
      const id = await insertDay(temporary)
      for (const starts of [-60, 1440, 1500, 1, 61, 60.5, 'invalid', null]) {
        await rejectInsert(
          temporary,
          'weekly_slot_blocks',
          blockRow(id, { starts_at_minute: starts })
        )
      }
      for (const starts of [0, 1380]) {
        await temporary.client
          .table('weekly_slot_blocks')
          .insert(blockRow(id, { starts_at_minute: starts }))
      }
      await assert.rejects(
        () => temporary.client.from('weekly_slot_blocks').update({ starts_at_minute: -60 }).exec(),
        /constraint/i
      )
    })
  })

  test('every stored status is restricted to the SQLite boolean domain', async () => {
    await withDatabase(async (temporary) => {
      const id = await insertDay(temporary)
      for (const value of [-1, 2, 0.5, 'true', null]) {
        await rejectInsert(
          temporary,
          'weekly_opening_hours',
          dayRow({ weekday: 2, is_active: value })
        )
        await rejectInsert(temporary, 'weekly_breaks', breakRow(id, { is_active: value }))
        await rejectInsert(temporary, 'weekly_slot_blocks', blockRow(id, { is_blocked: value }))
      }
    })
  })

  test('foreign keys reject orphaned children, reparenting and destructive parent changes', async () => {
    await withDatabase(async (temporary) => {
      const pragma = await temporary.client.rawQuery('PRAGMA foreign_keys')
      assert.equal(pragma[0].foreign_keys, 1)
      const id = await insertDay(temporary)
      for (const table of ['weekly_breaks', 'weekly_slot_blocks']) {
        const row = table === 'weekly_breaks' ? breakRow : blockRow
        await rejectInsert(temporary, table, row(999999))
        await rejectInsert(temporary, table, row(id, { weekly_opening_hour_id: null }))
        await temporary.client.table(table).insert(row(id))
        await assert.rejects(
          () => temporary.client.from(table).update({ weekly_opening_hour_id: 999999 }).exec(),
          /foreign key/i
        )
      }
      await assert.rejects(
        () => temporary.client.from('weekly_opening_hours').where('id', id).delete().exec(),
        /foreign key/i
      )
      await assert.rejects(
        () =>
          temporary.client
            .from('weekly_opening_hours')
            .where('id', id)
            .update({ id: 999999 })
            .exec(),
        /foreign key/i
      )
      assert.deepEqual(await temporary.client.rawQuery('PRAGMA foreign_key_check'), [])
    })
  })

  test('required creation timestamps are enforced on all four tables', async () => {
    await withDatabase(async (temporary) => {
      const id = await insertDay(temporary)
      await rejectInsert(temporary, 'booking_settings', { created_at: null })
      await rejectInsert(
        temporary,
        'weekly_opening_hours',
        dayRow({ weekday: 2, created_at: null })
      )
      await rejectInsert(temporary, 'weekly_breaks', breakRow(id, { created_at: null }))
      await rejectInsert(temporary, 'weekly_slot_blocks', blockRow(id, { created_at: null }))
    })
  })
})

test.group('booking schedule Lucid models', () => {
  test('settings map fixed defaults, create timestamps and reject rule changes through the model', async () => {
    await withDatabase(async (temporary) => {
      const trx = await temporary.client.transaction()
      try {
        const settings = await BookingSetting.create({ id: 1 }, { client: trx })
        await settings.refresh()
        assert.equal(settings.timezone, 'America/Sao_Paulo')
        assert.equal(settings.slotDurationMinutes, 60)
        assert.ok(DateTime.isDateTime(settings.createdAt) && settings.createdAt.isValid)
        assert.ok(DateTime.isDateTime(settings.updatedAt) && settings.updatedAt.isValid)
        const read = await BookingSetting.findOrFail(1, { client: trx })
        assert.equal(read.slotDurationMinutes, 60)
        const row = await trx.from('booking_settings').first()
        assert.equal(row.slot_duration_minutes, 60)
        assert.equal('slotDurationMinutes' in row, false)
        assert.equal(settings.serialize().slotDurationMinutes, 60)
        await assert.rejects(() => BookingSetting.create({ id: 2 }, { client: trx }), /constraint/i)
        settings.timezone = 'UTC'
        await assert.rejects(() => settings.save(), /constraint/i)
        await settings.refresh()
        settings.slotDurationMinutes = 30
        await assert.rejects(() => settings.save(), /constraint/i)
        await settings.refresh()
        assert.equal(settings.timezone, 'America/Sao_Paulo')
        assert.equal(settings.slotDurationMinutes, 60)
      } finally {
        await trx.rollback()
      }
    })
  })

  test('weekly models map columns and relations and persist activation and release without deleting rows', async () => {
    await withDatabase(async (temporary) => {
      const trx = await temporary.client.transaction()
      try {
        const day = await WeeklyOpeningHour.create(
          { weekday: 1, isActive: true, opensAtMinute: 540, closesAtMinute: 1080 },
          { client: trx }
        )
        const first = await day.related('breaks').create({ startsAtMinute: 720, endsAtMinute: 780 })
        const second = await day
          .related('breaks')
          .create({ startsAtMinute: 900, endsAtMinute: 960, isActive: false })
        const block = await day.related('slotBlocks').create({ startsAtMinute: 600 })
        await day.refresh()
        await first.refresh()
        await block.refresh()
        assert.equal(first.weeklyOpeningHourId, day.id)
        assert.equal(first.isActive, true)
        assert.equal(block.isBlocked, true)
        const loaded = await WeeklyOpeningHour.query({ client: trx })
          .where('id', day.id)
          .preload('breaks')
          .preload('slotBlocks')
          .firstOrFail()
        assert.deepEqual(
          loaded.breaks.map((pause) => pause.id).sort(),
          [first.id, second.id].sort()
        )
        assert.equal(loaded.slotBlocks[0].id, block.id)
        await first.load('weeklyOpeningHour')
        await block.load('weeklyOpeningHour')
        assert.equal(first.weeklyOpeningHour.id, day.id)
        assert.equal(block.weeklyOpeningHour.id, day.id)
        for (const [record, table, property, column] of [
          [day, 'weekly_opening_hours', 'opensAtMinute', 'opens_at_minute'],
          [first, 'weekly_breaks', 'startsAtMinute', 'starts_at_minute'],
          [block, 'weekly_slot_blocks', 'startsAtMinute', 'starts_at_minute'],
        ] as const) {
          const row = await trx.from(table).where('id', record.id).first()
          assert.equal(record.serialize()[property], row[column])
          assert.equal(property in row, false)
          assert.ok(DateTime.isDateTime(record.createdAt) && record.createdAt.isValid)
          assert.ok(DateTime.isDateTime(record.updatedAt) && record.updatedAt.isValid)
        }
        day.isActive = false
        first.isActive = false
        block.isBlocked = false
        await day.save()
        await first.save()
        await block.save()
        await day.refresh()
        await first.refresh()
        await block.refresh()
        assert.equal(day.isActive, false)
        assert.equal(first.isActive, false)
        assert.equal(block.isBlocked, false)
        day.isActive = true
        first.isActive = true
        block.isBlocked = true
        await day.save()
        await first.save()
        await block.save()
        const reread = await WeeklySlotBlock.findOrFail(block.id, { client: trx })
        assert.equal(reread.isBlocked, true)
        assert.equal(day.opensAtMinute, 540)
        const rows = await trx.from('weekly_opening_hours').select('*')
        assert.equal(rows.length, 1)
        const breaks = await trx.from('weekly_breaks').select('*')
        assert.equal(breaks.length, 2)
        const blocks = await trx.from('weekly_slot_blocks').select('*')
        assert.equal(blocks.length, 1)
      } finally {
        await trx.rollback()
      }
    })
  })

  test('an unconfigured inactive day maps null times without inventing opening hours', async () => {
    await withDatabase(async (temporary) => {
      const trx = await temporary.client.transaction()
      try {
        const day = await WeeklyOpeningHour.create({ weekday: 7 }, { client: trx })
        await day.refresh()
        assert.equal(day.isActive, false)
        assert.equal(day.opensAtMinute, null)
        assert.equal(day.closesAtMinute, null)
        day.isActive = true
        await assert.rejects(() => day.save(), /constraint/i)
      } finally {
        await trx.rollback()
      }
    })
  })

  test('database constraints remain effective for writes through each weekly model', async () => {
    await withDatabase(async (temporary) => {
      const trx = await temporary.client.transaction()
      try {
        await assert.rejects(
          () => WeeklyOpeningHour.create({ weekday: 8 }, { client: trx }),
          /constraint/i
        )
        const day = await WeeklyOpeningHour.create({ weekday: 1 }, { client: trx })
        await assert.rejects(
          () => WeeklyOpeningHour.create({ weekday: 1 }, { client: trx }),
          /constraint/i
        )
        await assert.rejects(
          () =>
            WeeklyBreak.create(
              { weeklyOpeningHourId: day.id, startsAtMinute: 720, endsAtMinute: 721 },
              { client: trx }
            ),
          /constraint/i
        )
        await assert.rejects(
          () =>
            WeeklySlotBlock.create(
              { weeklyOpeningHourId: day.id, startsAtMinute: 1440 },
              { client: trx }
            ),
          /constraint/i
        )
        await assert.rejects(
          () =>
            WeeklyBreak.create(
              { weeklyOpeningHourId: 999999, startsAtMinute: 720, endsAtMinute: 780 },
              { client: trx }
            ),
          /foreign key/i
        )
      } finally {
        await trx.rollback()
      }
    })
  })

  test('weekly edits preserve createdAt and Lucid advances updatedAt for all three models', async () => {
    await withDatabase(async (temporary) => {
      const trx = await temporary.client.transaction()
      try {
        const day = await WeeklyOpeningHour.create(
          { weekday: 1, isActive: true, opensAtMinute: 540, closesAtMinute: 1080 },
          { client: trx }
        )
        const pause = await WeeklyBreak.create(
          { weeklyOpeningHourId: day.id, startsAtMinute: 720, endsAtMinute: 780 },
          { client: trx }
        )
        const block = await WeeklySlotBlock.create(
          { weeklyOpeningHourId: day.id, startsAtMinute: 600 },
          { client: trx }
        )
        for (const [record, table] of [
          [day, 'weekly_opening_hours'],
          [pause, 'weekly_breaks'],
          [block, 'weekly_slot_blocks'],
        ] as const) {
          await trx
            .from(table)
            .where('id', record.id)
            .update({ created_at: '2000-01-01 00:00:00', updated_at: '2000-01-02 00:00:00' })
          await record.refresh()
          const createdAt = record.createdAt.toISO()
          const updatedAt = record.updatedAt!.toMillis()
          if (record instanceof WeeklySlotBlock) record.isBlocked = false
          else record.isActive = false
          await record.save()
          await record.refresh()
          assert.equal(record.createdAt.toISO(), createdAt)
          assert.ok(record.updatedAt!.toMillis() > updatedAt)
        }
      } finally {
        await trx.rollback()
      }
    })
  })
})
