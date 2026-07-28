import type { ReactNode } from 'react'
import type { Blok, Json } from '../core/doc'
import type { Field } from '../core/fields'
import { AssetInput, MultiAssetInput } from './AssetInput'
import { useFolio } from './FolioContext'
import { LinkInput } from './LinkInput'
import { RichTextInput } from './RichTextInput'

interface Props {
  blok: Blok | null
  /**
   * Names the block as well as the field. An input can issue its write long
   * after it rendered — an upload finishing is the case — so the target cannot
   * be the selection at that moment.
   */
  onChange: (uid: string, field: string, value: Json) => void
  onRemove: (uid: string) => void
  /** Rendered above the fields. Used for page routing on the root block. */
  address?: ReactNode
  /** True while a past version is being previewed. */
  readOnly?: boolean
}

export function Inspector({ blok, onChange, onRemove, address, readOnly = false }: Props) {
  const { schema } = useFolio()

  if (!blok) {
    return (
      <aside className="inspector">
        <p className="inspector__empty">Select a block in the preview or the tree.</p>
      </aside>
    )
  }

  const def = schema[blok.type]
  if (!def) {
    return (
      <aside className="inspector">
        <p className="inspector__empty">Unknown block type “{blok.type}”.</p>
      </aside>
    )
  }

  const entries = Object.entries(def.fields).filter(([, f]) => f.kind !== 'blocks')

  return (
    <aside className="inspector">
      <header className="inspector__head">
        <div>
          <h2>{def.label}</h2>
          <code>{blok.uid}</code>
        </div>
        {blok.parent && !readOnly ? (
          <button type="button" className="btn-danger" onClick={() => onRemove(blok.uid)}>
            Delete
          </button>
        ) : null}
      </header>

      {address}

      {readOnly ? (
        <p className="inspector__note">Read-only. Close the version preview to edit.</p>
      ) : null}

      <fieldset className="inspector__fields" disabled={readOnly}>
        {entries.map(([name, field]) => (
          <FieldInput
            key={`${blok.uid}:${name}`}
            name={name}
            field={field}
            value={blok.data[name] ?? null}
            onChange={(v) => onChange(blok.uid, name, v)}
          />
        ))}
      </fieldset>
    </aside>
  )
}

function FieldInput({
  name,
  field,
  value,
  onChange,
}: {
  name: string
  field: Field
  value: Json
  onChange: (v: Json) => void
}) {
  const { stories } = useFolio()
  const label = field.label ?? name
  const id = `f-${name}`

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {field.required ? <span className="field__req">*</span> : null}
      </label>

      {field.kind === 'textarea' ? (
        <textarea
          id={id}
          rows={field.rows ?? 4}
          placeholder={field.placeholder}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.kind === 'select' ? (
        <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.kind === 'boolean' ? (
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : field.kind === 'number' ? (
        <input
          id={id}
          type="number"
          min={field.min}
          max={field.max}
          value={Number(value ?? 0)}
          onChange={(e) => onChange(e.target.valueAsNumber || 0)}
        />
      ) : field.kind === 'multilink' ? (
        <LinkInput id={id} value={value} allow={field.allow} onChange={onChange} />
      ) : field.kind === 'reference' ? (
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">Nothing selected</option>
          {[...stories]
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} — /{s.path}
              </option>
            ))}
        </select>
      ) : field.kind === 'richtext' ? (
        <RichTextInput value={value} limits={field} onChange={onChange} />
      ) : field.kind === 'asset' ? (
        <AssetInput id={id} value={value} accept={field.accept} onChange={onChange} />
      ) : field.kind === 'multiasset' ? (
        <MultiAssetInput
          id={id}
          value={value}
          accept={field.accept}
          max={field.max}
          onChange={onChange}
        />
      ) : (
        <input
          id={id}
          type="text"
          placeholder={field.kind === 'text' ? field.placeholder : undefined}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {field.help ? <p className="field__help">{field.help}</p> : null}
    </div>
  )
}
