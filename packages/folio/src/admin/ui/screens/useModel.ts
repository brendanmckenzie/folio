import { useCallback, useEffect, useRef, useState } from 'react'
import type { StoryMeta } from '../../../core/story'
import type { MigrateReport, MigrationStatus } from '../../../server/migrate'
import type { Me } from '../../me'
import {
  type AuditBatch,
  type AuditState,
  canReadAudit,
  MAX_AUDIT_BATCHES,
  MAX_RUN_BATCHES,
  mergeAudits,
  mergeMigrateReports,
  type RunState,
  type StoryTitles,
} from './model-model'
import { messageOf } from './useContent'

/**
 * The Model screen's data: the migration ledger, a batched run, and a batched audit
 * walk.
 *
 * Both writes on this screen are **loops**, which is what makes this hook different
 * in kind from `useDocuments` and `useContent`. `POST /migrate` and `GET /audit`
 * each answer one batch and a `continueFrom`; a caller that reads the first
 * response and stops has migrated a prefix of the site or audited one. So the two
 * things here that are not `fetch` are:
 *
 *   - **progress is published per batch**, not at the end. A run over 5,000
 *     documents is 200 requests, and a screen that showed nothing until the last
 *     one is indistinguishable from a hung one.
 *   - **a ceiling on the loop**, because a cursor that stopped advancing would
 *     otherwise spin forever in somebody's tab. Hitting it leaves the report's own
 *     `continueFrom` non-null, which is what `isUnfinished` reads, so the screen
 *     reports a partial run as partial rather than as a success.
 *
 * Everything decidable — both merges, the wording, the permissions — is in
 * `model-model.ts` where a Node test reaches it.
 */

/**
 * Published documents per audit request.
 *
 * The route defaults to 100 and clamps at 500, and the screen names its own number
 * for the reason `useDocuments`' `PAGE` does: the page size is the *screen's*
 * decision. A hundred is deliberately modest — each document is JSON-parsed and
 * walked blok by blok, so this is the most expensive read per row in the admin, and
 * the first batch lands on page load whether or not anybody wanted the drift
 * report.
 */
const AUDIT_BATCH = 100

export interface ModelData {
  status: MigrationStatus | null
  statusLoading: boolean
  statusError?: string
  /** The most recent run or preview, or null when none has been started. */
  run: RunState | null
  audit: AuditState
  /** Re-read the ledger. */
  reload: () => void
  /** Run or preview the pending migrations, following the cursor to the end. */
  start: (opts: { dryRun: boolean }) => void
  /** Walk the audit from wherever it got to, to exhaustion. */
  continueAudit: () => void
}

export function useModel(apiBase: string, me: Me, onNotice: (message: string) => void): ModelData {
  /** Read once as a boolean so the effects below key on the answer rather than on
   * the identity of the `Me` object it came from. */
  const mayAudit = canReadAudit(me)

  const [status, setStatus] = useState<MigrationStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | undefined>(undefined)
  const [run, setRun] = useState<RunState | null>(null)
  const [audit, setAudit] = useState<AuditState>({ data: null, loading: true, batches: 0 })

  /**
   * Whether this hook's component is still mounted.
   *
   * `useDocuments` needs no such thing — one fetch, and a late `setState` on an
   * unmounted component is a warning nobody sees. A loop is different: navigating
   * away mid-run leaves up to 500 pending requests each writing state, so the flag
   * is what stops the walk rather than merely what stops the write.
   */
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  /** A run and an audit walk each refuse to start a second copy of themselves. */
  const running = useRef(false)
  const walking = useRef(false)

  const reload = useCallback(async () => {
    setStatusLoading(true)
    try {
      // No `?story=`: that parameter answers "is *this document* behind", which is
      // the editor's banner. This screen is the site-wide answer.
      const res = await fetch(`${apiBase}/migrations`)
      if (!res.ok) throw new Error(await messageOf(res))
      const next = (await res.json()) as MigrationStatus
      if (!live.current) return
      setStatus(next)
      setStatusError(undefined)
    } catch (e) {
      if (live.current) setStatusError((e as Error).message)
    } finally {
      if (live.current) setStatusLoading(false)
    }
  }, [apiBase])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * One audit batch, or the whole remaining walk.
   *
   * `from === null` starts over and discards what was held; a cursor continues from
   * it. `exhaust` decides whether one batch answers or the loop runs to the end.
   *
   * The accumulator is threaded through the loop rather than read back out of state,
   * because `setAudit` is asynchronous — the batch after next would otherwise merge
   * into whatever React had last committed and drop one.
   */
  const walk = useCallback(
    async (from: string | null, exhaust: boolean) => {
      if (walking.current) return
      walking.current = true
      setAudit((prev) => ({ ...prev, loading: true, error: undefined }))
      let total: AuditBatch | null = from === null ? null : audit.data
      let batches = from === null ? 0 : audit.batches
      let cursor = from
      try {
        for (let calls = 0; calls < MAX_AUDIT_BATCHES; calls++) {
          const params = new URLSearchParams({ batch: String(AUDIT_BATCH) })
          if (cursor) params.set('continueFrom', cursor)
          const res = await fetch(`${apiBase}/audit?${params}`)
          if (!res.ok) throw new Error(await messageOf(res))
          const batch = (await res.json()) as AuditBatch
          if (!live.current) return
          total = total === null ? batch : mergeAudits(total, batch)
          cursor = batch.continueFrom
          batches++
          // Per batch, so a long walk shows its document count climbing.
          setAudit({ data: total, loading: cursor !== null && exhaust, batches })
          if (cursor === null || !exhaust) break
        }
      } catch (e) {
        if (live.current) {
          setAudit((prev) => ({ ...prev, loading: false, error: (e as Error).message }))
        }
      } finally {
        walking.current = false
        if (live.current) setAudit((prev) => ({ ...prev, loading: false }))
      }
    },
    [apiBase, audit.data, audit.batches],
  )

  /**
   * The first batch, on mount — and **only** for an actor the route will answer.
   *
   * `GET /audit` is `ADMIN`, so asking as an editor would turn "this panel is not
   * for you" into a failed request on every load of a screen the sidebar offers to
   * everybody (`nav.ts` keeps Model visible for a non-admin deliberately: a
   * migration list explains a document being behind the model).
   *
   * One batch and then stop, rather than walking to exhaustion here. Opening this
   * screen must not become a full-site scan several requests deep for a panel the
   * visitor may only be here to read the migration half of — so the *screen* offers
   * the rest, and says how far the report actually reaches until it is asked.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `walk` closes over the accumulated report so it changes on every batch; depending on it here would re-run the first fetch after each merge. Keyed on `mayAudit` rather than on `me` for the same class of reason — a caller that rebuilt its `Me` object per render would otherwise restart the walk
  useEffect(() => {
    if (!mayAudit) {
      setAudit({ data: null, loading: false, batches: 0 })
      return
    }
    void walk(null, false)
  }, [apiBase, mayAudit])

  const continueAudit = useCallback(() => {
    const from = audit.data?.continueFrom ?? null
    // A cursor means "keep going", and that walks to the end — it is what the
    // screen's own button asked for. No cursor means this is the error path
    // retrying the *first* batch, and that stays one batch, the same restraint the
    // mount read has: a failed first request must not become a full-site scan.
    void walk(from, from !== null)
  }, [walk, audit.data])

  const start = useCallback(
    ({ dryRun }: { dryRun: boolean }) => {
      if (running.current) return
      running.current = true
      setRun({ dryRun, batches: 0, running: true, report: null })

      void (async () => {
        let cursor: string | null = null
        let total: MigrateReport | null = null
        let batches = 0
        try {
          for (let calls = 0; calls < MAX_RUN_BATCHES; calls++) {
            const res = await fetch(`${apiBase}/migrate`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // No `batch`: the runner's own default is chosen against the CPU
              // limit it exists to stay under, and a screen has no better
              // information about that than the runner does.
              body: JSON.stringify({ dryRun, continueFrom: cursor }),
            })
            if (!res.ok) throw new Error(await messageOf(res))
            const batch = (await res.json()) as MigrateReport
            if (!live.current) return
            total = total === null ? batch : mergeMigrateReports(total, batch)
            cursor = batch.continueFrom
            batches++
            setRun({ dryRun, batches, running: cursor !== null, report: total })
            if (cursor === null) break
          }
          if (cursor !== null) {
            // The ceiling, not the end of the table. `total.continueFrom` is still
            // set, so `isUnfinished` is true and the panel says the run is partial
            // — this notice explains why it stopped rather than what is left.
            onNotice(
              `Stopped after ${MAX_RUN_BATCHES} batches. The run is not finished; start it again to continue.`,
            )
          }
        } catch (e) {
          if (live.current) {
            setRun({ dryRun, batches, running: false, report: total, error: (e as Error).message })
          }
          onNotice((e as Error).message)
        } finally {
          running.current = false
          if (live.current) {
            setRun((prev) => (prev ? { ...prev, running: false } : prev))
            void reload()
            /**
             * A real run rewrote published documents, so every audit tally it
             * touched is stale — and the drift it *fixed* is the number somebody is
             * about to look at to see whether it worked. One batch, not the whole
             * walk, for the same reason the mount read is one batch.
             */
            if (!dryRun && mayAudit) void walk(null, false)
          }
        }
      })()
    },
    [apiBase, mayAudit, onNotice, reload, walk],
  )

  return { status, statusLoading, statusError, run, audit, reload, start, continueAudit }
}

/**
 * Titles for the documents the audit panel is about to link, so a finding names a
 * page rather than a hex id.
 *
 * **The screen resolves these, not the report.** Carrying `title` on the audit's
 * batch reader was the first attempt and it was reverted — `server/stories.ts`'s
 * `PublishedDocRow` carries that argument: it denormalises a column into a reporting
 * module with no other use for it, and `reindex`, the other caller, would pay the
 * wider projection for nothing. `GET {base}/api/stories?ids=` already resolves a
 * batch of ids to full rows and chunks above D1's bind limit, which is exactly what
 * decision 7 built it for.
 *
 * Three properties, all of which the panel depends on:
 *
 *   - **It never blocks a finding.** Separate state from the audit walk, so the
 *     findings render on the batch that produced them and the labels arrive a moment
 *     later. A report that waited on a second round trip to draw at all would be a
 *     slower screen for a nicety.
 *   - **It asks only for what it does not hold**, so `Audit the rest` costs one
 *     request for the new ids rather than re-resolving the whole set — and the
 *     labels already on screen do not blink while it is in flight.
 *   - **An id that comes back absent is recorded as absent**, not left unknown. That
 *     is what stops the loop: `?ids=` answers a deleted row by omission, so an
 *     unrecorded miss would stay in `wanted` and be re-requested on every render.
 */
export function useStoryTitles(apiBase: string, ids: readonly string[]): StoryTitles {
  const [known, setKnown] = useState<Record<string, string | null>>({})

  /**
   * The ids still owed, as the string that goes on the wire.
   *
   * Serialised rather than kept as an array, because `ids` is derived per render and
   * a fresh array would restart the effect every time — the same reason
   * `useDocuments` keys its fetch on `documentsParams(...).toString()`.
   */
  const wanted = ids.filter((id) => !(id in known)).join(',')

  useEffect(() => {
    if (wanted === '') return
    let live = true
    const query = new URLSearchParams({ ids: wanted })
    fetch(`${apiBase}/stories?${query}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ rows: StoryMeta[] }>) : { rows: [] }))
      .then(({ rows }) => {
        if (!live) return
        // `title || slug` is the same label `chainOf` gives a breadcrumb crumb, minus
        // its `|| id` fallback: null here means "nothing better than the id", and the
        // row is what decides how to draw that.
        const found = new Map(rows.map((row) => [row.id, row.title || row.slug || null]))
        setKnown((prev) => {
          const next = { ...prev }
          for (const id of wanted.split(',')) next[id] = found.get(id) ?? null
          return next
        })
      })
      .catch(() => {
        // Left unknown, so the rows keep their ids. No retry and no notice: a label
        // is decoration, and a toast about it would be noise over a working panel.
        // `wanted` is unchanged, so the effect does not re-fire.
      })
    return () => {
      live = false
    }
  }, [apiBase, wanted])

  return known
}
