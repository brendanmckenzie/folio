import { collection, defineBlock, text } from 'folio/core'

/**
 * A search results block (`content-model/full-text-search.md` architecture
 * decision 10): "a search page is a page holding a collection block", and
 * `searchable: true` is the whole of what makes it one. No new entity, no
 * second index the host maintains — the same `ReferenceTarget`-shaped items
 * `insightList` already renders, except each one may now carry a `snippet` and
 * a `score` because this field's query carries a `search` term.
 *
 * Not a document type of its own (`src/index.tsx` never lists it under
 * `types`): the `/search` route builds an in-memory `Doc` holding one of these
 * and calls `folio.resolve(env, doc, { search: url.searchParams.get('q') })`,
 * so there is no story to seed for a page that has nothing to publish.
 */
export const searchResults = defineBlock({
  name: 'searchResults',
  label: 'Search results',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading', translatable: true }),
    list: collection({
      label: 'Results',
      // Fixed by the schema, like `insightList`'s: this block renders insight
      // cards, so an editor narrowing `type` further would make its own render
      // a lie.
      type: 'insight',
      searchable: true,
      maxPerPage: 10,
      defaultOrder: { field: 'published', dir: 'desc' },
    }),
  },
  render: ({ heading, list }) => (
    <section className="search-results">
      <h1 className="search-results__heading">{heading || 'Search'}</h1>

      {list.items.length === 0 ? (
        <p className="search-results__empty">No matches.</p>
      ) : (
        <ul className="search-results__items">
          {list.items.map((item) => (
            <li key={item.id} className="search-results__item">
              <a href={item.url}>{item.title}</a>
              {/* `snippet` is only ever present when the query carried `search`
                  (`core/query.ts`'s `ContentItem`) — a plain, unsearched list
                  renders the same cards `insightList` does. Parts are `{ text,
                  match }`, never a `<mark>…</mark>` string to trust as HTML. */}
              {item.snippet ? (
                <p className="search-results__snippet">
                  {item.snippet.map((part, i) =>
                    part.match ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity of their own; the list is rebuilt whole on every render.
                      <mark key={i}>{part.text}</mark>
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                      <span key={i}>{part.text}</span>
                    ),
                  )}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {list.pages > 1 ? (
        <nav className="search-results__pages">
          <span>
            Page {list.page} of {list.pages}
          </span>
        </nav>
      ) : null}
    </section>
  ),
})
