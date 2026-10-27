// Pengu, the mascot: an original inline SVG, so there's no image licensing, it stays sharp at any DPI,
// and it's themeable with CSS. Moods are just a class on the root; every animation is a CSS transform
// or opacity change, which the GPU compositor runs without waking React or the main thread.

export type Mood = 'idle' | 'alert' | 'sleep' | 'happy'

export function Penguin({ mood, size = 44 }: { mood: Mood; size?: number }) {
  return (
    <svg className={`pg pg-${mood}`} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={`Pengu is ${mood}`}>
      {/* Feet stay on the ground while the body bobs, which sells the "standing" look. */}
      <ellipse className="pg-foot" cx="24" cy="60" rx="6" ry="3" />
      <ellipse className="pg-foot" cx="40" cy="60" rx="6" ry="3" />
      <g className="pg-body">
        <path className="pg-flip pg-flip-l" d="M14 34 C6 40 6 50 12 52 C14 46 16 40 17 36 Z" />
        <path className="pg-flip pg-flip-r" d="M50 34 C58 40 58 50 52 52 C50 46 48 40 47 36 Z" />
        <ellipse className="pg-coat" cx="32" cy="36" rx="19" ry="23" />
        {/* Face mask (two overlapping circles) plus belly: the classic penguin read at 40px. */}
        <circle className="pg-belly" cx="26.5" cy="27" r="8.5" />
        <circle className="pg-belly" cx="37.5" cy="27" r="8.5" />
        <ellipse className="pg-belly" cx="32" cy="43" rx="13" ry="14" />
        <g className="pg-eyes">
          <circle cx="27" cy="27" r="2.8" className="pg-pupil" />
          <circle cx="37" cy="27" r="2.8" className="pg-pupil" />
          <circle cx="28" cy="26" r="0.9" className="pg-shine" />
          <circle cx="38" cy="26" r="0.9" className="pg-shine" />
        </g>
        {/* Closed eyes, shown only while sleeping. */}
        <path className="pg-closed" d="M24 28 Q27 30 30 28 M34 28 Q37 30 40 28" />
        <ellipse className="pg-cheek" cx="22.5" cy="32" rx="2.6" ry="1.6" />
        <ellipse className="pg-cheek" cx="41.5" cy="32" rx="2.6" ry="1.6" />
        <path className="pg-beak" d="M28.5 31.5 Q32 30 35.5 31.5 Q32 36 28.5 31.5 Z" />
      </g>
      {/* Mood props: "!" when something needs you, "z" while all is clear, sparkles on a win. */}
      <text className="pg-bang" x="54" y="14">!</text>
      <text className="pg-z" x="48" y="16">z</text>
      <g className="pg-spark">
        <path d="M8 10 l1.5 3 3 1.5 -3 1.5 -1.5 3 -1.5 -3 -3 -1.5 3 -1.5 Z" />
        <path d="M54 6 l1 2 2 1 -2 1 -1 2 -1 -2 -2 -1 2 -1 Z" />
      </g>
    </svg>
  )
}
