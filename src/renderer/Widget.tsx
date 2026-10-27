import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { daysLeft, live, type Snapshot } from '../shared/model'
import { apply } from './assist'
import { MicButton } from './AskBar'
import { Penguin, type Mood } from './Penguin'
import { useSnapshot } from './useSnapshot'

// One thing Pengu can tell you about: a meet you're tagged on, or a ticket assigned to you.
interface Item {
  id: string
  kind: 'meet' | 'ticket'
  title: string
  when: string
  at: number // sort key, epoch ms
  urgent: boolean
  route: string
}

const MIN = 60_000
// Short relative time: "now", "in 8m", "in 3h", else a weekday and time like "Tue 14:00".
function meetLabel(at: number) {
  const d = at - Date.now()
  if (d <= 0) return 'now'
  if (d < 60 * MIN) return `in ${Math.ceil(d / MIN)}m`
  if (d < 6 * 60 * MIN) return `in ${Math.round(d / (60 * MIN))}h`
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}
const dueLabel = (n: number | null) => (n === null ? '' : n === 0 ? 'today' : n > 0 ? `${n}d` : `${-n}d late`)

// Everything that matters to me: an imminent meet first (it can't wait), then everything else soonest first. A meet is urgent from 15 min before until it ends (1h);
// a ticket is urgent when it's due today or late. Meets older than an hour and other people's tickets are dropped.
function itemsFor(snap: Snapshot): Item[] {
  const me = snap.settings.me
  const now = Date.now()
  const meets = live(snap.discussions)
    .filter((d) => d.meetAt && d.tagged.includes(me))
    .map((d) => ({ d, at: new Date(d.meetAt!).getTime() }))
    .filter(({ at }) => at > now - 60 * MIN && at < now + 7 * 24 * 60 * MIN)
    .map(({ d, at }): Item => ({ id: d.id, kind: 'meet', title: d.title, when: meetLabel(at), at, urgent: at - now < 15 * MIN, route: `/discussions/${d.id}` }))
  const tickets = live(snap.tickets)
    .filter((t) => t.status === 'open' && t.assignee === me)
    .map((t): Item => {
      const n = daysLeft(t.deadline)
      return { id: t.id, kind: 'ticket', title: t.title, when: dueLabel(n), at: t.deadline ? now + (n ?? 0) * 1440 * MIN : Infinity, urgent: n !== null && n <= 0, route: `/tickets/${t.id}` }
    })
  const rank = (i: Item) => (i.kind === 'meet' && i.urgent ? 0 : 1)
  return [...meets, ...tickets].sort((a, b) => rank(a) - rank(b) || a.at - b.at)
}

// The desktop penguin, inspired by "a tiny character sitting on a status pill":
// collapsed, it shows the one thing that matters most; click it (or press Alt+Shift+P) and a panel lists the rest.
// Drag it anywhere; a press that moves less than 4px counts as a click.
export default function Widget() {
  const snap = useSnapshot()
  const root = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean; raf: number } | null>(null)
  const doneCount = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | 'meet' | 'ticket'>('all')
  const [happyUntil, setHappyUntil] = useState(0)
  const [line, setLine] = useState('')
  const [asking, setAsking] = useState(false)
  const [reply, setReply] = useState('')
  // While listening or thinking, the panel must not close on blur, or the mic and the answer vanish with it.
  const busy = useRef(false)
  const [, rerender] = useState(0)

  // Labels like "in 8m" must tick even when no data changes; once a minute is enough.
  useEffect(() => {
    const t = setInterval(() => rerender((n) => n + 1), MIN)
    return () => clearInterval(t)
  }, [])

  // The panel closes when focus leaves the widget or on Escape, like a popover; the shortcut toggles it.
  useEffect(() => {
    const close = () => !busy.current && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('blur', close)
    window.addEventListener('keydown', esc)
    const off = window.pengu.onWidgetToggle(() => setOpen((o) => !o))
    return () => (window.removeEventListener('blur', close), window.removeEventListener('keydown', esc), off())
  }, [])

  // The window takes the page's exact size, so the transparent area never blocks clicks on the desktop.
  useLayoutEffect(() => {
    if (!root.current) return
    const ro = new ResizeObserver(([e]) => {
      const r = e.target.getBoundingClientRect()
      window.pengu.fitWidget(Math.ceil(r.width), Math.ceil(r.height))
    })
    ro.observe(root.current)
    return () => ro.disconnect()
  }, [])

  // Celebrate when a ticket gets marked done anywhere (the window or a sync), not on first load.
  const done = snap ? live(snap.tickets).filter((t) => t.status === 'done').length : null
  useEffect(() => {
    if (done === null) return
    if (doneCount.current !== null && done > doneCount.current) setHappyUntil(Date.now() + 2000)
    doneCount.current = done
  }, [done])
  useEffect(() => {
    if (!happyUntil) return
    const t = setTimeout(() => setHappyUntil(0), happyUntil - Date.now())
    return () => clearTimeout(t)
  }, [happyUntil])

  // Pointer handling for click-vs-drag. Moves go to main at most once per frame via rAF,
  // which keeps dragging smooth without flooding IPC.
  const onDown = (e: PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.screenX, y: e.screenY, moved: false, raf: 0 }
  }
  const onMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.screenX - d.x
    const dy = e.screenY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    if (!d.moved) (d.moved = true), window.pengu.dragWidget('start')
    cancelAnimationFrame(d.raf)
    d.raf = requestAnimationFrame(() => window.pengu.dragWidget('move', dx, dy))
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.moved) window.pengu.dragWidget('end')
    else setOpen((o) => !o)
  }

  // Ask Pengu from the desktop: nothing is open here, so the assistant creates tickets, notes or discussions.
  const ask = async (words: string) => {
    if (!snap || !words.trim() || asking) return
    setAsking(true)
    busy.current = true
    setReply('')
    try {
      const r = await window.pengu.aiAsk(words, null)
      await apply(r, null, snap.settings.me)
      setReply(r.reply)
      setLine('')
      setHappyUntil(Date.now() + 1500)
    } catch (e) {
      setReply(String((e as Error).message).replace(/^.*?Error: /, ''))
    } finally {
      setAsking(false)
      busy.current = false
    }
  }

  if (!snap) return <div className="pg-root" ref={root} />
  const items = itemsFor(snap)
  const top = items[0]
  const urgent = items.some((i) => i.urgent)
  // Mood priority: a fresh win beats everything, then anything urgent, then sleep when nothing is pending.
  const mood: Mood = happyUntil ? 'happy' : urgent ? 'alert' : items.length === 0 ? 'sleep' : 'idle'
  const shown = items.filter((i) => filter === 'all' || i.kind === filter)
  const meets = items.filter((i) => i.kind === 'meet').length
  const tickets = items.length - meets

  return (
    <div className="pg-root" ref={root}>
      <div className="pg-anchor" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} title="Drag to move · click to open">
        <Penguin mood={mood} size={48} />
        <div className={`pg-pill${urgent ? ' urgent' : ''}`}>
          {top ? (
            <>
              <span className="pg-pill-text">{top.title}</span>
              <span className="pg-pill-when">{top.when}</span>
            </>
          ) : (
            <span className="pg-pill-text muted">All clear</span>
          )}
        </div>
      </div>

      {open && (
        <div className="pg-panel">
          <header className="pg-head">
            <span className="pg-brand">Pengu</span>
            <span className="pg-count">{meets} meets · {tickets} tickets</span>
            <button className="pg-icon" onClick={() => window.pengu.open('/discussions')} title="Open Pengu">↗</button>
          </header>
          <div className="pg-chips">
            {(['all', 'meet', 'ticket'] as const).map((f) => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'meet' ? 'Meets' : 'Tickets'}
              </button>
            ))}
          </div>
          <div className="pg-list">
            {shown.length === 0 && <div className="pg-empty">Nothing here. Pengu is napping.</div>}
            {shown.map((i) => (
              <button key={i.id} className="pg-item" onClick={() => window.pengu.open(i.route)}>
                <span className={`pg-kind ${i.kind}`}>{i.kind === 'meet' ? 'Meet' : 'Ticket'}</span>
                <span className="pg-item-title">{i.title}</span>
                <span className={`pg-item-when${i.urgent ? ' urgent' : ''}`}>{i.when}</span>
              </button>
            ))}
          </div>
          {reply && <div className="pg-reply" onClick={() => setReply('')}>✦ {reply}</div>}
          {/* Brainstorm: Enter opens the full app on a new discussion with the line as its title.
              ✦ (or speaking, when the assistant is on) asks Pengu to file it as tickets, notes or a discussion. */}
          <form
            className="pg-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (!line.trim()) return
              window.pengu.open('/discussions/new', line.trim())
              setLine('')
              setHappyUntil(Date.now() + 1500)
            }}
          >
            <input className="pg-input" value={line} disabled={asking} onChange={(e) => setLine(e.target.value)} placeholder={asking ? 'Pengu is thinking…' : 'Brainstorm an idea… ↵'} />
            <button type="button" className="pg-icon" title="Ask Pengu to file this as a ticket, discussion or note" disabled={asking || !line.trim()} onClick={() => void ask(line)}>✦</button>
            {snap.settings.voice && (
              <MicButton snap={snap} compact onState={(st) => (busy.current = st !== 'idle' || asking)} onText={(w) => setLine(w)} />
            )}
          </form>
        </div>
      )}
    </div>
  )
}
