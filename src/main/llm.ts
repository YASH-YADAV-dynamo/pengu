import type { AiResult } from './ai'
import { ASSISTANT_MODELS, nameOf, teamIds } from '../shared/model'
import { transformers } from './hf'
import { log } from './log'

// The built-in assistant: open-source models running on this computer (transformers.js on ONNX Runtime, no network
// and no API key). Used when Claude Code isn't connected. A small model can't be trusted to rewrite a whole
// document, so the work is split the way a RAG pipeline does it:
//   1. embeddings (MiniLM) find the section of the open page the request is about,
//   2. the chat model rewrites only that section,
//   3. a plain-code check keeps every existing line unless the request asked to remove or change something.
// The page then shows the result as a green/red diff, so a bad suggestion is one click from rejected.

type Pipe = (input: unknown, opts?: Record<string, unknown>) => Promise<unknown>
interface Engine { gen: Pipe; embed: Pipe; stop: { interrupt(): void; reset(): void } }

let engine: Promise<Engine> | null = null

async function load(): Promise<Engine> {
  const t = await transformers()
  const t0 = Date.now()
  const [gen, embed] = await Promise.all([
    t.pipeline('text-generation', ASSISTANT_MODELS.llm.id, { dtype: ASSISTANT_MODELS.llm.dtype, device: 'cpu' }),
    t.pipeline('feature-extraction', ASSISTANT_MODELS.embed.id, { dtype: ASSISTANT_MODELS.embed.dtype, device: 'cpu' })
  ])
  log('assistant', `models loaded in ${Date.now() - t0}ms`)
  return { gen: gen as unknown as Pipe, embed: embed as unknown as Pipe, stop: new t.InterruptableStoppingCriteria() }
}
const getEngine = () => (engine ??= load().catch((e) => ((engine = null), Promise.reject(e))))

export const warm = () => void getEngine().catch((e) => log('assistant', 'could not load models:', e))
export const cancel = () => void engine?.then((e) => e.stop.interrupt()).catch(() => {})

// ---------- steps ----------

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0) // vectors are normalized

async function vectors(e: Engine, texts: string[]): Promise<number[][]> {
  const out = (await e.embed(texts, { pooling: 'mean', normalize: true })) as { tolist(): number[][] }
  return out.tolist()
}

export interface Part { heading: string; body: string }
// The page sends the open discussion as text with "## Heading" lines; split it into its sections.
export function parts(doc: string): Part[] {
  const out: Part[] = []
  let cur: Part | null = null
  for (const line of doc.split('\n')) {
    const h = line.match(/^#{1,2}\s+(.*)$/)
    if (h) out.push((cur = { heading: h[1].trim(), body: '' }))
    else if (cur) cur.body += (cur.body ? '\n' : '') + line
  }
  return out.map((p) => ({ ...p, body: p.body.trim() }))
}

// The section the request is about: a heading named in the request wins; otherwise the closest by meaning.
async function pick(e: Engine, instruction: string, secs: Part[]): Promise<Part> {
  const said = instruction.toLowerCase()
  const named = secs.find((s) => s.heading.length > 3 && said.includes(s.heading.toLowerCase()))
  if (named) return named
  const [q, ...rest] = await vectors(e, [instruction, ...secs.map((s) => `${s.heading}. ${s.body}`.slice(0, 600))])
  return secs.map((s, i) => ({ s, score: cosine(q, rest[i]) })).sort((a, b) => b.score - a.score)[0].s
}

const SYSTEM = `You edit one section of a team's document. You get the CURRENT section and an INSTRUCTION.
Output the complete UPDATED section as "- " bullets: keep every existing bullet unless the instruction removes or changes it, add the new points, fix grammar and obvious speech-to-text mistakes. Do not invent facts. Output only the bullets.`
const SHOTS = [
  { role: 'user', content: 'CURRENT:\n- Users like badges\n\nINSTRUCTION: add that we should try push reminders' },
  { role: 'assistant', content: '- Users like badges\n- Try push reminders' },
  { role: 'user', content: 'CURRENT:\n- Pricing is 5 dollars\n- Launch in March\n\nINSTRUCTION: change the launch to April and remove pricing' },
  { role: 'assistant', content: '- Launch in April' }
]

const lines = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean)
const words = (l: string) => new Set(l.toLowerCase().replace(/^(?:[-*•]|\d+[.)])\s*/, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean))
const similar = (a: string, b: string) => {
  const x = words(a)
  const y = words(b)
  const both = [...x].filter((w) => y.has(w)).length
  return both / Math.max(1, Math.min(x.size, y.size)) >= 0.8
}
const REMOVES = /\b(remove|delete|drop|replace|change|rename|instead|rewrite|shorten|fix|correct|no longer)\b/i

// Keep what was already written unless the request says to remove or change it; the small model sometimes forgets
// lines. Existing lines stay exactly as they were, and only lines that say something new are added after them.
export function guard(current: string, generated: string, instruction: string): string {
  const next = lines(generated)
  if (REMOVES.test(instruction)) return next.length ? next.join('\n') : current
  const old = lines(current)
  return [...old, ...next.filter((l) => !old.some((o) => similar(o, l)))].join('\n')
}

// Adding is the job a small model does well: turn the request into clean bullets. The existing lines are never
// sent through the model, so nothing already written can be lost.
const ADD_SYSTEM = `You turn a short, rough request into 1 to 3 clear bullet points for a team document, in the same language. Fix grammar and speech-to-text mistakes. Do not invent facts. Output only the bullets, each starting with "- ".`
const ADD_SHOTS = [
  { role: 'user', content: 'add that duolingo also has leaderboards and we should test push reminders' },
  { role: 'assistant', content: '- Duolingo also has leaderboards\n- Test push reminders' },
  { role: 'user', content: 'we decided weekly digest emails, ana writes the copy' },
  { role: 'assistant', content: '- Decision: send weekly digest emails\n- Ana writes the copy' }
]
const CHAT = async (e: Engine, messages: unknown[], max: number) => {
  e.stop.reset()
  const out = (await e.gen(messages, { max_new_tokens: max, do_sample: false, stopping_criteria: e.stop })) as { generated_text: { content: string }[] }[]
  return out[0].generated_text.at(-1)!.content
}
// The small model sometimes just echoes the request. Then fall back to plain rules: drop "add that", split at
// "and we/also/…" into separate points, capitalise.
export function tidyRequest(instruction: string): string {
  const names = teamIds().map(nameOf).map((n) => n.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).join('|')
  return instruction
    .trim()
    .replace(/^(please\s+)?(can you\s+)?(add|note|write|mention|put)(\s+down)?(\s+a\s+note)?(\s+that)?\s+/i, '')
    .replace(/[.!]+$/, '')
    .split(new RegExp(`\\s*(?:,\\s*(?:and\\s+)?|\\s+and\\s+)(?=(?:we|they|let'?s|it${names ? `|${names}` : ''})\\s)`, 'i'))
    .map((p) => p.replace(/^and\s+/i, '').trim())
    .filter(Boolean)
    .map((p) => `- ${p[0].toUpperCase()}${p.slice(1)}`)
    .join('\n')
}
async function addBullets(e: Engine, instruction: string) {
  const out = await CHAT(e, [{ role: 'system', content: ADD_SYSTEM }, ...ADD_SHOTS, { role: 'user', content: instruction }], 160)
  const echoed = lines(out).length <= 1 && similar(out, instruction)
  return echoed ? tidyRequest(instruction) : out
}
const rewrite = (e: Engine, current: string, instruction: string) =>
  CHAT(e, [{ role: 'system', content: SYSTEM }, ...SHOTS, { role: 'user', content: `CURRENT:\n${current.trim() || '(empty)'}\n\nINSTRUCTION: ${instruction}` }], 400)

// One section's new text: removing or changing goes through the rewrite (checked by guard); adding only appends.
async function revise(e: Engine, current: string, instruction: string) {
  if (REMOVES.test(instruction)) return guard(current, await rewrite(e, current, instruction), instruction)
  return guard(current, [current, await addBullets(e, instruction)].join('\n'), instruction)
}

// The answer for an open discussion (a section) or note (the whole body); null when this assistant can't help.
export async function edit(instruction: string, ctx: { kind?: string; doc?: string; body?: string }): Promise<Pick<AiResult, 'sections' | 'body' | 'reply'> | null> {
  const e = await getEngine()
  const t0 = Date.now()
  if (ctx.kind === 'discussions' && ctx.doc) {
    const secs = parts(ctx.doc)
    if (!secs.length) return null
    const sec = await pick(e, instruction, secs)
    const text = await revise(e, sec.body, instruction)
    log('assistant', `edited "${sec.heading}" in ${Date.now() - t0}ms`)
    return { sections: [{ heading: sec.heading, markdown: text }], reply: `Suggested changes to ${sec.heading}.` }
  }
  if (ctx.kind === 'notes' && typeof ctx.body === 'string') {
    const text = await revise(e, ctx.body, instruction)
    log('assistant', `edited note in ${Date.now() - t0}ms`)
    return { sections: [], body: text, reply: 'Suggested changes to the note.' }
  }
  return null
}
