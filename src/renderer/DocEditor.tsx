import { useContext, useEffect, useRef, useState } from 'react'
import { Editor, Extension } from '@tiptap/react'
import Image from '@tiptap/extension-image'
import { Placeholder } from '@tiptap/extensions'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import { SECTION_HINTS } from '../shared/doc'
import { norm } from '../shared/links'
import { KIND_ICON, LinkCtx } from './Links'

// One document per discussion, like a page in Obsidian: headings, lists, images and text in one flow.
// The five topics start as headings with a hint under each; rename, move or delete them like any text.
// [[ and # autocomplete, [[links]] and #tags are highlighted (Ctrl/Cmd+click opens them), images can be
// pasted or dropped, and selecting text offers "Make tickets", like a copilot.

const WIKI = /\[\[([^[\]|]+?)(?:\|[^[\]]*)?\]\]/g
const TAG = /(^|[\s(,;])(#[\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu

// Highlights [[links]] and #tags as you type. They stay plain text in the document, so links survive copy,
// export and the assistant; only the look and the Ctrl+click behaviour come from here.
const LinkHighlight = Extension.create({
  name: 'linkHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('linkHighlight'),
        props: {
          decorations(state) {
            const out: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return
              for (const m of node.text.matchAll(WIKI))
                out.push(Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, { class: 'wikilink', 'data-link': m[1].trim(), title: 'Ctrl+click to open' }))
              for (const m of node.text.matchAll(TAG)) {
                const at = pos + m.index! + m[1].length
                out.push(Decoration.inline(at, at + m[2].length, { class: 'doc-tag', 'data-tag': m[2].slice(1).toLowerCase(), title: 'Ctrl+click to see on the map' }))
              }
            })
            return DecorationSet.create(state.doc, out)
          }
        }
      })
    ]
  }
})

// The hint under each topic heading comes from the heading's text, so a renamed heading simply loses its hint.
function hintFor(editor: Editor, pos: number) {
  const $pos = editor.state.doc.resolve(pos)
  const index = $pos.index(0)
  const prev = index > 0 ? editor.state.doc.child(index - 1) : null
  if (prev?.type.name === 'heading') return SECTION_HINTS[prev.textContent.trim().toLowerCase()] ?? 'Write here…'
  return editor.state.doc.childCount <= 1 ? 'Write, paste images, type [[ to link and # to tag…' : ''
}

// The text the editor starts from when nobody has edited the document together yet: the saved HTML as a Yjs update.
// Uses the same node types as the editor, so the converted text looks identical.
export function seedFromHtml(html: string): Uint8Array {
  const tmp = new Editor({ extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] } }), Image], content: html || '<p></p>' })
  const ydoc = new Y.Doc()
  prosemirrorJSONToYXmlFragment(tmp.schema, tmp.getJSON(), ydoc.getXmlFragment('default'))
  tmp.destroy()
  return Y.encodeStateAsUpdate(ydoc)
}

type Suggest = { mode: 'link' | 'tag'; from: number; to: number; query: string; left: number; top: number; active: number; options: { label: string; value: string; icon: string }[] }

export interface DocEditorProps {
  value: string
  version: number // bump to push an outside change (the assistant, Undo) into the editor
  onChange: (html: string) => void
  onTasks: (text: string, whole: boolean) => void
  onAsk: (text: string) => void
  onOpenLink: (title: string) => void
  onOpenTag: (tag: string) => void
  busy?: boolean
  ydoc?: Y.Doc // live editing with the other person: the text then lives in this document
}

export function DocEditor({ value, version, onChange, onTasks, onAsk, onOpenLink, onOpenTag, busy, ydoc }: DocEditorProps) {
  const data = useContext(LinkCtx)
  const [sug, setSug] = useState<Suggest | null>(null)
  const sugRef = useRef<Suggest | null>(null)
  sugRef.current = sug
  const props = useRef({ onOpenLink, onOpenTag, data })
  props.current = { onOpenLink, onOpenTag, data }
  const wrap = useRef<HTMLDivElement>(null)
  // The ProseMirror callbacks below run after the editor exists; they read it through this ref.
  const ed = useRef<Editor | null>(null)

  // Pasted or dropped image files are saved by main (userData/images) and inserted as pengu-img:// links.
  const insertImages = (editor: Editor, files: File[], at?: number) => {
    for (const f of files.filter((x) => /^image\/(png|jpeg|gif|webp)$/.test(x.type))) {
      void f.arrayBuffer().then(async (buf) => {
        try {
          const src = await window.pengu.saveImage(new Uint8Array(buf), f.type)
          const chain = editor.chain().focus()
          ;(at !== undefined ? chain.insertContentAt(at, { type: 'image', attrs: { src } }) : chain.setImage({ src })).run()
        } catch (e) {
          alert(String((e as Error).message).replace(/^.*?Error: /, ''))
        }
      })
    }
  }

  // What's typed at the caret: "[[part" opens title suggestions, "#part" opens tag suggestions.
  const refresh = (editor: Editor) => {
    const { $from, empty } = editor.state.selection
    const d = props.current.data
    if (!empty || !d) return setSug(null)
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
    const link = before.match(/\[\[([^[\]\n]*)$/)
    const tag = before.match(/(^|[\s(,;])#([\p{L}\p{N}_/-]*)$/u)
    const hit = link ? { mode: 'link' as const, query: link[1] } : tag ? { mode: 'tag' as const, query: tag[2] } : null
    if (!hit) return setSug(null)
    const q = norm(hit.query)
    const options =
      hit.mode === 'link'
        ? d.items.filter((i) => norm(i.title).includes(q)).slice(0, 8).map((i) => ({ label: i.title, value: i.title, icon: KIND_ICON[i.kind] }))
        : d.tags.filter((g) => g.includes(q)).slice(0, 8).map((g) => ({ label: `#${g}`, value: g, icon: '#' }))
    if (q && !options.some((o) => norm(o.value) === q)) options.push({ label: hit.mode === 'link' ? `New: ${hit.query}` : `#${hit.query}`, value: hit.query, icon: '+' })
    if (!options.length) return setSug(null)
    const coords = editor.view.coordsAtPos($from.pos)
    const box = wrap.current!.getBoundingClientRect()
    setSug({ ...hit, from: $from.pos - hit.query.length, to: $from.pos, left: coords.left - box.left, top: coords.bottom - box.top + 4, active: 0, options })
  }
  const pick = (editor: Editor, s: Suggest, value: string) => {
    // Swallow a "]]" the user may already have typed after the caret, so the link isn't doubled.
    const after = editor.state.doc.textBetween(s.to, Math.min(s.to + 2, editor.state.doc.content.size))
    const to = s.mode === 'link' && after === ']]' ? s.to + 2 : s.to
    editor.chain().focus().insertContentAt({ from: s.from, to }, s.mode === 'link' ? `${value}]] ` : `${value} `).run()
    setSug(null)
  }

  const editor = useEditor({
    extensions: [
      // Live editing brings its own undo (it must only undo your own typing), so the built-in history is off then.
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true }, ...(ydoc ? { undoRedo: false as const } : {}) }),
      ...(ydoc ? [Collaboration.configure({ document: ydoc })] : []),
      Image.configure({ allowBase64: false }),
      Placeholder.configure({ placeholder: ({ editor, pos }) => hintFor(editor, pos), showOnlyCurrent: false, includeChildren: false }),
      LinkHighlight
    ],
    content: ydoc ? undefined : value || '<p></p>',
    // With live editing the text comes from the shared document, so tell the page what it is right away.
    onCreate: ({ editor }) => void (ydoc && onChange(editor.getHTML())),
    onUpdate: ({ editor }) => (onChange(editor.getHTML()), refresh(editor)),
    onSelectionUpdate: ({ editor }) => refresh(editor),
    editorProps: {
      attributes: { class: 'doc', spellcheck: 'true' },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])]
        if (!files.some((f) => f.type.startsWith('image/')) || !ed.current) return false
        insertImages(ed.current, files)
        return true
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])]
        if (!files.some((f) => f.type.startsWith('image/')) || !ed.current) return false
        insertImages(ed.current, files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
        return true
      },
      handleKeyDown: (_view, e): boolean => {
        const s = sugRef.current
        const editor = ed.current
        if (!s || !editor) return false
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const d = e.key === 'ArrowDown' ? 1 : -1
          setSug({ ...s, active: (s.active + d + s.options.length) % s.options.length })
          return true
        }
        if (e.key === 'Enter' || e.key === 'Tab') return pick(editor, s, s.options[s.active].value), true
        if (e.key === 'Escape') return setSug(null), true
        return false
      },
      handleClick: (_view, _pos, e) => {
        if (!(e.ctrlKey || e.metaKey)) return false
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-link],[data-tag]')
        if (!el) return false
        if (el.dataset.link) props.current.onOpenLink(el.dataset.link)
        else if (el.dataset.tag) props.current.onOpenTag(el.dataset.tag)
        return true
      }
    }
  })

  ed.current = editor

  // An outside change (assistant edit, Undo) replaces the content without echoing back as a user edit.
  useEffect(() => {
    if (editor && version > 0 && editor.getHTML() !== value) editor.commands.setContent(value || '<p></p>', { emitUpdate: false })
  }, [version])

  if (!editor) return null
  const selected = () => {
    const { from, to } = editor.state.selection
    return editor.state.doc.textBetween(from, to, '\n', '\n').trim()
  }
  const addSection = () => editor.chain().focus('end').insertContent('<h2>New section</h2><p></p>').run()

  return (
    <div className="doc-wrap" ref={wrap}>
      <div className="doc-toolbar" role="toolbar">
        <button type="button" className={editor.isActive('heading', { level: 2 }) ? 'on' : ''} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Section heading">H</button>
        <button type="button" className={editor.isActive('bold') ? 'on' : ''} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold"><b>B</b></button>
        <button type="button" className={editor.isActive('italic') ? 'on' : ''} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic"><i>I</i></button>
        <button type="button" className={editor.isActive('bulletList') ? 'on' : ''} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullets">•</button>
        <button type="button" className={editor.isActive('orderedList') ? 'on' : ''} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">1.</button>
        <button type="button" onClick={addSection} title="Add a section at the end">+ Section</button>
        <span className="grow" />
        <button type="button" className="ai" disabled={busy} onClick={() => onTasks(editor.getText({ blockSeparator: '\n' }), true)} title="Find every action item in this discussion and make tickets (skips ones that already exist)">
          {busy ? 'Working…' : '✦ Find tasks → tickets'}
        </button>
      </div>

      <BubbleMenu editor={editor} shouldShow={({ editor: e, state }) => e.isFocused && !state.selection.empty && selected().length > 2} className="bubble">
        <button type="button" className="ai" disabled={busy} onClick={() => onTasks(selected(), false)}>✦ Make tickets</button>
        <button type="button" onClick={() => onAsk(selected())}>✦ Ask Pengu</button>
        <span className="sep" />
        <button type="button" onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></button>
        <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H</button>
        <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()}>•</button>
      </BubbleMenu>

      <EditorContent editor={editor} />

      {sug && (
        <div className="suggest" role="listbox" style={{ left: sug.left, top: sug.top, right: 'auto', width: 280 }}>
          {sug.options.map((o, i) => (
            <button key={o.label} type="button" role="option" aria-selected={i === sug.active} className={i === sug.active ? 'active' : ''} onMouseDown={(e) => (e.preventDefault(), pick(editor, sug, o.value))}>
              <span className="suggest-icon">{o.icon}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
