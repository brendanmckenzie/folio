import { useCallback, useEffect, useMemo, useState } from 'react'
import { diff, summariseDiff } from '../../core/diff'
import type { Doc } from '../../core/doc'
import { type ActivityEntry, MAX_TX_MUTATIONS } from '../../core/protocol'
import type { VersionMeta } from '../../server/versions'
import { afterWrite, expectOk, send } from '../api'
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
}

interface Options {
  store: StoryStore
  apiBase: string
  storyId: string
  /** The live draft, for the delta against the version being viewed. */
  liveDoc: Doc | null
  notify: Notify
  /** True while the History rail is open: the lists load when it is. */
  active: boolean
}

/**
 * Versions, activity, and the read-only preview of a past version.
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
}: Options): Versions {
  const [versions, setVersions] = useState<VersionMeta[]>([])
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<{ version: VersionMeta; doc: Doc } | null>(null)

  const reload = useCallback(async () => {
    const [v, a] = await Promise.all([
      fetch(`${apiBase}/story/${encodeURIComponent(storyId)}/versions`),
      fetch(`${apiBase}/story/${encodeURIComponent(storyId)}/activity`),
    ])
    if (v.ok) setVersions((await v.json()) as VersionMeta[])
    if (a.ok) setActivity((await a.json()) as ActivityEntry[])
  }, [apiBase, storyId])

  useEffect(() => {
    if (active) void reload()
  }, [active, reload])

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
    activity,
    busy,
    source,
    viewing,
    delta,
    reload,
    checkpoint,
    view,
    exit,
    restore,
  }
}
