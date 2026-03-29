const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { addUser, findUserByUsername } = require('../server/userStore')
const { hashPassword, validatePasswordStrength } = require('../server/passwords')

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

function parseArg(name) {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)
  if (index === -1) {
    return ''
  }
  return process.argv[index + 1] || ''
}

function randomPassword() {
  return `${crypto.randomBytes(10).toString('base64url')}!A7`
}

async function main() {
  const username = parseArg('username') || 'owner'
  const role = parseArg('role') || 'owner'
  const suppliedPassword = parseArg('password')
  const password = suppliedPassword || randomPassword()

  if (findUserByUsername(username)) {
    console.error(`User '${username}' already exists.`)
    process.exit(1)
  }

  if (!validatePasswordStrength(password)) {
    console.error('Password is not strong enough. Use 14+ chars with upper/lower/number/symbol.')
    process.exit(1)
  }

  const passwordHash = await hashPassword(password)

  addUser({
    username,
    role,
    passwordHash,
    createdAt: new Date().toISOString(),
  })

  console.log('User created successfully.')
  console.log(`username=${username}`)
  console.log(`password=${password}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
