import {
  buildClearedSessionCookie,
  buildSessionCookie,
  createPasswordRecord,
  createSessionToken,
  getSessionCookieName,
  parseCookies,
  verifyPassword,
  verifySessionToken,
} from './functions/_lib/auth.js'

const PUBLIC_ADMIN_PATHS = new Set(['/admin/login.html', '/admin/root-login.html'])
const OWNER_ONLY_SITE_PATHS = new Set(['/pages/super-user.html', '/pages/super-user'])

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
      redirectTo: '/index.html',
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

async function handleSession(request, env) {
  const cookies = parseCookies(request.headers.get('cookie') || '')
  const token = cookies[getSessionCookieName()]

  if (!token) {
    return json({ ok: false }, { status: 401 })
  }

  const session = await verifySessionToken(token, env)

  if (!session) {
    const headers = new Headers()
    headers.append('set-cookie', buildClearedSessionCookie())
    return json({ ok: false }, { status: 401, headers })
  }

  return json({ ok: true, username: session.username, role: session.role })
}

// --- Auth helpers ---

async function getSession(request, env) {
  const cookies = parseCookies(request.headers.get('cookie') || '')
  const token = cookies[getSessionCookieName()]
  if (!token) return null
  return verifySessionToken(token, env)
}

function hasRole(session, ...allowed) {
  return Boolean(session && allowed.includes(session.role))
}

// --- User management (owner only) ---

async function handleListUsers(request, env) {
  const session = await getSession(request, env)
  if (!hasRole(session, 'owner')) return json({ ok: false, message: 'Forbidden.' }, { status: 403 })

  const { results } = await env.DB.prepare(
    `SELECT id, username, role, created_at FROM users WHERE role != 'owner' ORDER BY created_at DESC`
  ).all()

  return json({ ok: true, users: results })
}

async function handleCreateUser(request, env) {
  const session = await getSession(request, env)
  if (!hasRole(session, 'owner')) return json({ ok: false, message: 'Forbidden.' }, { status: 403 })

  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, message: 'Invalid request body.' }, { status: 400 })
  }

  const username = String(body?.username || '').trim()
  const password = String(body?.password || '')
  const role = ['admin', 'mod'].includes(body?.role) ? body.role : 'admin'

  if (!username || !password) {
    return json({ ok: false, message: 'Username and password are required.' }, { status: 400 })
  }

  if (password.length < 8) {
    return json({ ok: false, message: 'Password must be at least 8 characters.' }, { status: 400 })
  }

  const { salt, hash, iterations } = await createPasswordRecord(password, env.AUTH_PEPPER)

  try {
    const result = await env.DB.prepare(
      `INSERT INTO users (username, role, password_salt, password_hash, password_iterations) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(username, role, salt, hash, iterations)
      .run()

    return json({ ok: true, id: result.meta.last_row_id })
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return json({ ok: false, message: 'Username already exists.' }, { status: 409 })
    }
    throw err
  }
}

async function handleDeleteUser(request, env) {
  const session = await getSession(request, env)
  if (!hasRole(session, 'owner')) return json({ ok: false, message: 'Forbidden.' }, { status: 403 })

  const url = new URL(request.url)
  const id = parseInt(url.pathname.split('/').pop(), 10)
  if (!id) return json({ ok: false, message: 'Invalid user id.' }, { status: 400 })

  const target = await env.DB.prepare(`SELECT role FROM users WHERE id = ?`).bind(id).first()
  if (!target) return json({ ok: false, message: 'User not found.' }, { status: 404 })
  if (target.role === 'owner') return json({ ok: false, message: 'Cannot delete owner accounts.' }, { status: 403 })

  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run()
  return json({ ok: true })
}

// --- Media management (admin / mod / owner) ---

async function handleListMedia(request, env) {
  const session = await getSession(request, env)
  if (!hasRole(session, 'owner', 'admin', 'mod')) return json({ ok: false, message: 'Forbidden.' }, { status: 403 })

  const { results } = await env.DB.prepare(
    `SELECT id, title, url, type, added_by, created_at FROM media ORDER BY created_at DESC`
  ).all()

  return json({ ok: true, media: results })
}

async function handleAddMedia(request, env) {
  const session = await getSession(request, env)
  if (!hasRole(session, 'owner', 'admin', 'mod')) return json({ ok: false, message: 'Forbidden.' }, { status: 403 })

  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, message: 'Invalid request body.' }, { status: 400 })
  }

  const title = String(body?.title || '').trim()
  const url = String(body?.url || '').trim()
  const type = ['image', 'video'].includes(body?.type) ? body.type : 'image'

  if (!title || !url) {
    return json({ ok: false, message: 'Title and URL are required.' }, { status: 400 })
  }

  try {
    new URL(url)
  } catch {
    return json({ ok: false, message: 'Invalid URL.' }, { status: 400 })
  }

  const result = await env.DB.prepare(
    `INSERT INTO media (title, url, type, added_by) VALUES (?, ?, ?, ?)`
  )
    .bind(title, url, type, session.username)
    .run()

  return json({ ok: true, id: result.meta.last_row_id })
}

async function handleDeleteMedia(request, env) {
  const session = await getSession(request, env)
  if (!hasRole(session, 'owner', 'admin', 'mod')) return json({ ok: false, message: 'Forbidden.' }, { status: 403 })

  const reqUrl = new URL(request.url)
  const id = parseInt(reqUrl.pathname.split('/').pop(), 10)
  if (!id) return json({ ok: false, message: 'Invalid media id.' }, { status: 400 })

  await env.DB.prepare(`DELETE FROM media WHERE id = ?`).bind(id).run()
  return json({ ok: true })
}

// --- Content management (admin / mod / owner) ---

async function handleListContent(request, env) {
  const session = await getSession(request, env)
  if (!hasRole(session, 'owner', 'admin', 'mod')) return json({ ok: false, message: 'Forbidden.' }, { status: 403 })

  const { results } = await env.DB.prepare(
    `SELECT id, page, key, value, updated_by, updated_at FROM content ORDER BY page, key`
  ).all()

  return json({ ok: true, content: results })
}

async function handlePutContent(request, env) {
  const session = await getSession(request, env)
  if (!hasRole(session, 'owner', 'admin', 'mod')) return json({ ok: false, message: 'Forbidden.' }, { status: 403 })

  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, message: 'Invalid request body.' }, { status: 400 })
  }

  const page = String(body?.page || '').trim()
  const key = String(body?.key || '').trim()
  const value = String(body?.value ?? '')

  if (!page || !key) {
    return json({ ok: false, message: 'Page and key are required.' }, { status: 400 })
  }

  await env.DB.prepare(
    `INSERT INTO content (page, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(page, key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  )
    .bind(page, key, value, session.username)
    .run()

  return json({ ok: true })
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

  return redirect('/index.html')
}

async function guardOwnerOnlySiteRoute(request, env) {
  const path = new URL(request.url).pathname.toLowerCase()

  if (!OWNER_ONLY_SITE_PATHS.has(path)) {
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

  if (session.role !== 'owner') {
    return redirect('/index.html')
  }

  return null
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/admin/root-login.html') {
      return redirect('/admin/login.html')
    }

    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env)
    }

    if (url.pathname === '/api/logout' && request.method === 'POST') {
      return handleLogout()
    }

    if (url.pathname === '/api/session' && request.method === 'GET') {
      return handleSession(request, env)
    }

    // User management (owner only)
    if (url.pathname === '/api/users' && request.method === 'GET') return handleListUsers(request, env)
    if (url.pathname === '/api/users' && request.method === 'POST') return handleCreateUser(request, env)
    if (/^\/api\/users\/\d+$/.test(url.pathname) && request.method === 'DELETE') return handleDeleteUser(request, env)

    // Media management (admin / mod / owner)
    if (url.pathname === '/api/media' && request.method === 'GET') return handleListMedia(request, env)
    if (url.pathname === '/api/media' && request.method === 'POST') return handleAddMedia(request, env)
    if (/^\/api\/media\/\d+$/.test(url.pathname) && request.method === 'DELETE') return handleDeleteMedia(request, env)

    // Content management (admin / mod / owner)
    if (url.pathname === '/api/content' && request.method === 'GET') return handleListContent(request, env)
    if (url.pathname === '/api/content' && request.method === 'PUT') return handlePutContent(request, env)

    const adminBlockResponse = await guardAdminRoute(request, env)

    if (adminBlockResponse) {
      return adminBlockResponse
    }

    const ownerOnlyBlockResponse = await guardOwnerOnlySiteRoute(request, env)

    if (ownerOnlyBlockResponse) {
      return ownerOnlyBlockResponse
    }

    return env.ASSETS.fetch(request)
  },
}
