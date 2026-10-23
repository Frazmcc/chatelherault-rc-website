import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// This repository deploys a Cloudflare Worker (wrangler.toml main=worker.js).
// Run the actual Worker route, not the older unmounted Pages Function.
test('deployed /api/login rejects excess account/IP attempts and prunes stale rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrc-worker-auth-'))
  const sqlite = new DatabaseSync(':memory:')
  try {
    const authSource = await readFile(new URL('../functions/_lib/auth.js', import.meta.url), 'utf8')
    const limiterSource = await readFile(new URL('../functions/_lib/login-rate-limit.js', import.meta.url), 'utf8')
    const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8')
    assert.match(source, /from '\.\/functions\/_lib\/login-rate-limit\.js'/)
    const compiled = source
      .replace("from './functions/_lib/auth.js'", "from './auth.mjs'")
      .replace("from './functions/_lib/login-rate-limit.js'", "from './login-rate-limit.mjs'")
    await writeFile(join(directory, 'auth.mjs'), authSource)
    await writeFile(join(directory, 'login-rate-limit.mjs'), limiterSource)
    await writeFile(join(directory, 'worker.mjs'), compiled)

    const { default: worker } = await import(pathToFileURL(join(directory, 'worker.mjs')).href)

    sqlite.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      role TEXT,
      password_salt TEXT,
      password_hash TEXT,
      password_iterations INTEGER
    );`)
    sqlite.exec(`CREATE TABLE auth_rate_window (
      key TEXT PRIMARY KEY,
      bucket INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    );`)
    sqlite.prepare('INSERT INTO auth_rate_window (key, bucket, attempts) VALUES (?, ?, ?)')
      .run('expired-row', 0, 1)

    const DB = {
      prepare(query) {
        const statement = sqlite.prepare(query)
        return {
          async run() { return statement.run() },
          bind(...values) {
            return {
              async first() { return statement.get(...values) ?? null },
              async all() { return { results: statement.all(...values) } },
              async run() { return statement.run(...values) },
            }
          },
        }
      },
    }
    const env = { DB, AUTH_PEPPER: 'test-pepper', AUTH_SESSION_SECRET: 'test-only-secret' }
    const pending = []
    const ctx = { waitUntil(job) { pending.push(job) } }
    async function attempt(username) {
      const request = new Request('https://chatelheraultrc.com/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
        body: JSON.stringify({ username, password: 'invalid-password' }),
      })
      const result = await worker.fetch(request, env, ctx)
      await Promise.all(pending.splice(0))
      return result
    }

    for (let i = 0; i < 8; i++) {
      assert.equal((await attempt('Alice')).status, 401)
    }
    const accountLimited = await attempt('aLiCe')
    assert.equal(accountLimited.status, 429)
    assert.equal(accountLimited.headers.get('retry-after'), '600')

    for (let i = 0; i < 6; i++) {
      assert.equal((await attempt('unique-account-' + i)).status, 401)
    }
    assert.equal((await attempt('unique-account-6')).status, 429)
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM auth_rate_window WHERE key='expired-row'").get().n, 0)
  } finally {
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
})
