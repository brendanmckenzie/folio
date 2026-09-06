import { describe, expect, it } from 'vitest'
import {
  formsRequest,
  loadResolvedForms,
  wantedFormIds,
} from '../../../src/admin/hooks/useResolvedForms'
import type { Blok, Doc, Json } from '../../../src/core/doc'
import { form, text } from '../../../src/core/fields'
import type { ResolvedForm } from '../../../src/core/forms'
import type { SchemaIndex } from '../../../src/core/schema'

/**
 * The admin half of a `form` field (`content-model/forms.md` decision 4).
 *
 * **The bug this exists to keep fixed is a missing key, not a wrong value.**
 * The preview iframe is server-rendered with a complete `Resolution`, and then
 * `usePreviewBridge` posts the admin's own over it — so any key `useEditor` does
 * not assemble is a key the preview loses on the first frame. `forms` was that
 * key: a page with a form rendered it correctly when published and as nothing at
 * all in the pane an editor was building it in.
 *
 * As everywhere else in this tree, no test mounts a component: what is pinned is
 * the pure half the hook is a thin fetch around — which ids are wanted, what the
 * request looks like, and what an answer that is not an answer does.
 */

const schema: SchemaIndex = {
  contact: {
    name: 'contact',
    label: 'Contact',
    fields: { heading: text({ label: 'Heading' }), enquiry: form({ label: 'Form' }) },
  },
  plain: { name: 'plain', label: 'Plain', fields: { body: text({ label: 'Body' }) } },
}

const doc = (bloks: Doc['bloks']): Doc => ({ root: 'root0000', bloks })

const blok = (uid: string, type: string, data: Record<string, Json>): Blok => ({
  uid,
  type,
  parent: null,
  slot: null,
  order: 'a0',
  data,
})

describe('wantedFormIds', () => {
  it('is the ids the document embeds, sorted — so an unchanged set is an unchanged dependency', () => {
    const one = doc({ root0000: blok('root0000', 'contact', { enquiry: 'frm_b00000000002' }) })
    const two = doc({
      root0000: blok('root0000', 'contact', { enquiry: 'frm_b00000000002' }),
      b1: blok('b1', 'contact', { enquiry: 'frm_a00000000001' }),
    })
    expect(wantedFormIds(one, schema)).toBe('frm_b00000000002')
    // Sorted rather than in document order: moving the block up the page must
    // not look like a different set and refetch.
    expect(wantedFormIds(two, schema)).toBe('frm_a00000000001,frm_b00000000002')
  })

  it('is empty for a document with no form field, and for no document at all', () => {
    expect(
      wantedFormIds(doc({ root0000: blok('root0000', 'plain', { body: 'hi' }) }), schema),
    ).toBe('')
    expect(wantedFormIds(null, schema)).toBe('')
  })
})

describe('formsRequest', () => {
  it('names the ids and nothing else when the locale and page are unknown', () => {
    // Not `locale=` and `page=` with nothing after them: an empty `page` would
    // put an empty `_folio_page` on the descriptor where the server render puts
    // no hidden input at all.
    expect(formsRequest(['frm_a00000000001'])).toBe('/forms/resolved?ids=frm_a00000000001')
  })

  it('carries the locale and the page, which are what shape a descriptor', () => {
    expect(formsRequest(['frm_a00000000001', 'frm_b00000000002'], 'fr', '/fr/contact')).toBe(
      '/forms/resolved?ids=frm_a00000000001%2Cfrm_b00000000002&locale=fr&page=%2Ffr%2Fcontact',
    )
  })
})

describe('loadResolvedForms', () => {
  const descriptor = { id: 'frm_a00000000001', name: 'contact' } as unknown as ResolvedForm

  it('answers the map the route sent', async () => {
    const answer = await loadResolvedForms(
      '/folio/api',
      ['frm_a00000000001'],
      undefined,
      undefined,
      (async (url: string) => {
        expect(url).toBe('/folio/api/forms/resolved?ids=frm_a00000000001')
        return new Response(JSON.stringify({ frm_a00000000001: descriptor }))
      }) as unknown as typeof fetch,
    )
    expect(answer).toEqual({ frm_a00000000001: descriptor })
  })

  /**
   * `null` rather than `{}` for every kind of no-answer, and the distinction is
   * the whole point: the caller keeps the descriptors it holds. A form that
   * resolved a moment ago and cannot be re-read now is better drawn from the
   * copy in hand than blanked out of the preview mid-edit — whereas an id the
   * route answers *without* is a deleted form, and comes back as an absent key.
   */
  it('answers null for a transport failure, a refusal and an unreadable body', async () => {
    const failing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(
      await loadResolvedForms('/api', ['frm_a00000000001'], undefined, undefined, failing),
    ).toBe(null)

    const refused = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    expect(
      await loadResolvedForms('/api', ['frm_a00000000001'], undefined, undefined, refused),
    ).toBe(null)

    const garbage = (async () => new Response('<html>')) as unknown as typeof fetch
    expect(
      await loadResolvedForms('/api', ['frm_a00000000001'], undefined, undefined, garbage),
    ).toBe(null)
  })
})
