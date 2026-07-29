import { describe, expect, it } from 'vitest'
import { globalPreviewUrl, globalTypes } from '../../../src/admin/GlobalsList'
import type { DocumentType } from '../../../src/core/schema'
import type { StoryNode } from '../../../src/core/story'

const type = (overrides: Partial<DocumentType> = {}): DocumentType => ({
  name: 'header',
  label: 'Header',
  kind: 'singleton',
  root: 'headerRoot',
  ...overrides,
})

const node = (overrides: Partial<StoryNode> = {}): StoryNode => ({
  id: 'sng_header',
  type: 'header',
  parentId: null,
  slug: 'header',
  path: null,
  ord: 'a0',
  title: 'Header',
  publishedAt: null,
  unpublishedAt: null,
  draftSyncId: 0,
  draftUpdatedAt: null,
  publishedSyncId: 0,
  updatedAt: 0,
  state: 'draft',
  hasUnpublishedChanges: false,
  children: [],
  ...overrides,
})

describe('globalTypes', () => {
  const header = type({ name: 'header', label: 'Header' })
  const footer = type({ name: 'footer', label: 'Footer' })
  const settings = type({ name: 'settings', label: 'Settings' })

  it('returns the configured globals, in FolioConfig.globals order', () => {
    expect(globalTypes([settings, footer, header], ['header', 'footer'])).toEqual([header, footer])
  })

  it('drops a name naming no declared type, rather than throwing', () => {
    expect(globalTypes([header], ['header', 'ghost'])).toEqual([header])
  })

  it('is empty when nothing is configured as a global', () => {
    expect(globalTypes([header, footer, settings], [])).toEqual([])
  })
})

describe('globalPreviewUrl', () => {
  it('appends &as=<name> to the previewPath story’s own preview URL', () => {
    const flat = [node({ id: 'sty_home', type: 'page', path: '', previewUrl: '/?_folio=preview' })]
    const url = globalPreviewUrl(type({ previewPath: '' }), flat, '/folio')
    expect(url).toBe('/?_folio=preview&as=header')
  })

  it('falls back to the bare preview route when no previewPath is declared', () => {
    const flat = [node({ id: 'sty_home', type: 'page', path: '', previewUrl: '/?_folio=preview' })]
    const url = globalPreviewUrl(type({ previewPath: undefined }), flat, '/folio')
    expect(url).toBe('/folio/preview/global/header')
  })

  it('falls back to the bare preview route when no story lives at previewPath any more', () => {
    const flat = [node({ id: 'sty_home', type: 'page', path: '', previewUrl: '/?_folio=preview' })]
    const url = globalPreviewUrl(type({ previewPath: 'gone' }), flat, '/folio')
    expect(url).toBe('/folio/preview/global/header')
  })

  it('encodes the type name in both URL shapes', () => {
    const flat = [node({ id: 'sty_home', type: 'page', path: '', previewUrl: '/?_folio=preview' })]
    expect(globalPreviewUrl(type({ name: 'a b', previewPath: '' }), flat, '/folio')).toBe(
      '/?_folio=preview&as=a%20b',
    )
    expect(globalPreviewUrl(type({ name: 'a b', previewPath: undefined }), [], '/folio')).toBe(
      '/folio/preview/global/a%20b',
    )
  })
})
