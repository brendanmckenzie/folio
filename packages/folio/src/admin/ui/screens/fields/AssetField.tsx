import { useRef, useState } from 'react'
import type { Json } from '../../../../core/doc'
import { asAsset, asAssets, type AssetValue, isImageAsset } from '../../../../core/values'
import { useUpload } from '../../../hooks/useUpload'
import { Button } from '../../Button'
import { Field, Input } from '../../Field'
import { AssetPicker } from '../AssetPicker'
import { humanSize, keyAssets, type KeyedAsset } from '../assets-model'
import css from './fields.module.css'

interface Props {
  id: string
  value: Json
  accept?: string
  /** `{base}/api`, for uploads and for the picker's listing. */
  apiBase: string
  /** The bare mount. `/asset/:key` serves bytes into an `<img>` and stays there,
   * because its URL is also baked into published HTML through
   * `Resolution.assetBase` (`server/routes/assets.ts` says so at the mount). */
  mount: string
  editable: boolean
  onChange: (value: Json) => void
}

/**
 * A thumbnail URL for a stored field value.
 *
 * `assets-model.ts`'s `thumbUrl` takes a library *row*, which always has a `key`; a
 * field value may instead be an absolute `url` for an asset hosted elsewhere, and
 * the transform route cannot touch that one. Hence the local copy rather than a
 * widened signature on the shared helper.
 */
function thumbFor(mount: string, asset: AssetValue, width = 320): string {
  if (!asset.key) return asset.url!
  return `${mount}/asset/${encodeURIComponent(asset.key)}?w=${width}&f=webp`
}

/* ------------------------------------------------------------------ single --- */

export function AssetField({ id, value, accept, apiBase, mount, editable, onChange }: Props) {
  const asset = asAsset(value)
  const upload = useUpload(apiBase)
  const [picking, setPicking] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const take = async (chosen: File | undefined) => {
    const next = await upload.one(chosen)
    if (next) onChange(next as unknown as Json)
  }

  return (
    <div className={css.stack}>
      <input
        ref={file}
        id={id}
        type="file"
        accept={accept}
        hidden
        disabled={!editable}
        onChange={(e) => {
          void take(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {asset ? (
        <AssetCard
          mount={mount}
          asset={asset}
          editable={editable}
          onChange={(next) => onChange(next as unknown as Json)}
          onRemove={() => onChange(null)}
        />
      ) : null}

      <div className={css.row}>
        <Button
          size="sm"
          disabled={!editable || upload.busy}
          reason={upload.busy ? 'Uploading…' : undefined}
          onClick={() => file.current?.click()}
        >
          {asset ? 'Replace' : 'Upload'}
        </Button>
        <Button size="sm" variant="subtle" disabled={!editable} onClick={() => setPicking(true)}>
          Library
        </Button>
      </div>

      {upload.error ? <p className={`${css.note} ${css.danger}`}>{upload.error}</p> : null}

      {picking ? (
        <AssetPicker
          apiBase={apiBase}
          mount={mount}
          {...(accept ? { accept } : {})}
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

/* -------------------------------------------------------------------- many --- */

/**
 * `keyAssets` against the previous render, held in a ref. Reconciling during render
 * rather than in an effect is deliberate: the keys have to be right for the markup
 * being produced now, not one paint later. It is idempotent, so StrictMode's double
 * render produces the same ids.
 *
 * The algorithm itself is `assets-model.ts`'s `keyAssets`, which is where it landed
 * when port phase 8 deleted `admin/AssetInput.tsx` — imported across the seam until
 * then rather than copied, so there was never a second version to reconcile. It is
 * two passes over a pool of previous ids and the order of the passes is the whole
 * point — byte-identical first so a reorder moves DOM nodes instead of remounting
 * them, same-media second so typing in a card's alt box does not remount it after
 * one character — and it stays pinned by `test/unit/admin/asset-keys.test.ts`.
 */
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

export function MultiAssetField({
  id,
  value,
  accept,
  apiBase,
  mount,
  editable,
  max,
  onChange,
}: Props & { max?: number }) {
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
    <div className={css.stack}>
      <input
        ref={file}
        id={id}
        type="file"
        accept={accept}
        multiple
        hidden
        disabled={!editable}
        onChange={(e) => {
          void add(e.target.files)
          e.target.value = ''
        }}
      />

      {cards.map(({ id: cardId, asset }, i) => (
        <AssetCard
          key={cardId}
          mount={mount}
          asset={asset}
          editable={editable}
          position={{ index: i, total: assets.length }}
          onMove={(to) => swap(i, to)}
          onChange={(next) => write(assets.map((a, j) => (i === j ? next : a)))}
          onRemove={() => write(assets.filter((_, j) => j !== i))}
        />
      ))}

      <div className={css.row}>
        <Button
          size="sm"
          disabled={!editable || upload.busy || full}
          reason={upload.busy ? 'Uploading…' : `Limit of ${max} reached`}
          onClick={() => file.current?.click()}
        >
          Upload
        </Button>
        <Button
          size="sm"
          variant="subtle"
          disabled={!editable || full}
          reason={`Limit of ${max} reached`}
          onClick={() => setPicking(true)}
        >
          Library
        </Button>
      </div>

      {upload.error ? <p className={`${css.note} ${css.danger}`}>{upload.error}</p> : null}

      {picking ? (
        <AssetPicker
          apiBase={apiBase}
          mount={mount}
          {...(accept ? { accept } : {})}
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

/* -------------------------------------------------------------------- card --- */

function AssetCard({
  mount,
  asset,
  editable,
  position,
  onChange,
  onRemove,
  onMove,
}: {
  mount: string
  asset: AssetValue
  editable: boolean
  position?: { index: number; total: number }
  onChange: (next: AssetValue) => void
  onRemove: () => void
  onMove?: (to: number) => void
}) {
  const image = isImageAsset(asset)
  const focal = asset.focal

  // Clicking the image is the whole focal-point UI: pick the spot that must stay in
  // frame when this gets cropped to some other aspect ratio.
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
    <div className={css.card}>
      {image ? (
        <button
          type="button"
          className={css.thumb}
          disabled={!editable}
          // `title` alone was the old markup's only name for this, which is a
          // tooltip and not an accessible name. Biome's `useButtonType` and
          // `noSvgWithoutTitle` are not what catch it; a review of what a screen
          // reader announces is.
          aria-label={`Set the focal point of ${asset.filename}`}
          title="Click to set the focal point"
          onClick={setFocal}
        >
          <img src={thumbFor(mount, asset)} alt="" />
          {focal ? (
            <span
              className={css.focal}
              style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
            />
          ) : null}
        </button>
      ) : (
        <div className={css.file}>{asset.filename.split('.').pop()?.toUpperCase() ?? 'FILE'}</div>
      )}

      <div className={css.meta}>
        <span className={css.name} title={asset.filename}>
          {asset.filename}
        </span>
        <span className={css.dims}>
          {asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}
          {asset.size ? humanSize(asset.size) : 'external'}
        </span>

        {/* A real `<label>`, where the old card had a `placeholder="Alt text"` and
            nothing else. Alt text is the one field on this card that a
            screen-reader user is most likely to be the person writing. */}
        {image ? (
          <Field label="Alt text">
            {(id) => (
              <Input
                id={id}
                type="text"
                value={asset.alt}
                disabled={!editable}
                onChange={(e) => onChange({ ...asset, alt: e.target.value })}
              />
            )}
          </Field>
        ) : null}

        <div className={css.row}>
          {focal ? (
            <Button
              size="sm"
              variant="subtle"
              disabled={!editable}
              onClick={() => {
                const { focal: _drop, ...rest } = asset
                onChange(rest)
              }}
            >
              Centre focal point
            </Button>
          ) : null}
          {position && onMove ? (
            <>
              <Button
                size="sm"
                variant="subtle"
                disabled={!editable || position.index === 0}
                reason="Already first"
                aria-label={`Move ${asset.filename} up`}
                onClick={() => onMove(position.index - 1)}
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="subtle"
                disabled={!editable || position.index === position.total - 1}
                reason="Already last"
                aria-label={`Move ${asset.filename} down`}
                onClick={() => onMove(position.index + 1)}
              >
                ↓
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="danger"
            disabled={!editable}
            aria-label={`Remove ${asset.filename}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      </div>
    </div>
  )
}
