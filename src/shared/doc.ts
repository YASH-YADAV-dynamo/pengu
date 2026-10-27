// A discussion is one document (HTML from the editor), not five boxes. The five topics start as headings with
// hints under them, and the user can rename, reorder or delete them like any other heading.
// These helpers are plain string work (no DOM), so main and the page share them.
import { STEPS } from './model'

export const CONCLUSION = 'Conclusion'
// Hint shown under an empty heading in the editor, looked up by the heading's text.
export const SECTION_HINTS: Record<string, string> = {
  ...Object.fromEntries(STEPS.map((s) => [s.label.toLowerCase(), s.hint])),
  [CONCLUSION.toLowerCase()]: 'What we decided, and what happens next'
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const decode = (s: string) =>
  s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const normHeading = (s: string) => decode(s.replace(/<[^>]+>/g, '')).trim().toLowerCase().replace(/^\d+\.\s*/, '')

// The starting document: each topic as a heading over an empty paragraph, where the hint shows.
export const newDiscussionDoc = () => [...STEPS.map((s) => s.label), CONCLUSION].map((h) => `<h2>${h}</h2><p></p>`).join('')

// Small markdown → HTML for what the assistant writes: headings, bullet and numbered lists, images, bold/italic/code.
// Text is escaped first, so the assistant can never inject markup.
function inline(s: string) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}
export function mdToHtml(md: string): string {
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const close = () => list && (out.push(`</${list}>`), (list = null))
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trim()
    const img = line.match(/^!\[([^\]]*)\]\((pengu-img:\/\/[\w.]+)\)$/)
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    const ul = line.match(/^(?:[-*•]|- \[[ x]\])\s+(.*)$/)
    const ol = line.match(/^\d+[.)]\s+(.*)$/)
    if (!line) close()
    else if (img) (close(), out.push(`<img src="${img[2]}" alt="${escapeHtml(img[1])}">`))
    else if (h) {
      // Sections are h2, so markdown headings inside a section nest one level below (h3 at most).
      const level = Math.min(h[1].length + 1, 3)
      close()
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
    }
    else if (ul || ol) {
      const kind = ul ? 'ul' : 'ol'
      if (list !== kind) (close(), out.push(`<${kind}>`), (list = kind))
      out.push(`<li><p>${inline((ul ?? ol)![1])}</p></li>`)
    } else (close(), out.push(`<p>${inline(line)}</p>`))
  }
  close()
  return out.join('')
}

// HTML → readable text with markdown-ish structure. Used for [[link]]/#tag scanning and as the assistant's context.
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<h([1-6])[^>]*>/g, (_m, l) => `\n${'#'.repeat(Number(l))} `)
      .replace(/<\/h[1-6]>/g, '\n')
      .replace(/<li[^>]*>/g, '\n- ')
      .replace(/<img[^>]*src="([^"]*)"[^>]*>/g, '\n![image]($1)\n')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/(p|ul|ol|blockquote|pre)>/g, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n- \n/g, '\n- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Run fn over the text between tags only, so rename and "Link mention" never touch an attribute or a tag.
export const mapHtmlText = (html: string, fn: (t: string) => string) =>
  html.split(/(<[^>]+>)/).map((p) => (p.startsWith('<') ? p : fn(p))).join('')

// Replace (or append to) the body under a heading; a heading that isn't there yet is added at the end.
export type Section = { heading: string; markdown: string; append?: boolean }
export function applySections(html: string, sections: Section[]): string {
  // Sections are split at h1/h2 only, so subheadings (h3) stay inside the section they belong to.
  const parts = (html || '').split(/(<h[12][^>]*>[\s\S]*?<\/h[12]>)/)
  for (const sec of sections) {
    const want = normHeading(sec.heading)
    const body = mdToHtml(sec.markdown)
    const i = parts.findIndex((p, j) => j % 2 === 1 && normHeading(p) === want)
    if (i < 0) parts.push(`<h2>${escapeHtml(sec.heading.trim())}</h2>`, body)
    else parts[i + 1] = sec.append ? (parts[i + 1] ?? '').replace(/<p><\/p>/g, '') + body : body || '<p></p>'
  }
  return parts.join('')
}

// Old discussions kept five separate fields; turn them into one document with the same headings.
export function docFromSteps(steps: Record<string, string> | undefined, conclusion: string | undefined) {
  return [...STEPS.map((s) => [s.label, steps?.[s.key] ?? ''] as const), [CONCLUSION, conclusion ?? ''] as const]
    .map(([h, body]) => `<h2>${h}</h2>${body.trim() ? mdToHtml(body) : '<p></p>'}`)
    .join('')
}

// The text of one section (what sits under a heading), as markdown-ish text, for showing a before/after.
export function sectionText(html: string, heading: string): string {
  const parts = (html || '').split(/(<h[12][^>]*>[\s\S]*?<\/h[12]>)/)
  const want = normHeading(heading)
  const i = parts.findIndex((p, j) => j % 2 === 1 && normHeading(p) === want)
  return i < 0 ? '' : htmlToText(parts[i + 1] ?? '')
}
