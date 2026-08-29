import { describe, expect, it } from 'vitest'
import { toAssetValue } from '../../../src/server/assets'
import type { AssetSort } from '../../../src/core/story'
import {
  addedAgo,
  ASSET_COLUMNS,
  type AssetRow,
  type AssetsUrl,
  assetsParams,
  assetsQuery,
  assetValue,
  DEFAULT_ASSET_VIEW,
  dimensionsOf,
  dirOf,
  extensionOf,
  gridStep,
  humanSize,
  isAssetView,
  isNarrowed,
  isRenderableImage,
  kindForAccept,
  naturalDir,
  originalUrl,
  panelSubject,
  parseAssetsUrl,
  sortColumnKey,
  thumbUrl,
  typeLabel,
  uploadSummary,
  withFilter,
  withSort,
  withView,
} from '../../../src/admin/ui/screens/assets-model'

/**
 * The Assets screen's arithmetic, in Node with nothing mounted — the admin's
 * convention, and the reason `assets-model.ts` exists at all rather than these
 * assertions living inside a component nothing here can render.
 *
 * Five things are pinned harder than the rest, because all five are wrong in ways
 * that look right:
 *
 * - **`size` sorts descending and `filename` ascending.** The direction is stated in
 *   two places — here and `server/assets.ts`'s `ORDERS` — and they have to agree,
 *   because the URL is written on this side and read on that one.
 * - **A different sort starts at its own natural direction.** Carrying the previous
 *   one's direction over is the obvious implementation and it gives you
 *   smallest-file-first, which reads as a bug rather than a preserved preference.
 * - **`withView` keeps the filters**, where Content's clears them. Two toggles that
 *   look identical and are not.
 * - **`gridStep` clamps where `nextIndex` wraps.** A grid's last tile stepping to its
 *   first crosses two axes at once and reads as focus having been lost.
 * - **The stored type decides renderability, not the filename.** Anything that
 *   failed the upload sniff is stored as `application/octet-stream` and served as
 *   an attachment, so `core/values.ts`'s `isImageAsset` — which believes a
 *   filename — would put an `<img>` in front of a download.
 * - **A deleted file and a failed request are different answers.** `panelSubject`
 *   keeps them apart, because "could not load" about a 404 sends somebody hunting a
 *   network problem that is not there, and "that file is gone" about a dropped
 *   connection sends them looking for a backup.
 */

const row = (extra: Partial<AssetRow> = {}): AssetRow => ({
  id: 'ast_abc123',
  key: 'ast_abc123-photo.jpg',
  filename: 'photo.jpg',
  contentType: 'image/jpeg',
  size: 204_800,
  width: 1200,
  height: 800,
  alt: 'A photo',
  createdAt: 1_700_000_000_000,
  ...extra,
})

const url = (extra: Partial<AssetsUrl> = {}): AssetsUrl => ({
  view: 'grid',
  sort: 'created',
  dir: undefined,
  kind: 'all',
  q: '',
  asset: undefined,
  ...extra,
})

describe('the URL model', () => {
  it('falls back to the remembered view when the URL names none', () => {
    expect(parseAssetsUrl({}, { view: 'table' }).view).toBe('table')
    expect(parseAssetsUrl({ view: 'grid' }, { view: 'table' }).view).toBe('grid')
  })

  it('ignores a view, sort, direction or kind it does not recognise', () => {
    // The guard that matters: a remembered or hand-typed value must never be able to
    // assemble a request the route answers 400 to, which no amount of clicking would
    // then clear.
    const parsed = parseAssetsUrl(
      { view: 'masonry', sort: 'colour', dir: 'sideways', kind: 'video' },
      { view: 'grid' },
    )
    expect(parsed).toEqual(url())
  })

  it('reads the open asset out of the query, and an empty one as none', () => {
    expect(parseAssetsUrl({ asset: 'ast_x' }, { view: 'grid' }).asset).toBe('ast_x')
    expect(parseAssetsUrl({ asset: '' }, { view: 'grid' }).asset).toBeUndefined()
  })

  it('leaves every default out of the URL', () => {
    // `?view=grid&sort=created&dir=desc&kind=all` and the bare path are the same
    // screen, and only one of them is a link worth sending.
    expect(assetsQuery(url())).toEqual({
      view: undefined,
      sort: undefined,
      dir: undefined,
      kind: undefined,
      q: undefined,
      asset: undefined,
    })
  })

  it('writes what is not a default', () => {
    expect(assetsQuery(url({ view: 'table', sort: 'size', kind: 'image', q: 'logo' }))).toEqual({
      view: 'table',
      sort: 'size',
      // `size`'s own direction is descending, so it stays out even here.
      dir: undefined,
      kind: 'image',
      q: 'logo',
      asset: undefined,
    })
  })

  it('round trips every screen state', () => {
    const states: AssetsUrl[] = [
      url(),
      url({ view: 'table' }),
      url({ sort: 'filename' }),
      url({ sort: 'filename', dir: 'desc' }),
      url({ sort: 'size', dir: 'asc' }),
      url({ kind: 'application', q: 'invoice' }),
      url({ asset: 'ast_x' }),
    ]
    for (const state of states) {
      const written = assetsQuery(state)
      const query: Record<string, string> = {}
      for (const [key, value] of Object.entries(written))
        if (value !== undefined) query[key] = value
      expect(parseAssetsUrl(query, { view: DEFAULT_ASSET_VIEW })).toEqual(state)
    }
  })

  it('knows a view name', () => {
    expect(isAssetView('grid')).toBe(true)
    expect(isAssetView('table')).toBe(true)
    expect(isAssetView('list')).toBe(false)
  })
})

describe('sorting', () => {
  it('gives each ordering the direction server/assets.ts gives it', () => {
    // `ORDERS` there is `created: NEWEST_FIRST`, `filename: asc`, `size: desc`. Two
    // statements of one fact, and this is the one that catches them drifting.
    expect(naturalDir('created')).toBe('desc')
    expect(naturalDir('filename')).toBe('asc')
    expect(naturalDir('size')).toBe('desc')
  })

  it('resolves the absent direction to the natural one', () => {
    expect(dirOf(url({ sort: 'filename' }))).toBe('asc')
    expect(dirOf(url({ sort: 'filename', dir: 'desc' }))).toBe('desc')
  })

  it('flips the direction when the same ordering is chosen again', () => {
    expect(withSort(url({ sort: 'filename' }), 'filename').dir).toBe('desc')
    expect(withSort(url({ sort: 'filename', dir: 'desc' }), 'filename').dir).toBe('asc')
  })

  it('starts a different ordering at its own natural direction', () => {
    // Reversed to Z→A, then asked for size: descending, which is largest first — not
    // the ascending the previous column was left on.
    const reversed = url({ sort: 'filename', dir: 'desc' })
    expect(withSort(reversed, 'size')).toMatchObject({ sort: 'size', dir: 'desc' })
    const ascending = url({ sort: 'size', dir: 'asc' })
    expect(withSort(ascending, 'filename')).toMatchObject({ sort: 'filename', dir: 'asc' })
  })

  it('has a column for every ordering, and names which one is sorted', () => {
    const sorts: AssetSort[] = ['created', 'filename', 'size']
    for (const sort of sorts) {
      const column = ASSET_COLUMNS.find((c) => c.sort === sort)
      expect(column, `no column sorts by ${sort}`).toBeDefined()
      expect(sortColumnKey(url({ sort }))).toBe(column?.key)
    }
  })
})

describe('the view toggle and the filters', () => {
  it('keeps the filters across a view change', () => {
    // The one place this toggle differs from Content's `[ Tree | Flat ]`, which clears
    // them: a grid and a table are two arrangements of one query, so a filter means
    // exactly the same thing in both.
    const filtered = url({ kind: 'image', q: 'hero', asset: 'ast_x' })
    expect(withView(filtered, 'table')).toEqual({ ...filtered, view: 'table' })
  })

  it('keeps the open asset across a filter change', () => {
    // A filter is about the list; `asset` names a file. Closing the panel because
    // somebody typed in the search box throws away what they were reading.
    const open = url({ asset: 'ast_x' })
    expect(withFilter(open, { q: 'logo' })).toEqual({ ...open, q: 'logo' })
    expect(withFilter(open, { kind: 'image' })).toEqual({ ...open, kind: 'image' })
  })

  it('tells an empty library from a filter that matches nothing', () => {
    expect(isNarrowed(url())).toBe(false)
    expect(isNarrowed(url({ q: '  ' }))).toBe(false)
    expect(isNarrowed(url({ q: 'logo' }))).toBe(true)
    expect(isNarrowed(url({ kind: 'image' }))).toBe(true)
  })
})

describe('the request', () => {
  it('always states the ordering, and omits a filter that is not set', () => {
    const params = assetsParams(url(), { limit: 48 })
    expect(params.get('sort')).toBe('created')
    expect(params.get('dir')).toBe('desc')
    expect(params.get('limit')).toBe('48')
    expect(params.get('kind')).toBeNull()
    expect(params.get('q')).toBeNull()
    expect(params.get('count')).toBeNull()
    expect(params.get('cursor')).toBeNull()
  })

  it('carries the filter, the count and the cursor when asked', () => {
    const params = assetsParams(url({ kind: 'image', q: ' logo ' }), {
      limit: 48,
      cursor: 'abc',
      count: true,
    })
    expect(params.get('kind')).toBe('image')
    // Trimmed, so a trailing space from a paste is not a different query — and so the
    // cursor-resetting identity string does not change on a keystroke that changed
    // nothing.
    expect(params.get('q')).toBe('logo')
    expect(params.get('count')).toBe('1')
    expect(params.get('cursor')).toBe('abc')
  })

  it('never sends the open asset', () => {
    // It is a place on the screen, not a narrowing of the list.
    expect(assetsParams(url({ asset: 'ast_x' }), { limit: 48 }).get('asset')).toBeNull()
  })

  it('is identical with and without a cursor apart from the cursor', () => {
    // The property `useAssets` leans on: the request minus the cursor is the identity
    // that resets paging, so anything else changing has to change that string too.
    const state = url({ kind: 'image', q: 'logo', sort: 'size' })
    const withCursor = assetsParams(state, { limit: 48, cursor: 'abc', count: true })
    withCursor.delete('cursor')
    expect(withCursor.toString()).toBe(assetsParams(state, { limit: 48, count: true }).toString())
  })
})

describe('the kind a field imposes', () => {
  it('reads a single prefix out of an accept', () => {
    expect(kindForAccept('image/*')).toBe('image')
    expect(kindForAccept('image/png,image/webp')).toBe('image')
    expect(kindForAccept(' IMAGE/PNG ')).toBe('image')
    expect(kindForAccept('application/pdf')).toBe('application')
  })

  it('imposes nothing when the accept is absent, mixed or unrepresentable', () => {
    // `?kind=` is one content-type prefix, so a mixed accept is not expressible as
    // one — and imposing half of it would hide files the field can store.
    expect(kindForAccept(undefined)).toBeUndefined()
    expect(kindForAccept('')).toBeUndefined()
    expect(kindForAccept('image/png,application/pdf')).toBeUndefined()
    // `video` is a real prefix and no stored row can ever have it: `uploadAsset`
    // stores an allowlisted image type or `application/octet-stream`.
    expect(kindForAccept('video/mp4')).toBeUndefined()
  })
})

describe('what a tile and a cell read', () => {
  it('shows bytes at a scale somebody reads', () => {
    expect(humanSize(0)).toBe('0 B')
    expect(humanSize(300)).toBe('300 B')
    // The floor that matters: a 1KB-ish file must not read as taking no space.
    expect(humanSize(1024)).toBe('1 kB')
    expect(humanSize(204_800)).toBe('200 kB')
    expect(humanSize(4 * 1024 * 1024)).toBe('4.0 MB')
  })

  it('has no dimensions for a file whose header could not be read', () => {
    expect(dimensionsOf(row())).toBe('1200×800')
    expect(dimensionsOf(row({ width: null, height: null }))).toBe('')
    expect(dimensionsOf(row({ width: 1200, height: null }))).toBe('')
  })

  it('labels a type by its extension, because the stored type is lossy', () => {
    // A PDF, a zip and a font are all `application/octet-stream`, and `PDF` is what
    // somebody is scanning the column for.
    expect(typeLabel(row({ filename: 'terms.pdf', contentType: 'application/octet-stream' }))).toBe(
      'PDF',
    )
    expect(typeLabel(row())).toBe('JPG')
    expect(typeLabel(row({ filename: 'noext', contentType: 'application/octet-stream' }))).toBe(
      'octet-stream',
    )
  })

  it('reads an extension without mistaking a dotfile for one', () => {
    expect(extensionOf('photo.jpg')).toBe('jpg')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('noext')).toBe('')
  })

  it('calls an image renderable only when the stored type says so', () => {
    expect(isRenderableImage(row())).toBe(true)
    // An SVG that passed the upload sniff is stored as `image/svg+xml`, served
    // inline behind the sandbox CSP, and renders here.
    expect(isRenderableImage(row({ filename: 'logo.svg', contentType: 'image/svg+xml' }))).toBe(
      true,
    )
    // The trap, which the filename cannot tell apart from the line above. This
    // `.svg` failed the sniff — HTML wearing the extension, say — so it is stored
    // as `application/octet-stream` and comes back as an attachment. It passes
    // `core/values.ts`'s `isImageAsset` on its filename alone, and an `<img>`
    // pointing at it renders nothing.
    expect(
      isRenderableImage(row({ filename: 'logo.svg', contentType: 'application/octet-stream' })),
    ).toBe(false)
    expect(
      isRenderableImage(row({ filename: 'terms.pdf', contentType: 'application/octet-stream' })),
    ).toBe(false)
  })

  it('points every image through the transform route', () => {
    // Never the original: a 4MB PNG must not be the 160px tile.
    expect(thumbUrl('/folio', row(), 320)).toBe('/folio/asset/ast_abc123-photo.jpg?w=320&f=webp')
    // And the download link is the original, untransformed.
    expect(originalUrl('/folio', row())).toBe('/folio/asset/ast_abc123-photo.jpg')
  })

  it('shows a relative stamp, coarsening as it ages', () => {
    const now = 1_700_000_000_000
    expect(addedAgo(now, now)).toBe('just now')
    expect(addedAgo(now - 5 * 60_000, now)).toBe('5m ago')
    expect(addedAgo(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(addedAgo(now - 4 * 86_400_000, now)).toBe('4d ago')
    // Past a month a date beats a number of days nobody counts in.
    expect(addedAgo(now - 200 * 86_400_000, now)).not.toMatch(/ago/)
  })
})

describe('the field value', () => {
  it('agrees with the server toAssetValue it is a copy of', () => {
    // The whole reason a copy is acceptable: `server/assets.ts` is a Worker module and
    // importing it into the admin bundle to reuse eight assignments is the wrong
    // trade, so the agreement is asserted instead of assumed.
    for (const subject of [
      row(),
      row({ width: null, height: null }),
      row({ alt: '' }),
      row({
        filename: 'terms.pdf',
        contentType: 'application/octet-stream',
        width: null,
        height: null,
      }),
    ]) {
      expect(assetValue(subject)).toEqual(toAssetValue(subject))
    }
  })

  it('carries no focal point, because a row has none', () => {
    // A focal point belongs to a *use* of a file: it answers "what stays in frame when
    // this block crops it", which differs per placement. There is no column for it.
    expect(assetValue(row())).not.toHaveProperty('focal')
  })

  it('omits absent dimensions rather than writing nulls into a document', () => {
    expect(assetValue(row({ width: null, height: null }))).toEqual({
      key: 'ast_abc123-photo.jpg',
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      size: 204_800,
      alt: 'A photo',
    })
  })
})

describe('what the detail panel is showing', () => {
  const idle = { row: null, gone: false, error: null, loading: false }

  it('shows nothing when the URL names no asset', () => {
    expect(panelSubject(undefined, null, idle)).toEqual({ state: 'none' })
    // Even with a row lying around from a previous selection.
    expect(panelSubject(undefined, row(), idle)).toEqual({ state: 'none' })
  })

  it('prefers a row already in hand over any lookup state', () => {
    // The property that stops the panel flickering to a skeleton every time the list is
    // re-read after a PATCH or a delete.
    const inHand = row()
    expect(panelSubject(inHand.id, inHand, { ...idle, loading: true })).toEqual({
      state: 'row',
      row: inHand,
    })
    expect(panelSubject(inHand.id, inHand, { ...idle, gone: true })).toEqual({
      state: 'row',
      row: inHand,
    })
  })

  it('uses a resolved row when nothing was in hand', () => {
    const resolved = row()
    expect(panelSubject(resolved.id, null, { ...idle, row: resolved })).toEqual({
      state: 'row',
      row: resolved,
    })
  })

  it('ignores a row that is not the one asked for', () => {
    // Both directions: a stale `inHand` from the previous selection, and a lookup that
    // has not caught up with a newer id. Either one rendered would put the wrong file's
    // alt text in front of somebody.
    const other = row({ id: 'ast_other' })
    expect(panelSubject('ast_wanted', other, idle).state).toBe('loading')
    expect(panelSubject('ast_wanted', null, { ...idle, row: other }).state).toBe('loading')
  })

  it('tells a deleted file from a failed request', () => {
    // The distinction the whole type exists for. Saying "could not load" about a 404
    // sends somebody hunting a network problem that is not there; saying "that file is
    // gone" about a dropped connection tells them to go looking for a backup.
    expect(panelSubject('ast_x', null, { ...idle, gone: true })).toEqual({ state: 'gone' })
    expect(panelSubject('ast_x', null, { ...idle, error: 'Failed to fetch' })).toEqual({
      state: 'error',
      message: 'Failed to fetch',
    })
  })

  it('is loading on the render before the request has even started', () => {
    // `useAsset`'s state is idle until its effect runs, so the first render of a cold
    // link arrives here with nothing set. It must not read as an error.
    expect(panelSubject('ast_x', null, idle)).toEqual({ state: 'loading' })
    expect(panelSubject('ast_x', null, { ...idle, loading: true })).toEqual({ state: 'loading' })
  })
})

describe('keyboard traversal across the grid', () => {
  // 10 tiles, 4 columns:  0 1 2 3 / 4 5 6 7 / 8 9
  const COUNT = 10
  const COLS = 4

  it('lands on the first tile from the container, whichever key it was', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']) {
      expect(gridStep(key, -1, COUNT, COLS)).toBe(0)
    }
  })

  it('moves by one across and by a row down', () => {
    expect(gridStep('ArrowRight', 0, COUNT, COLS)).toBe(1)
    expect(gridStep('ArrowLeft', 1, COUNT, COLS)).toBe(0)
    expect(gridStep('ArrowDown', 1, COUNT, COLS)).toBe(5)
    expect(gridStep('ArrowUp', 5, COUNT, COLS)).toBe(1)
  })

  it('clamps at both ends rather than wrapping', () => {
    // `rank.ts`'s `nextIndex` is modulo, which in a grid is a jump from bottom-right
    // to top-left — two axes at once, and it reads as focus having been lost.
    expect(gridStep('ArrowRight', COUNT - 1, COUNT, COLS)).toBe(COUNT - 1)
    expect(gridStep('ArrowLeft', 0, COUNT, COLS)).toBe(0)
    expect(gridStep('ArrowUp', 2, COUNT, COLS)).toBe(0)
    // Down from the last full row has no row below it, so it stops on the last tile
    // rather than off the end.
    expect(gridStep('ArrowDown', 7, COUNT, COLS)).toBe(9)
    expect(gridStep('ArrowDown', 9, COUNT, COLS)).toBe(9)
  })

  it('crosses the whole set with Home and End, and pages by three rows', () => {
    expect(gridStep('Home', 9, COUNT, COLS)).toBe(0)
    expect(gridStep('End', 0, COUNT, COLS)).toBe(9)
    expect(gridStep('PageDown', 0, 100, COLS)).toBe(12)
    expect(gridStep('PageUp', 40, 100, COLS)).toBe(28)
  })

  it('claims nothing else, and nothing at all in an empty grid', () => {
    expect(gridStep('Enter', 0, COUNT, COLS)).toBeNull()
    expect(gridStep('a', 0, COUNT, COLS)).toBeNull()
    expect(gridStep('ArrowDown', 0, 0, COLS)).toBeNull()
  })

  it('survives a column count of zero', () => {
    // `columnsOf` measures the DOM and can answer 0 for a grid that has not laid out
    // yet; a step of 0 would make ArrowDown do nothing forever.
    expect(gridStep('ArrowDown', 0, COUNT, 0)).toBe(1)
  })
})

describe('the upload report', () => {
  const entry = (id: string, status: 'uploading' | 'done' | 'failed', error?: string) => ({
    id,
    filename: `${id}.png`,
    status,
    ...(error ? { error } : {}),
  })

  it('counts what has settled while a batch runs', () => {
    expect(
      uploadSummary([entry('a', 'done'), entry('b', 'uploading'), entry('c', 'uploading')]),
    ).toMatchObject({ busy: true, text: 'Uploading 2 of 3…' })
  })

  it('names the split rather than rounding it', () => {
    // The reason the per-file list exists: `MAX_UPLOAD_BYTES` and the content-length
    // check refuse per request, so nine of ten landing is the normal partial outcome.
    expect(
      uploadSummary([entry('a', 'done'), entry('b', 'failed', 'File is larger than 20MB')]),
    ).toMatchObject({ busy: false, done: 1, failed: 1, text: '1 uploaded · 1 failed' })
    expect(uploadSummary([entry('a', 'failed', 'Empty upload')])).toMatchObject({
      text: '1 failed',
    })
  })

  it('reads as a plain success when nothing failed', () => {
    expect(uploadSummary([entry('a', 'done')]).text).toBe('Uploaded 1 file')
    expect(uploadSummary([entry('a', 'done'), entry('b', 'done')]).text).toBe('Uploaded 2 files')
  })
})
