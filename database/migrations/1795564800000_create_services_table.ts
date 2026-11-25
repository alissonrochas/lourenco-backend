import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'services'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('name').notNullable()
      table.text('description').nullable()
      table.integer('price_cents').notNullable()
      table.integer('duration_minutes').notNullable()
      table.boolean('is_active').notNullable().defaultTo(true)
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      // SQLite affinity alone does not enforce integer values or boolean domains.
      table.check('length(trim(name)) > 0', {}, 'services_name_not_empty')
      table.check(
        "typeof(price_cents) = 'integer' AND price_cents BETWEEN 0 AND 9007199254740991",
        {},
        'services_price_cents_valid'
      )
      table.check(
        "typeof(duration_minutes) = 'integer' AND duration_minutes BETWEEN 5 AND 480",
        {},
        'services_duration_minutes_valid'
      )
      table.check(
        "typeof(is_active) = 'integer' AND is_active IN (0, 1)",
        {},
        'services_is_active_valid'
      )
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
