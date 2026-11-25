import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    for (const name of ['date_blocks', 'date_slot_blocks']) {
      this.schema.createTable(name, (table) => {
        table.increments('id').notNullable()
        table.string('local_date', 10).notNullable()
        if (name === 'date_slot_blocks') table.integer('starts_at_minute').notNullable()
        table.boolean('is_blocked').notNullable().defaultTo(true)
        table.text('reason').nullable()
        table.timestamp('created_at').notNullable()
        table.timestamp('updated_at').nullable()
        if (name === 'date_blocks') table.unique(['local_date'])
        else {
          table.unique(['local_date', 'starts_at_minute'])
          table.check(
            "typeof(starts_at_minute) = 'integer' AND starts_at_minute BETWEEN 0 AND 1380 AND starts_at_minute % 60 = 0",
            {},
            `${name}_time_valid`
          )
        }
        // Gregorian calendar integrity also guards direct SQL. Application/model
        // validation independently checks real dates, rather than relying on SQLite date().
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
          `${name}_date_valid`
        )
        table.check(
          "typeof(is_blocked) = 'integer' AND is_blocked IN (0, 1)",
          {},
          `${name}_status_valid`
        )
        table.check(
          "reason IS NULL OR (typeof(reason) = 'text' AND length(trim(reason)) <= 500)",
          {},
          `${name}_reason_valid`
        )
      })
    }
  }

  async down() {
    this.schema.dropTable('date_slot_blocks')
    this.schema.dropTable('date_blocks')
  }
}
