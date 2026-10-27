import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { before, describe, it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PrismaPGlite } from 'pglite-prisma-adapter'
import { PrismaClient } from '../generated/prisma/client.ts'
import { migrationNames } from '../lib/db.ts'
import { parseRequest, slackRoute } from '../plugins/slack.ts'

// The Slack plugin against a real in-memory Postgres, with Slack's replies captured instead of sent.
const signingSecret = 's'.repeat(32)
const clock = new Date('2026-10-14T12:00:00') // a Wednesday
let prisma: PrismaClient
let route: (r: Request) => Promise<Response>
const replies: { channel: string; text: string }[] = []
let n = 0

function signed(body: unknown, { secret = signingSecret, at = clock } = {}) {
  const raw = JSON.stringify(body)
  const ts = String(Math.floor(at.getTime() / 1000))
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`
  return new Request('https://x/api/slack/events', { method: 'POST', headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body: raw })
}
const mention = (user: string, text: string, eventId = `Ev${++n}`) => ({
  type: 'event_callback', event_id: eventId, authorizations: [{ user_id: 'UBOT' }],
  event: { type: 'app_mention', user, text: `<@UBOT> ${text}`, channel: 'C1', ts: `1760443200.00${n}` }
})
async function say(user: string, text: string) {
  replies.length = 0
  const r = await route(signed(mention(user, text)))
  assert.equal(r.status, 200)
  return replies.at(-1)?.text ?? ''
}

before(async () => {
  const pg = new PGlite()
  await pg.exec(migrationNames().map((name) => readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8')).join('\n'))
  prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) })
  await prisma.user.createMany({ data: [
    { id: 'ana', name: 'Ana', passwordHash: 'x', slackId: 'UANA' },
    { id: 'ben', name: 'Ben', passwordHash: 'x', slackId: 'UBEN' },
    { id: 'vic', name: 'Vic', passwordHash: 'x', role: 'viewer', slackId: 'UVIC' }
  ] })
  route = slackRoute({ prisma, signingSecret, botToken: 'xoxb-test', now: () => clock, post: async (_m, b) => void replies.push(b as { channel: string; text: string }) })
})

describe('slack: requests', () => {
  it('refuses unsigned, wrongly signed and old requests', async () => {
    assert.equal((await route(new Request('https://x', { method: 'POST', body: '{}' }))).status, 401)
    assert.equal((await route(signed({ type: 'url_verification' }, { secret: 'w'.repeat(32) }))).status, 401)
    assert.equal((await route(signed({ type: 'url_verification' }, { at: new Date(clock.getTime() - 600_000) }))).status, 401)
  })
  it('answers the URL check', async () => {
    const r = await route(signed({ type: 'url_verification', challenge: 'abc' }))
    assert.deepEqual(await r.json(), { challenge: 'abc' })
  })
  it('handles a retried event once', async () => {
    const before = await prisma.ticket.count()
    await route(signed(mention('UANA', 'water the plants', 'EvSame')))
    await route(signed(mention('UANA', 'water the plants', 'EvSame')))
    assert.equal(await prisma.ticket.count(), before + 1)
  })
})

describe('slack: tickets', () => {
  it('creates a ticket for the mentioned person with a deadline', async () => {
    const text = await say('UANA', 'fix the login page for <@UBEN> by friday')
    const t = await prisma.ticket.findFirst({ where: { title: 'Fix the login page' } })
    assert.ok(t, text)
    assert.equal(t.assignee, 'ben')
    assert.equal(t.updatedBy, 'ana')
    assert.equal(t.deadline, '2026-10-16')
    assert.match(t.notes, /slack\.com\/archives\/C1/)
    assert.match(text, /Created/)
  })
  it('gives the ticket to the requester when nobody is mentioned', async () => {
    await say('UBEN', 'ticket: write release notes')
    assert.equal((await prisma.ticket.findFirst({ where: { title: 'Write release notes' } }))?.assignee, 'ben')
  })
  it('lists and closes your tickets', async () => {
    const list = await say('UBEN', 'my tickets')
    assert.match(list, /Fix the login page/)
    const t = (await prisma.ticket.findFirst({ where: { title: 'Fix the login page' } }))!
    assert.match(await say('UBEN', `done ${t.id.slice(0, 6)}`), /Closed/)
    const after = (await prisma.ticket.findUnique({ where: { id: t.id } }))!
    assert.equal(after.status, 'done')
    assert.ok(after.seq > t.seq, 'a new sequence number, so apps pull the change')
  })
  it('refuses people who are not linked, unknown assignees and viewers', async () => {
    const before = await prisma.ticket.count()
    assert.match(await say('UNOBODY', 'do a thing'), /don't know you/)
    assert.match(await say('UANA', 'do a thing for <@USTRANGER>'), /isn't linked/)
    assert.match(await say('UVIC', 'do a thing'), /read-only/)
    assert.match(await say('UVIC', 'my tickets'), /no open tickets/)
    assert.equal(await prisma.ticket.count(), before)
  })
})

describe('slack: parsing', () => {
  it('keeps the words that matter in the title', () => {
    assert.equal(parseRequest('<@UBOT> create a ticket: review <https://x.io|the PR> for <@UBEN> tomorrow', 'UBOT').title, 'Review the PR')
    assert.deepEqual(parseRequest('<@UBOT> ping <@UANA> &amp; <@UBEN|ben>', 'UBOT').mentions, ['UANA', 'UBEN'])
  })
})
