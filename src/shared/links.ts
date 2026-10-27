// Obsidian-style links for every layer: [[Title]] (or [[Title|alias]]) links to any discussion, ticket, note or
// roadmap by title, and #tags group them. The mind map, backlinks, autocomplete and rename all read from here,
// so the rules for what counts as a link live in one place.
import { htmlToText, mapHtmlText } from './doc'
import { live, type Kind, type State } from './model'

export interface LinkItem {
  id: string
  kind: Kind
  title: string
  text: string // every link-bearing text field of the row, joined
  route: string
  sub?: string // discussion type, ticket status
}

const WIKI = /\[\[([^[\]|]+?)(?:\|[^[\]]*)?\]\]/g
// A tag starts after a space or line start and must contain a letter, so "#1" or "issue #42" isn't a tag.
const TAG = /(^|[\s(,;])#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu

export const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ')
export const linksIn = (text: string) => [...text.matchAll(WIKI)].map((m) => m[1].trim()).filter(Boolean)
export const tagsIn = (text: string) => [...new Set([...text.matchAll(TAG)].map((m) => m[2].toLowerCase()))]
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The text fields of a row that may hold links. Rename and "Link mention" rewrite exactly these.
type AnyRow = Record<string, unknown>
export function mapText<T extends AnyRow>(kind: Kind, row: T, fn: (s: string) => string): T {
  const r = row as AnyRow
  if (kind === 'discussions')
    return {
      ...row,
      doc: mapHtmlText(String(r.doc ?? ''), fn),
      design: ((r.design as { note: string }[]) ?? []).map((e) => ({ ...e, note: fn(e.note) }))
    }
  if (kind === 'tickets') return { ...row, notes: fn(String(r.notes ?? '')) }
  if (kind === 'notes') return { ...row, body: fn(String(r.body ?? '')) }
  return row
}

export function itemsOf(s: Pick<State, 'discussions' | 'tickets' | 'roadmaps' | 'notes'>): LinkItem[] {
  return [
    ...live(s.discussions).map((d) => ({
      id: d.id, kind: 'discussions' as const, title: d.title, route: `/discussions/${d.id}`, sub: d.type,
      text: [htmlToText(d.doc ?? ''), ...d.design.map((e) => e.note)].join('\n')
    })),
    ...live(s.tickets).map((t) => ({ id: t.id, kind: 'tickets' as const, title: t.title, route: `/tickets/${t.id}`, sub: t.status, text: t.notes ?? '' })),
    ...live(s.notes ?? []).map((n) => ({ id: n.id, kind: 'notes' as const, title: n.title, route: `/notes/${n.id}`, text: n.body })),
    ...live(s.roadmaps).map((r) => ({ id: r.id, kind: 'roadmaps' as const, title: r.title, route: `/roadmaps/${r.id}`, text: '' }))
  ].filter((i) => i.title.trim())
}

// Title → item. When two items share a title, the first one wins, like Obsidian's shortest-path rule.
export function titleIndex(items: LinkItem[]) {
  const map = new Map<string, LinkItem>()
  for (const i of items) if (!map.has(norm(i.title))) map.set(norm(i.title), i)
  return map
}

// Plain-text mentions of a title (whole words, case-insensitive) outside any [[link]].
// Titles under 4 characters are skipped, or "API" or "Ux" would match half the workspace.
function mentions(text: string, title: string) {
  if (title.trim().length < 4) return false
  const plain = text.replace(WIKI, ' ')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(title.trim())}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(plain)
}

// Wrap plain mentions of a title in [[ ]]: the "Link" button on an unlinked mention.
export function linkMentions(text: string, title: string) {
  const parts = text.split(/(\[\[[^\]]*\]\])/)
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escape(title.trim())})(?=$|[^\\p{L}\\p{N}])`, 'giu')
  return parts.map((p) => (p.startsWith('[[') ? p : p.replace(re, (_m, pre, hit) => `${pre}[[${hit}]]`))).join('')
}

// Rename: [[Old]] and [[Old|alias]] point at the new title, the way Obsidian updates links on rename.
export function renameLinks(text: string, from: string, to: string) {
  return text.replace(WIKI, (m, target: string) => {
    if (norm(target) !== norm(from)) return m
    const alias = m.match(/\|([^\]]*)\]\]$/)
    return alias ? `[[${to}|${alias[1]}]]` : `[[${to}]]`
  })
}

export function backlinks(item: LinkItem, items: LinkItem[]) {
  const others = items.filter((i) => i.id !== item.id)
  const linked = others.filter((i) => linksIn(i.text).some((t) => norm(t) === norm(item.title)))
  const unlinked = others.filter((i) => !linked.includes(i) && mentions(i.text, item.title))
  return { linked, unlinked }
}

// ---------- the unified graph behind the mind map ----------

export type NodeKind = Kind | 'tag' | 'ghost' // ghost: a [[link]] to something that doesn't exist yet
export interface GraphNode { id: string; kind: NodeKind; label: string; route?: string; sub?: string }
export interface GraphEdge { a: string; b: string; kind: 'structure' | 'link' | 'mention' | 'tag' }

export function buildGraph(s: Pick<State, 'discussions' | 'tickets' | 'roadmaps' | 'notes'>) {
  const items = itemsOf(s)
  const index = titleIndex(items)
  const nodes = new Map<string, GraphNode>(items.map((i) => [i.id, { id: i.id, kind: i.kind, label: i.title, route: i.route, sub: i.sub }]))
  const edges = new Map<string, GraphEdge>()
  // One edge per pair; a stronger kind replaces a weaker one (a typed link beats a plain mention).
  const rank = { structure: 3, link: 2, tag: 1, mention: 0 }
  const add = (a: string, b: string, kind: GraphEdge['kind']) => {
    if (a === b || !nodes.has(a) || !nodes.has(b)) return
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    const prev = edges.get(key)
    if (!prev || rank[kind] > rank[prev.kind]) edges.set(key, { a, b, kind })
  }

  for (const t of live(s.tickets)) if (t.discussionId) add(t.id, t.discussionId, 'structure')
  for (const r of live(s.roadmaps)) for (const d of r.discussionIds) add(r.id, d, 'structure')

  for (const i of items) {
    for (const target of linksIn(i.text)) {
      const hit = index.get(norm(target))
      if (hit) add(i.id, hit.id, 'link')
      else {
        const gid = `ghost:${norm(target)}`
        if (!nodes.has(gid)) nodes.set(gid, { id: gid, kind: 'ghost', label: target })
        add(i.id, gid, 'link')
      }
    }
    for (const tag of tagsIn(i.text)) {
      const tid = `tag:${tag}`
      if (!nodes.has(tid)) nodes.set(tid, { id: tid, kind: 'tag', label: `#${tag}` })
      add(i.id, tid, 'tag')
    }
    for (const other of items) if (other.id !== i.id && mentions(i.text, other.title)) add(i.id, other.id, 'mention')
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], items }
}

export const allTags = (items: LinkItem[]) => [...new Set(items.flatMap((i) => tagsIn(i.text)))].sort()
