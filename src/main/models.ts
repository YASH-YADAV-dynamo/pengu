import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { ASSISTANT_MODELS, type AssistantStatus, type VoiceStatus } from '../shared/model'
import { log } from './log'

// Disk cache for the open-source Whisper voice model. Main downloads it when the app starts (ensure), and the
// page's worker reads the same files through get(); a file the worker fetches itself is saved through put().
// Browser cache storage isn't reliable under file://, which is why this lives in main.

const root = () => join(app.getPath('userData'), 'models')

// Only huggingface.co URLs map to a file, and the path must stay inside the models folder,
// so a crafted URL can't read or write anywhere else on disk.
function fileFor(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.hostname !== 'huggingface.co') return null
    const rel = decodeURIComponent(u.pathname).replace(/[^\w./-]/g, '_')
    const file = resolve(root(), '.' + rel)
    return relative(root(), file).startsWith('..') ? null : file
  } catch {
    return null
  }
}

export async function get(url: unknown): Promise<Uint8Array | null> {
  const file = fileFor(url)
  if (!file) return null
  try {
    return await readFile(file)
  } catch {
    return null
  }
}

export async function put(url: unknown, data: unknown) {
  const file = fileFor(url)
  if (!file || !(data instanceof Uint8Array || data instanceof ArrayBuffer)) return
  await mkdir(dirname(file), { recursive: true })
  // Temp file + rename, so a crash mid-write never leaves a truncated model that looks complete.
  await writeFile(file + '.tmp', new Uint8Array(data))
  await rename(file + '.tmp', file)
}

export const clear = () => rm(root(), { recursive: true, force: true })

// Total bytes on disk, shown in Settings next to the delete button.
export async function size(dir = root()): Promise<number> {
  try {
    let total = 0
    for (const e of await readdir(dir, { withFileTypes: true }))
      total += e.isDirectory() ? await size(join(dir, e.name)) : (await stat(join(dir, e.name))).size
    return total
  } catch {
    return 0
  }
}

// ---------- download at startup ----------

// Exactly the files transformers.js asks for with dtype q8 (checked against what the worker requested).
const FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']
const urlOf = (model: string, f: string) => `https://huggingface.co/${model}/resolve/main/${f}`

let running: Promise<void> | null = null
let runningModel = ''

// A file's size for an honest percent. The Hub's first hop (before the CDN redirect) carries X-Linked-Size.
async function sizeOf(url: string) {
  const r = await fetch(url, { method: 'HEAD', redirect: 'manual' }).catch(() => null)
  return Number(r?.headers.get('x-linked-size') ?? r?.headers.get('content-length') ?? 0)
}

// Fetch one file to disk. Hugging Face redirects large files to a CDN; the first hop carries X-Linked-ETag,
// the file's SHA-256, which is checked before the file is kept. A bad or partial download is thrown away.
async function download(url: string, file: string, onBytes: (n: number) => void) {
  const first = await fetch(url, { redirect: 'manual' })
  const sha = first.headers.get('x-linked-etag')?.replace(/"/g, '')
  const res = first.status >= 300 && first.status < 400 ? await fetch(new URL(first.headers.get('location')!, url)) : first
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url.split('/main/')[1]}`)
  await mkdir(dirname(file), { recursive: true })
  const hash = createHash('sha256')
  const part = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.part`
  const out = createWriteStream(part)
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
      onBytes(chunk.length)
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())))
    if (sha && /^[0-9a-f]{64}$/.test(sha) && hash.digest('hex') !== sha) throw new Error(`checksum mismatch for ${url.split('/main/')[1]}`)
    await rename(part, file)
  } catch (e) {
    out.destroy()
    await rm(part, { force: true })
    throw e
  }
}

// Make sure every file of the model is on disk; reports progress as a percent of the bytes still needed.
// Safe to call repeatedly: a running download for the same model is shared, and finished files are skipped.
export function ensure(model: string, report: (s: VoiceStatus) => void): Promise<void> {
  if (running && runningModel === model) return running
  runningModel = model
  running = (async () => {
    const missing: { url: string; file: string }[] = []
    for (const f of FILES) {
      const url = urlOf(model, f)
      const file = fileFor(url)!
      if (!(await stat(file).catch(() => null))) missing.push({ url, file })
    }
    if (!missing.length) return report({ state: 'ready', percent: 100, model })
    log('voice', `downloading ${model}: ${missing.length} files`)
    const t0 = Date.now()
    // Sizes come from HEAD-like probes so the percent is honest; unknown sizes just count as done when finished.
    const sizes = await Promise.all(missing.map((m) => sizeOf(m.url)))
    const total = sizes.reduce((a, b) => a + b, 0) || 1
    let got = 0
    let last = -1
    report({ state: 'downloading', percent: 0, model })
    for (const m of missing)
      await download(m.url, m.file, (n) => {
        got += n
        const p = Math.min(99, Math.floor((got / total) * 100))
        if (p !== last) (last = p), report({ state: 'downloading', percent: p, model })
      })
    log('voice', `downloaded ${model} (${(got / 1e6).toFixed(0)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    report({ state: 'ready', percent: 100, model })
  })()
    .catch((e) => {
      log('voice', 'download failed:', e)
      report({ state: 'error', percent: 0, model, error: `Couldn't download the voice model: ${(e as Error).message}. Pengu will retry on the next start, or press Retry.` })
    })
    .finally(() => (running = null))
  return running
}

// ---------- the writing assistant and search models ----------

let assistantRun: Promise<void> | null = null

// Download the assistant's models (chat model + embeddings) before the app opens. Same checks as the voice model:
// SHA-256 from the Hub, temp file then rename, finished files skipped, and one shared run if called twice.
export function ensureAssistant(report: (s: AssistantStatus) => void): Promise<void> {
  if (assistantRun) return assistantRun
  assistantRun = (async () => {
    const missing: { url: string; file: string }[] = []
    for (const m of Object.values(ASSISTANT_MODELS))
      for (const f of m.files) {
        const url = urlOf(m.id, f)
        const file = fileFor(url)!
        if (!(await stat(file).catch(() => null))) missing.push({ url, file })
      }
    if (!missing.length) return report({ state: 'ready', percent: 100 })
    log('assistant', `downloading ${missing.length} files`)
    const t0 = Date.now()
    report({ state: 'downloading', percent: 0 })
    const sizes = await Promise.all(missing.map((m) => sizeOf(m.url)))
    const total = sizes.reduce((a, b) => a + b, 0) || 1
    let got = 0
    let last = -1
    for (const m of missing)
      await download(m.url, m.file, (n) => {
        got += n
        const p = Math.min(99, Math.floor((got / total) * 100))
        if (p !== last) (last = p), report({ state: 'downloading', percent: p })
      })
    log('assistant', `downloaded ${(got / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    report({ state: 'ready', percent: 100 })
  })()
    .catch((e) => {
      log('assistant', 'download failed:', e)
      report({ state: 'error', percent: 0, error: `Couldn't download the assistant models: ${(e as Error).message}.` })
    })
    .finally(() => (assistantRun = null))
  return assistantRun
}
