// Word-level diff for the "Pengu suggests" review: what stays, what is added (green) and what goes (red).
// Plain LCS over words and whitespace; texts here are a section or a note, so the table stays small.
export type Piece = { kind: 'same' | 'add' | 'del'; text: string }

const MAX_TOKENS = 3000 // beyond this a full LCS table is too big; show the whole old text struck out and the new text added

const tokens = (s: string) => s.split(/(\s+)/).filter((t) => t !== '')

export function wordDiff(before: string, after: string): Piece[] {
  const a = tokens(before)
  const b = tokens(after)
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return [...(before.trim() ? [{ kind: 'del' as const, text: before }] : []), ...(after.trim() ? [{ kind: 'add' as const, text: after }] : [])]
  }
  const w = b.length + 1
  const t = new Uint16Array((a.length + 1) * w) // t[i*w+j] = LCS length of a[i..] and b[j..]
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
  const out: Piece[] = []
  const push = (kind: Piece['kind'], text: string) => {
    const last = out.at(-1)
    if (last?.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) (push('same', a[i]), i++, j++)
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) push('del', a[i++])
    else push('add', b[j++])
  }
  while (i < a.length) push('del', a[i++])
  while (j < b.length) push('add', b[j++])
  return out
}
