import { prisma } from '../lib/db.ts'

// GET /api/health  ->  { ok: true } when the database answers. Used by the app's "Test connection" and for uptime checks.
export async function GET() {
  try {
    await prisma().$queryRaw`select 1`
    return Response.json({ ok: true })
  } catch {
    return Response.json({ ok: false }, { status: 503 })
  }
}
