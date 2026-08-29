import { useCallback, useEffect, useState } from 'react'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { ListHeader } from '../List'
import {
  type AssetRow,
  type AssetsUrl,
  type AssetView,
  assetsQuery,
  panelSubject,
  parseAssetsUrl,
} from './assets-model'
import { AssetBrowser } from './AssetBrowser'
import { AssetDeleteDialog } from './AssetDeleteDialog'
import { AssetDetail } from './AssetDetail'
import css from './Assets.module.css'
import { useAsset, useAssets, useDropTarget, useUploads } from './useAssets'
import { messageOf } from './useContent'

interface Props {
  /** The admin's internal JSON base — `{base}/api`. Every read and write here. */
  apiBase: string
  /** Where Folio is mounted — `{base}`. Thumbnails and the download link come off
   * `/asset/:key`, which is not part of the internal API, and the usage list's links
   * are real `<a href>` into the shell. */
  mount: string
  query: Readonly<Record<string, string>>
  /** `replace`, not `push`: a filter keystroke must not be a history entry. */
  onQuery: (next: Record<string, string | undefined>) => void
  onNotice: (message: string) => void
  /** The remembered view, used when the URL names none. */
  remembered: { view: AssetView }
  onRemember: (next: { view: AssetView }) => void
}

/**
 * The media library as a **place** — `docs/ui-architecture.md`'s port phase 4.
 *
 * What it replaces is worth restating, because the spec is blunt about it: *"Today
 * assets are not a place: the library is a `position: fixed` modal launched from a
 * field, with no search, no filter, no sort, no metadata, no usage information, and a
 * red Delete link under every tile that fires immediately."* Every clause in that
 * sentence is a thing on this screen.
 *
 * The structure is three parts, and only the first is new work in this file:
 *
 * 1. **`AssetBrowser`** — the grid, the table, the toggle, the search, the filters,
 *    the sort, the upload control and the pager. It is a component rather than markup
 *    here because `AssetPicker` renders the same one inside a `Dialog` at `wide`: *one
 *    implementation, two mounts*, which is the load-bearing requirement of this phase.
 *    The seam is a selection — this mount turns one into a detail panel, the picker
 *    turns one into an armed *Use this file* button, and the browser knows neither.
 * 2. **`AssetDetail`** — a second column, beside the grid rather than over it.
 * 3. **`AssetDeleteDialog`** — the confirmation that names what breaks.
 *
 * Two things about this file specifically:
 *
 * - **The screen's controls live in the browser, not in `ListHeader`.** Content and
 *   Documents both put their search box and their create button in the header's
 *   `actions` slot, and this one cannot: the picker has no `ListHeader`, so anything
 *   put there would be a control the second mount does not have. A deliberate
 *   deviation from the two screens either side of it, and the price of one grid.
 * - **The selected id is in the URL, and the link is complete.** An asset is a thing
 *   somebody sends a colleague, so `?asset=ast_x` is what makes "have a look at this
 *   one" a link rather than a set of instructions. Building this screen found that the
 *   promise could not be kept — there was no `GET {base}/api/assets/:id`, so an id that
 *   was not on the page the URL loaded had nothing to resolve it with — and the route
 *   was added rather than the panel left apologising. `known`, `useAsset` and
 *   `panelSubject` between them keep it to one request and four honest states.
 */
export function Assets(props: Props) {
  const { apiBase, mount, onQuery, onNotice, onRemember } = props
  const url = parseAssetsUrl(props.query, props.remembered)
  const data = useAssets(apiBase, url)

  const [deleting, setDeleting] = useState<AssetRow | null>(null)

  const go = useCallback(
    (next: AssetsUrl) => {
      // Remembered *and* in the URL: linkable first, convenient second — the same rule
      // and the same order Content's `[ Tree | Flat ]` toggle follows. The URL is what
      // a person sends a colleague; the memory is what they get when they arrive
      // without one.
      onRemember({ view: next.view })
      onQuery(assetsQuery(next))
    },
    [onQuery, onRemember],
  )

  /**
   * The last row the selected id resolved to, kept so the panel does not blank.
   *
   * Two things make this necessary rather than a cache for its own sake. A filter
   * change re-queries the list and can exclude the open file — and the panel is about
   * a *file*, so it should stay open (see `withFilter`). And a reload after a `PATCH`
   * briefly has no rows at all.
   *
   * **It is also half of what makes `?asset=` a real link**, the other half being
   * `useAsset`. Building this screen found that there was no `GET
   * {base}/api/assets/:id`, so a cold link to an asset that was not on the page the URL
   * loaded had nothing to resolve it with; the route now exists and this is the cache
   * that keeps it to **one** request. In hand beats a lookup, and a lookup is only
   * asked for when nothing is in hand — see `panelSubject`.
   */
  const [known, setKnown] = useState<AssetRow | null>(null)
  const found = url.asset ? (data.page.rows.find((row) => row.id === url.asset) ?? null) : null
  const inHand = found ?? (known && known.id === url.asset ? known : null)

  /**
   * The cold-link resolution, and it asks for nothing whenever the row is already
   * here: `undefined` is how the hook is told there is nothing to resolve.
   *
   * A resolved row is remembered like a listed one, so paging or filtering afterwards
   * does not fetch it again — and so the panel does not flicker back to a skeleton the
   * moment the list is re-read.
   */
  const lookup = useAsset(apiBase, inHand ? undefined : url.asset)
  useEffect(() => {
    const row = found ?? lookup.row
    if (row) setKnown(row)
  }, [found, lookup.row])
  const subject = panelSubject(url.asset, inHand, lookup)

  const onUploaded = useCallback(
    (done: readonly AssetRow[]) => {
      if (done.length === 0) return
      data.reload()
      onNotice(
        done.length === 1 ? `Uploaded ${done[0]!.filename}` : `Uploaded ${done.length} files`,
      )
      // Opens the panel on what just arrived, which is the thing somebody uploading an
      // image is about to want: its alt text. Failures are not announced here — they
      // are per file, in the browser's own report, because a batch of ten can land
      // nine and one toast cannot say which.
      go({ ...url, asset: done[done.length - 1]!.id })
    },
    [data, go, onNotice, url],
  )
  const upload = useUploads(apiBase, onUploaded)

  const onFiles = useCallback((files: FileList | null) => upload.add(files), [upload])
  const drop = useDropTarget(onFiles)

  const remove = useCallback(
    async (row: AssetRow) => {
      try {
        const res = await fetch(`${apiBase}/assets/${encodeURIComponent(row.id)}`, {
          method: 'DELETE',
        })
        if (!res.ok) throw new Error(await messageOf(res))
        onNotice(`Deleted ${row.filename}`)
        setKnown(null)
        go({ ...url, asset: undefined })
        data.reload()
      } catch (e) {
        onNotice((e as Error).message)
      }
    },
    [apiBase, data, go, onNotice, url],
  )

  if (data.page.error && data.page.rows.length === 0) {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>Assets</ListHeader>
        <EmptyState
          title="Could not load the media library"
          body={data.page.error}
          action={
            <Button size="sm" onClick={data.reload}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  return (
    // The drop target is the whole screen, which is what `ui-architecture.md` asks for
    // — "upload by dropping anywhere on the screen" — and it is why the handlers are
    // here rather than on the grid: dropping onto the detail panel, the filter bar or
    // the empty space beside a short page all mean the same thing.
    <div className={css.screen} {...drop.handlers}>
      <ListHeader level={1}>Assets</ListHeader>

      {/*
        `data-open` follows `url.asset` rather than the resolved row: the cold-link
        message below is also a panel and wants the same second column, or it stretches
        to the screen's width to say two sentences.
      */}
      <div className={css.body} data-open={url.asset ? '' : undefined}>
        <AssetBrowser
          mount={mount}
          url={url}
          onUrl={go}
          data={data}
          upload={upload}
          selected={url.asset}
          onSelect={(id) => go({ ...url, asset: id })}
          label="Media library"
          kinds
        />

        {/*
          The four states a linked `?asset=` can be in. `panelSubject` decides which,
          and the two that are easy to collapse into one are deliberately not: a file
          that has been **deleted** is a fact somebody needs told plainly, and a fetch
          that **failed** is a retry. Reporting both as "could not load" would send one
          person hunting a network problem that is not there and tell another their file
          is gone because their wifi dropped.
        */}
        {subject.state === 'row' ? (
          <AssetDetail
            apiBase={apiBase}
            mount={mount}
            row={subject.row}
            onClose={() => go({ ...url, asset: undefined })}
            onDelete={() => setDeleting(subject.row)}
            onChanged={(next) => {
              setKnown(next)
              data.reload()
            }}
            onNotice={onNotice}
          />
        ) : subject.state === 'loading' ? (
          // A skeleton panel, not a spinner: the panel's shape is known before its
          // contents arrive, which is the rule `ui-architecture.md` states once for
          // every list and applies just as well to a fixed-layout column.
          <aside className={css.panel} aria-hidden="true">
            <div className={css.skeletonPreview} />
            <div className={css.skeletonLine} />
            <div className={css.skeletonLine} data-short="" />
            <div className={css.skeletonLine} />
          </aside>
        ) : subject.state === 'gone' ? (
          <aside className={css.panel}>
            <h2 className={css.panelHeading}>That file is gone</h2>
            <p className={css.note}>
              Nothing in the library has the id <code className={css.key}>{url.asset}</code> any
              more. It was deleted, so a link to it will not come back — documents that used it now
              render a missing image.
            </p>
            <Button size="sm" onClick={() => go({ ...url, asset: undefined })}>
              Close
            </Button>
          </aside>
        ) : subject.state === 'error' ? (
          <aside className={css.panel}>
            <h2 className={css.panelHeading}>Could not load that file</h2>
            {/* The file is very probably still there. The message is the server's or
                the network's, and the offer is a retry rather than a dismissal. */}
            <p className={css.note}>{subject.message}</p>
            <div className={css.panelFoot}>
              {/* The *lookup's* retry, not the list's: reloading the page of rows would
                  not re-ask the question that failed. */}
              <Button size="sm" onClick={lookup.retry}>
                Try again
              </Button>
              <Button size="sm" variant="subtle" onClick={() => go({ ...url, asset: undefined })}>
                Close
              </Button>
            </div>
          </aside>
        ) : null}
      </div>

      {drop.over ? (
        // `aria-hidden`, because it is an invitation to a pointer gesture and a
        // keyboard user is already looking at a real file input. Announcing "drop to
        // upload" to somebody who cannot drop is noise.
        <div className={css.dropVeil} aria-hidden="true">
          Drop to upload
        </div>
      ) : null}

      {deleting ? (
        <AssetDeleteDialog
          apiBase={apiBase}
          mount={mount}
          row={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const row = deleting
            setDeleting(null)
            void remove(row)
          }}
        />
      ) : null}
    </div>
  )
}
