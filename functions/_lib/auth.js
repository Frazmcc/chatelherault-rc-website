const textEncoder = new TextEncoder()
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const base64Lookup = Object.fromEntries([...base64Alphabet].map((ch, index) => [ch, index]))

const SESSION_COOKIE_NAME = 'chrc_session'
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 12

function encodeBase64Url(bytes) {
  let base64 = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const triple = (a << 16) | (b << 8) | c

    base64 += base64Alphabet[(triple >> 18) & 63]
    base64 += base64Alphabet[(triple >> 12) & 63]
    base64 += i + 1 < bytes.length ? base64Alphabet[(triple >> 6) & 63] : '='
    base64 += i + 2 < bytes.length ? base64Alphabet[triple & 63] : '='
  }

  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const output = []

  for (let i = 0; i < padded.length; i += 4) {
    const c1 = padded[i]
    const c2 = padded[i + 1]
    const c3 = padded[i + 2]
    const c4 = padded[i + 3]

    if (!(c1 in base64Lookup) || !(c2 in base64Lookup)) {
      throw new Error('Invalid base64 value')
    }

    const n1 = base64Lookup[c1]
    const n2 = base64Lookup[c2]
    const n3 = c3 === '=' ? 0 : base64Lookup[c3]
    const n4 = c4 === '=' ? 0 : base64Lookup[c4]

    if ((c3 !== '=' && !(c3 in base64Lookup)) || (c4 !== '=' && !(c4 in base64Lookup))) {
      throw new Error('Invalid base64 value')
    }

    const triple = (n1 << 18) | (n2 << 12) | (n3 << 6) | n4

    output.push((triple >> 16) & 255)

    if (c3 !== '=') {
      output.push((triple >> 8) & 255)
    }

    if (c4 !== '=') {
      output.push(triple & 255)
    }
  }

  return new Uint8Array(output)
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
