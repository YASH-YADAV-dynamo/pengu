import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Kind, Settings, Snapshot } from '../shared/model'
import type { AiResult, TaskOut } from '../main/ai'

// The only door between the page and the OS. Each method maps to one checked IPC handler in main,
// and raw ipcRenderer is never exposed, so a bug in the page can't call arbitrary channels.

// Subscribe to a main → page event and return an unsubscribe, which fits React's useEffect cleanup.
function on<T>(channel: string, fn: (v: T) => void) {
  const handler = (_e: IpcRendererEvent, v: T) => fn(v)
  ipcRenderer.on(channel, handler)
  return () => void ipcRenderer.off(channel, handler)
}

const api = {
  platform: process.platform,
  getState: (): Promise<Snapshot> => ipcRenderer.invoke('state:get'),
  onState: (fn: (s: Snapshot) => void) => on('state', fn),
  onNavigate: (fn: (route: string) => void) => on('navigate', fn),
  upsert: <T extends { id: string }>(kind: Kind, item: T) => ipcRenderer.invoke('item:upsert', kind, item),
  remove: (kind: Kind, id: string) => ipcRenderer.invoke('item:remove', kind, id),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
  setTeamName: (name: string): Promise<void> => ipcRenderer.invoke('team:rename', name),
  open: (route: string, seed?: string) => ipcRenderer.invoke('app:open', route, seed),
  takeSeed: (): Promise<string> => ipcRenderer.invoke('seed:take'),
  fitWidget: (width: number, height: number) => ipcRenderer.invoke('widget:fit', width, height),
  dragWidget: (phase: 'start' | 'move' | 'end', dx = 0, dy = 0) => ipcRenderer.invoke('widget:drag', phase, dx, dy),
  onWidgetToggle: (fn: () => void) => on('widget:toggle', fn),
  exportJson: (name: string, data: unknown, ext: 'json' | 'excalidraw' = 'json') => ipcRenderer.invoke('export:json', name, data, ext),
  // Assistant (Claude Code) and voice (Whisper, on this machine)
  aiStatus: (): Promise<{ claude: string | null; modelBytes: number }> => ipcRenderer.invoke('ai:status'),
  aiAsk: (instruction: string, context: unknown): Promise<AiResult> => ipcRenderer.invoke('ai:ask', instruction, context),
  aiCancel: () => ipcRenderer.invoke('ai:cancel'),
  syncSignIn: (url: string, user: string, password: string): Promise<void> => ipcRenderer.invoke('sync:signIn', url, user, password),
  syncSignOut: () => ipcRenderer.invoke('sync:signOut'),
  collabExchange: (docId: string, since: number, updates: string[], seed?: string): Promise<{ updates: { id: number; update: string }[]; last: number; more: boolean }> =>
    ipcRenderer.invoke('collab:exchange', docId, since, updates, seed),
  syncNow: (): Promise<void> => ipcRenderer.invoke('sync:now'),
  gmailConnect: (clientId: string, clientSecret: string): Promise<void> => ipcRenderer.invoke('gmail:connect', clientId, clientSecret),
  gmailDisconnect: (): Promise<void> => ipcRenderer.invoke('gmail:disconnect'),
  gmailNow: (): Promise<void> => ipcRenderer.invoke('gmail:now'),
  openMeet: (url: string): Promise<'chrome' | 'browser'> => ipcRenderer.invoke('meet:open', url),
  voiceWarm: () => ipcRenderer.invoke('voice:warm'),
  voiceTranscribe: (audio: Float32Array): Promise<string> => ipcRenderer.invoke('voice:transcribe', audio),
  modelClear: () => ipcRenderer.invoke('model:clear'),
  micAsk: (): Promise<boolean> => ipcRenderer.invoke('mic:ask'),
  aiConnect: (): Promise<{ ok: boolean; path: string | null; error?: string }> => ipcRenderer.invoke('ai:connect'),
  aiDisconnect: () => ipcRenderer.invoke('ai:disconnect'),
  voiceRetry: () => ipcRenderer.invoke('voice:retry'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  log: (scope: string, msg: string) => void ipcRenderer.invoke('log:write', scope, msg),
  aiTasks: (text: string, context: { title: string; existing: string[]; whole: boolean }): Promise<{ tasks: TaskOut[]; via: 'claude' | 'offline' }> =>
    ipcRenderer.invoke('ai:tasks', text, context),
  saveImage: (data: Uint8Array, mime: string): Promise<string> => ipcRenderer.invoke('image:save', data, mime)
}

export type PenguApi = typeof api
contextBridge.exposeInMainWorld('pengu', api)
