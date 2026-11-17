/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import AdminAuthController from '#controllers/admin_auth_controller'
import CustomersController from '#controllers/customers_controller'
import { controllers } from '#generated/controllers'
import router from '@adonisjs/core/services/router'

router.on('/').renderInertia('home', {}).as('home')

router.post('/api/customers', [CustomersController, 'store'])
router.get('/api/customers', [CustomersController, 'index'])

router.post('/api/admin/login', [AdminAuthController, 'login'])

router
  .group(() => {
    router.post('/api/admin/logout', [AdminAuthController, 'logout'])
    router.get('/api/admin/me', [AdminAuthController, 'me'])
  })
  .use(middleware.adminAuth())

router
  .group(() => {
    router.get('login', [controllers.Session, 'create'])
    router.post('login', [controllers.Session, 'store'])
    router.get('signup', [controllers.NewAccount, 'create'])
    router.post('signup', [controllers.NewAccount, 'store'])
  })
  .use(middleware.guest())

router
  .group(() => {
    router.on('/dashboard').renderInertia('dashboard', {}).as('dashboard')
    router.post('logout', [controllers.Session, 'destroy'])
  })
  .use(middleware.auth())
