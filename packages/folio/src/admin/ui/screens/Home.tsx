import { useEffect, useState } from 'react'
import type { Page } from '../../../core/pagination'
import type { DocumentType } from '../../../core/schema'
import type { StoryMeta } from '../../../core/story'
import { href, type Screen } from '../route'
import css from './Home.module.css'

interface Props {
  types: readonly DocumentType[]
  apiBase: string
  mount: string
}

/**
 * Recency and quick access, which is what every comparable product's home screen
 * turned out to be (`docs/ui-architecture.md`'s survey — and the block I was most
 * confident about, a queue of unpublished changes, is the one nobody ships).
 *
 * **Quick access is real here; the three recency blocks are not, and cannot be
 * yet.** Latest changes and latest published are dependency 5: two site-wide
 * queries that do not exist — most recently edited across every type
 * (`draftUpdatedAt`) and most recent publishes (`versions` rows of kind
 * `publish`, which already carry an actor and a timestamp). Latest media wants
 * `listAssets` with a small limit. All three are named rather than mocked,
 * because a plausible fake list on a home screen is the single easiest thing in
 * this prototype to mistake for a working feature.
 */
export function Home({ types, apiBase, mount }: Props) {
  const pages = usePageCount(apiBase)
  const cards: { label: string; screen: Screen; count?: number; note: string }[] = [
    {
      label: 'Pages',
      screen: { name: 'content' },
      ...(pages === undefined ? {} : { count: pages }),
      note: 'The tree. Every one has a URL.',
    },
    ...types
      .filter((t) => t.kind === 'record')
      .map((t) => ({
        label: t.label,
        screen: { name: 'documents' as const, type: t.name },
        // No count: `GET /documents` returns every record of every type in one
        // response, and asking for a number here is how a home screen quietly
        // becomes the most expensive request in the admin. The count arrives with
        // paging, which owes every list header one anyway.
        note: 'Records, edited as a table.',
      })),
    { label: 'Assets', screen: { name: 'assets' }, note: 'The media library.' },
  ]

  return (
    <div className={css.screen}>
      <h1 className={css.title}>Home</h1>

      <section aria-labelledby="home-quick">
        <h2 className={css.heading} id="home-quick">
          Quick access
        </h2>
        <div className={css.cards}>
          {cards.map((card) => (
            <a className={css.card} key={card.label} href={href(card.screen, mount)}>
              <span className={css.cardLabel}>{card.label}</span>
              {card.count === undefined ? null : (
                <span className={css.cardCount}>{card.count}</span>
              )}
              <span className={css.cardNote}>{card.note}</span>
            </a>
          ))}
        </div>
      </section>

      <section aria-labelledby="home-pending">
        <h2 className={css.heading} id="home-pending">
          Not built yet
        </h2>
        <ul className={css.pending}>
          <li>
            <b>Latest changes</b> — recently edited across every type, with who and when. Wants a
            site-wide query over <code>draftUpdatedAt</code>.
          </li>
          <li>
            <b>Latest published</b> — wants a site-wide query over <code>versions</code>, which
            already holds one row per publish with its actor.
          </li>
          <li>
            <b>Latest media</b> — the newest uploads as thumbnails. <code>listAssets</code> is
            already ordered by <code>created_at</code> descending.
          </li>
          <li>
            <b>Needs attention</b> — pending migrations and audit findings, and{' '}
            <b>absent entirely when there is nothing wrong</b>. No green tick.
          </li>
        </ul>
      </section>
    </div>
  )
}

/**
 * How many routed pages the site has.
 *
 * `?count=1&limit=1` — the count is the whole point and the row is the smallest
 * thing that can carry it, so this is one aggregate and one row rather than the
 * recursive walk over a whole tree it replaces. The card simply has no number
 * until it lands, which is why `count` is spread in conditionally rather than
 * rendered as a zero: a "0" that turns into "1,284" reads as data loss for the
 * moment it is wrong.
 *
 * The other three cards still have no count, for the reason the comment below
 * gives, and this is the shape theirs will take.
 */
function usePageCount(apiBase: string): number | undefined {
  const [total, setTotal] = useState<number | undefined>(undefined)
  useEffect(() => {
    let live = true
    fetch(`${apiBase}/stories?flat=1&limit=1&count=1`)
      .then((res) => (res.ok ? (res.json() as Promise<Page<StoryMeta>>) : null))
      .then((page) => {
        if (live && page) setTotal(page.total)
      })
      .catch(() => {
        // A missing number on a card is a missing number. Nothing to say.
      })
    return () => {
      live = false
    }
  }, [apiBase])
  return total
}
