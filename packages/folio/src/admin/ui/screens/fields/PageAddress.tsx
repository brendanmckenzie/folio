import { useEffect, useState } from 'react'
import { slugify, type StoryMeta } from '../../../../core/story'
import { Field, Input } from '../../Field'

/**
 * Routing structure for the open page — its slug, and the URL that follows from it.
 *
 * Unlike the fields below it, this lives in D1 rather than in the document, because
 * it is the routing index and needs uniqueness and tree queries. So it is a `PATCH`
 * and not a mutation: it does not go through `store.tx`, has no undo step, and
 * `pathsChanged` fires for every descendant the rename moves.
 *
 * **The parent picker is gone**, and that is the one deliberate subtraction from
 * `admin/PageAddress.tsx`. It was a `<select>` over every document on the site — the
 * same whole-tree read `candidates.ts` explains the removal of — and moving a page is
 * now the Content screen's job, where it is a drag, four `⌥`-arrow chords and a
 * `MoveDialog` that encodes the rules this select never knew (a page cannot move
 * inside its own subtree; `PATCH /stories/:id { parentId, index }` refuses it). One
 * affordance for moving a page, on the screen that shows the tree it moves within,
 * beats a second one in a panel that cannot show where it would land.
 */
export function PageAddress({
  story,
  apiBase,
  disabled,
  onNotice,
  onChanged,
}: {
  story: StoryMeta
  apiBase: string
  /** A past version is on the stage, or the role may not manage content. */
  disabled: boolean
  onNotice: (message: string) => void
  /** The caller's story row is stale: the slug, the path and the URL all moved. */
  onChanged: () => void
}) {
  const isRoot = story.path === ''
  const [slug, setSlug] = useState(story.slug)
  const [busy, setBusy] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: story.id is deliberate — switching to a story with an identical slug must still discard a half-typed local edit
  useEffect(() => {
    setSlug(story.slug)
  }, [story.id, story.slug])

  const commit = async () => {
    const next = slugify(slug)
    if (!slug.trim() || next === story.slug) {
      setSlug(story.slug)
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${apiBase}/stories/${encodeURIComponent(story.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: next }),
      })
      if (!res.ok) throw new Error(`Could not rename this page (${res.status})`)
      onChanged()
    } catch (e) {
      // Back to what the server still says, rather than leaving a slug on screen that
      // no URL resolves to.
      setSlug(story.slug)
      onNotice((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field
      label="Slug"
      help={
        isRoot
          ? 'The site root has no slug of its own.'
          : 'Renaming updates every page beneath this one. Existing drafts are kept.'
      }
    >
      {(id) => (
        <Input
          id={id}
          type="text"
          value={isRoot ? '' : slug}
          placeholder={isRoot ? '/' : 'page-slug'}
          disabled={isRoot || busy || disabled}
          onChange={(e) => setSlug(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setSlug(story.slug)
          }}
        />
      )}
    </Field>
  )
}
