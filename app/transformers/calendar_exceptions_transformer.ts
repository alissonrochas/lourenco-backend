import { BaseTransformer } from '@adonisjs/core/transformers'
import type DateBlock from '#models/date_block'
import type DateSlotBlock from '#models/date_slot_block'

type Resource = { dateBlocks: DateBlock[]; slotBlocks: DateSlotBlock[] }
export default class CalendarExceptionsTransformer extends BaseTransformer<Resource> {
  toObject() {
    const fields = (record: DateBlock | DateSlotBlock) => ({
      id: record.id,
      localDate: record.localDate,
      isBlocked: record.isBlocked,
      reason: record.reason,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
    return {
      dateBlocks: this.resource.dateBlocks.map(fields),
      slotBlocks: this.resource.slotBlocks.map((record) => ({
        ...fields(record),
        startsAtMinute: record.startsAtMinute,
      })),
    }
  }
}
