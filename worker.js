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

function toBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

async function githubApiRequest(env, path, init = {}) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO_OWNER || !env.GITHUB_REPO_NAME) {
    throw new Error('GitHub sync is not configured.')
  }

  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'chatelherault-rc-worker',
      ...(init.headers || {}),
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub API ${path} failed (${response.status}): ${body.slice(0, 280)}`)
  }

  if (response.status === 204) {
    return null
  }

  return response.json()
}

async function getRepoFileSha(env, path, branch) {
  try {
    const data = await githubApiRequest(
      env,
      `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/contents/${path}?ref=${encodeURIComponent(branch)}`,
      { method: 'GET' }
    )
    return data?.sha || null
  } catch (error) {
    if (String(error).includes('failed (404)')) {
      return null
    }
    throw error
  }
}

async function upsertRepoFile(env, path, content, message, branch) {
  const sha = await getRepoFileSha(env, path, branch)

  const payload = {
    message,
    content: toBase64Utf8(content),
    branch,
  }

  if (sha) {
    payload.sha = sha
  }

  await githubApiRequest(
    env,
    `/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/contents/${path}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    }
  )
}

async function syncLiveEditsToGit(env, meta = {}) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO_OWNER || !env.GITHUB_REPO_NAME) {
    return
  }

  const branch = env.GITHUB_BRANCH || 'main'

  const [contentRows, mediaRows] = await Promise.all([
    env.DB.prepare(
      `SELECT page, key, value, updated_by, updated_at FROM content ORDER BY datetime(updated_at) DESC`
    ).all(),
    env.DB.prepare(
      `SELECT title, url, type, added_by, created_at FROM media ORDER BY datetime(created_at) DESC`
    ).all(),
  ])

  let rigRows = { results: [] }

  try {
    rigRows = await env.DB.prepare(
      `SELECT id, owner_name, chassis_model, battery, upgrades, blog_text, media_items, status, submitted_at, reviewed_by, reviewed_at, review_note
       FROM rig_submissions
       ORDER BY datetime(submitted_at) DESC`
    ).all()
  } catch {
    // Table may not exist yet in older deployments.
  }

  const contentSnapshot = JSON.stringify(
    [
      {
        results: contentRows.results || [],
        generated_at: new Date().toISOString(),
        source: 'cloudflare-d1-live',
      },
    ],
    null,
    2
  )

  const mediaSnapshot = JSON.stringify(
    [
      {
        results: mediaRows.results || [],
        generated_at: new Date().toISOString(),
        source: 'cloudflare-d1-live',
      },
    ],
    null,
    2
  )

  const rigSnapshotRows = (rigRows.results || []).map((row) => {
    let media = []

    try {
      const parsed = JSON.parse(row.media_items || '[]')
      media = Array.isArray(parsed)
        ? parsed.map((item) => ({
            name: item?.name || '',
            type: item?.type || '',
            size: item?.size || 0,
          }))
        : []
    } catch {
      media = []
    }

    return {
      ...row,
      media_items: media,
    }
  })

  const rigSnapshot = JSON.stringify(
    [
      {
        results: rigSnapshotRows,
        generated_at: new Date().toISOString(),
        source: 'cloudflare-d1-live',
      },
    ],
    null,
    2
  )

  const actor = meta.actor || 'unknown'
  const operation = meta.operation || 'edit'
  const pageOrScope = meta.scope || 'site'
  const message = `Sync live ${operation} by ${actor} (${pageOrScope})`

  await Promise.all([
    upsertRepoFile(env, 'data/live-content-overrides.json', contentSnapshot, message, branch),
    upsertRepoFile(env, 'data/live-media-overrides.json', mediaSnapshot, message, branch),
    upsertRepoFile(env, 'data/live-rig-submissions.json', rigSnapshot, message, branch),
  ])
}

function encodeArrayBufferBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

async function ensureRigSubmissionTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS rig_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_name TEXT NOT NULL,
      chassis_model TEXT NOT NULL,
      battery TEXT,
      upgrades TEXT,
      blog_text TEXT,
      media_items TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      submitted_by_ip TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_note TEXT
    )`
  ).run()
}

async function handleCreateRigSubmission(request, env, executionCtx) {
  await ensureRigSubmissionTable(env)

  const form = await request.formData()
  const ownerName = String(form.get('owner') || '').trim()
  const chassisModel = String(form.get('chassisModel') || '').trim()
  const battery = String(form.get('battery') || '').trim()
  const upgrades = String(form.get('upgrades') || '').trim()
  const blogText = String(form.get('blog') || '').trim()

  if (!ownerName || !chassisModel || !blogText) {
    return json({ ok: false, message: 'Owner, Chassis/Model, and Blog are required.' }, { status: 400 })
  }

  const files = form.getAll('media').filter((entry) => entry instanceof File)

  if (files.length > 8) {
    return json({ ok: false, message: 'Maximum of 8 media files per submission.' }, { status: 400 })
  }

  const mediaItems = []
  let totalBytes = 0

  for (const file of files) {
    if (!file.size) {
      continue
    }

    if (!String(file.type).startsWith('image/') && !String(file.type).startsWith('video/')) {
      return json({ ok: false, message: `Unsupported media type: ${file.type || 'unknown'}` }, { status: 400 })
    }

    totalBytes += Number(file.size)

    if (totalBytes > 25 * 1024 * 1024) {
      return json({ ok: false, message: 'Combined media payload is too large. Keep total under 25MB.' }, { status: 413 })
    }

    const buffer = await file.arrayBuffer()
    const base64 = encodeArrayBufferBase64(buffer)

    mediaItems.push({
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl: `data:${file.type || 'application/octet-stream'};base64,${base64}`,
    })
  }

  const result = await env.DB.prepare(
    `INSERT INTO rig_submissions (owner_name, chassis_model, battery, upgrades, blog_text, media_items, status, submitted_by_ip)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      ownerName,
      chassisModel,
      battery,
      upgrades,
      blogText,
      JSON.stringify(mediaItems),
      request.headers.get('cf-connecting-ip') || ''
    )
    .run()

  const syncJob = syncLiveEditsToGit(env, {
    actor: ownerName,
    operation: 'rig submission',
    scope: 'rigs',
  }).catch((error) => console.error('Git sync failed after rig submission:', error))

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(syncJob)
  }

  return json({ ok: true, id: result.meta.last_row_id, status: 'pending' })
}

async function handleListRigSubmissions(request, env) {
  await ensureRigSubmissionTable(env)

  const session = await getSession(request, env)
  if (!hasRole(session, 'owner', 'admin', 'mod')) {
    return json({ ok: false, message: 'Forbidden.' }, { status: 403 })
  }

  const status = new URL(request.url).searchParams.get('status')
  const allowedStatuses = new Set(['pending', 'approved', 'rejected'])

  const query = status && allowedStatuses.has(status)
    ? env.DB.prepare(
        `SELECT id, owner_name, chassis_model, battery, upgrades, blog_text, media_items, status, submitted_at, reviewed_by, reviewed_at, review_note
         FROM rig_submissions
         WHERE status = ?
         ORDER BY datetime(submitted_at) DESC`
      ).bind(status)
    : env.DB.prepare(
        `SELECT id, owner_name, chassis_model, battery, upgrades, blog_text, media_items, status, submitted_at, reviewed_by, reviewed_at, review_note
         FROM rig_submissions
         ORDER BY datetime(submitted_at) DESC`
      )

  const { results } = await query.all()
  return json({ ok: true, submissions: results || [] })
}

async function handleListPublicApprovedRigs(env) {
  await ensureRigSubmissionTable(env)

  const { results } = await env.DB.prepare(
    `SELECT id, owner_name, chassis_model, battery, upgrades, blog_text, media_items, submitted_at
     FROM rig_submissions
     WHERE status = 'approved'
     ORDER BY datetime(submitted_at) DESC`
  ).all()

  return json({ ok: true, rigs: results || [] })
}

async function handleRigSubmissionDecision(request, env, executionCtx) {
  await ensureRigSubmissionTable(env)

  const session = await getSession(request, env)
  if (!hasRole(session, 'owner', 'admin', 'mod')) {
    return json({ ok: false, message: 'Forbidden.' }, { status: 403 })
  }

  const id = Number.parseInt(new URL(request.url).pathname.split('/').slice(-2)[0], 10)
  if (!Number.isFinite(id) || id <= 0) {
    return json({ ok: false, message: 'Invalid submission id.' }, { status: 400 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, message: 'Invalid request body.' }, { status: 400 })
  }

  const decision = String(body?.decision || '').toLowerCase()
  const reviewNote = String(body?.note || '').trim()

  if (!['approved', 'rejected'].includes(decision)) {
    return json({ ok: false, message: 'Decision must be approved or rejected.' }, { status: 400 })
  }

  const existing = await env.DB.prepare(`SELECT id FROM rig_submissions WHERE id = ?`).bind(id).first()
  if (!existing) {
    return json({ ok: false, message: 'Submission not found.' }, { status: 404 })
  }

  await env.DB.prepare(
    `UPDATE rig_submissions
     SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
     WHERE id = ?`
  )
    .bind(decision, session.username, reviewNote, id)
    .run()

  const syncJob = syncLiveEditsToGit(env, {
    actor: session.username,
    operation: `rig ${decision}`,
    scope: 'rigs',
  }).catch((error) => console.error('Git sync failed after rig review:', error))

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(syncJob)
  }

  return json({ ok: true })
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

function normalizeWeatherCode(code) {
  const table = {
    0: 'Clear night',
    1: 'Sunny day',
    2: 'Partly cloudy',
    3: 'Partly cloudy',
    5: 'Mist',
    6: 'Fog',
    7: 'Cloudy',
    8: 'Overcast',
    9: 'Light rain shower',
    10: 'Light rain shower',
    11: 'Drizzle',
    12: 'Light rain',
    13: 'Heavy rain shower',
    14: 'Heavy rain shower',
    15: 'Heavy rain',
    16: 'Sleet shower',
    17: 'Sleet shower',
    18: 'Sleet',
    19: 'Hail shower',
    20: 'Hail shower',
    21: 'Hail',
    22: 'Light snow shower',
    23: 'Light snow shower',
    24: 'Light snow',
    25: 'Heavy snow shower',
    26: 'Heavy snow shower',
    27: 'Heavy snow',
    28: 'Thunder shower',
    29: 'Thunder shower',
    30: 'Thunder',
  }

  return table[Number(code)] || 'Unknown'
}

function formatDateKey(dateLike) {
  return new Date(dateLike).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
}

function pickNumber(...values) {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

async function fetchMetOfficeSeries(url, apiKey) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: apiKey,
      accept: 'application/json',
    },
  })

  if (!response.ok) {
    return null
  }

  const payload = await response.json()
  return payload?.features?.[0]?.properties?.timeSeries || []
}

function normalizeTimeSeriesRows(series) {
  return series
    .map((entry) => {
      const tempC = pickNumber(
        entry?.screenTemperature,
        entry?.airTemperature,
        entry?.feelsLikeTemperature,
        entry?.dayMaxScreenTemperature,
        entry?.dayMinScreenTemperature,
        entry?.maxScreenAirTemp,
        entry?.minScreenAirTemp
      )

      const precipPct = pickNumber(
        entry?.probOfPrecipitation,
        entry?.probabilityOfPrecipitation,
        entry?.dayProbabilityOfPrecipitation,
        entry?.nightProbabilityOfPrecipitation
      )

      const windSpeedRaw = pickNumber(
        entry?.windSpeed10m,
        entry?.windSpeed,
        entry?.dayMax10mWindSpeed,
        entry?.nightMax10mWindSpeed
      )

      const weatherCode =
        entry?.significantWeatherCode ??
        entry?.weatherType ??
        entry?.daySignificantWeatherCode ??
        entry?.nightSignificantWeatherCode

      return {
        time: entry?.time,
        condition: normalizeWeatherCode(weatherCode),
        tempC,
        precipPct,
        windMph: Number.isFinite(Number(windSpeedRaw)) ? Math.round(Number(windSpeedRaw) * 2.23694) : null,
      }
    })
    .filter((row) => Boolean(row.time))
}

function filterRowsForDate(rows, targetDate) {
  return rows
    .filter((row) => formatDateKey(row.time) === targetDate)
    .sort((a, b) => new Date(a.time) - new Date(b.time))
}

async function handleMetOfficeForecast(request, env) {
  if (!env.METOFFICE_API_KEY) {
    return json({ ok: false, message: 'Met Office API key is not configured.' }, { status: 503 })
  }

  const targetDate = new URL(request.url).searchParams.get('targetDate')

  if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return json({ ok: false, message: 'Missing or invalid targetDate (YYYY-MM-DD).' }, { status: 400 })
  }

  const base = 'https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point'
  const buildUrl = (mode) => {
    const endpoint = new URL(`${base}/${mode}`)
    endpoint.searchParams.set('latitude', '55.76278')
    endpoint.searchParams.set('longitude', '-4.010164')
    endpoint.searchParams.set('includeLocationName', 'true')
    return endpoint.toString()
  }

  // 1) Hourly (preferred)
  const hourlySeries = await fetchMetOfficeSeries(buildUrl('hourly'), env.METOFFICE_API_KEY)
  const hourlyRows = Array.isArray(hourlySeries) ? filterRowsForDate(normalizeTimeSeriesRows(hourlySeries), targetDate) : []

  if (hourlyRows.length > 0) {
    return json({ ok: true, resolution: 'hourly', rows: hourlyRows })
  }

  // 2) Three-hourly fallback
  const threeHourlyCandidates = ['three-hourly', '3hourly', 'threehourly']
  let threeHourlyRows = []

  for (const mode of threeHourlyCandidates) {
    const series = await fetchMetOfficeSeries(buildUrl(mode), env.METOFFICE_API_KEY)
    const rows = Array.isArray(series) ? filterRowsForDate(normalizeTimeSeriesRows(series), targetDate) : []
    if (rows.length > 0) {
      threeHourlyRows = rows
      break
    }
  }

  if (threeHourlyRows.length > 0) {
    return json({ ok: true, resolution: 'three-hourly', rows: threeHourlyRows })
  }

  // 3) Daily fallback (entire day summary)
  const dailySeries = await fetchMetOfficeSeries(buildUrl('daily'), env.METOFFICE_API_KEY)
  const dailyRows = Array.isArray(dailySeries) ? filterRowsForDate(normalizeTimeSeriesRows(dailySeries), targetDate) : []

  if (dailyRows.length > 0) {
    return json({ ok: true, resolution: 'daily', rows: dailyRows })
  }

  return json(
    {
      ok: false,
      message: 'No hourly, 3-hourly, or daily forecast entries are available yet for the requested Sunday.',
    },
    { status: 404 }
  )
}

function parseFacebookMemberCount(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return null
  }

  const patterns = [
    /"group_member_count"\s*:\s*"?(\d+)"?/i,
    /"group_members"\s*:\s*"?(\d+)"?/i,
    /([0-9][0-9,\.]*)\s+members/i,
  ]

  for (const pattern of patterns) {
    const match = rawHtml.match(pattern)
    if (!match || !match[1]) {
      continue
    }

    const normalized = match[1].replace(/[^0-9]/g, '')
    const parsed = Number.parseInt(normalized, 10)

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }

  return null
}

async function handleFacebookGroupMembers(request) {
  const groupId = new URL(request.url).searchParams.get('groupId') || '281937597729380'

  if (!/^\d+$/.test(groupId)) {
    return json({ ok: false, message: 'Invalid groupId.' }, { status: 400 })
  }

  const facebookUrl = `https://www.facebook.com/groups/${groupId}/`

  try {
    const response = await fetch(facebookUrl, {
      method: 'GET',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-GB,en;q=0.9',
      },
    })

    const html = await response.text()
    const count = parseFacebookMemberCount(html)

    const headers = new Headers({ 'cache-control': 'public, max-age=900' })

    return json(
      {
        ok: true,
        groupId,
        count,
        source: count ? 'facebook' : 'unavailable',
      },
      { headers }
    )
  } catch {
    return json(
      {
        ok: true,
        groupId,
        count: null,
        source: 'unavailable',
      },
      { headers: { 'cache-control': 'public, max-age=120' } }
    )
  }
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

async function handleAddMedia(request, env, executionCtx) {
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

  const syncJob = syncLiveEditsToGit(env, {
    actor: session.username,
    operation: 'media add',
    scope: 'media',
  }).catch((error) => console.error('Git sync failed after media add:', error))

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(syncJob)
  }

  return json({ ok: true, id: result.meta.last_row_id })
}

async function handleDeleteMedia(request, env, executionCtx) {
  const session = await getSession(request, env)
  if (!hasRole(session, 'owner', 'admin', 'mod')) return json({ ok: false, message: 'Forbidden.' }, { status: 403 })

  const reqUrl = new URL(request.url)
  const id = parseInt(reqUrl.pathname.split('/').pop(), 10)
  if (!id) return json({ ok: false, message: 'Invalid media id.' }, { status: 400 })

  await env.DB.prepare(`DELETE FROM media WHERE id = ?`).bind(id).run()

  const syncJob = syncLiveEditsToGit(env, {
    actor: session.username,
    operation: 'media delete',
    scope: 'media',
  }).catch((error) => console.error('Git sync failed after media delete:', error))

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(syncJob)
  }

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

async function handleListPublicContent(env) {
  const { results } = await env.DB.prepare(
    `SELECT page, key, value FROM content ORDER BY page, key`
  ).all()

  return json({ ok: true, content: results })
}

async function handlePutContent(request, env, executionCtx) {
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

  const syncJob = syncLiveEditsToGit(env, {
    actor: session.username,
    operation: 'content save',
    scope: page,
  }).catch((error) => console.error('Git sync failed after content save:', error))

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(syncJob)
  }

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
  async fetch(request, env, executionCtx) {
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

    if (url.pathname === '/api/metoffice-forecast' && request.method === 'GET') {
      return handleMetOfficeForecast(request, env)
    }

    if (url.pathname === '/api/facebook-group-members' && request.method === 'GET') {
      return handleFacebookGroupMembers(request)
    }

    if (url.pathname === '/api/rig-submissions' && request.method === 'POST') {
      return handleCreateRigSubmission(request, env, executionCtx)
    }

    if (url.pathname === '/api/rig-submissions' && request.method === 'GET') {
      return handleListRigSubmissions(request, env)
    }

    if (url.pathname === '/api/rig-submissions-public' && request.method === 'GET') {
      return handleListPublicApprovedRigs(env)
    }

    if (/^\/api\/rig-submissions\/\d+\/decision$/.test(url.pathname) && request.method === 'POST') {
      return handleRigSubmissionDecision(request, env, executionCtx)
    }

    // User management (owner only)
    if (url.pathname === '/api/users' && request.method === 'GET') return handleListUsers(request, env)
    if (url.pathname === '/api/users' && request.method === 'POST') return handleCreateUser(request, env)
    if (/^\/api\/users\/\d+$/.test(url.pathname) && request.method === 'DELETE') return handleDeleteUser(request, env)

    // Media management (admin / mod / owner)
    if (url.pathname === '/api/media' && request.method === 'GET') return handleListMedia(request, env)
    if (url.pathname === '/api/media' && request.method === 'POST') return handleAddMedia(request, env, executionCtx)
    if (/^\/api\/media\/\d+$/.test(url.pathname) && request.method === 'DELETE') return handleDeleteMedia(request, env, executionCtx)

    // Public content read for page rendering overrides
    if (url.pathname === '/api/content-public' && request.method === 'GET') return handleListPublicContent(env)

    // Content management (admin / mod / owner)
    if (url.pathname === '/api/content' && request.method === 'GET') return handleListContent(request, env)
    if (url.pathname === '/api/content' && request.method === 'PUT') return handlePutContent(request, env, executionCtx)

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
