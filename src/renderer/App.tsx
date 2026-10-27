import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, Route, Router, Switch, Redirect, useLocation } from 'wouter'
import { useHashLocation } from 'wouter/use-hash-location'
import {
  ACCENTS, DISCUSSION_TYPES, VOICE_LANGUAGES, VOICE_MODELS, daysLeft, live, nameOf, teamIds,
  type Accent, type Discussion, type Note, type Roadmap, type Snapshot, type Ticket, type User, type VoiceLanguage, type VoiceModel
} from '../shared/model'
import { applySections, htmlToText, newDiscussionDoc, sectionText } from '../shared/doc'
import { itemsOf, norm, tagsIn } from '../shared/links'
import { DocEditor, seedFromHtml } from './DocEditor'
import { openCollab, type Collab } from './collab'
import { AskBar } from './AskBar'
import { Setup, setupPending } from './Setup'
import { SyncSection } from './SyncSection'
import { PluginsSection } from './PluginsSection'
import { DiffView, type Change } from './DiffView'
import { AssistCtx, apply, describe, useAssistTarget, type AssistTarget } from './assist'
import type { AiResult } from '../main/ai'
import { LinkCtx, LinksPanel, LinkTextarea, useLinkData } from './Links'
import MindMap from './MindMap'
import { newId, useSnapshot } from './useSnapshot'

const api = () => window.pengu

// ---------- small helpers ----------

// <input type="datetime-local"> works in local "YYYY-MM-DDTHH:mm" while the store keeps ISO UTC. Convert both ways here.
const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null)
const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
const dayText = (n: number | null) => (n === null ? '—' : n === 0 ? 'Today' : n > 0 ? `${n}d` : `${-n}d late`)

const blankDiscussion = (me: User): Discussion => ({
  id: newId(), type: 'product', title: '', meetAt: null, tagged: teamIds(), design: [], doc: newDiscussionDoc(),
  updatedAt: '', updatedBy: me, deletedAt: null
})

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {hint && <span className="field-hint">{hint}</span>}
      {children}
    </label>
  )
}

// Right-hand issue panel, like Jira's: header with title and actions, scrolling body. `wide` fills the main area.
function Panel({ title, actions, wide, children }: { title: string; actions?: ReactNode; wide?: boolean; children: ReactNode }) {
  const [, nav] = useLocation()
  return (
    <aside className={`panel${wide ? ' wide' : ''}`}>
      <header className="panel-head">
        <h2>{title}</h2>
        <div className="row">
          {actions}
          <button className="btn subtle" onClick={() => nav(`/${location.hash.split('/')[1]}`)} aria-label="Close">✕</button>
        </div>
      </header>
      <div className="panel-body">{children}</div>
    </aside>
  )
}

// ---------- shell ----------

// Top-level layout: top bar, collapsible sidebar, routed content. Hash routing keeps deep links and
// widget clicks working under file:// in the packaged app.
export default function App() {
  const snap = useSnapshot()
  return (
    <Router hook={useHashLocation}>
      <Shell snap={snap} />
    </Router>
  )
}

function Shell({ snap }: { snap: Snapshot | null }) {
  const [, nav] = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [navKey, setNavKey] = useState(0)
  const [skipSetup, setSkipSetup] = useState(false)
  // Main asks us to navigate when a widget, tray item or deep link is clicked. Bumping the key remounts
  // the page, so a "new discussion" form opened again picks up the latest brainstorm line.
  useEffect(() => api().onNavigate((route) => (nav(route), setNavKey((k) => k + 1))), [nav])

  // The open panel registers itself so the Ask bar edits it; the latest registered panel wins.
  const targets = useRef<{ current: AssistTarget }[]>([])
  const [, bump] = useState(0)
  const assist = useMemo(() => ({
    add: (t: { current: AssistTarget }) => {
      targets.current.push(t)
      bump((n) => n + 1)
      return () => ((targets.current = targets.current.filter((x) => x !== t)), bump((n) => n + 1))
    }
  }), [])
  const target = () => targets.current.at(-1)?.current ?? null
  if (!snap) return null
  // First start: wait here until the voice and assistant models are on disk.
  if (!skipSetup && (setupPending(snap) || snap.assistantStatus.state === 'error' || (snap.settings.voice && snap.voiceStatus.state === 'error'))) return <Setup snap={snap} onSkip={() => setSkipSetup(true)} />

  return (
    <AssistCtx.Provider value={assist}>
    <Linked snap={snap}>
    <div className={`shell${collapsed ? ' collapsed' : ''}`}>
      <TopBar snap={snap} target={target} />
      <nav className="sidebar">
        {([
          ['discussions', 'Discussions', '◎'],
          ['tickets', 'Tickets', '▤'],
          ['notes', 'Notes', '✎'],
          ['roadmaps', 'Roadmaps', '⇢'],
          ['map', 'Mind map', '✺'],
          ['settings', 'Settings', '⚙']
        ] as const).map(([to, label, icon]) => (
          <NavItem key={to} to={`/${to}`} label={label} icon={icon} />
        ))}
        <button className="nav-item collapse" onClick={() => setCollapsed(!collapsed)}>
          <span className="nav-icon">{collapsed ? '»' : '«'}</span>
          <span className="nav-label">Collapse</span>
        </button>
      </nav>
      <main className="content" key={navKey}>
        <Switch>
          <Route path="/discussions/:id?">{(p) => <Discussions snap={snap} id={p.id} />}</Route>
          <Route path="/tickets/:id?/:from?">{(p) => <Tickets snap={snap} id={p.id} from={p.from} />}</Route>
          <Route path="/roadmaps/:id?">{(p) => <Roadmaps snap={snap} id={p.id} />}</Route>
          <Route path="/notes/:id?">{(p) => <Notes snap={snap} id={p.id} />}</Route>
          <Route path="/map/:focus?">{(p) => <MindMap key={p.focus ?? ''} snap={snap} focus={p.focus} />}</Route>
          <Route path="/settings"><SettingsPage snap={snap} /></Route>
          <Route><Redirect to="/discussions" /></Route>
        </Switch>
      </main>
    </div>
    </Linked>
    </AssistCtx.Provider>
  )
}

// Titles and tags for [[ / # autocomplete and the Links sections, rebuilt once per snapshot.
function Linked({ snap, children }: { snap: Snapshot; children: ReactNode }) {
  return <LinkCtx.Provider value={useLinkData(snap)}>{children}</LinkCtx.Provider>
}

// The top bar doubles as the window's drag area, since the native title bar is hidden.
// Padding on the platform side leaves room for macOS traffic lights or the Windows caption buttons.
function TopBar({ snap, target }: { snap: Snapshot; target: () => AssistTarget | null }) {
  const [open, setOpen] = useState(false)
  const [, nav] = useLocation()
  const go = (to: string) => (setOpen(false), nav(to))
  return (
    <header className="topbar">
      <span className="brand">Pengu</span>
      <div className="create">
        <button className="btn primary" onClick={() => setOpen(!open)} onBlur={() => setTimeout(() => setOpen(false), 150)}>
          Create
        </button>
        {open && (
          <div className="menu">
            <button onClick={() => go('/discussions/new')}>Discussion</button>
            <button onClick={() => go('/tickets/new')}>Ticket</button>
            <button onClick={() => go('/notes/new')}>Note</button>
            <button onClick={() => go('/roadmaps/new')}>Roadmap</button>
          </div>
        )}
      </div>
      <AskBar snap={snap} target={target} />
    </header>
  )
}

function NavItem({ to, label, icon }: { to: string; label: string; icon: string }) {
  const [loc] = useLocation()
  const active = loc === to || loc.startsWith(`${to}/`)
  return (
    <Link href={to} className={`nav-item${active ? ' active' : ''}`}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
    </Link>
  )
}

// ---------- discussions ----------

function Discussions({ snap, id }: { snap: Snapshot; id?: string }) {
  const [, nav] = useLocation()
  const rows = live(snap.discussions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const current = rows.find((d) => d.id === id)
  return (
    <div className="page">
      <section className="list">
        <h1>Discussions</h1>
        {rows.length === 0 ? (
          <Empty text="No discussions yet." action="New discussion" to="/discussions/new" />
        ) : (
          <table>
            <thead><tr><th>Type</th><th>Title</th><th>Meet</th><th>Tickets</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className={d.id === id ? 'selected' : ''} onClick={() => nav(`/discussions/${d.id}`)}>
                  <td><span className={`pill ${d.type}`}>{d.type}</span></td>
                  <td>{d.title}</td>
                  <td>{fmtWhen(d.meetAt)}</td>
                  <td>{live(snap.tickets).filter((t) => t.discussionId === d.id).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {id === 'new' && <NewDiscussion me={snap.settings.me} />}
      {current && <DiscussionPanel key={current.id} d={current} snap={snap} />}
    </div>
  )
}

// New discussion: title, type and meet time. Both people are tagged by default.
// If it was opened from the Brainstorm widget, the typed line becomes the title.
function NewDiscussion({ me }: { me: User }) {
  const [, nav] = useLocation()
  const [d, setD] = useState(() => blankDiscussion(me))
  useEffect(() => void api().takeSeed().then((seed) => seed && setD((x) => ({ ...x, title: seed }))), [])
  const save = async () => {
    if (!d.title.trim()) return
    await api().upsert('discussions', d)
    nav(`/discussions/${d.id}`)
  }
  return (
    <Panel title="New discussion" actions={<button className="btn primary" onClick={save}>Save</button>}>
      <Field label="Title"><input autoFocus value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
      <Field label="Type">
        <select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as Discussion['type'] })}>
          {DISCUSSION_TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
        </select>
      </Field>
      <Field label="Meet">
        <input type="datetime-local" value={toLocalInput(d.meetAt)} onChange={(e) => setD({ ...d, meetAt: fromLocalInput(e.target.value) })} />
      </Field>
      <p className="muted">Tagged: {d.tagged.map(nameOf).join(', ')}</p>
    </Panel>
  )
}

// A discussion is one document, like an Obsidian page: the five topics start as headings and can be renamed,
// moved or deleted; images paste straight in. Select text → "Make tickets", or "Find tasks" for the whole page;
// tickets that already exist are skipped, and every ticket stays editable in the list on the right.
// Edits stay a local draft until Save, so half-typed text never reaches the other person or the widgets.
function DiscussionPanel({ d: saved, snap }: { d: Discussion; snap: Snapshot }) {
  const [, nav] = useLocation()
  const [d, setD] = useState(saved)
  const [docVersion, setDocVersion] = useState(0)
  const [taskBusy, setTaskBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)
  // Live editing with the other person when signed in to Team sync; otherwise the ordinary editor.
  const signedIn = !!snap.syncStatus.user
  const [collab, setCollab] = useState<Collab | null>(null)
  const [liveState, setLive] = useState<'off' | 'connecting' | 'live' | 'offline'>('off')
  // Pengu's suggested edit, shown as a green/red diff until each change is accepted or rejected.
  const [review, setReview] = useState<{ r: AiResult; changes: Change[]; extra: string[]; created: boolean } | null>(null)
  // Compare content only; main restamps updatedAt/updatedBy on save, which would otherwise look like an edit.
  const content = (x: Discussion) => JSON.stringify({ ...x, updatedAt: '', updatedBy: '' })
  const dirty = content(d) !== content(saved)
  const tickets = live(snap.tickets).filter((t) => t.discussionId === d.id)

  useEffect(() => {
    if (!signedIn) return setLive('off')
    let gone = false
    let opened: Collab | null = null
    setLive('connecting')
    openCollab(saved.id, () => seedFromHtml(latest.current.doc))
      .then((c) => {
        if (gone) return c.destroy()
        opened = c
        c.onStatus((on) => setLive(on ? 'live' : 'offline'))
        setCollab(c)
        setLive('live')
      })
      .catch(() => !gone && setLive('off')) // can't reach the server: the ordinary editor still works
    return () => {
      gone = true
      opened?.destroy()
      setCollab(null)
    }
  }, [signedIn, saved.id])
  // Together, the text changes without anyone pressing Save, so save it shortly after it changes.
  useEffect(() => {
    if (!collab || !dirty) return
    const t = setTimeout(() => void api().upsert('discussions', latest.current), 2000)
    return () => clearTimeout(t)
  }, [collab, d.doc])

  // The Ask bar proposes edits to this draft section by section; nothing is saved until you press Save.
  const latest = useRef(d)
  latest.current = d
  const target: AssistTarget = {
    kind: 'discussions', id: d.id, title: d.title, discussionId: d.id,
    context: () => ({ title: latest.current.title, type: latest.current.type, doc: htmlToText(latest.current.doc), tickets: tickets.map((t) => ({ title: t.title, assignee: t.assignee, deadline: t.deadline, status: t.status })) }),
    patch: (r) => {
      const prev = latest.current
      if (!r.sections.length) return null
      setD({ ...prev, doc: applySections(prev.doc, r.sections) })
      setDocVersion((v) => v + 1)
      return () => (setD(prev), setDocVersion((v) => v + 1))
    },
    review: (r) => {
      if (!r.sections.length) return false
      const doc = latest.current.doc
      const changes = r.sections.map((sec, i) => {
        const before = sectionText(doc, sec.heading)
        return { key: String(i), label: sec.heading, before, after: sec.append && before ? `${before}\n${sec.markdown}` : sec.markdown }
      })
      // A suggestion that changes nothing isn't worth a review.
      const real = changes.filter((c) => c.before.trim() !== c.after.trim())
      if (!real.length) return false
      setReview({ r, changes: real, extra: describe({ ...r, sections: [] }, null), created: false })
      return true
    }
  }
  useAssistTarget(target)

  // Accepting a change puts it into the draft (and offers Undo). New tickets and notes from the same answer
  // are created together with the first accepted change.
  const decide = async (keys: string[], accept: boolean) => {
    if (!review) return
    const rest = review.changes.filter((c) => !keys.includes(c.key))
    if (accept) {
      const prev = latest.current
      const secs = keys.map((k) => review.r.sections[Number(k)])
      const next = { ...prev, doc: applySections(prev.doc, secs) }
      latest.current = next
      setD(next)
      setDocVersion((v) => v + 1)
      const undos = [() => (setD(prev), setDocVersion((v) => v + 1))]
      if (!review.created) undos.push(await apply({ ...review.r, sections: [] }, target, snap.settings.me))
      setToast({ text: 'Change accepted. Edit it freely, or undo.', undo: () => undos.reverse().forEach((u) => void u()) })
    }
    setReview(rest.length ? { ...review, changes: rest, created: review.created || accept } : null)
  }

  // Action items → tickets on this discussion. Titles that match an existing ticket are skipped (reconciled).
  const same = (a: string, b: string) => norm(a) === norm(b) || (norm(b).length > 8 && (norm(a).includes(norm(b)) || norm(b).includes(norm(a))))
  const makeTickets = async (text: string, whole: boolean) => {
    if (!text.trim()) return setToast({ text: 'Select some text first, or use Find tasks for the whole page.' })
    setTaskBusy(true)
    try {
      const existing = tickets.map((t) => t.title)
      const { tasks, via } = await api().aiTasks(text, { title: d.title, existing, whole })
      const fresh = tasks.filter((t) => !existing.some((e) => same(e, t.title)))
      const ids: string[] = []
      for (const t of fresh) {
        const row: Ticket = { id: newId(), discussionId: d.id, title: t.title, assignee: t.assignee, deadline: t.deadline, status: 'open', notes: t.notes, updatedAt: '', updatedBy: snap.settings.me, deletedAt: null }
        await api().upsert('tickets', row)
        ids.push(row.id)
      }
      const skipped = tasks.length - fresh.length
      setToast({
        text: fresh.length
          ? `Made ${fresh.length} ticket${fresh.length > 1 ? 's' : ''}${skipped ? ` (${skipped} already existed)` : ''}${via === 'offline' ? ' with the offline rules' : ''}.`
          : skipped ? 'Those tasks already have tickets.' : 'No action items found there.',
        undo: ids.length ? () => ids.forEach((id) => api().remove('tickets', id)) : undefined
      })
    } catch (e) {
      setToast({ text: String((e as Error).message).replace(/^.*?Error: /, '') })
    } finally {
      setTaskBusy(false)
    }
  }
  const openLink = async (title: string) => {
    const hit = itemsOf(snap).find((i) => norm(i.title) === norm(title))
    if (hit) return nav(hit.route)
    const note: Note = { id: newId(), title, body: '', updatedAt: '', updatedBy: snap.settings.me, deletedAt: null }
    await api().upsert('notes', note)
    nav(`/notes/${note.id}`)
  }

  return (
    <Panel
      wide
      title={d.title}
      actions={
        <>
          <button className="btn subtle" onClick={() => api().exportJson(d.title, { ...d, text: htmlToText(d.doc), tickets })}>Export</button>
          <button className="btn subtle" onClick={() => confirm('Delete this discussion?') && (api().remove('discussions', d.id), nav('/discussions'))}>Delete</button>
          <button className="btn primary" disabled={!dirty} onClick={() => api().upsert('discussions', d)}>{dirty ? 'Save' : 'Saved'}</button>
        </>
      }
    >
      <div className="page-col">
        <input className="title-input" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
        <div className="fields">
          <label>Type
            <select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as Discussion['type'] })}>
              {DISCUSSION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label>Meet <input type="datetime-local" value={toLocalInput(d.meetAt)} onChange={(e) => setD({ ...d, meetAt: fromLocalInput(e.target.value) })} /></label>
          <span className="muted">Tagged: {d.tagged.map(nameOf).join(', ')}</span>
          {liveState === 'live' && <span className="live-badge" title="Changes appear for the other person within a couple of seconds">● Live</span>}
          {liveState === 'offline' && <span className="muted" title="Your changes are kept and sent when the server is back">Reconnecting…</span>}
        </div>

        {toast && (
          <div className="toast" role="status">
            <span>{toast.text}</span>
            {toast.undo && <button className="btn subtle" onClick={() => (toast.undo!(), setToast(null))}>Undo</button>}
            <button className="btn subtle" onClick={() => setToast(null)} aria-label="Dismiss">✕</button>
          </div>
        )}
        {review ? (
          <DiffView
            changes={review.changes}
            extra={review.extra}
            onAccept={(k) => void decide([k], true)}
            onReject={(k) => void decide([k], false)}
            onAcceptAll={() => void decide(review.changes.map((c) => c.key), true)}
            onRejectAll={() => setReview(null)}
          />
        ) : signedIn && liveState === 'connecting' ? (
          <p className="muted">Connecting live editing…</p>
        ) : (
          <DocEditor
            key={collab ? 'live' : 'plain'}
            ydoc={collab?.ydoc}
            value={d.doc}
            version={docVersion}
            busy={taskBusy}
            onChange={(doc) => setD((x) => ({ ...x, doc }))}
            onTasks={(text, whole) => void makeTickets(text, whole)}
            onAsk={(text) => window.dispatchEvent(new CustomEvent('pengu:ask', { detail: text }))}
            onOpenLink={(t) => void openLink(t)}
            onOpenTag={(t) => nav(`/map/tag-${encodeURIComponent(t)}`)}
          />
        )}

        {tickets.length > 0 && (
          <div className="tickets-inline">
            <h3>Tickets</h3>
            {tickets.map((t) => <TicketRow key={`${t.id}:${t.title}`} t={t} />)}
          </div>
        )}
        <LinksPanel kind="discussions" id={d.id} title={saved.title} text={[htmlToText(d.doc), ...d.design.map((e) => e.note)].join('\n')} />
      </div>
    </Panel>
  )
}

// A ticket inside its discussion, editable in place: done, title, owner and deadline save as you change them.
function TicketRow({ t }: { t: Ticket }) {
  const [, nav] = useLocation()
  const save = (patch: Partial<Ticket>) => api().upsert('tickets', { ...t, ...patch })
  const n = daysLeft(t.deadline)
  return (
    <div className={`ticket-row${t.status === 'done' ? ' is-done' : ''}`}>
      <input type="checkbox" checked={t.status === 'done'} title="Done" onChange={() => save({ status: t.status === 'done' ? 'open' : 'done' })} />
      <input className="ticket-title" defaultValue={t.title} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== t.title && save({ title: e.target.value.trim() })} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      <div className="ticket-meta">
        <select value={t.assignee} onChange={(e) => save({ assignee: e.target.value as User })}>
          {teamIds().map((u) => <option key={u} value={u}>{nameOf(u)}</option>)}
        </select>
        <input type="date" value={t.deadline ?? ''} onChange={(e) => save({ deadline: e.target.value || null })} />
        <span className={n !== null && n < 0 && t.status === 'open' ? 'late' : 'muted'}>{dayText(n)}</span>
        <button className="btn subtle" title="Open ticket" onClick={() => nav(`/tickets/${t.id}`)}>↗</button>
      </div>
    </div>
  )
}

// ---------- tickets ----------

function Tickets({ snap, id, from }: { snap: Snapshot; id?: string; from?: string }) {
  const [, nav] = useLocation()
  const [tab, setTab] = useState<'open' | 'done'>('open')
  // Open tickets sort by nearest deadline first; tickets without a deadline go last.
  const rows = live(snap.tickets)
    .filter((t) => t.status === tab)
    .sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'))
  const current = live(snap.tickets).find((t) => t.id === id)
  return (
    <div className="page">
      <section className="list">
        <h1>Tickets</h1>
        <div className="tabs">
          {(['open', 'done'] as const).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t === 'open' ? 'Open' : 'Done'}</button>
          ))}
        </div>
        {rows.length === 0 ? (
          <Empty text={tab === 'open' ? 'No open tickets.' : 'Nothing done yet.'} action="New ticket" to="/tickets/new" />
        ) : (
          <table>
            <thead><tr><th>Title</th><th>Assignee</th><th>Deadline</th><th>Days</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((t) => {
                const n = daysLeft(t.deadline)
                return (
                  <tr key={t.id} className={t.id === id ? 'selected' : ''} onClick={() => nav(`/tickets/${t.id}`)}>
                    <td>{t.title}</td>
                    <td>{nameOf(t.assignee)}</td>
                    <td>{t.deadline ?? '—'}</td>
                    <td className={n !== null && n < 0 ? 'late' : ''}>{dayText(n)}</td>
                    <td><span className={`pill ${t.status}`}>{t.status}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
      {id === 'new' && <TicketPanel key={`new-${from ?? ''}`} snap={snap} from={from} />}
      {current && <TicketPanel key={current.id} snap={snap} ticket={current} />}
    </div>
  )
}

// Create or edit a ticket. "Discuss" turns a ticket into a discussion with a meet time and links the two,
// which is how a ticket "moves into" the five steps.
function TicketPanel({ snap, ticket, from }: { snap: Snapshot; ticket?: Ticket; from?: string }) {
  const [, nav] = useLocation()
  const me = snap.settings.me
  const [t, setT] = useState<Ticket>(
    ticket ?? { id: newId(), discussionId: from ?? null, title: '', assignee: me, deadline: null, status: 'open', updatedAt: '', updatedBy: me, deletedAt: null }
  )
  const [meet, setMeet] = useState('')
  const linked = live(snap.discussions).find((d) => d.id === t.discussionId)
  const latest = useRef(t)
  latest.current = t
  const [touched, setTouched] = useState(false)
  useAssistTarget({
    kind: 'tickets', id: t.id, title: t.title, discussionId: t.discussionId,
    context: () => ({ ...latest.current, discussion: linked?.title ?? null }),
    patch: (r) => {
      const prev = latest.current
      if (r.body === undefined) return null
      setT({ ...prev, notes: r.body })
      setTouched(true)
      return () => (setT(prev), setTouched(false))
    }
  })
  const save = async (next = t) => {
    if (!next.title.trim()) return
    await api().upsert('tickets', next)
    if (!ticket) nav(`/tickets/${next.id}`)
  }
  const discuss = async () => {
    const d = { ...blankDiscussion(me), title: t.title, meetAt: fromLocalInput(meet) }
    await api().upsert('discussions', d)
    await api().upsert('tickets', { ...t, discussionId: d.id })
    nav(`/discussions/${d.id}`)
  }
  return (
    <Panel
      title={ticket ? 'Ticket' : 'New ticket'}
      actions={
        <>
          {ticket && <button className="btn subtle" onClick={() => confirm('Delete this ticket?') && (api().remove('tickets', t.id), nav('/tickets'))}>Delete</button>}
          {ticket && <button className="btn" onClick={() => save({ ...t, status: t.status === 'open' ? 'done' : 'open' })}>{t.status === 'open' ? 'Done' : 'Reopen'}</button>}
          <button className="btn primary" onClick={() => save()}>Save</button>
        </>
      }
    >
      <Field label="Title"><input autoFocus={!ticket} value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} /></Field>
      <Field label="Assignee">
        <select value={t.assignee} onChange={(e) => setT({ ...t, assignee: e.target.value as User })}>
          {teamIds().map((u) => <option key={u} value={u}>{nameOf(u)}</option>)}
        </select>
      </Field>
      <Field label="Deadline" hint={t.deadline ? dayText(daysLeft(t.deadline)) : undefined}>
        <input type="date" value={t.deadline ?? ''} onChange={(e) => setT({ ...t, deadline: e.target.value || null })} />
      </Field>
      <Field label="Notes">
        <LinkTextarea rows={5} highlight={touched} value={t.notes ?? ''} placeholder="Details. Type [[ to link, # to tag." onChange={(v) => setT({ ...t, notes: v })} />
      </Field>
      {linked ? (
        <button className="link-row" onClick={() => nav(`/discussions/${linked.id}`)}>From discussion: {linked.title}</button>
      ) : ticket && (
        <div className="card">
          <Field label="Move into a discussion" hint="Pick a meet time; the five steps start there.">
            <input type="datetime-local" value={meet} onChange={(e) => setMeet(e.target.value)} />
          </Field>
          <button className="btn" disabled={!meet} onClick={discuss}>Discuss</button>
        </div>
      )}
      {ticket && <LinksPanel kind="tickets" id={t.id} title={ticket.title} text={t.notes ?? ''} />}
    </Panel>
  )
}

// ---------- roadmaps ----------

function Roadmaps({ snap, id }: { snap: Snapshot; id?: string }) {
  const [, nav] = useLocation()
  const rows = live(snap.roadmaps)
  const current = rows.find((r) => r.id === id)
  return (
    <div className="page">
      <section className="list">
        <h1>Roadmaps</h1>
        {rows.length === 0 ? (
          <Empty text="No roadmaps yet." action="New roadmap" to="/roadmaps/new" />
        ) : (
          <table>
            <thead><tr><th>Title</th><th>Discussions</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.id === id ? 'selected' : ''} onClick={() => nav(`/roadmaps/${r.id}`)}>
                  <td>{r.title}</td>
                  <td>{r.discussionIds.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {(id === 'new' || current) && <RoadmapPanel key={id} snap={snap} roadmap={current} />}
    </div>
  )
}

// A roadmap is a named group of discussions. Export dumps everything in it (discussions with their
// steps, numbers and tickets) as one JSON file, the same shape the MCP server will serve later.
function RoadmapPanel({ snap, roadmap }: { snap: Snapshot; roadmap?: Roadmap }) {
  const [, nav] = useLocation()
  const me = snap.settings.me
  const [r, setR] = useState<Roadmap>(roadmap ?? { id: newId(), title: '', discussionIds: [], updatedAt: '', updatedBy: me, deletedAt: null })
  const all = live(snap.discussions)
  const toggle = (id: string) =>
    setR({ ...r, discussionIds: r.discussionIds.includes(id) ? r.discussionIds.filter((x) => x !== id) : [...r.discussionIds, id] })
  const dump = () => {
    const discussions = all.filter((d) => r.discussionIds.includes(d.id))
    const tickets = live(snap.tickets).filter((t) => t.discussionId && r.discussionIds.includes(t.discussionId))
    api().exportJson(`${r.title}-dump`, { roadmap: r, discussions, tickets, exportedAt: new Date().toISOString() })
  }
  const save = async () => {
    if (!r.title.trim()) return
    await api().upsert('roadmaps', r)
    if (!roadmap) nav(`/roadmaps/${r.id}`)
  }
  return (
    <Panel
      title={roadmap ? 'Roadmap' : 'New roadmap'}
      actions={
        <>
          {roadmap && <button className="btn subtle" onClick={() => confirm('Delete this roadmap?') && (api().remove('roadmaps', r.id), nav('/roadmaps'))}>Delete</button>}
          {roadmap && <button className="btn subtle" onClick={dump}>Export dump</button>}
          <button className="btn primary" onClick={save}>Save</button>
        </>
      }
    >
      <Field label="Name"><input autoFocus={!roadmap} value={r.title} onChange={(e) => setR({ ...r, title: e.target.value })} /></Field>
      <h3>Discussions</h3>
      {all.length === 0 && <p className="muted">Create a discussion first.</p>}
      {all.map((d) => (
        <label key={d.id} className="check">
          <input type="checkbox" checked={r.discussionIds.includes(d.id)} onChange={() => toggle(d.id)} />
          <span className={`pill ${d.type}`}>{d.type}</span> {d.title}
        </label>
      ))}
    </Panel>
  )
}

// ---------- notes ----------

// Obsidian-style notes: a title and a free body where [[links]] and #tags connect them to everything else.
function Notes({ snap, id }: { snap: Snapshot; id?: string }) {
  const [, nav] = useLocation()
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const all = live(snap.notes).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const tags = [...new Set(all.flatMap((n) => tagsIn(n.body)))].sort()
  const rows = all.filter((n) => (!tag || tagsIn(n.body).includes(tag)) && (!q.trim() || `${n.title}\n${n.body}`.toLowerCase().includes(q.trim().toLowerCase())))
  const current = all.find((n) => n.id === id)
  return (
    <div className="page">
      <section className="list">
        <h1>Notes</h1>
        <div className="row filters">
          <input placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} />
          {tags.length > 0 && (
            <select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">All tags</option>
              {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
            </select>
          )}
        </div>
        {all.length === 0 ? (
          <Empty text="No notes yet. Write one, or ask Pengu to take notes for you." action="New note" to="/notes/new" />
        ) : (
          <table>
            <thead><tr><th>Title</th><th>Tags</th><th>Updated</th></tr></thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id} className={n.id === id ? 'selected' : ''} onClick={() => nav(`/notes/${n.id}`)}>
                  <td>{n.title}</td>
                  <td className="muted">{tagsIn(n.body).map((t) => `#${t}`).join(' ')}</td>
                  <td>{fmtWhen(n.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {(id === 'new' || current) && <NotePanel key={id} snap={snap} note={current} />}
    </div>
  )
}

// A note is a draft until Save, like a discussion, so the assistant's edits can be reviewed first.
function NotePanel({ snap, note }: { snap: Snapshot; note?: Note }) {
  const [, nav] = useLocation()
  const me = snap.settings.me
  const [n, setN] = useState<Note>(note ?? { id: newId(), title: '', body: '', updatedAt: '', updatedBy: me, deletedAt: null })
  const content = (x: Note) => `${x.title}\n${x.body}`
  const dirty = !note || content(n) !== content(note)
  const latest = useRef(n)
  latest.current = n
  const [touched, setTouched] = useState(false)
  const [review, setReview] = useState<{ r: AiResult; created: boolean } | null>(null)
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null)
  const target: AssistTarget = {
    kind: 'notes', id: n.id, title: n.title, discussionId: null,
    context: () => latest.current,
    patch: (r) => {
      const prev = latest.current
      if (r.body === undefined) return null
      setN({ ...prev, body: r.body })
      setTouched(true)
      return () => (setN(prev), setTouched(false))
    },
    review: (r) => {
      if (r.body === undefined || r.body.trim() === latest.current.body.trim()) return false
      setReview({ r, created: false })
      return true
    }
  }
  useAssistTarget(target)
  const accept = async () => {
    if (!review) return
    const undos = [target.patch(review.r)!, await apply({ ...review.r, body: undefined }, target, me)]
    setToast({ text: 'Change accepted. Edit it freely, or undo.', undo: () => undos.reverse().forEach((u) => void u()) })
    setReview(null)
  }
  const save = async () => {
    if (!n.title.trim()) return
    await api().upsert('notes', n)
    if (!note) nav(`/notes/${n.id}`)
  }
  return (
    <Panel
      title={note ? 'Note' : 'New note'}
      actions={
        <>
          {note && <button className="btn subtle" onClick={() => api().exportJson(n.title, n)}>Export</button>}
          {note && <button className="btn subtle" onClick={() => confirm('Delete this note?') && (api().remove('notes', n.id), nav('/notes'))}>Delete</button>}
          <button className="btn primary" disabled={!dirty} onClick={save}>{dirty ? 'Save' : 'Saved'}</button>
        </>
      }
    >
      <input className="title-input" autoFocus={!note} placeholder="Title" value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} />
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          <button className="btn subtle" onClick={() => (toast.undo(), setToast(null))}>Undo</button>
          <button className="btn subtle" onClick={() => setToast(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      {review ? (
        <DiffView
          changes={[{ key: 'body', label: 'Note', before: n.body, after: review.r.body ?? '' }]}
          extra={describe({ ...review.r, body: undefined }, null)}
          onAccept={() => void accept()}
          onReject={() => setReview(null)}
          onAcceptAll={() => void accept()}
          onRejectAll={() => setReview(null)}
        />
      ) : (
        <LinkTextarea rows={18} highlight={touched} value={n.body} placeholder="Write freely. [[ links a discussion, ticket or note; # adds a tag." onChange={(v) => setN({ ...n, body: v })} />
      )}
      {note && <LinksPanel kind="notes" id={n.id} title={note.title} text={n.body} />}
    </Panel>
  )
}

// ---------- settings ----------

// One card per topic, one row per setting: label and hint on the left, the control on the right.
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="set-card">
      <header>
        <h2>{title}</h2>
        {hint && <p className="muted">{hint}</p>}
      </header>
      {children}
    </section>
  )
}
function SetRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <span>{label}</span>
        {hint && <span className="muted">{hint}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}
function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} onClick={onChange}><span /></button>
}

// Claude Code is connected with one button: it finds the CLI and makes a tiny test call, so "Connected" means
// installed and signed in. Without it the assistant still answers, using simple offline rules.
function ClaudeSection({ snap }: { snap: Snapshot }) {
  const s = snap.settings
  const set = api().setSettings
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => void api().aiStatus().then((st) => setPath(st.claude)), [s.ai, s.claudePath])
  const connect = async () => {
    setBusy(true)
    setError('')
    const r = await api().aiConnect()
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'Could not connect.')
    setPath(r.path)
  }
  return (
    <Section title="Claude Code" hint="Pengu's assistant turns what you say into tickets, discussions and notes. Claude Code on this computer does the thinking; Pengu stores no API key.">
      <SetRow
        label={s.ai ? 'Connected' : 'Not connected'}
        hint={s.ai ? path ?? '' : path ? 'Found on this computer. Press Connect to check it is signed in.' : 'Without it, Pengu uses simple offline rules.'}
      >
        <span className={`status-dot${s.ai ? ' ok' : ''}`} />
        {s.ai ? (
          <button className="btn" onClick={() => api().aiDisconnect()}>Disconnect</button>
        ) : (
          <button className="btn primary" disabled={busy} onClick={connect}>{busy ? 'Connecting…' : 'Connect Claude Code'}</button>
        )}
      </SetRow>
      {error && <p className="set-error">{error}</p>}
      <SetRow label="Apply changes right away" hint="Undo is always offered. Off means you review and press Apply.">
        <Toggle label="Apply changes right away" on={s.aiAutoApply} onChange={() => set({ aiAutoApply: !s.aiAutoApply })} />
      </SetRow>
      <details className="set-more">
        <summary>Advanced</summary>
        <SetRow label="Path to claude" hint="Only if it isn't found automatically.">
          <input placeholder="Auto-detect" defaultValue={s.claudePath} onBlur={(e) => set({ claudePath: e.target.value.trim() })} />
        </SetRow>
      </details>
    </Section>
  )
}

// Voice uses the open-source Whisper model, downloaded in the background when Pengu starts.
function VoiceSection({ snap }: { snap: Snapshot }) {
  const s = snap.settings
  const v = snap.voiceStatus
  const set = api().setSettings
  const [bytes, setBytes] = useState(0)
  useEffect(() => void api().aiStatus().then((st) => setBytes(st.modelBytes)), [v.state, s.voiceModel])
  const status =
    !s.voice ? 'Off'
    : v.state === 'ready' ? 'Ready. Click the mic in the top bar or on the penguin and talk.'
    : v.state === 'downloading' ? `Downloading the speech model… ${v.percent}%`
    : v.state === 'error' ? v.error ?? 'Download failed.'
    : 'Starting…'
  return (
    <Section title="Voice" hint="Speech becomes text on this computer with the open-source Whisper model. Audio is never uploaded.">
      <SetRow label="Voice input" hint={<span className={v.state === 'error' && s.voice ? 'late' : ''}>{status}</span>}>
        {s.voice && v.state === 'error' && <button className="btn" onClick={() => api().voiceRetry()}>Retry</button>}
        <Toggle label="Voice input" on={s.voice} onChange={() => set({ voice: !s.voice })} />
      </SetRow>
      {s.voice && v.state === 'downloading' && <div className="progress"><span style={{ width: `${v.percent}%` }} /></div>}
      <SetRow label="Speech model" hint="Bigger models understand you better but take a moment longer.">
        <div className="tabs flat">
          {(Object.keys(VOICE_MODELS) as VoiceModel[]).map((m) => (
            <button key={m} className={s.voiceModel === m ? 'active' : ''} onClick={() => set({ voiceModel: m })}>{VOICE_MODELS[m]}</button>
          ))}
        </div>
      </SetRow>
      <SetRow label="Language" hint="Pick English if that's what you speak; it's the most accurate.">
        <select value={s.voiceLanguage} onChange={(e) => set({ voiceLanguage: e.target.value as VoiceLanguage })}>
          {(Object.keys(VOICE_LANGUAGES) as VoiceLanguage[]).map((l) => <option key={l} value={l}>{VOICE_LANGUAGES[l]}</option>)}
        </select>
      </SetRow>
      {bytes > 0 && (
        <SetRow label="Downloaded models" hint={`${(bytes / 1e6).toFixed(0)} MB on this computer`}>
          <button className="btn subtle" onClick={async () => (await set({ voice: false }), await api().modelClear(), setBytes(0))}>Delete and turn off</button>
        </SetRow>
      )}
    </Section>
  )
}

// Settings write straight through to main, which re-themes every window and re-opens widgets right away.
function SettingsPage({ snap }: { snap: Snapshot }) {
  const s = snap.settings
  const set = api().setSettings
  return (
    <div className="page">
      <section className="list settings">
        <h1>Settings</h1>
        <ClaudeSection snap={snap} />
        <VoiceSection snap={snap} />
        <SyncSection snap={snap} Section={Section} SetRow={SetRow} />
        <PluginsSection snap={snap} Section={Section} SetRow={SetRow} />
        <Section title="You">
          <SetRow label="I am" hint={snap.syncStatus.user ? 'Set by Team sync (your admin manages names and roles). Sign out of sync to change it.' : 'Your display name. A team admin adds everyone else; see the README.'}>
            {snap.syncStatus.user
              ? <span>{nameOf(s.me)} · {snap.team.find((m) => m.id === s.me)?.role ?? 'member'}</span>
              : <input value={nameOf(s.me)} maxLength={40} onChange={(e) => void api().setTeamName(e.target.value)} />}
          </SetRow>
          <SetRow label="Appearance">
            <div className="tabs flat">
              {(['system', 'light', 'dark'] as const).map((a) => (
                <button key={a} className={s.appearance === a ? 'active' : ''} onClick={() => set({ appearance: a })}>{a[0].toUpperCase() + a.slice(1)}</button>
              ))}
            </div>
          </SetRow>
          <SetRow label="Accent">
            <div className="swatches">
              {(Object.keys(ACCENTS) as Accent[]).map((a) => (
                <button key={a} title={a} className={`swatch${s.accent === a ? ' active' : ''}`} style={{ background: ACCENTS[a] || snap.systemAccent }} onClick={() => set({ accent: a })}>
                  {a === 'system' ? 'A' : ''}
                </button>
              ))}
            </div>
          </SetRow>
        </Section>
        <Section title="Desktop penguin" hint="Drag it anywhere. Click it, or press Alt+Shift+P, to open its panel. Alerts arrive as system notifications with sound.">
          <SetRow label="Show the penguin on my desktop">
            <Toggle label="Show the penguin" on={s.widget} onChange={() => set({ widget: !s.widget })} />
          </SetRow>
          <SetRow label="Keep it above other windows">
            <Toggle label="Keep on top" on={s.widgetsOnTop} onChange={() => set({ widgetsOnTop: !s.widgetsOnTop })} />
          </SetRow>
          <SetRow label="Start Pengu in the tray when I log in">
            <Toggle label="Start at login" on={s.openAtLogin} onChange={() => set({ openAtLogin: !s.openAtLogin })} />
          </SetRow>
        </Section>
        <Section title="Help">
          <SetRow label="Logs" hint="What Pengu did, with timings and errors. Never what you said.">
            <button className="btn" onClick={() => api().openLogs()}>Open logs folder</button>
          </SetRow>
        </Section>
        <p className="muted about">Pengu · open-source workspace for discussions, tickets and roadmaps.</p>
      </section>
    </div>
  )
}

function Empty({ text, action, to }: { text: string; action: string; to: string }) {
  return (
    <div className="empty">
      <p>{text}</p>
      <Link href={to} className="btn primary">{action}</Link>
    </div>
  )
}
