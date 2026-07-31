import { describe, expect, it } from 'vitest'
import { crumbs, documentTitle, href, parse, same } from '../../../src/admin/ui/route'

/**
 * The URL model. Every one of these is a claim `docs/design-system.md` makes as a
 * commitment — "if a person can see it, they can link to it" — and the router is
 * where it either holds or quietly does not.
 *
 * Mounted at `/folio`, which is where the shell lives now that the admin's
 * internal JSON has moved to `/folio/api`
 * (`docs/specs/foundation/pagination.md` phase 3). These tests were written
 * against `/folio/ui` and every path in them is relative to `MOUNT`, so the move
 * was one constant here — which was the whole argument for making the router
 * prefix-relative rather than absolute.
 */

const MOUNT = '/folio'

describe('parse', () => {
  it('reads the mount root as Home, with or without a trailing slash', () => {
    expect(parse('/folio', MOUNT).screen).toEqual({ name: 'home' })
    expect(parse('/folio/', MOUNT).screen).toEqual({ name: 'home' })
  })

  it('reads each parameterless screen', () => {
    expect(parse('/folio/content', MOUNT).screen).toEqual({ name: 'content' })
    expect(parse('/folio/assets', MOUNT).screen).toEqual({ name: 'assets' })
    expect(parse('/folio/access', MOUNT).screen).toEqual({ name: 'access' })
    expect(parse('/folio/model', MOUNT).screen).toEqual({ name: 'model' })
    expect(parse('/folio/redirects', MOUNT).screen).toEqual({ name: 'redirects' })
    expect(parse('/folio/settings', MOUNT).screen).toEqual({ name: 'settings' })
    // The kitchen sink, which finally has a sane URL: it read `/folio/ui/ui` while
    // the shell was itself under a `/ui` prefix.
    expect(parse('/folio/ui', MOUNT).screen).toEqual({ name: 'ui' })
  })

  it('reads the two parameterised screens', () => {
    expect(parse('/folio/documents/person', MOUNT).screen).toEqual({
      name: 'documents',
      type: 'person',
    })
    expect(parse('/folio/edit/sty_abc', MOUNT).screen).toEqual({ name: 'edit', id: 'sty_abc' })
  })

  it('decodes a parameter, so a type name with a space is one segment not two', () => {
    expect(parse('/folio/documents/case%20study', MOUNT).screen).toEqual({
      name: 'documents',
      type: 'case study',
    })
  })

  it('refuses an empty parameter rather than routing to a screen that would fetch nothing', () => {
    expect(parse('/folio/documents/', MOUNT).screen).toEqual({
      name: 'missing',
      path: '/folio/documents/',
    })
    expect(parse('/folio/edit/', MOUNT).screen).toEqual({
      name: 'missing',
      path: '/folio/edit/',
    })
  })

  it('is missing for an unknown screen', () => {
    expect(parse('/folio/nope', MOUNT).screen).toEqual({
      name: 'missing',
      path: '/folio/nope',
    })
    // Two segments, neither of them a parameterised screen. The admin's own JSON
    // lives under `/folio/api`, so this is also what the shell would see if a
    // fetch URL were ever navigated to by mistake.
    expect(parse('/folio/api/stories', MOUNT).screen).toEqual({
      name: 'missing',
      path: '/folio/api/stories',
    })
  })

  it('is missing for a path outside the mount, including one that only looks like it', () => {
    // A host route that reached the shell by mistake must not resolve to Home —
    // and `/foliox` sharing a prefix with `/folio` must not either, which is what
    // makes the check a segment comparison rather than a `startsWith`.
    expect(parse('/somewhere/else', MOUNT).screen).toEqual({
      name: 'missing',
      path: '/somewhere/else',
    })
    expect(parse('/foliox/content', MOUNT).screen).toEqual({
      name: 'missing',
      path: '/foliox/content',
    })
    expect(parse('/', MOUNT).screen).toEqual({ name: 'missing', path: '/' })
  })

  it('reads the query, and keeps it on a screen that has no idea what it means', () => {
    const route = parse('/folio/content?state=changed&q=team', MOUNT)
    expect(route.screen).toEqual({ name: 'content' })
    expect(route.query).toEqual({ state: 'changed', q: 'team' })
    expect(parse('/folio/nope?x=1', MOUNT).query).toEqual({ x: '1' })
  })

  it('reads the editor query the design names', () => {
    const route = parse('/folio/edit/sty_1?blok=u9&locale=fr&version=ver_2&panel=history', MOUNT)
    expect(route.query).toEqual({ blok: 'u9', locale: 'fr', version: 'ver_2', panel: 'history' })
  })
})

describe('href', () => {
  it('round-trips every screen through parse', () => {
    const screens = [
      { name: 'home' },
      { name: 'content' },
      { name: 'assets' },
      { name: 'access' },
      { name: 'model' },
      { name: 'redirects' },
      { name: 'settings' },
      { name: 'ui' },
      { name: 'documents', type: 'person' },
      { name: 'edit', id: 'sty_abc' },
    ] as const
    for (const screen of screens) {
      expect(parse(href(screen, MOUNT), MOUNT).screen).toEqual(screen)
    }
  })

  it('round-trips a parameter that needs encoding', () => {
    const screen = { name: 'documents', type: 'case study' } as const
    expect(href(screen, MOUNT)).toBe('/folio/documents/case%20study')
    expect(parse(href(screen, MOUNT), MOUNT).screen).toEqual(screen)
  })

  it('writes Home as the bare mount', () => {
    expect(href({ name: 'home' }, MOUNT)).toBe('/folio')
  })

  it('drops empty and undefined query values, so a cleared filter leaves the URL', () => {
    expect(href({ name: 'content' }, MOUNT, { state: 'draft', q: '', type: undefined })).toBe(
      '/folio/content?state=draft',
    )
    expect(href({ name: 'content' }, MOUNT, { q: '' })).toBe('/folio/content')
  })

  it('is prefix-relative, which is what made the mount move a one-line change', () => {
    // Proven rather than asserted in prose: the shell moved from `/folio/ui` to
    // `/folio` in one constant, because nothing in `route.ts` names a prefix.
    expect(href({ name: 'content' }, '/folio/ui')).toBe('/folio/ui/content')
    expect(href({ name: 'content' }, '/admin')).toBe('/admin/content')
    // A host may mount Folio anywhere, which is why this is not optional.
    expect(href({ name: 'edit', id: 'sty_1' }, '/cms/v2')).toBe('/cms/v2/edit/sty_1')
  })
})

describe('same', () => {
  it('is true for the same place and false when the query differs', () => {
    const a = parse('/folio/content?state=draft', MOUNT)
    const b = parse('/folio/content?state=draft', MOUNT)
    const c = parse('/folio/content?state=changed', MOUNT)
    expect(same(a, b)).toBe(true)
    expect(same(a, c)).toBe(false)
  })

  it('is false for two different screens', () => {
    expect(same(parse('/folio/content', MOUNT), parse('/folio/assets', MOUNT))).toBe(false)
  })
})

describe('crumbs', () => {
  const label = (name: string) => ({ person: 'People', office: 'Offices' })[name]

  it('names a platform screen with no trail', () => {
    expect(crumbs(parse('/folio/assets', MOUNT))).toEqual([{ text: 'Assets' }])
    expect(crumbs(parse('/folio/model', MOUNT))).toEqual([{ text: 'Model' }])
  })

  it('names a type list by its label, falling back to the type name', () => {
    expect(crumbs(parse('/folio/documents/person', MOUNT), { label })).toEqual([{ text: 'People' }])
    expect(crumbs(parse('/folio/documents/ghost', MOUNT), { label })).toEqual([{ text: 'ghost' }])
  })

  it('builds a page trail from Content, with every ancestor a link and the document not', () => {
    const trail = crumbs(parse('/folio/edit/sty_team', MOUNT), {
      chain: [
        { id: 'sty_about', title: 'About' },
        { id: 'sty_team', title: 'Our team' },
      ],
    })
    expect(trail).toEqual([
      { text: 'Content', screen: { name: 'content' } },
      { text: 'About', screen: { name: 'edit', id: 'sty_about' } },
      { text: 'Our team' },
    ])
  })

  it("roots a record's trail at its own list, which is the way back the review found missing", () => {
    expect(
      crumbs(parse('/folio/edit/sty_ada', MOUNT), {
        root: { text: 'People', screen: { name: 'documents', type: 'person' } },
        chain: [{ id: 'sty_ada', title: 'Ada Lovelace' }],
      }),
    ).toEqual([
      { text: 'People', screen: { name: 'documents', type: 'person' } },
      { text: 'Ada Lovelace' },
    ])
  })

  it('gives a global no root at all: there is one of it and no list to go back to', () => {
    // `null`, not undefined. The distinction is load-bearing — the running shell
    // rooted every global at `Content` until it existed.
    expect(
      crumbs(parse('/folio/edit/sng_header', MOUNT), {
        root: null,
        chain: [{ id: 'sng_header', title: 'Header' }],
      }),
    ).toEqual([{ text: 'Header' }])
  })

  it('roots at Content while the manifest has not landed, so the bar does not reflow', () => {
    expect(crumbs(parse('/folio/edit/sty_ada', MOUNT), { label })).toEqual([
      { text: 'Content', screen: { name: 'content' } },
    ])
  })

  it('says so for a path it does not recognise', () => {
    expect(crumbs(parse('/folio/nope', MOUNT))).toEqual([{ text: 'Not found' }])
  })
})

describe('documentTitle', () => {
  it('leads with the deepest crumb, because a tab strip truncates from the right', () => {
    expect(
      documentTitle(parse('/folio/edit/sty_team', MOUNT), {
        chain: [
          { id: 'sty_about', title: 'About' },
          { id: 'sty_team', title: 'Our team' },
        ],
      }),
    ).toBe('Our team · Folio')
    expect(documentTitle(parse('/folio/content', MOUNT))).toBe('Content · Folio')
  })
})
