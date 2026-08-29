/**
 * The create dialog's rules (`admin/ui/screens/create-model.ts`).
 *
 * The defect these exist for: both New buttons used to `POST {title:'Untitled'}`
 * on click, so a row existed — in the tree, in search, in every "used by N"
 * count — before its author had typed anything, and abandoning the editor left it
 * there for good. The dialog collects the name first and writes once, so the
 * assertions that matter are the two that make an `Untitled` row unrepresentable:
 * `refusalOf` refuses an empty name, and `createBody` returns null rather than a
 * body when it would.
 *
 * Pure functions only, per the admin's convention — no test here mounts the
 * dialog, so what the dialog *decides* has to be decidable without it.
 */
import { describe, expect, it } from 'vitest'
import {
  createBody,
  createForm,
  type CreateDraft,
  EMPTY_DRAFT,
  pathOf,
  refusalOf,
  slugFieldValue,
  slugOf,
} from '../../../src/admin/ui/screens/create-model'
import { text, textarea } from '../../../src/core/fields'
import type { DocumentType, SchemaIndex } from '../../../src/core/schema'

const schema: SchemaIndex = {
  page: {
    name: 'page',
    label: 'Page',
    summary: 'title',
    fields: {
      title: text({ label: 'Title', required: true }),
      description: textarea({ label: 'Meta description' }),
    },
  },
  personRecord: {
    name: 'personRecord',
    label: 'Person',
    summary: 'fullName',
    fields: {
      fullName: text({ label: 'Full name', required: true }),
      role: text({ label: 'Role' }),
    },
  },
  /** No `title` field, no `summary` — so `titleFieldOf` runs out. */
  bareRoot: { name: 'bareRoot', label: 'Bare', fields: { note: text({ label: 'Note' }) } },
}

const pageType: DocumentType = { name: 'page', label: 'Page', kind: 'page', root: 'page' }
const personType: DocumentType = {
  name: 'person',
  label: 'Person',
  kind: 'record',
  root: 'personRecord',
  titleField: 'fullName',
}
const bareType: DocumentType = {
  name: 'bare',
  label: 'Bare thing',
  kind: 'record',
  root: 'bareRoot',
}

/** A draft, from the empty one. */
function draft(overrides: Partial<CreateDraft> = {}): CreateDraft {
  return { ...EMPTY_DRAFT, ...overrides }
}

describe('createForm: what the dialog asks for', () => {
  it('labels the name field with the title field’s own label', () => {
    // The whole reason the dialog reads the schema: creating a person asks for a
    // "Full name", which is what `personRecord` calls it — not "Name", not
    // "Title".
    expect(createForm(personType, schema)).toEqual({
      type: 'person',
      titleField: 'fullName',
      titleFieldKnown: true,
      nameLabel: 'Full name',
      routed: false,
    })
  })

  it('derives the title field for a type that declares none', () => {
    // `page` has no `titleField`; `titleFieldOf` finds the root block's own
    // `title`.
    expect(createForm(pageType, schema)).toEqual({
      type: 'page',
      titleField: 'title',
      titleFieldKnown: true,
      nameLabel: 'Title',
      routed: true,
    })
  })

  it('falls back to Title when the root block offers no title field at all', () => {
    // The honest fallback: the name still goes somewhere — `stories.title`, which
    // `runtime.ts`'s `titleFor` falls back to — but no field on the form holds it.
    // `titleFieldKnown` is what lets the dialog say so.
    expect(createForm(bareType, schema)).toEqual({
      type: 'bare',
      titleField: undefined,
      titleFieldKnown: true,
      nameLabel: 'Title',
      routed: false,
    })
  })

  it('does not claim a type has no title field when it has no schema to check', () => {
    // Content is not handed a `SchemaIndex` yet, so this is the path its dialog
    // takes today. `titleField` is undefined either way, and only
    // `titleFieldKnown` tells "there is none" from "I cannot see" — without it the
    // dialog printed "Page has no title field" under a `page`, which is false.
    expect(createForm(pageType)).toEqual({
      type: 'page',
      titleField: undefined,
      titleFieldKnown: false,
      nameLabel: 'Title',
      routed: true,
    })
    expect(createForm(personType).nameLabel).toBe('Title')
  })

  it('asks for a slug for a page kind and for nothing else', () => {
    expect(createForm(pageType, schema).routed).toBe(true)
    expect(createForm(personType, schema).routed).toBe(false)
    expect(
      createForm({ name: 'settings', label: 'Settings', kind: 'singleton', root: 'bareRoot' })
        .routed,
    ).toBe(false)
  })
})

describe('the slug follows the name until somebody takes it over', () => {
  it('derives the slug from the name', () => {
    expect(slugFieldValue(draft({ name: 'Our Team' }))).toBe('our-team')
    expect(slugOf(draft({ name: 'Our Team' }))).toBe('our-team')
  })

  it('leaves the slug box empty before the first keystroke', () => {
    // `slugify('')` answers `'untitled'`, which is right for a row being written
    // and wrong for a box nobody has filled in: it would be indistinguishable
    // from a slug somebody chose.
    expect(slugFieldValue(EMPTY_DRAFT)).toBe('')
    expect(slugOf(EMPTY_DRAFT)).toBe('')
  })

  it('stops deriving once the slug is edited', () => {
    const edited = draft({ name: 'Our Team', slug: 'team', slugEdited: true })
    expect(slugFieldValue(edited)).toBe('team')
    expect(slugOf(edited)).toBe('team')
  })

  it('shows a half-typed slug unslugified and slugifies it on the way out', () => {
    // Slugifying every keystroke eats the states a slug passes through: `team-`
    // would collapse to `team` and the next character could never be typed.
    const typing = draft({ name: 'Our Team', slug: 'The Team-', slugEdited: true })
    expect(slugFieldValue(typing)).toBe('The Team-')
    expect(slugOf(typing)).toBe('the-team')
  })

  it('falls back to the name when the slug box is cleared', () => {
    // `createStory` does `slugify(input.slug || input.title)`, so a cleared box
    // means "derive it" on the server too. The two have to agree or the path
    // preview lies about where the page lands.
    const cleared = draft({ name: 'Our Team', slug: '', slugEdited: true })
    expect(slugOf(cleared)).toBe('our-team')
  })
})

describe('pathOf: where the page will live', () => {
  it('is the slug at the top level', () => {
    expect(pathOf(draft({ name: 'Our Team' }))).toBe('/our-team')
  })

  it('joins the parent’s path, with one slash', () => {
    // `'' + '/' + slug` is how a leading double slash appears; `joinPath` is why
    // it does not.
    expect(pathOf(draft({ name: 'Our Team' }), 'about')).toBe('/about/our-team')
    expect(pathOf(draft({ name: 'Our Team' }), '')).toBe('/our-team')
  })

  it('is the parent’s own path before anything is typed', () => {
    expect(pathOf(EMPTY_DRAFT, 'about')).toBe('/about')
    expect(pathOf(EMPTY_DRAFT)).toBe('/')
  })
})

describe('refusalOf: an unnamed document cannot be created', () => {
  it('refuses an empty name, in the field’s own words', () => {
    expect(refusalOf(createForm(personType, schema), EMPTY_DRAFT)).toBe('Enter a full name')
    expect(refusalOf(createForm(pageType, schema), EMPTY_DRAFT)).toBe('Enter a title')
  })

  it('refuses whitespace', () => {
    expect(refusalOf(createForm(pageType, schema), draft({ name: '   ' }))).toBe('Enter a title')
  })

  it('accepts a name', () => {
    expect(refusalOf(createForm(pageType, schema), draft({ name: 'Our Team' }))).toBeUndefined()
  })

  it('has no rule of its own for the slug', () => {
    // There is nothing to refuse: `slugOf` cannot answer empty for a non-empty
    // name, because an emptied box re-derives.
    const cleared = draft({ name: 'Our Team', slug: '', slugEdited: true })
    expect(refusalOf(createForm(pageType, schema), cleared)).toBeUndefined()
  })
})

describe('createBody: the request that used to say Untitled', () => {
  it('is the same body as before, with a real title', () => {
    // `{title, slug?, parentId, type}` — exactly what both screens already posted.
    // No route changed for this feature and none needed to.
    expect(createBody(createForm(pageType, schema), draft({ name: 'Our Team' }))).toEqual({
      title: 'Our Team',
      slug: 'our-team',
      parentId: null,
      type: 'page',
    })
  })

  it('trims the title', () => {
    expect(createBody(createForm(pageType, schema), draft({ name: '  Our Team  ' }))?.title).toBe(
      'Our Team',
    )
  })

  it('carries the parent for a page', () => {
    const body = createBody(createForm(pageType, schema), draft({ name: 'Team' }), 'sty_about')
    expect(body).toEqual({ title: 'Team', slug: 'team', parentId: 'sty_about', type: 'page' })
  })

  it('sends no slug for an unrouted type, and no parent either', () => {
    // `createStory` throws on a record with a parent — a record is not in the
    // tree, so there is nothing for it to be under — and its slug is derived from
    // the title inside its own sibling group.
    const body = createBody(
      createForm(personType, schema),
      draft({ name: 'Ada Lovelace' }),
      'sty_x',
    )
    expect(body).toEqual({ title: 'Ada Lovelace', parentId: null, type: 'person' })
    expect(body && 'slug' in body).toBe(false)
  })

  it('is null when the name is empty', () => {
    // The guard, and the reason it is here rather than only in the component: an
    // unchecked caller cannot post an `Untitled` row by skipping the disabled
    // button.
    expect(createBody(createForm(pageType, schema), EMPTY_DRAFT)).toBeNull()
    expect(createBody(createForm(personType, schema), draft({ name: ' ' }))).toBeNull()
  })
})
