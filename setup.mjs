// First run after `git clone`:  npm run setup   (or: node setup.mjs)
// Detects your OS, checks Node, installs dependencies, then runs the database/user wizard (server/cli/pengu.ts).
//   node setup.mjs                      interactive
//   node setup.mjs --server-only        a machine that only hosts the sync server: skips the desktop app's install
//   node setup.mjs --db local --admin ana --name "Ana" --password-env PENGU_ADMIN_PASSWORD --yes     no prompts
// Any other flag is passed to the wizard; see server/cli/pengu.ts for the list.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const win = platform() === 'win32'
const wsl = platform() === 'linux' && /microsoft/i.test(release())
const os = win ? 'Windows' : platform() === 'darwin' ? 'macOS' : wsl ? 'Linux (WSL)' : 'Linux'
console.log(`Detected: ${os} ${arch()}, Node ${process.versions.node}`)

const hint = {
  Windows: 'winget install OpenJS.NodeJS.LTS   (or download from https://nodejs.org), then open a new terminal',
  macOS: 'brew install node   (or download from https://nodejs.org)',
  Linux: 'install Node 22+ with nvm (https://github.com/nvm-sh/nvm): nvm install 22   or your package manager / NodeSource',
  'Linux (WSL)': 'install Node 22+ inside WSL with nvm (https://github.com/nvm-sh/nvm): nvm install 22'
}[os]
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`\nNode 22 or newer is required.\n  ${hint}\nThen run: npm run setup`)
  process.exit(1)
}

const args = process.argv.slice(2)
const serverOnly = args.includes('--server-only')
const passthrough = args.filter((a) => a !== '--server-only')

function run(cmd, cmdArgs, cwd) {
  // npm is a .cmd file on Windows and needs a shell; node's own path may contain spaces, so it must not go through one.
  const viaShell = win && cmd === 'npm'
  const r = spawnSync(viaShell ? 'npm.cmd' : cmd, cmdArgs, { cwd, stdio: 'inherit', shell: viaShell })
  if (r.status !== 0) {
    console.error(`\nFailed: ${cmd} ${cmdArgs.join(' ')}  (in ${cwd})`)
    if (os === 'Linux' || os === 'Linux (WSL)') console.error('On Linux the desktop app may need system libraries (libgtk-3, libnss3, libasound2). On a server, use --server-only.')
    process.exit(r.status ?? 1)
  }
}

if (!serverOnly) {
  console.log('\n[1/3] Installing the desktop app (downloads Electron, a few minutes the first time)')
  run('npm', ['install'], ROOT)
} else console.log('\n[1/3] Skipped the desktop app (--server-only)')
console.log('\n[2/3] Installing the server')
run('npm', ['install'], `${ROOT}server`)
console.log('\n[3/3] Database, secret and first admin')
if (!existsSync(`${ROOT}server/cli/pengu.ts`)) process.exit(1)
run(process.execPath, ['--experimental-strip-types', '--no-warnings', 'cli/pengu.ts', 'setup', ...passthrough], `${ROOT}server`)
