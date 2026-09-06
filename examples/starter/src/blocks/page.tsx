import { blocks, boolean, defineBlock, text, textarea } from 'folio/core'

/**
 * The root block. Every document has exactly one, and this one is named by the
 * `page` document type in `src/index.tsx`.
 *
 * Page metadata lives here rather than in the database, so editing it runs
 * through the same sync engine as everything else: multiplayer, undoable,
 * versioned, and published atomically with the content. Only routing structure
 * — slug, parent, order — lives in D1.
 */
export const page = defineBlock({
  name: 'page',
  label: 'Page',
  // Which field the editor's outline shows for this block.
  summary: 'title',
  fields: {
    title: text({ label: 'Title', required: true }),
    description: textarea({
      label: 'Meta description',
      rows: 3,
      help: 'Shown in search results. Around 150 characters.',
    }),
    noindex: boolean({ label: 'Hide from search engines' }),
    // The body slot. `allow` is the whole of "what can go on a page" — add a
    // block's name here and it appears in the editor's insert menu.
    body: blocks({ label: 'Body', allow: ['hero', 'prose'] }),
  },
  render: ({ body }) => <main className="page">{body}</main>,
})
