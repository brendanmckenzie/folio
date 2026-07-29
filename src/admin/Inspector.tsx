import type { ReactNode } from 'react'
import { matches } from '../core/conditions'
import type { Blok, Json } from '../core/doc'
import type { Field } from '../core/fields'
import { isTranslatable } from '../core/locales'
import { asRichtext, richtextToText, sanitiseRichtext } from '../core/richtext'
import type { StoryNode } from '../core/story'
import { asAsset } from '../core/values'
import { RichText } from '../preview/RichText'
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
   *
   * `locale` is supplied by this component from the active locale, not by the
   * caller: every input writes through one door, and which language it writes
   * into is a property of the editor's state rather than of the input
   * (`localisation.md` phase 3).
   */
  onChange: (uid: string, field: string, value: Json, locale?: string) => void
  onRemove: (uid: string) => void
  /** Clones the whole subtree with fresh uids, right after the original in the
   * same slot (duplicate-and-paste.md). A full slot refuses with a toast
   * rather than disabling this button: unlike the tree row, the inspector has
   * no cheap way to know the slot's sibling count. */
  onDuplicate: (uid: string) => void
  /** Rendered above the fields. Used for page routing on the root block. */
  address?: ReactNode
  /** True while a past version is being previewed. */
  readOnly?: boolean
  /**
   * A block belonging to this global was just clicked while previewing
   * something else (`../../../docs/specs/content-model/globals.md` checkpoint
   * 3): offer to switch rather than pretend a selection happened. Takes
   * priority over `blok`, which does not change when this fires.
   */
  globalHint?: { name: string; label: string } | null
  onEditGlobal?: (name: string) => void
}

/**
 * The fields a block's form actually draws: `blocks`-kind fields never reach
 * the inspector (they render as tree slots, see `BlockTree.tsx`'s `slotsOf`),
 * `hidden: true` fields never draw (conditional-fields.md's `showIf: false`
 * shorthand, for a field kept only so a later migration can still read it),
 * and a `showIf` field draws only when its condition matches the *same
 * blok's* own data.
 *
 * Filtering here, once, in the parent, means `FieldInput` keeps its current
 * props and learns nothing about visibility. Declaration order is preserved
 * (`Object.entries` order), so a field's React key
 * (`${blok.uid}:${name}`, set where this is consumed) never moves when a
 * sibling appears or disappears — an in-flight upload in one field survives a
 * condition revealing another.
 */
export function visibleEntries(
  fields: Record<string, Field>,
  data: Record<string, Json>,
): [string, Field][] {
  return Object.entries(fields).filter(
    ([, f]) => f.kind !== 'blocks' && !f.hidden && (!f.showIf || matches(f.showIf, data)),
  )
}

/**
 * The documents a `reference` field offers: narrowed by `field.types`, sorted so
 * routed documents come first by path and unrouted ones by title. Unlike a link,
 * a reference *may* point at a record — pulling a person's details into a card
 * is the whole point — so nothing is excluded for being unrouted.
 *
 * Pure and exported so the filter is tested without mounting the inspector.
 */
export function referenceCandidates(
  stories: readonly StoryNode[],
  types?: readonly string[],
): StoryNode[] {
  return stories
    .filter((s) => !types || types.includes(s.type))
    .sort((a, b) =>
      a.path === null || b.path === null
        ? (a.path === null ? 1 : 0) - (b.path === null ? 1 : 0) || a.title.localeCompare(b.title)
        : a.path.localeCompare(b.path),
    )
}

/**
 * How one field's input behaves in the active locale
 * (`localisation.md` decision 4 and the resolved open question).
 *
 * Three states, and they are exhaustive:
 *
 *   - `'source'` — the source locale is active. Exactly the pre-localisation
 *     editor: one input, bound to `data`, no second column.
 *   - `'translate'` — a non-source locale and the field is `translatable`. The
 *     input is bound to **the locale's own raw value**, never the fallback: an
 *     input pre-filled with the English would copy it into the translation the
 *     moment somebody typed one character, and "untranslated" would become
 *     unreachable. The source appears beside it, read-only.
 *   - `'shared'` — a non-source locale and the field is not translatable. The
 *     input is disabled and says so, bound to the source value so it is legible.
 *     Nothing writes a locale-scoped `set` from here, which is the editor half of
 *     decision 4's asymmetry: the renderer *would* honour one.
 *
 * Pure and exported so the three states are tested without mounting the panel.
 */
export type FieldMode = 'source' | 'translate' | 'shared'

export function fieldMode(field: Field, isSourceLocale: boolean): FieldMode {
  if (isSourceLocale) return 'source'
  return isTranslatable(field) ? 'translate' : 'shared'
}

/**
 * The value an input is bound to, given its mode. Separated from `fieldMode` for
 * the property worth pinning on its own: a `'translate'` input reads the raw
 * locale map, so an untranslated field is *empty*, and never the fallback.
 */
export function boundValue(blok: Blok, name: string, mode: FieldMode, locale: string): Json | null {
  if (mode === 'translate') return blok.i18n?.[locale]?.[name] ?? null
  return blok.data[name] ?? null
}

export function Inspector({
  blok,
  onChange,
  onRemove,
  onDuplicate,
  address,
  readOnly = false,
  globalHint,
  onEditGlobal,
}: Props) {
  const { schema, locale, isSourceLocale, locales } = useFolio()
  const localeLabel = locales?.available.find((l) => l.code === locale)?.label ?? locale
  const sourceLabel =
    locales?.available.find((l) => l.code === locales.default)?.label ?? locales?.default ?? ''

  if (globalHint) {
    return (
      <aside className="inspector">
        <p className="inspector__empty">
          This block belongs to <strong>{globalHint.label}</strong>, not this document.
        </p>
        <button type="button" onClick={() => onEditGlobal?.(globalHint.name)}>
          Edit {globalHint.label} →
        </button>
      </aside>
    )
  }

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

  const entries = visibleEntries(def.fields, blok.data)

  return (
    <aside className="inspector">
      <header className="inspector__head">
        <div>
          <h2>{def.label}</h2>
          <code>{blok.uid}</code>
        </div>
        {blok.parent && !readOnly ? (
          <div className="inspector__head-actions">
            <button type="button" onClick={() => onDuplicate(blok.uid)}>
              Duplicate
            </button>
            <button type="button" className="btn-danger" onClick={() => onRemove(blok.uid)}>
              Delete
            </button>
          </div>
        ) : null}
      </header>

      {address}

      {readOnly ? (
        <p className="inspector__note">Read-only. Close the version preview to edit.</p>
      ) : null}

      {/* Which language this panel is writing into. Only ever shown for a
          non-source locale: on the source it would be a label on every screen
          saying "you are editing normally". */}
      {isSourceLocale ? null : (
        <p className="inspector__note inspector__note--locale">
          Editing <strong>{localeLabel}</strong>. Untranslated fields fall back to{' '}
          {sourceLabel || 'the source language'}.
        </p>
      )}

      <fieldset className="inspector__fields" disabled={readOnly}>
        {entries.map(([name, field]) => {
          const mode = fieldMode(field, isSourceLocale)
          return (
            <FieldInput
              key={`${blok.uid}:${name}`}
              name={name}
              field={field}
              value={boundValue(blok, name, mode, locale)}
              mode={mode}
              source={blok.data[name] ?? null}
              onChange={(v) =>
                onChange(blok.uid, name, v, mode === 'translate' ? locale : undefined)
              }
            />
          )
        })}
      </fieldset>
    </aside>
  )
}

function FieldInput({
  name,
  field,
  value,
  onChange,
  mode = 'source',
  source = null,
}: {
  name: string
  field: Field
  value: Json
  onChange: (v: Json) => void
  /** See `fieldMode`. Defaults to `'source'`, which is the pre-localisation
   * behaviour and what a single-locale site always gets. */
  mode?: FieldMode
  /** The source-locale value, for the read-only column beside a translation. */
  source?: Json
}) {
  const { stories } = useFolio()
  const label = field.label ?? name
  const id = `f-${name}`

  return (
    <div className={`field${mode === 'source' ? '' : ` field--${mode}`}`}>
      <label className="field__label" htmlFor={id}>
        {label}
        {field.required ? <span className="field__req">*</span> : null}
        {/* Says why the input below cannot be typed into, at the input rather
            than in a note somewhere else. */}
        {mode === 'shared' ? (
          <span className="field__shared">shared across all languages</span>
        ) : null}
      </label>

      {/* A nested fieldset is what disables an arbitrary input tree without
          every input learning about locales: `mode === 'shared'` turns the whole
          control off, which is decision 4's editor half — no locale-scoped `set`
          can leave here. */}
      <fieldset className="field__control" disabled={mode === 'shared'}>
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
          <LinkInput
            id={id}
            value={value}
            allow={field.allow}
            types={field.types}
            onChange={onChange}
          />
        ) : field.kind === 'reference' ? (
          <select
            id={id}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">Nothing selected</option>
            {referenceCandidates(stories, field.types).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
                {s.path === null ? '' : ` — /${s.path}`}
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
      </fieldset>

      {/* The source value as a **second read-only column**, not a placeholder
          (the spec's resolved open question): a placeholder cannot show richtext
          formatting, so richtext would have needed the column anyway, and
          consistency then argues for it everywhere. */}
      {mode === 'translate' ? <SourceValue field={field} value={source} /> : null}

      {field.help ? <p className="field__help">{field.help}</p> : null}
    </div>
  )
}

/**
 * The source-locale value beside a translation input: what a translator is
 * translating *from*.
 *
 * Richtext renders formatted, through the same `RichText` component the preview
 * uses and the same sanitiser, with the editor's real resolution — so an internal
 * link in the English prose is a real href here rather than a broken `#`. That
 * fidelity is the whole reason the source is a column and not a placeholder.
 *
 * Every other kind renders as text, because that is all there is to show: an
 * asset is its filename, a link is its target, and a number is a number. Nothing
 * here is interactive, so nothing can be typed into the language you are not
 * editing.
 */
function SourceValue({ field, value }: { field: Field; value: Json }) {
  const { resolution, locales } = useFolio()
  const from = locales?.available.find((l) => l.code === locales.default)?.label ?? 'source'

  const body =
    field.kind === 'richtext' ? (
      <RichText doc={sanitiseRichtext(asRichtext(value), field)} resolution={resolution} />
    ) : (
      sourceText(field, value)
    )

  return (
    <div className="field__source">
      <span className="field__source-label">{from}</span>
      <div className="field__source-body">{body || <em>empty</em>}</div>
    </div>
  )
}

/** One source value as display text. The same unwrapping `summarise` does, for
 * the same reason: an object value would otherwise read "[object Object]". */
function sourceText(field: Field, value: Json): string {
  if (value === null || value === undefined) return ''
  switch (field.kind) {
    case 'richtext':
      return richtextToText(asRichtext(value))
    case 'asset':
      return asAsset(value)?.filename ?? ''
    case 'multiasset':
      return Array.isArray(value) ? `${value.length} file${value.length === 1 ? '' : 's'}` : ''
    case 'boolean':
      return value ? 'yes' : 'no'
    case 'select': {
      const option = field.options.find((o) => o.value === value)
      return option?.label ?? String(value)
    }
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
}
