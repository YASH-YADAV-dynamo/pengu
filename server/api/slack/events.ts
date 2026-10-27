import { prisma } from '../../lib/db.ts'
import { enabled, plugins } from '../../plugins/index.ts'

// POST /api/slack/events  Slack's Events API (signed by Slack). See plugins/slack.ts.
export async function POST(request: Request) {
  const slack = plugins.find((p) => p.name === 'slack')!
  if (!enabled(slack)) return Response.json({ error: 'The Slack plugin is not configured.' }, { status: 404 })
  return slack.route(prisma())(request)
}
