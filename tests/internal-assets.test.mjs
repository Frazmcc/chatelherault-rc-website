import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

test('Worker blocks internal assets, including encoded paths, before the asset binding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crc-assets-'))
  try {
    for (const name of ['auth', 'login-rate-limit']) {
      await writeFile(join(directory, `${name}.mjs`), await readFile(new URL(`../functions/_lib/${name}.js`, import.meta.url), 'utf8'))
    }
    const source = (await readFile(new URL('../worker.js', import.meta.url), 'utf8'))
      .replace("from './functions/_lib/auth.js'", "from './auth.mjs'")
      .replace("from './functions/_lib/login-rate-limit.js'", "from './login-rate-limit.mjs'")
    await writeFile(join(directory, 'worker.mjs'), source)
    const { default: worker } = await import(pathToFileURL(join(directory, 'worker.mjs')).href)
    let assetRequests = 0
    const env = { ASSETS: { fetch() { assetRequests++; return new Response('public asset') } } }
    for (const path of ['/server/server.js', '/%73erver/server.js', '/functions/_lib/auth.js', '/.git/config', '/%2egit/config', '/snapshots/old.html', '/worker.js', '/wrangler.toml', '/package-lock.json', '/data/live-rig-submissions.json']) {
      const response = await worker.fetch(new Request(`https://chatelheraultrc.com${path}`), env, {})
      assert.equal(response.status, 404, path)
    }
    assert.equal(assetRequests, 0)
    const response = await worker.fetch(new Request('https://chatelheraultrc.com/assets/public.css'), env, {})
    assert.equal(response.status, 200)
    assert.equal(assetRequests, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
