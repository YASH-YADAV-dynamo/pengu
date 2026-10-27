import * as Y from 'yjs'
import type { PrismaClient } from '../generated/prisma/client.ts'

// Live document editing. The app keeps a Yjs document per discussion and exchanges binary updates through this one
// route: it sends the updates it made since last time and gets back every update it hasn't seen. Merging is done
// by Yjs on each side, so the server only stores and relays bytes.

export const MAX_UPDATES = 64 // per request
export const MAX_UPDATE_BYTES = 500_000
const PAGE = 200
const COMPACT_AT = 300 // merge a document's rows into one when it has this many
const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface DocRequest { docId?: unknown; since?: unknown; updates?: unknown; seed?: unknown }
export interface DocResponse { updates: { id: number; update: string }[]; last: number; more: boolean }

const bytes = (b64: unknown, what: string): Uint8Array<ArrayBuffer> => {
  if (typeof b64 !== 'string' || b64.length > MAX_UPDATE_BYTES * 1.4) throw new RangeError(`${what} is too large`)
  const b = Buffer.from(b64, 'base64')
  if (b.length === 0 || b.length > MAX_UPDATE_BYTES) throw new RangeError(`${what} is empty or too large`)
  return Uint8Array.from(b)
}

export async function exchange(prisma: PrismaClient, req: DocRequest): Promise<DocResponse> {
  const docId = typeof req.docId === 'string' && DOC_ID.test(req.docId) ? req.docId : null
  if (!docId) throw new TypeError('docId is not valid')
  const since = typeof req.since === 'number' && Number.isSafeInteger(req.since) && req.since >= 0 ? req.since : 0
  const updates = Array.isArray(req.updates) ? req.updates : []
  if (updates.length > MAX_UPDATES) throw new RangeError(`Send at most ${MAX_UPDATES} updates at a time.`)
  const incoming = updates.map((u) => bytes(u, 'an update'))

  // The first copy of a document's text. Only the first seed counts: if two people open an unshared document at the
  // same moment, one seed wins and the other person receives it, instead of both texts being merged together.
  if (req.seed !== undefined) {
    const seed = bytes(req.seed, 'the seed')
    await prisma.$executeRaw`insert into "DocUpdate" ("docId", "update") select ${docId}, ${seed} where not exists (select 1 from "DocUpdate" where "docId" = ${docId})`
  }
  if (incoming.length) await prisma.docUpdate.createMany({ data: incoming.map((update) => ({ docId, update })) })

  const rows = await prisma.docUpdate.findMany({ where: { docId, id: { gt: BigInt(since) } }, orderBy: { id: 'asc' }, take: PAGE + 1 })
  const page = rows.slice(0, PAGE)
  const out = {
    updates: page.map((r) => ({ id: Number(r.id), update: Buffer.from(r.update).toString('base64') })),
    last: page.length ? Number(page[page.length - 1].id) : since,
    more: rows.length > PAGE
  }
  if (incoming.length) await compact(prisma, docId)
  return out
}

// Replace a long run of updates with their merge. Only the rows read here are removed, so an update that arrives
// meanwhile is kept. The merged row gets a new, higher id: a client that already had those updates receives it once
// and Yjs ignores what it already knows.
async function compact(prisma: PrismaClient, docId: string) {
  if ((await prisma.docUpdate.count({ where: { docId } })) < COMPACT_AT) return
  const rows = await prisma.docUpdate.findMany({ where: { docId }, orderBy: { id: 'asc' } })
  if (rows.length < COMPACT_AT) return
  const merged = Uint8Array.from(Y.mergeUpdates(rows.map((r) => new Uint8Array(r.update))))
  await prisma.$transaction([
    prisma.docUpdate.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }),
    prisma.docUpdate.create({ data: { docId, update: merged } })
  ])
}
