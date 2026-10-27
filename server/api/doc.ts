import { prisma } from '../lib/db.ts'
import { docRoute } from '../lib/handlers.ts'

// POST /api/doc  { docId, since, updates?: base64[], seed?: base64 }  ->  { updates: [{id, update}], last, more }
// Live editing of one discussion's document (see lib/doc.ts).
export async function POST(request: Request) {
  const secret = process.env.PENGU_AUTH_SECRET
  if (!secret || secret.length < 32) return Response.json({ error: 'Server is not configured.' }, { status: 500 })
  return docRoute({ prisma: prisma(), secret })(request)
}
