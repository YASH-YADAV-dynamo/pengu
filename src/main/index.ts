import { app, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerMonitor, protocol, session, shell, systemPreferences, Tray, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { KINDS, VOICE_MODELS, daysLeft, isUser, live, nameOf, type AssistantStatus, type Kind, type Settings, type Snapshot, type State, type VoiceStatus } from '../shared/model'
import { mapText, norm, renameLinks } from '../shared/links'
import * as ai from './ai'
import { localAsk, localTasks } from './local'
import { log, logDir } from './log'
import * as models from './models'
import * as llm from './llm'
import * as sync from './sync'
import * as gmail from './plugins/gmail'
import * as voice from './voice'
import * as store from './store'
import { allWindows, applyTheme, dragWidget, fitWidget, setQuitting, showMain, syncWidgets, toggleWidget } from './windows'

const isMac = process.platform === 'darwin'
const APP_ID = 'app.pengu.desktop' // must equal appId in electron-builder.yml, or Windows toasts silently vanish
let tray: Tray | null = null
let pendingRoute: string | null = null // a deep link that arrived before the app was ready
let pendingSeed = '' // brainstorm line waiting for the new-discussion form to pick it up

// ---------- Single instance and deep links ----------

// One running copy only. A second launch (e.g. clicking a pengu:// link on Windows) hands its argv to the first.
if (!app.requestSingleInstanceLock()) app.quit()

// Turn pengu://tickets/abc into /tickets/abc, but only for routes the app has. Anything else is ignored,
// because any website can trigger a pengu:// link.
const ROUTE_OK = /^\/(discussions|tickets|roadmaps|notes|map|settings)(\/[\w-]{1,64})?$/
function routeFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const route = '/' + (u.host + u.pathname).replace(/^\/+|\/+$/g, '')
    return ROUTE_OK.test(route) ? route : null
  } catch {
    return null
  }
}
const openLink = (url: string) => {
  const route = routeFromUrl(url)
  if (!route) return
  if (app.isReady()) showMain(route)
  else pendingRoute = route
}

// Windows passes the link in argv; macOS sends open-url, which can fire before 'ready', hence the queue.
app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => a.startsWith('pengu://'))
  link ? openLink(link) : showMain()
})
app.on('open-url', (e, url) => {
  e.preventDefault()
  openLink(url)
})
// In dev the app runs as electron.exe plus a script path, so Windows needs both to relaunch it from a link.
if (process.defaultApp) app.setAsDefaultProtocolClient('pengu', process.execPath, [resolve(process.argv[1])])
else app.setAsDefaultProtocolClient('pengu')

// ---------- Images pasted into documents ----------

// Pasted images are files in userData/images named by their SHA-256, served to the page as pengu-img://<hash>.<ext>.
// Keeping them out of pengu.json keeps every state broadcast small; the name check means only those files are served.
protocol.registerSchemesAsPrivileged([{ scheme: 'pengu-img', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const imageDir = () => join(app.getPath('userData'), 'images')
const IMAGE_NAME = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/

// ---------- State broadcast ----------

// The OS accent as #RRGGBB. Electron returns RRGGBBAA; the alpha is dropped. Blue is the fallback.
function systemAccent() {
  try {
    return '#' + systemPreferences.getAccentColor().slice(0, 6)
  } catch {
    return '#0C66E4'
  }
}

// Push the whole state to every window. The data is a few hundred KB at most, so a full send
// is simpler and safer than diffing.
let voiceStatus: VoiceStatus = { state: 'off', percent: 0, model: '' }
let assistantStatus: AssistantStatus = { state: 'checking', percent: 0 }
const snapshot = (s: State = store.get()): Snapshot => ({ ...s, systemAccent: systemAccent(), voiceStatus, assistantStatus, syncStatus: sync.getStatus(), gmailStatus: gmail.getStatus() })
function broadcast(s: State = store.get()) {
  const snap = snapshot(s)
  for (const w of allWindows()) w.webContents.send('state', snap)
}

// Apply the OS-facing side of settings: theme, widgets, tray menu and launch at login.
// Login items are skipped in dev, otherwise every dev run would register electron.exe to start with the OS.
let lastLogin: boolean | null = null
function applySettings(s: Settings) {
  nativeTheme.themeSource = s.appearance
  syncVoice(s)
  syncWidgets(s)
  buildTray(s)
  if (app.isPackaged && lastLogin !== s.openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: s.openAtLogin, args: ['--hidden'] })
    lastLogin = s.openAtLogin
  }
}

// Voice is on by default, so the open-source Whisper model downloads in the background as soon as the app starts
// (and again if the user picks another model). Windows learn the progress from the snapshot.
const voiceModel = () => { const m = store.get().settings.voiceModel; return m in VOICE_MODELS ? m : 'Xenova/whisper-base' }
let voiceKey = ''
function syncVoice(s: Settings) {
  const model = s.voiceModel in VOICE_MODELS ? s.voiceModel : 'Xenova/whisper-base'
  const key = s.voice ? model : 'off'
  if (key === voiceKey) return
  voiceKey = key
  if (!s.voice) return void ((voiceStatus = { state: 'off', percent: 0, model }), broadcast())
  void models.ensure(model, (st) => {
    if (voiceKey !== st.model) return // the user switched models mid-download
    voiceStatus = st
    broadcast()
  })
}

// The writing assistant's models download on first start, and the window shows a setup screen until they're on disk.
function syncAssistant() {
  void models.ensureAssistant((st) => {
    assistantStatus = st
    if (st.state === 'ready') llm.warm()
    broadcast()
  })
}

// ---------- Google Calendar in Chrome ----------

const safeCalendarUrl = (raw: string) => {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && u.hostname === 'calendar.google.com' && u.pathname === '/calendar/render' ? u.toString() : null
  } catch {
    return null
  }
}
// No shell is involved on either platform: the URL is one argument, so its & and ? can't be read as commands.
async function openInChrome(url: string): Promise<'chrome' | 'browser'> {
  const tried = await new Promise<boolean>((done) => {
    if (isMac) return execFile('open', ['-a', 'Google Chrome', url], (err) => done(!err))
    if (process.platform === 'linux') return execFile('google-chrome', [url], (err) => done(!err)) // not found: falls back to the default browser
    const dirs = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[]
    const exe = dirs.map((d) => join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(existsSync)
    if (!exe) return done(false)
    execFile(exe, [url], (err) => done(!err))
  })
  if (tried) return 'chrome'
  await shell.openExternal(url)
  return 'browser'
}

// ---------- Tray ----------

// Mac menu bar needs a black "Template" image that macOS tints for light and dark bars.
// Windows gets a colored PNG. The @2x files are picked up automatically on high-DPI screens.
function buildTray(s: Settings) {
  if (!tray) {
    const icon = nativeImage.createFromPath(join(__dirname, '../../resources', isMac ? 'trayTemplate.png' : 'tray.png'))
    tray = new Tray(icon)
    tray.setToolTip('Pengu')
    if (!isMac) tray.on('click', () => showMain()) // on Windows a left click opens; the right click shows the menu
  }
  const toggle = (patch: Partial<Settings>) => store.update((st) => void Object.assign(st.settings, patch))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Pengu', click: () => showMain() },
      { label: 'New brainstorm', click: () => showMain('/discussions/new') },
      { type: 'separator' },
      { label: 'Show desktop penguin', type: 'checkbox', checked: s.widget, click: () => toggle({ widget: !s.widget }) },
      { label: 'Test alert sound', click: () => notify('Pengu', 'Alerts look and sound like this.', '/discussions') },
      { label: 'Keep widget on top', type: 'checkbox', checked: s.widgetsOnTop, click: () => toggle({ widgetsOnTop: !s.widgetsOnTop }) },
      { type: 'separator' },
      { label: 'Quit Pengu', click: () => (setQuitting(), app.quit()) }
    ])
  )
}

// ---------- Alerts and reminders ----------

// Every alert is an OS notification with the system's default sound: a Windows toast or a macOS banner.
// They show even when Pengu's windows are closed, and clicking one opens the app on that item.
// Mac needs a named sound to play one; on Windows, sound is on unless `silent` is set.
function notify(title: string, body: string, route: string) {
  if (!Notification.isSupported()) return
  const toast = new Notification({ title, body, silent: false, ...(isMac ? { sound: 'Glass' } : {}) })
  toast.on('click', () => showMain(route))
  toast.show()
}

// Packaged builds only. A newer GitHub Release downloads in the background; the toast appears once it is ready.
// Clicking it restarts into that version. Quitting from the tray installs it too, if the toast was dismissed.
function watchUpdates() {
  if (!app.isPackaged) return
  let told = ''
  autoUpdater.on('update-downloaded', (info) => {
    const version = info.version
    if (!version || told === version || !Notification.isSupported()) return
    told = version
    log('update', `downloaded ${version}`)
    const toast = new Notification({
      title: 'A new version of Pengu is ready',
      body: `Version ${version} has been downloaded. Click to restart and update.`,
      silent: false,
      ...(isMac ? { sound: 'Glass' as const } : {})
    })
    toast.on('click', () => {
      log('update', `install ${version}`)
      setQuitting()
      store.flush()
      autoUpdater.quitAndInstall(true, true)
    })
    toast.show()
  })
  autoUpdater.on('error', (e) => log('update', 'failed:', e))
  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  check()
  powerMonitor.on('resume', check)
}

// Electron can't schedule a notification for later, and a long setTimeout drifts or dies across sleep.
// So a 30s tick compares the wall clock with what is due, and stores fired keys so nothing repeats.
// Rules: meet reminder 10 min before (until 1h after start); ticket deadline at 09:00 on the due day;
// plus any activity by the other person from the last day (a new ticket for me, a saved step), which arrives once sync lands.
function tick() {
  const s = store.get()
  const me = s.settings.me
  const now = Date.now()
  const due: { key: string; title: string; body: string; route: string }[] = []

  for (const d of live(s.discussions)) {
    if (!d.meetAt || !d.tagged.includes(me)) continue
    const at = new Date(d.meetAt).getTime()
    if (now >= at - 10 * 60_000 && now < at + 60 * 60_000)
      due.push({ key: `meet:${d.id}:${d.meetAt}`, title: 'Meet soon', body: d.title, route: `/discussions/${d.id}` })
  }
  for (const t of live(s.tickets)) {
    if (t.status !== 'open' || t.assignee !== me || !t.deadline) continue
    if ((daysLeft(t.deadline) ?? 1) <= 0 && new Date().getHours() >= 9)
      due.push({ key: `due:${t.id}:${t.deadline}`, title: 'Ticket due', body: t.title, route: `/tickets/${t.id}` })
  }
  for (const a of s.activity) {
    if (a.by !== me && now - new Date(a.at).getTime() < 86_400_000)
      due.push({ key: `alert:${a.id}`, title: nameOf(a.by), body: a.text, route: a.route })
  }

  const fresh = due.filter((n) => !s.fired.includes(n.key))
  if (!fresh.length) return
  for (const n of fresh) notify(n.title, n.body, n.route)
  store.update((st) => void (st.fired = [...st.fired, ...fresh.map((n) => n.key)].slice(-500)))
}

// ---------- IPC ----------

// What the window and widgets may ask of main. Every argument is checked here because the renderer
// is treated as untrusted input, even though it is our own code.
function registerIpc() {
  const isKind = (k: unknown): k is Kind => KINDS.includes(k as Kind)
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,64}$/.test(id)

  ipcMain.handle('state:get', (): Snapshot => snapshot())

  // Create or replace a row. Main stamps who and when, so the renderer can't fake either,
  // and logs one activity line for the Alerts widget.
  ipcMain.handle('item:upsert', (_e, kind: unknown, item: { id?: unknown; title?: unknown } & Record<string, unknown>) => {
    if (!isKind(kind) || !item || !validId(item.id)) throw new Error('bad upsert')
    store.update((s) => {
      const me = s.settings.me
      const rows = s[kind] as unknown as Record<string, unknown>[]
      const i = rows.findIndex((r) => r.id === item.id)
      const row = { deletedAt: null, ...item, updatedAt: new Date().toISOString(), updatedBy: me }
      const title = String(item.title ?? '')
      // Renamed: point every [[Old title]] in the workspace at the new title, as Obsidian does.
      const old = i >= 0 ? String(rows[i].title ?? '') : ''
      if (old.trim() && norm(old) !== norm(title)) {
        for (const k of KINDS) {
          const list = s[k] as unknown as Record<string, unknown>[]
          list.forEach((r, j) => {
            const next = mapText(k, r, (t) => renameLinks(t, old, title))
            // Rows whose links were rewritten count as changed by you, so sync sends them too.
            list[j] = JSON.stringify(next) === JSON.stringify(r) ? r : { ...next, updatedAt: new Date().toISOString(), updatedBy: me }
          })
        }
      }
      i >= 0 ? (rows[i] = row) : rows.push(row)
      const assignee = isUser(item.assignee) ? item.assignee : me
      const text =
        kind === 'tickets' && i < 0 ? `New ticket for ${nameOf(assignee)}: ${title}`
        : kind === 'tickets' && item.status === 'done' ? `${nameOf(me)} closed ${title}`
        : `${nameOf(me)} ${i < 0 ? 'started' : 'updated'} ${title}`
      const route = `/${kind}/${item.id}`
      s.activity = [{ id: crypto.randomUUID(), at: row.updatedAt, by: me, text, route }, ...s.activity].slice(0, 30)
    })
  })

  // Soft delete only, matching the Neon schema: the row stays with deletedAt set, so sync can pass the delete on.
  ipcMain.handle('item:remove', (_e, kind: unknown, id: unknown) => {
    if (!isKind(kind) || !validId(id)) throw new Error('bad remove')
    store.update((s) => {
      const row = (s[kind] as { id: string; deletedAt: string | null; updatedAt: string; updatedBy: string }[]).find((r) => r.id === id)
      // Stamped like any other change, so sync sends the delete to the other person.
      if (row) Object.assign(row, { deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: s.settings.me })
    })
  })

  // Only known settings keys are merged; anything else in the patch is dropped.
  ipcMain.handle('settings:set', (_e, patch: Record<string, unknown>) => {
    const keys = Object.keys(store.get().settings)
    store.update((s) => {
      for (const k of Object.keys(patch ?? {})) if (keys.includes(k)) (s.settings as unknown as Record<string, unknown>)[k] = patch[k]
    })
  })

  // Your display name while nobody else is in the app. Signed in, names come from the server instead.
  ipcMain.handle('team:rename', (_e, name: unknown) => {
    const text = typeof name === 'string' ? name.trim().slice(0, 40) : ''
    if (!text || sync.getStatus().user) return
    store.update((s) => void (s.team = s.team.map((m) => (m.id === s.settings.me ? { ...m, name: text } : m))))
  })

  // Widgets call this to open the full window on a route. The brainstorm line is parked in main and the
  // form takes it on mount, so it survives even when the window has to be created first.
  ipcMain.handle('app:open', (_e, route: unknown, seed?: unknown) => {
    if (typeof route !== 'string' || !ROUTE_OK.test(route)) return
    if (typeof seed === 'string') pendingSeed = seed.slice(0, 500)
    showMain(route)
  })
  ipcMain.handle('widget:fit', (_e, w: unknown, h: unknown) => fitWidget(Number(w), Number(h)))
  ipcMain.handle('widget:drag', (_e, phase: unknown, dx: unknown, dy: unknown) => {
    if (phase === 'start' || phase === 'move' || phase === 'end') dragWidget(phase, Number(dx), Number(dy))
  })
  ipcMain.handle('seed:take', () => {
    const seed = pendingSeed
    pendingSeed = ''
    return seed
  })

  // ---------- AI and voice ----------
  // Without Claude Code: the built-in open-source model rewrites the part of the open page the request is about
// (shown to the user as a diff), and the plain rules still sort out tickets, notes and new discussions.
async function offlineAsk(s: State, words: string, context: unknown) {
  const r = localAsk(s, words, context)
  if (assistantStatus.state !== 'ready') return r
  try {
    const ctx = (context ?? {}) as { kind?: string; doc?: string; body?: string }
    const e = await llm.edit(words, ctx)
    if (!e) return r
    return { ...r, sections: e.sections, body: e.body ?? r.body, reply: e.reply + (r.newTickets.length ? ` Also found ${r.newTickets.length} ticket${r.newTickets.length > 1 ? 's' : ''}.` : '') }
  } catch (err) {
    log('assistant', 'local model failed, using rules:', err)
    return r
  }
}
// The page sends the user's words and the open item (an unsaved draft may differ from the store).
  // Main adds the titles and tags itself and returns checked edits; the page applies them.
  ipcMain.handle('ai:status', async () => ({ claude: await ai.findClaude(store.get().settings.claudePath), modelBytes: await models.size() }))
  // Claude Code when connected; the offline rules otherwise, or when Claude fails, so a request always gets an answer.
  ipcMain.handle('ai:ask', async (_e, instruction: unknown, context: unknown) => {
    if (typeof instruction !== 'string' || !instruction.trim()) throw new Error('Say or type what you want.')
    const s = store.get()
    const words = instruction.slice(0, 20_000)
    if (!s.settings.ai) return offlineAsk(s, words, context)
    try {
      return await ai.ask(s, words, context)
    } catch (e) {
      if ((e as Error).message === 'Cancelled.') throw e
      log('ai', 'claude failed, using offline mode:', e)
      const r = await offlineAsk(s, words, context)
      return { ...r, reply: `Claude Code didn't answer (${(e as Error).message.slice(0, 120)}). ${r.reply}` }
    }
  })
  // Action items → tickets. The page reconciles the result against the discussion's tickets before creating any.
  ipcMain.handle('ai:tasks', async (_e, text: unknown, context: { title?: unknown; existing?: unknown; whole?: unknown }) => {
    if (typeof text !== 'string' || !text.trim()) return { tasks: [], via: 'offline' }
    const s = store.get()
    const existing = Array.isArray(context?.existing) ? context.existing.filter((x): x is string => typeof x === 'string').slice(0, 200) : []
    const ctx = { title: typeof context?.title === 'string' ? context.title : '', existing }
    if (s.settings.ai)
      try {
        return { tasks: await ai.tasks(s, text, ctx), via: 'claude' }
      } catch (e) {
        if ((e as Error).message === 'Cancelled.') throw e
        log('ai', 'claude tasks failed, using offline rules:', e)
      }
    return { tasks: localTasks(s, text.slice(0, 60_000), context?.whole === true), via: 'offline' }
  })
  ipcMain.handle('image:save', async (_e, data: unknown, mime: unknown) => {
    const ext = IMAGE_TYPES[String(mime)]
    if (!ext || !(data instanceof Uint8Array) || data.byteLength > 15_000_000) throw new Error('Only PNG, JPEG, GIF or WebP images up to 15 MB.')
    const name = `${createHash('sha256').update(data).digest('hex')}.${ext}`
    await mkdir(imageDir(), { recursive: true })
    await writeFile(join(imageDir(), name), data)
    return `pengu-img://${name}`
  })
  ipcMain.handle('ai:connect', async () => {
    const r = await ai.connect(store.get().settings.claudePath)
    if (r.ok) store.update((s) => void (s.settings.ai = true))
    return r
  })
  ipcMain.handle('ai:disconnect', () => store.update((s) => void (s.settings.ai = false)))
  ipcMain.handle('voice:retry', () => ((voiceKey = ''), syncVoice(store.get().settings), syncAssistant()))
  ipcMain.handle('logs:open', () => shell.openPath(logDir()))
  // The page's own diary lines (voice states, errors). Length-capped, and the page never sends what was said.
  ipcMain.handle('log:write', (_e, scope: unknown, msg: unknown) => log(`ui:${String(scope).slice(0, 20)}`, String(msg).slice(0, 500)))
  ipcMain.handle('ai:cancel', () => (ai.cancel(), llm.cancel()))
  // Team sync (server/): sign in with name and password, the token stays encrypted in this computer's keychain.
  ipcMain.handle('sync:signIn', (_e, url: unknown, user: unknown, password: unknown) => sync.signIn(url, user, password))
  ipcMain.handle('sync:signOut', () => sync.signOut())
  ipcMain.handle('sync:now', () => sync.syncNow())
  // Gmail plugin: emails labelled "Pengu" become tickets. Google sign-in happens in the browser; see plugins/gmail.ts.
  ipcMain.handle('gmail:connect', (_e, clientId: unknown, clientSecret: unknown) => gmail.connect(clientId, clientSecret))
  ipcMain.handle('gmail:disconnect', () => gmail.disconnect())
  ipcMain.handle('gmail:now', () => gmail.pollNow())
  ipcMain.handle('collab:exchange', (_e, docId: unknown, since: unknown, updates: unknown, seed: unknown) => sync.docExchange(docId, since, updates, seed))
  // "Set up in Google Calendar": opens Calendar's create-event page, already filled in, in Chrome when it's installed
  // (Windows, macOS and Linux), else in the default browser. Only that one Google page can be opened this way.
  ipcMain.handle('meet:open', (_e, url: unknown) => {
    const u = typeof url === 'string' ? safeCalendarUrl(url) : null
    if (!u) throw new Error('That is not a Google Calendar link.')
    return openInChrome(u)
  })
  // Speech-to-text runs here (native ONNX Runtime). The page sends 16 kHz mono samples; nothing is stored.
  ipcMain.handle('voice:warm', () => void voice.warm(voiceModel()))
  ipcMain.handle('voice:transcribe', async (_e, audio: unknown) => {
    if (!(audio instanceof Float32Array) || audio.length === 0 || audio.length > 16_000 * 6 * 60) throw new Error('No audio to transcribe.')
    const s = store.get().settings
    if (!s.voice) throw new Error('Voice is off. Turn it on in Settings → Voice.')
    return voice.transcribe(voiceModel(), audio, s.voiceLanguage)
  })
  ipcMain.handle('model:clear', () => models.clear())
  // macOS asks the user once per app; Windows uses the "Let desktop apps access your microphone" switch.
  ipcMain.handle('mic:ask', async () => (isMac ? systemPreferences.askForMediaAccess('microphone') : systemPreferences.getMediaAccessStatus('microphone') !== 'denied'))

  // Export through a native Save dialog. The page never gets file-system access, only this one call.
  // `.excalidraw` is the same JSON under Excalidraw's own extension, so the file opens straight in excalidraw.com.
  ipcMain.handle('export:json', async (e, name: unknown, data: unknown, ext: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const safe = String(name).replace(/[^\w-]+/g, '-').slice(0, 80) || 'pengu-export'
    const x = ext === 'excalidraw' ? 'excalidraw' : 'json'
    const opts = { defaultPath: `${safe}.${x}`, filters: [{ name: x === 'json' ? 'JSON' : 'Excalidraw', extensions: [x] }] }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (!res.canceled && res.filePath) await writeFile(res.filePath, JSON.stringify(data, null, 2))
  })
}

// ---------- Startup ----------

// Before any window opens: set the toast identity, load data, wire IPC and listeners, then show the window
// unless the OS launched us at login (then we start quietly in the tray).
// Page errors and crashes go to the log file too, so "it didn't work" can be traced afterwards.
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (ev) => {
    const e = ev as unknown as { level?: string | number; message?: string }
    if (e.level === 'error' || e.level === 'warning' || e.level === 3 || e.level === 2) log('console', String(e.message ?? '').slice(0, 500))
  })
  wc.on('render-process-gone', (_ev, d) => log('crash', `renderer gone: ${d.reason} (${d.exitCode})`))
})
process.on('uncaughtException', (e) => log('main', 'uncaught:', e.stack ?? e))

app.whenReady().then(() => {
  log('main', `start v${app.getVersion()} ${process.platform} ${process.arch}${app.isPackaged ? '' : ' (dev)'}`)
  protocol.handle('pengu-img', (req) => {
    const name = new URL(req.url).hostname
    return IMAGE_NAME.test(name) ? net.fetch(pathToFileURL(join(imageDir(), name)).toString()) : new Response('Not found', { status: 404 })
  })
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath)
  // Electron grants every permission by default. Pengu's pages only ever need the microphone (voice), so allow that alone.
  const micOnly = (perm: string, details?: { mediaTypes?: string[]; mediaType?: string }) =>
    perm === 'media' && (details?.mediaTypes ?? [details?.mediaType]).every((t) => t === 'audio') && store.get().settings.voice
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => cb(micOnly(perm, details as { mediaTypes?: string[] })))
  session.defaultSession.setPermissionCheckHandler((_wc, perm, _origin, details) => micOnly(perm, details as { mediaType?: string }))
  const s = store.load()
  registerIpc()
  store.onChange((st) => (applySettings(st.settings), broadcast(st)))
  applySettings(s.settings)
  syncAssistant()
  sync.start(() => broadcast())
  gmail.start(() => broadcast())

  // Both light/dark and accent changes come from the OS, and each OS reports accent changes its own way.
  nativeTheme.on('updated', () => (applyTheme(), broadcast()))
  if (isMac) systemPreferences.subscribeNotification('AppleColorPreferencesChangedNotification', () => broadcast())
  else systemPreferences.on('accent-color-changed', () => broadcast())

  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin
  const link = process.argv.find((a) => a.startsWith('pengu://'))
  if (link) openLink(link)
  if (pendingRoute) showMain(pendingRoute)
  else if (!hidden) showMain()

  // Alt+Shift+P opens the penguin's panel from anywhere. Registration fails quietly if another app owns the keys.
  globalShortcut.register('Alt+Shift+P', toggleWidget)

  tick()
  setInterval(tick, 30_000)
  powerMonitor.on('resume', tick) // catch up on anything that came due while the laptop slept
  powerMonitor.on('unlock-screen', tick)

  watchUpdates()
})

// Mac: clicking the Dock icon reopens the window. Both: the app keeps running in the tray when windows close.
app.on('activate', () => showMain())
app.on('window-all-closed', () => {})
app.on('will-quit', () => (globalShortcut.unregisterAll(), ai.cancel()))
app.on('before-quit', () => {
  setQuitting()
  store.flush()
})
