import { STEPS, nameOf, teamIds, type State, type StepKey, type User } from '../shared/model'
import type { Section } from '../shared/doc'
import { itemsOf, linkMentions, norm } from '../shared/links'
import { findDate, findMeet } from '../shared/dates'
import type { AiResult, TaskOut } from './ai'

// Offline assistant: simple rules, no model, used when Claude Code isn't connected (or fails), so a voice note
// always lands somewhere. It sorts the words into a ticket, a discussion or a note, reads names and dates,
// and links titles it recognises. Claude Code does this far better; this keeps the app useful without it.

const findUser = (text: string, me: User): User => teamIds().find((u) => new RegExp(`\\b${nameOf(u)}\\b`, 'i').test(text)) ?? me

const ACTION = /\b(ticket|task|to-?do|fix|bug|add|create|build|implement|ship|send|write|review|update|follow up|call|email|design|deploy|test|check|remind)\b/i
const TALK = /\b(discuss|discussion|meeting|meet|sync|talk about|brainstorm|idea|ideas|should we|what if|let'?s think|we (?:talked|discussed|decided)|agenda|recap)\b/i
const STEP_HINTS: [StepKey, RegExp][] = [
  ['decide', /\b(decid|decision|agreed|we will|we'll|going with|chose|choose|plan is)\w*/i],
  ['journeys', /\b(user|users|flow|journey|onboard|drop.?off|edge case|screen|step|signup|sign up|login)\w*/i],
  ['outcomes', /\b(revenue|metric|conversion|retention|growth|kpi|goal|outcome|impact|users per|%)\w*/i],
  ['fit', /\b(our app|fits|fit with|last startup|we tried|for us|our users)\w*/i],
  ['research', /\b(competitor|other apps|like|how .* does|research|benchmark|similar)\w*/i]
]
const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)
// "Add a ticket for Ana to fix the email by Friday" → "Fix the email".
function ticketTitle(s: string) {
  const t = s
    .replace(/^(please\s+)?(can you\s+)?(add|create|make|open|log)\s+(a\s+|an\s+)?(new\s+)?(ticket|task|to-?do)\s*(for\s+\w+\s*)?(to\s+|about\s+|:\s*)?/i, '')
    .replace(/^(\w+\s+)?(needs to|has to|should|will|must|is going to|to)\s+/i, '')
    .replace(new RegExp(`^(${teamIds().map(nameOf).join('|')})\\s+(\\w+?)(es|s)?\\b`, 'i'), (_m, _who, verb: string, end?: string) => verb + (end === 'es' && !/(x|sh|ch|ss|z)$/i.test(verb) ? 'e' : ''))
    .replace(/\s*\b(by|before|due|on)\s+(today|tonight|tomorrow|next week|(next\s+)?(sun|mon|tues|wednes|thurs|fri|satur)day|\d{4}-\d{2}-\d{2}|\d{1,2}(st|nd|rd|th)?\s+\w+)\b.*$/i, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+(today|tonight|tomorrow|next week)$/i, '')
    .trim()
  return (t[0]?.toUpperCase() ?? '') + t.slice(1, 120)
}

const STEP_LABEL = Object.fromEntries(STEPS.map((s) => [s.key, s.label])) as Record<StepKey, string>
const sectionFor = (p: string) => STEP_LABEL[STEP_HINTS.find(([, re]) => re.test(p))?.[0] ?? 'research']
const isAction = (p: string) => ACTION.test(p) && (!!findDate(p) || teamIds().some((u) => new RegExp(`\\b${nameOf(u)}\\b`, 'i').test(p)) || /\b(ticket|task|to-?do)\b/i.test(p))

// Group sentences into sections by topic, as bullets appended under each heading.
function toSections(parts: string[], link: (t: string) => string): Section[] {
  const by = new Map<string, string[]>()
  for (const p of parts) by.set(sectionFor(p), [...(by.get(sectionFor(p)) ?? []), `- ${link(p)}`])
  return [...by].map(([heading, lines]) => ({ heading, markdown: lines.join('\n'), append: true }))
}

// Action items from text. A selection is something the user chose, so every line counts; for the whole
// document only lines that look like actions (a verb plus an owner, a date or the word "ticket") do.
export function localTasks(s: State, text: string, whole: boolean): TaskOut[] {
  const seen = new Set<string>()
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/:$/.test(l) && !/^!\[/.test(l))
    .flatMap((l) => (/^([-*•]|\d+[.)]|\[[ x]\])\s/.test(l) ? [l.replace(/^([-*•]|\d+[.)])\s+(\[[ x]\]\s+)?/, '').replace(/^\[[ x]\]\s+/, '')] : sentences(l)))
    // A statement ("Users love streaks", "The market is big") isn't a task even inside a selection.
    .filter((l) => l.split(/\s+/).length >= 2 && (isAction(l) || ACTION.test(l.split(/\s+/)[0]) || (!whole && !/^(the|a|an|users?|we|it|they|this|that|our|there)\b/i.test(l))))
    .map((p) => ({ title: ticketTitle(p) || p.slice(0, 120), assignee: findUser(p, s.settings.me), deadline: findDate(p), notes: '' }))
    .filter((t) => {
      const k = norm(t.title)
      const dup = seen.has(k)
      seen.add(k)
      return !dup
    })
}

export function localAsk(s: State, instruction: string, context: unknown): AiResult {
  const me = s.settings.me
  const titles = itemsOf(s).map((i) => i.title).filter((t) => t.trim().length >= 4)
  const link = (t: string) => titles.reduce((acc, title) => linkMentions(acc, title), t)
  const parts = sentences(instruction)
  const ctx = context as { kind?: string; title?: string; doc?: string; body?: string; notes?: string } | null
  const out: AiResult = { reply: '', sections: [], newTickets: [], newNotes: [], newDiscussions: [] }
  // "Schedule a meeting tomorrow at 4" is handled by the voice dialog's Calendar option, not a ticket.
  const actions = parts.filter((p) => isAction(p) && !/\b(schedule|set up|arrange|book)\s+(a\s+|an\s+)?(meeting|call|sync)\b/i.test(p))
  const ticketsFrom = (xs: string[], discussion?: string): TaskOut[] =>
    xs.map((p) => ({ title: ticketTitle(p) || p.slice(0, 120), assignee: findUser(p, me), deadline: findDate(p), notes: '', discussion }))

  if (ctx?.kind === 'discussions') {
    // The open discussion: points go under the heading they fit, action items become its tickets.
    out.sections = toSections(parts.filter((p) => !actions.includes(p)), link)
    out.newTickets = ticketsFrom(actions)
    const put = out.sections.length ? `Added to ${out.sections.map((x) => x.heading).join(', ')}` : ''
    const made = out.newTickets.length ? `made ${out.newTickets.length} ticket${out.newTickets.length > 1 ? 's' : ''} on this discussion` : ''
    out.reply = `${[put, made].filter(Boolean).join(' and ') || 'Nothing to add'}.`.replace(/^m/, 'M')
  } else if (ctx?.kind === 'notes' || ctx?.kind === 'tickets') {
    const prev = (ctx.kind === 'notes' ? ctx.body : ctx.notes) ?? ''
    out.body = `${prev.trim()}${prev.trim() ? '\n' : ''}${parts.map((p) => `- ${link(p)}`).join('\n')}`
    out.newTickets = ctx.kind === 'notes' ? ticketsFrom(actions) : []
    out.reply = 'Added to the open item.'
  } else if (TALK.test(instruction) || parts.length >= 3) {
    // Several points or meeting words: a discussion, with tickets for the action items hanging off it.
    const lead = ticketTitle(parts[0]).replace(/^(quick\s+)?(recap of|summary of|notes from)\s+(our|the)?\s*/i, '').replace(/^(let'?s\s+)?(discuss|talk about|brainstorm|meeting about|meeting on)\s+/i, '')
    const title = (lead || 'New discussion').slice(0, 80)
    const type = /\b(growth|marketing|referral|acquisition)\b/i.test(instruction) ? 'growth' : /\b(api|backend|bug|deploy|server|database|tech)\b/i.test(instruction) ? 'tech' : 'product'
    const disc = { title: title[0].toUpperCase() + title.slice(1), type: type as 'growth' | 'tech' | 'product', meetAt: findMeet(instruction), sections: toSections(parts.slice(1).filter((p) => !actions.includes(p)), link) }
    out.newDiscussions = [disc]
    out.newTickets = ticketsFrom(actions.filter((a) => a !== parts[0]), disc.title)
    out.reply = `Started a discussion "${disc.title}"${out.newTickets.length ? ` with ${out.newTickets.length} ticket(s)` : ''}.`
  } else if (actions.length) {
    out.newTickets = ticketsFrom(actions)
    out.reply = out.newTickets.map((t) => `Ticket for ${nameOf(t.assignee)}: ${t.title}${t.deadline ? `, due ${t.deadline}` : ''}.`).join(' ')
  } else {
    out.newNotes = [{ title: (parts[0] ?? 'Note').replace(/[.!?]+$/, '').slice(0, 60), body: parts.map((p) => `- ${link(p)}`).join('\n') }]
    out.reply = `Saved a note "${out.newNotes[0].title}".`
  }
  return out
}
