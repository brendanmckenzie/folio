import type { Json } from '../../../../core/doc'
import type { Field as FieldDef } from '../../../../core/fields'
import {
  type CollectionField as CollectionFieldDef,
  collectionQuery,
  maxPerPageOf,
  queryKey,
} from '../../../../core/query'
import type { Resolution } from '../../../../core/resolve'
import type { DocumentType, SchemaIndex } from '../../../../core/schema'
import { Input, Select, Textarea } from '../../Field'
import { AssetField, MultiAssetField } from './AssetField'
import { CollectionField } from './CollectionField'
import css from './fields.module.css'
import { LinkField } from './LinkField'
import { ReferenceField, ReferencesField } from './ReferenceField'
import { type FieldChrome, RichTextField } from './RichTextField'

/**
 * Everything a control needs that is the same for every field in the panel. The
 * editor-wide half of what `FolioContext` used to carry — but as a prop, because
 * `admin/ui/` screens are handed their world by whatever mounts them
 * (`EditorShell.tsx`'s `EditorSlot`) rather than reaching for a context.
 */
export interface FieldEnv {
  /** `{base}/api` — the admin's internal JSON. */
  apiBase: string
  /** The bare mount, for `/asset/:key`. */
  mount: string
  schema: SchemaIndex
  types: readonly DocumentType[]
  /** What the preview is rendered with. Carries the resolved story rows for every id
   * this document points at, and the answers to its collection queries. */
  resolution: Resolution
}

export interface ControlProps {
  /** The id `Field` generated, so the label points at a real control. */
  id: string
  /** The field's declared name. Never read from the selection — an input can issue
   * its write long after it rendered (an upload finishing is the case). */
  name: string
  field: FieldDef
  value: Json
  onChange: (value: Json) => void
  /** False while a past version is on the stage, or for a shared field in a
   * non-source locale. See `isEditable`. */
  editable: boolean
  env: FieldEnv
  /** What the focus overlay repeats. Richtext only. */
  chrome: FieldChrome
  expanded: boolean
  onExpand: (open: boolean) => void
}

/**
 * The key one collection field's answer travels under, exactly as `render` computes
 * it — so the inspector's count and the preview's list can never be about different
 * queries.
 */
const collectionKey = (field: CollectionFieldDef, value: Json): string =>
  queryKey(collectionQuery(field, value), maxPerPageOf(field))

/**
 * One field's control, by kind.
 *
 * A switch on `field.kind` rather than on `inspector-model.ts`'s `controlFor`, and
 * that is not duplication: only a switch on the discriminant narrows the union, which
 * is what lets the `select` branch reach `field.options` and the `asset` branch reach
 * `field.accept`. `controlFor` answers a different question — what *kind* of control
 * this is, for the row's layout and for the keyboard — and is exhaustive by
 * construction, so a new kind in `core/fields.ts` fails to compile there and falls
 * into `text` here rather than the reverse.
 *
 * `blocks` never arrives: `visibleEntries` drops it before a row is built, because
 * children are tree slots (`BlockRail.tsx`) and not a value.
 */
export function Control(props: ControlProps) {
  const { id, field, value, onChange, editable, env } = props

  switch (field.kind) {
    case 'textarea':
      return (
        <Textarea
          id={id}
          rows={field.rows ?? 4}
          placeholder={field.placeholder}
          value={String(value ?? '')}
          disabled={!editable}
          onChange={(e) => onChange(e.target.value)}
        />
      )

    case 'select':
      return (
        <Select
          id={id}
          value={String(value ?? '')}
          disabled={!editable}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )

    case 'boolean':
      /*
       * The one control the primitives cannot be. `Input` applies
       * `Field.module.css`'s `.control` through a className the caller may not
       * override, and that rule is `width: 100%; height: var(--row-h)` — which for
       * `type="checkbox"` is a full-width 28px box. A twelfth primitive for one
       * element would be the wrong trade (`design-system.md` argues the fixed count),
       * so this is a bare input with one class of its own.
       */
      return (
        <input
          id={id}
          type="checkbox"
          className={css.checkbox}
          checked={Boolean(value)}
          disabled={!editable}
          onChange={(e) => onChange(e.target.checked)}
        />
      )

    case 'number':
      return (
        <Input
          id={id}
          type="number"
          min={field.min}
          max={field.max}
          value={Number(value ?? 0)}
          disabled={!editable}
          onChange={(e) => onChange(e.target.valueAsNumber || 0)}
        />
      )

    case 'multilink':
      return (
        <LinkField
          id={id}
          label={field.label ?? props.name}
          value={value}
          {...(field.allow ? { allow: field.allow } : {})}
          {...(field.types ? { types: field.types } : {})}
          stories={env.resolution.stories}
          apiBase={env.apiBase}
          mount={env.mount}
          editable={editable}
          onChange={onChange}
        />
      )

    case 'reference':
      return (
        <ReferenceField
          id={id}
          label={field.label ?? props.name}
          value={value}
          {...(field.types ? { types: field.types } : {})}
          stories={env.resolution.stories}
          apiBase={env.apiBase}
          editable={editable}
          onChange={onChange}
        />
      )

    case 'references':
      return (
        <ReferencesField
          id={id}
          label={field.label ?? props.name}
          value={value}
          {...(field.types ? { types: field.types } : {})}
          {...(field.max === undefined ? {} : { max: field.max })}
          stories={env.resolution.stories}
          apiBase={env.apiBase}
          editable={editable}
          onChange={onChange}
        />
      )

    case 'collection':
      return (
        <CollectionField
          id={id}
          field={field}
          value={value}
          // The answer the preview is already holding, looked up the way `render`
          // looks it up — so the panel's count and the preview's list are the same
          // query. Undefined while the fetch is in flight, which is the honest state.
          {...(() => {
            const answer = env.resolution.collections?.[collectionKey(field, value)]
            return answer ? { answer } : {}
          })()}
          schema={env.schema}
          types={env.types}
          editable={editable}
          onChange={onChange}
        />
      )

    case 'richtext':
      return (
        <RichTextField
          value={value}
          limits={field}
          editable={editable}
          onChange={onChange}
          chrome={props.chrome}
          stories={env.resolution.stories}
          apiBase={env.apiBase}
          mount={env.mount}
          expanded={props.expanded}
          onExpand={props.onExpand}
        />
      )

    case 'asset':
      return (
        <AssetField
          id={id}
          value={value}
          {...(field.accept ? { accept: field.accept } : {})}
          apiBase={env.apiBase}
          mount={env.mount}
          editable={editable}
          onChange={onChange}
        />
      )

    case 'multiasset':
      return (
        <MultiAssetField
          id={id}
          value={value}
          {...(field.accept ? { accept: field.accept } : {})}
          {...(field.max === undefined ? {} : { max: field.max })}
          apiBase={env.apiBase}
          mount={env.mount}
          editable={editable}
          onChange={onChange}
        />
      )

    default:
      // `text`, and `blocks` — which cannot reach here. Kept as the default rather
      // than as a `case 'text'` plus an exhaustive assertion, so a field kind added
      // to `core/fields.ts` renders a working text box rather than nothing at all
      // while its own control is being written. `controlFor` is where a missing kind
      // is a compile error.
      return (
        <Input
          id={id}
          type="text"
          placeholder={field.kind === 'text' ? field.placeholder : undefined}
          value={String(value ?? '')}
          disabled={!editable}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}
