import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('bookings', (table) => {
      table.increments('id').notNullable()
      table
        .integer('customer_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('customers')
        .onDelete('RESTRICT')
        .onUpdate('RESTRICT')
      table
        .integer('service_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('services')
        .onDelete('RESTRICT')
        .onUpdate('RESTRICT')
      // Canonical UTC instants: integer Unix milliseconds, not SQLite timestamp text.
      table.integer('starts_at_utc').notNullable()
      table.integer('ends_at_utc').notNullable()
      table.string('local_date', 10).notNullable()
      table.integer('starts_at_minute').notNullable()
      table.string('status').notNullable().defaultTo('confirmed')
      table.string('service_name_snapshot', 120).notNullable()
      table.integer('service_price_cents_snapshot').notNullable()
      table.integer('cancelled_at_utc').nullable()
      table
        .integer('cancelled_by_user_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('RESTRICT')
        .onUpdate('RESTRICT')
      table.text('cancellation_reason').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()
      table.index(['customer_id'])
      table.index(['service_id'])
      table.index(['local_date', 'status'])
      table.index(['cancelled_by_user_id'])
      table.check(
        "typeof(starts_at_utc) = 'integer' AND starts_at_utc BETWEEN -62135596800000 AND 253402300799999",
        {},
        'bookings_start_valid'
      )
      table.check(
        "typeof(ends_at_utc) = 'integer' AND ends_at_utc BETWEEN -62135596800000 AND 253402300799999 AND ends_at_utc > starts_at_utc AND ends_at_utc - starts_at_utc = 3600000",
        {},
        'bookings_duration_valid'
      )
      table.check(
        "typeof(starts_at_minute) = 'integer' AND starts_at_minute BETWEEN 0 AND 1380 AND starts_at_minute % 60 = 0",
        {},
        'bookings_local_minute_valid'
      )
      table.check("status IN ('confirmed', 'cancelled')", {}, 'bookings_status_valid')
      table.check(
        "typeof(service_price_cents_snapshot) = 'integer' AND service_price_cents_snapshot BETWEEN 0 AND 9007199254740991",
        {},
        'bookings_price_valid'
      )
      table.check(
        'length(trim(service_name_snapshot)) BETWEEN 2 AND 120',
        {},
        'bookings_name_valid'
      )
      table.check(
        `typeof(local_date) = 'text' AND length(local_date) = 10
        AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND CAST(substr(local_date, 1, 4) AS INTEGER) BETWEEN 1 AND 9999
        AND CAST(substr(local_date, 6, 2) AS INTEGER) BETWEEN 1 AND 12
        AND CAST(substr(local_date, 9, 2) AS INTEGER) BETWEEN 1 AND
          CASE CAST(substr(local_date, 6, 2) AS INTEGER)
            WHEN 2 THEN CASE WHEN CAST(substr(local_date, 1, 4) AS INTEGER) % 4 = 0
              AND (CAST(substr(local_date, 1, 4) AS INTEGER) % 100 != 0 OR CAST(substr(local_date, 1, 4) AS INTEGER) % 400 = 0) THEN 29 ELSE 28 END
            WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END`,
        {},
        'bookings_local_date_valid'
      )
      table.check(
        `(status = 'confirmed' AND cancelled_at_utc IS NULL AND cancelled_by_user_id IS NULL AND cancellation_reason IS NULL)
        OR (status = 'cancelled' AND typeof(cancelled_at_utc) = 'integer'
          AND cancelled_at_utc BETWEEN -62135596800000 AND 253402300799999
          AND cancelled_by_user_id IS NOT NULL AND cancellation_reason IS NOT NULL
          AND typeof(cancellation_reason) = 'text' AND length(trim(cancellation_reason)) BETWEEN 1 AND 500)`,
        {},
        'bookings_cancellation_audit_valid'
      )
    })
    // Lucid queues schema statements: the index must run only after CREATE TABLE.
    this.defer(async (db) => {
      await db.rawQuery(
        "CREATE UNIQUE INDEX bookings_confirmed_start_unique ON bookings (starts_at_utc) WHERE status = 'confirmed'"
      )
    })
  }

  async down() {
    this.schema.dropTable('bookings')
  }
}
