import vine from '@vinejs/vine'

export const createCustomerValidator = vine.create({
  name: vine.string().trim().minLength(2).maxLength(120),
  phone: vine
    .string()
    .trim()
    .minLength(10)
    .maxLength(20)
    .regex(/^[0-9()+\-\s]+$/),
})
