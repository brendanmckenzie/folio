import { Mark, mergeAttributes } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { useEditor } from '@tiptap/react'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, useState } from 'react'
import type { Json } from '../../../../core/doc'
import {
  asRichtext,
  RICHTEXT_MARKS,
  RICHTEXT_NODES,
  type RichtextDoc,
  type RichtextLimits,
  sanitiseRichtext,
} from '../../../../core/richtext'
import { asLink } from '../../../../core/values'

/**
 * The prose editor itself: one TipTap instance, its schema built from the field's
 * own limits, and the round-trip guard that keeps a keystroke from resetting its own
 * caret.
 *
 * **This hook is the whole reason focus mode cannot fork the write path.** The
 * `Editor`, the `local` echo ref and the `onUpdate` closure that calls `onChange`
 * live here, one level above the two places a surface can be drawn — inline in the
 * inspector, or in the overlay over the stage. `RichTextField` is never unmounted
 * when focus mode opens; only its `<EditorContent>` moves, and TipTap's
 * `EditorContent` *re-parents* `editor.view.dom` rather than rebuilding it. So the
 * same ProseMirror view, the same document, the same selection and the same
 * `store.tx` per keystroke serve both — there is no second editor to disagree with
 * the first.
 *
 * `externalUpdate` was imported from `admin/RichTextInput.tsx` rather than copied
 * while both admins existed, and **moved here when port phase 8 deleted that file**.
 * It is the three-way decision `live-collaboration.md` phase 4 turns on and it stays
 * pinned by `test/unit/admin/inspector.test.ts`. `extensionsFor` and `FolioLink`
 * below were copied instead, because that file did not export them and port phase 7b
 * could not edit it; they are now the only versions there are.
 */

/**
 * What to do with a value that arrived from outside this editor
 * (`../../../../../docs/specs/editing/live-collaboration.md` phase 4, step 1).
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

/**
 * A link inside prose stores the same `LinkValue` a `multilink` field does, so an
 * internal link survives the target page being renamed. TipTap's own Link extension
 * stores a bare `href`, which would freeze the path into the document — the exact
 * failure this project is built to avoid.
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
const EXTRA_MARKS: Partial<Record<string, () => unknown>> = {
  subscript: () => Subscript,
  superscript: () => Superscript,
}

/**
 * Builds the editor's schema from the field's own limits.
 *
 * This is what makes paste handling work: ProseMirror will not hold a node or mark
 * its schema does not define, so pasting a styled heading into a bold-and-links-only
 * caption drops the formatting on the way in rather than needing to be cleaned up
 * afterwards.
 */
function extensionsFor(limits: RichtextLimits) {
  const marks = new Set<string>(limits.marks ?? RICHTEXT_MARKS)
  const nodes = new Set<string>(limits.nodes ?? RICHTEXT_NODES)
  const wantsList = nodes.has('bulletList') || nodes.has('orderedList')

  const off = <T>(on: boolean, config: T) => (on ? config : (false as const))

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

  // **`.configure({})`, so this is a fresh instance.** `FolioLink` is declared
  // once at module scope, and pushing it raw handed *the same* extension object
  // to every editor, while the `EXTRA_MARKS` beside it are constructed per call.
  // `configure` returns a copy, so this makes the two consistent.
  //
  // **Not the cause of anything observed**, and worth saying so plainly because
  // it was written while chasing `RangeError: Adding different instances of a
  // keyed plugin` and it did not fix it. That was two copies of
  // `prosemirror-state` in the dev module graph — see `vite/index.ts`, which is
  // where the fix lives. This is hygiene against a hazard nobody has hit:
  // sharing one extension instance across editors is not something tiptap
  // promises to support.
  if (marks.has('link')) out.push(FolioLink.configure({}))
  for (const [name, make] of Object.entries(EXTRA_MARKS)) {
    if (marks.has(name)) out.push(make!())
  }
  return out as never
}

export interface Richtext {
  /** Null for the one render before TipTap has built its view. */
  editor: Editor | null
  /** An external value is being held back while this field has focus. */
  behind: boolean
}

export function useRichtext(
  value: Json,
  limits: RichtextLimits,
  editable: boolean,
  onChange: (value: Json) => void,
  /**
   * The class TipTap puts on its own `contenteditable`, so the peer ring can reach
   * it: a prose surface is not an `input` and would otherwise get no ring at all.
   *
   * Typed as possibly absent because that is what a CSS module's index signature
   * yields under `noUncheckedIndexedAccess`, and coerced once here rather than at the
   * call site — TipTap's `attributes` is `Record<string, string>` and will not take an
   * undefined.
   */
  surfaceClass: string | undefined,
): Richtext {
  /** Whether the prose surface itself has focus. See `externalUpdate`. */
  const [focused, setFocused] = useState(false)
  const [behind, setBehind] = useState(false)

  /**
   * Guards the round trip. Every keystroke writes a mutation, which comes back
   * through props; without this the incoming value would be pushed into the editor
   * again and move the caret to the end of the document on every letter.
   */
  const local = useRef<string>('')

  /**
   * **Built once per field, not once per render.**
   *
   * `extensions: extensionsFor(limits)` inline rebuilt the whole extension list —
   * a new array of new instances — on every render of a mounted editor, and
   * `useEditor` reads a changed `extensions` as a reconfigure. So every keystroke
   * elsewhere in the inspector threw away and rebuilt this editor's plugins.
   *
   * A ref rather than `useMemo`, and built once rather than keyed on `limits`: a
   * field's limits come from its block definition and cannot change while the
   * field is mounted, so there is nothing to invalidate on. `useMemo` would also
   * need `limits` in its dependency list, where it is a fresh object every render
   * and would memoise nothing.
   *
   * **Also not the cause of the keyed-plugin RangeError**, though it was written
   * looking for it. Same note as `FolioLink.configure({})` above: the fix for that
   * is in `vite/index.ts`. This one stands on its own as waste that is now gone.
   */
  // `unknown[]`, because `extensionsFor` returns `as never` — TipTap's own
  // extension union is not expressible here and the cast is the existing shape.
  const built = useRef<unknown[] | null>(null)
  if (built.current === null) built.current = extensionsFor(limits)

  const editor = useEditor({
    extensions: built.current as never,
    content: asRichtext(value) ?? undefined,
    editable,
    editorProps: {
      attributes: {
        class: surfaceClass ?? '',
        /**
         * Two attributes the old input did not carry, both needed by focus mode.
         *
         * `tabindex` puts the surface in `useFocusTrap`'s cycle — ProseMirror sets
         * `contenteditable` and nothing else, so without this the overlay's Tab cycle
         * would run through the toolbar and skip the prose entirely.
         *
         * `data-folio-prose` is how `FocusMode.module.css` reaches the surface at all:
         * the class above is hashed by another module, and `[contenteditable="true"]`
         * would stop matching in read-only mode, which is exactly when a past version
         * is on the stage and the overlay still has to look right.
         */
        tabindex: '0',
        'data-folio-prose': '',
      },
    },
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
   * Read-only is a *document* state and arrives after the editor is built — a past
   * version going on the stage, or a role that may not edit. Told separately because
   * a `contenteditable` is not a form control and the `<fieldset disabled>` the
   * inspector wraps its fields in does not reach it. The old inspector left every
   * prose field typeable while viewing a version and let the store refuse the
   * keystroke, which reads as the editor being broken rather than locked.
   */
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable)
  }, [editor, editable])

  /**
   * Applies edits that came from somewhere else: another editor over the WebSocket,
   * an undo, or a version restore — unless this field has focus, in which case it
   * waits for the blur rather than resetting the caret under somebody's hands.
   * `focused` is a dependency, which is what makes the blur re-run this against
   * whatever the authoritative value is by then.
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
    // Recorded even when nothing is pushed, exactly as before: the surface already
    // shows this value, so it is no longer an external change.
    local.current = serialised
    if (decision === 'apply') editor.commands.setContent(incoming ?? '', { emitUpdate: false })
  }, [editor, value, focused])

  return { editor, behind }
}
