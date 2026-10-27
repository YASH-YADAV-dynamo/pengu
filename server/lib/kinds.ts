// What the app sends and receives for each kind of item, checked and converted to database columns.
// Everything from the network is untrusted: unknown fields are dropped, enums and lengths are enforced,
// and a bad item is rejected on its own (reported back) without failing the rest of the batch.

export const KINDS = ['discussions', 'tickets', 'roadmaps', 'notes'] as const
export type Kind = (typeof KINDS)[number]

const ID = /^[A-Za-z0-9_-]{1,64}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_TEXT = 500_000 // a long discussion document

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number, what: string, required = true) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${what} is required`)
    return ''
  }
  if (typeof v !== 'string' || v.length > max) throw new Error(`${what} must be text up to ${max} characters`)
  return v
}
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => {
  if (!list.includes(v as T)) throw new Error(`${what} must be one of ${list.join(', ')}`)
  return v as T
}
const date = (v: unknown, what: string): Date | null => {
  if (v === null || v === undefined || v === '') return null
  const d = new Date(String(v))
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) throw new Error(`${what} is not a date`)
  return d
}
const ids = (v: unknown, what: string, max = 200): string[] => {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || x.length > 64)) throw new Error(`${what} must be a list of ids`)
  return v as string[]
}

export interface Base { id: string; updatedAt: Date; updatedBy: string; deletedAt: Date | null }

// Shared columns. A timestamp more than ten minutes ahead of the server clock is treated as "now", so one computer
// with a wrong clock can't make its edits win forever.
function base(row: Obj, now: Date, users: readonly string[]): Base {
  const id = str(row.id, 64, 'id')
  if (!ID.test(id)) throw new Error('id has characters that are not allowed')
  const at = date(row.updatedAt, 'updatedAt')
  if (!at) throw new Error('updatedAt is required')
  return {
    id,
    updatedAt: at.getTime() > now.getTime() + 600_000 ? now : at,
    updatedBy: oneOf(row.updatedBy, users, 'updatedBy'),
    deletedAt: date(row.deletedAt, 'deletedAt')
  }
}

// `users` is everyone who exists on the server right now; ids outside it are rejected (assignee) or dropped (tagged).
export const parse = {
  discussions(row: Obj, now: Date, users: readonly string[]) {
    const design = row.design === undefined ? [] : row.design
    if (!Array.isArray(design) || JSON.stringify(design).length > 200_000) throw new Error('design is too large')
    return {
      ...base(row, now, users),
      type: oneOf(row.type, ['product', 'growth', 'tech'] as const, 'type'),
      title: str(row.title, 300, 'title'),
      meetAt: date(row.meetAt, 'meetAt'),
      tagged: ids(row.tagged, 'tagged', 10).filter((u) => users.includes(u)),
      doc: str(row.doc, MAX_TEXT, 'doc', false),
      design: design as object[]
    }
  },
  tickets(row: Obj, now: Date, users: readonly string[]) {
    const deadline = row.deadline === null || row.deadline === undefined || row.deadline === '' ? null : String(row.deadline)
    if (deadline !== null && !DAY.test(deadline)) throw new Error('deadline must be YYYY-MM-DD')
    const discussionId = row.discussionId ? str(row.discussionId, 64, 'discussionId') : null
    return {
      ...base(row, now, users),
      discussionId,
      title: str(row.title, 300, 'title'),
      assignee: oneOf(row.assignee, users, 'assignee'),
      deadline,
      status: oneOf(row.status, ['open', 'done'] as const, 'status'),
      notes: str(row.notes, MAX_TEXT, 'notes', false)
    }
  },
  roadmaps(row: Obj, now: Date, users: readonly string[]) {
    return { ...base(row, now, users), title: str(row.title, 300, 'title'), discussionIds: ids(row.discussionIds, 'discussionIds') }
  },
  notes(row: Obj, now: Date, users: readonly string[]) {
    return { ...base(row, now, users), title: str(row.title, 300, 'title'), body: str(row.body, MAX_TEXT, 'body', false) }
  }
}

export function parseRow(kind: Kind, row: unknown, now: Date, users: readonly string[]) {
  if (!isObj(row)) throw new Error('item must be an object')
  return parse[kind](row, now, users)
}

// A database row back to the app's JSON shape (dates as ISO strings, bookkeeping included, seq left out).
export function toWire(row: Record<string, unknown>): Obj {
  const { seq: _seq, ...rest } = row
  const out: Obj = {}
  for (const [k, v] of Object.entries(rest)) out[k] = v instanceof Date ? v.toISOString() : v
  return out
}
