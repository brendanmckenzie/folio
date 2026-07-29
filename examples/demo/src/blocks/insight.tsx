import {
  asset,
  blocks,
  boolean,
  collection,
  defineBlock,
  reference,
  select,
  text,
  textarea,
} from 'folio/core'

/**
 * Topics an insight can carry. A closed list because it is what an index page
 * filters on: a free-text tag field would make "the six most recent insights
 * tagged policy" depend on nobody having typed "Policy".
 */
export const INSIGHT_TOPICS = [
  { label: 'Policy', value: 'policy' },
  { label: 'Technology', value: 'technology' },
  { label: 'Practice', value: 'practice' },
]

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
    // `indexed: true` is what makes this queryable, and it is only ever declared on
    // a root block (`content-model/collections.md` decision 2): the index is a
    // fixed projection of a document, so it cannot depend on which blocks happen
    // to be inside one. `GET /folio/audit` reports the flag on anything else.
    //
    // Translatable *and* indexed: a French index page filtering a French title
    // matches, because the projection writes a row per locale.
    title: text({ label: 'Title', required: true, translatable: true, indexed: true }),
    // Not translatable, deliberately: a topic is a token an index page filters on,
    // and translating the token rather than its label would fork the filter.
    topic: select({
      label: 'Topic',
      options: INSIGHT_TOPICS,
      indexed: true,
      help: 'What an index page can filter this insight by.',
    }),
    // A date as an ISO 8601 string, which is the escape hatch decision 2 names for
    // "sort by something": the projection stores it in both index columns, so it
    // sorts correctly as text *and* takes numeric range filters.
    published: text({
      label: 'Publish date',
      placeholder: '2026-03-14',
      indexed: true,
      help: 'YYYY-MM-DD. What an index page sorts by.',
    }),
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
  render: ({ title, topic, published, standfirst, author, body }) => (
    <article className="insight">
      <header className="insight__head">
        <h1 className="insight__title">{title || 'Untitled'}</h1>
        {standfirst ? <p className="insight__standfirst">{standfirst}</p> : null}
        <p className="insight__meta">
          {topicLabel(topic)}
          {published ? ` · ${published}` : ''}
        </p>
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

const topicLabel = (value: string) => INSIGHT_TOPICS.find((t) => t.value === value)?.label ?? value

/**
 * An index page's list of insights — the block `content-model/collections.md`
 * exists for.
 *
 * The whole list is **one field**. The field declares the shape of the query (this
 * lists insights, an editor may narrow it by topic, at most twelve, newest first)
 * and the editor picks within it; the answer arrives already resolved, as the same
 * `ReferenceTarget`s a `reference` field hands back — so this render reads exactly
 * like the `personCard` one does, and there is no fetch anywhere in this file.
 *
 * Nothing here knows about SQL, `content_index`, or pagination arithmetic. It reads
 * `list.items`, `list.page` and `list.pages`, and the host's own route is what turns
 * `?page=` into the offset (see src/index.tsx).
 */
export const insightList = defineBlock({
  name: 'insightList',
  label: 'Insight list',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading', translatable: true }),
    list: collection({
      label: 'Which insights',
      // Fixed by the schema, not by the editor: this block renders insight cards,
      // so offering to point it at pages would make its own render a lie.
      type: 'insight',
      // What the editor may narrow by. Each must be `indexed` on a root block, and
      // is enforced twice — the input only offers these, and `collectionQuery`
      // drops anything else on the way out, because a value can also arrive from an
      // importer or over the content API.
      filterable: ['topic'],
      maxPerPage: 12,
      defaultOrder: { field: 'published', dir: 'desc' },
    }),
  },
  render: ({ heading, list }) => (
    <section className="insight-list">
      {heading ? <h2 className="insight-list__heading">{heading}</h2> : null}

      {list.items.length === 0 ? (
        <p className="insight-list__empty">Nothing published here yet.</p>
      ) : (
        <ul className="insight-list__items">
          {list.items.map((item) => (
            <li key={item.id} className="insight-list__item">
              <a href={item.url}>{item.title}</a>
              {item.data.published ? (
                <span className="insight-list__date">{String(item.data.published)}</span>
              ) : null}
              {item.data.standfirst ? (
                <p className="insight-list__standfirst">{String(item.data.standfirst)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* Offset pagination is what makes "page 2 of 4" expressible at all
          (decision 2); keyset could not without a count. The links are the host's
          own `?page=`, which every collection on the page shares. */}
      {list.pages > 1 ? (
        <nav className="insight-list__pages">
          {list.page > 1 ? <a href={`?page=${list.page - 1}`}>← Newer</a> : null}
          <span>
            Page {list.page} of {list.pages}
          </span>
          {list.page < list.pages ? <a href={`?page=${list.page + 1}`}>Older →</a> : null}
        </nav>
      ) : null}

      {/* `stale` is only ever set in the editor's preview: a collection resolves
          against PUBLISHED content there (decision 3), because querying drafts would
          mean opening every candidate Durable Object on every keystroke. Saying so
          beats an editor wondering where their new draft went. */}
      {list.stale ? (
        <p className="insight-list__stale">Showing published insights. Drafts appear once live.</p>
      ) : null}
    </section>
  ),
})
