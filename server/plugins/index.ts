import type { PrismaClient } from '../generated/prisma/client.ts'
import { slackRoute } from './slack.ts'

// Server plugins: extra routes that turn messages from other tools into Pengu items. Each is on only when its
// environment variables are set (server/.env, or the host's settings). To add one: write a route in its own file and
// list it here; `serve` mounts it and the Vercel route under api/ calls the same function.

export interface Plugin {
  name: string
  path: string
  env: string[] // all must be set to turn the plugin on
  route(prisma: PrismaClient): (req: Request) => Promise<Response>
}

export const plugins: Plugin[] = [
  {
    name: 'slack',
    path: '/api/slack/events',
    env: ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN'],
    route: (prisma) => slackRoute({ prisma, signingSecret: process.env.SLACK_SIGNING_SECRET!, botToken: process.env.SLACK_BOT_TOKEN! })
  }
]

export const enabled = (p: Plugin) => p.env.every((k) => !!process.env[k])
