import { prisma } from '../lib/db.ts'
import { syncRoute } from '../lib/handlers.ts'

// POST /api/sync  { cursor, changes: [{ kind, data }] }  ->  { cursor, more, rows, rejected, applied }
export async function POST(request: Request) {
  const secret = process.env.PENGU_AUTH_SECRET
  if (!secret || secret.length < 32) return Response.json({ error: 'Server is not configured.' }, { status: 500 })
  return syncRoute({ prisma: prisma(), secret })(request)
}
