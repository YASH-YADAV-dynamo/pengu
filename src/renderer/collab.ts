import * as Y from 'yjs'

// Live editing of one document with the other person. A Yjs document holds the text; its changes are sent to the
// server as small binary updates and the other person's are fetched about every second and a half. Yjs merges them
// in any order, so two people typing at once both keep their words. Needs Team sync sign-in (main does the network).

const POLL_MS = 1500
const SEND_MS = 250 // batch keystrokes into one request
const BATCH = 60 // updates per request; the server accepts up to 64

const b64 = (u: Uint8Array) => {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export interface Collab {
  ydoc: Y.Doc
  onStatus: (fn: (online: boolean) => void) => void
  destroy: () => void
}

// Connect to the document. If nobody has edited it together yet, `seed()` supplies the text to start from; when two
// people open it at the same moment the server keeps the first seed and gives it to both.
// Rejects when the server can't be reached, so the caller can fall back to the ordinary editor.
export async function openCollab(docId: string, seed: () => Uint8Array): Promise<Collab> {
  const ydoc = new Y.Doc()
  let last = 0
  let queue: Uint8Array[] = []
  let busy: Promise<void> | null = null
  let again = false
  let dead = false
  let online = true
  let listener: (online: boolean) => void = () => {}
  const setOnline = (v: boolean) => v !== online && ((online = v), listener(v))

  // One request: our updates (and optionally the seed) out, everything new in.
  async function round(out: Uint8Array[], first?: Uint8Array): Promise<number> {
    let received = 0
    const batches: Uint8Array[][] = []
    for (let i = 0; i < out.length; i += BATCH) batches.push(out.slice(i, i + BATCH))
    if (!batches.length) batches.push([])
    for (const [i, batch] of batches.entries()) {
      let r = await window.pengu.collabExchange(docId, last, batch.map(b64), i === 0 && first ? b64(first) : undefined)
      for (;;) {
        Y.transact(ydoc, () => r.updates.forEach((u) => Y.applyUpdate(ydoc, unb64(u.update))), 'remote')
        received += r.updates.length
        last = r.last
        if (!r.more) break
        r = await window.pengu.collabExchange(docId, last, [])
      }
    }
    return received
  }

  // Never two requests at once; a change made meanwhile is sent right after.
  const run = (): Promise<void> => {
    if (busy) return (again = true), busy
    const out = queue.length ? [Y.mergeUpdates(queue)] : []
    queue = []
    busy = round(out)
      .then(() => setOnline(true))
      .catch(() => {
        queue = [...out, ...queue] // keep what we couldn't send
        setOnline(false)
      })
      .then(() => {
        busy = null
        if (again && !dead) ((again = false), void run())
      })
    return busy
  }

  // First contact: fetch what exists; if nothing, offer our text as the first version and take whatever wins.
  if ((await round([])) === 0 && last === 0) await round([], seed())

  ydoc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'remote' || dead) return
    queue.push(u)
    clearTimeout(sendTimer)
    sendTimer = setTimeout(() => void run(), SEND_MS)
  })
  let sendTimer: ReturnType<typeof setTimeout> | undefined
  const poll = setInterval(() => !dead && void run(), POLL_MS)

  return {
    ydoc,
    onStatus: (fn) => (listener = fn),
    destroy: () => {
      dead = true
      clearInterval(poll)
      clearTimeout(sendTimer)
      if (queue.length) void window.pengu.collabExchange(docId, last, [b64(Y.mergeUpdates(queue))]).catch(() => {}) // last words
      ydoc.destroy()
    }
  }
}
