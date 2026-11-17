/* eslint-disable prettier/prettier */
import type { routes } from './index.ts'

export interface ApiDefinition {
  home: typeof routes['home']
  customers: {
    store: typeof routes['customers.store']
    index: typeof routes['customers.index']
  }
  adminAuth: {
    login: typeof routes['admin_auth.login']
    logout: typeof routes['admin_auth.logout']
    me: typeof routes['admin_auth.me']
  }
  session: {
    create: typeof routes['session.create']
    store: typeof routes['session.store']
    destroy: typeof routes['session.destroy']
  }
  newAccount: {
    create: typeof routes['new_account.create']
    store: typeof routes['new_account.store']
  }
  dashboard: typeof routes['dashboard']
}
