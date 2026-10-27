import { BrowserWindow, nativeTheme, screen, shell, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { Settings } from '../shared/model'
import * as store from './store'

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

let main: BrowserWindow | null = null
let widget: BrowserWindow | null = null
let anchor = { x: 0, y: 0 } // where the collapsed penguin sits; the panel may shift up from here near the screen bottom
let dragStart = anchor
export let quitting = false
export const setQuitting = () => (quitting = true)

// Same locked-down settings for every window: no Node in the page, sandboxed, and a single preload bridge.
const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false
}

// Load the renderer at a hash route: the Vite dev server in dev, the built file in production.
// Hash routing works under file:// as well; history routing would break when the page reloads.
function load(win: BrowserWindow, route: string) {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) win.loadURL(`${dev}#${route}`)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
}

// Pages never navigate away or open popups. Http(s) links go to the real browser; everything else is dropped.
function lockDown(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
}

// Caption-button colors on Windows have to match the page, or they stay light on a dark bar.
const titleBar = () => ({
  color: nativeTheme.shouldUseDarkColors ? '#1D2125' : '#FFFFFF',
  symbolColor: nativeTheme.shouldUseDarkColors ? '#DCDFE4' : '#44546F',
  height: 48
})

// Show the main window at a route, creating it if needed.
// It starts hidden with a theme-matched background and only shows on ready-to-show, so there is no white flash.
export function showMain(route?: string) {
  if (main && !main.isDestroyed()) {
    if (route) main.webContents.send('navigate', route)
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    return
  }
  main = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Pengu',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1D2125' : '#F7F8F9',
    // Custom top bar on both OSes: traffic lights inset on Mac, caption-button overlay on Windows.
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 16 } } : { titleBarOverlay: titleBar() }),
    webPreferences
  })
  lockDown(main)
  main.once('ready-to-show', () => main?.show())
  // Closing only hides the window, so the tray keeps running and reminders still fire. Quit is in the tray menu.
  main.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      main?.hide()
    }
  })
  load(main, route ?? '/discussions')
}

// Re-color the window chrome when the OS or the user switches light/dark.
export function applyTheme() {
  if (!main || main.isDestroyed()) return
  main.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1D2125' : '#F7F8F9')
  if (isWin) main.setTitleBarOverlay(titleBar())
}

// Saved position if it is still on a connected screen, else the top-right of the primary display.
// The check matters when a laptop leaves its external monitor: the widget must not reopen off-screen.
function widgetPos(s: Settings) {
  const p = s.widgetPos
  if (p && typeof p.x === 'number' && screen.getAllDisplays().some(({ workArea: a }) => p.x >= a.x && p.y >= a.y && p.x < a.x + a.width && p.y < a.y + a.height)) return p
  const { x, y, width } = screen.getPrimaryDisplay().workArea
  return { x: x + width - 300, y: y + 16 }
}

// The desktop penguin: a fully transparent, frameless window. The page draws the character, pill and panel
// with CSS, so they look identical on Mac and Windows (no vibrancy/acrylic differences) and the shape isn't a box.
// It starts small; the page measures itself and asks for its exact size (fitWidget).
function createWidget(s: Settings) {
  anchor = widgetPos(s)
  const win = new BrowserWindow({
    ...anchor,
    width: 280,
    height: 90,
    transparent: true,
    hasShadow: false, // the OS shadow would outline the invisible rectangle; CSS draws the real shadows
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: s.widgetsOnTop,
    backgroundColor: '#00000000',
    webPreferences
  })
  lockDown(win)
  if (isMac) win.setVisibleOnAllWorkspaces(true) // stay on every Space, like a real desktop widget
  win.once('ready-to-show', () => win.showInactive()) // appear without stealing focus from the app the user is in
  win.on('closed', () => (widget = null))
  load(win, '/widget')
  widget = win
}

// Show or hide the penguin from settings, and apply on-top. Safe to call after every settings change.
export function syncWidgets(s: Settings) {
  if (s.widget && !widget) createWidget(s)
  else if (!s.widget && widget) widget.destroy()
  else widget?.setAlwaysOnTop(s.widgetsOnTop)
}

// Size the window to the page (collapsed pill or open panel). It grows down from the anchor,
// and shifts up only if it would run off the bottom of the screen, so the panel is never cut off.
export function fitWidget(width: number, height: number) {
  if (!widget || !Number.isFinite(width) || !Number.isFinite(height)) return
  const w = Math.round(Math.min(Math.max(width, 120), 420))
  const h = Math.round(Math.min(Math.max(height, 60), 560))
  const area = screen.getDisplayNearestPoint(anchor).workArea
  const y = Math.min(anchor.y, area.y + area.height - h)
  widget.setBounds({ x: anchor.x, y, width: w, height: h })
}

// Custom drag, so the same penguin can be clicked (open panel) and dragged (move).
// A CSS drag region can't do both, because Electron swallows clicks inside it.
// The page sends the pointer's total screen offset since pointerdown; main moves from where the drag started.
export function dragWidget(phase: 'start' | 'move' | 'end', dx = 0, dy = 0) {
  if (!widget) return
  if (phase === 'start') dragStart = anchor
  if (phase === 'move' && Number.isFinite(dx) && Number.isFinite(dy)) {
    anchor = { x: Math.round(dragStart.x + dx), y: Math.round(dragStart.y + dy) }
    widget.setPosition(anchor.x, anchor.y)
  }
  if (phase === 'end') store.update((st) => void (st.settings.widgetPos = anchor))
}

// Open or close the penguin's panel from the global shortcut, focusing it so typing works right away.
export function toggleWidget() {
  if (!widget) return
  widget.focus()
  widget.webContents.send('widget:toggle')
}

// Every open window (main and widget), used to push state changes to all of them.
export const allWindows = () => [main, widget].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
