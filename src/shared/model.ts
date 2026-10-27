// Shared data model for main, preload and renderer.
// One file of plain types keeps the local JSON, the IPC payloads and (later) the Neon rows in the same shape.

// A person is a short id ("ana", "sam-2"). Who exists, and what each may do, is set on the server with the Pengu CLI
// (`npm run pengu -- user add ...`); a signed-in app receives the list. Without a server it is just you.
export type User = string
export type Role = 'admin' | 'member' | 'viewer' // viewers can read but not change anything
export const ROLES: Role[] = ['admin', 'member', 'viewer']
export interface Member { id: User; name: string; role: Role }

export type DiscussionType = 'product' | 'growth' | 'tech'
export const DISCUSSION_TYPES: DiscussionType[] = ['product', 'growth', 'tech']

// The five fixed steps, in order. The hint is the prompt shown above each box.
export const STEPS = [
  { key: 'research', label: 'Research', hint: 'How other apps and platforms use it' },
  { key: 'fit', label: 'Fit', hint: 'How it fits our apps, and where this fell off or helped the last startup' },
  { key: 'decide', label: 'Decide', hint: 'Points to decide, and where it will turn out' },
  { key: 'journeys', label: 'Journeys', hint: 'User journeys and edge cases' },
  { key: 'outcomes', label: 'Outcomes', hint: 'Business outcomes' }
] as const
export type StepKey = (typeof STEPS)[number]['key']

// Every synced row carries who/when and a soft-delete marker, matching the server schema (server/prisma/schema.prisma).
interface Row {
  id: string
  updatedAt: string
  updatedBy: User
  deletedAt: string | null
}

export interface DesignEntry {
  id: string
  mode: 'experiment' | 'document'
  label: string
  numbers: Record<string, string>
  note: string
}

export interface Discussion extends Row {
  type: DiscussionType
  title: string
  meetAt: string | null // ISO timestamp, shown in local time
  tagged: User[]
  doc: string // one document (editor HTML); the five topics start as headings in it (see shared/doc.ts)
  design: DesignEntry[]
  // Before the single document, each topic was its own field. Kept only so old files load; store.load moves them into doc.
  steps?: Record<StepKey, string>
  conclusion?: string
}

export interface Ticket extends Row {
  discussionId: string | null
  title: string
  assignee: User
  deadline: string | null // YYYY-MM-DD; the day count is computed, never stored, so it can't go stale
  status: 'open' | 'done'
  notes?: string // free text with [[links]] and #tags; optional so tickets saved before notes existed still load
}

// An Obsidian-style note: a title and a body. [[Title]] links and #tags in any text field build the mind map.
export interface Note extends Row {
  title: string
  body: string
}

export interface Roadmap extends Row {
  title: string
  discussionIds: string[]
}

export interface Activity {
  id: string
  at: string
  by: User
  text: string
  route: string
}

// Accent presets. 'system' resolves to the OS accent in main.
export const ACCENTS = {
  system: '',
  blue: '#0C66E4',
  teal: '#0D9488',
  amber: '#B45309',
  rose: '#BE123C',
  slate: '#475569'
} as const
export type Accent = keyof typeof ACCENTS

export interface Settings {
  me: User
  appearance: 'system' | 'light' | 'dark'
  accent: Accent
  widget: boolean // the desktop penguin; alerts are OS notifications with sound, never on the widget
  widgetsOnTop: boolean
  openAtLogin: boolean
  widgetPos: { x: number; y: number } | null
  ai: boolean // Claude Code connected (the Connect button); without it the assistant runs in offline mode
  aiAutoApply: boolean // apply the assistant's changes right away (Undo is offered) instead of asking first
  claudePath: string // manual override when `claude` isn't found on PATH; empty means auto-detect
  voice: boolean // on by default: the open-source Whisper model downloads when the app starts
  voiceModel: VoiceModel
  voiceLanguage: VoiceLanguage
}

// Open-source Whisper models that run on this machine; audio never leaves it. Sizes are the quantized download.
export const VOICE_MODELS = {
  'Xenova/whisper-tiny': 'Fast · 40 MB',
  'Xenova/whisper-base': 'Balanced · 80 MB',
  'Xenova/whisper-small': 'Most accurate · 250 MB'
} as const
export type VoiceModel = keyof typeof VOICE_MODELS
// English is the most accurate when that's what you speak; "translate" turns Hindi or Hinglish into English text.
export const VOICE_LANGUAGES = { english: 'English', auto: 'Detect language', translate: 'Any language → English' } as const
export type VoiceLanguage = keyof typeof VOICE_LANGUAGES

// Live state of the voice model download, sent with every snapshot and never stored.
export type VoiceStatus = { state: 'off' | 'downloading' | 'ready' | 'error'; percent: number; model: string; error?: string }

// The open-source models Pengu downloads on first start, before the app opens: a small chat model that rewrites
// sections when you ask, and a tiny embedding model that finds the section a request is about (the "RAG" part).
// Files are exactly what transformers.js requests for that dtype.
export const ASSISTANT_MODELS = {
  llm: {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct', dtype: 'int8', label: 'Writing assistant',
    files: ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_int8.onnx']
  },
  embed: {
    id: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8', label: 'Search',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
  }
} as const
// Live download state of those models, sent with every snapshot and never stored.
export type AssistantStatus = { state: 'checking' | 'downloading' | 'ready' | 'error'; percent: number; error?: string }

// Live state of team sync, sent with every snapshot and never stored.
export type SyncStatus = { state: 'off' | 'idle' | 'syncing' | 'error'; user?: User; at?: string; error?: string }
// Live state of the Gmail plugin (src/main/plugins/gmail.ts), sent with every snapshot and never stored.
export type GmailStatus = { state: 'off' | 'connecting' | 'ok' | 'error'; email?: string; at?: string; error?: string; created?: number }

export interface State {
  discussions: Discussion[]
  tickets: Ticket[]
  roadmaps: Roadmap[]
  notes: Note[]
  activity: Activity[]
  team: Member[] // everyone you can assign work to; from the server when signed in
  settings: Settings
  fired: string[] // notification keys already shown, so a reminder never repeats after sleep or restart
}

// What the renderer receives: the stored state plus the live OS accent, which is never persisted.
export type Snapshot = State & { systemAccent: string; voiceStatus: VoiceStatus; assistantStatus: AssistantStatus; syncStatus: SyncStatus; gmailStatus: GmailStatus }

export type Kind = 'discussions' | 'tickets' | 'roadmaps' | 'notes'
export const KINDS: Kind[] = ['discussions', 'tickets', 'roadmaps', 'notes']

export const DEFAULT_STATE: State = {
  discussions: [],
  tickets: [],
  roadmaps: [],
  notes: [],
  activity: [],
  team: [{ id: 'me', name: 'Me', role: 'admin' }],
  fired: [],
  settings: {
    me: 'me',
    appearance: 'system',
    accent: 'system',
    widget: true,
    widgetsOnTop: false,
    openAtLogin: true,
    widgetPos: null,
    ai: false,
    aiAutoApply: true,
    claudePath: '',
    voice: true,
    voiceModel: 'Xenova/whisper-base',
    voiceLanguage: 'english'
  }
}

// Whole days from today (local) to a YYYY-MM-DD deadline; negative means overdue.
// Parsing as local midnight avoids the UTC off-by-one that `new Date('2026-10-14')` gives east of GMT.
export function daysLeft(deadline: string | null): number | null {
  if (!deadline) return null
  const [y, m, d] = deadline.split('-').map(Number)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86_400_000)
}

// The team as last received. Main and each window hold their own copy, refreshed whenever a snapshot arrives.
let team: Member[] = DEFAULT_STATE.team
export const setTeam = (t: Member[]) => void (team = t)
export const teamIds = (): User[] => team.map((m) => m.id)
export const isUser = (u: unknown): u is User => typeof u === 'string' && team.some((m) => m.id === u)
// Display names. Kept here so widgets, notifications and the window all spell names the same.
export const nameOf = (u: User) => team.find((m) => m.id === u)?.name ?? u
export const live = <T extends Row>(rows: T[]) => rows.filter((r) => !r.deletedAt)
