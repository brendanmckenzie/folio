import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StoryMeta, StoryNode } from '../../core/story'
import type { IndexedValues } from '../../server/content-index'
import { expectJson, expectOk, send } from '../api'
import type { Notify } from './useNotice'

export interface Stories {
  /** The page tree as the rail draws it. `page`-kind types only: unrouted
   * documents are not in it (`document-types.md` checkpoint 2). */
  tree: StoryNode[]
  /** Every unrouted document (records and singletons), flat, for the Data rail.
   * Fetching this is also what creates a singleton on first access. */
  documents: StoryNode[]
  /**
   * The `indexed` field values of those documents, keyed by story id then field
   * — the Data list view's columns
   * (`../../../docs/specs/content-model/data-documents.md` decision 2).
   *
   * Published values, source locale, from one query on the server. Empty for a
   * document with nothing published, which the list draws as a blank cell beside
   * that row's draft badge.
   */
  indexed: IndexedValues
  /**
   * Every document — the tree flattened, then the unrouted ones — for links,
   * references and the parent picker. A `reference` can point at a record, so
   * the pickers need both lists; each filters for itself.
   */
  flat: StoryNode[]
  /** The document being edited. */
  storyId: string
  current: StoryNode | undefined
  reload: () => Promise<void>
  open: (id: string) => void
  /** `type` is a document type name; absent means the default page type. */
  create: (title: string, parentId: string | null, type?: string) => Promise<void>
  patch: (id: string, patch: Record<string, unknown>) => Promise<void>
  /** `redirect` (redirects.md) is the delete confirmation's checkbox value:
   * true writes a redirect to the parent, false is the escape hatch. */
  remove: (story: StoryNode, redirect: boolean) => Promise<void>
  /** duplicate-and-paste.md: `title` is the confirmation dialog's title field
   * at the moment of confirming. Opens the copy once it lands, the same as
   * `create` does for a brand-new page. */
  duplicate: (story: StoryNode, title: string) => Promise<void>
}

function flatten(nodes: StoryNode[]): StoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)])
}

/**
 * The story tree, the CRUD that changes it, and which story the editor is on.
 *
 * Switching pages is client-side: the rail keeps its state, the tree stays put,
 * and there is no full reload — so this hook owns the history entries too.
 */
export function useStories(
  apiBase: string,
  /** The bare mount: this hook owns the editor page's history entries, and
   * `/edit/:id` is a page rather than JSON. */
  base: string,
  initialStoryId: string,
  notify: Notify,
): Stories {
  const [storyId, setStoryId] = useState(initialStoryId)
  const [tree, setTree] = useState<StoryNode[]>([])
  const [documents, setDocuments] = useState<StoryNode[]>([])
  const [indexed, setIndexed] = useState<IndexedValues>({})

  const flat = useMemo(() => [...flatten(tree), ...documents], [tree, documents])
  const current = useMemo(() => flat.find((s) => s.id === storyId), [flat, storyId])

  /**
   * Both lists, in parallel. `/documents` is a second request rather than one
   * combined payload because the tree is a *tree* and the unrouted documents are
   * a flat list — and because asking for the flat list is what brings every
   * declared singleton into existence (`document-types.md` decision 7), which
   * the tree request must not be responsible for.
   */
  const reload = useCallback(async () => {
    const [treeRes, docsRes] = await Promise.all([
      fetch(`${apiBase}/stories`),
      fetch(`${apiBase}/documents`),
    ])
    if (treeRes.ok) setTree((await treeRes.json()) as StoryNode[])
    if (docsRes.ok) {
      const body = (await docsRes.json()) as { documents: StoryMeta[]; indexed?: IndexedValues }
      // Given `children: []` so one list can hold both kinds: nothing nests
      // under an unrouted document, so the array is always empty.
      setDocuments(body.documents.map((d) => ({ ...d, children: [] })))
      // Absent on a site that marks nothing `indexed`, which is why this is
      // defaulted rather than required.
      setIndexed(body.indexed ?? {})
    }
  }, [apiBase])

  useEffect(() => {
    void reload()
  }, [reload])

  const open = useCallback(
    (id: string) => {
      if (id === storyId) return
      setStoryId(id)
      window.history.pushState({ folioStoryId: id }, '', `${base}/edit/${id}`)
    },
    [base, storyId],
  )

  useEffect(() => {
    const onPop = () => {
      const id = window.location.pathname.split('/').pop()
      if (id) setStoryId(id)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (current) document.title = `${current.title} · Folio`
  }, [current])

  const patch = useCallback(
    async (id: string, fields: Record<string, unknown>) => {
      try {
        await expectOk(await send(`${apiBase}/stories/${encodeURIComponent(id)}`, 'PATCH', fields))
      } catch (e) {
        // A refused rename or move leaves the tree as the server still has it,
        // so reloading below puts the old value back on screen under the notice.
        notify((e as Error).message)
      }
      await reload()
    },
    [apiBase, notify, reload],
  )

  const create = useCallback(
    async (title: string, parentId: string | null, type?: string) => {
      let story: StoryNode
      try {
        story = await expectJson<StoryNode>(
          // `type` is omitted rather than sent as undefined when absent, so the
          // server applies its own default page type.
          await send(`${apiBase}/stories`, 'POST', {
            title,
            parentId,
            ...(type ? { type } : {}),
          }),
        )
      } catch (e) {
        // An `under` violation and an unknown type both land here as a notice —
        // the refusal the resolved open question asked for, rather than a
        // create that appears to work and does nothing.
        notify((e as Error).message)
        return
      }
      await reload()
      // Stay on the rail you were working in: the tree, or the Data list.
      open(story.id)
    },
    [apiBase, notify, open, reload],
  )

  const remove = useCallback(
    async (story: StoryNode, redirect: boolean) => {
      try {
        await expectOk(
          await fetch(`${apiBase}/stories/${encodeURIComponent(story.id)}?redirect=${redirect}`, {
            method: 'DELETE',
          }),
        )
      } catch (e) {
        notify((e as Error).message)
        await reload()
        return
      }
      await reload()
      if (story.id === storyId) {
        const fallback = flat.find((s) => s.path === '') ?? flat.find((s) => s.id !== story.id)
        if (fallback) open(fallback.id)
      }
    },
    [apiBase, flat, notify, open, reload, storyId],
  )

  const duplicate = useCallback(
    async (story: StoryNode, title: string) => {
      let created: StoryNode
      try {
        created = (
          await expectJson<{ story: StoryNode }>(
            await send(`${apiBase}/stories/${encodeURIComponent(story.id)}/duplicate`, 'POST', {
              title,
            }),
          )
        ).story
      } catch (e) {
        notify((e as Error).message)
        return
      }
      await reload()
      // Same reasoning as `create`: you were just working with the tree, so
      // stay there — but open the copy, not the page just duplicated.
      open(created.id)
    },
    [apiBase, notify, open, reload],
  )

  return {
    tree,
    documents,
    indexed,
    flat,
    storyId,
    current,
    reload,
    open,
    create,
    patch,
    remove,
    duplicate,
  }
}
