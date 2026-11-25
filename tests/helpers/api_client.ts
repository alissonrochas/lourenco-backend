import assert from 'node:assert/strict'
import env from '#start/env'

// The assembler selects a free PORT. Never send tests to a hard-coded development server.
const host = env.get('HOST')
export const baseUrl = `http://${host.includes(':') ? `[${host}]` : host}:${env.get('PORT')}`

export function mergeCookies(existing: string, response: Response) {
  const cookies = new Map<string, string>()
  for (const item of existing.split(/;\s*/)) {
    const separator = item.indexOf('=')
    if (separator > 0) cookies.set(item.slice(0, separator), item.slice(separator + 1))
  }
  for (const header of response.headers.getSetCookie()) {
    const item = header.split(';')[0]
    const separator = item.indexOf('=')
    if (separator > 0) cookies.set(item.slice(0, separator), item.slice(separator + 1))
  }
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ')
}

export async function getJson(path: string, cookie = '', accept = 'application/json') {
  return fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    headers: { Accept: accept, Cookie: cookie },
  })
}

async function writeJson(
  method: 'POST' | 'PATCH',
  path: string,
  data: unknown,
  cookie = '',
  accept = 'application/json'
) {
  const prime = await getJson('/api/csrf', cookie)
  assert.equal(prime.status, 200)
  const csrfCookie = mergeCookies(cookie, prime)
  const token = csrfCookie.split(/;\s*/).find((item) => item.startsWith('XSRF-TOKEN='))
  assert.ok(token)
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      'Accept': accept,
      'Cookie': csrfCookie,
      'X-XSRF-TOKEN': decodeURIComponent(token.slice('XSRF-TOKEN='.length)),
    },
    body: JSON.stringify(data),
  })
  return { response, cookie: mergeCookies(csrfCookie, response) }
}

export function postJson(path: string, data: unknown, cookie = '', accept = 'application/json') {
  return writeJson('POST', path, data, cookie, accept)
}

export function patchJson(path: string, data: unknown, cookie = '', accept = 'application/json') {
  return writeJson('PATCH', path, data, cookie, accept)
}
