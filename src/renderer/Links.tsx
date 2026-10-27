import { createContext, useContext, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useLocation } from 'wouter'
import type { Kind, Note, Snapshot } from '../shared/model'
import { allTags, backlinks, itemsOf, linkMentions, linksIn, mapText, norm, tagsIn, titleIndex, type LinkItem } from '../shared/links'
import { newId } from './useSnapshot'

// Obsidian-style linking in the window: [[ and # autocomplete in text boxes, and a Links section on every item
// with outgoing links, tags, backlinks and unlinked mentions.

export const KIND_ICON: Record<Kind, string> = { discussions: '◎', tickets: '▤', roadmaps: '⇢', notes: '✎' }

interface LinkData { items: LinkItem[]; tags: string[]; snap: Snapshot }
export const LinkCtx = createContext<LinkData | null>(null)
export const useLinkData = (snap: Snapshot): LinkData =>
  useMemo(() => {
    const items = itemsOf(snap)
    return { items, tags: allTags(items), snap }
  }, [snap])

type Suggest = { mode: 'link' | 'tag'; start: number; query: string; options: { label: string; value: string; icon: string }[]; active: number }

// Find what's being typed at the caret: "[[part" (no closing ]] yet) or "#part".
function trigger(text: string, caret: number) {
  const before = text.slice(0, caret)
  const link = before.match(/\[\[([^[\]\n]*)$/)
  if (link) return { mode: 'link' as const, start: caret - link[1].length, query: link[1] }
  const tag = before.match(/(^|[\s(,;])#([\p{L}\p{N}_/-]*)$/u)
  if (tag) return { mode: 'tag' as const, start: caret - tag[2].length, query: tag[2] }
  return null
}

// A textarea that suggests titles after [[ and existing tags after #. Enter or Tab inserts; Escape closes.
export function LinkTextarea({ value, onChange, rows = 4, placeholder, highlight }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; highlight?: boolean }) {
  const data = useContext(LinkCtx)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [sug, setSug] = useState<Suggest | null>(null)

  const refresh = (text: string, caret: number) => {
    const t = trigger(text, caret)
    if (!t || !data) return setSug(null)
    const q = norm(t.query)
    const options =
      t.mode === 'link'
        ? data.items.filter((i) => norm(i.title).includes(q)).slice(0, 8).map((i) => ({ label: i.title, value: i.title, icon: KIND_ICON[i.kind] }))
        : data.tags.filter((g) => g.includes(q)).slice(0, 8).map((g) => ({ label: `#${g}`, value: g, icon: '#' }))
    // Offer the typed text itself for a new link (a ghost note) or a new tag.
    if (q && !options.some((o) => norm(o.value) === q)) options.push({ label: t.mode === 'link' ? `New: ${t.query}` : `#${t.query}`, value: t.query, icon: '+' })
    setSug(options.length ? { ...t, options, active: 0 } : null)
  }

  // Replace the partial word at the caret (and a closing ]] already there) with the full link or tag.
  const insert = (pick: string) => {
    if (!sug || !ref.current) return
    const text = value
    const caret = ref.current.selectionStart
    const after = text.slice(caret).replace(sug.mode === 'link' ? /^[^[\]\n]*\]\]/ : /^[\p{L}\p{N}_/-]*/u, '')
    const piece = sug.mode === 'link' ? `${pick}]]` : `${pick} `
    const next = text.slice(0, sug.start) + piece + after
    onChange(next)
    setSug(null)
    const pos = sug.start + piece.length
    requestAnimationFrame(() => ref.current?.setSelectionRange(pos, pos))
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!sug) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setSug({ ...sug, active: (sug.active + d + sug.options.length) % sug.options.length })
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      insert(sug.options[sug.active].value)
    } else if (e.key === 'Escape') setSug(null)
  }

  return (
    <div className="link-text">
      <textarea
        ref={ref}
        rows={rows}
        value={value}
        placeholder={placeholder}
        className={highlight ? 'ai-touched' : ''}
        onChange={(e) => (onChange(e.target.value), refresh(e.target.value, e.target.selectionStart))}
        onKeyDown={onKey}
        onClick={(e) => refresh(value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setSug(null), 150)}
      />
      {sug && (
        <div className="suggest" role="listbox">
          {sug.options.map((o, i) => (
            <button key={o.label} type="button" role="option" aria-selected={i === sug.active} className={i === sug.active ? 'active' : ''} onMouseDown={(e) => (e.preventDefault(), insert(o.value))}>
              <span className="suggest-icon">{o.icon}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// The Links section of an item: where it points, what points at it, and plain mentions that could become links.
// `text` is the live draft, so new [[links]] show up while typing, before Save.
export function LinksPanel({ kind, id, title, text }: { kind: Kind; id: string; title: string; text: string }) {
  const data = useContext(LinkCtx)
  const [, nav] = useLocation()
  if (!data) return null
  const index = titleIndex(data.items)
  const outgoing = [...new Set(linksIn(text))]
  const tags = tagsIn(text)
  const self: LinkItem = { id, kind, title, text, route: '' }
  const { linked, unlinked } = title.trim() ? backlinks(self, data.items) : { linked: [], unlinked: [] }

  // Clicking a link to something that doesn't exist creates a note with that title, as Obsidian does.
  const open = async (target: string) => {
    const hit = index.get(norm(target))
    if (hit) return nav(hit.route)
    const note: Note = { id: newId(), title: target, body: '', updatedAt: '', updatedBy: data.snap.settings.me, deletedAt: null }
    await window.pengu.upsert('notes', note)
    nav(`/notes/${note.id}`)
  }
  // Turn plain mentions of this title in another item into [[links]], and save that item.
  const linkIn = (other: LinkItem) => {
    const rows = data.snap[other.kind] as unknown as (Record<string, unknown> & { id: string })[]
    const row = rows.find((r) => r.id === other.id && !r.deletedAt)
    if (row) void window.pengu.upsert(other.kind, mapText(other.kind, row, (t) => linkMentions(t, title)))
  }

  return (
    <div className="links">
      <div className="row between">
        <h3>Links</h3>
        <button className="btn subtle" onClick={() => nav(`/map/${id}`)}>Show on map</button>
      </div>
      {tags.length > 0 && (
        <div className="chips">
          {tags.map((t) => <button key={t} className="chip tag" onClick={() => nav(`/map/tag-${encodeURIComponent(t)}`)}>#{t}</button>)}
        </div>
      )}
      {outgoing.length > 0 && (
        <div className="chips">
          {outgoing.map((l) => {
            const hit = index.get(norm(l))
            return (
              <button key={l} className={`chip${hit ? '' : ' ghost'}`} title={hit ? `Open ${l}` : `Create note "${l}"`} onClick={() => void open(l)}>
                {hit ? KIND_ICON[hit.kind] : '+'} {l}
              </button>
            )
          })}
        </div>
      )}
      {!tags.length && !outgoing.length && <p className="muted">Type [[ to link a discussion, ticket or note, and # to tag.</p>}
      {linked.length > 0 && (
        <>
          <span className="field-label">Linked mentions</span>
          {linked.map((i) => (
            <button key={i.id} className="link-row" onClick={() => nav(i.route)}>
              <span>{KIND_ICON[i.kind]} {i.title}</span>
            </button>
          ))}
        </>
      )}
      {unlinked.length > 0 && (
        <>
          <span className="field-label">Unlinked mentions</span>
          {unlinked.map((i) => (
            <div key={i.id} className="link-row">
              <button className="plain" onClick={() => nav(i.route)}>{KIND_ICON[i.kind]} {i.title}</button>
              <button className="btn subtle" onClick={() => linkIn(i)}>Link</button>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
