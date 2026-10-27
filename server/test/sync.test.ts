import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, describe, it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PrismaPGlite } from 'pglite-prisma-adapter'
import { PrismaClient } from '../generated/prisma/client.ts'
import { hashPassword, signToken, verifyToken } from '../lib/auth.ts'
import { migrationNames } from '../lib/db.ts'
import { login, syncRoute } from '../lib/handlers.ts'

// Real Postgres (PGlite, in memory) running the real migration, driven through the real handlers.
const secret = 'x'.repeat(40)
let prisma: PrismaClient
let doLogin: (r: Request) => Promise<Response>
let doSync: (r: Request) => Promise<Response>
let clock = new Date('2026-10-14T12:00:00Z')

const post = (url: string, body: unknown, token?: string, ip = '1.1.1.1') =>
  new Request(`https://x${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })

const ticket = (id: string, by: string, over: Record<string, unknown> = {}) => ({
  kind: 'tickets',
  data: { id, discussionId: null, title: `Ticket ${id}`, assignee: 'ben', deadline: '2026-10-20', status: 'open', notes: '', updatedAt: clock.toISOString(), updatedBy: by, deletedAt: null, ...over }
})

async function token(user: string, password: string) {
  const r = await doLogin(post('/api/auth/login', { user, password }))
  return { status: r.status, ...(await r.json()) } as { status: number; token: string }
}
const run = async (tok: string, body: unknown) => {
  const r = await doSync(post('/api/sync', body, tok))
  return { status: r.status, ...(await r.json()) } as { status: number; cursor: number; more: boolean; rows: { kind: string; data: Record<string, unknown> }[]; rejected: { id: string; error: string }[]; applied: number }
}

before(async () => {
  const pg = new PGlite()
  await pg.exec(migrationNames().map((name) => readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8')).join('\n'))
  prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) })
  await prisma.user.createMany({ data: [
    { id: 'ana', name: 'Ana', passwordHash: hashPassword('ana-password-1') },
    { id: 'ben', name: 'Ben', passwordHash: hashPassword('ben-password-1') },
    { id: 'vic', name: 'Vic', role: 'viewer', passwordHash: hashPassword('vic-password-1') }
  ] })
  const deps = { prisma, secret, now: () => clock }
  doLogin = login(deps)
  doSync = syncRoute(deps)
})

describe('sign in', () => {
  it('accepts the right password and returns a token for that user', async () => {
    const r = await token('ana', 'ana-password-1')
    assert.equal(r.status, 200)
    assert.equal(verifyToken(secret, r.token, clock.getTime()), 'ana')
  })
  it('is case-insensitive on the name but strict on the password', async () => {
    assert.equal((await token('Ben', 'ben-password-1')).status, 200)
    assert.equal((await token('ben', 'nope')).status, 401)
    assert.equal((await token('nobody', 'whatever-123')).status, 401)
  })
  it('slows down guessing from one address, then recovers', async () => {
    for (let i = 0; i < 8; i++) await doLogin(post('/api/auth/login', { user: 'ana', password: 'bad' }, undefined, '9.9.9.9'))
    const blocked = await doLogin(post('/api/auth/login', { user: 'ana', password: 'ana-password-1' }, undefined, '9.9.9.9'))
    assert.equal(blocked.status, 429)
    clock = new Date(clock.getTime() + 16 * 60_000)
    const later = await doLogin(post('/api/auth/login', { user: 'ana', password: 'ana-password-1' }, undefined, '9.9.9.9'))
    assert.equal(later.status, 200)
  })
  it('returns the sign-in user, their role and the whole team', async () => {
    const r = await doLogin(post('/api/auth/login', { user: 'ana', password: 'ana-password-1' }))
    const body = await r.json() as { user: string; role: string; team: { id: string; name: string; role: string }[] }
    assert.equal(r.status, 200)
    assert.equal(body.role, 'member')
    assert.deepEqual(body.team.map((m) => [m.id, m.role]), [['ana', 'member'], ['ben', 'member'], ['vic', 'viewer']])
  })
  it('tokens expire and cannot be forged', () => {
    const { token: t } = signToken(secret, 'ana', clock.getTime())
    assert.equal(verifyToken(secret, t, clock.getTime() + 31 * 86_400_000), null)
    assert.equal(verifyToken(secret, t.replace('ana', 'ben'), clock.getTime()), null)
    assert.equal(verifyToken('y'.repeat(40), t, clock.getTime()), null)
  })
})

describe('sync', () => {
  it('needs a token', async () => {
    assert.equal((await doSync(post('/api/sync', { cursor: 0, changes: [] }))).status, 401)
    assert.equal((await doSync(post('/api/sync', { cursor: 0, changes: [] }, 'garbage'))).status, 401)
  })

  it('carries a change from one person to the other, and back', async () => {
    const ana = (await token('ana', 'ana-password-1')).token
    const ben = (await token('ben', 'ben-password-1')).token
    const pushed = await run(ana, { cursor: 0, changes: [
      { kind: 'discussions', data: { id: 'd1', type: 'product', title: 'Habit loop', meetAt: '2026-10-15T10:30:00.000Z', tagged: ['ana', 'ben'], doc: '<h2>Research</h2><p>x</p>', design: [], updatedAt: clock.toISOString(), updatedBy: 'ana', deletedAt: null } },
      ticket('t1', 'ana')
    ] })
    assert.equal(pushed.applied, 2)
    assert.deepEqual(pushed.rejected, [])

    const pulled = await run(ben, { cursor: 0, changes: [] })
    const d = pulled.rows.find((r) => r.kind === 'discussions')!.data
    assert.equal(d.title, 'Habit loop')
    assert.equal(d.meetAt, '2026-10-15T10:30:00.000Z')
    assert.deepEqual(d.tagged, ['ana', 'ben'])
    assert.equal(pulled.rows.find((r) => r.kind === 'tickets')!.data.assignee, 'ben')
    assert.ok(!('seq' in d))

    // Ben closes the ticket; Ana receives it using the cursor from his last sync.
    clock = new Date(clock.getTime() + 60_000)
    await run(ben, { cursor: pulled.cursor, changes: [ticket('t1', 'ben', { status: 'done' })] })
    const back = await run(ana, { cursor: pushed.cursor, changes: [] })
    assert.equal(back.rows.find((r) => r.data.id === 't1')!.data.status, 'done')
  })

  it('keeps the newer write when two people edit the same item (last write wins)', async () => {
    const ana = (await token('ana', 'ana-password-1')).token
    const newer = new Date(clock.getTime() + 5 * 60_000).toISOString()
    const older = new Date(clock.getTime() + 60_000).toISOString()
    clock = new Date(clock.getTime() + 10 * 60_000)
    await run(ana, { cursor: 0, changes: [ticket('lww', 'ana', { title: 'newer', updatedAt: newer })] })
    const r = await run(ana, { cursor: 0, changes: [ticket('lww', 'ana', { title: 'older', updatedAt: older })] })
    assert.equal(r.applied, 0)
    assert.equal(r.rows.find((x) => x.data.id === 'lww')!.data.title, 'newer')
  })

  it('syncs deletes', async () => {
    const ana = (await token('ana', 'ana-password-1')).token
    const gone = clock.toISOString()
    clock = new Date(clock.getTime() + 1000)
    const at = new Date(clock.getTime() + 1000).toISOString()
    await run(ana, { cursor: 0, changes: [ticket('del', 'ana')] })
    const r = await run(ana, { cursor: 0, changes: [ticket('del', 'ana', { updatedAt: at, deletedAt: gone })] })
    assert.equal(r.rows.find((x) => x.data.id === 'del')!.data.deletedAt, gone)
  })

  it('rejects forged authors and bad items, and still applies the good ones', async () => {
    const ana = (await token('ana', 'ana-password-1')).token
    clock = new Date(clock.getTime() + 1000)
    const r = await run(ana, { cursor: 0, changes: [
      ticket('forged', 'ben'),
      ticket('bad-status', 'ana', { status: 'weird' }),
      ticket('bad id!', 'ana'),
      { kind: 'nope', data: { id: 'z' } },
      ticket('good', 'ana')
    ] })
    assert.equal(r.applied, 1)
    assert.equal(r.rejected.length, 4)
    assert.ok(r.rejected.find((x) => x.id === 'forged')!.error.includes('not changed by you'))
    assert.ok(r.rows.some((x) => x.data.id === 'good'))
    assert.ok(!r.rows.some((x) => x.data.id === 'forged'))
  })

  it('treats a far-future clock as now so one wrong computer cannot win forever', async () => {
    const ana = (await token('ana', 'ana-password-1')).token
    const r = await run(ana, { cursor: 0, changes: [ticket('future', 'ana', { updatedAt: '2099-01-01T00:00:00.000Z' })] })
    const row = r.rows.find((x) => x.data.id === 'future')!.data
    assert.equal(row.updatedAt, clock.toISOString())
  })

  it('pages through large changes with the cursor', async () => {
    const ben = (await token('ben', 'ben-password-1')).token
    clock = new Date(clock.getTime() + 1000)
    const many = Array.from({ length: 150 }, (_, i) => ({ kind: 'notes', data: { id: `n${i}`, title: `Note ${i}`, body: '', updatedAt: clock.toISOString(), updatedBy: 'ben', deletedAt: null } }))
    await run(ben, { cursor: 0, changes: many })
    const seen = new Set<string>()
    let cursor = 0
    for (let guard = 0; guard < 50; guard++) {
      const r = await run(ben, { cursor, changes: [] })
      r.rows.forEach((x) => seen.add(`${x.kind}:${x.data.id}`))
      if (!r.more) break
      cursor = r.cursor
    }
    assert.ok([...seen].filter((k) => k.startsWith('notes:n')).length === 150)
  })

  it('lists the team in every reply, and rejects people who do not exist', async () => {
    const ana = (await token('ana', 'ana-password-1')).token
    const r = await run(ana, { cursor: 0, changes: [ticket('ghost', 'ana', { assignee: 'nobody' })] })
    assert.deepEqual((r as unknown as { team: { id: string }[] }).team.map((m) => m.id), ['ana', 'ben', 'vic'])
    assert.equal(r.applied, 0)
    assert.match(r.rejected[0].error, /assignee must be one of/)
  })

  it('lets a viewer read but not write', async () => {
    const vic = (await token('vic', 'vic-password-1')).token
    assert.equal((await run(vic, { cursor: 0, changes: [] })).status, 200)
    const r = await run(vic, { cursor: 0, changes: [ticket('v1', 'vic')] })
    assert.equal(r.status, 403)
  })

  it('applies a role change at once, without a new sign-in', async () => {
    const vic = (await token('vic', 'vic-password-1')).token
    await prisma.user.update({ where: { id: 'vic' }, data: { role: 'member' } })
    assert.equal((await run(vic, { cursor: 0, changes: [ticket('v2', 'vic')] })).applied, 1)
    await prisma.user.update({ where: { id: 'vic' }, data: { role: 'viewer' } })
    assert.equal((await run(vic, { cursor: 0, changes: [ticket('v3', 'vic')] })).status, 403)
  })

  it('refuses more than 200 changes in one request', async () => {
    const ana = (await token('ana', 'ana-password-1')).token
    const r = await run(ana, { cursor: 0, changes: Array.from({ length: 201 }, (_, i) => ticket(`big${i}`, 'ana')) })
    assert.equal(r.status, 413)
  })
})
