import { useState } from 'react'
import type { Json } from '../core/doc'
import type { StoryNode } from '../core/story'
import { asAsset, asLink, LINK_KINDS, type LinkKind, type LinkValue } from '../core/values'
import { AssetInput } from './AssetInput'
import { useFolio } from './FolioContext'

const LABELS: Record<LinkKind, string> = {
  story: 'Page',
  url: 'URL',
  email: 'Email',
  anchor: 'Anchor',
  asset: 'File',
}

/**
 * The documents a story link may point at: routed only, narrowed by the field's
 * own `types`, sorted by path. Pure and exported so the filter is tested without
 * mounting the input.
 */
export function linkCandidates(
  stories: readonly StoryNode[],
  types?: readonly string[],
): StoryNode[] {
  return stories
    .filter((s) => s.path !== null && (!types || types.includes(s.type)))
    .sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''))
}

interface Props {
  id: string
  value: Json
  allow?: readonly LinkKind[]
  /** `multilink({ types })`: which document types a story link may point at.
   * Absent offers every *routed* type — an unrouted document has no URL, so it
   * is never offered whatever this says (`document-types.md`). */
  types?: readonly string[]
  onChange: (value: Json) => void
}

/**
 * Editor for a `multilink`. Lives in the library because the admin ships
 * prebuilt: a host project contributes field *config* over `/folio/schema`, not
 * field UI.
 *
 * Every change writes the whole link object back as one value, so a link edit is
 * an ordinary `set` mutation and needs nothing special from the sync engine.
 */
export function LinkInput({ id, value, allow, types, onChange }: Props) {
  const { stories } = useFolio()
  const kinds = allow?.length ? LINK_KINDS.filter((k) => allow.includes(k)) : LINK_KINDS
  const link = asLink(value)

  /**
   * Which tab is open, for the gap between choosing a kind and filling it in.
   * A half-finished link is stored as `null` rather than as `{kind:'url',url:''}`
   * so nothing downstream has to know about junk values — which means the
   * document cannot remember the tab, and this has to.
   */
  const [chosen, setChosen] = useState<LinkKind | null>(null)
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

  // The picker never offers what `resolveLink` would refuse to emit an href
  // from: an unrouted document has no URL at all, and a type the field does not
  // allow resolves `broken`. Same constraint, enforced in both places, for the
  // same reason `richtext`'s marks are (`document-types.md` decision 5).
  const sorted = linkCandidates(stories, types)
  const missing = link?.kind === 'story' && link.id && !stories.some((s) => s.id === link.id)

  return (
    <div className="link">
      {kinds.length > 1 ? (
        <div className="link__kinds">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className={k === kind ? 'is-active' : ''}
              onClick={() => switchKind(k)}
            >
              {LABELS[k]}
            </button>
          ))}
        </div>
      ) : null}

      {kind === 'story' ? (
        <>
          <select
            id={id}
            value={link?.kind === 'story' ? link.id : ''}
            onChange={(e) =>
              patch(
                e.target.value
                  ? {
                      kind: 'story',
                      id: e.target.value,
                      ...(link?.kind === 'story' && link.anchor ? { anchor: link.anchor } : {}),
                      ...(link?.kind === 'story' && link.target ? { target: link.target } : {}),
                    }
                  : null,
              )
            }
          >
            <option value="">Choose a page…</option>
            {sorted.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} — /{s.path}
              </option>
            ))}
          </select>
          {missing ? <p className="link__warn">That page has been deleted. Pick another.</p> : null}
          <input
            type="text"
            placeholder="Anchor on that page (optional)"
            value={link?.kind === 'story' ? (link.anchor ?? '') : ''}
            onChange={(e) =>
              link?.kind === 'story'
                ? patch({ ...link, anchor: e.target.value || undefined })
                : undefined
            }
          />
        </>
      ) : kind === 'url' ? (
        <input
          id={id}
          type="url"
          placeholder="https://example.com"
          value={link?.kind === 'url' ? link.url : ''}
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
        <AssetInput
          id={id}
          value={(link?.kind === 'asset' ? link.asset : null) as unknown as Json}
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
          <input
            id={id}
            type="email"
            placeholder="someone@example.com"
            value={link?.kind === 'email' ? link.email : ''}
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
          <input
            type="text"
            placeholder="Subject (optional)"
            value={link?.kind === 'email' ? (link.subject ?? '') : ''}
            onChange={(e) =>
              link?.kind === 'email'
                ? patch({ ...link, subject: e.target.value || undefined })
                : undefined
            }
          />
        </>
      ) : (
        <input
          id={id}
          type="text"
          placeholder="section-id"
          value={link?.kind === 'anchor' ? link.anchor : ''}
          onChange={(e) =>
            patch(e.target.value ? { kind: 'anchor', anchor: e.target.value } : null)
          }
        />
      )}

      <div className="link__foot">
        {kind === 'story' || kind === 'url' || kind === 'asset' ? (
          <label className="link__check">
            <input
              type="checkbox"
              checked={Boolean(link && 'target' in link && link.target === '_blank')}
              onChange={(e) => {
                if (!link || link.kind === 'email' || link.kind === 'anchor') return
                patch({ ...link, target: e.target.checked ? '_blank' : undefined })
              }}
            />
            Open in a new tab
          </label>
        ) : (
          <span />
        )}
        {link ? (
          <button type="button" className="link__clear" onClick={() => patch(null)}>
            Clear
          </button>
        ) : null}
      </div>
    </div>
  )
}
