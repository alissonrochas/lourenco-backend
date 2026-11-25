import vine from '@vinejs/vine'
import type { Infer } from '@vinejs/vine/types'

const patchShape = vine.createRule((value, _options, field) => {
  const root = value as Record<string, unknown>
  const report = () =>
    field.report('Configuração inválida ou campos não permitidos.', 'bookingSettings', field)
  const checkKeys = (
    input: Record<string, unknown>,
    allowed: string[],
    nullable: string[] = []
  ) => {
    for (const key of Object.keys(input)) {
      if (!allowed.includes(key) || (input[key] === null && !nullable.includes(key))) report()
    }
  }
  checkKeys(root, ['days'])
  if (!Array.isArray(root.days)) return
  const weekdays = new Set<unknown>()
  for (const day of root.days) {
    if (!day || typeof day !== 'object' || Array.isArray(day)) continue
    checkKeys(
      day,
      ['weekday', 'isActive', 'opensAtMinute', 'closesAtMinute', 'breaks', 'slotBlocks'],
      ['opensAtMinute', 'closesAtMinute']
    )
    if (
      !['isActive', 'opensAtMinute', 'closesAtMinute', 'breaks', 'slotBlocks'].some((key) =>
        Object.hasOwn(day, key)
      )
    )
      report()
    if (weekdays.has(day.weekday)) report()
    weekdays.add(day.weekday)
    for (const key of ['breaks', 'slotBlocks']) {
      if (!Array.isArray(day[key])) continue
      const starts = new Set<unknown>()
      for (const item of day[key]) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        checkKeys(
          item,
          key === 'breaks'
            ? ['startsAtMinute', 'endsAtMinute', 'isActive']
            : ['startsAtMinute', 'isBlocked']
        )
        if (starts.has(item.startsAtMinute)) report()
        starts.add(item.startsAtMinute)
      }
    }
  }
})

const startMinute = () => vine.number({ strict: true }).withoutDecimals().min(0).max(1380)
const endMinute = () => vine.number({ strict: true }).withoutDecimals().min(60).max(1440)

export const updateBookingSettingsValidator = vine.create(
  vine
    .object({
      days: vine
        .array(
          vine.object({
            weekday: vine.number({ strict: true }).withoutDecimals().min(1).max(7),
            isActive: vine.boolean({ strict: true }).optional(),
            opensAtMinute: startMinute().nullable().optional(),
            closesAtMinute: endMinute().nullable().optional(),
            breaks: vine
              .array(
                vine.object({
                  startsAtMinute: startMinute(),
                  endsAtMinute: endMinute(),
                  isActive: vine.boolean({ strict: true }),
                })
              )
              .maxLength(24)
              .optional(),
            slotBlocks: vine
              .array(
                vine.object({
                  startsAtMinute: startMinute(),
                  isBlocked: vine.boolean({ strict: true }),
                })
              )
              .maxLength(24)
              .optional(),
          })
        )
        .minLength(1)
        .maxLength(7),
    })
    .use(patchShape())
)

export type BookingSettingsPatch = Infer<typeof updateBookingSettingsValidator>
