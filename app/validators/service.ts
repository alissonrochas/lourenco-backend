import vine from '@vinejs/vine'

export const createServiceValidator = vine.create({
  name: vine.string().trim().minLength(2).maxLength(120),
  description: vine
    .string()
    .parse((value) => (typeof value === 'string' && value.trim() === '' ? null : value))
    .trim()
    .maxLength(1000)
    .nullable()
    .optional(),
  priceCents: vine.number({ strict: true }).withoutDecimals().min(0).max(Number.MAX_SAFE_INTEGER),
  durationMinutes: vine.number({ strict: true }).withoutDecimals().min(5).max(480),
  isActive: vine.boolean({ strict: true }).parse((value) => (value === undefined ? true : value)),
})
