// Durable, concurrency-safe Cloudflare D1 login throttling.
// IP buckets prevent username rotation; account+IP buckets slow targeted attempts.
let schemaPromise
let lastPruneWindow = -1
async function initialize(db) {
  if (!schemaPromise) {
    schemaPromise = db.prepare(
      'CREATE TABLE IF NOT EXISTS auth_rate_window (key TEXT PRIMARY KEY, bucket INTEGER NOT NULL, attempts INTEGER NOT NULL)'
    ).run().catch(error => { schemaPromise = undefined; throw error })
  }
  await schemaPromise
}

async function claim(db, key, window, maxAttempts) {
  const row = await db.prepare(
    `INSERT INTO auth_rate_window (key,bucket,attempts) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN bucket = excluded.bucket THEN attempts + 1 ELSE 1 END,
      bucket = excluded.bucket
    RETURNING attempts`
  ).bind(key, window).first()
  return Number(row?.attempts || 0) <= maxAttempts
}

async function sha256(value) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(raw), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function allowLoginAttempt(request, env, username) {
  await initialize(env.DB)
  const window = Math.floor(Date.now() / (10 * 60 * 1000))
  // Remove abandoned account/IP buckets periodically. Otherwise rotating
  // usernames creates permanent D1 rows and can exhaust database storage.
  // Do not purge active quota windows; retain a full day of recent buckets.
  if (window - lastPruneWindow >= 6) {
    await env.DB.prepare('DELETE FROM auth_rate_window WHERE bucket < ?')
      .bind(window - 144)
      .run()
    lastPruneWindow = window
  }
  // CF-Connecting-IP is assigned by Cloudflare's edge. Never trust user
  // provided X-Forwarded-For to choose a separate rate-limit bucket.
  const remote = request.headers.get('CF-Connecting-IP') || 'unknown'
  const ipHash = await sha256(remote)
  const accountHash = await sha256(username.trim().toLowerCase().slice(0, 128))
  // Atomic UPSERT makes concurrent requests count correctly across Workers.
  const ipAllowed = await claim(env.DB, 'ip:' + ipHash, window, 15)
  const accountAllowed = await claim(env.DB, 'account:' + accountHash, window, 8)
  return ipAllowed && accountAllowed
}
