import { useState } from 'react'
import type { Blok } from '../../../core/doc'
import type { LocaleConfig } from '../../../core/locales'
import type { Resolution } from '../../../core/resolve'
import type { DocumentType, SchemaIndex } from '../../../core/schema'
import type { StoryMeta } from '../../../core/story'
import type { Blocks } from '../../hooks/useBlocks'
import { type StoryStore, useStoreState } from '../../store'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { FieldRow } from './fields/FieldRow'
import { PageAddress } from './fields/PageAddress'
import css from './Inspector.module.css'
import { canFocus, visibleEntries } from './inspector-model'

/**
 * What the inspector needs, which is a subset of `EditorShell.tsx`'s `EditorSlot` —
 * so wiring it is `inspector={(slot) => <Inspector {...slot} />}` and nothing more.
 * Named as its own interface rather than as `EditorSlot` itself, because a component
 * that declares the twenty-four things it is handed and reads eighteen of them is
 * lying about its dependencies.
 */
export interface InspectorProps {
  /** For presence and for the focused-field record. Never for reads of the document:
   * `blok` is out of `shownDoc`, which is the version being viewed when one is. */
  store: StoryStore
  schema: SchemaIndex
  types: readonly DocumentType[]
  apiBase: string
  /** The bare mount, for `/asset/:key`. */
  mount: string
  locales: LocaleConfig | undefined
  locale: string
  isSourceLocale: boolean
  resolution: Resolution
  /** The blok to draw: out of the version being viewed, when one is on screen. */
  blok: Blok | null
  /** Viewing a past version, or a role that may not edit. */
  readOnly: boolean
  blocks: Blocks
  story: StoryMeta
  /** The document has a URL of its own, so the root block's row also edits its
   * address. False for a record and for a global. */
  routed: boolean
  /** The selection is the document root, and it is editable. */
  isRootBlok: boolean
  /** A block inside a global was clicked while previewing something else. */
  globalHint: { name: string; label: string } | null
  onEditGlobal: (name: string) => void
  onNotice: (message: string) => void
  /**
   * There is no stage: this document is a form, so the inspector *is* the screen. The
   * fields do not change; what changes is that nothing above draws the block's label,
   * so this does.
   */
  form: boolean
  /** The caller's story row is stale after a rename. Optional: without it the slug
   * still changes, and only the URL line beside it goes stale. */
  onStoryChanged?: () => void
  /**
   * Focus mode, when the **shell** owns which field is open — which it must, because
   * `⌘⏎` is one entry in `ui/shortcuts.ts` and not a chord this component binds.
   * `inspector-model.ts`'s `canFocus` is the predicate the shell needs to decide
   * whether the chord means anything for the field the store currently records as
   * focused.
   *
   * Absent means this component owns it, which is what makes the expand control in a
   * richtext toolbar work before the chord is wired.
   */
  focus?: { field: string | null; open: (field: string | null) => void }
}

/**
 * The block's fields — port phase 7b.
 *
 * A port of `admin/Inspector.tsx` onto `admin/ui/`'s tokens and primitives, and
 * `docs/editor-port-plan.md` is explicit about which half moved: **the styling, not
 * the logic.** Validation, the locale columns, the peer rings and the disabled
 * control on a shared field are correct and hard-won; what changed is that they stop
 * reading `admin.css`'s hand-written classes. The pure half of that logic is
 * `inspector-model.ts`, where a Node test can reach it — no admin test mounts a
 * component.
 *
 * Three things are genuinely new, and each is argued where it lives:
 *
 * 1. **Focus mode** (`FocusMode.tsx`), which is `ui-architecture.md` decision 5's
 *    answer to richtext at 340px — a measure rather than more pixels. It is a
 *    container and not a second editor: `useRichtext` owns the one TipTap instance
 *    and `EditorContent` re-parents its view, so a keystroke takes the identical path
 *    in both places.
 * 2. **Searchable document pickers** (`fields/candidates.ts`), because the array they
 *    used to filter no longer exists — pagination phase 3 replaced the editor's
 *    whole-tree fetch with the ids one document points at.
 * 3. **Real accessible names and states throughout.** Biome's a11y rules are on for
 *    `admin/ui/**` and off elsewhere, so the toolbar toggles, the link kind tabs, the
 *    focal-point button and the alt-text box all had to gain what they had been
 *    getting away with not having.
 */
export function Inspector(props: InspectorProps) {
  const { store, schema, blok, readOnly, blocks, locale, isSourceLocale, locales } = props
  const state = useStoreState(store)

  /**
   * Which field focus mode holds. Uncontrolled by default and controlled when the
   * shell passes `focus`, rather than always-internal-plus-an-imperative-handle: the
   * shell has to be able to *open* this from `⌘⏎`, and a ref API for one boolean is
   * more machinery than a prop.
   */
  const own = useState<string | null>(null)
  const expandedField = props.focus ? props.focus.field : own[0]
  const setExpandedField = props.focus ? props.focus.open : own[1]

  const localeLabel = locales?.available.find((l) => l.code === locale)?.label ?? locale
  const sourceLabel =
    locales?.available.find((l) => l.code === locales.default)?.label ??
    locales?.default ??
    'source'

  if (props.globalHint) {
    return (
      <div className={css.empty}>
        <EmptyState
          title={`This block belongs to ${props.globalHint.label}`}
          body="It is edited in that document, not this one — a global appears on every page that includes it."
          action={
            <Button
              size="sm"
              variant="primary"
              onClick={() => props.onEditGlobal(props.globalHint!.name)}
            >
              Edit {props.globalHint.label}
            </Button>
          }
        />
      </div>
    )
  }

  if (!blok) {
    return (
      <div className={css.empty}>
        <EmptyState
          title="Nothing selected"
          body="Pick a block in the preview or in the rail beside it."
        />
      </div>
    )
  }

  const def = schema[blok.type]
  if (!def) {
    // The same posture an unknown collection type gets: say so, do not pretend. A
    // block whose type no schema declares still has data, and hiding it is how content
    // disappears without anybody deleting it.
    return (
      <div className={css.empty}>
        <EmptyState
          title={`Unknown block “${blok.type}”`}
          body="No block by that name is declared. Its content is untouched — a schema migration is what reaches it."
        />
      </div>
    )
  }

  const entries = visibleEntries(def.fields, blok.data)

  return (
    // The gutter and the rhythm are the panel's, and form mode widens both: the same
    // fields on a 34rem card want more air between them than they do in a 340px
    // column, and one class rather than two components is what keeps them the same
    // fields.
    <div className={props.form ? `${css.panel} ${css.panelForm}` : css.panel}>
      {/* In form mode the head is the card's header — a heading, the uid, and a rule
          under it — so it is the one part of the panel that changes shape. */}
      <div className={props.form ? `${css.head} ${css.headForm}` : css.head}>
        {/* Only in form mode. `EditorShell` puts the block's label at the top of the
            340px column already; in form mode there is no column and no heading. */}
        {props.form ? <h2 className={css.title}>{def.label}</h2> : null}
        <code className={css.uid}>{blok.uid}</code>
        {blok.parent && !readOnly ? (
          <div className={css.actions}>
            <Button size="sm" variant="subtle" onClick={() => blocks.duplicate(blok.uid)}>
              Duplicate
            </Button>
            <Button size="sm" variant="danger" onClick={() => blocks.remove(blok.uid)}>
              Delete
            </Button>
          </div>
        ) : null}
      </div>

      {/* Routing lives in D1 rather than in the document, so it is a `PATCH` and not a
          mutation. Only on the root block of a routed page: a nested block has no
          address, and a record has no URL to have one. */}
      {props.routed && props.isRootBlok ? (
        <div className={css.address}>
          <h3 className={css.addressTitle}>Address</h3>
          <PageAddress
            story={props.story}
            apiBase={props.apiBase}
            disabled={readOnly}
            onNotice={props.onNotice}
            onChanged={() => props.onStoryChanged?.()}
          />
          <p className={css.url}>
            <span>URL</span>
            <code>{props.story.url ?? `/${props.story.path ?? ''}`}</code>
          </p>
        </div>
      ) : null}

      {readOnly ? (
        <p className={`${css.note} ${css.noteWarn}`}>
          Read-only. Close the version preview to edit.
        </p>
      ) : null}

      {/* Which language this panel is writing into. Only ever shown for a non-source
          locale: on the source it would be a label on every screen saying "you are
          editing normally". */}
      {isSourceLocale ? null : (
        <p className={css.note}>
          Editing <strong>{localeLabel}</strong>. Untranslated fields fall back to {sourceLabel}.
        </p>
      )}

      <fieldset className={css.fields} disabled={readOnly}>
        <legend className={css.srOnly}>{def.label} fields</legend>
        {entries.map(([name, field]) => (
          <FieldRow
            // `${blok.uid}:${name}`, so a field's identity never moves when a `showIf`
            // sibling appears or disappears — an in-flight upload in one field survives
            // a condition revealing another.
            key={`${blok.uid}:${name}`}
            blok={blok}
            name={name}
            field={field}
            isSourceLocale={isSourceLocale}
            locale={locale}
            sourceLabel={sourceLabel}
            readOnly={readOnly}
            peers={state.peers}
            env={{
              apiBase: props.apiBase,
              mount: props.mount,
              schema,
              types: props.types,
              resolution: props.resolution,
            }}
            expanded={expandedField === name}
            onExpand={(open) => setExpandedField(open ? name : null)}
            onChange={blocks.setField}
            focusedField={state.focus}
            onFocusField={(next) => store.focusField(next)}
          />
        ))}
      </fieldset>
    </div>
  )
}

/**
 * The other half of the `⌘⏎` seam, re-exported beside the component that consumes
 * it: the shell asks `canFocus(schema, blok, state.focus)` and, if it narrows,
 * calls `focus.open(name)`. Both halves imported from one module means the wiring
 * cannot pick up one without the other.
 */
export { canFocus }
