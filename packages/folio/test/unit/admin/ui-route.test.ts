import { describe, expect, it } from 'vitest'
import { crumbs, documentTitle, href, parse, same } from '../../../src/admin/ui/route'

/**
 * The URL model. Every one of these is a claim `docs/design-system.md` makes as a
 * commitment — "if a person can see it, they can link to it" — and the router is
 * where it either holds or quietly does not.
 *
 * Mounted at `/folio/ui` throughout, which is where the shell lives while the
 * admin's internal JSON still owns the bare namespace (`server/routes/shell.ts`).
 * Every path is relative to the mount for exactly that reason, so these tests
 * carry through the move unchanged.
 */

const MOUNT = '/folio/ui'

describe('parse', () => {
  it('reads the mount root as Home, with or without a trailing slash', () => {
    expect(parse('/folio/ui', MOUNT).screen).toEqual({ name: 'home' })
    expect(parse('/folio/ui/', MOUNT).screen).toEqual({ name: 'home' })
  })

  it('reads each parameterless screen', () => {
    expect(parse('/folio/ui/content', MOUNT).screen).toEqual({ name: 'content' })
    expect(parse('/folio/ui/assets', MOUNT).screen).toEqual({ name: 'assets' })
    expect(parse('/folio/ui/access', MOUNT).screen).toEqual({ name: 'access' })
    expect(parse('/folio/ui/model', MOUNT).screen).toEqual({ name: 'model' })
    expect(parse('/folio/ui/redirects', MOUNT).screen).toEqual({ name: 'redirects' })
    expect(parse('/folio/ui/settings', MOUNT).screen).toEqual({ name: 'settings' })
    expect(parse('/folio/ui/ui', MOUNT).screen).toEqual({ name: 'ui' })
  })

  it('reads the two parameterised screens', () => {
    expect(parse('/folio/ui/documents/person', MOUNT).screen).toEqual({
      name: 'documents',
      type: 'person',
    })
    expect(parse('/folio/ui/edit/sty_abc', MOUNT).screen).toEqual({ name: 'edit', id: 'sty_abc' })
  })

  it('decodes a parameter, so a type name with a space is one segment not two', () => {
    expect(parse('/folio/ui/documents/case%20study', MOUNT).screen).toEqual({
      name: 'documents',
      type: 'case study',
    })
  })

  it('refuses an empty parameter rather than routing to a screen that would fetch nothing', () => {
    expect(parse('/folio/ui/documents/', MOUNT).screen).toEqual({
      name: 'missing',
      path: '/folio/ui/documents/',
    })
    expect(parse('/folio/ui/edit/', MOUNT).screen).toEqual({
      name: 'missing',
      path: '/folio/ui/edit/',
    })
  })

  it('is missing for an unknown screen and for a path outside the mount', () => {
    expect(parse('/folio/ui/nope', MOUNT).screen).toEqual({
      name: 'missing',
      path: '/folio/ui/nope',
    })
    // The important half: a host route that reached the shell by mistake, or a
    // prefix that only looks like the mount, must not resolve to Home.
    expect(parse('/folio/content', MOUNT).screen).toEqual({
      name: 'missing',
      path: '/folio/content',
    })
    expect(parse('/folio/uixx/content', MOUNT).screen).toEqual({
      name: 'missing',
      path: '/folio/uixx/content',
    })
  })

  it('reads the query, and keeps it on a screen that has no idea what it means', () => {
    const route = parse('/folio/ui/content?state=changed&q=team', MOUNT)
    expect(route.screen).toEqual({ name: 'content' })
    expect(route.query).toEqual({ state: 'changed', q: 'team' })
    expect(parse('/folio/ui/nope?x=1', MOUNT).query).toEqual({ x: '1' })
  })

  it('reads the editor query the design names', () => {
    const route = parse('/folio/ui/edit/sty_1?blok=u9&locale=fr&version=ver_2&panel=history', MOUNT)
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
    expect(href(screen, MOUNT)).toBe('/folio/ui/documents/case%20study')
    expect(parse(href(screen, MOUNT), MOUNT).screen).toEqual(screen)
  })

  it('writes Home as the bare mount', () => {
    expect(href({ name: 'home' }, MOUNT)).toBe('/folio/ui')
  })

  it('drops empty and undefined query values, so a cleared filter leaves the URL', () => {
    expect(href({ name: 'content' }, MOUNT, { state: 'draft', q: '', type: undefined })).toBe(
      '/folio/ui/content?state=draft',
    )
    expect(href({ name: 'content' }, MOUNT, { q: '' })).toBe('/folio/ui/content')
  })

  it('is prefix-relative, which is what makes the mount move a one-line change', () => {
    expect(href({ name: 'content' }, '/folio')).toBe('/folio/content')
    expect(href({ name: 'content' }, '/admin/ui')).toBe('/admin/ui/content')
  })
})

describe('same', () => {
  it('is true for the same place and false when the query differs', () => {
    const a = parse('/folio/ui/content?state=draft', MOUNT)
    const b = parse('/folio/ui/content?state=draft', MOUNT)
    const c = parse('/folio/ui/content?state=changed', MOUNT)
    expect(same(a, b)).toBe(true)
    expect(same(a, c)).toBe(false)
  })

  it('is false for two different screens', () => {
    expect(same(parse('/folio/ui/content', MOUNT), parse('/folio/ui/assets', MOUNT))).toBe(false)
  })
})

describe('crumbs', () => {
  const label = (name: string) => ({ person: 'People', office: 'Offices' })[name]

  it('names a platform screen with no trail', () => {
    expect(crumbs(parse('/folio/ui/assets', MOUNT))).toEqual([{ text: 'Assets' }])
    expect(crumbs(parse('/folio/ui/model', MOUNT))).toEqual([{ text: 'Model' }])
  })

  it('names a type list by its label, falling back to the type name', () => {
    expect(crumbs(parse('/folio/ui/documents/person', MOUNT), { label })).toEqual([
      { text: 'People' },
    ])
    expect(crumbs(parse('/folio/ui/documents/ghost', MOUNT), { label })).toEqual([
      { text: 'ghost' },
    ])
  })

  it('builds a page trail from Content, with every ancestor a link and the document not', () => {
    const trail = crumbs(parse('/folio/ui/edit/sty_team', MOUNT), {
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
      crumbs(parse('/folio/ui/edit/sty_ada', MOUNT), {
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
      crumbs(parse('/folio/ui/edit/sng_header', MOUNT), {
        root: null,
        chain: [{ id: 'sng_header', title: 'Header' }],
      }),
    ).toEqual([{ text: 'Header' }])
  })

  it('roots at Content while the manifest has not landed, so the bar does not reflow', () => {
    expect(crumbs(parse('/folio/ui/edit/sty_ada', MOUNT), { label })).toEqual([
      { text: 'Content', screen: { name: 'content' } },
    ])
  })

  it('says so for a path it does not recognise', () => {
    expect(crumbs(parse('/folio/ui/nope', MOUNT))).toEqual([{ text: 'Not found' }])
  })
})

describe('documentTitle', () => {
  it('leads with the deepest crumb, because a tab strip truncates from the right', () => {
    expect(
      documentTitle(parse('/folio/ui/edit/sty_team', MOUNT), {
        chain: [
          { id: 'sty_about', title: 'About' },
          { id: 'sty_team', title: 'Our team' },
        ],
      }),
    ).toBe('Our team · Folio')
    expect(documentTitle(parse('/folio/ui/content', MOUNT))).toBe('Content · Folio')
  })
})
