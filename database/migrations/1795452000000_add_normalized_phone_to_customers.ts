import { BaseSchema } from '@adonisjs/lucid/schema'

export function getPhoneNormalizationAssignments(customers: Array<{ id: number; phone: string }>) {
  const assigned = new Set<string>()
  const assignments: Array<{ id: number; phoneNormalized: string }> = []

  for (const customer of customers) {
    const normalized = String(customer.phone).replace(/\D/g, '')

    if (normalized.length < 10 || normalized.length > 15 || assigned.has(normalized)) {
      continue
    }

    assigned.add(normalized)
    assignments.push({ id: customer.id, phoneNormalized: normalized })
  }

  return assignments
}

export default class extends BaseSchema {
  protected tableName = 'customers'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('phone_normalized', 15).nullable().unique()
    })

    // Lucid executes schema changes before the deferred backfill, in the same transaction.
    this.defer(async (db) => {
      const customers = await db.from(this.tableName).select('id', 'phone').orderBy('id', 'asc')

      for (const assignment of getPhoneNormalizationAssignments(customers)) {
        await db
          .from(this.tableName)
          .where('id', assignment.id)
          .update({ phone_normalized: assignment.phoneNormalized })
      }
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('phone_normalized')
    })
  }
}
