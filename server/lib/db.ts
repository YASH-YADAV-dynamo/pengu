import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.ts'

// Where the data lives. Two modes, picked by the environment (server/.env, written by `npm run setup`):
//   hosted  DATABASE_URL is set: any Postgres (Neon, Supabase, RDS, your own server...).
//   local   no DATABASE_URL: a Postgres that runs inside this process and keeps its files in server/.data/.
// The Vercel routes only ever use hosted mode (prisma() below); the CLI and `serve` can use either (openDb()).

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
export const DATA_DIR = `${SERVER_DIR}.data`
const LOCK = `${DATA_DIR}/server.lock`
const MIGRATIONS = new URL('../prisma/migrations/', import.meta.url)

// Read server/.env into process.env without overriding what is already set (Vercel and CI set real variables).
export function loadEnv() {
  try {
    process.loadEnvFile(`${SERVER_DIR}.env`)
  } catch {
    /* no .env: fine */
  }
}

// Neon's pooled hosts need its serverless driver; every other Postgres uses the standard one.
const adapterFor = (url: string) => (new URL(url).hostname.endsWith('.neon.tech') ? new PrismaNeon({ connectionString: url }) : new PrismaPg({ connectionString: url }))

let client: PrismaClient | undefined

// One client per warm function instance (hosted mode).
export function prisma(): PrismaClient {
  if (client) return client
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  client = new PrismaClient({ adapter: adapterFor(url) })
  return client
}

export interface Db {
  prisma: PrismaClient
  mode: 'hosted' | 'local'
  // Local mode applies any migration not yet recorded and returns their names. Hosted mode is migrated by
  // `prisma migrate deploy` (cli/pengu.ts), so this returns [] there.
  migrate(): Promise<string[]>
  close(): Promise<void>
}

const alive = (pid: number) => {
  try {
    return process.kill(pid, 0), true
  } catch {
    return false
  }
}

// The local database is a single-process file store, so two programs must not open it at once: `serve` writes a lock
// with its process id, and the CLI refuses to open the database while that process is alive.
export function localServerPid(): number | null {
  try {
    const pid = Number(readFileSync(LOCK, 'utf8'))
    return alive(pid) ? pid : null
  } catch {
    return null
  }
}

export const migrationNames = () => readdirSync(MIGRATIONS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
const migrationSql = (name: string) => readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS), 'utf8')

export async function openDb({ lock = false }: { lock?: boolean } = {}): Promise<Db> {
  const url = process.env.DATABASE_URL
  if (url) {
    const p = new PrismaClient({ adapter: adapterFor(url) })
    return { prisma: p, mode: 'hosted', migrate: async () => [], close: () => p.$disconnect() }
  }
  const running = localServerPid()
  if (running && running !== process.pid) {
    throw new Error(`The local server is running (process ${running}) and has the database open. Stop it first, or use a hosted Postgres (DATABASE_URL) so the CLI and the server can run together.`)
  }
  mkdirSync(DATA_DIR, { recursive: true })
  if (lock) writeFileSync(LOCK, String(process.pid))
  const { PGlite } = await import('@electric-sql/pglite')
  const { PrismaPGlite } = await import('pglite-prisma-adapter')
  const pg = new PGlite(`${DATA_DIR}/pg`)
  await pg.waitReady
  const p = new PrismaClient({ adapter: new PrismaPGlite(pg) })
  return {
    prisma: p,
    mode: 'local',
    // The same SQL files Prisma applies to a hosted database, each recorded once in a small table.
    async migrate() {
      await pg.exec('CREATE TABLE IF NOT EXISTS "_pengu_migrations" (name TEXT PRIMARY KEY, at TIMESTAMP DEFAULT now())')
      const have = new Set((await pg.query<{ name: string }>('SELECT name FROM "_pengu_migrations"')).rows.map((r) => r.name))
      const done: string[] = []
      for (const name of migrationNames().filter((n) => !have.has(n))) {
        await pg.exec(migrationSql(name))
        await pg.query('INSERT INTO "_pengu_migrations" (name) VALUES ($1)', [name])
        done.push(name)
      }
      return done
    },
    async close() {
      await p.$disconnect()
      await pg.close()
      if (lock) rmSync(LOCK, { force: true })
    }
  }
}
