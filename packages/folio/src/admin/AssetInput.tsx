import { useCallback, useEffect, useRef, useState } from 'react'
import type { Json } from '../core/doc'
import { asAsset, asAssets, isImageAsset, type AssetValue } from '../core/values'

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

const thumb = (apiBase: string, asset: AssetValue, width = 320) => {
  if (!asset.key) return asset.url!
  return `${apiBase}/asset/${asset.key}?w=${width}&f=webp`
}

const humanSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} kB`

/** Shared upload, so the library and the "upload straight into this field" path agree. */
async function upload(
  apiBase: string,
  file: File,
): Promise<{ asset: AssetRow; value: AssetValue }> {
  const res = await fetch(`${apiBase}/assets?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) {
    throw new Error(
      ((await res.json().catch(() => ({}))) as { error?: string }).error ??
        `Upload failed (${res.status})`,
    )
  }
  return (await res.json()) as { asset: AssetRow; value: AssetValue }
}

/* ------------------------------------------------------------- single ---- */

interface Props {
  id: string
  value: Json
  apiBase: string
  accept?: string
  onChange: (value: Json) => void
}

export function AssetInput({ id, value, apiBase, accept, onChange }: Props) {
  const asset = asAsset(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const take = async (chosen: File | undefined) => {
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      onChange((await upload(apiBase, chosen)).value as unknown as Json)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
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
          apiBase={apiBase}
          onChange={(next) => onChange(next as unknown as Json)}
          onRemove={() => onChange(null)}
        />
      ) : null}

      <div className="asset__actions">
        <button type="button" disabled={busy} onClick={() => file.current?.click()}>
          {busy ? 'Uploading…' : asset ? 'Replace' : 'Upload'}
        </button>
        <button type="button" onClick={() => setPicking(true)}>
          Library
        </button>
      </div>

      {error ? <p className="asset__error">{error}</p> : null}

      {picking ? (
        <MediaLibrary
          apiBase={apiBase}
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

export function MultiAssetInput({
  id,
  value,
  apiBase,
  accept,
  max,
  onChange,
}: Props & { max?: number }) {
  const assets = asAssets(value)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const full = max !== undefined && assets.length >= max

  const write = (next: AssetValue[]) => onChange(next as unknown as Json)

  const add = async (chosen: FileList | null) => {
    if (!chosen?.length) return
    setBusy(true)
    setError(null)
    try {
      const room = max === undefined ? chosen.length : Math.max(0, max - assets.length)
      const uploaded = await Promise.all(
        [...chosen].slice(0, room).map((f) => upload(apiBase, f).then((r) => r.value)),
      )
      write([...assets, ...uploaded])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
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

      {assets.map((asset, i) => (
        <AssetCard
          // biome-ignore lint/suspicious/noArrayIndexKey: the same asset can appear twice so the index disambiguates; stable local ids are tracked follow-up work
          key={`${asset.key ?? asset.url}:${i}`}
          asset={asset}
          apiBase={apiBase}
          position={{ index: i, total: assets.length }}
          onMove={(to) => swap(i, to)}
          onChange={(next) => write(assets.map((a, j) => (i === j ? next : a)))}
          onRemove={() => write(assets.filter((_, j) => j !== i))}
        />
      ))}

      <div className="asset__actions">
        <button type="button" disabled={busy || full} onClick={() => file.current?.click()}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
        <button type="button" disabled={full} onClick={() => setPicking(true)}>
          Library
        </button>
        {full ? <span className="asset__note">Limit of {max} reached</span> : null}
      </div>

      {error ? <p className="asset__error">{error}</p> : null}

      {picking ? (
        <MediaLibrary
          apiBase={apiBase}
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
  apiBase,
  position,
  onChange,
  onRemove,
  onMove,
}: {
  asset: AssetValue
  apiBase: string
  position?: { index: number; total: number }
  onChange: (next: AssetValue) => void
  onRemove: () => void
  onMove?: (to: number) => void
}) {
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
  apiBase,
  accept,
  onPick,
  onClose,
}: {
  apiBase: string
  accept?: string
  onPick: (asset: AssetValue) => void
  onClose: () => void
}) {
  const [rows, setRows] = useState<AssetRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const res = await fetch(`${apiBase}/assets`)
    setRows(res.ok ? ((await res.json()) as AssetRow[]) : [])
  }, [apiBase])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const add = async (chosen: File | undefined) => {
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      onPick((await upload(apiBase, chosen)).value)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    await fetch(`${apiBase}/assets/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div className="library" role="dialog" aria-label="Media library">
      {/* Clicking the backdrop closes, so the modal never traps anyone. */}
      <button type="button" className="library__scrim" aria-label="Close" onClick={onClose} />
      <div className="library__panel">
        <header className="library__head">
          <strong>Media library</strong>
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
            <button type="button" disabled={busy} onClick={() => file.current?.click()}>
              {busy ? 'Uploading…' : 'Upload'}
            </button>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {error ? <p className="asset__error">{error}</p> : null}

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
