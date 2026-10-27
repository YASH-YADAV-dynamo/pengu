import { prisma } from '../../lib/db.ts'
import { login } from '../../lib/handlers.ts'

// POST /api/auth/login  { user, password }  ->  { token, expiresAt, user, name, role, team }
export async function POST(request: Request) {
  const secret = process.env.PENGU_AUTH_SECRET
  if (!secret || secret.length < 32) return Response.json({ error: 'Server is not configured.' }, { status: 500 })
  return login({ prisma: prisma(), secret })(request)
}
