import type { PrismaClient } from '../generated/prisma/client.ts'
import { KINDS, parseRow, toWire, type Kind } from './kinds.ts'

// One sync round trip: apply the app's changes (last write wins on updatedAt), then return everything that
// changed on the server since the app's cursor, so both people converge on the same data.

export const MAX_CHANGES = 200
export const PAGE = 500
// The pull starts a little before the cursor. Sequence numbers are handed out before a write commits, so a row can
// become visible just after a later one; the overlap re-sends it. Re-applying a row is harmless (same updatedAt wins once).
const OVERLAP = 50

export interface SyncRequest { cursor?: unknown; changes?: unknown }
export interface Member { id: string; name: string; role: string }
export interface SyncResponse {
  cursor: number
  team: Member[] // everyone on the server, so each app can offer them as assignees
  more: boolean
  rows: { kind: Kind; data: Record<string, unknown> }[]
  rejected: { kind: string; id: string; error: string }[]
  applied: number
}

// A loosely typed view of the delegates; they share the same bookkeeping columns.
type Delegate = {
  findUnique(a: { where: { id: string }; select: { updatedAt: true } }): Promise<{ updatedAt: Date } | null>
  upsert(a: { where: { id: string }; create: object; update: object }): Promise<unknown>
  findMany(a: { where: { seq: { gt: bigint } }; orderBy: { seq: 'asc' }; take: number }): Promise<Record<string, unknown>[]>
}
const delegates = (db: Pick<PrismaClient, 'discussion' | 'ticket' | 'roadmap' | 'note'>) => ({
  discussions: db.discussion as unknown as Delegate,
  tickets: db.ticket as unknown as Delegate,
  roadmaps: db.roadmap as unknown as Delegate,
  notes: db.note as unknown as Delegate
})

export async function sync(prisma: PrismaClient, user: string, req: SyncRequest, now = new Date()): Promise<SyncResponse> {
  const cursor = typeof req.cursor === 'number' && Number.isSafeInteger(req.cursor) && req.cursor >= 0 ? req.cursor : 0
  const changes = Array.isArray(req.changes) ? req.changes : []
  if (changes.length > MAX_CHANGES) throw new RangeError(`Send at most ${MAX_CHANGES} changes at a time.`)

  const team: Member[] = await prisma.user.findMany({ select: { id: true, name: true, role: true }, orderBy: { id: 'asc' } })
  const users = team.map((m) => m.id)
  const rejected: SyncResponse['rejected'] = []
  let applied = 0

  if (changes.length) {
    await prisma.$transaction(async (tx) => {
      const d = delegates(tx)
      for (const c of changes as { kind?: unknown; data?: unknown }[]) {
        const kind = c?.kind as Kind
        const id = String((c?.data as { id?: unknown } | undefined)?.id ?? '')
        try {
          if (!KINDS.includes(kind)) throw new Error('unknown kind')
          const row = parseRow(kind, c.data, now, users)
          // Each person can only write as themselves, so a stolen or edited app can't forge the other's edits.
          if (row.updatedBy !== user) throw new Error('item was not changed by you')
          const delegate = d[kind]
          const existing = await delegate.findUnique({ where: { id: row.id }, select: { updatedAt: true } })
          if (existing && existing.updatedAt.getTime() >= row.updatedAt.getTime()) continue // the server's copy is as new or newer
          const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`select nextval('sync_seq') as n`
          await delegate.upsert({ where: { id: row.id }, create: { ...row, seq: n }, update: { ...row, seq: n } })
          applied++
        } catch (e) {
          rejected.push({ kind: String(kind), id, error: (e as Error).message })
        }
      }
    })
  }

  const since = BigInt(Math.max(0, cursor - OVERLAP))
  const d = delegates(prisma)
  const found = (
    await Promise.all(
      KINDS.map(async (kind) =>
        (await d[kind].findMany({ where: { seq: { gt: since } }, orderBy: { seq: 'asc' }, take: PAGE + 1 })).map((row) => ({ kind, seq: row.seq as bigint, row }))
      )
    )
  )
    .flat()
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
  const page = found.slice(0, PAGE)
  return {
    team,
    cursor: page.length ? Math.max(cursor, Number(page[page.length - 1].seq)) : cursor,
    more: found.length > PAGE,
    rows: page.map(({ kind, row }) => ({ kind, data: toWire(row) })),
    rejected,
    applied
  }
}
