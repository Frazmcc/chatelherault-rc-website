import {
  buildClearedSessionCookie,
  buildSessionCookie,
  createPasswordRecord,
  createSessionToken,
  getSessionCookieName,
  parseCookies,
  shouldUpgradePasswordRecord,
  verifyPassword,
  verifySessionToken,
} from './functions/_lib/auth.js'

const PUBLIC_ADMIN_PATHS = new Set(['/admin/login', '/admin/login.html', '/admin/root-login.html'])
const OWNER_ONLY_SITE_PATHS = new Set([
  '/pages/super-user.html',
  '/pages/super-user',
  '/super-user.html',
  '/super-user',
])
const LOGIN_RATE_LIMIT_WINDOW_SECONDS = 5 * 60
const LOGIN_RATE_LIMIT_MAX_REQUESTS = 10
const RIG_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS = 60 * 60
const RIG_SUBMISSION_RATE_LIMIT_MAX_REQUESTS = 6

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'content-security-policy-report-only':
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://challenges.cloudflare.com; connect-src 'self' https:; frame-src 'self' https:",
}

function json(data, init = {}) {
  const headers = new Headers(init.headers || {})
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(data), { ...init, headers })
}

function applySecurityHeaders(response) {
  const headers = new Headers(response.headers)

  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function getClientIp(request) {
  const cfIp = request.headers.get('cf-connecting-ip')
  if (cfIp) {
    return cfIp.trim()
  }

  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0].trim()
  }

  return 'unknown'
}

async function ensureRateLimitTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS request_rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    )`
  ).run()
}

async function enforceRateLimit(env, key, windowSeconds, maxRequests) {
  await ensureRateLimitTable(env)

  const now = Math.floor(Date.now() / 1000)
  const row = await env.DB.prepare(`SELECT count, reset_at FROM request_rate_limits WHERE key = ?`).bind(key).first()

  if (!row || Number(row.reset_at) <= now) {
    await env.DB.prepare(
      `INSERT INTO request_rate_limits (key, count, reset_at)
       VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`
    )
      .bind(key, now + windowSeconds)
      .run()

    return { allowed: true, remaining: Math.max(maxRequests - 1, 0), retryAfter: windowSeconds }
  }

  const count = Number(row.count) || 0
  const resetAt = Number(row.reset_at) || now + windowSeconds
  const retryAfter = Math.max(resetAt - now, 1)

  if (count >= maxRequests) {
    return { allowed: false, remaining: 0, retryAfter }
  }

  const nextCount = count + 1

  await env.DB.prepare(`UPDATE request_rate_limits SET count = ? WHERE key = ?`)
    .bind(nextCount, key)
    .run()

  return { allowed: true, remaining: Math.max(maxRequests - nextCount, 0), retryAfter }
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

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

async function verifyTurnstileToken(token, request, env) {
  if (!env.TURNSTILE_SECRET) {
    return { ok: true }
  }

  if (!token) {
    return { ok: false, message: 'Please complete the security check.' }
  }

  const payload = new URLSearchParams()
  payload.set('secret', env.TURNSTILE_SECRET)
  payload.set('response', token)

  const connectingIp = request.headers.get('CF-Connecting-IP')

  if (connectingIp) {
    payload.set('remoteip', connectingIp)
  }

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: payload.toString(),
  })

  if (!response.ok) {
    return { ok: false, message: 'Security validation failed. Please try again.' }
  }

  const data = await response.json().catch(() => null)

  if (!data?.success) {
    return { ok: false, message: 'Security validation failed. Please try again.' }
  }

  return { ok: true }
}

function handleContactConfig(env) {
  return json({
    ok: true,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
    turnstileEnabled: Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET),
  })
}

async function sendContactEmailViaResend({ env, recipientEmail, fromEmail, email, name, subject, plainText, htmlBody }) {
  if (!env.RESEND_API_KEY) {
    return { attempted: false, ok: false, provider: 'resend', details: 'RESEND_API_KEY is not configured.' }
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      from: `Chatelherault RC Website <${fromEmail}>`,
      to: [recipientEmail],
      reply_to: email,
      subject: `Contact Form: ${subject}`,
      text: plainText,
      html: htmlBody,
    }),
  })

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    return {
      attempted: true,
      ok: false,
      provider: 'resend',
      details: `status=${response.status}; details=${details.slice(0, 500)}`,
    }
  }

  return { attempted: true, ok: true, provider: 'resend', details: null }
}

async function sendContactEmailViaMailChannels({ env, recipientEmail, fromEmail, email, name, subject, plainText, htmlBody }) {
  if (!env.MAILCHANNELS_API_KEY) {
    return {
      attempted: false,
      ok: false,
      provider: 'mailchannels',
      details: 'MAILCHANNELS_API_KEY is not configured.',
    }
  }

  const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.MAILCHANNELS_API_KEY}`,
      'x-api-key': env.MAILCHANNELS_API_KEY,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: recipientEmail }] }],
      from: {
        email: fromEmail,
        name: 'Chatelherault RC Website',
      },
      reply_to: { email, name },
      subject: `Contact Form: ${subject}`,
      content: [
        { type: 'text/plain', value: plainText },
        { type: 'text/html', value: htmlBody },
      ],
    }),
  })

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    return {
      attempted: true,
      ok: false,
      provider: 'mailchannels',
      details: `status=${response.status}; details=${details.slice(0, 500)}`,
    }
  }

  return { attempted: true, ok: true, provider: 'mailchannels', details: null }
}

async function handleContactSubmission(request, env) {
  let body

  try {
    body = await request.json()
  } catch {
    return json({ ok: false, message: 'Invalid request body.' }, { status: 400 })
  }

  const name = String(body?.name || '').trim()
  const email = String(body?.email || '').trim()
  const subject = String(body?.subject || '').trim()
  const message = String(body?.message || '').trim()
  const turnstileToken = String(body?.turnstileToken || '').trim()

  if (!name || !email || !subject || !message) {
    return json({ ok: false, message: 'Name, email, subject, and message are required.' }, { status: 400 })
  }

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return json({ ok: false, message: 'Please enter a valid email address.' }, { status: 400 })
  }

  const turnstile = await verifyTurnstileToken(turnstileToken, request, env)

  if (!turnstile.ok) {
    return json({ ok: false, message: turnstile.message }, { status: 400 })
  }

  const recipientEmail = env.CONTACT_EMAIL || 'contact@chatelheraultrc.com'
  const fromEmail = env.CONTACT_FROM_EMAIL || recipientEmail

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS contact_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivery_status TEXT NOT NULL DEFAULT 'received',
      delivery_error TEXT
    )`
  ).run()

  const parsedDailyLimit = Number.parseInt(String(env.CONTACT_DAILY_LIMIT || '50'), 10)
  const dailyLimit = Number.isFinite(parsedDailyLimit) && parsedDailyLimit > 0 ? parsedDailyLimit : 50

  const todayCountRow = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM contact_submissions WHERE date(created_at) = date('now')`
  ).first()

  const todayCount = Number(todayCountRow?.count || 0)

  if (todayCount >= dailyLimit) {
    return json(
      {
        ok: false,
        message: 'Daily contact limit reached. Please try again tomorrow or email us directly at contact@chatelheraultrc.com.',
      },
      { status: 429 }
    )
  }

  const insertResult = await env.DB.prepare(
    `INSERT INTO contact_submissions (name, email, subject, message, delivery_status)
     VALUES (?, ?, ?, ?, 'received')`
  )
    .bind(name, email, subject, message)
    .run()

  const submissionId = insertResult?.meta?.last_row_id || null

  const plainText = [
    'New contact form submission',
    `Name: ${name}`,
    `Email: ${email}`,
    `Subject: ${subject}`,
    '',
    message,
  ].join('\n')

  const htmlBody = `
    <h2>New contact form submission</h2>
    <p><strong>Name:</strong> ${escapeHtml(name)}</p>
    <p><strong>Email:</strong> ${escapeHtml(email)}</p>
    <p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
    <p><strong>Message:</strong></p>
    <p>${escapeHtml(message).replaceAll('\n', '<br/>')}</p>
  `

  const resendResult = await sendContactEmailViaResend({
    env,
    recipientEmail,
    fromEmail,
    email,
    name,
    subject,
    plainText,
    htmlBody,
  })

  const shouldTryMailChannelsFallback = !resendResult.ok && Boolean(env.MAILCHANNELS_API_KEY)

  const deliveryResult = shouldTryMailChannelsFallback
    ? await sendContactEmailViaMailChannels({
        env,
        recipientEmail,
        fromEmail,
        email,
        name,
        subject,
        plainText,
        htmlBody,
      })
    : resendResult

  if (!deliveryResult.ok) {
    console.error('Mail delivery failed:', deliveryResult.provider, deliveryResult.details)

    if (submissionId) {
      await env.DB.prepare(
        `UPDATE contact_submissions SET delivery_status = 'email_failed', delivery_error = ? WHERE id = ?`
      )
        .bind(`${deliveryResult.provider}: ${deliveryResult.details}`, submissionId)
        .run()
    }

    return json({ ok: true, queued: true })
  }

  if (submissionId) {
    await env.DB.prepare(
      `UPDATE contact_submissions SET delivery_status = 'emailed', delivery_error = NULL WHERE id = ?`
    )
      .bind(submissionId)
      .run()
  }

  return json({ ok: true })
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

  const rigSubmitLimit = await enforceRateLimit(
    env,
    `rig-submit:${getClientIp(request)}`,
    RIG_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS,
    RIG_SUBMISSION_RATE_LIMIT_MAX_REQUESTS
  )

  if (!rigSubmitLimit.allowed) {
    const headers = new Headers({ 'retry-after': String(rigSubmitLimit.retryAfter) })
    return json(
      {
        ok: false,
        message: 'Too many submissions from this network. Please try again later.',
      },
      { status: 429, headers }
    )
  }

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

function permanentRedirect(location) {
  return new Response(null, {
    status: 301,
    headers: { location },
  })
}

async function ensureSiteStatsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS site_stats (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run()
}

async function incrementSiteHitCount(env) {
  await ensureSiteStatsTable(env)

  await env.DB.prepare(
    `INSERT INTO site_stats (key, value, updated_at)
     VALUES ('site_hits', 1, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = site_stats.value + 1,
       updated_at = datetime('now')`
  ).run()
}

async function getSiteHitCount(env) {
  await ensureSiteStatsTable(env)

  const row = await env.DB.prepare(`SELECT value FROM site_stats WHERE key = 'site_hits'`).first()
  return Number(row?.value || 0)
}

function shouldTrackHit(request, response, url) {
  const pathname = url.pathname

  if (request.method !== 'GET') return false
  if (pathname.startsWith('/api/')) return false
  if (pathname.startsWith('/assets/')) return false

  if (url.hostname.toLowerCase() !== 'chatelheraultrc.com') return false

  if (request.cf?.botManagement?.verifiedBot) return false

  const userAgent = String(request.headers.get('user-agent') || '').toLowerCase()
  if (!userAgent) return false

  const obviousBotUa = /(bot|crawler|spider|slurp|lighthouse|headless|facebookexternalhit|whatsapp|discordbot|telegrambot|linkedinbot|curl|wget|python-requests)/i
  if (obviousBotUa.test(userAgent)) return false

  const secFetchDest = String(request.headers.get('sec-fetch-dest') || '').toLowerCase()
  if (secFetchDest && secFetchDest !== 'document') return false

  const secFetchMode = String(request.headers.get('sec-fetch-mode') || '').toLowerCase()
  if (secFetchMode && secFetchMode !== 'navigate') return false

  const purposeHeaders = [
    String(request.headers.get('purpose') || ''),
    String(request.headers.get('x-purpose') || ''),
    String(request.headers.get('sec-purpose') || ''),
  ]
    .join(' ')
    .toLowerCase()

  if (purposeHeaders.includes('prefetch') || purposeHeaders.includes('preview')) return false

  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  if (!contentType.includes('text/html')) return false

  return response.status >= 200 && response.status < 300
}

function getCanonicalPublicPath(pathname) {
  const normalized = pathname.toLowerCase()
  const canonicalMap = {
    '/index.html': '/',
    '/pages/contact': '/contact',
    '/pages/contact.html': '/contact',
    '/pages/media': '/media',
    '/pages/media.html': '/media',
    '/pages/meetups': '/meetups',
    '/pages/meetups.html': '/meetups',
    '/pages/spotlight': '/spotlight',
    '/pages/spotlight.html': '/spotlight',
    '/pages/register-rig': '/register-rig',
    '/pages/register-rig.html': '/register-rig',
    '/pages/members-rigs': '/members-rigs',
    '/pages/members-rigs.html': '/members-rigs',
    '/pages/rig-approvals': '/rig-approvals',
    '/pages/rig-approvals.html': '/rig-approvals',
    '/pages/super-user': '/super-user',
    '/pages/super-user.html': '/super-user',
    '/pages/grounds': '/grounds',
    '/pages/grounds.html': '/grounds',
    '/pages/sponsors': '/sponsors',
    '/pages/sponsors.html': '/sponsors',
    '/pages/privacy-policy': '/privacy-policy',
    '/pages/privacy-policy.html': '/privacy-policy',
    '/pages/privacy-protocol': '/privacy-protocol',
    '/pages/privacy-protocol.html': '/privacy-protocol',
    '/pages/safety-guidelines': '/safety-guidelines',
    '/pages/safety-guidelines.html': '/safety-guidelines',
    '/pages/terms-of-service': '/terms-of-service',
    '/pages/terms-of-service.html': '/terms-of-service',
  }

  return canonicalMap[normalized] || null
}

async function fakeWork(password, pepper) {
  const data = new TextEncoder().encode(`${password}${pepper || ''}`)
  await crypto.subtle.digest('SHA-256', data)
}

async function ensureLoginAuditTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS login_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      ip_address TEXT,
      local_address TEXT,
      user_agent TEXT,
      country TEXT,
      region TEXT,
      city TEXT,
      timezone TEXT,
      latitude REAL,
      longitude REAL,
      client_latitude REAL,
      client_longitude REAL,
      client_accuracy_m REAL,
      client_altitude_m REAL,
      client_altitude_accuracy_m REAL,
      client_location_label TEXT,
      client_postcode TEXT,
      client_fix_source TEXT,
      client_sample_count INTEGER,
      client_best_accuracy_m REAL,
      browser_telemetry_json TEXT,
      outcome TEXT NOT NULL DEFAULT 'success',
      failure_reason TEXT,
      attempted_username TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run()

  const schemaMigrations = [
    `ALTER TABLE login_audit ADD COLUMN outcome TEXT NOT NULL DEFAULT 'success'`,
    `ALTER TABLE login_audit ADD COLUMN failure_reason TEXT`,
    `ALTER TABLE login_audit ADD COLUMN attempted_username TEXT`,
    `ALTER TABLE login_audit ADD COLUMN client_altitude_m REAL`,
    `ALTER TABLE login_audit ADD COLUMN client_altitude_accuracy_m REAL`,
    `ALTER TABLE login_audit ADD COLUMN client_location_label TEXT`,
    `ALTER TABLE login_audit ADD COLUMN client_postcode TEXT`,
    `ALTER TABLE login_audit ADD COLUMN client_fix_source TEXT`,
    `ALTER TABLE login_audit ADD COLUMN client_sample_count INTEGER`,
    `ALTER TABLE login_audit ADD COLUMN client_best_accuracy_m REAL`,
    `ALTER TABLE login_audit ADD COLUMN browser_telemetry_json TEXT`,
  ]

  for (const sql of schemaMigrations) {
    try {
      await env.DB.prepare(sql).run()
    } catch {
      // Ignore duplicate-column errors on existing deployments.
    }
  }
}

function toFiniteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

async function reverseGeocodeClientLocation(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { label: null, postcode: null }
  }

  try {
    const endpoint = new URL('https://nominatim.openstreetmap.org/reverse')
    endpoint.searchParams.set('format', 'jsonv2')
    endpoint.searchParams.set('lat', String(latitude))
    endpoint.searchParams.set('lon', String(longitude))
    endpoint.searchParams.set('zoom', '18')
    endpoint.searchParams.set('addressdetails', '1')

    const response = await fetch(endpoint.toString(), {
      method: 'GET',
      headers: {
        'accept-language': 'en-GB,en;q=0.9',
        'user-agent': 'chatelherault-rc-worker/1.0',
      },
    })

    if (!response.ok) {
      return { label: null, postcode: null }
    }

    const payload = await response.json()
    const label = String(payload?.display_name || '').trim().slice(0, 300)
    const postcode = String(payload?.address?.postcode || '').trim().slice(0, 32)

    return {
      label: label || null,
      postcode: postcode || null,
    }
  } catch {
    return { label: null, postcode: null }
  }
}

async function writeLoginAudit(env, request, entry, telemetry) {
  await ensureLoginAuditTable(env)

  const clientIp = getClientIp(request)
  const cfMeta = request.cf || {}
  const t = telemetry && typeof telemetry === 'object' ? telemetry : {}

  const latitude = toFiniteNumber(cfMeta.latitude)
  const longitude = toFiniteNumber(cfMeta.longitude)
  const clientLatitude = toFiniteNumber(t.latitude)
  const clientLongitude = toFiniteNumber(t.longitude)
  const clientAccuracy = toFiniteNumber(t.accuracy)
  const clientAltitude = toFiniteNumber(t.altitude)
  const clientAltitudeAccuracy = toFiniteNumber(t.altitudeAccuracy)
  const clientFixSource = String(t.fixSource || '').trim().slice(0, 120)
  const clientSampleCount = toFiniteNumber(t.sampleCount)
  const clientBestAccuracy = toFiniteNumber(t.bestAccuracyM)
  let browserTelemetryJson = null

  if (t.browser && typeof t.browser === 'object') {
    try {
      browserTelemetryJson = JSON.stringify(t.browser).slice(0, 12000)
    } catch {
      browserTelemetryJson = null
    }
  }

  const preciseLocation = await reverseGeocodeClientLocation(clientLatitude, clientLongitude)

  const localAddress = String(t.publicAddress || t.localAddress || '').trim().slice(0, 120)
  const userAgent = String(request.headers.get('user-agent') || '').slice(0, 512)
  const username = String(entry?.username || entry?.attemptedUsername || 'unknown').trim().slice(0, 64) || 'unknown'
  const role = String(entry?.role || 'unknown').trim().slice(0, 32) || 'unknown'
  const outcome = String(entry?.outcome || 'success').toLowerCase() === 'failed' ? 'failed' : 'success'
  const failureReason = String(entry?.failureReason || '').trim().slice(0, 160)
  const attemptedUsername = String(entry?.attemptedUsername || '').trim().slice(0, 64)

  await env.DB.prepare(
    `INSERT INTO login_audit (
      username,
      role,
      ip_address,
      local_address,
      user_agent,
      country,
      region,
      city,
      timezone,
      latitude,
      longitude,
      client_latitude,
      client_longitude,
      client_accuracy_m,
      client_altitude_m,
      client_altitude_accuracy_m,
      client_location_label,
      client_postcode,
      client_fix_source,
      client_sample_count,
      client_best_accuracy_m,
      browser_telemetry_json,
      outcome,
      failure_reason,
      attempted_username
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      username,
      role,
      clientIp,
      localAddress || null,
      userAgent || null,
      String(cfMeta.country || '').slice(0, 64) || null,
      String(cfMeta.region || '').slice(0, 128) || null,
      String(cfMeta.city || '').slice(0, 128) || null,
      String(cfMeta.timezone || '').slice(0, 128) || null,
      latitude,
      longitude,
      clientLatitude,
      clientLongitude,
      clientAccuracy,
      clientAltitude,
      clientAltitudeAccuracy,
      preciseLocation.label,
      preciseLocation.postcode,
      clientFixSource || null,
      clientSampleCount,
      clientBestAccuracy,
      browserTelemetryJson,
      outcome,
      failureReason || null,
      attemptedUsername || null
    )
    .run()
}

async function handleLogin(request, env, executionCtx) {
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
  const telemetry = body?.telemetry

  async function recordAudit(entry) {
    const job = writeLoginAudit(env, request, entry, telemetry).catch((error) => {
      console.error('Login audit write failed:', error)
    })

    if (executionCtx?.waitUntil) {
      executionCtx.waitUntil(job)
      return
    }

    await job
  }

  if (!username || !password) {
    await recordAudit({
      username: username || 'unknown',
      role: 'unknown',
      outcome: 'failed',
      failureReason: 'missing credentials',
      attemptedUsername: username || null,
    })
    return json({ ok: false, message: 'Username and password are required.' }, { status: 400 })
  }

  const { results: users } = await env.DB.prepare(
    `SELECT id, username, role, password_salt, password_hash, password_iterations
     FROM users
     WHERE lower(username) = lower(?)
     ORDER BY
       CASE WHEN username = ? THEN 0 ELSE 1 END,
       CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'mod' THEN 2 ELSE 3 END,
       id DESC
     LIMIT 20`
  )
    .bind(username, username)
    .all()

  if (!users || !users.length) {
    await fakeWork(password, env.AUTH_PEPPER)
    await recordAudit({
      username,
      role: 'unknown',
      outcome: 'failed',
      failureReason: 'invalid credentials',
      attemptedUsername: username,
    })
    return json({ ok: false, message: 'Invalid credentials.' }, { status: 401 })
  }

  let matchedUser = null

  for (const candidate of users) {
    const valid = await verifyPassword(password, candidate, env.AUTH_PEPPER)
    if (valid) {
      matchedUser = candidate
      break
    }
  }

  if (!matchedUser) {
    await recordAudit({
      username,
      role: 'unknown',
      outcome: 'failed',
      failureReason: 'invalid credentials',
      attemptedUsername: username,
    })
    return json({ ok: false, message: 'Invalid credentials.' }, { status: 401 })
  }

  if (shouldUpgradePasswordRecord(matchedUser)) {
    const upgraded = await createPasswordRecord(password, env.AUTH_PEPPER)
    await env.DB.prepare(
      `UPDATE users
       SET password_salt = ?, password_hash = ?, password_iterations = ?
       WHERE id = ?`
    )
      .bind(upgraded.salt, upgraded.hash, upgraded.iterations, matchedUser.id)
      .run()
  }

  await recordAudit({
    username: matchedUser.username,
    role: matchedUser.role,
    outcome: 'success',
    attemptedUsername: username,
  })

  const token = await createSessionToken({ username: matchedUser.username, role: matchedUser.role }, env)
  const headers = new Headers()
  headers.append('set-cookie', buildSessionCookie(token, env))

  return json(
    {
      ok: true,
      username: matchedUser.username,
      role: matchedUser.role,
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

async function handleListContactSubmissions(request, env) {
  const session = await getSession(request, env)
  if (!hasRole(session, 'owner')) return json({ ok: false, message: 'Forbidden.' }, { status: 403 })

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS contact_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivery_status TEXT NOT NULL DEFAULT 'received',
      delivery_error TEXT
    )`
  ).run()

  const { results } = await env.DB.prepare(
    `SELECT id, name, email, subject, message, created_at, delivery_status, delivery_error
     FROM contact_submissions
     ORDER BY datetime(created_at) DESC
     LIMIT 200`
  ).all()

  return json({ ok: true, submissions: results || [] })
}

async function handleListLoginAudit(request, env) {
  const session = await getSession(request, env)
  if (!hasRole(session, 'owner')) return json({ ok: false, message: 'Forbidden.' }, { status: 403 })

  await ensureLoginAuditTable(env)

  const { results } = await env.DB.prepare(
    `SELECT
      id,
      username,
      role,
      outcome,
      failure_reason,
      attempted_username,
      ip_address,
      local_address,
      country,
      region,
      city,
      timezone,
      latitude,
      longitude,
      client_latitude,
      client_longitude,
      client_accuracy_m,
      client_altitude_m,
      client_altitude_accuracy_m,
      client_location_label,
      client_postcode,
      client_fix_source,
      client_sample_count,
      client_best_accuracy_m,
      browser_telemetry_json,
      created_at
     FROM login_audit
     ORDER BY id DESC
     LIMIT 300`
  ).all()

  return json({ ok: true, logins: results || [] })
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
    return redirect('/admin/login')
  }

  const session = await verifySessionToken(token, env)

  if (!session) {
    return redirect('/admin/login', true)
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
    return redirect('/admin/login')
  }

  const session = await verifySessionToken(token, env)

  if (!session) {
    return redirect('/admin/login', true)
  }

  if (session.role !== 'owner') {
    return redirect('/index.html')
  }

  return null
}

function mapRootPagePath(pathname) {
  const normalized = pathname.toLowerCase()
  const pageMap = {
    '/contact': '/pages/contact',
    '/contact.html': '/pages/contact',
    '/media': '/pages/media',
    '/media.html': '/pages/media',
    '/meetups': '/pages/meetups',
    '/meetups.html': '/pages/meetups',
    '/spotlight': '/pages/spotlight',
    '/spotlight.html': '/pages/spotlight',
    '/register-rig': '/pages/register-rig',
    '/register-rig.html': '/pages/register-rig',
    '/members-rigs': '/pages/members-rigs',
    '/members-rigs.html': '/pages/members-rigs',
    '/rig-approvals': '/pages/rig-approvals',
    '/rig-approvals.html': '/pages/rig-approvals',
    '/super-user': '/pages/super-user',
    '/super-user.html': '/pages/super-user',
    '/grounds': '/pages/grounds',
    '/grounds.html': '/pages/grounds',
    '/sponsors': '/pages/sponsors',
    '/sponsors.html': '/pages/sponsors',
    '/privacy-policy': '/pages/privacy-policy',
    '/privacy-policy.html': '/pages/privacy-policy',
    '/privacy-protocol': '/pages/privacy-protocol',
    '/privacy-protocol.html': '/pages/privacy-protocol',
    '/safety-guidelines': '/pages/safety-guidelines',
    '/safety-guidelines.html': '/pages/safety-guidelines',
    '/terms-of-service': '/pages/terms-of-service',
    '/terms-of-service.html': '/pages/terms-of-service',
  }

  return pageMap[normalized] || null
}

export default {
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url)
    let response

    if (url.hostname.toLowerCase() !== 'chatelheraultrc.com') {
      const apex = new URL(url.toString())
      apex.hostname = 'chatelheraultrc.com'
      return applySecurityHeaders(permanentRedirect(apex.toString()))
    }

    const canonicalPath = getCanonicalPublicPath(url.pathname)
    if (canonicalPath && canonicalPath !== url.pathname) {
      const target = `${url.origin}${canonicalPath}${url.search}`
      return applySecurityHeaders(permanentRedirect(target))
    }

    if (url.pathname === '/admin/root-login.html') {
      response = redirect('/admin/login')
      return applySecurityHeaders(response)
    }

    if (url.pathname === '/api/login' && request.method === 'POST') {
      response = await handleLogin(request, env, executionCtx)
      return applySecurityHeaders(response)
    }

    if (url.pathname === '/api/logout' && request.method === 'POST') {
      response = handleLogout()
      return applySecurityHeaders(response)
    }

    if (url.pathname === '/api/session' && request.method === 'GET') {
      response = await handleSession(request, env)
      return applySecurityHeaders(response)
    }

    if (url.pathname === '/api/metoffice-forecast' && request.method === 'GET') {
      response = await handleMetOfficeForecast(request, env)
      return applySecurityHeaders(response)
    }

    if (url.pathname === '/api/contact-config' && request.method === 'GET') {
      response = handleContactConfig(env)
      return applySecurityHeaders(response)
    }

    if (url.pathname === '/api/contact' && request.method === 'POST') {
      response = await handleContactSubmission(request, env)
      return applySecurityHeaders(response)
    }

    if (url.pathname === '/api/facebook-group-members' && request.method === 'GET') {
      response = await handleFacebookGroupMembers(request)
      return applySecurityHeaders(response)
    }

    if (/^\/api\/hit-counter\/?$/.test(url.pathname) && request.method === 'GET') {
      const count = await getSiteHitCount(env)
      response = json(
        { ok: true, count },
        {
          headers: {
            'cache-control': 'no-store, no-cache, must-revalidate',
          },
        }
      )
      return applySecurityHeaders(response)
    }

    if (url.pathname === '/api/rig-submissions' && request.method === 'POST') {
      response = await handleCreateRigSubmission(request, env, executionCtx)
      return applySecurityHeaders(response)
    }

    if (url.pathname === '/api/rig-submissions' && request.method === 'GET') {
      response = await handleListRigSubmissions(request, env)
      return applySecurityHeaders(response)
    }

    if (url.pathname === '/api/rig-submissions-public' && request.method === 'GET') {
      response = await handleListPublicApprovedRigs(env)
      return applySecurityHeaders(response)
    }

    if (/^\/api\/rig-submissions\/\d+\/decision$/.test(url.pathname) && request.method === 'POST') {
      response = await handleRigSubmissionDecision(request, env, executionCtx)
      return applySecurityHeaders(response)
    }

    // User management (owner only)
    if (url.pathname === '/api/users' && request.method === 'GET') return applySecurityHeaders(await handleListUsers(request, env))
    if (url.pathname === '/api/users' && request.method === 'POST') return applySecurityHeaders(await handleCreateUser(request, env))
    if (/^\/api\/users\/\d+$/.test(url.pathname) && request.method === 'DELETE') return applySecurityHeaders(await handleDeleteUser(request, env))
    if (url.pathname === '/api/contact-submissions' && request.method === 'GET') return applySecurityHeaders(await handleListContactSubmissions(request, env))
    if (url.pathname === '/api/login-audit' && request.method === 'GET') return applySecurityHeaders(await handleListLoginAudit(request, env))

    // Media management (admin / mod / owner)
    if (url.pathname === '/api/media' && request.method === 'GET') return applySecurityHeaders(await handleListMedia(request, env))
    if (url.pathname === '/api/media' && request.method === 'POST') return applySecurityHeaders(await handleAddMedia(request, env, executionCtx))
    if (/^\/api\/media\/\d+$/.test(url.pathname) && request.method === 'DELETE') return applySecurityHeaders(await handleDeleteMedia(request, env, executionCtx))

    // Public content read for page rendering overrides
    if (url.pathname === '/api/content-public' && request.method === 'GET') return applySecurityHeaders(await handleListPublicContent(env))

    // Content management (admin / mod / owner)
    if (url.pathname === '/api/content' && request.method === 'GET') return applySecurityHeaders(await handleListContent(request, env))
    if (url.pathname === '/api/content' && request.method === 'PUT') return applySecurityHeaders(await handlePutContent(request, env, executionCtx))

    const adminBlockResponse = await guardAdminRoute(request, env)

    if (adminBlockResponse) {
      return applySecurityHeaders(adminBlockResponse)
    }

    const ownerOnlyBlockResponse = await guardOwnerOnlySiteRoute(request, env)

    if (ownerOnlyBlockResponse) {
      return applySecurityHeaders(ownerOnlyBlockResponse)
    }

    const mappedPath = mapRootPagePath(url.pathname)

    if (mappedPath) {
      const rewrittenUrl = new URL(request.url)
      rewrittenUrl.pathname = mappedPath
      response = await env.ASSETS.fetch(new Request(rewrittenUrl.toString(), request))

      if (shouldTrackHit(request, response, url)) {
        await incrementSiteHitCount(env).catch((error) => {
          console.error('Failed to increment site hit counter:', error)
        })
      }

      return applySecurityHeaders(response)
    }

    response = await env.ASSETS.fetch(request)

    if (shouldTrackHit(request, response, url)) {
      await incrementSiteHitCount(env).catch((error) => {
        console.error('Failed to increment site hit counter:', error)
      })
    }

    return applySecurityHeaders(response)
  },
}
