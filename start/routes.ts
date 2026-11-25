/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import { controllers } from '#generated/controllers'
import router from '@adonisjs/core/services/router'

router.on('/').renderInertia('home', {}).as('home')

router.get('/api/services', [() => import('#controllers/services_controller'), 'index'])

router
  .post('/api/customers', [() => import('#controllers/customers_controller'), 'store'])
  .use(middleware.customerRateLimit())

router
  .get('/api/customers', [() => import('#controllers/customers_controller'), 'index'])
  .use(middleware.adminAuth())

router
  .post('/api/admin/login', [() => import('#controllers/admin_auth_controller'), 'login'])
  .use(middleware.loginRateLimit())

router
  .group(() => {
    router.post('/api/admin/logout', [() => import('#controllers/admin_auth_controller'), 'logout'])
    router.get('/api/admin/me', [() => import('#controllers/admin_auth_controller'), 'me'])
    router.get('/api/admin/calendar-exceptions', [
      () => import('#controllers/admin_calendar_exceptions_controller'),
      'index',
    ])
    router.post('/api/admin/calendar-exceptions', [
      () => import('#controllers/admin_calendar_exceptions_controller'),
      'store',
    ])
    router.get('/api/admin/booking-settings', [
      () => import('#controllers/admin_booking_settings_controller'),
      'index',
    ])
    router.patch('/api/admin/booking-settings', [
      () => import('#controllers/admin_booking_settings_controller'),
      'update',
    ])
    router.get('/api/admin/services', [
      () => import('#controllers/admin_services_controller'),
      'index',
    ])
    router.get('/api/admin/services/:id', [
      () => import('#controllers/admin_services_controller'),
      'show',
    ])
    router.patch('/api/admin/services/:id', [
      () => import('#controllers/admin_services_controller'),
      'update',
    ])
    router.post('/api/admin/services', [
      () => import('#controllers/admin_services_controller'),
      'store',
    ])
  })
  .use(middleware.adminAuth())

router
  .group(() => {
    router.get('login', [controllers.Session, 'create'])
    router.post('login', [controllers.Session, 'store']).use(middleware.loginRateLimit())
  })
  .use(middleware.guest())

router
  .group(() => {
    router.on('/dashboard').renderInertia('dashboard', {}).as('dashboard')
    router.post('logout', [controllers.Session, 'destroy'])
  })
  .use(middleware.adminAuth())

router.get('/api/csrf', ({ response }) => response.json({ ok: true }))
