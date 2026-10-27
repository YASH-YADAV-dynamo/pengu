// What the assistant's answer does to the workspace. Shared by the main window's Ask bar and the desktop
// penguin, so a voice note gives the same result from either place.
import { createContext, useContext, useEffect, useRef } from 'react'
import type { AiResult } from '../main/ai'
import { live, teamIds, nameOf, type Discussion, type Note, type Snapshot, type Ticket, type User } from '../shared/model'
import { applySections, newDiscussionDoc } from '../shared/doc'
import { norm } from '../shared/links'
import { newId } from './useSnapshot'

const api = () => window.pengu

// The item open in the window. Its panel owns an unsaved draft, so only the panel can apply edits to it;
// it registers here, and the Ask bar sends the draft as context and hands the answer back.
export interface AssistTarget {
  kind: 'discussions' | 'tickets' | 'notes'
  id: string
  title: string
  discussionId: string | null // new tickets from the assistant link here
  context: () => unknown
  patch: (r: AiResult) => (() => void) | null // returns an undo, or null when nothing in the draft changed
  review?: (r: AiResult) => boolean // shows the edits as a green/red diff to accept or reject; true when it took over
}

type Reg = { add: (t: { current: AssistTarget }) => () => void }
export const AssistCtx = createContext<Reg>({ add: () => () => {} })

// Call from a panel: while it is mounted, the Ask bar edits this item. The ref keeps the latest draft without re-registering.
export function useAssistTarget(t: AssistTarget) {
  const reg = useContext(AssistCtx)
  const ref = useRef(t)
  ref.current = t
  useEffect(() => reg.add(ref), [reg])
}

// A one-line summary per change, shown before applying (or after, next to Undo).
export function describe(r: AiResult, target: AssistTarget | null): string[] {
  const lines: string[] = []
  if (target) {
    if (target.kind === 'discussions') for (const s of r.sections) lines.push(`Updated ${s.heading}`)
    if (r.body !== undefined && target.kind !== 'discussions') lines.push(target.kind === 'notes' ? 'Updated note' : 'Updated ticket notes')
  }
  for (const d of r.newDiscussions) lines.push(`New discussion: ${d.title}${d.meetAt ? ` (meet ${new Date(d.meetAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })})` : ''}`)
  for (const t of r.newTickets) lines.push(`New ticket: ${t.title} → ${nameOf(t.assignee)}${t.deadline ? `, due ${t.deadline}` : ''}${t.discussion ? ` · in ${t.discussion}` : ''}`)
  for (const n of r.newNotes) lines.push(`New note: ${n.title}`)
  return lines
}

// Apply everything and return one undo. Edits to the open item go into its draft (you still press Save);
// new tickets, notes and discussions are saved right away, and Undo deletes them again.
// Discussions are created first, so a ticket that names one (new in this answer, or existing) hangs off it on the map.
export async function apply(r: AiResult, target: AssistTarget | null, me: User): Promise<() => void> {
  const undos: (() => unknown)[] = []
  const draftUndo = target?.patch(r)
  if (draftUndo) undos.push(draftUndo)
  const stamp = { updatedAt: '', updatedBy: me, deletedAt: null }
  const snap: Snapshot = await api().getState()
  const byTitle = new Map(live(snap.discussions).map((d) => [norm(d.title), d.id]))

  for (const d of r.newDiscussions) {
    const row: Discussion = { id: newId(), type: d.type, title: d.title, meetAt: d.meetAt, tagged: teamIds(), doc: applySections(newDiscussionDoc(), d.sections), design: [], ...stamp }
    await api().upsert('discussions', row)
    byTitle.set(norm(d.title), row.id)
    undos.push(() => api().remove('discussions', row.id))
  }
  for (const t of r.newTickets) {
    const discussionId = target?.discussionId ?? (t.discussion ? byTitle.get(norm(t.discussion)) : undefined) ?? null
    const row: Ticket = { id: newId(), discussionId, title: t.title, assignee: t.assignee, deadline: t.deadline, status: 'open', notes: t.notes, ...stamp }
    await api().upsert('tickets', row)
    undos.push(() => api().remove('tickets', row.id))
  }
  for (const n of r.newNotes) {
    const row: Note = { id: newId(), title: n.title, body: n.body, ...stamp }
    await api().upsert('notes', row)
    undos.push(() => api().remove('notes', row.id))
  }
  return () => undos.reverse().forEach((u) => void u())
}
