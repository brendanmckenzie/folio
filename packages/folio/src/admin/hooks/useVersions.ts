import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { diff, summariseDiff } from '../../core/diff'
import type { Doc } from '../../core/doc'
import type { Page } from '../../core/pagination'
import { type ActivityEntry, MAX_TX_MUTATIONS } from '../../core/protocol'
import type { VersionMeta } from '../../server/versions'
import { afterWrite, expectJson, expectOk, send } from '../api'
import type { StoryStore } from '../store'
import type { Notify } from './useNotice'

/**
 * What the preview iframe is showing. The editor has exactly two modes and this
 * hook is their only owner: everything that has to behave differently while a
 * past version is on screen — the store-to-iframe seam, undo, the inspector,
 * publish — reads it from here rather than keeping its own guard.
 */
export type PreviewMode = 'live' | 'viewing'

export interface PreviewSource {
  mode: PreviewMode
  /**
   * The version's document while `mode` is 'viewing', null while live. The
   * document and not just a flag, so an iframe reload mid-preview can be
   * re-seeded with the version rather than with the live draft.
   */
  doc: Doc | null
}

const LIVE: PreviewSource = { mode: 'live', doc: null }

/* ------------------------------------------------------------------ paging --- */

/**
 * A paged list that **appends**, plus everything a control over it needs.
 *
 * Both halves of history page by cursor and, until port phase 7c, neither had a
 * control: the cursor was fetched and thrown away, so a story with more than fifty
 * versions had forty-nine of them unreachable. The slide-over is where that gets
 * fixed (`ui-architecture.md`, the editor), and the state has to live *here* rather
 * than in the panel — a second copy in the panel is a copy that disagrees with this
 * one the moment a checkpoint is written, since `checkpoint` and `restore` refresh
 * what this hook holds and nothing else.
 *
 * Appending rather than next / previous, which is every other list in this admin
 * (`ui-architecture.md` Resolved 5): both of these are one **chronology**, and the
 * newest row is the reference point every other row is understood against — a
 * version list is read as "what changed since *that*", which is the same comparison
 * the amber frame and the top bar are showing. Paging the newest publish off the top
 * would remove the thing being compared to. `content-model.ts`'s `Level` reaches the
 * same control for a tree level, for a structural reason rather than a temporal one.
 */
export interface Trail<T> {
  rows: readonly T[]
  /** Null when the list is fully loaded. */
  cursor: string | null
  /**
   * No page has landed yet, or one is in flight. Initially true, which is what a
   * skeleton wants: an empty list that has not been asked for yet must not draw as
   * an empty list that has.
   */
  loading: boolean
  /** A failed read, so a reader can say so instead of looking empty. */
  error?: string
  /** Appends the next page. A no-op on the last page and while one is in flight. */
  more: () => Promise<void>
  /** Back to page one, discarding the tail. */
  reload: () => Promise<void>
}

interface TrailState<T> {
  rows: T[]
  cursor: string | null
  loading: boolean
  error?: string
}

/**
 * A held list plus the page that continues it.
 *
 * Deduplicated by key, which is not defensive padding: a checkpoint saved from the
 * History panel between two pages of the same list would otherwise appear twice,
 * because the keyset moved under the cursor.
 *
 * Exported because it is the one part of the paging that is decidable without a
 * `fetch`, and the admin's convention is that such a part is a pure function with a
 * Node test rather than a branch inside a hook nothing mounts.
 */
export function appendRows<T>(
  held: readonly T[],
  incoming: readonly T[],
  keyOf: (row: T) => string | number,
): T[] {
  const seen = new Set(held.map(keyOf))
  const out = [...held]
  for (const row of incoming) {
    const key = keyOf(row)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

const versionKey = (row: VersionMeta) => row.id
const activityKey = (row: ActivityEntry) => row.syncId

/**
 * One paged, appending list over a `Page<T>` route.
 *
 * `auto` decides whether page one is read on mount. Both callers need a different
 * answer and both answers are load-bearing: the version list loads unconditionally
 * because `usePublishedDoc` needs the newest `publish` version on every load of the
 * story, and the activity trail loads only when History is open because nothing else
 * reads it.
 */
function useTrail<T>(url: string, keyOf: (row: T) => string | number, auto: boolean) {
  const [state, setState] = useState<TrailState<T>>({ rows: [], cursor: null, loading: true })
  const live = useRef(true)
  // Set on the way in as well as cleared on the way out: StrictMode mounts, cleans
  // up and mounts again, so a flag that was only ever cleared would leave the second
  // mount permanently unable to apply a response. `StoryStore.connect` and
  // `spaceStore` both carry a note about the same double mount.
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const read = useCallback(
    async (from: string | null) => {
      setState((prev) => ({ ...prev, loading: true, error: undefined }))
      try {
        const res = await fetch(from === null ? url : `${url}?cursor=${encodeURIComponent(from)}`)
        const page = await expectJson<Page<T>>(res)
        if (!live.current) return
        setState((prev) => ({
          // `from === null` is a reload and replaces; a cursor appends. The held rows
          // come from `prev` rather than from the closure, so two reads in flight
          // cannot drop one another's page.
          rows: from === null ? page.rows : appendRows(prev.rows, page.rows, keyOf),
          cursor: page.cursor,
          loading: false,
        }))
      } catch (e) {
        if (live.current) {
          setState((prev) => ({ ...prev, loading: false, error: (e as Error).message }))
        }
      }
    },
    [keyOf, url],
  )

  useEffect(() => {
    if (auto) void read(null)
  }, [auto, read])

  const reload = useCallback(() => read(null), [read])
  const more = useCallback(
    () => (state.cursor === null || state.loading ? Promise.resolve() : read(state.cursor)),
    [read, state.cursor, state.loading],
  )

  const trail = useMemo<Trail<T>>(
    () => ({
      rows: state.rows,
      cursor: state.cursor,
      loading: state.loading,
      ...(state.error === undefined ? {} : { error: state.error }),
      more,
      reload,
    }),
    [more, reload, state],
  )

  return { rows: state.rows, reload, trail }
}

/* ---------------------------------------------------------------- versions --- */

export interface VersionsList {
  versions: VersionMeta[]
  reload: () => Promise<void>
  /**
   * The same rows, plus the cursor and the control over it. One state read two
   * ways rather than two states: `versions` is the shape `usePublishedDoc` and the
   * old `Editor.tsx` already read, and `trail` is what a paging consumer needs.
   */
  trail: Trail<VersionMeta>
}

/**
 * The version list alone, loaded unconditionally rather than only while the
 * History rail is open: `usePublishedDoc` needs the newest `publish` version
 * on every load of the story, not only once an editor opens History
 * (`unpublished-changes.md`'s phase 1 note on `useVersions`). `Editor.tsx`
 * owns one of these and hands the list to both `usePublishedDoc` and
 * `useVersions` below, so there is exactly one fetch of it, not two
 * disagreeing copies.
 *
 * The cursor is kept rather than discarded, and that is the whole of what port
 * phase 7c added here: the newest publish still arrives on the first page, so
 * `usePublishedDoc` is untouched, and "show older" is now expressible by whoever
 * draws the list. `Trail` argues why the control appends.
 */
export function useVersionsList(apiBase: string, storyId: string): VersionsList {
  // `Page<VersionMeta>` since `foundation/pagination.md` phase 4.
  const { rows, reload, trail } = useTrail<VersionMeta>(
    `${apiBase}/story/${encodeURIComponent(storyId)}/versions`,
    versionKey,
    true,
  )
  return { versions: rows, reload, trail }
}

export interface Versions {
  versions: VersionMeta[]
  activity: ActivityEntry[]
  /** A version request is in flight; the History controls stay disabled. */
  busy: boolean
  source: PreviewSource
  /** The version on screen, for the banner and the list's highlight. */
  viewing: { version: VersionMeta; doc: Doc } | null
  /** How the live draft differs from the version being viewed. */
  delta: ReturnType<typeof summariseDiff> | null
  reload: () => Promise<void>
  checkpoint: (label: string) => Promise<void>
  view: (version: VersionMeta) => Promise<void>
  exit: () => void
  restore: (version: VersionMeta, preloaded?: Doc) => Promise<void>
  /**
   * The same rows as `activity`, plus the cursor and the control over it — the
   * activity half of what `VersionsList.trail` is for the versions half.
   *
   * The trail is the one that most needed a control: the log grows with every
   * transaction, so a story anybody has worked in for an afternoon has more than
   * one page of it.
   */
  activityTrail: Trail<ActivityEntry>
}

interface Options {
  store: StoryStore
  apiBase: string
  storyId: string
  /** The live draft, for the delta against the version being viewed. */
  liveDoc: Doc | null
  notify: Notify
  /** True while the History rail is open: the activity trail loads when it is. */
  active: boolean
  /** The version list `useVersionsList` already loaded, for the History rail
   * and the viewing/restore machinery below. */
  versions: VersionMeta[]
  reloadVersions: () => Promise<void>
}

/**
 * Activity, the read-only preview of a past version, and everything that acts
 * on the version list `Editor.tsx` already loaded via `useVersionsList`.
 *
 * Previewing leaves the store untouched. The version's document is pushed into
 * the iframe by the preview bridge and live mutations stop being forwarded, so
 * they cannot corrupt what is on screen.
 */
export function useVersions({
  store,
  apiBase,
  storyId,
  liveDoc,
  notify,
  active,
  versions,
  reloadVersions,
}: Options): Versions {
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<{ version: VersionMeta; doc: Doc } | null>(null)

  /**
   * `Page<ActivityEntry>`, matching the versions route beside it — the two used to
   * disagree, one answering `{ rows }` and the other a bare array.
   *
   * `active` is the `auto` flag, so the trail reads page one exactly when History
   * opens: the same condition the effect below used to express, now expressed once
   * and by the thing that owns the state.
   */
  const activityTrail = useTrail<ActivityEntry>(
    `${apiBase}/story/${encodeURIComponent(storyId)}/activity`,
    activityKey,
    active,
  )

  /**
   * Both lists, back to page one. Every write in this hook goes through it, which is
   * what stops a checkpoint made from the History panel being absent from the list
   * beside the button that made it.
   */
  const reload = useCallback(async () => {
    await Promise.all([reloadVersions(), activityTrail.reload()])
  }, [activityTrail, reloadVersions])

  // The version half only: the activity half is `active`-driven above. Kept so that
  // opening History still refreshes the version list, which is what it has always
  // done — a peer may have published since the editor loaded.
  useEffect(() => {
    if (active) void reloadVersions()
  }, [active, reloadVersions])

  const checkpoint = useCallback(
    async (label: string) => {
      setBusy(true)
      try {
        await expectOk(
          await send(`${apiBase}/story/${encodeURIComponent(storyId)}/versions`, 'POST', {
            label,
            actor: store.name,
          }),
        )
        // Through `afterWrite`: the checkpoint is written, so a failed re-read
        // of the lists is not the checkpoint failing (see admin/api.ts).
        await afterWrite(reload())
      } catch (e) {
        notify((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [apiBase, notify, reload, store.name, storyId],
  )

  const fetchDoc = useCallback(
    async (version: VersionMeta): Promise<Doc | null> => {
      const res = await fetch(`${apiBase}/versions/${encodeURIComponent(version.id)}`)
      if (!res.ok) {
        notify('Could not load that version.')
        return null
      }
      return ((await res.json()) as { doc: Doc }).doc
    },
    [apiBase, notify],
  )

  const view = useCallback(
    async (version: VersionMeta) => {
      setBusy(true)
      try {
        const doc = await fetchDoc(version)
        if (!doc) return
        setViewing({ version, doc })
        store.select(null)
      } finally {
        setBusy(false)
      }
    },
    [fetchDoc, store],
  )

  const exit = useCallback(() => {
    setViewing(null)
    store.select(store.getSnapshot().doc?.root ?? null)
  }, [store])

  /**
   * Restore does not overwrite the document. It diffs the live document against
   * the version and applies the result as one transaction, so the restore
   * reaches other editors and Cmd+Z undoes it.
   */
  const restore = useCallback(
    async (version: VersionMeta, preloaded?: Doc) => {
      const live = store.getSnapshot().doc
      if (!live) return
      setBusy(true)
      try {
        const target = preloaded ?? (await fetchDoc(version))
        if (!target) return
        const mutations = diff(live, target)
        if (mutations.length === 0) {
          notify('Already identical to that version.')
          return
        }
        // A restore is one transaction so it lands and undoes as a single step;
        // that means it is also one shot at the wire caps, with no chunking to
        // fall back on (see MAX_TX_MUTATIONS in core/protocol). A restore this
        // large is rare enough that refusing it up front, rather than splitting
        // it into several separately-undoable transactions, is the simpler and
        // more honest failure.
        if (mutations.length > MAX_TX_MUTATIONS) {
          notify(
            `This restore touches ${mutations.length} things at once, over the ` +
              `${MAX_TX_MUTATIONS} the sync engine allows in one step. Try restoring a ` +
              'version with a smaller difference from the live page.',
          )
          return
        }
        // Leave preview first so the live document flows to the iframe again.
        setViewing(null)
        if (!store.tx(mutations)) {
          notify('That restore could not be sent: it is too large to sync. Nothing changed.')
          return
        }
        const s = summariseDiff(mutations)
        notify(
          `Restored: ${[
            s.edited && `${s.edited} edited`,
            s.added && `${s.added} added`,
            s.removed && `${s.removed} removed`,
            s.moved && `${s.moved} moved`,
          ]
            .filter(Boolean)
            .join(', ')}. Cmd+Z to undo.`,
        )
        // The transaction has landed and synced, and the notice above says so.
        // A failed refresh must not replace it with a fetch error about a
        // restore that did happen.
        await afterWrite(reload())
      } catch (e) {
        notify((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [fetchDoc, notify, reload, store],
  )

  const source = useMemo<PreviewSource>(
    () => (viewing ? { mode: 'viewing', doc: viewing.doc } : LIVE),
    [viewing],
  )

  const delta = useMemo(() => {
    if (!viewing || !liveDoc) return null
    try {
      return summariseDiff(diff(liveDoc, viewing.doc))
    } catch {
      return null
    }
  }, [liveDoc, viewing])

  return {
    versions,
    activity: activityTrail.rows,
    busy,
    source,
    viewing,
    delta,
    reload,
    checkpoint,
    view,
    exit,
    restore,
    activityTrail: activityTrail.trail,
  }
}
