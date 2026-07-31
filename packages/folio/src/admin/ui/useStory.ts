import { useEffect, useState } from 'react'
import type { DocumentType } from '../../core/schema'
import { ancestorPaths, type StoryMeta } from '../../core/story'

/**
 * One document and its ancestors, by id.
 *
 * **This is what replaced the shell's whole-tree fetch.** The shell needs exactly
 * three things about the open document — the row itself, so `/edit/:id` resolves
 * to something; its ancestor chain, for the breadcrumb; and its type, to decide
 * what sits above it — and it used to get all three by holding every story on the
 * site. `GET {base}/api/stories?ids=&ancestors=1` answers precisely that set in one
 * request (`docs/specs/foundation/pagination.md` decision 7), which is the same
 * narrowing `resolve()` already does server-side.
 *
 * The ancestors come back in the same response rather than from a second call,
 * because the caller cannot compute `ancestorPaths` until it knows the row's
 * `path` — so asking separately would be two sequential round trips for something
 * the server has in hand after the first query.
 */
export interface OpenStory {
  story: StoryMeta | undefined
  /** Root first, the document itself last — the breadcrumb's chain. */
  chain: { id: string; title: string }[]
  loading: boolean
}

const NOTHING: OpenStory = { story: undefined, chain: [], loading: false }

export function useStory(apiBase: string, id: string | undefined): OpenStory {
  const [state, setState] = useState<OpenStory>(id ? { ...NOTHING, loading: true } : NOTHING)

  useEffect(() => {
    if (!id) {
      setState(NOTHING)
      return
    }
    let live = true
    setState((prev) => ({ ...prev, loading: true }))
    const query = new URLSearchParams({ ids: id, ancestors: '1' })
    fetch(`${apiBase}/stories?${query}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ rows: StoryMeta[] }>) : { rows: [] }))
      .then(({ rows }) => {
        if (!live) return
        const story = rows.find((row) => row.id === id)
        setState({ story, chain: story ? chainOf(rows, story) : [], loading: false })
      })
      .catch(() => {
        if (live) setState({ ...NOTHING, loading: false })
      })
    return () => {
      live = false
    }
  }, [apiBase, id])

  return state
}

/**
 * A document's ancestors, root first, itself last.
 *
 * Ordered **by path** rather than by walking `parentId`, and that is the change
 * paging forced. The old version walked the parent chain through a flat list of
 * every story; the rows here are only the document and its ancestors, so there is
 * no list to walk — but a path *is* the ancestor chain, which is the whole reason
 * `ancestorPaths` exists and the reason the server can fetch them in one query.
 *
 * An unrouted document has no path and therefore no chain: a record's way back is
 * its type's list, and a global has nothing above it at all. Both are the
 * breadcrumb's `root`, decided by the caller, which knows the content model.
 *
 * Pure and exported so the ordering is tested in Node without a fetch.
 */
export function chainOf(
  rows: readonly StoryMeta[],
  node: StoryMeta,
): { id: string; title: string }[] {
  const label = (row: StoryMeta) => row.title || row.slug || row.id
  if (node.path === null) return [{ id: node.id, title: label(node) }]
  const byPath = new Map(rows.filter((r) => r.path !== null).map((r) => [r.path, r]))
  const out = ancestorPaths(node.path)
    .map((path) => byPath.get(path))
    .filter((row): row is StoryMeta => row !== undefined)
    .map((row) => ({ id: row.id, title: label(row) }))
  out.push({ id: node.id, title: label(node) })
  return out
}

/**
 * A story row by path, for the one caller that has a path and needs a URL: a
 * global's preview.
 *
 * `globalPreviewUrl` below puts a singleton's draft on top of a real host page via
 * `&as=<name>`, and it finds that page by `type.previewPath`. It used to search the
 * whole tree for it; now it asks for the one row.
 */
export function usePreviewHost(apiBase: string, path: string | undefined): StoryMeta | undefined {
  const [row, setRow] = useState<StoryMeta | undefined>(undefined)

  useEffect(() => {
    if (path === undefined) {
      setRow(undefined)
      return
    }
    let live = true
    // `paths` rather than `ids`, and an empty string is a legitimate value here —
    // `previewPath: ''` means the site's home page hosts the preview.
    const query = new URLSearchParams({ paths: path })
    fetch(`${apiBase}/stories?${query}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ rows: StoryMeta[] }>) : { rows: [] }))
      .then(({ rows }) => {
        if (live) setRow(rows.find((r) => r.path === path))
      })
      .catch(() => {
        if (live) setRow(undefined)
      })
    return () => {
      live = false
    }
  }, [apiBase, path])

  return row
}

/**
 * The iframe src for previewing `type`'s singleton in context (`globals.md`
 * decision 4): the `previewPath` story's own preview URL with `&as=<name>`
 * appended, or the bare preview route (`server/routes/editor.ts`'s
 * `/preview/global/:name`) when there is no `previewPath` declared, or no story
 * currently lives at the one that is.
 *
 * Moved here from `admin/GlobalsList.tsx` when port phase 8 deleted the old admin,
 * next to `usePreviewHost` — the hook that now supplies its one candidate. Pure and
 * exported so it is tested without an iframe.
 *
 * `candidates` is a `StoryMeta[]` rather than the old signature's `StoryNode[]`:
 * the search is the server's now, so the caller has one flat row and had been
 * fabricating an empty `children` to satisfy a type this never read.
 */
export function globalPreviewUrl(
  type: Pick<DocumentType, 'name' | 'previewPath'>,
  candidates: readonly Pick<StoryMeta, 'path' | 'previewUrl'>[],
  /** The bare mount, not `apiBase`: `/preview/global/:name` renders HTML. */
  base: string,
): string {
  if (type.previewPath !== undefined) {
    const host = candidates.find((s) => s.path === type.previewPath)
    if (host?.previewUrl) return `${host.previewUrl}&as=${encodeURIComponent(type.name)}`
  }
  return `${base}/preview/global/${encodeURIComponent(type.name)}`
}
