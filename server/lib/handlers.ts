import type { PrismaClient } from '../generated/prisma/client.ts'
import { signToken, verifyPassword, verifyToken } from './auth.ts'
import { exchange, type DocRequest } from './doc.ts'
import { sync, type SyncRequest } from './sync.ts'

// The endpoints as plain (Request) => Response functions, so they run on Vercel and in tests the same way.
// Dependencies come in as arguments: the database client and the signing secret.

export interface Deps { prisma: PrismaClient; secret: string; now?: () => Date }

const MAX_BODY = 4_000_000 // Vercel rejects bodies over 4.5 MB anyway
const FAIL_LIMIT = 8 // failed sign-ins per address in the window below
const FAIL_WINDOW_MS = 15 * 60_000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text()
  if (text.length > MAX_BODY) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const clientIp = (req: Request) => (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim().slice(0, 64)

// A hash to compare against when the user doesn't exist, so a wrong name and a wrong password take the same time.
const DUMMY = 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

export function login({ prisma, secret, now = () => new Date() }: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)
    const body = await readJson(req)
    const user = typeof body?.user === 'string' ? body.user.toLowerCase().trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!user || !password || password.length > 200) return json({ error: 'Enter your name and password.' }, 400)

    const ip = clientIp(req)
    const since = new Date(now().getTime() - FAIL_WINDOW_MS)
    if ((await prisma.loginFailure.count({ where: { ip, at: { gt: since } } })) >= FAIL_LIMIT) {
      return json({ error: 'Too many wrong passwords. Try again in 15 minutes.' }, 429)
    }
    const row = await prisma.user.findUnique({ where: { id: user } })
    const ok = verifyPassword(password, row?.passwordHash ?? DUMMY) && !!row
    if (!ok) {
      await prisma.loginFailure.create({ data: { ip, at: now() } })
      await prisma.loginFailure.deleteMany({ where: { at: { lt: new Date(now().getTime() - 86_400_000) } } })
      return json({ error: 'Wrong name or password.' }, 401)
    }
    const { token, expiresAt } = signToken(secret, row.id, now().getTime())
    const team = await prisma.user.findMany({ select: { id: true, name: true, role: true }, orderBy: { id: 'asc' } })
    return json({ token, expiresAt, user: row.id, name: row.name, role: row.role, team })
  }
}

// The signed-in user and their role, or null. Checked against the database too, so removing a user (or changing their
// role) takes effect at once, even for a token that hasn't expired yet.
async function who(prisma: PrismaClient, secret: string, req: Request, now: Date): Promise<{ id: string; role: string } | null> {
  const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
  const user = bearer ? verifyToken(secret, bearer, now.getTime()) : null
  return user ? prisma.user.findUnique({ where: { id: user }, select: { id: true, role: true } }) : null
}
const READ_ONLY = 'Your role is read-only (viewer). Ask an admin to make you a member to edit.'

export function docRoute({ prisma, secret, now = () => new Date() }: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)
    const user = await who(prisma, secret, req, now())
    if (!user) return json({ error: 'Sign in again.' }, 401)
    const body = await readJson(req)
    if (!body) return json({ error: 'Send JSON of at most 4 MB.' }, 400)
    const writes = (Array.isArray(body.updates) && body.updates.length > 0) || body.seed !== undefined
    if (user.role === 'viewer' && writes) return json({ error: READ_ONLY }, 403)
    try {
      return json(await exchange(prisma, body as DocRequest))
    } catch (e) {
      if (e instanceof RangeError) return json({ error: e.message }, 413)
      if (e instanceof TypeError) return json({ error: e.message }, 400)
      throw e
    }
  }
}

export function syncRoute({ prisma, secret, now = () => new Date() }: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)
    const user = await who(prisma, secret, req, now())
    if (!user) return json({ error: 'Sign in again.' }, 401)
    const body = await readJson(req)
    if (!body) return json({ error: 'Send JSON of at most 4 MB.' }, 400)
    if (user.role === 'viewer' && Array.isArray(body.changes) && body.changes.length) return json({ error: READ_ONLY }, 403)
    try {
      return json(await sync(prisma, user.id, body as SyncRequest, now()))
    } catch (e) {
      if (e instanceof RangeError) return json({ error: e.message }, 413)
      throw e
    }
  }
}
