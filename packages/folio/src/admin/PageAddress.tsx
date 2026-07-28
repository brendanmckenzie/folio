import { useEffect, useState } from 'react'
import { descendants, slugify, type StoryNode } from '../core/story'
import { useFolio } from './FolioContext'

interface Props {
  story: StoryNode
  onChange: (patch: { slug?: string; parentId?: string | null }) => Promise<void>
}

/**
 * Routing structure for the current page. Unlike the fields below it, this
 * lives in D1 rather than the document, because it is the routing index and
 * needs uniqueness and tree queries.
 */
export function PageAddress({ story, onChange }: Props) {
  const { stories } = useFolio()
  const isRoot = story.path === ''
  const [slug, setSlug] = useState(story.slug)
  const [busy, setBusy] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: story.id is deliberate — switching to a story with an identical slug must still discard a half-typed local edit
  useEffect(() => {
    setSlug(story.slug)
  }, [story.id, story.slug])

  const blocked = new Set(descendants(stories, story.id))
  const parents = stories.filter((s) => !blocked.has(s.id))

  const commit = async (patch: { slug?: string; parentId?: string | null }) => {
    setBusy(true)
    try {
      await onChange(patch)
    } finally {
      setBusy(false)
    }
  }

  const commitSlug = () => {
    const next = slugify(slug)
    if (!slug.trim() || next === story.slug) {
      setSlug(story.slug)
      return
    }
    void commit({ slug: next })
  }

  return (
    <div className="address">
      <h3 className="address__title">Address</h3>

      <div className="field">
        <label className="field__label" htmlFor="page-parent">
          Parent page
        </label>
        <select
          id="page-parent"
          disabled={isRoot || busy}
          value={story.parentId ?? ''}
          onChange={(e) => void commit({ parentId: e.target.value || null })}
        >
          <option value="">— Top level —</option>
          {parents.map((s) => (
            <option key={s.id} value={s.id}>
              {'— '.repeat(s.path ? s.path.split('/').length : 0)}
              {s.title}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="page-slug">
          Slug
        </label>
        <input
          id="page-slug"
          type="text"
          value={isRoot ? '' : slug}
          placeholder={isRoot ? 'The site root has no slug' : 'page-slug'}
          disabled={isRoot || busy}
          onChange={(e) => setSlug(e.target.value)}
          onBlur={commitSlug}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setSlug(story.slug)
          }}
        />
        <p className="field__help">
          Renaming updates every page beneath this one. Existing drafts are kept.
        </p>
      </div>

      <div className="address__url">
        <span>URL</span>
        <code>{story.url ?? `/${story.path}`}</code>
      </div>
    </div>
  )
}
