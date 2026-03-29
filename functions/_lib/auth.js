const textEncoder = new TextEncoder()

const SESSION_COOKIE_NAME = 'chrc_session'
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 12

function encodeBase64Url(bytes) {
  let base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false
  }

  const aBytes = textEncoder.encode(a)
  const bBytes = textEncoder.encode(b)

  if (aBytes.length !== bBytes.length) {
    return false
  }

  let mismatch = 0

  for (let i = 0; i < aBytes.length; i += 1) {
    mismatch |= aBytes[i] ^ bBytes[i]
  }

  return mismatch === 0
}

async function createHmac(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(message))
  return encodeBase64Url(new Uint8Array(signature))
}

function getSessionTtlSeconds(env) {
  const raw = Number(env.SESSION_TTL_SECONDS)

  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_SESSION_TTL_SECONDS
  }

  return Math.floor(raw)
}

export function parseCookies(cookieHeader) {
  const cookies = {}

  if (!cookieHeader) {
    return cookies
  }

  for (const chunk of cookieHeader.split(';')) {
    const index = chunk.indexOf('=')

    if (index === -1) {
      continue
    }

    const key = chunk.slice(0, index).trim()
    const value = chunk.slice(index + 1).trim()

    if (!key) {
      continue
    }

    cookies[key] = value
  }

  return cookies
}

export function buildSessionCookie(token, env) {
  const maxAge = getSessionTtlSeconds(env)
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

export function buildClearedSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` 
}

export async function hashPassword(password, saltBase64Url, iterations, pepper) {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(`${password}${pepper}`), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: decodeBase64Url(saltBase64Url),
      iterations,
    },
    key,
    256
  )

  return encodeBase64Url(new Uint8Array(bits))
}

export async function verifyPassword(password, user, pepper) {
  if (!user || !user.password_salt || !user.password_hash) {
    return false
  }

  const iterations = Number(user.password_iterations) || 210000
  const hash = await hashPassword(password, user.password_salt, iterations, pepper)
  return timingSafeEqual(hash, user.password_hash)
}

export async function createSessionToken(sessionData, env) {
  const ttl = getSessionTtlSeconds(env)
  const payload = {
    username: sessionData.username,
    role: sessionData.role,
    exp: Math.floor(Date.now() / 1000) + ttl,
  }

  const payloadBase64 = encodeBase64Url(textEncoder.encode(JSON.stringify(payload)))
  const signature = await createHmac(payloadBase64, env.AUTH_SESSION_SECRET)
  return `${payloadBase64}.${signature}`
}

export async function verifySessionToken(token, env) {
  if (!token || !env.AUTH_SESSION_SECRET) {
    return null
  }

  const parts = token.split('.')

  if (parts.length !== 2) {
    return null
  }

  const [payloadBase64, signature] = parts
  const expectedSignature = await createHmac(payloadBase64, env.AUTH_SESSION_SECRET)

  if (!timingSafeEqual(signature, expectedSignature)) {
    return null
  }

  try {
    const payloadText = new TextDecoder().decode(decodeBase64Url(payloadBase64))
    const payload = JSON.parse(payloadText)

    if (!payload || typeof payload.username !== 'string' || typeof payload.role !== 'string') {
      return null
    }

    if (Number(payload.exp) <= Math.floor(Date.now() / 1000)) {
      return null
    }

    return payload
  } catch {
    return null
  }
}

export function getSessionCookieName() {
  return SESSION_COOKIE_NAME
}
