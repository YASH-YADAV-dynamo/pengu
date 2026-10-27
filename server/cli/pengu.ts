import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { arch, platform, release } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { hashPassword } from '../lib/auth.ts'
import { DATA_DIR, loadEnv, localServerPid, migrationNames, openDb, type Db } from '../lib/db.ts'
import { docRoute, login, syncRoute } from '../lib/handlers.ts'
import { enabled, plugins } from '../plugins/index.ts'

// The Pengu admin CLI. Run from the repo root:  npm run pengu -- <command>   (or `npm run setup` for the first run).
//
//   setup                         wire the database, create .env, run migrations, create the first admin
//   db migrate | db status        apply or list migrations
//   user add <id>                 create a person (--name, --role admin|member|viewer, password options below)
//   user list                     everyone and their role
//   user role <id> <role>         change a role
//   user passwd <id>              set a new password
//   user remove <id>              delete a person (their token stops working at once)
//   user slack <id> <U…|none>     link a person to their Slack member id, so @Pengu in Slack acts as them
//   serve                         run the sync API (--port 8787, --host 127.0.0.1, --trust-proxy behind a reverse proxy)
//   doctor                        check this computer and the configuration
//
// Passwords: --password-env NAME reads it from that environment variable (nothing in shell history);
// --generate makes a random one and prints it once; otherwise you are asked, with the typing hidden.
// Everything can be given as flags, so a script or an AI assistant can run it without a terminal prompt.

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const ENV_FILE = `${SERVER_DIR}.env`
const ROLES = ['admin', 'member', 'viewer'] as const
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const MAX_REQUEST = 5_000_000 // a little over the handlers' 4 MB JSON limit, so an endless body can't fill memory

class Fail extends Error {}
const fail = (msg: string): never => {
  throw new Fail(msg)
}

// ---------- arguments and prompts ----------

const argv = process.argv.slice(2)
const flags: Record<string, string | true> = {}
const pos: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) pos.push(a)
  else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i]
  else flags[a.slice(2)] = true
}
const flag = (name: string) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined)
const interactive = !!process.stdin.isTTY && !flags.yes

let rl: ReturnType<typeof createInterface> | undefined
async function ask(question: string, fallback?: string): Promise<string> {
  if (!interactive && fallback) return fallback
  if (!interactive) return fail(`Missing a value for "${question}". Pass it as a flag (see the command list in cli/pengu.ts) or run in a terminal.`)
  rl ??= createInterface({ input: process.stdin, output: process.stdout })
  const answer: string = await new Promise((r) => rl!.question(fallback ? `${question} [${fallback}]: ` : `${question}: `, r))
  return answer.trim() || fallback || ''
}

// Reads a line without echoing it (passwords, connection strings).
async function askSecret(question: string): Promise<string> {
  if (!interactive) return fail(`Missing "${question}". Use --password-env NAME (or --generate), or run in a terminal.`)
  rl?.close()
  rl = undefined
  process.stdout.write(`${question}: `)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve) => {
    let text = ''
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          return resolve(text)
        }
        if (c === '\x03') process.exit(130)
        if (c === '\x7f' || c === '\b') text = text.slice(0, -1)
        else text += c
      }
    }
    stdin.on('data', onData)
  })
}

const checkPassword = (p: string) => (p.length >= 10 && p.length <= 200 ? p : fail('Use a password of 10 to 200 characters.'))

async function passwordFor(who: string, { confirm = true } = {}): Promise<{ password: string; generated: boolean }> {
  const envName = flag('password-env')
  if (envName) {
    const v = process.env[envName]
    if (!v) fail(`The environment variable ${envName} is empty or not set.`)
    return { password: checkPassword(v!), generated: false }
  }
  if (flags.generate) return { password: randomBytes(12).toString('base64url'), generated: true }
  const first = checkPassword(await askSecret(`Password for ${who} (10+ characters)`))
  if (confirm && (await askSecret('Repeat it')) !== first) fail('The two passwords do not match.')
  return { password: first, generated: false }
}

// ---------- .env ----------

function readEnvFile(): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(ENV_FILE)) return out
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out.set(m[1], m[2].replace(/^"(.*)"$/, '$1'))
  }
  return out
}
function writeEnvFile(values: Record<string, string | null>) {
  const env = readEnvFile()
  for (const [k, v] of Object.entries(values)) v === null ? env.delete(k) : env.set(k, v)
  const text = ['# Written by `npm run setup`. Never commit this file (it is git-ignored).', ...[...env].map(([k, v]) => `${k}="${v}"`)].join('\n') + '\n'
  writeFileSync(ENV_FILE, text, { mode: 0o600 })
  for (const k of Object.keys(values)) values[k] === null ? delete process.env[k] : (process.env[k] = values[k]!)
}

// ---------- helpers ----------

const withDb = async <T>(fn: (db: Db) => Promise<T>, opts?: { lock?: boolean }): Promise<T> => {
  const db = await openDb(opts)
  try {
    const applied = await db.migrate()
    if (applied.length) console.log(`Applied database migrations: ${applied.join(', ')}`)
    return await fn(db)
  } finally {
    await db.close()
  }
}

function migrateHosted() {
  const win = platform() === 'win32'
  const r = spawnSync(win ? 'npx.cmd' : 'npx', ['prisma', 'migrate', 'deploy'], { cwd: SERVER_DIR, stdio: 'inherit', shell: win, env: process.env })
  if (r.status !== 0) fail('`prisma migrate deploy` failed. Check the connection string and that the database user may create tables.')
}

const validId = (id: string | undefined) => (id && ID.test(id) ? id : fail('A username is 1-32 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit.'))
const validRole = (r: string | undefined) => ((ROLES as readonly string[]).includes(r ?? '') ? (r as string) : fail(`The role must be one of: ${ROLES.join(', ')}.`))

// ---------- commands ----------

async function setup() {
  console.log(`Pengu setup on ${platform()} ${release()} (${arch()}), Node ${process.versions.node}`)
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Node 22 or newer is required. Install it from https://nodejs.org and run this again.')

  // 1. Which database.
  let choice = flag('db') ?? (flag('database-url') || flag('database-url-env') ? 'url' : undefined)
  if (!choice) {
    if (readEnvFile().has('DATABASE_URL')) choice = 'keep'
    else if (existsSync(DATA_DIR)) choice = 'local'
    else {
      console.log('\nWhere should the data live?\n  1) On this computer, nothing to install (good to try it out; one machine hosts the team)\n  2) A Postgres database you already have (Neon, Supabase, RDS, your own server...)')
      choice = (await ask('Choose 1 or 2', '1')) === '2' ? 'url' : 'local'
    }
  }
  if (choice === 'local') {
    writeEnvFile({ DATABASE_URL: null, DIRECT_URL: null })
    console.log(`Using the built-in local database (files in ${DATA_DIR}).`)
  } else if (choice === 'url') {
    const fromEnv = flag('database-url-env') ? process.env[flag('database-url-env')!] : undefined
    const url = flag('database-url') ?? fromEnv ?? (await askSecret('Postgres connection string (postgresql://...)'))
    if (!/^postgres(ql)?:\/\//.test(url)) fail('The connection string must look like postgresql://user:password@host:5432/dbname')
    try {
      new URL(url)
    } catch {
      fail('That is not a valid connection string.')
    }
    writeEnvFile({ DATABASE_URL: url, DIRECT_URL: flag('direct-url') ?? null })
    console.log('Saved the connection string to server/.env (git-ignored).')
  }

  // 2. The secret that signs sign-in tokens.
  if (!readEnvFile().has('PENGU_AUTH_SECRET')) writeEnvFile({ PENGU_AUTH_SECRET: randomBytes(48).toString('base64url') })

  // 3. Tables.
  if (process.env.DATABASE_URL) migrateHosted()

  await withDb(async (db) => {
    console.log(`Database ready (${db.mode}).`)
    // 4. The first admin.
    if ((await db.prisma.user.count()) > 0) return void console.log('Users already exist; skipping the first admin. Add more with: npm run pengu -- user add <id>')
    console.log('\nCreate the first admin (everyone else can be added later).')
    const id = validId(flag('admin') ?? (await ask('Username', 'admin')))
    const name = flag('name') ?? (await ask('Display name', id))
    const { password, generated } = await passwordFor(id)
    await db.prisma.user.create({ data: { id, name, role: 'admin', passwordHash: hashPassword(password) } })
    console.log(`Created admin "${id}".`)
    if (generated) console.log(`Generated password (shown once, store it now): ${password}`)
  })
  console.log(`
All set. Next:
  npm run serve         start the sync server (http://localhost:8787)
  npm run dev           in another terminal, start the desktop app
Then in the app: Settings -> Team sync -> server address http://localhost:8787, your username and password.
Add teammates:          npm run pengu -- user add <id> --name "Name" --role member`)
}

async function user() {
  const [, sub, id, extra] = pos
  if (sub === 'list') {
    return withDb(async ({ prisma }) => {
      const rows = await prisma.user.findMany({ orderBy: { id: 'asc' } })
      if (!rows.length) return void console.log('No users yet. Create one: npm run pengu -- user add <id> --role admin')
      console.table(rows.map((u) => ({ username: u.id, name: u.name, role: u.role, slack: u.slackId ?? '', created: u.createdAt.toISOString().slice(0, 10) })))
    })
  }
  if (sub === 'add') {
    const uid = validId(id ?? (await ask('Username')))
    const name = flag('name') ?? (await ask('Display name', uid))
    const role = validRole(flag('role') ?? (interactive ? await ask(`Role (${ROLES.join('/')})`, 'member') : 'member'))
    const { password, generated } = await passwordFor(uid)
    await withDb(async ({ prisma }) => {
      if (await prisma.user.findUnique({ where: { id: uid } })) fail(`"${uid}" already exists. Use "user passwd" or "user role" to change them.`)
      await prisma.user.create({ data: { id: uid, name, role, passwordHash: hashPassword(password) } })
    })
    console.log(`Created ${role} "${uid}".`)
    if (generated) console.log(`Generated password (shown once, give it to ${name}): ${password}`)
    return
  }
  if (sub === 'slack') {
    const uid = validId(id)
    // A Slack member id (Slack: profile -> ⋮ -> Copy member ID). Only an admin running this CLI can link one, so
    // nobody can claim someone else's Slack account from inside the app.
    const slackId = extra === 'none' ? null : /^[UW][A-Z0-9]{2,20}$/.test(extra ?? '') ? extra! : fail('Give the Slack member id (starts with U, e.g. U01ABCDEF), or "none" to unlink.')
    return withDb(async ({ prisma }) => {
      if (!(await prisma.user.findUnique({ where: { id: uid } }))) return fail(`There is no user "${uid}". See: npm run pengu -- user list`)
      const taken = slackId ? await prisma.user.findUnique({ where: { slackId } }) : null
      if (taken && taken.id !== uid) fail(`That Slack id is already linked to "${taken.id}".`)
      await prisma.user.update({ where: { id: uid }, data: { slackId } })
      console.log(slackId ? `"${uid}" is now ${slackId} in Slack.` : `"${uid}" is no longer linked to Slack.`)
    })
  }
  if (sub !== 'role' && sub !== 'passwd' && sub !== 'remove') return fail('Usage: user add|list|role|passwd|remove|slack')
  const uid = validId(id)
  const role = sub === 'role' ? validRole(extra ?? flag('role')) : ''
  const pw = sub === 'passwd' ? await passwordFor(uid) : null
  await withDb(async ({ prisma }) => {
    const row = await prisma.user.findUnique({ where: { id: uid } })
    if (!row) return fail(`There is no user "${uid}". See: npm run pengu -- user list`)
    const lastAdmin = row.role === 'admin' && (await prisma.user.count({ where: { role: 'admin' } })) <= 1
    if (sub === 'role') {
      if (lastAdmin && role !== 'admin') fail('That is the last admin. Make someone else an admin first.')
      await prisma.user.update({ where: { id: uid }, data: { role } })
      console.log(`"${uid}" is now ${role}. It applies at their next sync.`)
    } else if (sub === 'passwd') {
      await prisma.user.update({ where: { id: uid }, data: { passwordHash: hashPassword(pw!.password) } })
      console.log(`Password changed for "${uid}".`)
      if (pw!.generated) console.log(`Generated password (shown once): ${pw!.password}`)
    } else {
      if (lastAdmin) fail('That is the last admin; it cannot be removed.')
      await prisma.user.delete({ where: { id: uid } })
      console.log(`Removed "${uid}". Their sign-in stops working immediately; items they created stay.`)
    }
  })
}

async function serve() {
  const secret = process.env.PENGU_AUTH_SECRET
  if (!secret || secret.length < 32) fail('PENGU_AUTH_SECRET is missing. Run: npm run setup')
  const port = Number(flag('port') ?? process.env.PORT ?? 8787)
  const host = flag('host') ?? process.env.HOST ?? '127.0.0.1'
  const db = await openDb({ lock: true })
  const applied = await db.migrate()
  if (applied.length) console.log(`Applied database migrations: ${applied.join(', ')}`)
  const deps = { prisma: db.prisma, secret: secret! }
  const routes: Record<string, (r: Request) => Promise<Response>> = {
    '/api/auth/login': login(deps),
    '/api/sync': syncRoute(deps),
    '/api/doc': docRoute(deps),
    ...Object.fromEntries(plugins.filter(enabled).map((p) => [p.path, p.route(db.prisma)])),
    '/api/health': async () => {
      try {
        await db.prisma.$queryRaw`select 1`
        return Response.json({ ok: true })
      } catch {
        return Response.json({ ok: false }, { status: 503 })
      }
    }
  }
  // Only a reverse proxy you run may set x-forwarded-for; trusting it otherwise lets anyone dodge sign-in throttling.
  const trustProxy = !!flags['trust-proxy'] || process.env.TRUST_PROXY === '1'
  const server = createServer(async (req, res) => {
    try {
      const handler = routes[(req.url ?? '').split('?')[0]]
      if (!handler) return void res.writeHead(404).end()
      const chunks: Buffer[] = []
      let size = 0
      for await (const c of req) {
        size += (c as Buffer).length
        if (size > MAX_REQUEST) return void res.writeHead(413).end()
        chunks.push(c as Buffer)
      }
      const forwarded = trustProxy ? (req.headers['x-forwarded-for'] as string | undefined) : undefined
      const headers = { ...(req.headers as Record<string, string>), 'x-forwarded-for': forwarded ?? req.socket.remoteAddress ?? 'unknown' }
      const out = await handler(new Request(`http://localhost${req.url}`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }))
      res.writeHead(out.status, Object.fromEntries(out.headers)).end(await out.text())
    } catch (e) {
      console.error(e)
      res.writeHead(500).end()
    }
  })
  const stop = async () => {
    server.close()
    await db.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const on = plugins.filter(enabled).map((p) => p.name)
  server.listen(port, host, () => console.log(`Pengu server on http://${host}:${port}  (database: ${db.mode}; plugins: ${on.join(', ') || 'none'}). Ctrl+C to stop.`))
}

async function doctor() {
  const ok = (good: boolean, text: string) => console.log(`${good ? 'ok  ' : 'FAIL'} ${text}`)
  console.log(`System: ${platform()} ${release()} ${arch()}`)
  ok(Number(process.versions.node.split('.')[0]) >= 22, `Node ${process.versions.node} (22+ needed)`)
  ok(existsSync(ENV_FILE), 'server/.env exists (run npm run setup if not)')
  ok((process.env.PENGU_AUTH_SECRET ?? '').length >= 32, 'PENGU_AUTH_SECRET is set')
  console.log(`Database: ${process.env.DATABASE_URL ? 'hosted Postgres (DATABASE_URL)' : 'built-in local database'}`)
  for (const p of plugins) console.log(`Plugin ${p.name}: ${enabled(p) ? 'on' : `off (set ${p.env.join(' and ')} to turn it on)`}`)
  const pid = localServerPid()
  if (pid) return void console.log(`The local server is running (process ${pid}); stop it before using user commands.`)
  await withDb(async (db) => ok(true, `database opens, ${await db.prisma.user.count()} user(s)`)).catch((e) => ok(false, `database: ${(e as Error).message}`))
}

// ---------- entry ----------

loadEnv()
const commands: Record<string, () => Promise<void>> = {
  setup,
  user,
  serve,
  doctor,
  db: async () => {
    if (pos[1] === 'migrate') {
      if (process.env.DATABASE_URL) migrateHosted()
      else await withDb(async () => console.log('Local database is up to date.'))
    } else if (pos[1] === 'status') await withDb(async (db) => console.log(`${db.mode} database. Migrations in the repo: ${migrationNames().join(', ')}`))
    else fail('Usage: db migrate | db status')
  }
}
try {
  const run = commands[pos[0] ?? '']
  if (!run) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
    process.exit(pos[0] ? 1 : 0)
  }
  await run()
  if (pos[0] !== 'serve') {
    rl?.close()
    process.exit(0)
  }
} catch (e) {
  rl?.close()
  console.error(e instanceof Error && !process.env.PENGU_DEBUG ? `Error: ${e.message}` : e)
  process.exit(1)
}
