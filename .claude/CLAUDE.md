# Pengu: context for AI assistants

@../AGENTS.md

## What this is

Electron + React desktop app (discussions, tickets, notes, roadmaps, a desktop penguin widget) plus an optional Node sync server.
Base code owned by Yash Yadav (https://x.com/yashastro23); see the hard rule in `AGENTS.md`.

## Where things are

- `src/main/` main process: `index.ts` (lifecycle, tray, reminders, IPC handlers), `store.ts` (single state, atomic save to
  `pengu.json`), `windows.ts` (main + penguin windows), `ai.ts` (runs local `claude -p`), `sync.ts` (talks to the server).
- `src/preload/index.ts` the only API pages can call (`window.pengu`). Every new IPC method needs validation in main.
- `src/renderer/` React UI, one bundle; `#/widget` renders the penguin. `src/shared/` types and pure logic.
- Plugins (`docs/plugins.md`): Slack is a server route (`server/plugins/`), Gmail runs in the app (`src/main/plugins/`).
- `server/lib/` handlers, auth (scrypt + HMAC tokens), sync, Yjs doc merge; `server/api/` Vercel routes; `server/cli/pengu.ts` admin
  CLI and `serve`; `server/prisma/` schema and SQL migrations (add a new numbered folder for schema changes).

## Commands

- Setup: `npm run setup` (see `AI_SETUP.md`). Run: `npm run serve` and `npm run dev`.
- Checks before finishing: `npm run typecheck`, then `cd server && npx tsc --noEmit && npm test`.

## Rules

- Never read, print or commit `server/.env`, passwords, tokens or connection strings. Use placeholders in examples.
- Keep windows sandboxed (`contextIsolation`, `sandbox`, no `nodeIntegration`); validate all IPC input in main and all request input
  on the server; never pass user text to a shell.
- No hardcoded people: users and roles come from the server's `User` table.
- Match the surrounding code style and comment density; keep changes small and focused.
