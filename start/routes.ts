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
