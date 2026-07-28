import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import type { Registry } from '../core/block'
import { childrenOf, type Doc } from '../core/doc'
import type { Field } from '../core/fields'
import { EMPTY_RESOLUTION, resolveReference, resolveValue, type Resolution } from '../core/resolve'
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

  const props: Record<string, unknown> = { uid }
  for (const [name, field] of Object.entries(def.fields as Record<string, Field>)) {
    // Richtext arrives already rendered, like a `blocks` field, so a block author
    // drops `{body}` into their JSX and cannot accidentally skip sanitising or
    // link resolution.
    if (field.kind === 'richtext') {
      props[name] = (
        <RichText doc={sanitiseRichtext(asRichtext(blok.data[name]), field)} resolution={resolution} />
      )
      continue
    }
    if (field.kind === 'reference') {
      const target = resolveReference(blok.data[name], resolution)
      props[name] = target
        ? {
            ...target,
            // Rendered without `edit` and without uid markers: this content
            // belongs to another story, so clicking it here must not offer to
            // edit it in the context of this one.
            //
            // `docs` is emptied on the way down, which is what bounds resolution
            // to one level and stops a story that references itself from
            // rendering until the stack gives out.
            content: (
              <RenderBlok
                doc={target.doc}
                registry={registry}
                uid={target.doc.root}
                resolution={{ ...resolution, docs: {} }}
              />
            ),
          }
        : null
      continue
    }
    if (field.kind !== 'blocks') {
      props[name] = resolveValue(field, blok.data[name], resolution)
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

/** Rendered into an empty `blocks` field so the slot is reachable in the preview. */
function EmptySlot({ parent, slot, label }: { parent: string; slot: string; label: string }) {
  return (
    <button type="button" className="folio-empty-slot" data-folio-slot={slot} data-folio-parent={parent}>
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
