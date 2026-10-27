import { useEffect, useState } from 'react'
import { ACCENTS, setTeam, type Snapshot } from '../shared/model'

// Live app state for any window. Main pushes a fresh snapshot after every change, so components
// just render from it. There is no client cache to keep in step.
export function useSnapshot(): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  useEffect(() => {
    const apply = (s: Snapshot) => (setTeam(s.team), setSnap(s)) // names and assignee lists read the team through model.ts
    window.pengu.getState().then(apply)
    return window.pengu.onState(apply)
  }, [])
  // Accent goes on :root as one variable. CSS derives the dark-mode shade with color-mix,
  // so every preset and the OS accent stay readable on dark backgrounds without a second palette.
  useEffect(() => {
    if (!snap) return
    const accent = ACCENTS[snap.settings.accent] || snap.systemAccent
    document.documentElement.style.setProperty('--accent', accent)
  }, [snap?.settings.accent, snap?.systemAccent])
  return snap
}

export const newId = () => crypto.randomUUID()
