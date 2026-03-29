const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const express = require('express')
const helmet = require('helmet')
const { findUserByUsername } = require('./userStore')
const { verifyPassword } = require('./passwords')

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separator = trimmed.indexOf('=')

    if (separator === -1) {
      continue
    }

    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()

    if (key && !Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value
    }
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'))

const app = express()
const PORT = process.env.PORT || 4173

app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json())
app.use(express.static(path.join(__dirname, '..')))

app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')

    if (!username || !password) {
      return res.status(400).json({ ok: false, message: 'Username and password are required.' })
    }

    const user = findUserByUsername(username)

    if (!user) {
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password))
      return res.status(401).json({ ok: false, message: 'Invalid credentials.' })
    }

    const valid = await verifyPassword(password, user.passwordHash)

    if (!valid) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials.' })
    }

    return res.json({
      ok: true,
      username: user.username,
      role: user.role,
      redirectTo: '/index.html',
    })
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Authentication service error.' })
  }
})

app.listen(PORT, () => {
  console.log(`Secure auth server running at http://localhost:${PORT}`)
})
