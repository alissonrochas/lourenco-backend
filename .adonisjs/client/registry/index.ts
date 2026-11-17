/* eslint-disable prettier/prettier */
import type { AdonisEndpoint } from '@tuyau/core/types'
import type { Registry } from './schema.d.ts'
import type { ApiDefinition } from './tree.d.ts'

export type { Route, Path } from './schema.d.ts'

const placeholder: any = {}

const routes = {
  'home': {
    methods: ["GET","HEAD"],
    pattern: '/',
    tokens: [[0,"/"]],
    types: placeholder as Registry['home']['types'],
  },
  'customers.store': {
    methods: ["POST"],
    pattern: '/api/customers',
    tokens: [[0,"api"],[0,"customers"]],
    types: placeholder as Registry['customers.store']['types'],
  },
  'customers.index': {
    methods: ["GET","HEAD"],
    pattern: '/api/customers',
    tokens: [[0,"api"],[0,"customers"]],
    types: placeholder as Registry['customers.index']['types'],
  },
  'admin_auth.login': {
    methods: ["POST"],
    pattern: '/api/admin/login',
    tokens: [[0,"api"],[0,"admin"],[0,"login"]],
    types: placeholder as Registry['admin_auth.login']['types'],
  },
  'admin_auth.logout': {
    methods: ["POST"],
    pattern: '/api/admin/logout',
    tokens: [[0,"api"],[0,"admin"],[0,"logout"]],
    types: placeholder as Registry['admin_auth.logout']['types'],
  },
  'admin_auth.me': {
    methods: ["GET","HEAD"],
    pattern: '/api/admin/me',
    tokens: [[0,"api"],[0,"admin"],[0,"me"]],
    types: placeholder as Registry['admin_auth.me']['types'],
  },
  'session.create': {
    methods: ["GET","HEAD"],
    pattern: '/login',
    tokens: [[0,"login"]],
    types: placeholder as Registry['session.create']['types'],
  },
  'session.store': {
    methods: ["POST"],
    pattern: '/login',
    tokens: [[0,"login"]],
    types: placeholder as Registry['session.store']['types'],
  },
  'new_account.create': {
    methods: ["GET","HEAD"],
    pattern: '/signup',
    tokens: [[0,"signup"]],
    types: placeholder as Registry['new_account.create']['types'],
  },
  'new_account.store': {
    methods: ["POST"],
    pattern: '/signup',
    tokens: [[0,"signup"]],
    types: placeholder as Registry['new_account.store']['types'],
  },
  'dashboard': {
    methods: ["GET","HEAD"],
    pattern: '/dashboard',
    tokens: [[0,"dashboard"]],
    types: placeholder as Registry['dashboard']['types'],
  },
  'session.destroy': {
    methods: ["POST"],
    pattern: '/logout',
    tokens: [[0,"logout"]],
    types: placeholder as Registry['session.destroy']['types'],
  },
} as const satisfies Record<string, AdonisEndpoint>

export { routes }

export const registry = {
  routes,
  $tree: {} as ApiDefinition,
}

declare module '@tuyau/core/types' {
  export interface UserRegistry {
    routes: typeof routes
    $tree: ApiDefinition
  }
}
