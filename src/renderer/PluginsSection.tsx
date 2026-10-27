import { useState, type ReactNode } from 'react'
import type { Snapshot } from '../shared/model'

// Settings → Plugins. Gmail runs in this app (your Google sign-in stays on this computer); Slack runs on the team's
// sync server, so here it only explains how to use it. Setup for both: docs/plugins.md.

const when = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'not yet')

export function PluginsSection({ snap, Section, SetRow }: {
  snap: Snapshot
  Section: (p: { title: string; hint?: string; children: ReactNode }) => ReactNode
  SetRow: (p: { label: string; hint?: ReactNode; children: ReactNode }) => ReactNode
}) {
  const st = snap.gmailStatus
  const connected = st.state === 'ok' || (st.state === 'error' && !!st.email)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const connect = async () => {
    setBusy(true)
    setError('')
    try {
      await window.pengu.gmailConnect(clientId, clientSecret)
      setClientSecret('')
    } catch (e) {
      setError(String((e as Error).message).replace(/^.*?Error: /, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Plugins" hint="Bring work in from the tools your team already uses. New tickets sync to everyone like any other.">
      {connected ? (
        <SetRow
          label={`Gmail · ${st.email}`}
          hint={<span className={st.state === 'error' ? 'late' : ''}>{st.error ?? `Emails you label "Pengu" become your tickets. Last checked ${when(st.at)}.`}</span>}
        >
          <button className="btn" onClick={() => void window.pengu.gmailNow()}>Check now</button>
          <button className="btn subtle" onClick={() => void window.pengu.gmailDisconnect()}>Disconnect</button>
        </SetRow>
      ) : (
        <form onSubmit={(e) => (e.preventDefault(), void connect())}>
          <SetRow label="Gmail" hint="Label an email &quot;Pengu&quot; in Gmail and it becomes your ticket. Pengu sees only subjects and senders, never email bodies.">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="OAuth client id" autoComplete="off" spellCheck={false} />
          </SetRow>
          <SetRow label="Client secret" hint="From your team's Google Cloud project (a &quot;Desktop app&quot; OAuth client). Stored encrypted on this computer.">
            <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
          </SetRow>
          <SetRow label={st.state === 'connecting' ? 'Finish signing in to Google in your browser…' : st.state === 'error' ? st.error ?? '' : 'Not connected'} hint={error ? <span className="late">{error}</span> : undefined}>
            <button className="btn primary" type="submit" disabled={busy || !clientId.trim() || !clientSecret.trim()}>{busy ? 'Connecting…' : 'Connect Gmail'}</button>
          </SetRow>
        </form>
      )}
      <SetRow
        label="Slack"
        hint={snap.syncStatus.user ? 'In a Slack channel, mention @Pengu: "@Pengu fix the login page for @ben by friday", "@Pengu my tickets", "@Pengu done 3f2a9c". Your admin turns it on and links your Slack account.' : 'Needs Team sync. Once signed in, mention @Pengu in Slack to create and close tickets.'}
      >
        <span className="muted">{snap.syncStatus.user ? 'On the team server' : 'Off'}</span>
      </SetRow>
    </Section>
  )
}
