import { powerMonitor, safeStorage, shell, app } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { findDate } from '../../shared/dates'
import type { GmailStatus, Ticket } from '../../shared/model'
import { log } from '../log'
import * as store from '../store'

// Gmail plugin: emails you put the "Pengu" label on become your tickets (title = subject, the notes link back to the
// email). The tickets are ordinary local rows, so Team sync shares them like any other.
//
// Privacy: Pengu asks Google only for the `gmail.metadata` scope, so it can see labels and headers (subject, sender)
// but never an email's body or attachments. Sign-in is Google's own page in your browser (OAuth with PKCE, answered on
// a one-off 127.0.0.1 port). The refresh token is encrypted with the OS keychain (safeStorage) and never leaves this
// computer. The OAuth client id and secret come from your own Google Cloud project ("Desktop app" client).

const SCOPE = 'https://www.googleapis.com/auth/gmail.metadata'
const LABEL = 'pengu'
const EVERY = 2 * 60_000
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

interface Secret { clientId: string; clientSecret: string; refreshToken: string }
interface Saved { email: string; seen: string[]; secret: string }

const file = () => join(app.getPath('userData'), 'gmail.json')
let saved: (Omit<Saved, 'secret'> & Secret) | null = null
let access: { token: string; until: number } | null = null
let status: GmailStatus = { state: 'off' }
let notify: () => void = () => {}
let running: Promise<void> | null = null

export const getStatus = () => status
const set = (s: GmailStatus) => ((status = s), notify())

function load() {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Saved
    if (!safeStorage.isEncryptionAvailable()) return null
    const secret = JSON.parse(safeStorage.decryptString(Buffer.from(raw.secret, 'base64'))) as Secret
    return { email: raw.email, seen: raw.seen ?? [], ...secret }
  } catch {
    return null
  }
}
function save() {
  if (!saved) return
  const { clientId, clientSecret, refreshToken, ...rest } = saved
  const secret = safeStorage.encryptString(JSON.stringify({ clientId, clientSecret, refreshToken })).toString('base64')
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify({ ...rest, secret }), { mode: 0o600 })
  renameSync(tmp, file())
}

// ---------- Google sign-in ----------

const b64url = (b: Buffer) => b.toString('base64url')

async function tokenCall(params: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) })
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!res.ok || !data.access_token) throw new Error(data.error === 'invalid_grant' ? 'Google sign-in expired or was revoked. Connect Gmail again.' : data.error_description ?? data.error ?? `Google answered ${res.status}.`)
  access = { token: data.access_token, until: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000 }
  return data
}

// Opens Google's consent page in the browser and waits (up to 5 minutes) for it to redirect back to a local port.
function consent(clientId: string): Promise<{ code: string; verifier: string; redirect: string }> {
  const verifier = b64url(randomBytes(32))
  const state = b64url(randomBytes(16))
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (u.pathname !== '/' || u.searchParams.get('state') !== state) return void res.writeHead(404).end()
      const code = u.searchParams.get('code')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<p style="font:16px system-ui;margin:40px">${code ? 'Gmail is connected. You can close this tab and go back to Pengu.' : 'Gmail was not connected. You can close this tab.'}</p>`)
      done()
      code ? resolve({ code, verifier, redirect }) : reject(new Error('Google sign-in was cancelled.'))
    })
    let redirect = ''
    const timer = setTimeout(() => (done(), reject(new Error('Google sign-in timed out. Try again.'))), 5 * 60_000)
    const done = () => (clearTimeout(timer), server.close())
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, state, access_type: 'offline', prompt: 'consent',
        code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256'
      })
      void shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${q}`)
    })
    server.on('error', (e) => (done(), reject(e)))
  })
}

export async function connect(clientIdRaw: unknown, clientSecretRaw: unknown) {
  const clientId = String(clientIdRaw ?? '').trim()
  const clientSecret = String(clientSecretRaw ?? '').trim()
  if (!/^[\w.-]{10,200}\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Enter the OAuth client id (ends with .apps.googleusercontent.com).')
  if (!/^[\w-]{10,100}$/.test(clientSecret)) throw new Error('Enter the OAuth client secret.')
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer can't store the Google sign-in securely (no keychain available).")
  set({ state: 'connecting' })
  try {
    const { code, verifier, redirect } = await consent(clientId)
    const t = await tokenCall({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier })
    if (!t.refresh_token) throw new Error('Google did not return a refresh token. Remove Pengu from your Google account permissions and connect again.')
    saved = { email: '', seen: [], clientId, clientSecret, refreshToken: t.refresh_token }
    saved.email = ((await gmail<{ emailAddress?: string }>('/profile')).emailAddress ?? '').slice(0, 200)
    save()
    log('gmail', 'connected')
  } catch (e) {
    saved = null
    set({ state: 'error', error: (e as Error).message })
    throw e
  }
  await pollNow()
}

export async function disconnect() {
  const token = saved?.refreshToken
  saved = null
  access = null
  rmSync(file(), { force: true })
  set({ state: 'off' })
  log('gmail', 'disconnected')
  // Also withdraw Pengu's access on Google's side; if this fails the token is still gone from this computer.
  if (token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => {})
}

async function gmail<T>(path: string): Promise<T> {
  if (!saved) throw new Error('Gmail is not connected.')
  if (!access || access.until < Date.now()) await tokenCall({ refresh_token: saved.refreshToken, client_id: saved.clientId, client_secret: saved.clientSecret, grant_type: 'refresh_token' })
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${access!.token}` }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Gmail answered ${res.status}.`)
  return (await res.json()) as T
}

// ---------- labelled emails -> tickets ----------

interface Message { id: string; threadId: string; payload?: { headers?: { name: string; value: string }[] } }

async function poll() {
  if (!saved) return
  const { labels = [] } = await gmail<{ labels?: { id: string; name: string }[] }>('/labels')
  const label = labels.find((l) => l.name.toLowerCase() === LABEL)
  if (!label) return set({ state: 'ok', email: saved.email, at: new Date().toISOString(), error: 'Create a Gmail label called "Pengu" and add it to emails you want as tickets.' })
  const { messages = [] } = await gmail<{ messages?: { id: string }[] }>(`/messages?labelIds=${encodeURIComponent(label.id)}&maxResults=50`)
  const fresh = messages.filter((m) => /^[\w-]{1,64}$/.test(m.id) && !saved!.seen.includes(m.id))
  const tickets: Ticket[] = []
  for (const m of fresh) {
    const msg = await gmail<Message>(`/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`)
    const header = (n: string) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? ''
    const title = header('subject').replace(/^((re|fwd?):\s*)+/i, '').trim().slice(0, 300) || '(no subject)'
    const me = store.get().settings.me
    const now = new Date().toISOString()
    tickets.push({
      id: crypto.randomUUID(), discussionId: null, title, assignee: me, deadline: findDate(title), status: 'open',
      notes: `From email by ${header('from').slice(0, 200)}\nhttps://mail.google.com/mail/u/?authuser=${encodeURIComponent(saved.email)}#all/${msg.threadId}`,
      updatedAt: now, updatedBy: me, deletedAt: null
    })
  }
  saved.seen = [...saved.seen, ...fresh.map((m) => m.id)].slice(-5000)
  if (tickets.length)
    store.update((s) => {
      s.tickets.push(...tickets)
      const lines = tickets.map((t) => ({ id: crypto.randomUUID(), at: t.updatedAt, by: t.updatedBy, text: `New ticket from Gmail: ${t.title}`, route: `/tickets/${t.id}` }))
      s.activity = [...lines, ...s.activity].slice(0, 30)
    })
  save()
  if (tickets.length) log('gmail', `${tickets.length} new ticket(s)`)
  set({ state: 'ok', email: saved.email, at: new Date().toISOString(), created: (status.created ?? 0) + tickets.length })
}

export function pollNow(): Promise<void> {
  if (!saved) return Promise.resolve()
  running ??= poll()
    .catch((e: Error) => {
      log('gmail', 'failed:', e)
      if (/revoked|expired/.test(e.message)) return void disconnect().then(() => set({ state: 'error', error: e.message }))
      set({ ...status, state: 'error', email: saved?.email, error: /fetch failed|timeout|abort/i.test(e.message) ? "Can't reach Gmail. Pengu will keep trying." : e.message })
    })
    .finally(() => (running = null))
  return running
}

export function start(onStatus: () => void) {
  notify = onStatus
  saved = existsSync(file()) ? load() : null
  if (saved) (set({ state: 'ok', email: saved.email }), void pollNow())
  setInterval(() => void pollNow(), EVERY).unref()
  powerMonitor.on('resume', () => void pollNow())
}
