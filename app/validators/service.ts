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

// Vine optional fields also skip null. Check the original object so PATCH keeps
// absence distinct from an explicit null, without changing creation defaults.
const validServicePatch = vine.createRule((value, _options, field) => {
  const input = value as Record<string, unknown>
  const editable = ['name', 'description', 'priceCents', 'durationMinutes', 'isActive']
  if (!editable.some((key) => Object.hasOwn(input, key))) {
    field.report('Envie pelo menos um campo editável.', 'servicePatch', field)
  }
  for (const key of ['name', 'priceCents', 'durationMinutes', 'isActive']) {
    if (Object.hasOwn(input, key) && input[key] === null) {
      field.report(`O campo ${key} não aceita null.`, 'servicePatch', field)
    }
  }
})

export const updateServiceValidator = vine.create(
  vine
    .object({
      name: vine.string().trim().minLength(2).maxLength(120).optional(),
      description: vine
        .string()
        .parse((value) => (typeof value === 'string' && value.trim() === '' ? null : value))
        .trim()
        .maxLength(1000)
        .nullable()
        .optional(),
      priceCents: vine
        .number({ strict: true })
        .withoutDecimals()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
      durationMinutes: vine.number({ strict: true }).withoutDecimals().min(5).max(480).optional(),
      isActive: vine.boolean({ strict: true }).optional(),
    })
    .use(validServicePatch())
)
