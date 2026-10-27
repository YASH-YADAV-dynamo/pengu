import { useEffect, useRef, useState } from 'react'
import type { VoiceLanguage, VoiceModel } from '../../shared/model'

// Push-to-talk: click the mic to record, click again (or wait for the 5 min cap) and the words come back as text.
// Recording and resampling happen here; Whisper runs in the main process (see main/voice.ts), which also
// downloads the model at startup.

export type VoiceState = 'idle' | 'starting' | 'recording' | 'working'
const MAX_MS = 5 * 60_000 // long enough to dictate a meeting recap
const log = (msg: string) => window.pengu.log('voice', msg)

// Load the model into memory ahead of time, so the first transcription doesn't wait for it.
let warmed = ''
export function warm(model: VoiceModel) {
  if (warmed === model) return
  warmed = model
  void window.pengu.voiceWarm()
}

// Whisper hears "Thank you." or "[Music]" in silence; those come back as an empty result instead.
const NOISE = /^(\[.*\]|\(.*\)|thank you\.?|thanks for watching!?|you\.?|bye\.?)$/i

// An AudioContext running at 16 kHz decodes and resamples the recording to the mono 16 kHz PCM Whisper expects.
async function toPcm(blob: Blob) {
  const ctx = new AudioContext({ sampleRate: 16_000 })
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer())
    return audio.getChannelData(0).slice()
  } finally {
    void ctx.close()
  }
}
const rms = (pcm: Float32Array) => Math.sqrt(pcm.reduce((a, x) => a + x * x, 0) / Math.max(pcm.length, 1))

const transcribe = (audio: Float32Array) => window.pengu.voiceTranscribe(audio)

// Plain-language reasons for the errors getUserMedia actually throws.
function micError(e: unknown) {
  const name = (e as DOMException)?.name
  if (name === 'NotAllowedError') return window.pengu.platform === 'darwin'
    ? 'Microphone blocked. Allow Pengu in System Settings → Privacy & Security → Microphone.'
    : 'Microphone blocked. Turn on Windows Settings → Privacy & security → Microphone → "Let desktop apps access your microphone".'
  if (name === 'NotFoundError') return 'No microphone found. Plug one in or pick an input device in your system sound settings.'
  if (name === 'NotReadableError') return 'The microphone is busy in another app. Close it there and try again.'
  return `Can't use the microphone: ${(e as Error)?.message ?? e}`
}

export function useVoice(opts: { model: VoiceModel; language: VoiceLanguage; enabled: boolean; onText: (text: string) => void }) {
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0) // 0..1 loudness while recording, drives the little bars
  const rec = useRef<MediaRecorder | null>(null)
  const latest = useRef(opts)
  latest.current = opts

  useEffect(() => {
    if (state !== 'recording') return setSeconds(0)
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [state])

  const start = async () => {
    setError('')
    if (!opts.enabled) return setError('Voice is off. Turn it on in Settings → Voice.')
    setState('starting')
    log('start')
    if (!(await window.pengu.micAsk())) return setState('idle'), setError(micError({ name: 'NotAllowedError' }))
    warm(opts.model) // loads from disk while you talk
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      const r = new MediaRecorder(stream)
      // Live loudness for the listening animation. Read only; the recording itself is untouched.
      const meter = new AudioContext()
      const analyser = meter.createAnalyser()
      analyser.fftSize = 256
      meter.createMediaStreamSource(stream).connect(analyser)
      const buf = new Uint8Array(analyser.fftSize)
      const tick = setInterval(() => {
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (const b of buf) sum += ((b - 128) / 128) ** 2
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4))
      }, 70)
      const chunks: Blob[] = []
      const t0 = Date.now()
      const cap = setTimeout(() => r.state === 'recording' && r.stop(), MAX_MS)
      r.ondataavailable = (e) => chunks.push(e.data)
      r.onstop = async () => {
        clearTimeout(cap)
        clearInterval(tick)
        void meter.close()
        setLevel(0)
        stream.getTracks().forEach((t) => t.stop()) // release the mic so the OS indicator turns off
        rec.current = null
        setState('working')
        try {
          const pcm = await toPcm(new Blob(chunks, { type: r.mimeType }))
          const level = rms(pcm)
          log(`recorded ${((Date.now() - t0) / 1000).toFixed(1)}s, level ${level.toFixed(4)}`)
          if (level < 0.002) throw new Error("I couldn't hear anything. Check that the right microphone is selected and not muted.")
          const text = (await transcribe(pcm)).trim()
          if (text && !NOISE.test(text)) latest.current.onText(text)
          else setError("Didn't catch that. Try again, a little closer to the mic.")
        } catch (e) {
          setError((e as Error).message)
        } finally {
          setState('idle')
        }
      }
      r.start(1000)
      rec.current = r
      setState('recording')
    } catch (e) {
      log(`mic failed: ${(e as DOMException)?.name ?? ''} ${(e as Error)?.message ?? e}`)
      setState('idle')
      setError(micError(e))
    }
  }

  const toggle = () => (state === 'recording' ? rec.current?.stop() : state === 'idle' ? void start() : undefined)
  return { state, error, seconds, level, toggle, clearError: () => setError('') }
}
