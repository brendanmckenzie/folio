import { useCallback, useState } from 'react'
import type { AssetValue } from '../../../core/values'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { useRememberedString } from '../remembered'
import {
  type AssetRow,
  type AssetsUrl,
  type AssetView,
  assetValue,
  DEFAULT_ASSET_VIEW,
  isAssetView,
  kindForAccept,
} from './assets-model'
import { AssetBrowser } from './AssetBrowser'
import css from './Assets.module.css'
import { useAsset, useAssets, useDropTarget, useUploads } from './useAssets'

/**
 * The remembered view, shared with the screen.
 *
 * **One key, deliberately.** `ui-architecture.md` gives Assets a single grid/table
 * preference, not one per surface: somebody who works in the table does not want the
 * picker to open as a grid. The screen's copy of this is wired by whatever mounts
 * `Assets` — it takes `remembered`/`onRemember` as props, because the shell owns the
 * `localStorage` access for every screen — while the picker is mounted by an asset
 * *field*, which has nothing above it to wire, so it reads the same key itself.
 */
export const ASSET_VIEW_KEY = 'folio.assets.view'

export interface AssetPickerProps {
  /** The admin's internal JSON base — `{base}/api`. */
  apiBase: string
  /** Where Folio is mounted — `{base}`. Thumbnails come off `/asset/:key`, which is
   * not part of the internal API and stays on the bare mount. */
  mount: string
  /** The field's `accept`. Narrows the file input, and — when every entry shares one
   * prefix — narrows the listing server-side through `?kind=`. */
  accept?: string
  /** What an asset field stores: `toAssetValue`'s output, which `assetValue` mirrors
   * client-side. */
  onPick: (value: AssetValue) => void
  onClose: () => void
}

/**
 * **The second mount.** The same `AssetBrowser` the screen renders full width, inside
 * a `Dialog` at `wide` — which is the sentence `docs/ui-architecture.md`'s Assets
 * section ends on, and the requirement this file exists to keep honest.
 *
 * What it adds and what it drops, both on purpose:
 *
 *  - **Adds one commit affordance: the footer's *Use this file*.** The browser reports
 *    a selection and nothing more, so the choose gesture exists once, in a dialog
 *    footer, reachable by Tab. An earlier shape put a *Use* button on every tile plus a
 *    double-click accelerator, which is three ways to commit and two of them invisible
 *    to a keyboard.
 *  - **Drops the detail panel.** Alt text, the focal-point explanation, usage and
 *    delete are all about *managing* a file. Picking one is a different job, and a
 *    single-question dialog that also edits the thing it is asking about is how a
 *    picker turns into a second Assets screen.
 *  - **Keeps the URL model, in `useState`.** The picker's search, filter, sort, view
 *    and page are the same `AssetsUrl` the screen keeps in the address bar. That is
 *    what lets one browser serve both: it reads state and reports changes, and where
 *    the state lives is the mount's business.
 *  - **Takes no `onNotice`.** Choosing writes nothing, and the only failure this
 *    surface can produce — an upload — is already named per file inside the browser's
 *    own report. A toast channel that nothing would ever send down is a prop every
 *    caller has to satisfy for no reason.
 *
 * The library half of `AssetInput.tsx` is what this replaces: `MediaLibrary`, its
 * `.library*` CSS namespace and its hand-rolled focus trap. It is deliberately left in
 * place for now — it belongs to the old single-screen editor, which owns
 * `{base}/edit/:id` until port phase 7, exactly as `StoryTree.tsx` did at phase 2. It
 * goes with the file that uses it.
 */
export function AssetPicker({ apiBase, mount, accept, onPick, onClose }: AssetPickerProps) {
  const remembered = useRememberedString<AssetView>(ASSET_VIEW_KEY, DEFAULT_ASSET_VIEW, isAssetView)

  /**
   * The kind the field imposes, if any. `image/*` means only an image may be stored,
   * so the listing asks the route for images and the chips are **absent** rather than
   * present-and-misleading — offering "All" in a picker for an image field is offering
   * a choice whose result cannot be used, and the system's rule is that impossible
   * controls are absent.
   *
   * Server-side, which is the whole point: narrowing the fetched page client-side
   * would filter *the page* and not the library, which is the exact mistake
   * `docs/specs/foundation/pagination.md` exists to prevent.
   */
  const imposed = kindForAccept(accept)

  const [url, setUrl] = useState<AssetsUrl>(() => ({
    view: remembered.value,
    sort: 'created',
    dir: undefined,
    kind: imposed ?? 'all',
    q: '',
    asset: undefined,
  }))
  const [selected, setSelected] = useState<string | undefined>(undefined)

  const data = useAssets(apiBase, url)

  // Selected, not chosen. The file somebody just dropped in is almost certainly the
  // one they want, but committing on their behalf would close the dialog and write a
  // field value out of a drag gesture.
  const onUploaded = useCallback(
    (done: readonly AssetRow[]) => {
      if (done.length === 0) return
      data.reload()
      setSelected(done[done.length - 1]!.id)
    },
    [data],
  )
  const upload = useUploads(apiBase, onUploaded)

  const onFiles = useCallback((files: FileList | null) => upload.add(files), [upload])
  const drop = useDropTarget(onFiles)

  /**
   * The selected row, resolved by id when the page does not hold it.
   *
   * The one case where it does not: a fresh upload. `onUploaded` selects what just
   * arrived and reloads, but under a `filename` or `size` ordering the new file need
   * not be on page one — and *Use this file* sitting disabled over a tile that looks
   * selected is the bug that produces. The same `useAsset` the screen resolves a cold
   * link with, asking for nothing in the ordinary case where the row is right there.
   */
  const inPage = data.page.rows.find((row) => row.id === selected)
  const lookup = useAsset(apiBase, inPage ? undefined : selected)
  const chosen = inPage ?? (lookup.row?.id === selected ? lookup.row : undefined)

  return (
    <Dialog
      title="Choose a file"
      size="wide"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!chosen}
            reason="Select a file first"
            onClick={() => {
              if (chosen) onPick(assetValue(chosen))
            }}
          >
            Use this file
          </Button>
        </>
      }
    >
      {/*
        The drop target is the dialog's body, which is what "anywhere" means in this
        mount — the screen's is the whole screen. Same hook, same handlers, different
        bounds.
      */}
      <div className={css.dropZone} {...drop.handlers}>
        <AssetBrowser
          mount={mount}
          url={url}
          onUrl={(next) => {
            setUrl(next)
            remembered.set(next.view)
          }}
          data={data}
          upload={upload}
          selected={selected}
          onSelect={setSelected}
          label="Choose a file"
          kinds={imposed === undefined}
          accept={accept}
          compact
        />
        {drop.over ? (
          <div className={css.dropVeil} aria-hidden="true">
            Drop to upload
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
