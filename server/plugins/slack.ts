import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PrismaClient } from '../generated/prisma/client.ts'
import { parseRow } from '../lib/kinds.ts'
import { findDate } from '../../src/shared/dates.ts'

// Slack plugin: mention @Pengu in a channel (or DM it) to create, list and close tickets. The tickets are ordinary rows,
// so every signed-in Pengu app receives them on its next sync.
//
//   @Pengu fix the login page for @ben by friday     a ticket for Ben, due Friday (no mention: for you)
//   @Pengu my tickets                                your open tickets
//   @Pengu done 3f2a9c                               close one (the short id from the list)
//
// Slack signs every request with the app's signing secret; anything unsigned or older than five minutes is refused.
// A Slack person acts as the Pengu user an admin linked to them (`npm run pengu -- user slack <id> <SlackMemberId>`),
// with that user's role: viewers can list but not change.

export interface SlackDeps {
  prisma: PrismaClient
  signingSecret: string
  botToken: string
  now?: () => Date
  // Calls a Slack Web API method. Tests pass a fake.
  post?: (method: string, body: Record<string, unknown>) => Promise<unknown>
}

const MAX_BODY = 1_000_000
const MAX_SKEW_S = 300

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function verifySlack(secret: string, timestamp: string | null, signature: string | null, body: string, now: Date): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > MAX_SKEW_S) return false
  const want = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`)
  const got = Buffer.from(signature)
  return want.length === got.length && timingSafeEqual(want, got)
}

const webApi = (token: string) => async (method: string, body: Record<string, unknown>) => {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  })
  return res.json()
}

interface SlackEvent { type?: string; user?: string; text?: string; channel?: string; channel_type?: string; ts?: string; thread_ts?: string; bot_id?: string; subtype?: string }

export function slackRoute({ prisma, signingSecret, botToken, now = () => new Date(), post = webApi(botToken) }: SlackDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)
    const raw = await req.text()
    if (raw.length > MAX_BODY) return json({ error: 'Too large.' }, 413)
    if (!verifySlack(signingSecret, req.headers.get('x-slack-request-timestamp'), req.headers.get('x-slack-signature'), raw, now())) {
      return json({ error: 'Bad signature.' }, 401)
    }
    let body: { type?: string; challenge?: string; event_id?: string; event?: SlackEvent; authorizations?: { user_id?: string }[] }
    try {
      body = JSON.parse(raw)
    } catch {
      return json({ error: 'Bad JSON.' }, 400)
    }
    // Slack checks the Request URL once when it is saved.
    if (body.type === 'url_verification') return json({ challenge: String(body.challenge ?? '') })
    const ev = body.event
    if (body.type !== 'event_callback' || !ev || !body.event_id) return json({ ok: true })
    const wanted = ev.type === 'app_mention' || (ev.type === 'message' && ev.channel_type === 'im')
    if (!wanted || ev.bot_id || ev.subtype || !ev.user || !ev.channel || !ev.ts) return json({ ok: true })
    if (!(await firstTime(prisma, `slack:${body.event_id}`, now()))) return json({ ok: true })

    const text = await answer(prisma, ev, body.authorizations?.[0]?.user_id ?? '', now())
    try {
      await post('chat.postMessage', { channel: ev.channel, thread_ts: ev.thread_ts ?? ev.ts, text })
    } catch (e) {
      console.error('slack: reply failed', (e as Error).message)
    }
    return json({ ok: true })
  }
}

// Records the event id; false when it was already handled. Rows older than a day are pruned on the way.
async function firstTime(prisma: PrismaClient, id: string, now: Date): Promise<boolean> {
  try {
    await prisma.pluginEvent.create({ data: { id, at: now } })
  } catch {
    return false
  }
  await prisma.pluginEvent.deleteMany({ where: { at: { lt: new Date(now.getTime() - 86_400_000) } } })
  return true
}

// ---------- understanding the message ----------

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*'
const DATE_WORDS = new RegExp(
  `\\b(?:(?:by|on|due|before)\\s+)?(?:today|tonight|eod|tomorrow|next week|(?:next\\s+)?(?:sun|mon|tues|wednes|thurs|fri|satur)day|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?)\\b`,
  'gi'
)
const MENTION = /<@([UW][A-Z0-9]{2,20})(?:\|[^>]*)?>/g

// Slack's markup to plain text: channel and link labels kept, entities decoded. Mentions stay as <@U…> for now.
const plain = (t: string) =>
  t
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

export function parseRequest(raw: string, botId: string) {
  const text = plain(raw).replace(new RegExp(`<@${botId || 'NONE'}(?:\\|[^>]*)?>`, 'g'), ' ').replace(/\s+/g, ' ').trim()
  const mentions = [...text.matchAll(MENTION)].map((m) => m[1])
  const title = text
    .replace(MENTION, ' ')
    .replace(DATE_WORDS, ' ')
    .replace(/^(?:please\s+)?(?:(?:create|new|add|make)\s+)?(?:an?\s+)?(?:ticket|task|todo)s?\b\s*[:-]?\s*/i, '')
    .replace(/^(?:assign(?:ed)?\s+)?(?:to|for)\s+/i, '')
    .replace(/\s+(?:assign(?:ed)?\s+)?(?:to|for)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,:-]+|[\s,.:-]+$/g, '')
    .slice(0, 300)
  return { text, mentions, title: title ? title[0].toUpperCase() + title.slice(1) : '' }
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const short = (id: string) => id.slice(0, 6)
const HELP = [
  "Here's what I can do:",
  '• `@Pengu fix the login page for @someone by friday` creates a ticket (no mention: it is yours)',
  '• `@Pengu my tickets` lists your open tickets',
  '• `@Pengu done 3f2a9c` closes one'
].join('\n')

async function answer(prisma: PrismaClient, ev: SlackEvent, botId: string, now: Date): Promise<string> {
  const me = await prisma.user.findUnique({ where: { slackId: ev.user! } })
  if (!me) return `I don't know you in Pengu yet. Ask an admin to run: \`npm run pengu -- user slack <your-username> ${ev.user}\``
  const { text, mentions, title } = parseRequest(ev.text ?? '', botId)
  const cmd = text.toLowerCase()

  if (!cmd || cmd === 'help') return HELP
  if (/^(?:my\s+)?(?:tickets|tasks|todos?|list)\??$/.test(cmd)) {
    const open = await prisma.ticket.findMany({ where: { assignee: me.id, status: 'open', deletedAt: null }, orderBy: [{ deadline: 'asc' }, { updatedAt: 'desc' }], take: 15 })
    if (!open.length) return 'You have no open tickets. 🎉'
    return ['Your open tickets:', ...open.map((t) => `• \`${short(t.id)}\` ${esc(t.title)}${t.deadline ? ` (due ${t.deadline})` : ''}`)].join('\n')
  }
  if (me.role === 'viewer') return 'Your role is read-only (viewer). Ask an admin to make you a member to create or close tickets.'

  const done = /^(?:done|close|closed|finish(?:ed)?)\s+`?([A-Za-z0-9-]{4,64})`?$/i.exec(text)
  if (done) {
    const found = await prisma.ticket.findMany({ where: { id: { startsWith: done[1].toLowerCase() }, status: 'open', deletedAt: null }, take: 2 })
    if (found.length !== 1) return found.length ? 'More than one ticket starts with that. Use more of the id.' : 'No open ticket has that id. Try `@Pengu my tickets`.'
    const users = (await prisma.user.findMany({ select: { id: true } })).map((u) => u.id)
    const t = found[0]
    await write(prisma, parseRow('tickets', { ...t, status: 'done', updatedAt: now.toISOString(), updatedBy: me.id, deletedAt: null }, now, users))
    return `Closed \`${short(t.id)}\` ${esc(t.title)}. ✅`
  }

  if (!title) return HELP
  let assignee = me.id
  if (mentions.length) {
    const who = await prisma.user.findUnique({ where: { slackId: mentions[0] } })
    if (!who) return `<@${mentions[0]}> isn't linked to a Pengu user yet. Ask an admin to run: \`npm run pengu -- user slack <their-username> ${mentions[0]}\``
    assignee = who.id
  }
  const users = (await prisma.user.findMany({ select: { id: true } })).map((u) => u.id)
  const deadline = findDate(text, now)
  const link = `https://slack.com/archives/${ev.channel}/p${ev.ts!.replace('.', '')}`
  const row = parseRow('tickets', {
    id: randomUUID(), discussionId: null, title, assignee, deadline, status: 'open',
    notes: `From Slack: ${link}`, updatedAt: now.toISOString(), updatedBy: me.id, deletedAt: null
  }, now, users)
  await write(prisma, row)
  const owner = mentions.length ? `<@${mentions[0]}>` : 'you'
  return `Created \`${short(row.id)}\` *${esc(title)}* for ${owner}${deadline ? `, due ${deadline}` : ''}. It's in Pengu now.`
}

// Same write as a sync push: a fresh sequence number, so every app pulls the row on its next sync.
async function write(prisma: PrismaClient, row: ReturnType<typeof parseRow>) {
  await prisma.$transaction(async (tx) => {
    const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`select nextval('sync_seq') as n`
    const data = { ...(row as Parameters<typeof tx.ticket.create>[0]['data']), seq: n }
    await tx.ticket.upsert({ where: { id: row.id }, create: data, update: data })
  })
}
