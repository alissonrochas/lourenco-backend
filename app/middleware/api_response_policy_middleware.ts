import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { isApiRequest, isPrivateResponse, noStore } from '#services/http_response_policy'
import { requestId } from '#services/safe_http_logging'

export default class ApiResponsePolicyMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (isApiRequest(ctx)) {
      // Response serialization also reads this header. Do not echo an untrusted ID.
      ctx.request.request.headers['x-request-id'] = requestId(ctx)
    }
    if (isPrivateResponse(ctx)) noStore(ctx)
    try {
      return await next()
    } finally {
      if (isPrivateResponse(ctx)) noStore(ctx)
    }
  }
}
