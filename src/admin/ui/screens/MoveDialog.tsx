import { useEffect, useMemo, useState } from 'react'
import type { Page } from '../../../core/pagination'
import type { StoryMeta } from '../../../core/story'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { rank } from '../rank'
import css from './Content.module.css'
import { messageOf } from './useContent'

/**
 * Where a bulk move is going.
 *
 * **Bulk move is an ordinary feature** (`ui-architecture.md` decision 7): the
 * reasoning that once deferred it — "a tree operation with fractional indices and
 * cycle checks" — was our implementation's concern dressed up as a product
 * decision. What a user needs is to pick a destination and confirm, and
 * `PATCH /stories/:id { parentId, index }` already encodes every rule that
 * applies. Storyblok's flow is exactly this.
 *
 * **A searchable list of paths, not a tree picker.** The obvious design is a
 * miniature of the Content tree, and it is the wrong one here for the same reason
 * the block picker became a palette: a destination is *known* to the person
 * choosing it, so typing three characters of its path beats expanding three levels
 * to reach it. It also sidesteps the thing a tree picker inside a paged tree would
 * have to solve — lazily loading a second, independent set of levels purely to
 * choose from.
 *
 * The candidate list is `?flat=1&sort=path`, one page of it, filtered as you type.
 * One page rather than a walk, because a picker showing the first fifty paths and
 * narrowing on a keystroke is a picker that works on a site of any size; the
 * `q` goes to the server, so what is not in the first page is still reachable.
 */
export function MoveDialog({
  apiBase,
  count,
  note,
  onClose,
  onConfirm,
}: {
  apiBase: string
  /** How many pages are moving, for the title. */
  count: number
  /**
   * What a confirmation would have said — the invisible part of the selection, and
   * the conditions a select-all captured.
   *
   * This dialog **is** the move's confirmation, so it carries the sentence rather
   * than a second dialog appearing behind it: "Move 12 pages? 9 are not shown by
   * the current filter" and "pick a destination" are one question, and asking them
   * separately is two modals for one gesture.
   */
  note?: string
  onClose: () => void
  /** `null` is the top level, which is a real destination rather than "no
   * choice" — hence a separate radio rather than an empty selection. */
  onConfirm: (parentId: string | null) => void
}) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<readonly StoryMeta[]>([])
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const query = new URLSearchParams({ flat: '1', sort: 'path', limit: '50' })
    if (q.trim()) query.set('q', q.trim())
    fetch(`${apiBase}/stories?${query}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await messageOf(res))
        return (await res.json()) as Page<StoryMeta>
      })
      .then((page) => {
        if (live) {
          setRows(page.rows)
          setError(null)
        }
      })
      .catch((e: Error) => {
        if (live) setError(e.message)
      })
    return () => {
      live = false
    }
  }, [apiBase, q])

  /**
   * Ranked client-side *as well* as filtered server-side, and the two are not
   * redundant: the server's `like` decides which fifty rows come back, and `rank`
   * decides which of them is first. `rank` is the palette's, so typing `abt`
   * finds `/about` here exactly as it does there — one ranking implementation,
   * three consumers.
   */
  const ordered = useMemo(
    () =>
      rank(
        q,
        rows.map((row) => ({ label: row.title, keywords: pathLabel(row), row })),
      ).map((hit) => hit.item.row),
    [q, rows],
  )

  return (
    <Dialog
      title={`Move ${count} ${count === 1 ? 'page' : 'pages'}`}
      // "In the order you see them" is a promise the server keeps: the set lands in
      // walk order from the index given, rather than each page pushing the last one
      // down — which is what `index: 0` per document used to do.
      description="Pick a destination. They arrive in the order you see them, each move is its own write, and any the tree refuses are reported."
      size="wide"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onConfirm(target)}>
            Move
          </Button>
        </>
      }
    >
      {note ? <p className={css.dialogNote}>{note}</p> : null}
      <input
        className={css.search}
        type="search"
        value={q}
        placeholder="Search destinations"
        aria-label="Search destinations"
        onChange={(e) => setQ(e.target.value)}
      />
      {error ? <p className={css.dialogError}>{error}</p> : null}
      <div className={css.destinations} role="radiogroup" aria-label="Destination">
        <label className={css.destination}>
          <input
            type="radio"
            name="folio-move-target"
            checked={target === null}
            onChange={() => setTarget(null)}
          />
          <span className={css.destinationName}>The top level</span>
          <code className={css.destinationPath}>/</code>
        </label>
        {ordered.map((row) => (
          <label key={row.id} className={css.destination}>
            <input
              type="radio"
              name="folio-move-target"
              checked={target === row.id}
              onChange={() => setTarget(row.id)}
            />
            <span className={css.destinationName}>{row.title || 'Untitled'}</span>
            <code className={css.destinationPath}>{pathLabel(row)}</code>
          </label>
        ))}
        {ordered.length === 0 && !error ? (
          <p className={css.dialogError}>No page matches “{q}”.</p>
        ) : null}
      </div>
    </Dialog>
  )
}

/** The full path, which is what tells two pages with the same title apart — and
 * `design-system.md`'s third commitment says an identifier is a typographic
 * citizen rather than something to hide. */
function pathLabel(row: StoryMeta): string {
  return row.path === '' ? '/' : `/${row.path}`
}
