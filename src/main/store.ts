import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { docFromSteps } from '../shared/doc'
import { DEFAULT_STATE, setTeam, type State } from '../shared/model'

// Local store: a single JSON file in userData, owned by the main process.
// Main owns it (not IndexedDB in the renderer) so the window, the widgets and the reminder tick
// all read one copy, even when the main window is closed. Neon sync plugs in here later.

let state: State = structuredClone(DEFAULT_STATE)
let saveTimer: NodeJS.Timeout | undefined
const listeners = new Set<(s: State) => void>()
const file = () => join(app.getPath('userData'), 'pengu.json')

// Read the file once at startup and merge over defaults, so fields added in a later version get a value.
// A missing or corrupt file falls back to defaults; the app should open even if the file is damaged.
export function load(): State {
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8')) as Partial<State>
    state = { ...structuredClone(DEFAULT_STATE), ...saved, settings: { ...DEFAULT_STATE.settings, ...saved.settings } }
    // Files from before the team came from the server: keep whoever "me" was as the one member.
    if (!Array.isArray(saved.team) || !saved.team.length) state.team = [{ id: state.settings.me, name: state.settings.me, role: 'admin' }]
    // Fields that no longer exist.
    delete (state as unknown as Record<string, unknown>).readings
    delete (state.settings as unknown as Record<string, unknown>).organization
    // Discussions saved with five separate step fields become one document with the same headings.
    for (const d of state.discussions) if (typeof d.doc !== 'string') d.doc = docFromSteps(d.steps, d.conclusion)
  } catch {
    state = structuredClone(DEFAULT_STATE)
  }
  setTeam(state.team)
  return state
}

export const get = () => state

// The only write path: mutate a draft, then save and notify every window.
// Funnelling all changes through here means widgets and the window can never show different data.
export function update(mutate: (s: State) => void): State {
  mutate(state)
  setTeam(state.team)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, 300) // batch rapid edits (typing, window drags) into one disk write
  listeners.forEach((fn) => fn(state))
  return state
}

export function onChange(fn: (s: State) => void) {
  listeners.add(fn)
}

// Write to a temp file and rename it over the real one. Rename is atomic on both NTFS and APFS,
// so quitting or crashing mid-write leaves the old file intact instead of a half-written one.
export function flush() {
  clearTimeout(saveTimer)
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, file())
}
