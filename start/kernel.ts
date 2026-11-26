/*
|--------------------------------------------------------------------------
| HTTP kernel file
|--------------------------------------------------------------------------
|
| The HTTP kernel file is used to register the middleware with the server
| or the router.
|
*/

import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

/**
 * The error handler is used to convert an exception
 * to a HTTP response.
 */
server.errorHandler(() => import('#exceptions/handler'))

/**
 * The server middleware stack runs middleware on all the HTTP
 * requests, even if there is no route registered for
 * the request URL.
 */
server.use([
  () => import('#middleware/container_bindings_middleware'),
  () => import('@adonisjs/static/static_middleware'),
  () => import('@adonisjs/cors/cors_middleware'),
  () => import('@adonisjs/vite/vite_middleware'),
  () => import('#middleware/inertia_middleware'),
])

/**
 * The router middleware stack runs middleware on all the HTTP
 * requests with a registered route.
 */
router.use([
  () => import('@adonisjs/core/bodyparser_middleware'),
  () =>
    import('#middleware/availability_state_middleware').then((module) => ({
      default: module.AvailabilitySessionMiddleware,
    })),
  () =>
    import('#middleware/availability_state_middleware').then((module) => ({
      default: module.AvailabilityShieldMiddleware,
    })),
  () =>
    import('#middleware/availability_state_middleware').then((module) => ({
      default: module.AvailabilityInitializeAuthMiddleware,
    })),
  () =>
    import('#middleware/availability_state_middleware').then((module) => ({
      default: module.AvailabilitySilentAuthMiddleware,
    })),
])

/**
 * Named middleware collection must be explicitly assigned to
 * the routes or the routes group.
 */
export const middleware = router.named({
  guest: () => import('#middleware/guest_middleware'),
  auth: () => import('#middleware/auth_middleware'),
  adminAuth: () => import('#middleware/admin_auth_middleware'),
  loginRateLimit: () => import('#middleware/login_rate_limit_middleware'),
  customerRateLimit: () => import('#middleware/customer_rate_limit_middleware'),
  availabilityRateLimit: () =>
    import('#middleware/availability_state_middleware').then((module) => ({
      default: module.AvailabilityRouteRateLimitMiddleware,
    })),
})
