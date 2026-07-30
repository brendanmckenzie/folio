import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import type { Registry } from '../core/block'
import { childrenOf, type Doc } from '../core/doc'
import type { Field } from '../core/fields'
import { fieldValue } from '../core/locales'
import {
  EMPTY_RESOLUTION,
  resolveReference,
  resolveReferences,
  resolveValue,
  type Resolution,
} from '../core/resolve'
import { asRichtext, sanitiseRichtext } from '../core/richtext'
import { RichText } from './RichText'

interface Props {
  doc: Doc
  registry: Registry
  uid: string
  /** Preview mode: tag every block so the bridge can map DOM back to uid. */
  edit?: boolean
  /**
   * Context a document cannot hold: story ids to current URLs, and so on.
   * Defaulted so a caller with nothing to resolve stays a one-liner.
   */
  resolution?: Resolution
}

export function RenderBlok({
  doc,
  registry,
  uid,
  edit = false,
  resolution = EMPTY_RESOLUTION,
}: Props): ReactNode {
  const blok = doc.bloks[uid]
  if (!blok) return null

  const def = registry[blok.type]
  if (!def) {
    return edit ? <div className="folio-unknown">Unknown block type “{blok.type}”</div> : null
  }

  /**
   * `render` is optional (`../../../docs/specs/content-model/data-documents.md`
   * checkpoint 1). Guarded here, above the props loop, so a block with nothing to
   * render also does no resolution work — and guarded the same way an unknown
   * type is, including not descending into children: a placeholder that then drew
   * its slots would be scaffolding pretending to be a layout.
   */
  if (!def.render) {
    return edit ? (
      <div className="folio-unrendered">
        “{def.label || blok.type}” has no renderer. It is data other pages read.
      </div>
    ) : null
  }

  const props: Record<string, unknown> = { uid }
  // Every field value this renderer reads goes through `fieldValue`
  // (`../../../docs/specs/content-model/localisation.md` architecture decision
  // 3), so "which language" is answered once, from the resolution, rather than
  // per field kind. `resolveValue` stays locale-blind, which is what keeps the
  // change small.
  //
  // Deliberately unconditional on `field.translatable` (decision 4): if a value
  // is in `i18n` it wins, wherever it came from. The editor is what refuses to
  // *write* a locale value to an unmarked field; un-marking one must not silently
  // hide content somebody already translated, and the audit reports that case.
  const locale = resolution.locale
  for (const [name, field] of Object.entries(def.fields as Record<string, Field>)) {
    // Richtext arrives already rendered, like a `blocks` field, so a block author
    // drops `{body}` into their JSX and cannot accidentally skip sanitising or
    // link resolution.
    if (field.kind === 'richtext') {
      props[name] = (
        <RichText
          doc={sanitiseRichtext(asRichtext(fieldValue(blok, name, locale)), field)}
          resolution={resolution}
        />
      )
      continue
    }
    if (field.kind === 'reference') {
      const target = resolveReference(fieldValue(blok, name, locale), resolution, field.types)
      props[name] = target
        ? { ...target, content: referenceContent(target.doc, registry, resolution) }
        : null
      continue
    }
    // The plural, in the editor's chosen order, with unresolvable entries already
    // dropped by `resolveReferences` (`data-documents.md` decision 3).
    if (field.kind === 'references') {
      props[name] = resolveReferences(fieldValue(blok, name, locale), resolution, field.types).map(
        (target) => ({ ...target, content: referenceContent(target.doc, registry, resolution) }),
      )
      continue
    }
    if (field.kind !== 'blocks') {
      props[name] = resolveValue(field, fieldValue(blok, name, locale), resolution)
      continue
    }
    const kids = childrenOf(doc, uid, name)
    if (kids.length === 0) {
      props[name] = edit ? <EmptySlot parent={uid} slot={name} label={field.label ?? name} /> : null
      continue
    }
    props[name] = kids.map((child) => (
      <RenderBlok
        key={child.uid}
        doc={doc}
        registry={registry}
        uid={child.uid}
        edit={edit}
        resolution={resolution}
      />
    ))
  }

  const el = def.render(props as never)
  if (!edit) return el

  // Storyblok makes each block author remember to spread {...storyblokEditable(blok)}.
  // Deriving it here means a block cannot forget to be editable.
  if (isValidElement(el)) {
    return cloneElement(el as ReactElement<Record<string, unknown>>, {
      'data-folio-uid': uid,
      'data-folio-type': blok.type,
    })
  }
  return (
    <div data-folio-uid={uid} data-folio-type={blok.type}>
      {el}
    </div>
  )
}

/**
 * The rendered form of a referenced document — what `reference.content` and each
 * `references[i].content` hold.
 *
 * **Literally `null`** when the target's root block has no renderer
 * (`../../../docs/specs/content-model/data-documents.md` checkpoint 2), rather
 * than an element that happens to render nothing: a record that is pure data
 * gives `content: null`, so `{person.content ?? <MyOwnCard {...person.data} />}`
 * means what it says. An always-truthy element would make that fallback dead code.
 *
 * Rendered without `edit` and without uid markers: this content belongs to
 * another story, so clicking it here must not offer to edit it in the context of
 * this one. `docs` is emptied on the way down, which is what bounds resolution to
 * one level and stops a story that references itself from rendering until the
 * stack gives out.
 */
function referenceContent(doc: Doc, registry: Registry, resolution: Resolution): ReactNode {
  const root = doc.bloks[doc.root]
  if (!root || !registry[root.type]?.render) return null
  return (
    <RenderBlok
      doc={doc}
      registry={registry}
      uid={doc.root}
      resolution={{ ...resolution, docs: {} }}
    />
  )
}

/** Rendered into an empty `blocks` field so the slot is reachable in the preview. */
function EmptySlot({ parent, slot, label }: { parent: string; slot: string; label: string }) {
  return (
    <button
      type="button"
      className="folio-empty-slot"
      data-folio-slot={slot}
      data-folio-parent={parent}
    >
      Add to {label.toLowerCase()}
    </button>
  )
}

/** Renders a whole document. The public entry point for both site and preview. */
export function FolioDoc({ doc, registry, edit, resolution }: Omit<Props, 'uid'>) {
  return (
    <RenderBlok doc={doc} registry={registry} uid={doc.root} edit={edit} resolution={resolution} />
  )
}

/**
 * A global, rendered — the one function behind both `Folio.renderGlobal` (a
 * host's own shell) and Folio's internal preview page, so the wrapper is
 * identical markup wherever it appears (`../../../docs/specs/content-model/
 * globals.md` decision 3): a hydration mismatch between a published page and
 * a preview is a header that flickers for the first person to notice.
 *
 * Null — no wrapper at all — when `resolution.globals` has nothing for `name`:
 * a global nobody has published yet renders nothing, in both modes, with
 * nothing to catch.
 */
export function renderGlobalNode(
  registry: Registry,
  resolution: Resolution,
  name: string,
  opts?: { edit?: boolean },
): ReactNode {
  const doc = resolution.globals?.[name]
  if (!doc) return null
  // Keyed on the global's name, which is unique by construction (`globals` is a
  // list of declared singleton type names). The key is inert for the single-use
  // call a host makes in its own shell — `renderGlobal(resolution, 'header')` —
  // and load-bearing the moment anything maps over several, which both Folio's
  // own preview shell and a host laying out its chrome naturally do. Setting it
  // here rather than at each call site is what makes that free: a caller cannot
  // add a key to a node it did not create.
  return (
    <div key={name} data-folio-global={name}>
      <FolioDoc doc={doc} registry={registry} edit={opts?.edit} resolution={resolution} />
    </div>
  )
}
