import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// Passwords are stored as scrypt hashes ("scrypt$N$salt$hash", base64url) and never leave the database.
// A sign-in returns a signed token ("user.expiry.signature"); the app sends it with every sync.

const N = 16_384
const KEYLEN = 32

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N })
  return `scrypt$${N}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !n || !salt || !hash) return false
  const want = Buffer.from(hash, 'base64url')
  const got = scryptSync(password, Buffer.from(salt, 'base64url'), want.length, { N: Number(n) })
  return got.length === want.length && timingSafeEqual(got, want)
}

export const TOKEN_DAYS = 30
const mac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('base64url')

export function signToken(secret: string, user: string, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + TOKEN_DAYS * 86_400_000
  const body = `${user}.${expiresAt}`
  return { token: `${body}.${mac(secret, body)}`, expiresAt }
}

// The user id inside a valid, unexpired token, else null.
export function verifyToken(secret: string, token: string, now = Date.now()): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [user, exp, sig] = parts
  const want = Buffer.from(mac(secret, `${user}.${exp}`))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  return Number(exp) > now ? user : null
}
