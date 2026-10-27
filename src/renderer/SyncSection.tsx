import { useState, type ReactNode } from 'react'
import { nameOf, type Snapshot } from '../shared/model'

// Settings → Team sync. Sign in with your username and password; the server address is whatever your admin shared.
// The password goes to the server once and is not kept: the app keeps only an encrypted sign-in token.

const when = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'not yet')

export function SyncSection({ snap, Section, SetRow }: {
  snap: Snapshot
  Section: (p: { title: string; hint?: string; children: ReactNode }) => ReactNode
  SetRow: (p: { label: string; hint?: ReactNode; children: ReactNode }) => ReactNode
}) {
  const st = snap.syncStatus
  const signedIn = st.state === 'idle' || st.state === 'syncing' || (st.state === 'error' && !!st.user)
  const [url, setUrl] = useState('')
  const [user, setUser] = useState(snap.syncStatus.user ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const signIn = async () => {
    setBusy(true)
    setError('')
    try {
      await window.pengu.syncSignIn(url, user, password)
      setPassword('')
    } catch (e) {
      setError(String((e as Error).message).replace(/^.*?Error: /, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Team sync" hint="Keeps discussions, tickets, notes and roadmaps the same on every computer. Images stay on the computer that added them.">
      {signedIn ? (
        <>
          <SetRow
            label={`Signed in as ${nameOf(st.user!)} · ${snap.team.find((m) => m.id === st.user)?.role ?? 'member'}`}
            hint={<span className={st.state === 'error' ? 'late' : ''}>{st.state === 'syncing' ? 'Syncing…' : st.state === 'error' ? st.error : `Up to date. Last synced ${when(st.at)}.`}</span>}
          >
            <button className="btn" disabled={st.state === 'syncing'} onClick={() => void window.pengu.syncNow()}>Sync now</button>
            <button className="btn subtle" onClick={() => void window.pengu.syncSignOut()}>Sign out</button>
          </SetRow>
        </>
      ) : (
        <form onSubmit={(e) => (e.preventDefault(), void signIn())}>
          <SetRow label="Server address" hint="Looks like https://pengu.example.com or http://localhost:8787">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoComplete="off" spellCheck={false} />
          </SetRow>
          <SetRow label="Username" hint="Created by your admin with the Pengu CLI.">
            <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" spellCheck={false} />
          </SetRow>
          <SetRow label="Password">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </SetRow>
          <SetRow label={st.state === 'error' ? st.error ?? '' : 'Not signed in'} hint={error ? <span className="late">{error}</span> : undefined}>
            <button className="btn primary" type="submit" disabled={busy || !url.trim() || !user.trim() || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </SetRow>
        </form>
      )}
    </Section>
  )
}
