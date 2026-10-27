import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DISCUSSION_TYPES, STEPS, nameOf, teamIds, type State } from '../shared/model'
import { CONCLUSION, type Section } from '../shared/doc'
import { allTags, itemsOf } from '../shared/links'
import { log } from './log'

// Claude Code is a power-up: when it's connected, it does the thinking; everything also works without it
// (see local.ts). It runs the Claude Code already installed and signed in on this machine (`claude -p`), so Pengu
// holds no API key. Input goes through stdin, never argv, because Windows caps command lines and a discussion can
// be long. Claude gets no tools and no settings, so it can only answer, never act on the machine.

const isWin = process.platform === 'win32'
const MODEL = 'sonnet' // fast enough for a voice round trip, strong enough to merge notes into the right section
const TIMEOUT = 120_000
let cached: string | null | undefined
let job: ChildProcess | null = null

const run = (file: string, args: string[]) =>
  new Promise<string>((res) => execFile(file, args, { timeout: 15_000, windowsHide: true }, (err, out) => res(err ? '' : out)))

// Find `claude` once. GUI apps on Mac start with a bare PATH, so ask the login shell; on Windows prefer the
// real .exe over an npm .cmd shim, which can't be spawned without a shell. A manual path in Settings wins.
export async function findClaude(override: string): Promise<string | null> {
  if (override) return existsSync(override) ? override : null
  if (cached !== undefined) return cached
  const known = [join(homedir(), '.local', 'bin', isWin ? 'claude.exe' : 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  const lines = isWin
    ? (await run('where', ['claude'])).split(/\r?\n/)
    : (await run(process.env.SHELL || '/bin/zsh', ['-ilc', 'command -v claude'])).split('\n')
  const found = [...lines.map((l) => l.trim()), ...known].filter((p) => p && existsSync(p))
  cached = found.find((p) => !/\.(cmd|bat)$/i.test(p)) ?? found[0] ?? null
  return cached
}

// ---------- what the assistant returns (Claude or the offline rules) ----------

export type User = string
export interface TaskOut { title: string; assignee: User; deadline: string | null; notes: string; discussion?: string }
export interface AiResult {
  reply: string
  sections: Section[] // edits to the open discussion document, by heading
  body?: string // new text of the open note or ticket notes
  newTickets: TaskOut[]
  newNotes: { title: string; body: string }[]
  newDiscussions: { title: string; type: (typeof DISCUSSION_TYPES)[number]; meetAt: string | null; sections: Section[] }[]
}

const sectionSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: { heading: { type: 'string' }, markdown: { type: 'string', description: 'Full new markdown of this section (without the heading line).' } },
    required: ['heading', 'markdown']
  }
}
const taskSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short imperative title, e.g. "Write the invite email".' },
    assignee: { type: 'string', get enum() { return teamIds() } }, // read when the schema is sent, so it lists today's team
    deadline: { type: 'string', description: 'YYYY-MM-DD or empty' },
    notes: { type: 'string', description: 'One or two lines of detail, may use [[links]] and #tags.' },
    discussion: { type: 'string', description: 'Title of the discussion this ticket belongs to: one created in this same answer, or an existing one. Empty if none.' }
  },
  required: ['title', 'assignee']
}
const ASK_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'One or two sentences telling the user what you did.' },
    sections: { ...sectionSchema, description: 'Sections of the OPEN discussion you changed or added.' },
    body: { type: 'string', description: 'Full new text of the open note or ticket notes, if changed.' },
    newTickets: { type: 'array', items: taskSchema },
    newNotes: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] } },
    newDiscussions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, type: { type: 'string', enum: DISCUSSION_TYPES }, meetAt: { type: 'string', description: 'ISO 8601 with offset, or empty' }, sections: sectionSchema },
        required: ['title', 'type']
      }
    }
  },
  required: ['reply']
}
const TASKS_SCHEMA = { type: 'object', properties: { tasks: { type: 'array', items: taskSchema } }, required: ['tasks'] }

const TOPICS = [...STEPS.map((s) => `"${s.label}" (${s.hint})`), `"${CONCLUSION}"`].join('; ')
const SYSTEM = `You are Pengu, the assistant inside a small team's workspace of discussions, tickets and notes.
You turn what the user says (often a rough voice transcript; fix obvious speech-to-text errors and filler words) into edits.
First decide what the input is:
- One concrete action ("add a ticket…", "Ana should fix X by Friday") → a ticket.
- A conversation, meeting recap, idea or several related points → a discussion with its sections filled in, plus a ticket for every action item, each with "discussion" set to that discussion's title.
- Reference information to keep → a note.
- If an item is open and the input is about it, edit that item (and add tickets for its action items; they link to it automatically). If the input is clearly about something else, create new items instead.
A discussion is one document with "## " section headings. New discussions start with: ${TOPICS}. The open document may have renamed, removed or added sections: use its headings as they are, and add a new heading only when nothing fits.
Rules:
- When changing a section, body or note, return its FULL new markdown: keep what is there, merge new points in, tidy wording. Never drop content (including ![image](…) lines) unless asked.
- Use "- " bullets. Link existing items with [[Exact Title]] from the titles list whenever the text mentions them. Add a few #tags (lowercase, hyphenated) for themes; reuse existing tags.
- Tickets: short imperative titles; use the owner and date the user gives; resolve "tomorrow", "Friday" etc. from today's date; don't repeat tickets that already exist.
- Do not invent numbers, people or facts. Only return fields you change. Keep "reply" short.`
const TASKS_SYSTEM = `You extract action items from a team's discussion text and turn each into a ticket.
- One ticket per distinct action. Merge duplicates. Skip things that are already done, pure facts, opinions or headings.
- Short imperative titles. Owner: a person named for it, else the current user. Deadline from the text, resolved from today's date, else empty.
- Skip any action that matches an existing ticket listed in the input.
- Do not invent work that isn't in the text.`

const clean = (v: unknown, max = 20_000) => (typeof v === 'string' ? v.slice(0, max) : '')
const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const arr = (v: unknown, max = 20) => (Array.isArray(v) ? v.slice(0, max) : []) as Record<string, unknown>[]
const sections = (v: unknown): Section[] =>
  arr(v, 12).filter((x) => clean(x.heading).trim()).map((x) => ({ heading: clean(x.heading, 120).trim(), markdown: clean(x.markdown) }))
export const cleanTasks = (v: unknown): TaskOut[] =>
  arr(v, 30)
    .filter((t) => clean(t.title).trim())
    .map((t) => ({
      title: clean(t.title, 200).trim(),
      assignee: teamIds().includes(t.assignee as string) ? (t.assignee as User) : teamIds()[0],
      deadline: isDate(t.deadline) ? (t.deadline as string) : null,
      notes: clean(t.notes),
      discussion: clean(t.discussion, 200) || undefined
    }))

// Claude's output is untrusted input: keep only known fields, known enums and sane lengths.
function sanitize(raw: Record<string, unknown>): AiResult {
  return {
    reply: clean(raw.reply, 600) || 'Done.',
    sections: sections(raw.sections),
    body: typeof raw.body === 'string' ? clean(raw.body) : undefined,
    newTickets: cleanTasks(raw.newTickets),
    newNotes: arr(raw.newNotes, 10).filter((n) => clean(n.title).trim()).map((n) => ({ title: clean(n.title, 200), body: clean(n.body) })),
    newDiscussions: arr(raw.newDiscussions, 5)
      .filter((d) => clean(d.title).trim())
      .map((d) => ({
        title: clean(d.title, 200),
        type: DISCUSSION_TYPES.includes(d.type as never) ? (d.type as AiResult['newDiscussions'][number]['type']) : 'product',
        meetAt: typeof d.meetAt === 'string' && d.meetAt && !Number.isNaN(Date.parse(d.meetAt)) ? new Date(d.meetAt).toISOString() : null,
        sections: sections(d.sections)
      }))
  }
}

// Pull the first {...} block out of plain text, for the .cmd fallback where --json-schema can't be passed safely.
function parseLoose(text: string) {
  const m = text.match(/\{[\s\S]*\}/)
  return m ? (JSON.parse(m[0]) as Record<string, unknown>) : { reply: text }
}

// What every request says about "now", the people and the workspace.
function header(s: State) {
  const items = itemsOf(s)
  const now = new Date()
  const off = -now.getTimezoneOffset()
  const tz = `${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`
  return [
    `Today: ${now.toLocaleDateString('en-CA')} ${now.toTimeString().slice(0, 5)} (UTC${tz}, ${now.toLocaleDateString('en-US', { weekday: 'long' })}).`,
    `People: ${teamIds().map((u) => `${u} (${nameOf(u)})`).join(', ')}. The user speaking is ${s.settings.me}.`,
    `Existing titles: ${JSON.stringify(items.map((i) => i.title).slice(0, 300))}`,
    `Existing tags: ${JSON.stringify(allTags(items).slice(0, 200))}`
  ].join('\n\n')
}

// One `claude -p` call with a system prompt and a JSON schema; resolves to the structured output.
// One request at a time: a new one cancels the old, so a second voice command never races the first.
async function claude(s: State, system: string, schema: object, input: string, label: string): Promise<Record<string, unknown>> {
  const bin = await findClaude(s.settings.claudePath)
  if (!bin) throw new Error('Claude Code was not found on this computer.')
  cancel()
  const shim = /\.(cmd|bat)$/i.test(bin)
  const args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--model', MODEL]
  if (!shim) args.push('--system-prompt', system, '--json-schema', JSON.stringify(schema))
  const prompt = shim ? `${system}\n\nReply with only a JSON object matching this schema:\n${JSON.stringify(schema)}\n\n${input}` : input
  // An empty working folder, so Claude Code doesn't pick up a CLAUDE.md or project from wherever Pengu started.
  const cwd = join(app.getPath('userData'), 'ai')
  mkdirSync(cwd, { recursive: true })

  return new Promise((resolve, reject) => {
    // Through cmd.exe an empty argument vanishes and shifts the rest, so it has to be spelled "".
    const child = spawn(shim ? `"${bin}"` : bin, shim ? args.map((a) => (a === '' ? '""' : a)) : args, { cwd, windowsHide: true, shell: shim })
    job = child
    let out = ''
    let err = ''
    const t0 = Date.now()
    log('ai', `${label}: ${input.length} chars in`)
    const timer = setTimeout(() => child.kill(), TIMEOUT)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => (clearTimeout(timer), reject(new Error(`Could not start Claude Code: ${e.message}`))))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (job === child) job = null
      log('ai', `${label}: claude exited code=${code} signal=${signal} after ${Date.now() - t0}ms${err ? ` stderr: ${err.slice(0, 300)}` : ''}`)
      if (signal) return reject(new Error('Cancelled.'))
      try {
        const j = JSON.parse(out) as { is_error?: boolean; result?: string; structured_output?: Record<string, unknown> }
        if (j.is_error) return reject(new Error(j.result || 'Claude Code returned an error. Run `claude` once in a terminal to sign in.'))
        resolve(j.structured_output ?? parseLoose(j.result ?? ''))
      } catch {
        reject(new Error((err || out).trim().slice(0, 300) || `Claude Code exited with code ${code}.`))
      }
    })
    child.stdin.end(prompt)
  })
}

export async function ask(s: State, instruction: string, context: unknown): Promise<AiResult> {
  const input = `${header(s)}\n\nOpen item (edit this one; null means nothing is open, so create new items): ${JSON.stringify(context ?? null).slice(0, 80_000)}\n\nUser input:\n${instruction}`
  return sanitize(await claude(s, SYSTEM, ASK_SCHEMA, input, 'ask'))
}

// Action items from a selection (or the whole document) → tickets, skipping ones that already exist.
export async function tasks(s: State, text: string, context: { title?: string; existing?: string[] }): Promise<TaskOut[]> {
  const input = `${header(s)}\n\nDiscussion: ${JSON.stringify(context.title ?? '')}\nExisting tickets: ${JSON.stringify(context.existing ?? [])}\n\nText:\n${text.slice(0, 60_000)}`
  return cleanTasks((await claude(s, TASKS_SYSTEM, TASKS_SCHEMA, input, 'tasks')).tasks)
}

// The Connect button: find Claude Code and make one tiny call, so "connected" means it's installed and signed in.
export async function connect(override: string): Promise<{ ok: boolean; path: string | null; error?: string }> {
  cached = undefined // look again; the user may have just installed it
  const bin = await findClaude(override)
  if (!bin) return { ok: false, path: null, error: 'Claude Code is not installed. Install it from claude.com/claude-code, run `claude` once to sign in, then press Connect.' }
  const shim = /\.(cmd|bat)$/i.test(bin)
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--model', 'haiku']
    const child = spawn(shim ? `"${bin}"` : bin, shim ? args.map((a) => (a === '' ? '""' : a)) : args, { windowsHide: true, shell: shim, cwd: app.getPath('userData') })
    let out = ''
    const timer = setTimeout(() => child.kill(), 60_000)
    child.stdout.on('data', (d) => (out += d))
    child.on('error', (e) => (clearTimeout(timer), resolve({ ok: false, path: bin, error: e.message })))
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out) as { is_error?: boolean; result?: string }
        log('ai', `connect test: ${j.is_error ? 'error' : 'ok'}`)
        resolve(j.is_error ? { ok: false, path: bin, error: j.result || 'Claude Code answered with an error. Run `claude` in a terminal to sign in.' } : { ok: true, path: bin })
      } catch {
        resolve({ ok: false, path: bin, error: 'Claude Code did not answer. Run `claude` in a terminal once to sign in, then press Connect.' })
      }
    })
    child.stdin.end('Reply with the single word OK.')
  })
}

export function cancel() {
  job?.kill()
  job = null
}
