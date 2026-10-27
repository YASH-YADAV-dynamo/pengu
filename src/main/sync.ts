import { app, powerMonitor, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KINDS, nameOf, type Kind, type Member, type State, type SyncStatus, type User } from '../shared/model'
import { log } from './log'
import * as store from './store'

// Team sync with the Pengu server (see server/: your own Postgres, run locally or on any host). The app holds no database credentials:
// you sign in with your name and password, the server returns a token, and the token (encrypted with the OS keychain
// through Electron's safeStorage) is the only secret kept here. Every few seconds after a change, and every minute,
// the app pushes what you changed and pulls what the other person changed. Last write wins on updatedAt.

interface Saved { url: string; user: User; token: string; expiresAt: number; cursor: number; pushedAt: string }

const file = () => join(app.getPath('userData'), 'sync.json')
const CHUNK = 200
const EVERY = 30_000
const DEBOUNCE = 4_000

let saved: Saved | null = null
let status: SyncStatus = { state: 'off' }
let running: Promise<void> | null = null
let again = false // a change arrived while syncing: go round once more
let applying = false // our own writes from the server must not trigger another sync
let debounce: NodeJS.Timeout | undefined
let notify: (s: SyncStatus) => void = () => {}
let team: Member[] | null = null // the list from the login reply, applied once the sign-in is saved

export const getStatus = () => status
const set = (s: SyncStatus) => ((status = s), notify(s))

// ---------- the saved token ----------

function load(): Saved | null {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Omit<Saved, 'token'> & { token: string }
    if (!safeStorage.isEncryptionAvailable()) return null
    return { ...raw, token: safeStorage.decryptString(Buffer.from(raw.token, 'base64')) }
  } catch {
    return null
  }
}
function save() {
  if (!saved) return
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify({ ...saved, token: safeStorage.encryptString(saved.token).toString('base64') }), { mode: 0o600 })
  renameSync(tmp, file())
}

// https only, except localhost for trying the server on your own computer.
export function cleanUrl(raw: unknown): string {
  let u: URL
  try {
    u = new URL(String(raw).trim())
  } catch {
    throw new Error('Enter the server address, like https://pengu-sync.vercel.app')
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('The server address must start with https://')
  return u.origin
}

// ---------- talking to the server ----------

class AuthError extends Error {}

async function call<T>(path: string, body: unknown, token?: string): Promise<T> {
  const url = saved?.url
  if (!url) throw new Error('Not signed in.')
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000)
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (res.status === 401 && token) throw new AuthError(data.error ?? 'Sign in again.')
  if (!res.ok) throw new Error(data.error ?? `The server answered ${res.status}.`)
  return data as T
}

export async function signIn(urlRaw: unknown, user: unknown, password: unknown): Promise<void> {
  const url = cleanUrl(urlRaw)
  const name = String(user ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new Error('Enter your username (the one your admin created).')
  if (typeof password !== 'string' || !password) throw new Error('Enter your password.')
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer can't store the sign-in securely (no keychain available).")
  saved = { url, user: name as User, token: '', expiresAt: 0, cursor: 0, pushedAt: '' }
  try {
    const r = await call<{ token: string; expiresAt: number; team?: Member[] }>('/api/auth/login', { user: name, password })
    saved = { ...saved, token: r.token, expiresAt: r.expiresAt }
    if (r.team) team = r.team
  } catch (e) {
    saved = null
    throw e
  }
  save()
  // Signing in makes this app that person's.
  store.update((s) => void ((s.settings.me = name), team && (s.team = team)))
  log('sync', `signed in as ${name}`)
  await syncNow()
}

export function signOut() {
  saved = null
  rmSync(file(), { force: true })
  set({ state: 'off' })
  log('sync', 'signed out')
}

// ---------- push and pull ----------

type Row = Record<string, unknown> & { id: string; updatedAt: string; updatedBy: User; deletedAt: string | null; title?: string }
interface Reply { cursor: number; more: boolean; team?: Member[]; rows: { kind: Kind; data: Row }[]; rejected: { kind: string; id: string; error: string }[]; applied: number }

const validRow = (kind: unknown, d: unknown): d is Row =>
  KINDS.includes(kind as Kind) && !!d && typeof d === 'object' &&
  typeof (d as Row).id === 'string' && /^[\w-]{1,64}$/.test((d as Row).id) &&
  typeof (d as Row).updatedAt === 'string' && /^[\w-]{1,32}$/.test((d as Row).updatedBy)

// Take the server's rows into the local store: a row wins only if it is newer than ours. Nothing is restamped,
// and a change by the other person adds one line to the activity list.
function applyRemote(rows: Reply['rows'], members?: Member[]): number {
  let n = 0
  store.update((s) => {
    if (members?.length) s.team = members
    for (const { kind, data } of rows) {
      if (!validRow(kind, data)) continue
      const list = s[kind] as unknown as Row[]
      const i = list.findIndex((r) => r.id === data.id)
      if (i >= 0 && list[i].updatedAt >= data.updatedAt) continue
      i >= 0 ? (list[i] = data) : list.push(data)
      n++
      if (data.updatedBy !== s.settings.me && !data.deletedAt) {
        const text = `${nameOf(data.updatedBy)} ${i < 0 ? 'started' : 'updated'} ${data.title ?? kind}`
        const route = `/${kind}/${data.id}`
        s.activity = [{ id: crypto.randomUUID(), at: data.updatedAt, by: data.updatedBy, text, route }, ...s.activity].slice(0, 30)
      }
    }
  })
  return n
}

function pending(s: State, me: User, since: string): { kind: Kind; data: Row }[] {
  return KINDS.flatMap((kind) => (s[kind] as unknown as Row[]).filter((r) => r.updatedBy === me && r.updatedAt > since).map((data) => ({ kind, data })))
    .sort((a, b) => (a.data.updatedAt < b.data.updatedAt ? -1 : 1))
}

async function round() {
  if (!saved) return
  if (saved.expiresAt < Date.now()) throw new AuthError('Your sign-in expired. Sign in again.')
  const me = saved.user
  const todo = pending(store.get(), me, saved.pushedAt)
  let pulled = 0
  let firstPass = true
  for (let i = 0; firstPass || i < todo.length; i += CHUNK) {
    firstPass = false
    const chunk = todo.slice(i, i + CHUNK)
    const r = await call<Reply>('/api/sync', { cursor: saved.cursor, changes: chunk }, saved.token)
    for (const x of r.rejected) log('sync', `server rejected ${x.kind}/${x.id}: ${x.error}`)
    applying = true
    try {
      pulled += applyRemote(r.rows, r.team)
    } finally {
      applying = false
    }
    saved.cursor = r.cursor
    if (chunk.length) saved.pushedAt = chunk[chunk.length - 1].data.updatedAt
    save()
    // More to download than one reply holds: keep pulling until caught up.
    let more = r.more
    while (more) {
      const p = await call<Reply>('/api/sync', { cursor: saved.cursor, changes: [] }, saved.token)
      applying = true
      try {
        pulled += applyRemote(p.rows, p.team)
      } finally {
        applying = false
      }
      saved.cursor = p.cursor
      more = p.more
      save()
    }
  }
  log('sync', `pushed ${todo.length}, received ${pulled}`)
}

// Live editing of one discussion's document: send the updates made since last time, get every update not seen yet.
// Updates are opaque base64 here; the page's editor merges them (Yjs). Needs a sign-in.
export interface DocReply { updates: { id: number; update: string }[]; last: number; more: boolean }
export async function docExchange(docId: unknown, since: unknown, updates: unknown, seed: unknown): Promise<DocReply> {
  if (!saved?.token) throw new Error('Sign in to Team sync to edit together.')
  if (typeof docId !== 'string' || !/^[\w-]{1,64}$/.test(docId)) throw new Error('bad document id')
  const list = Array.isArray(updates) ? updates.filter((u): u is string => typeof u === 'string') : []
  try {
    return await call<DocReply>('/api/doc', { docId, since: Number(since) || 0, updates: list, ...(typeof seed === 'string' ? { seed } : {}) }, saved.token)
  } catch (e) {
    if (e instanceof AuthError) {
      saved = null
      rmSync(file(), { force: true })
      set({ state: 'error', error: e.message })
    }
    throw e
  }
}

export function syncNow(): Promise<void> {
  if (!saved) return Promise.resolve()
  if (running) return (again = true, running)
  set({ state: 'syncing', user: saved.user, at: status.at })
  running = round()
    .then(() => set({ state: 'idle', user: saved?.user, at: new Date().toISOString() }))
    .catch((e: Error) => {
      log('sync', 'failed:', e)
      if (e instanceof AuthError) {
        saved = null
        rmSync(file(), { force: true })
        return set({ state: 'error', error: e.message })
      }
      // Offline is normal for a laptop; say so plainly and try again on the next tick.
      set({ state: 'error', user: saved?.user, at: status.at, error: /fetch failed|timeout|abort/i.test(e.message) ? "Can't reach the server. Pengu will keep trying." : e.message })
    })
    .finally(() => {
      running = null
      if (again) ((again = false), void syncNow())
    })
  return running
}

// Start at app launch: restore the sign-in, then sync on changes, every minute, and when the laptop wakes.
export function start(onStatus: (s: SyncStatus) => void) {
  notify = onStatus
  saved = existsSync(file()) ? load() : null
  if (saved) void syncNow()
  store.onChange(() => {
    if (!saved || applying) return
    clearTimeout(debounce)
    debounce = setTimeout(() => void syncNow(), DEBOUNCE)
  })
  setInterval(() => void syncNow(), EVERY).unref()
  powerMonitor.on('resume', () => void syncNow())
}
