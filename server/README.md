# Pengu server

The sync API and the admin CLI. The desktop app never holds database credentials: it signs in here with a username and
password and syncs through the API.

| Route | What it does |
|---|---|
| `POST /api/auth/login` | `{user, password}` -> a 30-day signed token, the user's role and the team list. 8 wrong passwords per address per 15 minutes, then 429. |
| `POST /api/sync` | `{cursor, changes}` -> applies the caller's changes (last write wins on `updatedAt`), returns everything newer than `cursor` and the team list. |
| `POST /api/doc` | Live editing of one discussion's document: `{docId, since, updates?, seed?}` -> every update not seen yet. The app merges them with Yjs, so two people typing at once both keep their words. |
| `GET /api/health` | `{ok:true}` when the database answers. |
| `POST /api/slack/events` | Slack plugin (on when `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are set): `@Pengu` creates, lists and closes tickets. See [`docs/plugins.md`](../docs/plugins.md). |

## Set up

From the repo root, `npm run setup` does everything below. By hand:

```bash
cd server
npm install
npm run pengu -- setup        # database, .env, tables, first admin
npm run serve                 # http://localhost:8787
```

Two ways to store data (`server/.env`):

- **Built-in local database** (no `DATABASE_URL`): files in `server/.data/`, nothing to install. One process owns it at a time, so
  stop `npm run serve` before using `user` commands.
- **Your own Postgres** (`DATABASE_URL`): Neon, Supabase, RDS, Docker (`docker run -e POSTGRES_PASSWORD=... -p 5432:5432 postgres:17`)...
  Tables are created with `prisma migrate deploy`. For Neon, `DIRECT_URL` may hold the non-pooled string for migrations.

`npm run pengu` lists every command (`user add|list|role|passwd|remove|slack`, `db migrate|status`, `serve`, `doctor`).

## Roles

`admin`, `member`, `viewer`. Viewers can read but their changes are rejected (HTTP 403). A role change or removal takes effect on
the person's next request, no new sign-in needed. The last admin cannot be demoted or removed.

## Hosting

- **Anywhere Node 22 runs**: `npm run serve -- --host 0.0.0.0 --port 8787` behind an HTTPS reverse proxy (Caddy, nginx, a tunnel).
  Behind a proxy, add `--trust-proxy` (or `TRUST_PROXY=1`) and forward `x-forwarded-for` so sign-in throttling sees real
  addresses. Without a proxy, leave it off: the header would be client-controlled.
- **Vercel**: import the repo, **Root Directory = `server`**, framework *Other*, environment variables `DATABASE_URL` and
  `PENGU_AUTH_SECRET`. The `api/` folder is the routes. Vercel needs a hosted Postgres (not the built-in local one). Add users by
  running the CLI on your computer with the same `DATABASE_URL`.

To rotate everyone's sign-in, change `PENGU_AUTH_SECRET` and restart.

## Data model

Tables (`prisma/schema.prisma`): `User` (username, display name, password hash, role), `Discussion`, `Ticket`, `Roadmap`, `Note`,
`DocUpdate` (live-edit updates, merged into one row after 300), `LoginFailure`, `PluginEvent` (plugin deliveries already handled).
`User.slackId` links a person to Slack. Every synced table has `updatedAt`, `updatedBy`,
`deletedAt` (soft delete) and `seq` (one shared sequence, the sync cursor). Links between items are plain ids, not foreign keys, so
the two apps can send a ticket before its discussion arrives.

Rules enforced by the server: each person can only write items as themselves; `assignee`/`updatedBy` must be existing users; unknown
fields are dropped; enums, lengths and ids are checked; a timestamp more than 10 minutes in the future counts as "now"; at most 200
changes per request.

## Develop and test

- `npm test` runs the tests against a real in-memory Postgres (PGlite) with the real migration: sign-in and throttling, roles,
  token expiry, two-way sync, last-write-wins, deletes, forged authors, bad items, clock skew, paging, and live editing.
- `npm run typecheck`.
- Change the schema: edit `prisma/schema.prisma`, then add the matching SQL as a new folder in `prisma/migrations/` (the local database
  applies those same files).

## Known limits

- Sync interval is 30 s plus a few seconds after any change, so others see an edit within about half a minute.
- Fields other than a discussion's document: if two people edit the same item at once, the later save replaces the earlier one. The
  document text itself merges live (needs Team sync sign-in; about 1.5 s delay; no cursors of the other person yet).
- Images pasted into documents are local files and are not synced.
- The standard-Postgres (`pg`) and Neon paths are covered by type checks only; the SQL, handlers and queries are tested on PGlite.
