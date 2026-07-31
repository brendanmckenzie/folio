import type { CSSProperties } from 'react'
import type { Blok, Json } from '../../../../core/doc'
import type { Field as FieldDef } from '../../../../core/fields'
import type { Presence } from '../../../../core/protocol'
import { asRichtext, sanitiseRichtext } from '../../../../core/richtext'
import { RichText } from '../../../../preview/RichText'
import { Field } from '../../Field'
import {
  boundValue,
  type FieldMode,
  fieldMode,
  fieldWarning,
  fieldWatchers,
  isEditable,
  isInlineControl,
  sourceText,
  watcherLabel,
  writeLocale,
} from '../inspector-model'
import { Control, type FieldEnv } from './Control'
import css from './fields.module.css'

interface Props {
  blok: Blok
  name: string
  field: FieldDef
  /** The source locale is active. Decides `fieldMode` and nothing else. */
  isSourceLocale: boolean
  /** Which locale this panel writes into. Ignored on the source. */
  locale: string
  /** The label of the source locale, for the read-only column's own heading. */
  sourceLabel: string
  /** True while a past version is on the stage, or the role may not edit. */
  readOnly: boolean
  peers: readonly Presence[]
  env: FieldEnv
  /** Focus mode is open for this field. */
  expanded: boolean
  onExpand: (open: boolean) => void
  /**
   * Names the block as well as the field. An input can issue its write long after it
   * rendered — an upload finishing is the case — so the target cannot be the
   * selection at that moment. `locale` is supplied here, not by the control: every
   * input writes through one door, and which language it writes into is a property of
   * the editor's state rather than of the input (`localisation.md` phase 3).
   */
  onChange: (uid: string, field: string, value: Json, locale?: string) => void
  /** Focus is presence, not selection. See the handlers below. */
  onFocusField: (field: string | null) => void
  /** What the store currently records as focused, so blur does not race itself. */
  focusedField: string | null
}

/**
 * One field: its label, its control, its peer ring, its warning, and — in a
 * non-source locale — the read-only source column beside it.
 *
 * The `Field` primitive rather than a hand-rolled label/control/help stack, which is
 * the whole point of the phase: `admin.css`'s `.field` namespace declared its own
 * input rules and every panel then re-declared them underneath, which is how the
 * data table's search box ended up as a bare browser default.
 */
export function FieldRow(props: Props) {
  const { blok, name, field, isSourceLocale, locale, readOnly, peers, env } = props

  const mode = fieldMode(field, isSourceLocale)
  const value = boundValue(blok, name, mode, locale)
  const editable = isEditable(mode, readOnly)
  const watchers = fieldWatchers(peers, blok.uid, name)
  const warning = fieldWarning(field, value)
  const label = field.label ?? name

  const source = mode === 'translate' ? (blok.data[name] ?? null) : null
  const sourceColumn =
    mode === 'translate' ? (
      <SourceValue field={field} value={source} from={props.sourceLabel} env={env} />
    ) : null

  const note = (
    <>
      {/* Says why the input below cannot be typed into, at the input rather than in a
          note somewhere else. */}
      {mode === 'shared' ? <span>shared across all languages</span> : null}
      {/* Advisory, never a lock (`live-collaboration.md` checkpoint 2): both may type,
          and this says somebody else is here so the last-write-wins model is visible. */}
      {watchers.map((p) => (
        <span
          key={p.actor}
          className={css.peer}
          style={{ background: p.colour }}
          title={watcherLabel(p, isSourceLocale ? null : locale)}
        >
          {p.name}
        </span>
      ))}
    </>
  )

  return (
    /*
     * The focus handlers are **delegated** rather than wired into each of the twelve
     * control kinds: focus bubbles in React, so a control this component does not know
     * about — a TipTap surface, an upload picker, a dialog's search box — reports
     * itself for free. Blur clears the record rather than leaving a stale ring on a
     * field nobody is in, but only if this field is still the one recorded, so tabbing
     * between two fields does not race its own focus.
     *
     * Both suppressions are about the same thing and neither is a shortcut: those two
     * rules exist to catch a `<div onClick>` that should have been a button, and this
     * element takes no click, no key and no pointer — it is a listener for descendant
     * focus, which is not an interaction anybody performs on it. Making it interactive
     * to satisfy the rule would put a focusable wrapper around every field in the
     * panel and add a Tab stop per field that does nothing.
     *
     * The suppressions sit here, before the element, rather than beside the handlers:
     * a `//` comment inside a JSX attribute list does not attach to the element's own
     * diagnostic — `EditorShell.tsx`'s grip says the same thing.
     *
     * biome-ignore lint/a11y/noStaticElementInteractions: a focus/blur listener for descendants is not an interaction on this element
     * biome-ignore lint/a11y/noNoninteractiveElementInteractions: as above — there is no click, key or pointer handler here
     */
    <div
      // The ring's colour is the first watcher's, so two people in one field read as
      // one ring plus two names rather than as a stripe.
      className={watchers.length ? css.watched : undefined}
      style={watchers[0] ? ({ '--peer': watchers[0].colour } as CSSProperties) : undefined}
      onFocus={() => props.onFocusField(name)}
      onBlur={() => {
        if (props.focusedField === name) props.onFocusField(null)
      }}
    >
      <Field
        label={label}
        {...(field.required ? { required: true } : {})}
        {...(field.help ? { help: field.help } : {})}
        {...(mode === 'shared' || watchers.length ? { note } : {})}
      >
        {(id) => (
          // Down the row for every kind but one. See `isInlineControl`: a 16px
          // checkbox leaves the rest of its row empty, so its warning goes beside it.
          <div className={isInlineControl(field.kind) ? css.row : css.stack}>
            {/*
              A nested fieldset is what disables an arbitrary input tree without every
              control learning about locales: `mode === 'shared'` turns the whole thing
              off, which is `localisation.md` decision 4's editor half — no
              locale-scoped `set` can leave here. `display: contents` keeps it out of
              the layout.
            */}
            <fieldset className={css.control} disabled={!editable}>
              <Control
                id={id}
                name={name}
                field={field}
                value={value}
                editable={editable}
                env={env}
                chrome={{
                  label,
                  ...(mode === 'source' ? {} : { note: shortNote(mode, props.sourceLabel) }),
                  ...(sourceColumn ? { source: sourceColumn } : {}),
                }}
                expanded={props.expanded}
                onExpand={props.onExpand}
                onChange={(next) => props.onChange(blok.uid, name, next, writeLocale(mode, locale))}
              />
            </fieldset>

            {/*
              The warning, here rather than through `Field`'s own `error` slot. `error`
              *replaces* `help`, and a field's help text is usually the thing that says
              how to satisfy the warning — so the two have to be able to coexist.
            */}
            {warning ? <p className={css.warn}>{warning}</p> : null}

            {/*
              The source value as a **second read-only column**, not a placeholder
              (`localisation.md`'s resolved open question): a placeholder cannot show
              richtext formatting, so richtext would have needed the column anyway, and
              consistency then argues for it everywhere.

              Suppressed while focus mode holds the field, because the overlay draws its
              own copy at the same measure — two of them, one behind a scrim, would be
              the same sentence twice.
            */}
            {props.expanded ? null : sourceColumn}
          </div>
        )}
      </Field>
    </div>
  )
}

/** The locale note focus mode repeats, in as few words as an overlay heading can
 * carry: which language this field is writing, or that it writes all of them. */
function shortNote(mode: FieldMode, sourceLabel: string): string {
  return mode === 'shared' ? 'shared across all languages' : `translating from ${sourceLabel}`
}

/**
 * The source-locale value beside a translation input: what a translator is
 * translating *from*.
 *
 * Richtext renders formatted, through the same `RichText` component the preview uses
 * and the same sanitiser, with the editor's real resolution — so an internal link in
 * the English prose is a real href here rather than a broken `#`. That fidelity is
 * the whole reason the source is a column and not a placeholder.
 *
 * Every other kind renders as text, because that is all there is to show: an asset is
 * its filename, a link is its target, and a number is a number. Nothing here is
 * interactive, so nothing can be typed into the language you are not editing.
 */
function SourceValue({
  field,
  value,
  from,
  env,
}: {
  field: FieldDef
  value: Json
  from: string
  env: FieldEnv
}) {
  const body =
    field.kind === 'richtext' ? (
      <RichText doc={sanitiseRichtext(asRichtext(value), field)} resolution={env.resolution} />
    ) : (
      sourceText(field, value)
    )

  return (
    <div className={css.source}>
      <span className={css.sourceLabel}>{from}</span>
      <div className={css.sourceBody}>{body || <em>empty</em>}</div>
    </div>
  )
}
