import {
  buildClearedSessionCookie,
  getSessionCookieName,
  parseCookies,
  verifySessionToken,
} from '../_lib/auth.js'

const PUBLIC_ADMIN_PATHS = new Set(['/admin/login.html', '/admin/root-login.html'])
const OWNER_ONLY_PATHS = new Set(['/admin/root-owner.html', '/admin/godmode.html', '/admin/root-management.html'])

function redirect(url, location, clearSession = false) {
  const headers = new Headers({ location })

  if (clearSession) {
    headers.append('set-cookie', buildClearedSessionCookie())
  }

  return new Response(null, { status: 302, headers })
}

export async function onRequest(context) {
  const { request, env, next } = context
  const url = new URL(request.url)
  const path = url.pathname.toLowerCase()

  if (PUBLIC_ADMIN_PATHS.has(path)) {
    return next()
  }

  const cookies = parseCookies(request.headers.get('cookie') || '')
  const token = cookies[getSessionCookieName()]

  if (!token) {
    return redirect(url, '/admin/login.html')
  }

  const session = await verifySessionToken(token, env)

  if (!session) {
    return redirect(url, '/admin/login.html', true)
  }

  if (OWNER_ONLY_PATHS.has(path) && session.role !== 'owner') {
    return redirect(url, '/admin/dashboard.html')
  }

  return next()
}
