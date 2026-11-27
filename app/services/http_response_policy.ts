import type { HttpContext } from '@adonisjs/core/http'

function path(ctx: HttpContext) {
  const raw = ctx.route?.pattern ?? ctx.request.url()
  try {
    return decodeURIComponent(raw).toLowerCase().replace(/\/+$/, '') || '/'
  } catch {
    return raw.toLowerCase()
  }
}
export function isApiRequest(ctx: HttpContext) {
  const value = path(ctx)
  return value === '/api' || value.startsWith('/api/')
}
export function isPrivateResponse(ctx: HttpContext) {
  const value = path(ctx)
  return (
    value === '/api/admin' ||
    value.startsWith('/api/admin/') ||
    (value === '/api/customers' && ['GET', 'HEAD'].includes(ctx.request.method())) ||
    ['/login', '/logout', '/dashboard', '/api/csrf'].includes(value) ||
    (value === '/' && !!(ctx as Partial<HttpContext>).auth?.user)
  )
}
export function noStore(ctx: HttpContext) {
  ctx.response.header('Cache-Control', 'no-store')
  // Retain ETag for calendar If-Match; remove only contradictory storage directives.
  for (const name of ['Expires', 'Surrogate-Control', 'CDN-Cache-Control'])
    ctx.response.removeHeader(name)
}

export const internalServerError = Object.freeze({
  code: 'INTERNAL_SERVER_ERROR',
  message: 'Não foi possível processar a solicitação.',
})
