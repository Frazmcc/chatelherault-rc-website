import { buildClearedSessionCookie } from '../_lib/auth.js'

export async function onRequestPost() {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  headers.append('set-cookie', buildClearedSessionCookie())

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers,
  })
}
