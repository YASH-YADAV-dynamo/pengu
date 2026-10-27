import { useEffect, useMemo, useRef, useState } from 'react'
import { detect, meetingFor, type IntentKind } from '../shared/intent'

// What Pengu heard, shown before anything happens. The words are editable; the chips show what keyword search
// found in them (ticket, meeting, discussion, note) and update as you type. A meeting offers Google Calendar with
// the time filled in, and only opens it when this box is confirmed with that option ticked.
export interface Meet { title: string; start: Date; minutes: number }

const LABEL: Record<IntentKind, string> = { ticket: 'Ticket', meet: 'Meeting', discussion: 'Discussion', note: 'Note' }
const toInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)

export function VoiceModal({ heard, onConfirm, onCancel }: { heard: string; onConfirm: (text: string, meet: Meet | null) => void; onCancel: () => void }) {
  const [text, setText] = useState(heard)
  const found = useMemo(() => detect(text), [text])
  const kinds = [...new Set(found.map((m) => m.kind))]
  const suggested = useMemo(() => meetingFor(text), [text])
  const [calendar, setCalendar] = useState(true)
  // Title and time follow the words until the user edits them.
  const [title, setTitle] = useState<string | null>(null)
  const [when, setWhen] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => area.current?.focus(), [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const start = when ? new Date(when) : suggested.start
  const meet = kinds.includes('meet') && calendar && !Number.isNaN(start.getTime()) ? { title: title ?? suggested.title, start, minutes: suggested.minutes } : null
  const go = () => text.trim() && onConfirm(text.trim(), meet)

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-label="Check what Pengu heard">
        <h2>Pengu heard</h2>
        <textarea ref={area} rows={5} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && go()} aria-label="What Pengu heard. Edit it if it's wrong." />
        <div className="chips">
          {kinds.length === 0 && <span className="muted">No keywords found. Pengu will decide whether it's a ticket, discussion or note.</span>}
          {kinds.map((k) => (
            <span key={k} className={`chip on kind-${k}`} title={`Found: ${found.filter((m) => m.kind === k).map((m) => m.word).join(', ')}`}>
              {LABEL[k]} <span className="muted">· {found.filter((m) => m.kind === k).map((m) => m.word).slice(0, 2).join(', ')}</span>
            </span>
          ))}
        </div>
        {kinds.includes('meet') && (
          <div className="meet-box">
            <label className="check"><input type="checkbox" checked={calendar} onChange={(e) => setCalendar(e.target.checked)} /> Set up this meeting in Google Calendar (opens in Chrome; you confirm there)</label>
            {calendar && (
              <div className="fields">
                <label>Title <input value={title ?? suggested.title} onChange={(e) => setTitle(e.target.value)} /></label>
                <label>Time <input type="datetime-local" value={when ?? toInput(suggested.start)} onChange={(e) => setWhen(e.target.value)} /></label>
              </div>
            )}
          </div>
        )}
        <div className="row end">
          <button className="btn subtle" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!text.trim()} onClick={go}>{meet ? 'Do it and open Calendar' : 'Do it'}</button>
        </div>
      </div>
    </div>
  )
}
