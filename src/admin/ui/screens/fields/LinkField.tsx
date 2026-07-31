import { useState } from 'react'
import type { Json } from '../../../../core/doc'
import type { StoryRef } from '../../../../core/resolve'
import { asAsset, asLink, LINK_KINDS, type LinkKind, type LinkValue } from '../../../../core/values'
import { Button } from '../../Button'
import { Field, Input } from '../../Field'
import { AssetField } from './AssetField'
import { candidateHint } from './candidates'
import { candidateOf, DocumentPicker } from './DocumentPicker'
import css from './fields.module.css'

const LABELS: Record<LinkKind, string> = {
  story: 'Page',
  url: 'URL',
  email: 'Email',
  anchor: 'Anchor',
  asset: 'File',
}

interface Props {
  id: string
  /** The field's label, for the document picker's own title. */
  label: string
  value: Json
  allow?: readonly LinkKind[]
  /** `multilink({ types })`: which document types a story link may point at.
   * Absent offers every *routed* type — an unrouted document has no URL, so it is
   * never offered whatever this says (`document-types.md`). */
  types?: readonly string[]
  stories: Readonly<Record<string, StoryRef>>
  apiBase: string
  mount: string
  editable: boolean
  onChange: (value: Json) => void
}

/**
 * A `multilink`.
 *
 * Every change writes the whole link object back as one value, so a link edit is an
 * ordinary `set` mutation and needs nothing special from the sync engine. Unchanged
 * from `admin/LinkInput.tsx`, along with the half-finished-link rule that makes
 * `chosen` necessary: a partly filled link is stored as `null` rather than as
 * `{kind:'url',url:''}`, so nothing downstream has to know about junk values — which
 * means the document cannot remember which tab is open and this has to.
 *
 * Two things did change, and both are `admin/ui/**`'s a11y rules being stricter than
 * the old admin's (they were off outside `admin/ui/`):
 *
 *  - **The kind tabs are a `<fieldset>` with a visually hidden `<legend>`**, and each
 *    carries `aria-pressed`. They were bare `<button className="is-active">`, which
 *    is a group of related controls with no group and a selected state no assistive
 *    technology could read. `Documents.module.css` carries the fieldset reset and
 *    says why it is not optional.
 *  - **Every input has a real label.** `placeholder="Anchor on that page (optional)"`
 *    was the only name four of these controls had.
 */
export function LinkField({
  id,
  label,
  value,
  allow,
  types,
  stories,
  apiBase,
  mount,
  editable,
  onChange,
}: Props) {
  const [chosen, setChosen] = useState<LinkKind | null>(null)
  const [picking, setPicking] = useState(false)

  const kinds = allow?.length ? LINK_KINDS.filter((k) => allow.includes(k)) : LINK_KINDS
  const link = asLink(value)
  const kind: LinkKind =
    link && kinds.includes(link.kind)
      ? link.kind
      : chosen && kinds.includes(chosen)
        ? chosen
        : kinds[0]!

  const patch = (next: LinkValue | null) => onChange(next as unknown as Json)

  const switchKind = (to: LinkKind) => {
    setChosen(to)
    patch(null)
  }

  const target = link && 'target' in link ? link.target : undefined
  const targetable = kind === 'story' || kind === 'url' || kind === 'asset'

  return (
    <div className={css.stack}>
      {kinds.length > 1 ? (
        <fieldset className={`${css.group} ${css.segments}`} disabled={!editable}>
          <legend className={css.srOnly}>What this links to</legend>
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className={`${css.segment} ${css.segmentWide} ${k === kind ? css.segmentOn : ''}`}
              aria-pressed={k === kind}
              onClick={() => switchKind(k)}
            >
              {LABELS[k]}
            </button>
          ))}
        </fieldset>
      ) : null}

      {kind === 'story' ? (
        <StoryTarget
          id={id}
          label={label}
          link={link}
          types={types}
          stories={stories}
          apiBase={apiBase}
          editable={editable}
          picking={picking}
          onPicking={setPicking}
          onPatch={patch}
        />
      ) : kind === 'url' ? (
        /*
         * The row's own `id`, bound straight to the input, and no nested `Field`.
         * The row's label already names this control — a `multilink` called "Read
         * more" with the URL tab open *is* a URL box called "Read more" — so a second
         * label reading "Address" would be noise, and, more to the point, leaving the
         * row's `htmlFor` pointing at an id nothing carries is a label associated
         * with nothing. The secondary inputs below (an anchor, a subject) do get
         * their own `Field`, because they need a name of their own.
         */
        <Input
          id={id}
          type="url"
          value={link?.kind === 'url' ? link.url : ''}
          placeholder="https://example.com"
          disabled={!editable}
          onChange={(e) =>
            patch(
              e.target.value
                ? {
                    kind: 'url',
                    url: e.target.value,
                    ...(link?.kind === 'url' && link.target ? { target: link.target } : {}),
                  }
                : null,
            )
          }
        />
      ) : kind === 'asset' ? (
        <AssetField
          id={id}
          value={(link?.kind === 'asset' ? link.asset : null) as unknown as Json}
          apiBase={apiBase}
          mount={mount}
          editable={editable}
          onChange={(next) => {
            const asset = asAsset(next)
            patch(
              asset
                ? {
                    kind: 'asset',
                    asset,
                    ...(link?.kind === 'asset' && link.target ? { target: link.target } : {}),
                  }
                : null,
            )
          }}
        />
      ) : kind === 'email' ? (
        <>
          <Input
            id={id}
            type="email"
            value={link?.kind === 'email' ? link.email : ''}
            placeholder="someone@example.com"
            disabled={!editable}
            onChange={(e) =>
              patch(
                e.target.value
                  ? {
                      kind: 'email',
                      email: e.target.value,
                      ...(link?.kind === 'email' && link.subject ? { subject: link.subject } : {}),
                    }
                  : null,
              )
            }
          />
          <Field label="Subject" help="Optional.">
            {(inner) => (
              <Input
                id={inner}
                type="text"
                value={link?.kind === 'email' ? (link.subject ?? '') : ''}
                // There is nothing to put a subject on until there is an address, and
                // a control that would silently discard what you typed is worse than
                // one that says it is not ready.
                disabled={!editable || link?.kind !== 'email'}
                onChange={(e) =>
                  link?.kind === 'email'
                    ? patch({ ...link, subject: e.target.value || undefined })
                    : undefined
                }
              />
            )}
          </Field>
        </>
      ) : (
        <Input
          id={id}
          type="text"
          value={link?.kind === 'anchor' ? link.anchor : ''}
          placeholder="section-id"
          disabled={!editable}
          onChange={(e) =>
            patch(e.target.value ? { kind: 'anchor', anchor: e.target.value } : null)
          }
        />
      )}

      <div className={css.row}>
        {targetable ? (
          <label className={css.checkLabel}>
            <input
              type="checkbox"
              className={css.checkbox}
              checked={target === '_blank'}
              disabled={!editable || !link}
              onChange={(e) => {
                if (!link || link.kind === 'email' || link.kind === 'anchor') return
                patch({ ...link, target: e.target.checked ? '_blank' : undefined })
              }}
            />
            Open in a new tab
          </label>
        ) : null}
        {link ? (
          <Button size="sm" variant="subtle" disabled={!editable} onClick={() => patch(null)}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The `story` tab: a picked page plus its optional anchor.
 *
 * The picker never offers what `resolveLink` would refuse to emit an href from — an
 * unrouted document has no URL at all, and a type the field does not allow resolves
 * `broken`. Same constraint, enforced in both places, for the same reason
 * `richtext`'s marks are (`document-types.md` decision 5).
 */
function StoryTarget({
  id,
  label,
  link,
  types,
  stories,
  apiBase,
  editable,
  picking,
  onPicking,
  onPatch,
}: {
  id: string
  label: string
  link: LinkValue | null
  types?: readonly string[]
  stories: Readonly<Record<string, StoryRef>>
  apiBase: string
  editable: boolean
  picking: boolean
  onPicking: (open: boolean) => void
  onPatch: (next: LinkValue | null) => void
}) {
  const target = link?.kind === 'story' ? link : null
  const resolved = target ? candidateOf(stories, target.id) : undefined

  return (
    <div className={css.stack}>
      {target ? (
        <div className={`${css.picked} ${resolved ? '' : css.missing}`}>
          <span className={css.pickedTitle}>
            {resolved ? resolved.title || 'Untitled' : 'not found'}
          </span>
          <span className={css.pickedWhere}>{resolved ? candidateHint(resolved) : target.id}</span>
        </div>
      ) : null}

      <div className={css.row}>
        <Button id={id} size="sm" disabled={!editable} onClick={() => onPicking(true)}>
          {target ? 'Change page…' : 'Choose a page…'}
        </Button>
      </div>

      {/* Said plainly rather than left as a dead link: the old input printed the same
          sentence, and it is still the only thing an editor can act on. */}
      {target && !resolved ? (
        <p className={`${css.note} ${css.danger}`}>That page has been deleted. Pick another.</p>
      ) : null}

      <Field label="Anchor on that page" help="Optional.">
        {(inner) => (
          <Input
            id={inner}
            type="text"
            value={target?.anchor ?? ''}
            placeholder="section-id"
            disabled={!editable || !target}
            onChange={(e) =>
              target ? onPatch({ ...target, anchor: e.target.value || undefined }) : undefined
            }
          />
        )}
      </Field>

      {picking ? (
        <DocumentPicker
          apiBase={apiBase}
          label={label}
          routed
          {...(types ? { types } : {})}
          onPick={(picked) => {
            onPatch({
              kind: 'story',
              id: picked,
              ...(target?.anchor ? { anchor: target.anchor } : {}),
              ...(target?.target ? { target: target.target } : {}),
            })
            onPicking(false)
          }}
          onClose={() => onPicking(false)}
        />
      ) : null}
    </div>
  )
}
