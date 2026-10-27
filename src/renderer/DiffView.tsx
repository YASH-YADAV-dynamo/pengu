import { wordDiff } from '../shared/diff'

// "Pengu suggests": the assistant's edit shown in place of the page, like a code copilot's inline diff.
// Added words are light green, removed words red and struck through. Accept or reject each change, or all at once;
// an accepted change goes into the draft (still editable, still needs Save), a rejected one is dropped.
export interface Change { key: string; label: string; before: string; after: string }

const tidy = (t: string) => t.replace(/\n{2,}/g, '\n').trim() // lists come out of the editor with blank lines between items

export function DiffView({ changes, extra, onAccept, onReject, onAcceptAll, onRejectAll }: {
  changes: Change[]
  extra: string[] // other things the answer would create (tickets, notes), applied with the first accepted change
  onAccept: (key: string) => void
  onReject: (key: string) => void
  onAcceptAll: () => void
  onRejectAll: () => void
}) {
  return (
    <div className="diff">
      <div className="diff-bar">
        <span className="ask-spark">✦</span>
        <strong>Pengu suggests {changes.length} change{changes.length === 1 ? '' : 's'}</strong>
        <span className="grow" />
        <button className="btn" onClick={onRejectAll}>Reject all</button>
        <button className="btn primary" onClick={onAcceptAll}>Accept all</button>
      </div>
      {extra.length > 0 && <ul className="diff-extra">{extra.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      {changes.map((c) => (
        <section key={c.key} className="diff-item">
          <header>
            <h2>{c.label}</h2>
            <span className="grow" />
            <button className="btn subtle" onClick={() => onReject(c.key)}>Reject</button>
            <button className="btn" onClick={() => onAccept(c.key)}>Accept</button>
          </header>
          <div className="diff-text">
            {wordDiff(tidy(c.before), tidy(c.after)).map((p, i) => (p.kind === 'same' ? <span key={i}>{p.text}</span> : p.kind === 'add' ? <ins key={i}>{p.text}</ins> : <del key={i}>{p.text}</del>))}
          </div>
        </section>
      ))}
    </div>
  )
}
