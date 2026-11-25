import Service from '#models/service'
import ServiceTransformer from '#transformers/service_transformer'
import type { HttpContext } from '@adonisjs/core/http'

export default class ServicesController {
  async index(ctx: HttpContext) {
    const services = await Service.query().where('isActive', true).orderBy('id', 'asc')
    // Avoid stale catalogues after an administrator deactivates a service.
    ctx.response.header('Cache-Control', 'no-store')
    return ctx.serialize(ServiceTransformer.transform(services))
  }
}
