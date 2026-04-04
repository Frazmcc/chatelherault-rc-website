import {
  buildSessionCookie,
  createSessionToken,
  createPasswordRecord,
  shouldUpgradePasswordRecord,
  verifyPassword,
} from '../_lib/auth.js'

function json(data, init = {}) {
  const headers = new Headers(init.headers || {})
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(data), { ...init, headers })
}

async function fakeWork(password, pepper) {
  const data = new TextEncoder().encode(`${password}${pepper || ''}`)
  await crypto.subtle.digest('SHA-256', data)
}

export async function onRequestPost(context) {
  const { request, env } = context

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

  if (shouldUpgradePasswordRecord(user)) {
    const upgraded = await createPasswordRecord(password, env.AUTH_PEPPER)
    await env.DB.prepare(
      `UPDATE users
       SET password_salt = ?, password_hash = ?, password_iterations = ?
       WHERE lower(username) = lower(?)`
    )
      .bind(upgraded.salt, upgraded.hash, upgraded.iterations, user.username)
      .run()
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
