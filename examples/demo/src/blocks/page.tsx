import { asset, blocks, boolean, defineBlock, text, textarea } from 'folio/core'

/**
 * Root block. Every document has exactly one.
 *
 * Page metadata lives here rather than in the stories table, so editing it runs
 * through the same sync engine as everything else: multiplayer, undoable,
 * versioned, and published atomically with the content. Only routing structure
 * (slug, parent, order) lives in D1.
 */
export const page = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title', required: true }),
    description: textarea({
      label: 'Meta description',
      rows: 3,
      help: 'Shown in search results. Around 150 characters.',
    }),
    socialImage: asset({ label: 'Social share image', accept: 'image/*' }),
    noindex: boolean({ label: 'Hide from search engines' }),
    body: blocks({
      label: 'Body',
      allow: [
        'hero',
        'prose',
        'pullquote',
        'image',
        'gallery',
        'features',
        'cta',
        'embed',
        'section',
        'personCard',
      ],
    }),
  },
  render: ({ body }) => <main className="page">{body}</main>,
})
