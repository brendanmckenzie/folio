import type { ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { StoryMeta } from '../../../core/story'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Field, Input } from '../Field'
import { href } from '../route'
import {
  addedAgo,
  addedOn,
  type AssetRow,
  dimensionsOf,
  humanSize,
  isRenderableImage,
  originalUrl,
  thumbUrl,
  typeLabel,
} from './assets-model'
import css from './Assets.module.css'
import { messageOf } from './useContent'

/** The transform width the preview asks for. See `AssetBrowser`'s note on why the
 * set of widths is deliberately tiny. */
const PREVIEW_WIDTH = 640

/** Enough to recognise what breaks, few enough that the panel does not become a
 * list. The count above it is exact either way. */
const USAGE_SHOWN = 8

/** What `GET {base}/api/assets/:id/usage` answers — the same shape
 * `{base}/api/documents/:id/usage` does, one field narrower. `server/assets.ts`'s
 * `assetUsage` argues the difference: every asset edge is one kind, so a `kind`
 * column would be the same word on every row and `links`/`references` would both be
 * zero. */
interface Usage {
  published: Pick<StoryMeta, 'id' | 'title' | 'path'>[]
  /** Distinct published documents — what "used on N published pages" counts. */
  total: number
}

export interface AssetDetailProps {
  apiBase: string
  mount: string
  row: AssetRow
  onClose: () => void
  onDelete: () => void
  /** The row after a successful `PATCH`, so the list and the screen's cache stop
   * showing the alt text somebody just replaced. */
  onChanged: (row: AssetRow) => void
  onNotice: (message: string) => void
}

/**
 * One asset: preview, dimensions, bytes, content type, when it arrived, its alt
 * text, and **where it is used**.
 *
 * **A panel beside the grid, not a slide-over.** Both were on the table and the
 * reason a panel wins is what `ui-architecture.md` says a slide-over is *for*: it
 * gives one to History and explains the choice as "a reference surface you consult
 * and dismiss, not one you co-edit with". This is the opposite of that. You edit alt
 * text here, and the thing you are editing it *about* is the grid behind it — an
 * editor working through a fresh batch of photos moves between five of them, and a
 * surface that covers the five to describe one makes that a sequence of open, type,
 * dismiss. A second column keeps both on screen.
 *
 * **Rejected: a slide-over** for the reason above. **Rejected: expanding the tile in
 * place**, which is what a lightbox would do — it puts the metadata form on top of
 * the image it describes and has nowhere for the usage list to go.
 *
 * Below 1100px there is no room for a second column, so it stacks under the grid and
 * `Assets.tsx` scrolls it into view on selection — see the CSS.
 */
export function AssetDetail({
  apiBase,
  mount,
  row,
  onClose,
  onDelete,
  onChanged,
  onNotice,
}: AssetDetailProps) {
  const titleId = useId()
  const panel = useRef<HTMLElement>(null)

  /**
   * Brought into view when the selection changes.
   *
   * `block: 'nearest'` is what makes this correct in both layouts rather than a
   * branch on the breakpoint: on a wide screen the panel is already beside the grid
   * and this is a no-op, and on a narrow one it is below the fold and this is the
   * whole reason a click on a tile appears to do something.
   *
   * **No `focus()`.** Moving focus on selection would fight the grid's roving
   * tabindex — the arrows would stop working after the first Enter, because focus
   * would have left the listbox.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `row.id` is the trigger, not a value the body reads — the effect exists precisely to fire when the subject changes. Reading it to satisfy the rule would misstate what this depends on
  useEffect(() => {
    panel.current?.scrollIntoView({ block: 'nearest' })
  }, [row.id])

  return (
    <aside ref={panel} className={css.panel} aria-labelledby={titleId}>
      <div className={css.panelHead}>
        <h2 className={css.panelTitle} id={titleId}>
          {row.filename}
        </h2>
        <Button size="sm" variant="subtle" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className={css.preview}>
        {isRenderableImage(row) ? (
          // Through the transform route like every other image on this screen, so a
          // 4MB original is never the preview either.
          <img className={css.previewImage} src={thumbUrl(mount, row, PREVIEW_WIDTH)} alt="" />
        ) : (
          <span className={css.previewExt}>{typeLabel(row)}</span>
        )}
      </div>

      <dl className={css.facts}>
        <Fact label="Type">
          <Badge mono>{row.contentType}</Badge>
        </Fact>
        {dimensionsOf(row) ? <Fact label="Dimensions">{dimensionsOf(row)}</Fact> : null}
        <Fact label="Size">{humanSize(row.size)}</Fact>
        <Fact label="Added">
          <span title={addedOn(row.createdAt)}>{addedAgo(row.createdAt)}</span>
        </Fact>
        <Fact label="Key">
          {/* The R2 key, because it is what a *document* stores and therefore what
              somebody debugging a broken reference is looking for. Monospace: a key
              is content here, per the brief's third commitment. */}
          <code className={css.key}>{row.key}</code>
        </Fact>
      </dl>

      <AltText apiBase={apiBase} row={row} onChanged={onChanged} onNotice={onNotice} />

      {/*
        The focal point, and the honest answer about it.

        `ui-architecture.md` lists it among the panel's contents, and it cannot be
        here: there is no column for it on `assets`, `toAssetValue` does not carry
        one, and `PATCH /assets/:id` accepts `alt` and nothing else. That is not an
        omission — a focal point answers "what must stay in frame when *this block*
        crops it", which is a different answer for a wide hero and a square avatar of
        the same file. It belongs to the field value, which is where the editor's
        asset field sets it. Said out loud rather than left as a missing control,
        because somebody will come looking for it.
      */}
      <p className={css.note}>
        A focal point belongs to a <em>use</em> of this file, not to the file: it is set on the
        field that places it, per block.
      </p>

      <Uses apiBase={apiBase} mount={mount} row={row} />

      <div className={css.panelFoot}>
        {/* The original bytes, untransformed, and `download` so a click saves rather
            than replacing the admin with an image. */}
        <a className={css.download} href={originalUrl(mount, row)} download={row.filename}>
          Download
        </a>
        <Button size="sm" variant="danger" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </aside>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={css.factLabel}>{label}</dt>
      <dd className={css.factValue}>{children}</dd>
    </>
  )
}

/* ---------------------------------------------------------------- alt text --- */

/**
 * The one editable thing about a library row.
 *
 * **Saved on blur, not per keystroke.** Every other text input in this admin is
 * debounced into a draft, and the difference is what absorbs the writes: a document's
 * keystrokes land in its own Durable Object, which coalesces them, while this is a
 * `PATCH` straight to a D1 row. A write per character to D1, for a value nobody is
 * co-editing, is the wrong shape.
 *
 * **Rejected: an explicit Save button.** It is the honest control for a form, and
 * this is one field — a button that is disabled almost always is furniture. Blur and
 * Enter both commit, and the state of it is said in words rather than implied by a
 * button's enabledness.
 */
function AltText({
  apiBase,
  row,
  onChanged,
  onNotice,
}: {
  apiBase: string
  row: AssetRow
  onChanged: (row: AssetRow) => void
  onNotice: (message: string) => void
}) {
  const [draft, setDraft] = useState(row.alt)
  const [saving, setSaving] = useState(false)
  /**
   * The value most recently written, rather than a `saved` boolean — and the
   * difference is the whole reason the note works.
   *
   * A boolean set on success was the first version and it never rendered: `onChanged`
   * hands the patched row up, the parent re-renders with the new `row.alt`, and the
   * reset below cleared the flag again in the same tick. So "Saved" flashed for less
   * than a frame, every time. Holding the *value* means the note survives its own row
   * coming back, and stops the moment somebody types something else.
   */
  const [savedValue, setSavedValue] = useState<string | null>(null)

  /**
   * A different asset is a different value.
   *
   * **Keyed on `row.id` alone, and `row.alt` is deliberately not a dependency.** Both
   * halves of that matter. The id has to be there because two files can carry the same
   * alt text, so watching the text alone misses the switch between them and leaves one
   * file's uncommitted keystrokes in the box while the panel describes the other. And
   * `row.alt` must *not* be there because the row comes back from our own successful
   * `PATCH` with a new one — firing then would reset the box and erase the note that
   * says it saved.
   *
   * The cost is that an external change to `alt` while the panel is open does not
   * reach the box. Nothing else edits this: it is one row, patched from here.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above — `row.id` is the trigger and `row.alt` is deliberately excluded, because the row returning from this component's own PATCH must not reset the field it was typed into
  useEffect(() => {
    setDraft(row.alt)
    setSavedValue(null)
  }, [row.id])

  const commit = async () => {
    if (draft === row.alt) return
    setSaving(true)
    try {
      const res = await fetch(`${apiBase}/assets/${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alt: draft }),
      })
      if (!res.ok) throw new Error(await messageOf(res))
      const next = (await res.json()) as AssetRow
      onChanged(next)
      setSavedValue(next.alt)
    } catch (e) {
      // Reported *and* left in the box: throwing away what somebody typed because
      // the request failed is the one response worse than the failure.
      onNotice((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Field
      label="Alt text"
      note={saving ? 'Saving…' : savedValue !== null && savedValue === draft ? 'Saved' : undefined}
      help="The file's default. A block copies it in when the image is placed and can then say something else, because alt text depends on what the image is being used to say."
    >
      {(id) => (
        <Input
          id={id}
          type="text"
          value={draft}
          placeholder="Describe the image"
          // No `setSavedValue(null)` here: the note is a comparison against what was
          // written, so typing and then typing the same thing back leaves it correct
          // rather than needing a second write to say so again.
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit()
          }}
        />
      )}
    </Field>
  )
}

/* --------------------------------------------------------------- where used --- */

/**
 * Where the file is used, from `GET {base}/api/assets/:id/usage`.
 *
 * **Published usage only, and it says so.** `content_refs` is written inside the
 * publish batch, so that is all the table holds; covering drafts would mean an edge
 * table maintained per keystroke or a scan of every Durable Object. The sentence
 * names the limit rather than letting "used nowhere" be read as "safe to delete".
 */
function Uses({ apiBase, mount, row }: { apiBase: string; mount: string; row: AssetRow }) {
  const usage = useUsage(apiBase, row.id)

  return (
    <section className={css.uses}>
      <h3 className={css.usesTitle}>Where it is used</h3>
      {usage.error ? (
        <p className={css.note}>Could not check what uses this: {usage.error}</p>
      ) : usage.data === null ? (
        <p className={css.note}>Checking…</p>
      ) : usage.data.total === 0 ? (
        <p className={css.note}>No published document uses this file.</p>
      ) : (
        <>
          <p className={css.note}>
            Used on <b>{usage.data.total}</b> published{' '}
            {usage.data.total === 1 ? 'document' : 'documents'}.
          </p>
          <ul className={css.usageList}>
            {usage.data.published.slice(0, USAGE_SHOWN).map((ref) => (
              <li key={ref.id}>
                {/*
                  A real `<a href>`, which the shell's one delegated click handler
                  turns into a soft navigation — so cmd-click opens the document in a
                  second tab, which is exactly what somebody auditing "what breaks if
                  I delete this" wants to do.
                */}
                <a className={css.usageLink} href={href({ name: 'edit', id: ref.id }, mount)}>
                  {ref.title || 'Untitled'}
                </a>
                <code className={css.usagePath}>
                  {ref.path === null ? 'not routed' : ref.path === '' ? '/' : `/${ref.path}`}
                </code>
              </li>
            ))}
          </ul>
          {usage.data.published.length > USAGE_SHOWN ? (
            <p className={css.note}>…and {usage.data.published.length - USAGE_SHOWN} more.</p>
          ) : null}
        </>
      )}
    </section>
  )
}

/** The usage read, refetched when the subject changes. Its own hook so both the
 * panel and the delete dialog ask the same question the same way. */
export function useUsage(apiBase: string, id: string) {
  const [data, setData] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setData(null)
    setError(null)
    fetch(`${apiBase}/assets/${encodeURIComponent(id)}/usage`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await messageOf(res))
        return (await res.json()) as Usage
      })
      .then((body) => {
        if (live) setData(body)
      })
      .catch((e: Error) => {
        if (live) setError(e.message)
      })
    return () => {
      live = false
    }
  }, [apiBase, id])

  return { data, error }
}
