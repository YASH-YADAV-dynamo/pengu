import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Plain-text log at userData/logs/pengu.log (Settings → Open logs). It records what happened, not what was said:
// voice and assistant lines carry lengths, timings and errors, never the user's words or item content.

const MAX = 1_000_000 // past ~1 MB the file rolls over to pengu.old.log, so it never grows without bound
export const logDir = () => join(app.getPath('userData'), 'logs')

export function log(scope: string, ...parts: unknown[]) {
  const line = `${new Date().toISOString()} [${scope}] ${parts.map((p) => (p instanceof Error ? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`
  try {
    mkdirSync(logDir(), { recursive: true })
    const file = join(logDir(), 'pengu.log')
    try {
      if (statSync(file).size > MAX) renameSync(file, join(logDir(), 'pengu.old.log'))
    } catch {
      // no file yet
    }
    appendFileSync(file, line)
  } catch {
    // logging must never break the app
  }
  if (!app.isPackaged) process.stdout.write(line)
}
