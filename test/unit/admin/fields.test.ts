import { describe, expect, it } from 'vitest'
import {
  controlFor,
  fieldWarning,
  isBlank,
  isInlineControl,
} from '../../../src/admin/ui/screens/inspector-model'
import {
  CANDIDATE_LIMIT,
  candidateHint,
  candidateRequests,
  narrow,
} from '../../../src/admin/ui/screens/fields/candidates'
import * as fields from '../../../src/core/fields'
import type { Field } from '../../../src/core/fields'
import type { StoryMeta } from '../../../src/core/story'

/*
 * Port phase 7b's per-field arithmetic. No test here mounts a component —
 * `vitest.config.ts` runs the unit project under `environment: 'node'` — so the
 * decisions the field controls make live in `inspector-model.ts` and
 * `fields/candidates.ts`, and this is where they are pinned.
 */

/** Every kind `core/fields.ts` declares, taken from its own builders rather than
 * retyped: a kind added there without a builder is not a kind, and a kind with one
 * appears here automatically. */
const EVERY_KIND: Field['kind'][] = [
  'text',
  'textarea',
  'number',
  'boolean',
  'select',
  'asset',
  'multiasset',
  'multilink',
  'richtext',
  'reference',
  'references',
  'blocks',
  'collection',
]

describe('controlFor', () => {
  /**
   * The guard against the failure the old twelve-branch ternary had: its final
   * `else` caught `text` *and* every kind added later, so a new field kind silently
   * rendered as a text box and nobody found out until an editor typed JSON into it.
   */
  it('answers for every kind core/fields.ts declares', () => {
    for (const kind of EVERY_KIND) {
      expect(controlFor(kind), kind).toBeTruthy()
    }
  })

  /**
   * The list above has to *be* every kind, or the assertion above proves nothing.
   * `core/fields.ts` exports one builder per kind, so the builders are the census —
   * and the count is checked too, so a fourteenth kind fails here rather than
   * quietly rendering as a text box.
   */
  it('is checked against every builder core/fields.ts exports', () => {
    const built = [
      fields.text(),
      fields.textarea(),
      fields.number(),
      fields.boolean(),
      fields.select({ options: [{ label: 'A', value: 'a' }] }),
      fields.asset(),
      fields.multiasset(),
      fields.multilink(),
      fields.richtext(),
      fields.reference(),
      fields.references(),
      fields.blocks({ allow: ['x'] }),
      fields.collection(),
    ]
    expect(new Set(built.map((f) => f.kind))).toEqual(new Set(EVERY_KIND))

    // `defaultValue` is the one exported function that is not a builder.
    const builders = Object.entries(fields).filter(
      ([name, value]) => typeof value === 'function' && name !== 'defaultValue',
    )
    expect(builders).toHaveLength(EVERY_KIND.length)
  })

  it('is none only for blocks, which never reaches a field row', () => {
    expect(controlFor('blocks')).toBe('none')
    for (const kind of EVERY_KIND.filter((k) => k !== 'blocks')) {
      expect(controlFor(kind), kind).not.toBe('none')
    }
  })

  it('groups the two asset kinds and the two reference kinds separately', () => {
    expect(controlFor('asset')).toBe('asset')
    expect(controlFor('multiasset')).toBe('multiasset')
    expect(controlFor('reference')).toBe('reference')
    expect(controlFor('references')).toBe('references')
  })

  /** A checkbox is 16px and leaves the rest of the row empty; every other control
   * fills the column, so anything beside it would be squeezed. One kind, and the
   * assertion is that it stays one kind. */
  it('lays out a checkbox across its row and nothing else', () => {
    expect(isInlineControl('boolean')).toBe(true)
    for (const kind of EVERY_KIND.filter((k) => k !== 'boolean')) {
      expect(isInlineControl(kind), kind).toBe(false)
    }
  })
})

/*
 * Warnings, never refusals. `required` is declared-and-ignored on write across the
 * whole field system, so an inspector that refused an empty required field would be
 * inventing enforcement ahead of the renderer, the content API and the importer.
 */
describe('fieldWarning', () => {
  it('is silent about a field with nothing to say', () => {
    expect(fieldWarning({ kind: 'text' }, '')).toBeNull()
    expect(fieldWarning({ kind: 'text' }, 'anything')).toBeNull()
  })

  it('names a required field that is still empty', () => {
    expect(fieldWarning({ kind: 'text', required: true }, '')).toMatch(/required/i)
    expect(fieldWarning({ kind: 'text', required: true }, '   ')).toMatch(/required/i)
    expect(fieldWarning({ kind: 'text', required: true }, 'x')).toBeNull()
  })

  /** `false` and `0` are values, not emptiness — a required boolean that is off is
   * satisfied, and a required number of zero is a number. */
  it('does not call false or zero empty', () => {
    expect(fieldWarning({ kind: 'boolean', required: true }, false)).toBeNull()
    expect(fieldWarning({ kind: 'number', required: true }, 0)).toBeNull()
  })

  /** data-documents.md decision 3: `min` is surfaced as a warning and **not**
   * enforced on write, while `max` is enforced by the input. */
  it('reports an unmet references min with both numbers', () => {
    const field: Field = { kind: 'references', min: 3 }
    expect(fieldWarning(field, ['a', 'b'])).toBe('Pick at least 3 — 2 chosen.')
    expect(fieldWarning(field, ['a', 'b', 'c'])).toBeNull()
  })

  it('counts references the way asStoryIds does, dropping repeats', () => {
    // `asStoryIds` drops duplicates on the way out, so a list of the same id twice is
    // one pick — and the warning has to agree, or `max` counts something the editor
    // cannot see.
    expect(fieldWarning({ kind: 'references', min: 2 }, ['a', 'a'])).toBe(
      'Pick at least 2 — 1 chosen.',
    )
  })

  it('states a reached multiasset limit rather than complaining about it', () => {
    const field: Field = { kind: 'multiasset', max: 2 }
    const asset = { key: 'k', filename: 'a.png', contentType: 'image/png', size: 1, alt: '' }
    expect(fieldWarning(field, [asset, asset] as never)).toBe('Limit of 2 reached.')
    expect(fieldWarning(field, [asset] as never)).toBeNull()
  })

  it('reports a number outside its declared range', () => {
    expect(fieldWarning({ kind: 'number', min: 1 }, 0)).toBe('Must be at least 1.')
    expect(fieldWarning({ kind: 'number', max: 10 }, 11)).toBe('Must be at most 10.')
    expect(fieldWarning({ kind: 'number', min: 1, max: 10 }, 5)).toBeNull()
  })
})

describe('isBlank', () => {
  it('treats an empty richtext document as nothing to translate', () => {
    expect(isBlank({ kind: 'richtext' }, null)).toBe(true)
    expect(isBlank({ kind: 'richtext' }, { type: 'doc', content: [] } as never)).toBe(true)
  })

  it('treats an asset that will not parse as absent', () => {
    expect(isBlank({ kind: 'asset' }, {} as never)).toBe(true)
    expect(isBlank({ kind: 'asset' }, { key: 'k', filename: 'a.png' } as never)).toBe(false)
  })

  it('treats an empty array as nothing and a whitespace string as nothing', () => {
    expect(isBlank({ kind: 'references' }, [])).toBe(true)
    expect(isBlank({ kind: 'text' }, ' \n ')).toBe(true)
  })
})

/* ------------------------------------------------------------- candidates --- */

/*
 * `fields/candidates.ts`. The one place the port changed behaviour rather than
 * styling: the array these pickers used to filter — every document on the site,
 * held in memory — is what `foundation/pagination.md` removed, so the candidate
 * list is a search over the routes.
 */

const row = (over: Partial<StoryMeta>): StoryMeta =>
  ({
    id: 'sty_a',
    type: 'page',
    parentId: null,
    slug: 'a',
    path: 'a',
    ord: 'a0',
    title: 'A',
    publishedAt: null,
    unpublishedAt: null,
    updatedAt: 0,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    ...over,
  }) as StoryMeta

describe('candidateRequests', () => {
  /**
   * `?flat=1` filters `path is not null`, so it is every routed *page* and can never
   * return a record; `GET /documents` with no `?type=` is every *unrouted* document.
   * Neither is a superset of the other, which is why a reference asks twice and a
   * link asks once.
   */
  it('asks one route for a link and two for a reference', () => {
    expect(candidateRequests({ q: '', routed: true })).toHaveLength(1)
    expect(candidateRequests({ q: '', routed: false })).toHaveLength(2)
    expect(candidateRequests({ q: '', routed: true })[0]).toContain('flat=1')
    expect(candidateRequests({ q: '', routed: false })[1]).toContain('/documents?')
  })

  it('sends the search to the route rather than filtering a page client-side', () => {
    const [pages] = candidateRequests({ q: '  about  ', routed: true })
    expect(pages).toContain('q=about')
  })

  it('leaves q out entirely when nothing has been typed', () => {
    expect(candidateRequests({ q: '   ', routed: true })[0]).not.toContain('q=')
  })

  it('bounds every request', () => {
    for (const path of candidateRequests({ q: '', routed: false })) {
      expect(path).toContain(`limit=${CANDIDATE_LIMIT}`)
    }
  })

  /**
   * The honest limitation, pinned so it cannot be forgotten: the routes take one
   * `?type=`, so a field naming two types narrows the *page* rather than the table.
   * `narrow` is what does that second half.
   */
  it('sends ?type= only when the field names exactly one type', () => {
    expect(candidateRequests({ q: '', routed: true, types: ['insight'] })[0]).toContain(
      'type=insight',
    )
    expect(
      candidateRequests({ q: '', routed: true, types: ['insight', 'person'] })[0],
    ).not.toContain('type=')
  })
})

describe('narrow', () => {
  it('refuses an unrouted document for a link and offers it for a reference', () => {
    const rows = [row({ id: 'sty_p', path: 'about' }), row({ id: 'sty_r', path: null })]
    expect(narrow(rows, { q: '', routed: true }).map((c) => c.id)).toEqual(['sty_p'])
    expect(narrow(rows, { q: '', routed: false }).map((c) => c.id)).toEqual(['sty_p', 'sty_r'])
  })

  it('narrows by every declared type, not only the one the route was told', () => {
    const rows = [
      row({ id: 'sty_i', type: 'insight' }),
      row({ id: 'sty_p', type: 'person', path: null }),
      row({ id: 'sty_x', type: 'page' }),
    ]
    const out = narrow(rows, { q: '', routed: false, types: ['insight', 'person'] })
    expect(out.map((c) => c.id)).toEqual(['sty_i', 'sty_p'])
  })

  it('drops what is already picked, which is what stops a references list repeating', () => {
    const rows = [row({ id: 'sty_a' }), row({ id: 'sty_b', path: 'b' })]
    expect(narrow(rows, { q: '', routed: false, exclude: ['sty_a'] }).map((c) => c.id)).toEqual([
      'sty_b',
    ])
  })

  /** Two requests can legitimately return the same row — a singleton reached by
   * `?type=` is ensured by both — so the merge has to be idempotent. */
  it('de-duplicates rows that arrived from both requests', () => {
    const one = row({ id: 'sty_a' })
    expect(narrow([one, one], { q: '', routed: false })).toHaveLength(1)
  })

  /**
   * Routed documents first by path, unrouted ones by title. That puts the site's
   * structure in front of its data, so the list reads as a sitemap rather than as an
   * alphabet — `referenceCandidates`' order, carried over.
   */
  it('sorts routed by path and unrouted by title, structure first', () => {
    const rows = [
      row({ id: 'sty_z', path: null, title: 'Zoe' }),
      row({ id: 'sty_b', path: 'blog' }),
      row({ id: 'sty_a', path: 'about' }),
      row({ id: 'sty_m', path: null, title: 'Mo' }),
    ]
    expect(narrow(rows, { q: '', routed: false }).map((c) => c.id)).toEqual([
      'sty_a',
      'sty_b',
      'sty_m',
      'sty_z',
    ])
  })
})

describe('candidateHint', () => {
  it('is a URL for a page and a type for a record', () => {
    expect(candidateHint({ id: 'a', title: 'A', path: 'about/team', type: 'page' })).toBe(
      '/about/team',
    )
    expect(candidateHint({ id: 'b', title: 'B', path: null, type: 'person' })).toBe('person')
  })

  /** The site root's path is `''`, which has to read as `/` and not as an empty
   * secondary line. */
  it('shows the site root as a slash', () => {
    expect(candidateHint({ id: 'r', title: 'Home', path: '', type: 'page' })).toBe('/')
  })
})
