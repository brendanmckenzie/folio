import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StoryNode } from '../../core/story'
import { expectJson, expectOk, send } from '../api'
import type { Notify } from './useNotice'

export interface Stories {
  /** The tree as the rail draws it. */
  tree: StoryNode[]
  /** The same stories, flattened, for links, references and the parent picker. */
  flat: StoryNode[]
  /** The story being edited. */
  storyId: string
  current: StoryNode | undefined
  reload: () => Promise<void>
  open: (id: string) => void
  create: (title: string, parentId: string | null) => Promise<void>
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
export function useStories(apiBase: string, initialStoryId: string, notify: Notify): Stories {
  const [storyId, setStoryId] = useState(initialStoryId)
  const [tree, setTree] = useState<StoryNode[]>([])

  const flat = useMemo(() => flatten(tree), [tree])
  const current = useMemo(() => flat.find((s) => s.id === storyId), [flat, storyId])

  const reload = useCallback(async () => {
    const res = await fetch(`${apiBase}/stories`)
    if (res.ok) setTree((await res.json()) as StoryNode[])
  }, [apiBase])

  useEffect(() => {
    void reload()
  }, [reload])

  const open = useCallback(
    (id: string) => {
      if (id === storyId) return
      setStoryId(id)
      window.history.pushState({ folioStoryId: id }, '', `${apiBase}/edit/${id}`)
    },
    [apiBase, storyId],
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
    async (title: string, parentId: string | null) => {
      let story: StoryNode
      try {
        story = await expectJson<StoryNode>(
          await send(`${apiBase}/stories`, 'POST', { title, parentId }),
        )
      } catch (e) {
        notify((e as Error).message)
        return
      }
      await reload()
      // Stay on the Content tab: you have just been working with the tree.
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

  return { tree, flat, storyId, current, reload, open, create, patch, remove, duplicate }
}
