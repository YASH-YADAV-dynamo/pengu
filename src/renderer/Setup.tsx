import { useState } from 'react'
import type { Snapshot } from '../shared/model'
import { Penguin } from './Penguin'

// First start: the open-source models (voice, writing assistant, search) download once, and the app opens when
// they are on disk. If a download fails the user can retry, or carry on without it (voice and the assistant then
// wait for the next start).
export function setupPending(snap: Snapshot) {
  const v = snap.voiceStatus
  const a = snap.assistantStatus
  return (snap.settings.voice && (v.state === 'off' || v.state === 'downloading')) || a.state === 'checking' || a.state === 'downloading'
}

const Bar = ({ label, percent, state }: { label: string; percent: number; state: string }) => (
  <div className="setup-row">
    <span>{label}</span>
    <span className="muted">{state === 'ready' ? 'Ready' : state === 'error' ? 'Failed' : `${percent}%`}</span>
    <div className="progress"><span style={{ width: `${state === 'ready' ? 100 : percent}%` }} /></div>
  </div>
)

export function Setup({ snap, onSkip }: { snap: Snapshot; onSkip: () => void }) {
  const [busy, setBusy] = useState(false)
  const v = snap.voiceStatus
  const a = snap.assistantStatus
  const failed = [snap.settings.voice && v.state === 'error' ? v.error : '', a.state === 'error' ? a.error : ''].filter(Boolean)
  return (
    <div className="setup">
      <Penguin mood="happy" size={96} />
      <h1>Setting up Pengu</h1>
      <p className="muted">Pengu runs its voice and writing assistant on this computer, so your notes never leave it. They download once; the app opens when they're ready.</p>
      {snap.settings.voice && <Bar label="Voice" percent={v.percent} state={v.state === 'off' ? 'downloading' : v.state} />}
      <Bar label="Writing assistant and search" percent={a.percent} state={a.state === 'checking' ? 'downloading' : a.state} />
      {failed.map((e) => <p key={e} className="late">{e}</p>)}
      {failed.length > 0 && (
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => (setBusy(true), void window.pengu.voiceRetry().finally(() => setBusy(false)))}>Retry</button>
          <button className="btn" onClick={onSkip}>Continue without</button>
        </div>
      )}
    </div>
  )
}
