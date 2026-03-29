const { hash, verify, Algorithm } = require('@node-rs/argon2')

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
}

function getPepper() {
  const pepper = process.env.AUTH_PEPPER

  if (!pepper || pepper.length < 16) {
    throw new Error('AUTH_PEPPER must be set to a strong random secret (16+ chars).')
  }

  return pepper
}

function validatePasswordStrength(password) {
  const strong =
    typeof password === 'string' &&
    password.length >= 14 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)

  return strong
}

async function hashPassword(password) {
  const pepper = getPepper()
  return hash(`${password}${pepper}`, ARGON2_OPTIONS)
}

async function verifyPassword(password, hashedPassword) {
  const pepper = getPepper()
  return verify(hashedPassword, `${password}${pepper}`)
}

module.exports = {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
}
