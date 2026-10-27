import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, describe, it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PrismaPGlite } from 'pglite-prisma-adapter'
import * as Y from 'yjs'
import { PrismaClient } from '../generated/prisma/client.ts'
import { hashPassword, signToken } from '../lib/auth.ts'
import { migrationNames } from '../lib/db.ts'
import { docRoute } from '../lib/handlers.ts'

// Two Yjs documents (two people's editors) exchanging updates through the real route over real Postgres semantics.
const secret = 'x'.repeat(40)
let prisma: PrismaClient
let route: (r: Request) => Promise<Response>
const tok = signToken(secret, 'ana').token

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
const call = async (body: Record<string, unknown>, token: string | null = tok) => {
  const r = await route(new Request('https://x/api/doc', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }))
  return { status: r.status, ...(await r.json()) } as { status: number; updates: { id: number; update: string }[]; last: number; more: boolean; error?: string }
}

// One person's editor: a Y doc, how far they have read, and what they typed since they last sent.
class Client {
  doc = new Y.Doc()
  last = 0
  out: Uint8Array[] = []
  id: string
  constructor(id: string) {
    this.id = id
    this.doc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && this.out.push(u))
  }
  text = () => this.doc.getText('t').toString()
  type(at: number, s: string) { this.doc.getText('t').insert(at, s) }
  async sync(seed?: Uint8Array) {
    // At most 60 updates per request, as the app does.
    const batches = [] as Uint8Array[][]
    for (let i = 0; i < this.out.length; i += 60) batches.push(this.out.slice(i, i + 60))
    if (!batches.length) batches.push([])
    this.out = []
    let r!: Awaited<ReturnType<typeof call>>
    for (const [i, batch] of batches.entries()) {
      r = await call({ docId: this.id, since: this.last, updates: batch.map(b64), ...(seed && i === 0 ? { seed: b64(seed) } : {}) })
      for (const u of r.updates) Y.applyUpdate(this.doc, Buffer.from(u.update, 'base64'), 'remote')
      this.last = r.last
    }
    return r
  }
}

before(async () => {
  const pg = new PGlite()
  await pg.exec(migrationNames().map((name) => readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8')).join('\n'))
  prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) })
  await prisma.user.create({ data: { id: 'ana', name: 'Ana', passwordHash: hashPassword('ana-password-1') } })
  route = docRoute({ prisma, secret })
})

describe('live document', () => {
  it('needs sign-in and a valid document id', async () => {
    assert.equal((await call({ docId: 'a', since: 0 }, null)).status, 401)
    assert.equal((await call({ docId: 'bad id!', since: 0 })).status, 400)
  })

  it('two people typing at the same time end up with the same text, with both edits kept', async () => {
    const a = new Client('doc1')
    const b = new Client('doc1')
    a.type(0, 'Hello world')
    await a.sync()
    await b.sync()
    assert.equal(b.text(), 'Hello world')
    // Both type before either has seen the other's change.
    a.type(5, ' brave')
    b.type(11, '!')
    await a.sync()
    await b.sync()
    await a.sync()
    assert.equal(a.text(), b.text())
    assert.ok(a.text().includes('brave') && a.text().endsWith('!'))
  })

  it('only the first seed counts when two people open an unshared document together', async () => {
    const mk = (s: string) => {
      const d = new Y.Doc()
      d.getText('t').insert(0, s)
      return Y.encodeStateAsUpdate(d)
    }
    const a = new Client('doc2')
    const b = new Client('doc2')
    await a.sync(mk('from A'))
    await b.sync(mk('from B'))
    await a.sync()
    assert.equal(a.text(), 'from A')
    assert.equal(b.text(), 'from A')
  })

  it('merges a long history into one row without changing the text', async () => {
    const a = new Client('doc3')
    for (let i = 0; i < 70; i++) {
      a.type(a.text().length, `${i},`)
      if (i % 7 === 0) await a.sync() // 10 requests of up to 7 updates
    }
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 60; j++) a.type(a.text().length, 'x')
      await a.sync()
    }
    const before = a.text()
    const rows = await prisma.docUpdate.count({ where: { docId: 'doc3' } })
    assert.ok(rows < 300, `expected the history to be merged, found ${rows} rows`)
    const fresh = new Client('doc3')
    await fresh.sync()
    assert.equal(fresh.text(), before)
  })

  it('rejects an oversized batch', async () => {
    const r = await call({ docId: 'doc4', since: 0, updates: Array.from({ length: 65 }, () => b64(new Uint8Array([1, 2, 3]))) })
    assert.equal(r.status, 413)
  })
})
