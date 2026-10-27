import type { VoiceLanguage } from '../shared/model'
import { transformers } from './hf'
import { log } from './log'

// Speech-to-text on this computer: Whisper (open source) on ONNX Runtime's native engine, in the main process.
// That is several times faster than the old in-page WASM worker and uses every CPU core. The page records and
// resamples to 16 kHz mono; audio goes over IPC to here and is never written to disk or sent anywhere.

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>
let asr: Promise<Asr> | null = null
let loaded = ''

export function warm(model: string) {
  if (asr && loaded === model) return asr
  loaded = model
  const t0 = Date.now()
  asr = transformers()
    .then((t) => t.pipeline('automatic-speech-recognition', model, { dtype: 'q8', device: 'cpu' }) as unknown as Promise<Asr>)
    .then((p) => (log('voice', `${model} loaded in ${Date.now() - t0}ms`), p))
  asr.catch((e) => ((asr = null), log('voice', 'model failed to load:', e)))
  return asr
}

// Whisper is told the language when it's English: that skips detection and is noticeably more accurate.
// "translate" outputs English from any language (Hindi or Hinglish in, English out).
export async function transcribe(model: string, audio: Float32Array, language: VoiceLanguage): Promise<string> {
  const run = await warm(model)
  const t0 = Date.now()
  const lang = language === 'english' && !model.endsWith('.en') ? { language: 'english', task: 'transcribe' } : language === 'translate' ? { task: 'translate' } : { task: 'transcribe' }
  const out = await run(audio, { chunk_length_s: 30, stride_length_s: 5, ...lang })
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim()
  log('voice', `transcribed ${text.length} chars from ${(audio.length / 16_000).toFixed(1)}s of audio in ${Date.now() - t0}ms`)
  return text
}
