import type { ChainedCommands, Editor } from '@tiptap/core'
import { EditorContent } from '@tiptap/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Json } from '../../../../core/doc'
import type { StoryRef } from '../../../../core/resolve'
import {
  RICHTEXT_MARKS,
  RICHTEXT_NODES,
  type RichtextLimits,
  type RichtextMarkName,
  type RichtextNodeName,
} from '../../../../core/richtext'
import { asLink } from '../../../../core/values'
import { Button } from '../../Button'
import { FocusMode } from '../FocusMode'
import css from './fields.module.css'
import { LinkField } from './LinkField'
import { useRichtext } from './useRichtext'

/**
 * What the focus overlay repeats from the row above it: the field's own label, the
 * locale note, and the read-only source column. Passed down rather than looked up,
 * because the row already computed all three and the overlay is one field's worth of
 * chrome, not a second inspector.
 */
export interface FieldChrome {
  label: string
  note?: ReactNode
  source?: ReactNode
}

interface Props {
  value: Json
  limits: RichtextLimits
  editable: boolean
  onChange: (value: Json) => void
  chrome: FieldChrome
  /** Every id this document points at, resolved — for the link editor's picked page. */
  stories: Readonly<Record<string, StoryRef>>
  apiBase: string
  mount: string
  /** Open in focus mode. Owned above so the shell's `⌘⏎` can set it. */
  expanded: boolean
  onExpand: (open: boolean) => void
}

/* ---------------------------------------------------------------- toolbars --- */

interface Tool {
  /** What the button shows. Short, because a 340px column holds about fourteen. */
  glyph: string
  /** What it is called. `B` and `‹›` are not accessible names. */
  label: string
  run: (chain: ChainedCommands) => { run: () => boolean }
}

const MARK_TOOLS: Partial<Record<RichtextMarkName, Tool>> = {
  bold: { glyph: 'B', label: 'Bold', run: (c) => c.toggleBold() },
  italic: { glyph: 'I', label: 'Italic', run: (c) => c.toggleItalic() },
  underline: { glyph: 'U', label: 'Underline', run: (c) => c.toggleUnderline() },
  strike: { glyph: 'S', label: 'Strikethrough', run: (c) => c.toggleStrike() },
  code: { glyph: '‹›', label: 'Inline code', run: (c) => c.toggleCode() },
  superscript: { glyph: 'x²', label: 'Superscript', run: (c) => c.toggleSuperscript() },
  subscript: { glyph: 'x₂', label: 'Subscript', run: (c) => c.toggleSubscript() },
}

const NODE_TOOLS: Partial<Record<RichtextNodeName, Tool>> = {
  bulletList: { glyph: '• List', label: 'Bulleted list', run: (c) => c.toggleBulletList() },
  orderedList: { glyph: '1. List', label: 'Numbered list', run: (c) => c.toggleOrderedList() },
  blockquote: { glyph: '❝', label: 'Block quote', run: (c) => c.toggleBlockquote() },
  codeBlock: { glyph: '{ }', label: 'Code block', run: (c) => c.toggleCodeBlock() },
}

/**
 * A toolbar toggle. `name` drives the pressed state so it reflects the caret.
 *
 * `aria-pressed` and a real `aria-label`, neither of which the old toolbar had: it
 * was `<button className={ed.isActive(name) ? 'is-active' : ''}>B</button>`, which is
 * a toggle whose state and whose name are both invisible to assistive technology.
 * Biome's a11y rules are on for `admin/ui/**` and off elsewhere, which is why this
 * had passed review for the whole life of the old admin.
 *
 * `onMouseDown` is prevented so clicking a toggle does not first take focus off the
 * prose and collapse the selection it is about to act on.
 */
function Toggle({
  ed,
  name,
  tool,
  attrs,
}: {
  ed: Editor
  name: string
  tool: Tool
  attrs?: Record<string, unknown>
}) {
  const on = attrs ? ed.isActive(name, attrs) : ed.isActive(name)
  return (
    <button
      type="button"
      className={`${css.segment} ${on ? css.segmentOn : ''}`}
      aria-pressed={on}
      aria-label={tool.label}
      title={tool.label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => tool.run(ed.chain().focus()).run()}
    >
      {tool.glyph}
    </button>
  )
}

/* ------------------------------------------------------------------- field --- */

export function RichTextField({
  value,
  limits,
  editable,
  onChange,
  chrome,
  stories,
  apiBase,
  mount,
  expanded,
  onExpand,
}: Props) {
  const [linking, setLinking] = useState(false)
  const { editor, behind } = useRichtext(value, limits, editable, onChange, css.surface)

  /**
   * Put the caret back where the person was.
   *
   * Both directions, one effect: opening focus mode should land in the prose (they
   * pressed `⌘⏎` while typing in it), and closing it has to return focus to the field
   * in the inspector — which `useFocusTrap` cannot do for us, because the element it
   * would have remembered as the opener was re-parented into the overlay in the same
   * commit, leaving `<body>` as the recorded opener.
   *
   * Runs *after* the trap's own effect, which is why it wins: `FocusMode` is a child
   * of this component, and React flushes child effects before parent ones. `settled`
   * skips the first real pass, so mounting the inspector does not steal focus from
   * wherever it already is.
   */
  const settled = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: expanded is the trigger, not a value the body reads — the whole point is to re-focus the surface whenever it changes container
  useEffect(() => {
    if (!editor) return
    if (!settled.current) {
      settled.current = true
      return
    }
    editor.commands.focus()
  }, [editor, expanded])

  if (!editor) return <p className={css.note}>Loading editor…</p>

  const marks = new Set<string>(limits.marks ?? RICHTEXT_MARKS)
  const nodes = new Set<string>(limits.nodes ?? RICHTEXT_NODES)
  const levels = limits.headingLevels ?? [2, 3]
  const activeLink = editor.getAttributes('link').link as Json | undefined

  const toolbar = (
    <fieldset className={`${css.group} ${css.segments}`} disabled={!editable}>
      <legend className={css.srOnly}>Formatting</legend>

      {(Object.keys(MARK_TOOLS) as RichtextMarkName[])
        .filter((name) => marks.has(name))
        .map((name) => (
          <Toggle key={name} ed={editor} name={name} tool={MARK_TOOLS[name]!} />
        ))}

      {nodes.has('heading')
        ? levels.map((level) => (
            <Toggle
              key={`h${level}`}
              ed={editor}
              name="heading"
              attrs={{ level }}
              tool={{
                glyph: `H${level}`,
                label: `Heading level ${level}`,
                run: (c) => c.toggleHeading({ level: level as never }),
              }}
            />
          ))
        : null}

      {(Object.keys(NODE_TOOLS) as RichtextNodeName[])
        .filter((name) => nodes.has(name))
        .map((name) => (
          <Toggle key={name} ed={editor} name={name} tool={NODE_TOOLS[name]!} />
        ))}

      {nodes.has('horizontalRule') ? (
        <button
          type="button"
          className={css.segment}
          aria-label="Horizontal rule"
          title="Horizontal rule"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        >
          —
        </button>
      ) : null}

      {marks.has('link') ? (
        <button
          type="button"
          className={`${css.segment} ${editor.isActive('link') ? css.segmentOn : ''}`}
          aria-pressed={editor.isActive('link')}
          aria-expanded={linking}
          // A link needs something to attach to, so it stays disabled until text is
          // selected or the caret sits inside an existing link.
          disabled={editor.state.selection.empty && !editor.isActive('link')}
          title="Select some text first"
          onClick={() => setLinking((v) => !v)}
        >
          Link
        </button>
      ) : null}

      {/* The expand control `ui-architecture.md` decision 5 names beside `⌘⏎`. In the
          toolbar rather than in the field's label, because it is a thing you reach for
          while writing and the toolbar is where your hand already is. */}
      <span className={css.spacerSegment} />
      <button
        type="button"
        className={css.segment}
        aria-label={expanded ? 'Leave focus mode' : 'Edit this field in focus mode'}
        title={expanded ? 'Leave focus mode (Esc)' : 'Focus mode (⌘⏎)'}
        onClick={() => onExpand(!expanded)}
      >
        {expanded ? '⤡' : '⤢'}
      </button>
    </fieldset>
  )

  const linkBox = linking ? (
    <div className={css.linkBox}>
      <LinkField
        id="folio-rt-link"
        label="this link"
        value={activeLink ?? null}
        stories={stories}
        apiBase={apiBase}
        mount={mount}
        editable={editable}
        onChange={(next) => {
          const link = asLink(next)
          if (link) editor.chain().focus().setMark('link', { link }).run()
          else editor.chain().focus().unsetMark('link').run()
        }}
      />
      <div className={css.row}>
        <Button size="sm" onClick={() => setLinking(false)}>
          Done
        </Button>
      </div>
    </div>
  ) : null

  /*
   * The surface, and it is **one element in both modes**. What moves is where this
   * subtree is rendered; the `editor` it points at is created once by `useRichtext`
   * and is not re-created by the move, because TipTap's `EditorContent` re-parents
   * `editor.view.dom` on mount and hands it back to a detached node on unmount.
   */
  const body = (
    <>
      {toolbar}
      {linkBox}
      <EditorContent editor={editor} />
      {/* Said plainly, because the alternative is somebody publishing a version of
          the prose they were not looking at. It clears itself the moment this field
          loses focus and the newer value lands. */}
      {behind ? (
        <p className={css.behind}>
          Somebody else changed this text while you were typing. Your copy is behind — click away to
          see theirs.
        </p>
      ) : null}
    </>
  )

  if (!expanded) return <div className={css.rt}>{body}</div>

  return (
    <>
      {/* A statement and a way back, not an empty box: the surface is genuinely
          elsewhere, and leaving a blank frame here would read as the field having
          lost its content. */}
      <div className={css.stub}>
        <span>Open in focus mode.</span>
        <Button size="sm" variant="subtle" onClick={() => onExpand(false)}>
          Bring it back
        </Button>
      </div>
      <FocusMode
        title={chrome.label}
        {...(chrome.note ? { note: chrome.note } : {})}
        {...(chrome.source ? { source: chrome.source } : {})}
        onClose={() => onExpand(false)}
      >
        {body}
      </FocusMode>
    </>
  )
}
