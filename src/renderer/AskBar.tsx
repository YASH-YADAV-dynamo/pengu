import { useEffect, useRef, useState } from 'react'
import type { AiResult } from '../main/ai'
import type { Snapshot } from '../shared/model'
import { apply, describe, type AssistTarget } from './assist'
import { useVoice, warm, type VoiceState } from './voice/useVoice'
import { VoiceModal, type Meet } from './VoiceModal'
import { calendarUrl } from '../shared/intent'

const MicIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
)
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// The mic button used by the Ask bar and the desktop penguin. While the model is still downloading it shows the
// percent; while recording it shows the time and a stop square.
export function MicButton({ snap, onText, onState, compact }: { snap: Snapshot; onText: (t: string) => void; onState?: (s: VoiceState) => void; compact?: boolean }) {
  const s = snap.settings
  const v = useVoice({ model: s.voiceModel, language: s.voiceLanguage, enabled: s.voice, onText })
  useEffect(() => {
    onState?.(v.state) // not returned: an effect may only return a cleanup function
  }, [v.state])
  const dl = snap.voiceStatus.state === 'downloading' ? snap.voiceStatus.percent : null
  const label =
    v.state === 'recording' ? `Listening ${mmss(v.seconds)}. Click to finish.`
    : v.state === 'working' ? 'Transcribing…'
    : dl !== null ? `Voice model downloading (${dl}%). You can talk now; it finishes first.`
    : 'Speak (click to start, click again to finish)'
  return (
    <span className="mic-wrap">
      {v.state === 'recording' && (
        <span className="mic-time">
          <span className="bars" aria-hidden>{[0.5, 1, 0.7, 0.9, 0.6].map((k, i) => <i key={i} style={{ transform: `scaleY(${0.2 + Math.min(1, v.level * k * 1.4) * 0.8})` }} />)}</span>
          {mmss(v.seconds)}
        </span>
      )}
      {v.state !== 'recording' && dl !== null && <span className="mic-time">{dl}%</span>}
      <button type="button" className={`mic ${v.state}${compact ? ' compact' : ''}`} onClick={v.toggle} title={label} aria-label={label} disabled={v.state === 'working' || v.state === 'starting'}>
        {v.state === 'working' || v.state === 'starting' ? <span className="spinner" /> : v.state === 'recording' ? '■' : <MicIcon />}
      </button>
      {v.error && <span className="mic-error" onClick={v.clearError} role="alert">{v.error}</span>}
    </span>
  )
}

type Pending = { r: AiResult; lines: string[]; target: AssistTarget | null; undo?: () => void }

// "Ask Pengu" in the top bar: type or speak. With a discussion, ticket or note open it edits that draft;
// otherwise it decides whether you described a ticket, a discussion (with tickets) or a note, and creates it.
// Ctrl/Cmd+K focuses it. A voice note is sent as soon as it's transcribed. It always answers: Claude Code when
// connected, the offline rules when not.
export function AskBar({ snap, target }: { snap: Snapshot; target: () => AssistTarget | null }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [voice, setVoice] = useState<VoiceState>('idle')
  const [error, setError] = useState('')
  const [result, setResult] = useState<Pending | null>(null)
  const [heard, setHeard] = useState('') // a voice note waiting for the user to check it
  const input = useRef<HTMLInputElement>(null)
  const s = snap.settings
  const t = target()

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') (e.preventDefault(), input.current?.focus())
    }
    // "Ask Pengu" on a selection in a document: quote it here and let the user say what to do with it.
    const quote = (e: Event) => {
      const sel = String((e as CustomEvent).detail ?? '').trim().slice(0, 2000)
      setText(`About this: "${sel}" → `)
      requestAnimationFrame(() => input.current?.focus())
    }
    window.addEventListener('keydown', key)
    window.addEventListener('pengu:ask', quote)
    return () => (window.removeEventListener('keydown', key), window.removeEventListener('pengu:ask', quote))
  }, [])
  // Once the model is on disk, load it in the background so the first voice note is quick.
  useEffect(() => {
    if (s.voice && snap.voiceStatus.state === 'ready') warm(s.voiceModel)
  }, [s.voice, s.voiceModel, snap.voiceStatus.state])

  const send = async (words = text) => {
    if (!words.trim() || busy) return
    const tgt = target()
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const r = await window.pengu.aiAsk(words, tgt ? { kind: tgt.kind, ...(tgt.context() as object) } : null)
      // Edits to the open page are shown as a diff to accept or reject, not applied behind your back.
      if (tgt?.review && tgt.review(r)) {
        setResult({ r, lines: [], target: tgt })
        setText('')
        return
      }
      const lines = describe(r, tgt)
      const undo = s.aiAutoApply && lines.length ? await apply(r, tgt, s.me) : undefined
      setResult({ r, lines, target: tgt, undo })
      setText('')
    } catch (e) {
      // IPC wraps main's errors as "Error invoking remote method 'ai:ask': Error: …"; show only the message.
      setError(String((e as Error).message).replace(/^.*?Error: /, ''))
    } finally {
      setBusy(false)
    }
  }

  // Confirmed from the voice dialog: run the (possibly edited) words, then open the meeting in Google Calendar.
  const confirmHeard = async (words: string, meet: Meet | null) => {
    setHeard('')
    void send(words)
    if (!meet) return
    try {
      await window.pengu.openMeet(calendarUrl(meet.title, meet.start, meet.minutes))
    } catch (e) {
      setError(String((e as Error).message).replace(/^.*?Error: /, ''))
    }
  }

  const placeholder =
    voice === 'recording' ? 'Listening… click ■ when you are done'
    : voice === 'working' ? 'Turning your voice into text…'
    : busy ? (s.ai ? 'Claude is working on it…' : 'Working on it…')
    : t ? `Tell Pengu what to add to "${t.title || 'this'}"… (Ctrl+K)`
    : 'Say or type anything: a task, a meeting recap, an idea… (Ctrl+K)'

  return (
    <div className="ask">
      {heard && <VoiceModal heard={heard} onConfirm={(w, m) => void confirmHeard(w, m)} onCancel={() => setHeard('')} />}
      <form className={`ask-bar${busy || voice === 'working' ? ' busy' : ''}${voice === 'recording' ? ' listening' : ''}`} onSubmit={(e) => (e.preventDefault(), void send())}>
        <span className="ask-spark">✦</span>
        <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} disabled={busy} />
        {busy ? (
          <button type="button" className="btn subtle" onClick={() => window.pengu.aiCancel()}>Stop</button>
        ) : (
          <MicButton snap={snap} compact onState={setVoice} onText={setHeard} />
        )}
      </form>
      {(result || error) && (
        <div className="ask-result" role="status">
          {error ? (
            <p className="late">{error}</p>
          ) : result && (
            <>
              <p>{result.r.reply}</p>
              {result.lines.length > 0 && <ul>{result.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
              {result.undo && result.target && result.lines.some((l) => l.startsWith('Updated')) && <p className="muted">Edits are in the draft. Press Save to keep them.</p>}
            </>
          )}
          <div className="row end">
            {result && !result.undo && result.lines.length > 0 && (
              <button className="btn primary" onClick={async () => setResult({ ...result, undo: await apply(result.r, result.target, s.me) })}>Apply</button>
            )}
            {result?.undo && <button className="btn" onClick={() => (result.undo!(), setResult(null))}>Undo</button>}
            <button className="btn subtle" onClick={() => (setResult(null), setError(''))}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
