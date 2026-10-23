import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
// Pages Functions are ES modules even though the site's Node package is CommonJS.
const source = await readFile(new URL('../functions/_lib/login-rate-limit.js', import.meta.url), 'utf8')
const { allowLoginAttempt } = await import('data:text/javascript,' + encodeURIComponent(source))

test('D1-backed login limiter enforces account and IP quotas atomically', async () => {
  const sqlite = new DatabaseSync(':memory:')
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql)
      return {
        run: async () => statement.run(),
        bind(...params) {
          return { first: async () => statement.get(...params), run: async () => statement.run(...params) }
        },
      }
    },
  }
  const env = { DB: db }
  const request = new Request('https://example.test/api/login', {
    headers: { 'CF-Connecting-IP': '198.51.100.5' },
  })
  for (let i = 0; i < 8; i++) {
    assert.equal(await allowLoginAttempt(request, env, 'Alice'), true)
  }
  assert.equal(await allowLoginAttempt(request, env, 'alice'), false)
  // Quota is keyed to account regardless of attacker-supplied capitalization.
  assert.equal(await allowLoginAttempt(request, env, 'ALICE'), false)
  // IP quota also prevents rotating through an unbounded list of usernames.
  for (let i = 0; i < 5; i++) {
    assert.equal(await allowLoginAttempt(request, env, 'new-' + i), true)
  }
  assert.equal(await allowLoginAttempt(request, env, 'new-5'), false)
  sqlite.close()
})
