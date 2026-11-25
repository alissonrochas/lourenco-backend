import Service from '#models/service'
import ServiceTransformer from '#transformers/service_transformer'
import { createServiceValidator, updateServiceValidator } from '#validators/service'
import type { HttpContext } from '@adonisjs/core/http'
import { errors } from '@vinejs/vine'

export default class AdminServicesController {
  async index(ctx: HttpContext) {
    const services = await Service.query().orderBy('id', 'asc')
    ctx.response.header('Cache-Control', 'no-store')
    return ctx.serialize(ServiceTransformer.transform(services))
  }

  async show(ctx: HttpContext) {
    const id = Number(ctx.params.id)
    if (!/^[1-9]\d*$/.test(ctx.params.id) || !Number.isSafeInteger(id)) {
      return ctx.response.notFound({ message: 'Serviço não encontrado.' })
    }
    const service = await Service.find(id)
    if (!service) {
      // Do not delegate API 404s to the production Inertia status page.
      return ctx.response.notFound({ message: 'Serviço não encontrado.' })
    }
    ctx.response.header('Cache-Control', 'no-store')
    return ctx.serialize(ServiceTransformer.transform(service))
  }

  async store(ctx: HttpContext) {
    let payload
    try {
      payload = await ctx.request.validateUsing(createServiceValidator)
    } catch (error) {
      if (error instanceof errors.E_VALIDATION_ERROR) {
        return ctx.response.unprocessableEntity({
          message: 'Dados do serviço inválidos.',
          errors: error.messages,
        })
      }
      throw error
    }

    // Explicit assignment prevents request IDs, timestamps or other fields reaching the model.
    const service = await Service.create({
      name: payload.name,
      description: payload.description ?? null,
      priceCents: payload.priceCents,
      durationMinutes: payload.durationMinutes,
      isActive: payload.isActive ?? true,
    })
    // Reload SQL defaults, boolean consumption and timestamp precision before serialization.
    await service.refresh()
    ctx.response.header('Cache-Control', 'no-store')
    return ctx.response.created(await ctx.serialize(ServiceTransformer.transform(service)))
  }

  async update(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store')
    const id = Number(ctx.params.id)
    if (!/^[1-9]\d*$/.test(ctx.params.id) || !Number.isSafeInteger(id)) {
      return ctx.response.notFound({ message: 'Serviço não encontrado.' })
    }
    const service = await Service.find(id)
    if (!service) {
      return ctx.response.notFound({ message: 'Serviço não encontrado.' })
    }

    let payload
    try {
      payload = await ctx.request.validateUsing(updateServiceValidator)
    } catch (error) {
      if (error instanceof errors.E_VALIDATION_ERROR) {
        return ctx.response.unprocessableEntity({
          message: 'Dados do serviço inválidos.',
          errors: error.messages,
        })
      }
      throw error
    }

    // Only validated business fields can reach Lucid. Omitted fields stay untouched.
    if (Object.hasOwn(payload, 'name')) service.name = payload.name!
    if (Object.hasOwn(payload, 'description')) service.description = payload.description ?? null
    if (Object.hasOwn(payload, 'priceCents')) service.priceCents = payload.priceCents!
    if (Object.hasOwn(payload, 'durationMinutes'))
      service.durationMinutes = payload.durationMinutes!
    if (Object.hasOwn(payload, 'isActive')) service.isActive = payload.isActive!
    await service.save()
    await service.refresh()
    return ctx.serialize(ServiceTransformer.transform(service))
  }
}
