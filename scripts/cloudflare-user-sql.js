#!/usr/bin/env node

const crypto = require('crypto')

function parseArg(name) {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)

  if (index === -1) {
    return ''
  }

  return process.argv[index + 1] || ''
}

function validatePasswordStrength(password) {
  return (
    typeof password === 'string' &&
    password.length >= 14 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  )
}

function normalizeRole(role) {
  const value = String(role || '').toLowerCase()
  if (value === 'owner') return 'owner'
  if (value === 'mod') return 'mod'
  return 'admin'
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''")
}

function base64Url(buffer) {
  return buffer.toString('base64url')
}

function createPasswordHash(password, pepper, iterations = 210000) {
  const salt = crypto.randomBytes(16)
  const saltBase64Url = base64Url(salt)
  const hash = crypto.createHash('sha256').update(`${password}${pepper}${saltBase64Url}`).digest()

  return {
    salt: saltBase64Url,
    hash: base64Url(hash),
    iterations,
  }
}

function main() {
  const username = parseArg('username')
  const role = normalizeRole(parseArg('role') || 'admin')
  const password = parseArg('password')
  const pepper = process.env.AUTH_PEPPER || ''

  if (!username) {
    throw new Error('Missing --username argument.')
  }

  if (!password) {
    throw new Error('Missing --password argument.')
  }

  if (!validatePasswordStrength(password)) {
    throw new Error('Password must be 14+ chars and include upper/lower/number/symbol.')
  }

  if (pepper.length < 16) {
    throw new Error('AUTH_PEPPER must be set to a strong random secret (16+ chars).')
  }

  const derived = createPasswordHash(password, pepper)

  const sql = [
    'INSERT INTO users (username, role, password_salt, password_hash, password_iterations)',
    `VALUES ('${escapeSql(username)}', '${role}', '${derived.salt}', '${derived.hash}', ${derived.iterations})`,
    'ON CONFLICT(username) DO UPDATE SET',
    `  role = excluded.role,`,
    `  password_salt = excluded.password_salt,`,
    `  password_hash = excluded.password_hash,`,
    `  password_iterations = excluded.password_iterations;`,
  ].join('\n')

  process.stdout.write(`${sql}\n`)
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
