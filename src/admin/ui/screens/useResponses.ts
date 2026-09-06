import { useCallback, useEffect, useState } from 'react'
import type { ResponsePage } from '../../../server/form-responses'
import type { Form } from '../../../server/forms'
import { type ResponsesUrl, responsesParams } from './responses-model'
import { messageOf } from './useContent'

/**
 * The Responses screen's data: the form it is about, and one page of its
 * submissions.
 *
 * `useRedirects`' shape — one page, a cursor stack for *previous*, a debounced
 * search term, a reload — plus one thing neither of the other list hooks needs:
 * **the form itself**, because the table's columns are the form's current
 * questions (decision 16) and the drawer marks the keys the form no longer
 * declares (decision 7). Both are facts about the form, not about a row, so a
 * screen that only read responses could not draw either.
 *
 * The two are fetched separately and only the page re-fetches on a filter
 * keystroke: a form is read once per screen and changes when somebody saves the
 * builder, which is not something this screen can do.
 */

/** Rows per request. The route defaults to 50 and clamps at 200. */
const PAGE = 50

/** How long the search box waits before it is a request. The same 150ms
 *  `useRedirects` and `useDocuments` use, and for their reason: the header asks
 *  `?count=1`, so an undebounced box drags a `count(*)` behind every keystroke —
 *  and here that count is over a table with no upper bound. */
const DEBOUNCE_MS = 150

export interface ResponsesData {
  /** The form, for its questions and its label. Null while the first fetch is in
   *  flight or the id is unknown. */
  form: Form | null
  formError?: string
  formLoading: boolean
  page: ResponsePage & { loading: boolean; error?: string }
  canGoBack: boolean
  nextPage: () => void
  prevPage: () => void
  /** Re-read the current page, after a delete. */
  reload: () => void
}

export function useResponses(apiBase: string, id: string, url: ResponsesUrl): ResponsesData {
  const [form, setForm] = useState<Form | null>(null)
  const [formState, setFormState] = useState<{ loading: boolean; error?: string }>({
    loading: true,
  })
  const [page, setPage] = useState<ResponsesData['page']>({
    rows: [],
    cursor: null,
    loading: true,
  })
  const [cursor, setCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly (string | null)[]>([])

  useEffect(() => {
    let live = true
    setFormState({ loading: true })
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/forms/${encodeURIComponent(id)}`)
        if (!res.ok) throw new Error(await messageOf(res))
        const answer = (await res.json()) as Form
        if (!live) return
        setForm(answer)
        setFormState({ loading: false })
      } catch (e) {
        if (!live) return
        setForm(null)
        setFormState({ loading: false, error: (e as Error).message })
      }
    })()
    return () => {
      live = false
    }
  }, [apiBase, id])

  // Only `q` is debounced. A date is one deliberate gesture and should answer at
  // once; a search term arrives one character at a time and its intermediate
  // states are not states anybody asked to see.
  const q = useDebounced(url.q)
  const settled = { ...url, q }
  const params = responsesParams(settled, { limit: PAGE, cursor, count: true }).toString()

  const fetchPage = useCallback(async () => {
    setPage((prev) => ({ ...prev, loading: true }))
    try {
      const res = await fetch(`${apiBase}/forms/${encodeURIComponent(id)}/responses?${params}`)
      if (!res.ok) throw new Error(await messageOf(res))
      setPage({ ...((await res.json()) as ResponsePage), loading: false })
    } catch (e) {
      setPage({ rows: [], cursor: null, loading: false, error: (e as Error).message })
    }
  }, [apiBase, id, params])

  useEffect(() => {
    void fetchPage()
  }, [fetchPage])

  /**
   * A filter change invalidates the cursor stack: it is a different set, so a
   * cursor from the old one resumes at a position that no longer exists.
   *
   * Keyed on the request *minus* the cursor — the same string the fetch uses,
   * with the one parameter allowed to change without a reset taken out. Deriving
   * it rather than listing the three filters keeps a fourth from being added
   * without a reset.
   */
  const identity = responsesParams(settled, { limit: PAGE, count: true }).toString()
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

  return {
    form,
    ...(formState.error === undefined ? {} : { formError: formState.error }),
    formLoading: formState.loading,
    page,
    canGoBack: history.length > 0,
    nextPage,
    prevPage,
    reload: fetchPage,
  }
}

/** A value that trails its input by `DEBOUNCE_MS`. The fourth copy of six lines,
 *  and it stays local for `useRedirects`' stated reason: this belongs in `ui/`
 *  the moment something other than a search box wants it, and a shared hook with
 *  one shape and four identical callers is a decision that can be made in one
 *  edit later. */
function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [value])
  return settled
}
