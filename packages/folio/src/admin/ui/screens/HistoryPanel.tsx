import type { ReactNode } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Doc } from '../../../core/doc'
import type { Page } from '../../../core/pagination'
import type { ActivityEntry } from '../../../core/protocol'
import type { SchemaIndex } from '../../../core/schema'
import type { VersionMeta } from '../../../server/versions'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import css from './HistoryPanel.module.css'
import {
  ACTIVITY_NOTE,
  type ActorForm,
  actorForm,
  actorNames,
  appendRows,
  describeEdit,
  historyExactly,
  historyWhen,
  VERSIONS_NOTE,
  versionKindLabel,
  versionTitle,
  versionTone,
} from './history-model'
import { messageOf } from './useContent'

export interface HistoryPanelProps {
  /**
   * Mounted only while true. `⌘H` belongs to the shell's shortcut map
   * (`ui/shortcuts.ts`), not to this component — the same rule `Palette.tsx`'s
   * closing comment states for `⌘K`.
   */
  open: boolean
  onClose: () => void
  apiBase: string
  storyId: string
  /** The live draft, for the labels in an activity phrase. */
  doc: Doc
  schema: SchemaIndex
  /** `useVersions`' own flag: a version request is in flight, so its controls stay
   * disabled. */
  busy: boolean
  /** `useVersions`' `viewing?.version.id ?? null` — the row that has the amber
   * frame on the stage. Only the id is needed here; the document belongs to the
   * stage. */
  viewingId: string | null
  /** `useVersions.checkpoint`. Reports its own failures through the toast. */
  onCheckpoint: (label: string) => Promise<void>
  /** `useVersions.view` — loads the version and puts it on the stage. */
  onView: (version: VersionMeta) => Promise<void>
  /** `useVersions.exit`. */
  onExitView: () => void
  /**
   * `useVersions.restore`. No preloaded document from here: the hook fetches the
   * version itself, which is the difference between restoring from this list and
   * restoring from `ViewingBar`, where the document is already in hand.
   */
  onRestore: (version: VersionMeta) => Promise<void>
  /**
   * Actor id → display name for whatever the shell already knows; presence is the
   * intended source, since a peer broadcast carries both. Optional, and layered
   * *under* the names the activity trail captured. See `actorNames`.
   */
  peerNames?: Readonly<Record<string, string>>
}

/**
 * History as a **slide-over** from the right, over the inspector, full height —
 * `docs/ui-architecture.md`'s editor section, and port phase 7c.
 *
 * A slide-over rather than a tab because it is a reference surface you consult and
 * dismiss, not one you co-edit with. Decision 4 there names what it beat: **a
 * segmented control in the inspector** (Fields / History), which is tabs again one
 * pane over, and makes a document-scoped reference surface compete with the fields
 * being edited.
 *
 * Three things about the container are decisions rather than styling:
 *
 * 1. **The scrim is transparent.** It is a real click target that dismisses, so
 *    the panel is honestly modal — `aria-modal` is true and Tab cannot leave it —
 *    but it does not tint. `Dialog`'s scrim uses `--bg-overlay` because a dialog
 *    asking a question wants the rest of the screen out of the way; this panel
 *    exists *so that you can look at the stage*. Choosing a version puts the amber
 *    frame on the preview and the comparison in the top bar, and dimming that is
 *    dimming the thing the panel was opened to compare against.
 * 2. **One focus trap, the existing one.** `useFocusTrap` on the panel and not the
 *    wrapper, exactly as `Dialog` does: focus in on open, back to the opener on
 *    close, Tab cycles, Escape dismisses. There is no `autoFocus` anywhere inside,
 *    including in the checkpoint form — React applies it during commit, before the
 *    trap reads `activeElement` to learn who opened the panel, and the two fight.
 * 3. **It owns its own reads of both lists.** `useVersions` and `useVersionsList`
 *    keep the first page and drop the cursor, because until now no history list
 *    had a paging control at all. A cursor is opaque by construction
 *    (`core/pagination.ts` says so and means it), so the tail cannot be derived
 *    from the rows the hook holds — it has to come from a response. The hook's
 *    copy stays what it is for, which is `usePublishedDoc` and the viewing
 *    machinery; this is the display copy, fetched on open and dropped on close.
 */
export function HistoryPanel(props: HistoryPanelProps) {
  // The early return is what makes `open` mean *mounted*: the focus trap's memory
  // of the opener, and both trails' first read, are mount effects.
  if (!props.open) return null
  return <Panel {...props} />
}

/* ------------------------------------------------------------------ paging --- */

interface Trail<T> {
  rows: readonly T[]
  /** Null when the list is fully loaded. */
  cursor: string | null
  loading: boolean
  error?: string
}

/** Module-level so they are stable identities and `read` is not rebuilt per
 * render. */
const versionKey = (row: VersionMeta) => row.id
const activityKey = (row: ActivityEntry) => row.syncId

/**
 * One paged, appending list over a `Page<T>` route.
 *
 * `appendRows` carries the argument for appending rather than paging; what is here
 * is only the fetch and the state it lands in, kept thin for the same reason
 * `useContent.ts` is.
 */
function useTrail<T>(url: string, keyOf: (row: T) => string | number) {
  const [trail, setTrail] = useState<Trail<T>>({ rows: [], cursor: null, loading: true })
  const live = useRef(true)
  useEffect(
    () => () => {
      live.current = false
    },
    [],
  )

  const read = useCallback(
    async (from: string | null) => {
      setTrail((prev) => ({ ...prev, loading: true, error: undefined }))
      try {
        const res = await fetch(from === null ? url : `${url}?cursor=${encodeURIComponent(from)}`)
        if (!res.ok) throw new Error(await messageOf(res))
        const page = (await res.json()) as Page<T>
        if (!live.current) return
        setTrail((prev) => ({
          // `from === null` is a reload and replaces; a cursor appends. The held
          // rows come from `prev` rather than from the closure, so two reads in
          // flight cannot drop one another's page.
          rows: from === null ? page.rows : appendRows(prev.rows, page.rows, keyOf),
          cursor: page.cursor,
          loading: false,
        }))
      } catch (e) {
        if (live.current) {
          setTrail((prev) => ({ ...prev, loading: false, error: (e as Error).message }))
        }
      }
    },
    [keyOf, url],
  )

  useEffect(() => {
    void read(null)
  }, [read])

  const more = useCallback(() => {
    if (trail.cursor !== null) void read(trail.cursor)
  }, [read, trail.cursor])
  const reload = useCallback(() => {
    void read(null)
  }, [read])

  return { trail, more, reload }
}

/* ------------------------------------------------------------------- panel --- */

function Panel({
  onClose,
  apiBase,
  storyId,
  doc,
  schema,
  busy,
  viewingId,
  onCheckpoint,
  onView,
  onExitView,
  onRestore,
  peerNames,
}: HistoryPanelProps) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const versionsId = useId()
  const activityId = useId()
  useFocusTrap(panel, onClose)

  const story = encodeURIComponent(storyId)
  const versions = useTrail<VersionMeta>(`${apiBase}/story/${story}/versions`, versionKey)
  const activity = useTrail<ActivityEntry>(`${apiBase}/story/${story}/activity`, activityKey)

  const [naming, setNaming] = useState(false)

  const names = useMemo(
    () => actorNames(activity.trail.rows, peerNames),
    [activity.trail.rows, peerNames],
  )

  const reloadBoth = useCallback(() => {
    versions.reload()
    activity.reload()
  }, [activity, versions])

  const checkpoint = useCallback(
    async (label: string) => {
      await onCheckpoint(label)
      setNaming(false)
      // Both, and unconditionally: a checkpoint writes a version row, and the hook
      // swallows its own failure into a toast, so there is nothing here to branch
      // on. Re-reading a list that did not change costs one request.
      reloadBoth()
    },
    [onCheckpoint, reloadBoth],
  )

  const restore = useCallback(
    async (version: VersionMeta) => {
      await onRestore(version)
      // Activity only: a restore is a transaction on the document, not a version.
      activity.reload()
    },
    [activity, onRestore],
  )

  return createPortal(
    <div className={css.wrap}>
      {/*
        A real button so dismissing by pointer has a name, held out of the tab
        cycle because Escape is the keyboard way out — `Dialog`'s scrim, minus the
        tint. See note 1 above for why it does not darken.
      */}
      <button
        type="button"
        className={css.scrim}
        tabIndex={-1}
        aria-label="Close history"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={css.panel}
      >
        <header className={css.head}>
          <h2 id={titleId} className={css.title}>
            History
          </h2>
          <Button
            size="sm"
            variant="subtle"
            disabled={busy || naming}
            reason={naming ? 'Name the checkpoint below first' : 'A version request is in flight'}
            onClick={() => setNaming(true)}
          >
            New checkpoint
          </Button>
          <Button size="sm" variant="subtle" onClick={reloadBoth}>
            Reload
          </Button>
          <Button size="sm" variant="subtle" title="Close (Esc)" onClick={onClose}>
            Close
          </Button>
        </header>

        <div className={css.body}>
          <section className={`${css.section} ${css.versions}`} aria-labelledby={versionsId}>
            <div className={css.sectionHead}>
              <h3 id={versionsId} className={css.sectionTitle}>
                Versions
              </h3>
              <p className={css.note}>{VERSIONS_NOTE}</p>
            </div>

            {naming ? (
              <CheckpointForm onCancel={() => setNaming(false)} onSubmit={checkpoint} />
            ) : null}

            <TrailList
              trail={versions.trail}
              onMore={versions.more}
              onRetry={versions.reload}
              noun="versions"
              empty={
                <EmptyState
                  title="No versions yet"
                  body="Publishing saves one automatically. A checkpoint is one you name, and you can save one now."
                  action={
                    <Button size="sm" disabled={busy} onClick={() => setNaming(true)}>
                      New checkpoint
                    </Button>
                  }
                />
              }
            >
              {versions.trail.rows.map((version) => (
                <VersionRow
                  key={version.id}
                  version={version}
                  actor={actorForm(version.actor, names)}
                  busy={busy}
                  viewing={version.id === viewingId}
                  onView={onView}
                  onExitView={onExitView}
                  onRestore={restore}
                />
              ))}
            </TrailList>
          </section>

          <section className={`${css.section} ${css.activity}`} aria-labelledby={activityId}>
            <div className={css.sectionHead}>
              <h3 id={activityId} className={css.sectionTitle}>
                Activity
              </h3>
              <p className={css.note}>{ACTIVITY_NOTE}</p>
            </div>

            <TrailList
              trail={activity.trail}
              onMore={activity.more}
              onRetry={activity.reload}
              noun="edits"
              empty={
                <EmptyState
                  title="No edits recorded yet"
                  body="The log starts at the first keystroke on this document and is kept with it, so it is empty on a page nobody has typed into."
                />
              }
            >
              {activity.trail.rows.map((entry) => (
                <li key={entry.syncId} className={css.row}>
                  <span className={css.rowMain}>
                    <span className={css.rowTitle}>
                      {describeEdit(entry.mutations, doc, schema)}
                    </span>
                  </span>
                  <span className={css.rowMeta}>
                    <When at={entry.at} />
                    <Actor form={actorForm(entry.actor, names)} />
                  </span>
                </li>
              ))}
            </TrailList>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* -------------------------------------------------------------------- rows --- */

/** Four skeleton rows. Named rather than indexed, matching Content's and
 * Documents'. */
const SKELETON = ['h1', 'h2', 'h3', 'h4']

/**
 * One list, with its first-load skeleton, its empty state, its error line and its
 * `Show older` control. Both sections are the same shape, so the shape is written
 * once — which is what keeps "versions above, activity below" a matter of two
 * sections rather than two implementations.
 */
function TrailList<T>({
  trail,
  onMore,
  onRetry,
  noun,
  empty,
  children,
}: {
  trail: Trail<T>
  onMore: () => void
  onRetry: () => void
  /** Plural, for the count and the failure line. */
  noun: string
  empty: ReactNode
  children: ReactNode
}) {
  let body: ReactNode
  if (trail.loading && trail.rows.length === 0) {
    body = (
      <div className={css.skeletons} aria-hidden="true">
        {SKELETON.map((key) => (
          <div className={css.skeleton} key={key} />
        ))}
      </div>
    )
  } else if (trail.error !== undefined && trail.rows.length === 0) {
    body = (
      <EmptyState
        title={`Could not load ${noun}`}
        body={trail.error}
        action={
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    )
  } else if (trail.rows.length === 0) {
    body = empty
  } else {
    body = (
      <>
        <ul className={css.list}>{children}</ul>
        {/* A failure that arrived over rows already on screen: those rows are
            still true, so it is a line under them rather than an empty state
            replacing them. */}
        {trail.error === undefined ? null : <p className={css.error}>{trail.error}</p>}
        <div className={css.foot}>
          <span className={css.count}>
            {trail.rows.length} {noun} loaded
          </span>
          {trail.cursor === null ? null : (
            <Button size="sm" disabled={trail.loading} onClick={onMore}>
              {trail.loading ? 'Loading…' : 'Show older'}
            </Button>
          )}
        </div>
      </>
    )
  }
  return <div className={css.scroller}>{body}</div>
}

function VersionRow({
  version,
  actor,
  busy,
  viewing,
  onView,
  onExitView,
  onRestore,
}: {
  version: VersionMeta
  actor: ActorForm
  busy: boolean
  viewing: boolean
  onView: (version: VersionMeta) => Promise<void>
  onExitView: () => void
  onRestore: (version: VersionMeta) => Promise<void>
}) {
  const label = versionTitle(version)
  return (
    <li className={`${css.row} ${viewing ? css.rowViewing : ''}`}>
      <span className={css.rowMain}>
        <span className={css.rowTitle} title={label}>
          {label}
        </span>
        {/*
          The badge is drawn only for a version somebody named. `versionTitle`
          already falls back to "Published" / "Checkpoint", so on the common case —
          an unlabelled publish — a badge would repeat the row's own heading. On a
          named one it is the only thing telling "Before the rewrite" the
          checkpoint from "Before the rewrite" the publish.
        */}
        {version.label ? (
          <Badge tone={versionTone(version.kind)}>{versionKindLabel(version.kind)}</Badge>
        ) : null}
      </span>
      <span className={css.rowMeta}>
        <When at={version.createdAt} />
        <Actor form={actor} />
      </span>
      <span className={css.rowActions}>
        {viewing ? (
          <Button size="sm" variant="subtle" onClick={onExitView}>
            Stop viewing
          </Button>
        ) : (
          <Button
            size="sm"
            variant="subtle"
            disabled={busy}
            reason="A version request is in flight"
            title="Put this version on the stage. Nothing is changed."
            onClick={() => void onView(version)}
          >
            View
          </Button>
        )}
        {/*
          Restore is on every row, which is a change from the surface this
          replaces: `History.tsx` routed it through the preview banner so a version
          was always seen before it was applied. `ui-architecture.md` asks for
          "restore and checkpoint in place", and the guard the old arrangement was
          buying is cheaper than it looked — a restore is one transaction, so it
          syncs and ⌘Z undoes it, and a version identical to the draft is refused
          rather than applied. The title says both; the section's note says it once
          more.

          Rejected: a confirmation dialog. It would tell the reader this is the
          irreversible kind of action, which is exactly what it is not.
        */}
        <Button
          size="sm"
          variant="subtle"
          disabled={busy}
          reason="A version request is in flight"
          title="Apply the difference as one edit. It syncs to everyone here, and ⌘Z undoes it."
          onClick={() => void onRestore(version)}
        >
          Restore
        </Button>
      </span>
    </li>
  )
}

/** Relative, with the exact timestamp as its title — `historyWhen` argues the
 * coarseness and the escape from it. */
function When({ at }: { at: number }) {
  return (
    <time className={css.when} dateTime={new Date(at).toISOString()} title={historyExactly(at)}>
      {historyWhen(at)}
    </time>
  )
}

/**
 * The author of a row, in whichever of the four forms the string supports.
 * `actorForm` carries the reasoning; what is here is only how each one draws.
 *
 * A literal element per branch rather than one element with a computed tag or
 * `role`: an attribute chosen by an expression is an attribute Biome's a11y rules
 * cannot verify.
 */
function Actor({ form }: { form: ActorForm }) {
  switch (form.kind) {
    case 'none':
      // No actor at all — `auth: 'open'`. A row that said "by nobody" would report
      // the absence of a feature as a property of the edit.
      return null
    case 'name':
      return <span className={css.actor}>{form.label}</span>
    case 'token':
      return (
        <span className={css.actor}>
          {form.label}
          <Badge tone="neutral">API token</Badge>
        </span>
      )
    case 'id':
      return (
        <code
          className={css.actorId}
          title="This account has not edited the document since, so only its id is known here."
        >
          {form.label}
        </code>
      )
  }
}

/* -------------------------------------------------------------- checkpoint --- */

/**
 * Naming a checkpoint, in place.
 *
 * Escape closes the whole panel rather than only this form: `Esc dismisses the
 * topmost overlay` is the map's rule, the trap owns that key, and a form inside a
 * panel is not a second overlay. Cancel is the way out of the form alone.
 */
function CheckpointForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (label: string) => Promise<void>
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  return (
    <form
      className={css.checkpoint}
      onSubmit={(e) => {
        e.preventDefault()
        setSaving(true)
        void onSubmit(label.trim()).finally(() => setSaving(false))
      }}
    >
      <input
        // Focused through a ref callback rather than `autoFocus`, for the reason
        // note 2 gives: React applies `autoFocus` during commit, before the focus
        // trap reads `activeElement` to remember the opener.
        ref={(el) => el?.focus()}
        className={css.checkpointInput}
        type="text"
        value={label}
        placeholder="Name this checkpoint"
        aria-label="Checkpoint name"
        onChange={(e) => setLabel(e.target.value)}
      />
      <Button size="sm" variant="primary" type="submit" disabled={saving}>
        Save
      </Button>
      <Button size="sm" variant="subtle" disabled={saving} onClick={onCancel}>
        Cancel
      </Button>
    </form>
  )
}
