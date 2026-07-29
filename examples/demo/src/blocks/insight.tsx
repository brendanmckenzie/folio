import { asset, blocks, boolean, defineBlock, reference, text, textarea } from 'folio/core'

/**
 * Root block for the `insight` document type — a **second routable page type**.
 *
 * There is no routing rule to configure (`document-types.md` checkpoint 3):
 * Folio derives a path from the tree, so an insight created under the "Insights"
 * page already serves at `/insights/whatever`. The type declares
 * `under: ['insight' is not allowed]`… more precisely `under: ['page']` in
 * src/index.tsx, which is what stops an insight being created (or dragged) to
 * the top level or under another insight.
 *
 * It shares `title`/`description`/`socialImage` with `page` because it is a real
 * page that real search engines index, and adds the two fields a page has no use
 * for: a standfirst and an author, the latter pointing at a `person` record.
 */
export const insightPage = defineBlock({
  name: 'insightPage',
  label: 'Insight',
  summary: 'title',
  fields: {
    title: text({ label: 'Title', required: true, translatable: true }),
    standfirst: textarea({
      label: 'Standfirst',
      rows: 2,
      help: 'The opening line, shown above the body.',
      translatable: true,
    }),
    author: reference({
      label: 'Author',
      types: ['person'],
      help: 'A Person record. Pages are not offered.',
    }),
    description: textarea({ label: 'Meta description', rows: 3, translatable: true }),
    socialImage: asset({ label: 'Social share image', accept: 'image/*' }),
    noindex: boolean({ label: 'Hide from search engines' }),
    body: blocks({
      label: 'Body',
      allow: ['hero', 'prose', 'pullquote', 'image', 'gallery', 'cta', 'personCard'],
    }),
  },
  render: ({ title, standfirst, author, body }) => (
    <article className="insight">
      <header className="insight__head">
        <h1 className="insight__title">{title || 'Untitled'}</h1>
        {standfirst ? <p className="insight__standfirst">{standfirst}</p> : null}
        {/* A reference to a record: read its own fields straight off `data`
            rather than inlining the whole thing. */}
        {author ? (
          <p className="insight__author">
            By {String(author.data.fullName ?? 'Unknown')}
            {author.data.role ? `, ${String(author.data.role)}` : ''}
          </p>
        ) : null}
      </header>
      {body}
    </article>
  ),
})
