import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Json } from '../core/doc'
import { asAsset, asAssets, isImageAsset, type AssetValue } from '../core/values'
import { expectJson, expectOk } from './api'
import { useFolio } from './FolioContext'
import { useFocusTrap } from './hooks/useFocusTrap'
import { useUpload } from './hooks/useUpload'
import type { Page } from '../core/pagination'

/** A row of the media library, as `GET /assets` returns it. */
interface AssetRow {
  id: string
  key: string
  filename: string
  contentType: string
  size: number
  width: number | null
  height: number | null
  alt: string
  createdAt: number
}

/** `base`, not `apiBase`: `/asset/:key` serves bytes into an `<img>` and stays on
 * the bare mount, because its URL is also baked into published HTML through
 * `Resolution.assetBase`. */
const thumb = (base: string, asset: AssetValue, width = 320) => {
  if (!asset.key) return asset.url!
  return `${base}/asset/${asset.key}?w=${width}&f=webp`
}

const humanSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} kB`

/* ------------------------------------------------------------- single ---- */

interface Props {
  id: string
  value: Json
  accept?: string
  onChange: (value: Json) => void
}

export function AssetInput({ id, value, accept, onChange }: Props) {
  const { apiBase } = useFolio()
  const asset = asAsset(value)
  const upload = useUpload(apiBase)
  const [picking, setPicking] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const take = async (chosen: File | undefined) => {
    const next = await upload.one(chosen)
    if (next) onChange(next as unknown as Json)
  }

  return (
    <div className="asset">
      <input
        ref={file}
        id={id}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          void take(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {asset ? (
        <AssetCard
          asset={asset}
          onChange={(next) => onChange(next as unknown as Json)}
          onRemove={() => onChange(null)}
        />
      ) : null}

      <div className="asset__actions">
        <button type="button" disabled={upload.busy} onClick={() => file.current?.click()}>
          {upload.busy ? 'Uploading…' : asset ? 'Replace' : 'Upload'}
        </button>
        <button type="button" onClick={() => setPicking(true)}>
          Library
        </button>
      </div>

      {upload.error ? <p className="asset__error">{upload.error}</p> : null}

      {picking ? (
        <MediaLibrary
          accept={accept}
          onPick={(picked) => {
            onChange(picked as unknown as Json)
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- many ---- */

/**
 * One card's stable React key, paired with the asset it is drawn from.
 *
 * The key is **local and minted here**. It is never written back: a `multiasset`
 * value is an array of `AssetValue`, and adding an id to it would put a
 * client-side render detail into the mutation log, where it would outlive every
 * deploy. So identity is reconstructed on each render instead, from the previous
 * render's answer.
 */
export interface KeyedAsset {
  /** Minted, not stored. Only ever a React key. */
  id: string
  asset: AssetValue
}

/** The R2 key, or the absolute URL for an asset hosted elsewhere. Not unique —
 * the same file may legitimately appear twice in one list, which is exactly why
 * the index was being used as a key in the first place. */
const mediaOf = (a: AssetValue) => a.key ?? a.url ?? ''

/** Whole-value equality: the card is showing precisely this, alt and focal
 * point included. */
const sameAsset = (a: AssetValue, b: AssetValue) =>
  a.key === b.key &&
  a.url === b.url &&
  a.filename === b.filename &&
  a.contentType === b.contentType &&
  a.size === b.size &&
  a.width === b.width &&
  a.height === b.height &&
  a.alt === b.alt &&
  a.focal?.x === b.focal?.x &&
  a.focal?.y === b.focal?.y

/**
 * Carry the previous render's card ids onto this render's assets, minting one
 * wherever nothing matches. Pure and exported so the reorder case is tested
 * without mounting.
 *
 * `asAssets` rebuilds every object on every render, so object identity is worth
 * nothing here and the match has to be made on content. It happens in two
 * passes, and the order is the whole point:
 *
 * 1. **Byte-identical first.** A reorder moves values around without changing
 *    any of them, so every card finds its own id and React moves DOM nodes
 *    instead of remounting them. That is what stops a reorder dropping focus.
 * 2. **Then same media, edited.** Typing in a card's alt box changes the value
 *    but not the card, so an unclaimed entry with the same `key`/`url` hands its
 *    id over. Without this pass every keystroke would remount the card and the
 *    caret would be lost after one character — a worse bug than the one being
 *    fixed.
 *
 * Both passes consume from the same pool, so two copies of one file get two
 * distinct ids and keep them.
 */
export function keyAssets(
  previous: readonly KeyedAsset[],
  assets: readonly AssetValue[],
  mint: () => string,
): KeyedAsset[] {
  const spare: (KeyedAsset | undefined)[] = [...previous]
  const out: (KeyedAsset | undefined)[] = assets.map(() => undefined)

  const claim = (at: number, asset: AssetValue): KeyedAsset => {
    const taken = spare[at]!
    spare[at] = undefined
    return { id: taken.id, asset }
  }

  assets.forEach((asset, i) => {
    const at = spare.findIndex((e) => e !== undefined && sameAsset(e.asset, asset))
    if (at !== -1) out[i] = claim(at, asset)
  })

  assets.forEach((asset, i) => {
    if (out[i]) return
    const at = spare.findIndex((e) => e !== undefined && mediaOf(e.asset) === mediaOf(asset))
    out[i] = at === -1 ? { id: mint(), asset } : claim(at, asset)
  })

  return out as KeyedAsset[]
}

/** `keyAssets` against the previous render, held in a ref. Reconciling during
 * render rather than in an effect is deliberate: the keys have to be right for
 * the markup being produced now, not one paint later. It is idempotent, so
 * StrictMode's double render produces the same ids. */
function useAssetKeys(assets: readonly AssetValue[]): KeyedAsset[] {
  const previous = useRef<KeyedAsset[]>([])
  const seq = useRef(0)
  const keyed = keyAssets(previous.current, assets, () => {
    seq.current += 1
    return `asset-${seq.current}`
  })
  previous.current = keyed
  return keyed
}

export function MultiAssetInput({ id, value, accept, max, onChange }: Props & { max?: number }) {
  const { apiBase } = useFolio()
  const assets = asAssets(value)
  const cards = useAssetKeys(assets)
  const upload = useUpload(apiBase)
  const [picking, setPicking] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const full = max !== undefined && assets.length >= max

  const write = (next: AssetValue[]) => onChange(next as unknown as Json)

  const add = async (chosen: FileList | null) => {
    const room = max === undefined ? (chosen?.length ?? 0) : Math.max(0, max - assets.length)
    const uploaded = await upload.many(chosen, room)
    if (uploaded) write([...assets, ...uploaded])
  }

  const swap = (from: number, to: number) => {
    if (to < 0 || to >= assets.length) return
    const next = [...assets]
    ;[next[from], next[to]] = [next[to]!, next[from]!]
    write(next)
  }

  return (
    <div className="asset">
      <input
        ref={file}
        id={id}
        type="file"
        accept={accept}
        multiple
        hidden
        onChange={(e) => {
          void add(e.target.files)
          e.target.value = ''
        }}
      />

      {cards.map(({ id: cardId, asset }, i) => (
        <AssetCard
          key={cardId}
          asset={asset}
          position={{ index: i, total: assets.length }}
          onMove={(to) => swap(i, to)}
          onChange={(next) => write(assets.map((a, j) => (i === j ? next : a)))}
          onRemove={() => write(assets.filter((_, j) => j !== i))}
        />
      ))}

      <div className="asset__actions">
        <button type="button" disabled={upload.busy || full} onClick={() => file.current?.click()}>
          {upload.busy ? 'Uploading…' : 'Upload'}
        </button>
        <button type="button" disabled={full} onClick={() => setPicking(true)}>
          Library
        </button>
        {full ? <span className="asset__note">Limit of {max} reached</span> : null}
      </div>

      {upload.error ? <p className="asset__error">{upload.error}</p> : null}

      {picking ? (
        <MediaLibrary
          accept={accept}
          onPick={(picked) => {
            write([...assets, picked])
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- card ---- */

function AssetCard({
  asset,
  position,
  onChange,
  onRemove,
  onMove,
}: {
  asset: AssetValue
  position?: { index: number; total: number }
  onChange: (next: AssetValue) => void
  onRemove: () => void
  onMove?: (to: number) => void
}) {
  const { apiBase } = useFolio()
  const image = isImageAsset(asset)
  const focal = asset.focal

  // Clicking the image is the whole focal-point UI: pick the spot that must stay
  // in frame when this gets cropped to some other aspect ratio.
  const setFocal = (e: React.MouseEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    onChange({
      ...asset,
      focal: {
        x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
        y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
      },
    })
  }

  return (
    <div className="asset__card">
      {image ? (
        <button
          type="button"
          className="asset__thumb"
          onClick={setFocal}
          title="Click to set the focal point"
        >
          <img src={thumb(apiBase, asset)} alt="" />
          {focal ? (
            <span
              className="asset__focal"
              style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
            />
          ) : null}
        </button>
      ) : (
        <div className="asset__file">
          {asset.filename.split('.').pop()?.toUpperCase() ?? 'FILE'}
        </div>
      )}

      <div className="asset__meta">
        <span className="asset__name" title={asset.filename}>
          {asset.filename}
        </span>
        <span className="asset__dims">
          {asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}
          {asset.size ? humanSize(asset.size) : 'external'}
        </span>

        {image ? (
          <input
            type="text"
            placeholder="Alt text"
            value={asset.alt}
            onChange={(e) => onChange({ ...asset, alt: e.target.value })}
          />
        ) : null}

        <div className="asset__row">
          {focal ? (
            <button
              type="button"
              className="asset__link"
              onClick={() => {
                const { focal: _drop, ...rest } = asset
                onChange(rest)
              }}
            >
              Centre focal point
            </button>
          ) : null}
          {position && onMove ? (
            <>
              <button
                type="button"
                className="asset__link"
                disabled={position.index === 0}
                onClick={() => onMove(position.index - 1)}
              >
                Up
              </button>
              <button
                type="button"
                className="asset__link"
                disabled={position.index === position.total - 1}
                onClick={() => onMove(position.index + 1)}
              >
                Down
              </button>
            </>
          ) : null}
          <button type="button" className="asset__link asset__link--danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ library ---- */

function MediaLibrary({
  accept,
  onPick,
  onClose,
}: {
  accept?: string
  onPick: (asset: AssetValue) => void
  onClose: () => void
}) {
  const { apiBase } = useFolio()
  const [rows, setRows] = useState<AssetRow[] | null>(null)
  /** The library's own last refusal: a list or a delete the server would not do. */
  const [failure, setFailure] = useState<string | null>(null)
  const upload = useUpload(apiBase)
  const file = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  const load = useCallback(async () => {
    try {
      // `Page<AssetRow>` since `foundation/pagination.md` phase 4 — and this modal
      // still shows only the first page, which is the honest interim: the route can
      // now reach asset 201, and the Assets *screen* is what will.
      setRows((await expectJson<Page<AssetRow>>(await fetch(`${apiBase}/assets`))).rows)
    } catch (e) {
      // A library that could not be read is not an empty one: rendering `[]`
      // alone would say "Nothing uploaded yet" about media that is still there.
      setRows([])
      setFailure((e as Error).message)
    }
  }, [apiBase])

  useEffect(() => {
    void load()
  }, [load])

  // Focus in on open, back to the opener on close, Tab cycling inside, Escape
  // out. The grid has not loaded when focus moves in, so the first landing spot
  // is Upload in the head.
  useFocusTrap(panel, onClose)

  const add = async (chosen: File | undefined) => {
    const picked = await upload.one(chosen)
    if (picked) onPick(picked)
  }

  const remove = async (id: string) => {
    setFailure(null)
    try {
      await expectOk(
        await fetch(`${apiBase}/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      )
    } catch (e) {
      // A refused delete — an unknown asset, or no media bucket bound at all —
      // was silent: the row simply came back on the reload below, which reads as
      // the click not having registered.
      setFailure((e as Error).message)
    }
    await load()
  }

  return (
    <div className="library">
      {/* Clicking the backdrop still closes, and so does Escape: focus is
          trapped, but never without a way out. `tabIndex={-1}` keeps this out of
          the cycle — it is the same affordance as the head's Close button, and a
          keyboard user should meet the one they can see. */}
      <button
        type="button"
        className="library__scrim"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
      />
      {/* The dialog is the panel, not the overlay: the scrim is chrome, and
          naming it part of the dialog would put a bare "Close" button inside the
          thing being described. */}
      <div
        ref={panel}
        className="library__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="library__head">
          <strong id={titleId}>Media library</strong>
          <input
            ref={file}
            type="file"
            accept={accept}
            hidden
            onChange={(e) => {
              void add(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <div className="library__head-actions">
            <button type="button" disabled={upload.busy} onClick={() => file.current?.click()}>
              {upload.busy ? 'Uploading…' : 'Upload'}
            </button>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {upload.error ? <p className="asset__error">{upload.error}</p> : null}
        {failure ? <p className="asset__error">{failure}</p> : null}

        {rows === null ? (
          <p className="library__empty">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="library__empty">Nothing uploaded yet.</p>
        ) : (
          <ul className="library__grid">
            {rows.map((row) => {
              const asset: AssetValue = {
                key: row.key,
                filename: row.filename,
                contentType: row.contentType,
                size: row.size,
                ...(row.width ? { width: row.width } : {}),
                ...(row.height ? { height: row.height } : {}),
                alt: row.alt,
              }
              return (
                <li key={row.id}>
                  <button type="button" className="library__item" onClick={() => onPick(asset)}>
                    {isImageAsset(asset) ? (
                      <img src={thumb(apiBase, asset, 240)} alt="" />
                    ) : (
                      <span className="asset__file">
                        {row.filename.split('.').pop()?.toUpperCase() ?? 'FILE'}
                      </span>
                    )}
                    <span className="library__name">{row.filename}</span>
                  </button>
                  <button
                    type="button"
                    className="library__del"
                    onClick={() => void remove(row.id)}
                  >
                    Delete
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
