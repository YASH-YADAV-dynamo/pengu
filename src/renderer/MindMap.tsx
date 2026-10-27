import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent } from 'react'
import rough from 'roughjs'
import type { Options } from 'roughjs/bin/core'
import { useLocation } from 'wouter'
import { buildGraph, type GraphEdge, type GraphNode, type NodeKind } from '../shared/links'
import type { Note, Snapshot } from '../shared/model'
import { newId } from './useSnapshot'

// One map of the whole workspace, drawn hand-sketched like Excalidraw. It builds itself from the data:
// tickets hang off their discussion, roadmaps off their discussions, and [[links]], #tags and plain-text
// mentions of a title connect everything else, the way Obsidian's graph view does. Nothing to arrange by hand.

const gen = rough.generator()
const MAX_LABEL = 26
const label = (n: GraphNode) => (n.label.length > MAX_LABEL ? n.label.slice(0, MAX_LABEL - 1) + '…' : n.label)

function size(n: GraphNode) {
  const w = label(n).length * 7.2
  if (n.kind === 'tag' || n.kind === 'ghost') return { w: Math.max(w + 18, 48), h: 26 }
  if (n.kind === 'roadmaps') return { w: Math.max(w + 56, 120), h: 60 }
  if (n.kind === 'notes') return { w: Math.max(w + 40, 100), h: 46 }
  return { w: Math.max(w + 28, 90), h: 40 }
}

// Fill colors are CSS variables (set per theme in styles.css), so the map follows light and dark mode.
function color(n: GraphNode) {
  if (n.kind === 'discussions') return `var(--map-${n.sub ?? 'product'})`
  if (n.kind === 'tickets') return n.sub === 'done' ? 'var(--map-done)' : 'var(--map-ticket)'
  if (n.kind === 'notes') return 'var(--map-note)'
  if (n.kind === 'roadmaps') return 'var(--map-roadmap)'
  return 'transparent'
}

// Stable per-node randomness, so a node keeps the same wobble and start position across renders.
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261)

function shape(n: GraphNode, sketch: boolean) {
  const { w, h } = size(n)
  const o: Options = {
    seed: (hash(n.id) % 2 ** 31) + 1,
    roughness: sketch ? 1.3 : 0,
    bowing: sketch ? 1.2 : 0,
    stroke: 'var(--map-stroke)',
    strokeWidth: 1.4,
    fill: color(n),
    fillStyle: sketch ? 'hachure' : 'solid',
    hachureGap: 5,
    fillWeight: 1.2,
    ...(n.kind === 'ghost' ? { strokeLineDash: [5, 5], fill: undefined } : {}),
    ...(n.kind === 'tag' ? { stroke: 'var(--map-tag)', fill: undefined } : {})
  }
  const d =
    n.kind === 'notes' ? gen.ellipse(0, 0, w, h, o)
    : n.kind === 'roadmaps' ? gen.polygon([[0, -h / 2], [w / 2, 0], [0, h / 2], [-w / 2, 0]], o)
    : gen.rectangle(-w / 2, -h / 2, w, h, o)
  return gen.toPaths(d)
}

// A solid shape under the sketch, so edges don't show through the hachure and cross the label.
function Backing({ n }: { n: GraphNode }) {
  const { w, h } = size(n)
  if (n.kind === 'notes') return <ellipse className="backing" rx={w / 2} ry={h / 2} />
  if (n.kind === 'roadmaps') return <polygon className="backing" points={`0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0`} />
  return <rect className="backing" x={-w / 2} y={-h / 2} width={w} height={h} rx={n.kind === 'tag' || n.kind === 'ghost' ? 12 : 3} />
}

const EDGE_LEN: Record<GraphEdge['kind'], number> = { structure: 110, link: 140, tag: 90, mention: 170 }
type P = { x: number; y: number; vx: number; vy: number; pinned?: boolean }
type View = { x: number; y: number; k: number }
const KIND_LABEL: Partial<Record<NodeKind, string>> = { discussions: 'Discussions', tickets: 'Tickets', notes: 'Notes', roadmaps: 'Roadmaps', tag: 'Tags' }

export default function MindMap({ snap, focus: focusParam }: { snap: Snapshot; focus?: string }) {
  const [, nav] = useLocation()
  const graph = useMemo(() => buildGraph(snap), [snap])
  const svg = useRef<SVGSVGElement>(null)
  const pos = useRef(new Map<string, P>())
  const alpha = useRef(1)
  const shapes = useRef(new Map<string, ReturnType<typeof shape>>())
  const [, setFrame] = useState(0)
  const [settled, setSettled] = useState(false)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [hover, setHover] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<NodeKind>>(new Set())
  const [mentions, setMentions] = useState(true)
  const [sketch, setSketch] = useState(true)
  const [query, setQuery] = useState('')
  const focus = focusParam?.startsWith('tag-') ? `tag:${decodeURIComponent(focusParam.slice(4))}` : focusParam
  const [local, setLocal] = useState(!!focus)
  const fitted = useRef(false)

  // What's visible: kind filters, mention edges on or off, and in local mode only nodes within two hops of the focus.
  const { nodes, edges, neighbors } = useMemo(() => {
    let edges = graph.edges.filter((e) => mentions || e.kind !== 'mention')
    let nodes = graph.nodes.filter((n) => !hidden.has(n.kind === 'ghost' ? 'notes' : n.kind))
    if (local && focus && graph.nodes.some((n) => n.id === focus)) {
      const keep = new Set([focus])
      for (let hop = 0; hop < 2; hop++)
        for (const e of edges) if (keep.has(e.a) || keep.has(e.b)) (keep.add(e.a), keep.add(e.b))
      nodes = nodes.filter((n) => keep.has(n.id))
    }
    const ids = new Set(nodes.map((n) => n.id))
    edges = edges.filter((e) => ids.has(e.a) && ids.has(e.b))
    const neighbors = new Map<string, Set<string>>()
    for (const e of edges) {
      if (!neighbors.has(e.a)) neighbors.set(e.a, new Set())
      if (!neighbors.has(e.b)) neighbors.set(e.b, new Set())
      neighbors.get(e.a)!.add(e.b)
      neighbors.get(e.b)!.add(e.a)
    }
    return { nodes, edges, neighbors }
  }, [graph, hidden, mentions, local, focus])

  // Place new nodes next to a node they connect to (or on a spiral), drop removed ones, and reheat the layout.
  useEffect(() => {
    const p = pos.current
    const ids = new Set(nodes.map((n) => n.id))
    for (const id of [...p.keys()]) if (!ids.has(id)) p.delete(id)
    let added = 0
    nodes.forEach((n, i) => {
      if (p.has(n.id)) return
      added++
      const near = [...(neighbors.get(n.id) ?? [])].map((id) => p.get(id)).find(Boolean)
      const a = (hash(n.id) % 360) * (Math.PI / 180)
      const r = near ? 60 : 40 * Math.sqrt(i + 1)
      p.set(n.id, { x: (near?.x ?? 0) + Math.cos(a) * r, y: (near?.y ?? 0) + Math.sin(a) * r, vx: 0, vy: 0 })
    })
    alpha.current = Math.max(alpha.current, added ? 1 : 0.3)
    setSettled(false)
  }, [nodes, neighbors])

  // A small force layout: nodes push apart, edges pull to a length set by their kind, and a weak pull keeps
  // everything centered. It cools down and stops, so an idle map costs nothing.
  useEffect(() => {
    if (settled) return
    let raf = 0
    const step = () => {
      const p = pos.current
      const list = nodes.map((n) => ({ n, p: p.get(n.id)!, r: size(n).w / 2 + 12 })).filter((x) => x.p)
      for (let t = 0; t < 3; t++) {
        const a = alpha.current
        for (let i = 0; i < list.length; i++)
          for (let j = i + 1; j < list.length; j++) {
            const A = list[i].p, B = list[j].p
            const dx = B.x - A.x || 0.01, dy = B.y - A.y || 0.01
            const d2 = dx * dx + dy * dy
            const d = Math.sqrt(d2)
            let f = (2200 * a) / Math.max(d2, 400)
            const overlap = list[i].r + list[j].r - d
            if (overlap > 0) f += overlap * 0.08 // separate overlapping boxes
            const fx = (dx / d) * f, fy = (dy / d) * f
            A.vx -= fx; A.vy -= fy; B.vx += fx; B.vy += fy
          }
        for (const e of edges) {
          const A = p.get(e.a), B = p.get(e.b)
          if (!A || !B) continue
          const dx = B.x - A.x, dy = B.y - A.y
          const d = Math.sqrt(dx * dx + dy * dy) || 1
          const k = (0.05 * a * (d - EDGE_LEN[e.kind])) / d
          A.vx += dx * k; A.vy += dy * k; B.vx -= dx * k; B.vy -= dy * k
        }
        for (const { p: q } of list) {
          q.vx -= q.x * 0.004 * a
          q.vy -= q.y * 0.004 * a
          if (q.pinned) (q.vx = 0), (q.vy = 0)
          q.x += q.vx *= 0.6
          q.y += q.vy *= 0.6
        }
        alpha.current *= 0.99
      }
      setFrame((f) => f + 1)
      if (alpha.current < 0.02) return setSettled(true)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [settled, nodes, edges])

  // Frame the whole map (or the focused node) once the first layout settles.
  const fit = () => {
    const el = svg.current
    const pts = nodes.map((n) => pos.current.get(n.id)).filter((p): p is P => !!p)
    if (!el || !pts.length) return
    const { width, height } = el.getBoundingClientRect()
    const f = focus && pos.current.get(focus)
    if (f && !local) return setView({ k: 1.2, x: width / 2 - f.x * 1.2, y: height / 2 - f.y * 1.2 })
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
    const [x0, x1, y0, y1] = [Math.min(...xs) - 140, Math.max(...xs) + 140, Math.min(...ys) - 60, Math.max(...ys) + 60]
    const k = Math.min(1.4, Math.max(0.2, Math.min(width / (x1 - x0), height / (y1 - y0))))
    setView({ k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k })
  }
  useEffect(() => {
    if (settled && !fitted.current) (fitted.current = true), fit()
  })
  useEffect(() => void (fitted.current = false), [focus, local])

  // ---------- pointer: pan the canvas, drag a node (it stays pinned), click a node to open it ----------
  const drag = useRef<{ id: string | null; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const down = (e: RPointerEvent, id: string | null) => {
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const p = id ? pos.current.get(id) : null
    drag.current = { id, sx: e.clientX, sy: e.clientY, ox: p ? p.x : view.x, oy: p ? p.y : view.y, moved: false }
  }
  const move = (e: RPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
    if (!d.moved) return
    if (!d.id) return setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }))
    const p = pos.current.get(d.id)!
    Object.assign(p, { x: d.ox + dx / view.k, y: d.oy + dy / view.k, pinned: true })
    alpha.current = Math.max(alpha.current, 0.3)
    setSettled(false)
    setFrame((f) => f + 1)
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved || !d.id) return
    void openNode(graph.nodes.find((n) => n.id === d.id)!)
  }
  const wheel = (e: WheelEvent) => {
    const r = svg.current!.getBoundingClientRect()
    const mx = e.clientX - r.left, my = e.clientY - r.top
    setView((v) => {
      const k = Math.min(3, Math.max(0.15, v.k * Math.exp(-e.deltaY * 0.0015)))
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k }
    })
  }

  // Open the item; a tag focuses the map on it; a [[link]] to nothing creates that note.
  const openNode = async (n: GraphNode) => {
    if (n.route) return nav(n.route)
    if (n.kind === 'tag') return nav(`/map/tag-${encodeURIComponent(n.label.slice(1))}`)
    const note: Note = { id: newId(), title: n.label, body: '', updatedAt: '', updatedBy: snap.settings.me, deletedAt: null }
    await window.pengu.upsert('notes', note)
    nav(`/notes/${note.id}`)
  }

  // Search jumps to the first match.
  const search = (q: string) => {
    setQuery(q)
    const hit = q.trim() && nodes.find((n) => n.label.toLowerCase().includes(q.trim().toLowerCase()))
    const p = hit && pos.current.get(hit.id)
    const r = svg.current?.getBoundingClientRect()
    if (hit && p && r) (setHover(hit.id), setView((v) => ({ ...v, x: r.width / 2 - p.x * v.k, y: r.height / 2 - p.y * v.k })))
  }

  const shapeOf = (n: GraphNode) => {
    const key = `${n.id}|${n.kind}|${n.sub}|${n.label}|${sketch}`
    if (!shapes.current.has(key)) shapes.current.set(key, shape(n, sketch))
    return shapes.current.get(key)!
  }
  // Rough edges once still (they're costly to redraw each frame); plain lines while the layout moves.
  const edgePath = (e: GraphEdge, A: P, B: P) => {
    if (!settled || !sketch) return [{ d: `M${A.x},${A.y}L${B.x},${B.y}` }]
    return gen.toPaths(gen.line(A.x, A.y, B.x, B.y, { seed: (hash(e.a + e.b) % 2 ** 31) + 1, roughness: 1, bowing: 2, stroke: 'x' }))
  }
  const lit = hover ? new Set([hover, ...(neighbors.get(hover) ?? [])]) : focus ? new Set([focus, ...(neighbors.get(focus) ?? [])]) : null

  return (
    <div className="map">
      <div className="map-tools">
        <input className="map-search" placeholder="Find on map…" value={query} onChange={(e) => search(e.target.value)} />
        {(Object.keys(KIND_LABEL) as NodeKind[]).map((k) => (
          <button key={k} className={`chip${hidden.has(k) ? '' : ' on'}`} onClick={() => setHidden((h) => (h.has(k) ? (h.delete(k), new Set(h)) : new Set(h.add(k))))}>
            <span className={`dot ${k}`} /> {KIND_LABEL[k]}
          </button>
        ))}
        <button className={`chip${mentions ? ' on' : ''}`} onClick={() => setMentions(!mentions)} title="Dashed lines: a title written in plain text, not yet a [[link]]">Mentions</button>
        {focus && <button className={`chip${local ? ' on' : ''}`} onClick={() => setLocal(!local)}>Local</button>}
        <span className="grow" />
        <button className="btn subtle" onClick={() => setSketch(!sketch)}>{sketch ? 'Clean' : 'Sketch'}</button>
        <button className="btn subtle" onClick={() => (pos.current.forEach((p) => (p.pinned = false)), (alpha.current = 1), setSettled(false), (fitted.current = false))}>Re-layout</button>
        <button className="btn subtle" onClick={fit}>Fit</button>
        <button className="btn" onClick={() => void window.pengu.exportJson('pengu-map', toExcalidraw(nodes, edges, pos.current), 'excalidraw')}>Export to Excalidraw</button>
      </div>
      {nodes.length === 0 ? (
        <div className="empty"><p>The map draws itself from your discussions, tickets and notes. Add one, or type [[ in any text to link items.</p></div>
      ) : (
        <svg ref={svg} className="map-canvas" onPointerDown={(e) => down(e, null)} onPointerMove={move} onPointerUp={up} onWheel={wheel}>
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {edges.map((e) => {
              const A = pos.current.get(e.a), B = pos.current.get(e.b)
              if (!A || !B) return null
              const dim = lit && !(lit.has(e.a) && lit.has(e.b))
              return (
                <g key={`${e.a}|${e.b}`} className={`edge ${e.kind}${dim ? ' dim' : ''}`}>
                  {edgePath(e, A, B).map((p, i) => <path key={i} d={p.d} />)}
                </g>
              )
            })}
            {nodes.map((n) => {
              const p = pos.current.get(n.id)
              if (!p) return null
              const dim = lit && !lit.has(n.id)
              return (
                <g
                  key={n.id}
                  className={`node ${n.kind}${dim ? ' dim' : ''}${n.id === focus ? ' focus' : ''}${p.pinned ? ' pinned' : ''}`}
                  transform={`translate(${p.x},${p.y})`}
                  onPointerDown={(e) => down(e, n.id)}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover(null)}
                  onDoubleClick={() => ((p.pinned = false), (alpha.current = 0.3), setSettled(false))}
                >
                  <title>{n.label}{n.kind === 'ghost' ? ' (click to create this note)' : ''}</title>
                  <Backing n={n} />
                  {shapeOf(n).map((s, i) => <path key={i} d={s.d} style={{ stroke: s.stroke, strokeWidth: s.strokeWidth, fill: s.fill ?? 'none' }} />)}
                  <text textAnchor="middle" dominantBaseline="central">{label(n)}</text>
                </g>
              )
            })}
          </g>
        </svg>
      )}
      <p className="map-hint muted">Drag to arrange (a dragged node stays put; double-click frees it). Click to open. Scroll to zoom. Solid: ticket/roadmap or [[link]]. Dotted: #tag. Dashed: plain mention.</p>
    </div>
  )
}

// ---------- export: a .excalidraw file with the same layout, each shape linking back into Pengu ----------

const EX_BG: Partial<Record<NodeKind, string>> = { discussions: '#a5d8ff', tickets: '#ffec99', notes: '#b2f2bb', roadmaps: '#d0bfff' }
const EX_TYPE_BG: Record<string, string> = { product: '#a5d8ff', growth: '#ffc9c9', tech: '#99e9f2' }

function toExcalidraw(nodes: GraphNode[], edges: GraphEdge[], pos: Map<string, P>) {
  const now = Date.now()
  const base = (id: string) => ({
    id, angle: 0, strokeColor: '#1e1e1e', fillStyle: 'hachure', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, seed: hash(id) % 2 ** 31, version: 1, versionNonce: hash(id + 'v') % 2 ** 31, isDeleted: false, updated: now, locked: false
  })
  const elements: Record<string, unknown>[] = []
  const bound = new Map<string, { id: string; type: string }[]>()
  for (const e of edges) {
    const id = `edge-${hash(e.a + e.b)}`
    for (const end of [e.a, e.b]) bound.set(end, [...(bound.get(end) ?? []), { id, type: 'arrow' }])
  }
  for (const n of nodes) {
    const p = pos.get(n.id)
    if (!p) continue
    const { w, h } = size(n)
    const textId = `${n.id}-label`
    const route = n.route ? `pengu://${n.route.slice(1)}` : null // clicking the shape in Excalidraw opens it in Pengu
    elements.push({
      ...base(n.id),
      type: n.kind === 'notes' ? 'ellipse' : n.kind === 'roadmaps' ? 'diamond' : 'rectangle',
      x: p.x - w / 2, y: p.y - h / 2, width: w, height: h,
      backgroundColor: n.kind === 'discussions' ? EX_TYPE_BG[n.sub ?? 'product'] : EX_BG[n.kind] ?? 'transparent',
      strokeStyle: n.kind === 'ghost' ? 'dashed' : 'solid',
      roundness: n.kind === 'tag' || n.kind === 'ghost' || n.kind === 'tickets' ? { type: 3 } : null,
      boundElements: [{ id: textId, type: 'text' }, ...(bound.get(n.id) ?? [])],
      link: route
    })
    elements.push({
      ...base(textId), type: 'text', x: p.x - w / 2 + 6, y: p.y - 10, width: w - 12, height: 20, backgroundColor: 'transparent',
      roundness: null, boundElements: null, link: null, text: n.label, originalText: n.label, fontSize: 16, fontFamily: 1,
      textAlign: 'center', verticalAlign: 'middle', containerId: n.id, lineHeight: 1.25, autoResize: true
    })
  }
  for (const e of edges) {
    const A = pos.get(e.a), B = pos.get(e.b)
    if (!A || !B) continue
    elements.push({
      ...base(`edge-${hash(e.a + e.b)}`), type: 'arrow', x: A.x, y: A.y, width: Math.abs(B.x - A.x), height: Math.abs(B.y - A.y),
      backgroundColor: 'transparent', strokeColor: e.kind === 'tag' ? '#868e96' : '#1e1e1e',
      strokeStyle: e.kind === 'mention' ? 'dashed' : e.kind === 'tag' ? 'dotted' : 'solid', roundness: { type: 2 }, boundElements: null, link: null,
      points: [[0, 0], [B.x - A.x, B.y - A.y]], lastCommittedPoint: null,
      startBinding: { elementId: e.a, focus: 0, gap: 6 }, endBinding: { elementId: e.b, focus: 0, gap: 6 },
      startArrowhead: null, endArrowhead: e.kind === 'link' ? 'arrow' : null
    })
  }
  return { type: 'excalidraw', version: 2, source: 'pengu', elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} }
}
