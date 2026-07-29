import { useEffect, useState } from 'react'

/**
 * What points at a document, for the confirmation shown before deleting it
 * (`../../../docs/specs/content-model/data-documents.md` architecture decision
 * 4).
 *
 * Published references only, and the dialog says so out loud.
 */
export interface DocumentUsage {
  published: { id: string; title: string; path: string | null; url: string; kind: string }[]
  /** Distinct published documents — what "Used on N published pages" counts. */
  total: number
  links: number
  references: number
}

export const NO_USAGE: DocumentUsage = { published: [], total: 0, links: 0, references: 0 }

export interface UsageState {
  usage: DocumentUsage | null
  loading: boolean
}

/**
 * Fetched when the confirmation opens, not with the tree: it costs a query over
 * `content_refs` and is only ever wanted at the moment somebody is about to
 * delete something.
 *
 * A transport failure resolves to `null` rather than to zero. The difference
 * matters: `NO_USAGE` says "nothing uses this", and reporting that because a
 * request failed would turn a warning into a false reassurance, which is the one
 * way this dialog could do harm. The dialog draws nothing in that case and the
 * delete still proceeds — it warns, it does not gate.
 */
export function useDocumentUsage(apiBase: string, storyId: string | null): UsageState {
  const [state, setState] = useState<UsageState>({ usage: null, loading: false })

  useEffect(() => {
    if (!storyId) {
      setState({ usage: null, loading: false })
      return
    }
    let live = true
    setState({ usage: null, loading: true })
    void fetch(`${apiBase}/documents/${encodeURIComponent(storyId)}/usage`)
      .then(async (res) => (res.ok ? ((await res.json()) as DocumentUsage) : null))
      .catch(() => null)
      .then((usage) => {
        if (live) setState({ usage, loading: false })
      })
    return () => {
      live = false
    }
  }, [apiBase, storyId])

  return state
}
