const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { hash, Algorithm } = require('@node-rs/argon2')

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env')

  if (!fs.existsSync(envPath)) {
    const pepper = crypto.randomBytes(48).toString('hex')
    fs.writeFileSync(envPath, `AUTH_PEPPER=${pepper}\nPORT=4173\n`, 'utf8')
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const i = trimmed.indexOf('=')
    if (i === -1) {
      continue
    }

    const key = trimmed.slice(0, i).trim()
    const value = trimmed.slice(i + 1).trim()
    if (key) {
      process.env[key] = value
    }
  }
}

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%^&*_-+=' 
  let out = ''

  for (let i = 0; i < 24; i += 1) {
    out += chars[crypto.randomInt(chars.length)]
  }

  return out
}

async function main() {
  loadEnv()

  const pepper = process.env.AUTH_PEPPER
  if (!pepper || pepper.length < 16) {
    throw new Error('AUTH_PEPPER is missing or too short')
  }

  const dataDir = path.join(__dirname, '..', 'data')
  const usersPath = path.join(dataDir, 'users.json')

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  const db = fs.existsSync(usersPath)
    ? JSON.parse(fs.readFileSync(usersPath, 'utf8'))
    : { users: [] }

  const existing = db.users.find((user) => user.username.toLowerCase() === 'owner')

  if (existing) {
    console.log('OWNER_EXISTS=true')
    return
  }

  const password = randomPassword()
  const passwordHash = await hash(`${password}${pepper}`, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
  })

  db.users.push({
    username: 'owner',
    role: 'owner',
    passwordHash,
    createdAt: new Date().toISOString(),
  })

  fs.writeFileSync(usersPath, JSON.stringify(db, null, 2), 'utf8')

  console.log('OWNER_CREATED=true')
  console.log('OWNER_USERNAME=owner')
  console.log(`OWNER_PASSWORD=${password}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
