import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('booking_settings', (table) => {
      table.integer('id').primary().notNullable().defaultTo(1)
      table.string('timezone').notNullable().defaultTo('America/Sao_Paulo')
      table.integer('slot_duration_minutes').notNullable().defaultTo(60)
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.check("typeof(id) = 'integer' AND id = 1", {}, 'booking_settings_singleton')
      table.check("timezone = 'America/Sao_Paulo'", {}, 'booking_settings_timezone_fixed')
      table.check(
        "typeof(slot_duration_minutes) = 'integer' AND slot_duration_minutes = 60",
        {},
        'booking_settings_slot_fixed'
      )
    })

    this.schema.createTable('weekly_opening_hours', (table) => {
      table.increments('id').notNullable()
      table.integer('weekday').notNullable().unique()
      // Unconfigured days are closed; no opening or closing hours are invented.
      table.boolean('is_active').notNullable().defaultTo(false)
      table.integer('opens_at_minute').nullable()
      table.integer('closes_at_minute').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.check(
        "typeof(weekday) = 'integer' AND weekday BETWEEN 1 AND 7",
        {},
        'weekly_opening_hours_weekday_valid'
      )
      table.check(
        "typeof(is_active) = 'integer' AND is_active IN (0, 1)",
        {},
        'weekly_opening_hours_active_valid'
      )
      table.check(
        `
        (is_active = 0 AND opens_at_minute IS NULL AND closes_at_minute IS NULL)
        OR (
          typeof(opens_at_minute) = 'integer' AND typeof(closes_at_minute) = 'integer'
          AND opens_at_minute BETWEEN 0 AND 1380 AND closes_at_minute BETWEEN 60 AND 1440
          AND opens_at_minute % 60 = 0 AND closes_at_minute % 60 = 0
          AND opens_at_minute < closes_at_minute
        )`,
        {},
        'weekly_opening_hours_times_valid'
      )
    })

    this.schema.createTable('weekly_breaks', (table) => {
      table.increments('id').notNullable()
      table
        .integer('weekly_opening_hour_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('weekly_opening_hours')
        .onDelete('RESTRICT')
        .onUpdate('RESTRICT')
      table.integer('starts_at_minute').notNullable()
      table.integer('ends_at_minute').notNullable()
      table.boolean('is_active').notNullable().defaultTo(true)
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.index(['weekly_opening_hour_id'])
      table.check(
        "typeof(is_active) = 'integer' AND is_active IN (0, 1)",
        {},
        'weekly_breaks_active_valid'
      )
      table.check(
        `
        typeof(starts_at_minute) = 'integer' AND typeof(ends_at_minute) = 'integer'
        AND starts_at_minute BETWEEN 0 AND 1380 AND ends_at_minute BETWEEN 60 AND 1440
        AND starts_at_minute % 60 = 0 AND ends_at_minute % 60 = 0
        AND starts_at_minute < ends_at_minute`,
        {},
        'weekly_breaks_times_valid'
      )
    })

    this.schema.createTable('weekly_slot_blocks', (table) => {
      table.increments('id').notNullable()
      table
        .integer('weekly_opening_hour_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('weekly_opening_hours')
        .onDelete('RESTRICT')
        .onUpdate('RESTRICT')
      table.integer('starts_at_minute').notNullable()
      table.boolean('is_blocked').notNullable().defaultTo(true)
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.unique(['weekly_opening_hour_id', 'starts_at_minute'])
      table.check(
        "typeof(is_blocked) = 'integer' AND is_blocked IN (0, 1)",
        {},
        'weekly_slot_blocks_blocked_valid'
      )
      table.check(
        "typeof(starts_at_minute) = 'integer' AND starts_at_minute BETWEEN 0 AND 1380 AND starts_at_minute % 60 = 0",
        {},
        'weekly_slot_blocks_time_valid'
      )
    })
  }

  async down() {
    this.schema.dropTable('weekly_slot_blocks')
    this.schema.dropTable('weekly_breaks')
    this.schema.dropTable('weekly_opening_hours')
    this.schema.dropTable('booking_settings')
  }
}
