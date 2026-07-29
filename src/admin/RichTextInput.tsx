import { Mark, mergeAttributes, type ChainedCommands, type Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import { useEffect, useRef, useState } from 'react'
import type { Json } from '../core/doc'
import {
  asRichtext,
  RICHTEXT_MARKS,
  RICHTEXT_NODES,
  sanitiseRichtext,
  type RichtextDoc,
  type RichtextLimits,
  type RichtextMarkName,
  type RichtextNodeName,
} from '../core/richtext'
import { asLink } from '../core/values'
import { LinkInput } from './LinkInput'

/**
 * A link inside prose stores the same `LinkValue` a `multilink` field does, so an
 * internal link survives the target page being renamed. TipTap's own Link
 * extension stores a bare `href`, which would freeze the path into the document —
 * the exact failure this project is built to avoid.
 */
const FolioLink = Mark.create({
  name: 'link',
  priority: 1000,
  keepOnSplit: false,
  inclusive: false,

  addAttributes() {
    return {
      link: {
        default: null,
        // The value is stored in the document JSON, not in the DOM: the editor's
        // HTML is a rendering detail and never what gets saved.
        parseHTML: (el) => {
          const href = el.getAttribute('href')
          return href ? { kind: 'url', url: href } : null
        },
        renderHTML: (attrs) => {
          const link = asLink(attrs.link)
          if (!link) return {}
          // Only for the editor's own display; nothing reads this back.
          return { href: link.kind === 'url' ? link.url : '#', 'data-folio-link': link.kind }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'a[href]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['a', mergeAttributes(HTMLAttributes), 0]
  },
})

/** Marks StarterKit does not provide, added only when the field permits them. */
const EXTRA_MARKS: Partial<Record<RichtextMarkName, () => unknown>> = {
  subscript: () => Subscript,
  superscript: () => Superscript,
}

/**
 * Builds the editor's schema from the field's own limits.
 *
 * This is what makes paste handling work: ProseMirror will not hold a node or
 * mark its schema does not define, so pasting a styled heading into a
 * bold-and-links-only caption drops the formatting on the way in rather than
 * needing to be cleaned up afterwards.
 */
function extensionsFor(limits: RichtextLimits) {
  const marks = new Set<string>(limits.marks ?? RICHTEXT_MARKS)
  const nodes = new Set<string>(limits.nodes ?? RICHTEXT_NODES)
  const wantsList = nodes.has('bulletList') || nodes.has('orderedList')

  const off = <T,>(on: boolean, config: T) => (on ? config : (false as const))

  const out: unknown[] = [
    StarterKit.configure({
      // Folio's own link mark replaces it; see FolioLink.
      link: false,
      bold: off(marks.has('bold'), {}),
      italic: off(marks.has('italic'), {}),
      strike: off(marks.has('strike'), {}),
      code: off(marks.has('code'), {}),
      underline: off(marks.has('underline'), {}),
      heading: off(nodes.has('heading'), {
        levels: (limits.headingLevels ?? [1, 2, 3, 4, 5, 6]) as never,
      }),
      blockquote: off(nodes.has('blockquote'), {}),
      codeBlock: off(nodes.has('codeBlock'), {}),
      horizontalRule: off(nodes.has('horizontalRule'), {}),
      hardBreak: off(nodes.has('hardBreak'), {}),
      bulletList: off(nodes.has('bulletList'), {}),
      orderedList: off(nodes.has('orderedList'), {}),
      listItem: off(wantsList, {}),
      listKeymap: off(wantsList, {}),
    }),
  ]

  if (marks.has('link')) out.push(FolioLink)
  for (const [name, make] of Object.entries(EXTRA_MARKS)) {
    if (marks.has(name)) out.push(make!())
  }
  return out as never
}

/**
 * What to do with a value that arrived from outside this editor
 * (`../../../docs/specs/editing/live-collaboration.md` phase 4, step 1).
 *
 * Three answers, and the middle one is the whole point of this spec's phase 4:
 *
 *   - `'ignore'` — it is what this editor already holds. Either the round trip of
 *     our own keystroke or a value the surface already shows; pushing it in would
 *     reset the caret for nothing.
 *   - `'defer'` — it differs, **and this field has focus**. Pushing it in calls
 *     `setContent`, which resets the selection, so a peer typing in the same
 *     richtext field would yank the caret out of the middle of your sentence.
 *     Held instead, and applied on blur.
 *   - `'apply'` — it differs and nobody is typing here. Exactly the pre-v4
 *     behaviour: another editor over the socket, an undo, or a version restore.
 *
 * This is not a merge and does not pretend to be one: last write still wins
 * (CRDTs are out of scope, and `README.md` says why). What it fixes is that
 * last-write-wins was *unusable* with two people in one prose field, rather than
 * merely lossy — and it costs nothing, because the deferred value is never
 * snapshotted. `'defer'` simply skips this pass; the effect re-runs on blur and
 * reads whatever the authoritative value is by then, which is the peer's value if
 * they wrote last and yours if you did.
 *
 * Pure and exported so all three branches are tested without a DOM or a TipTap
 * instance.
 */
export type ExternalUpdate = 'apply' | 'defer' | 'ignore'

export function externalUpdate(
  /** The incoming value, serialised. */
  incoming: string,
  /** The last value this editor emitted, serialised — the round-trip guard. */
  localEcho: string,
  /** What the surface currently shows, serialised. */
  shown: string,
  focused: boolean,
): ExternalUpdate {
  if (incoming === localEcho || incoming === shown) return 'ignore'
  return focused ? 'defer' : 'apply'
}

interface Props {
  value: Json
  limits: RichtextLimits
  onChange: (value: Json) => void
}

export function RichTextInput({ value, limits, onChange }: Props) {
  const [linking, setLinking] = useState(false)
  /** Whether the prose surface itself has focus. See `externalUpdate`. */
  const [focused, setFocused] = useState(false)
  /** An external value is being held back while this field has focus. */
  const [behind, setBehind] = useState(false)

  /**
   * Guards the round trip. Every keystroke writes a mutation, which comes back
   * through props; without this the incoming value would be pushed into the
   * editor again and move the caret to the end of the document on every letter.
   */
  const local = useRef<string>('')

  const editor = useEditor({
    extensions: extensionsFor(limits),
    content: asRichtext(value) ?? undefined,
    editorProps: { attributes: { class: 'rt__surface' } },
    // The admin renders on the client only; TipTap warns without this.
    immediatelyRender: false,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onUpdate: ({ editor: ed }) => {
      const doc = sanitiseRichtext(ed.getJSON() as RichtextDoc, limits)
      const next = ed.isEmpty ? null : doc
      local.current = JSON.stringify(next)
      onChange(next as unknown as Json)
    },
  })

  /**
   * Applies edits that came from somewhere else: another editor over the
   * WebSocket, an undo, or a version restore — unless this field has focus, in
   * which case it waits for the blur rather than resetting the caret under
   * somebody's hands. `focused` is a dependency, which is what makes the blur
   * re-run this against whatever the authoritative value is by then.
   */
  useEffect(() => {
    if (!editor) return
    const incoming = asRichtext(value)
    const serialised = JSON.stringify(incoming)
    const shown = JSON.stringify(asRichtext(editor.getJSON() as RichtextDoc))
    const decision = externalUpdate(serialised, local.current, shown, focused)
    if (decision === 'defer') {
      setBehind(true)
      return
    }
    setBehind(false)
    // Recorded even when nothing is pushed, exactly as before: the surface
    // already shows this value, so it is no longer an external change.
    local.current = serialised
    if (decision === 'apply') editor.commands.setContent(incoming ?? '', { emitUpdate: false })
  }, [editor, value, focused])

  if (!editor) return <div className="rt rt--loading">Loading editor…</div>

  const marks = new Set<string>(limits.marks ?? RICHTEXT_MARKS)
  const nodes = new Set<string>(limits.nodes ?? RICHTEXT_NODES)
  const levels = limits.headingLevels ?? [2, 3]
  const activeLink = editor.getAttributes('link').link as Json | undefined

  return (
    <div className="rt">
      <div className="rt__bar">
        {marks.has('bold') ? (
          <Tool ed={editor} name="bold" label="B" run={(c) => c.toggleBold()} />
        ) : null}
        {marks.has('italic') ? (
          <Tool ed={editor} name="italic" label="I" run={(c) => c.toggleItalic()} />
        ) : null}
        {marks.has('underline') ? (
          <Tool ed={editor} name="underline" label="U" run={(c) => c.toggleUnderline()} />
        ) : null}
        {marks.has('strike') ? (
          <Tool ed={editor} name="strike" label="S" run={(c) => c.toggleStrike()} />
        ) : null}
        {marks.has('code') ? (
          <Tool ed={editor} name="code" label="‹›" run={(c) => c.toggleCode()} />
        ) : null}
        {marks.has('superscript') ? (
          <Tool ed={editor} name="superscript" label="x²" run={(c) => c.toggleSuperscript()} />
        ) : null}
        {marks.has('subscript') ? (
          <Tool ed={editor} name="subscript" label="x₂" run={(c) => c.toggleSubscript()} />
        ) : null}

        {nodes.has('heading')
          ? levels.map((level) => (
              <button
                key={level}
                type="button"
                className={editor.isActive('heading', { level }) ? 'is-active' : ''}
                onClick={() =>
                  editor
                    .chain()
                    .focus()
                    .toggleHeading({ level: level as never })
                    .run()
                }
              >
                H{level}
              </button>
            ))
          : null}
        {nodes.has('bulletList') ? (
          <Tool ed={editor} name="bulletList" label="• List" run={(c) => c.toggleBulletList()} />
        ) : null}
        {nodes.has('orderedList') ? (
          <Tool ed={editor} name="orderedList" label="1. List" run={(c) => c.toggleOrderedList()} />
        ) : null}
        {nodes.has('blockquote') ? (
          <Tool ed={editor} name="blockquote" label="❝" run={(c) => c.toggleBlockquote()} />
        ) : null}
        {nodes.has('codeBlock') ? (
          <Tool ed={editor} name="codeBlock" label="{ }" run={(c) => c.toggleCodeBlock()} />
        ) : null}
        {nodes.has('horizontalRule') ? (
          <button type="button" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
            —
          </button>
        ) : null}

        {marks.has('link') ? (
          <button
            type="button"
            className={editor.isActive('link') ? 'is-active' : ''}
            // A link needs something to attach to, so it stays disabled until
            // text is selected or the caret sits inside an existing link.
            disabled={editor.state.selection.empty && !editor.isActive('link')}
            onClick={() => setLinking((v) => !v)}
          >
            Link
          </button>
        ) : null}
      </div>

      {linking ? (
        <div className="rt__link">
          <LinkInput
            id="rt-link"
            value={activeLink ?? null}
            onChange={(next) => {
              const link = asLink(next)
              if (link) editor.chain().focus().setMark('link', { link }).run()
              else editor.chain().focus().unsetMark('link').run()
            }}
          />
          <button type="button" className="rt__done" onClick={() => setLinking(false)}>
            Done
          </button>
        </div>
      ) : null}

      <EditorContent editor={editor} />

      {/* Said plainly, because the alternative is somebody publishing a version
          of the prose they were not looking at. It clears itself the moment this
          field loses focus and the newer value lands. */}
      {behind ? (
        <p className="rt__behind">
          Somebody else changed this text while you were typing. Your copy is behind — click away to
          see theirs.
        </p>
      ) : null}
    </div>
  )
}

/** A toolbar toggle. `name` drives the active state so it reflects the caret. */
function Tool({
  ed,
  name,
  label,
  run,
}: {
  ed: Editor
  name: string
  label: string
  run: (chain: ChainedCommands) => { run: () => boolean }
}) {
  return (
    <button
      type="button"
      className={ed.isActive(name) ? 'is-active' : ''}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => run(ed.chain().focus()).run()}
    >
      {label}
    </button>
  )
}

export type { RichtextMarkName, RichtextNodeName }
