import {
  buildClearedSessionCookie,
  buildSessionCookie,
  createSessionToken,
  getSessionCookieName,
  parseCookies,
  verifyPassword,
  verifySessionToken,
} from './functions/_lib/auth.js'

const PUBLIC_ADMIN_PATHS = new Set(['/admin/login.html', '/admin/root-login.html'])
const OWNER_ONLY_PATHS = new Set(['/admin/root-owner.html', '/admin/godmode.html', '/admin/root-management.html'])

function json(data, init = {}) {
  const headers = new Headers(init.headers || {})
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(data), { ...init, headers })
}

function redirect(location, clearSession = false) {
  const headers = new Headers({ location })

  if (clearSession) {
    headers.append('set-cookie', buildClearedSessionCookie())
  }

  return new Response(null, { status: 302, headers })
}

async function fakeWork(password, pepper) {
  const data = new TextEncoder().encode(`${password}${pepper || ''}`)
  await crypto.subtle.digest('SHA-256', data)
}

async function handleLogin(request, env) {
  if (!env.DB || !env.AUTH_PEPPER || !env.AUTH_SESSION_SECRET) {
    return json({ ok: false, message: 'Auth service is not configured.' }, { status: 500 })
  }

  let body

  try {
    body = await request.json()
  } catch {
    return json({ ok: false, message: 'Invalid request body.' }, { status: 400 })
  }

  const username = String(body?.username || '').trim()
  const password = String(body?.password || '')

  if (!username || !password) {
    return json({ ok: false, message: 'Username and password are required.' }, { status: 400 })
  }

  const user = await env.DB.prepare(
    `SELECT username, role, password_salt, password_hash, password_iterations
     FROM users
     WHERE lower(username) = lower(?)
     LIMIT 1`
  )
    .bind(username)
    .first()

  if (!user) {
    await fakeWork(password, env.AUTH_PEPPER)
    return json({ ok: false, message: 'Invalid credentials.' }, { status: 401 })
  }

  const valid = await verifyPassword(password, user, env.AUTH_PEPPER)

  if (!valid) {
    return json({ ok: false, message: 'Invalid credentials.' }, { status: 401 })
  }

  const token = await createSessionToken({ username: user.username, role: user.role }, env)
  const headers = new Headers()
  headers.append('set-cookie', buildSessionCookie(token, env))

  return json(
    {
      ok: true,
      username: user.username,
      role: user.role,
      redirectTo: user.role === 'owner' ? '/admin/root-owner.html' : '/admin/dashboard.html',
    },
    { headers }
  )
}

function handleLogout() {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  headers.append('set-cookie', buildClearedSessionCookie())

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers,
  })
}

async function guardAdminRoute(request, env) {
  const url = new URL(request.url)
  const path = url.pathname.toLowerCase()

  if (!path.startsWith('/admin/')) {
    return null
  }

  if (PUBLIC_ADMIN_PATHS.has(path)) {
    return null
  }

  const cookies = parseCookies(request.headers.get('cookie') || '')
  const token = cookies[getSessionCookieName()]

  if (!token) {
    return redirect('/admin/login.html')
  }

  const session = await verifySessionToken(token, env)

  if (!session) {
    return redirect('/admin/login.html', true)
  }

  if (OWNER_ONLY_PATHS.has(path) && session.role !== 'owner') {
    return redirect('/admin/dashboard.html')
  }

  return null
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env)
    }

    if (url.pathname === '/api/logout' && request.method === 'POST') {
      return handleLogout()
    }

    const adminBlockResponse = await guardAdminRoute(request, env)

    if (adminBlockResponse) {
      return adminBlockResponse
    }

    return env.ASSETS.fetch(request)
  },
}
