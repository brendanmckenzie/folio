import { useCallback, useEffect, useState } from 'react'
import type { Page } from '../../../core/pagination'
import type { StoryMeta } from '../../../core/story'
import {
  type ResolvedSchedule,
  type ScheduleRow,
  type SchedulesUrl,
  schedulesParams,
} from './schedules-model'
import { messageOf } from './useContent'

/**
 * The Schedules screen's data: one page of the `schedules` table, with each row's
 * document title joined on.
 *
 * The same cursor-stack shape as `useRedirects` and `useDocuments`, plus one thing
 * neither of them needs — **a second request to resolve titles.** `Schedule` carries
 * no title and no path on purpose (`server/routes/schedules.ts`'s own comment: a join
 * there would denormalise two columns into a reader with no other use for them), and
 * `GET {base}/api/stories?ids=` exists precisely to batch that lookup. So this is two
 * round trips by design rather than by omission, which is what
 * `docs/specs/platform/scheduled-publishing.md`'s deferred-work note describes.
 *
 * **The titles arrive second and the rows are shown first.** A schedule list whose
 * every row waited on a second request would be blank for two round trips instead of
 * one, and the columns that matter for triage — when, what, and whether it is overdue
 * — are all in the first response. `titleOf` renders the gap.
 */

/** Rows per request. The route defaults to 50 and clamps at 200. */
const PAGE = 50

export interface SchedulesData {
  page: Page<ResolvedSchedule> & { loading: boolean; error?: string }
  canGoBack: boolean
  nextPage: () => void
  prevPage: () => void
  reload: () => void
}

export function useSchedules(apiBase: string, url: SchedulesUrl): SchedulesData {
  const [page, setPage] = useState<SchedulesData['page']>({
    rows: [],
    cursor: null,
    loading: true,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly (string | null)[]>([])

  // Serialised, because a fresh object every render would restart the effect. The
  // string is also exactly what goes on the wire, so there is no second
  // representation to keep in step.
  const params = schedulesParams(url, { limit: PAGE, cursor, count: true }).toString()

  const fetchPage = useCallback(async () => {
    setPage((prev) => ({ ...prev, loading: true }))
    try {
      const res = await fetch(`${apiBase}/schedules?${params}`)
      if (!res.ok) throw new Error(await messageOf(res))
      const answer = (await res.json()) as Page<ScheduleRow>
      // Shown without titles, then again with them. See the header comment.
      setPage({ ...answer, loading: false })
      const titles = await resolveTitles(apiBase, answer.rows)
      // `null` is a *failed* lookup, and merging it would mark every row on the
      // screen as a deleted document. Leaving the titles unresolved shows the story
      // ids instead, which is what the rows actually contain.
      if (titles === null) return
      setPage((prev) => ({
        ...prev,
        rows: prev.rows.map((row) => ({
          ...row,
          title: titles.get(row.storyId),
          missing: !titles.has(row.storyId),
        })),
      }))
    } catch (e) {
      setPage({ rows: [], cursor: null, loading: false, error: (e as Error).message })
    }
  }, [apiBase, params])

  useEffect(() => {
    void fetchPage()
  }, [fetchPage])

  /**
   * A filter change invalidates the cursor stack: it is a different set, so a cursor
   * from the old one would resume at a position that no longer exists. Keyed on the
   * request minus the cursor, deriving it rather than listing the filters, which is
   * what stops a third filter being added without a reset.
   */
  const identity = schedulesParams(url, { limit: PAGE, count: true }).toString()
  // biome-ignore lint/correctness/useExhaustiveDependencies: `identity` is the trigger, not a value the body reads — it only clears. Naming it is the point; reading it to satisfy the rule would misstate what this depends on
  useEffect(() => {
    setCursor(null)
    setHistory([])
  }, [identity])

  const nextPage = useCallback(() => {
    if (!page.cursor) return
    setHistory((prev) => [...prev, cursor])
    setCursor(page.cursor)
  }, [page.cursor, cursor])

  const prevPage = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev
      setCursor(prev[prev.length - 1] ?? null)
      return prev.slice(0, -1)
    })
  }, [])

  return { page, canGoBack: history.length > 0, nextPage, prevPage, reload: fetchPage }
}

/**
 * Story titles by id for the rows on screen, or **null when the lookup failed**.
 *
 * That distinction is the whole signature. A failure and an answer-with-no-match are
 * different facts about a row, and returning an empty map for both is what made the
 * first version of this render every row as "Deleted document" the moment the second
 * request 500'd. Null means "we do not know"; an empty entry in a non-null map means
 * "we asked and it is gone".
 *
 * Deduplicated, because two rows for one document is the *normal* case — a campaign
 * window is a publish and an unpublish on one page, so an undeduplicated list asks
 * for half of them twice.
 *
 * **A failure is not an error state.** The rows are already displayed and every
 * column that matters for triage is in them; turning "the title lookup failed" into
 * an error page would hide a list of overdue schedules behind a message about a
 * cosmetic join.
 */
async function resolveTitles(
  apiBase: string,
  rows: readonly ScheduleRow[],
): Promise<Map<string, string> | null> {
  const ids = [...new Set(rows.map((row) => row.storyId))]
  if (ids.length === 0) return new Map()
  try {
    const res = await fetch(`${apiBase}/stories?ids=${ids.map(encodeURIComponent).join(',')}`)
    if (!res.ok) return null
    // `{ rows }`, not a bare array: the `?ids=` branch merges an optional ancestor
    // chain into the same envelope, so it has a key rather than being one.
    const { rows: stories } = (await res.json()) as { rows: StoryMeta[] }
    return new Map(stories.map((story) => [story.id, story.title]))
  } catch {
    return null
  }
}
