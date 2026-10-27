import { findDate, findMeet } from './dates'

// A quick look at what a voice note asks for, by plain keyword search. The voice dialog shows these as chips so the
// user sees what will happen before confirming, and can edit the words to change it. The assistant still decides
// the details; this only previews and decides whether to offer Google Calendar.
export type IntentKind = 'ticket' | 'meet' | 'discussion' | 'note'
export interface Match { kind: IntentKind; word: string }

const WORDS: Record<IntentKind, RegExp> = {
  ticket: /\b(tickets?|tasks?|to-?dos?|fix|bug|follow[- ]up|remind(?:er)?|assign|deadline|due)\b/gi,
  meet: /\b(meet(?:ing)?|call|sync|catch[- ]up|stand-?up|huddle|google meet|schedule)\b/gi,
  discussion: /\b(discuss(?:ion)?|brainstorm|talk(?:ed)? about|agenda|recap|decid(?:e|ed)|idea)\b/gi,
  note: /\b(notes?|remember|jot|write down|reference)\b/gi
}

export function detect(text: string): Match[] {
  const out: Match[] = []
  for (const kind of Object.keys(WORDS) as IntentKind[]) {
    const seen = new Set<string>()
    for (const m of text.matchAll(WORDS[kind])) {
      const word = m[0].toLowerCase()
      if (!seen.has(word)) (seen.add(word), out.push({ kind, word }))
    }
  }
  return out
}

// The meeting to offer: a time found in the words, else a date at 10:00, else the next full hour (never in the past).
export function meetingFor(text: string, now = new Date()): { title: string; start: Date; minutes: number } {
  const found = findMeet(text, now)
  let start: Date
  if (found) start = new Date(found)
  else {
    const day = findDate(text, now)
    if (day) {
      const [y, mo, d] = day.split('-').map(Number)
      start = new Date(y, mo - 1, d, 10, 0)
    } else (start = new Date(now)).setHours(now.getHours() + 1, 0, 0, 0)
  }
  if (start.getTime() < now.getTime()) start = new Date(now.getTime() + 3_600_000 - (now.getTime() % 3_600_000))
  const sentence = text.split(/(?<=[.!?])\s+|\n+/).find((s) => new RegExp(WORDS.meet.source, 'i').test(s)) ?? text
  const title = sentence
    .replace(/^(please\s+)?(can you\s+)?(schedule|set up|arrange|book|create)\s+(a\s+|an\s+)?/i, '')
    .replace(/^(meeting|call|sync|catch[- ]up)\s*/i, '')
    .replace(/\b(today|tonight|tomorrow|next week|(next\s+)?(sun|mon|tues|wednes|thurs|fri|satur)day|\d{4}-\d{2}-\d{2})\b/gi, '')
    .replace(/\b(at|by|on)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^(to|about|for|on)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim()
    .slice(0, 80)
  return { title: title ? title[0].toUpperCase() + title.slice(1) : 'Meeting', start, minutes: 30 }
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

// Google Calendar's "create event" page, filled in. The user adds a Meet link there (Workspace accounts do by default).
export function calendarUrl(title: string, start: Date, minutes: number, details = '', guests: string[] = []) {
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${stamp(start)}/${stamp(new Date(start.getTime() + minutes * 60_000))}` })
  if (details) q.set('details', details)
  if (guests.length) q.set('add', guests.join(','))
  return `https://calendar.google.com/calendar/render?${q}`
}
