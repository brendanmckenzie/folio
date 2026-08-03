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

/**
 * How much of the editor's addressing a render carries
 * (`../../../docs/specs/platform/mcp-server.md` decision 5a).
 *
 * - **`off`** — a published page. No attributes, no scaffolding, nothing a
 *   visitor should not see. The default, because a caller that says nothing is
 *   rendering for the public.
 * - **`mark`** — `data-folio-uid` on every block whose `render` returns a *host
 *   element*, and **nothing else**: node-for-node the DOM `off` produces. That is
 *   what makes it photographable — a screenshot of it is a screenshot of the
 *   page — while still letting a caller clip to one block by the selector the
 *   editor's own `markSelected` uses.
 * - **`edit`** — the editor's iframe. `mark` plus the marker wrapper below, the
 *   empty-slot buttons, and the unknown/unrendered placeholders.
 *
 * The three exist because **the uid attribute and the marker `<div>` used to be
 * one flag**, so a page could not be addressable without also carrying an extra
 * grid child. See the wrapper's own comment for which way that trade is now
 * resolved and why.
 */
export type RenderMode = 'off' | 'mark' | 'edit'

interface Props {
  doc: Doc
  registry: Registry
  uid: string
  /**
   * How much addressing to emit. Defaults to `off` — no attributes at all — so a
   * host rendering a published page cannot leak the editor's markers by omission.
   */
  mode?: RenderMode
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
  mode = 'off',
  resolution = EMPTY_RESOLUTION,
}: Props): ReactNode {
  const blok = doc.bloks[uid]
  if (!blok) return null

  /**
   * Every placeholder and affordance below is `edit` only, never `mark`: each one
   * is a node the published page does not have, and `mark`'s whole claim is that
   * it renders the same tree `off` does. An agent looking at a `mark` render of a
   * broken document sees what a visitor would see, which is the honest answer.
   */
  const editing = mode === 'edit'

  const def = registry[blok.type]
  if (!def) {
    return editing ? <div className="folio-unknown">Unknown block type “{blok.type}”</div> : null
  }

  /**
   * `render` is optional (`../../../docs/specs/content-model/data-documents.md`
   * checkpoint 1). Guarded here, above the props loop, so a block with nothing to
   * render also does no resolution work — and guarded the same way an unknown
   * type is, including not descending into children: a placeholder that then drew
   * its slots would be scaffolding pretending to be a layout.
   */
  if (!def.render) {
    return editing ? (
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
      props[name] = editing ? (
        <EmptySlot parent={uid} slot={name} label={field.label ?? name} />
      ) : null
      continue
    }
    props[name] = kids.map((child) => (
      <RenderBlok
        key={child.uid}
        doc={doc}
        registry={registry}
        uid={child.uid}
        mode={mode}
        resolution={resolution}
      />
    ))
  }

  const el = def.render(props as never)
  if (mode === 'off') return el

  // Storyblok makes each block author remember to spread {...storyblokEditable(blok)}.
  // Deriving it here means a block cannot forget to be editable.
  //
  // **`typeof el.type === 'string'` is the load-bearing half of that promise.**
  // `cloneElement` only reaches the DOM for a *host* element: hand these two
  // attributes to a custom component and they arrive as props it is free to
  // ignore — which every ordinary component does — and hand them to a Fragment
  // and React drops them with a warning. Either way no marker is written, and a
  // block with no marker cannot be hovered, selected or clicked in the preview.
  // It is not a degraded state that announces itself; the block simply does
  // nothing, and the click falls through to whichever ancestor *is* marked.
  //
  // The condition was `isValidElement(el)` alone, which is true of both cases,
  // so the wrapper below only ever caught a string or an array. Found the first
  // time a host wrapped its existing components — `render: (p) => <SectionHead
  // {...p} />` is the most natural thing to write when adopting Folio into a
  // site that already has a design system, and it was exactly the shape that
  // silently opted out of editing.
  if (isValidElement(el) && typeof el.type === 'string') {
    return cloneElement(el as ReactElement<Record<string, unknown>>, {
      'data-folio-uid': uid,
      'data-folio-type': blok.type,
    })
  }
  /**
   * **`mark` stops here, with no marker and therefore no uid for this block.**
   * That is the deliberate half of the split (`../../../docs/specs/platform/
   * mcp-server.md` decision 5a), and it is a trade rather than an omission: on a
   * real host it costs addressing for 2 blocks in 82 and buys production
   * geometry for those same 2, because the wrapper below is an extra grid or flex
   * child. A screenshot taken to answer "does this look right" must not be the
   * thing that makes it look wrong.
   *
   * Rejected: keep the wrapper in `mark` so every block is clippable — it
   * reintroduces the single most likely visual defect into exactly the blocks a
   * caller was asking about. Rejected: `display: contents` on the wrapper — no
   * box, so no bounding rect, so nothing to clip to, which is the same reason the
   * comment below gives for not using it for the outline.
   */
  if (mode === 'mark') return el
  /**
   * Everything else gets a wrapper, because the selection outline is drawn with
   * `position: relative` and an `::after` inset on the marked element, so the
   * marker has to be something that generates a box. `display: contents` would
   * leave the layout untouched and take the outline with it.
   *
   * The cost is honest and worth stating: in **edit mode only**, a block that
   * returns a component renders one extra `<div>` that the published page does
   * not have. In normal flow that is invisible; as a direct child of a grid or
   * flex container it can shift. `folio-marker` is on it so a host that hits
   * that can say `.folio-marker { display: contents }` and trade the outline
   * back for the layout.
   */
  return (
    <div className="folio-marker" data-folio-uid={uid} data-folio-type={blok.type}>
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
 * Rendered in `off` mode whatever the caller's own mode is, so without uid
 * markers: this content belongs to another story, so clicking it here must not
 * offer to edit it in the context of this one — and a uid on it would address a
 * block of a document the caller is not looking at. `docs` is emptied on the way
 * down, which is what bounds resolution to one level and stops a story that
 * references itself from rendering until the stack gives out.
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
export function FolioDoc({ doc, registry, mode, resolution }: Omit<Props, 'uid'>) {
  return (
    <RenderBlok doc={doc} registry={registry} uid={doc.root} mode={mode} resolution={resolution} />
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
  opts?: { mode?: RenderMode },
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
      <FolioDoc doc={doc} registry={registry} mode={opts?.mode} resolution={resolution} />
    </div>
  )
}
