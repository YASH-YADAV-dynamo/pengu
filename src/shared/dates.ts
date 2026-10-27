// Dates and times found in plain words ("tomorrow", "by Friday", "at 5pm"), shared by the offline assistant and the voice modal.

const DAY = 86_400_000
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// "today", "tomorrow", "by Friday", "next week", "on 20 Oct", "2026-10-20" → YYYY-MM-DD (local time).
export function findDate(text: string, now = new Date()): string | null {
  const t = text.toLowerCase()
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (iso) return iso[1]
  if (/\btoday\b|\btonight\b|\beod\b/.test(t)) return ymd(now)
  if (/\btomorrow\b/.test(t)) return ymd(new Date(now.getTime() + DAY))
  if (/\bnext week\b/.test(t)) return ymd(new Date(now.getTime() + 7 * DAY))
  const wd = t.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/)
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2])
    let diff = (target - now.getDay() + 7) % 7 || 7
    // "next Friday" skips this week's Friday only when that Friday is still ahead in the current week (Mon–Sun).
    const monIdx = (d: number) => (d + 6) % 7
    if (wd[1] && monIdx(target) > monIdx(now.getDay())) diff += 7
    return ymd(new Date(now.getTime() + diff * DAY))
  }
  const dm = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/) ?? t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/)
  if (dm) {
    const [day, mon] = /\d/.test(dm[1]) ? [Number(dm[1]), dm[2]] : [Number(dm[2]), dm[1]]
    const d = new Date(now.getFullYear(), MONTHS.indexOf(mon), day)
    if (d.getTime() < now.getTime() - DAY) d.setFullYear(d.getFullYear() + 1)
    return ymd(d)
  }
  return null
}

// "at 5pm", "at 17:30" on the date found (or today) → ISO timestamp, for a discussion's meet time.
export function findMeet(text: string, now = new Date()) {
  const m = text.toLowerCase().match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
  if (!m || (!m[3] && !m[2])) return null
  let h = Number(m[1]) % 12
  if (m[3] === 'pm' || (!m[3] && Number(m[1]) >= 12)) h += 12
  if (!m[3] && Number(m[1]) === 12) h = 12
  const day = findDate(text, now) ?? ymd(now)
  const [y, mo, d] = day.split('-').map(Number)
  return new Date(y, mo - 1, d, h, Number(m[2] ?? 0)).toISOString()
}

