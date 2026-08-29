import { describe, expect, it, vi } from 'vitest'
import {
  idsToFetch,
  loadReferencedDocs,
  mergeReferencedDocs,
  NO_REFERENCED_DOCS,
  type ReferencedDocs,
  wantedReferencedIds,
} from '../../../src/admin/hooks/useReferencedDocs'
import type { Blok, Doc } from '../../../src/core/doc'
import { reference } from '../../../src/core/fields'
import type { SchemaIndex } from '../../../src/core/schema'

const doc = (root: string): Doc => ({
  root,
  bloks: { [root]: { uid: root, type: 'page', parent: null, slot: null, order: 'a0', data: {} } },
})

/** A fetch that answers per url, so each test states exactly what the server did. */
function fakeFetch(answers: Record<string, Response | Error>) {
  return vi.fn(async (url: string | URL | Request) => {
    const answer = answers[String(url)]
    if (!answer) throw new Error(`unexpected request: ${String(url)}`)
    if (answer instanceof Error) throw answer
    return answer
  }) as unknown as typeof fetch
}

const found = (d: Doc) => new Response(JSON.stringify({ doc: d }), { status: 200 })
const gone = () => new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 })

const API = '/folio'
const url = (id: string) => `${API}/story/${id}/document`

describe('loadReferencedDocs', () => {
  it('returns the documents that came back', async () => {
    const fetchImpl = fakeFetch({ [url('a')]: found(doc('r1')), [url('b')]: found(doc('r2')) })
    const result = await loadReferencedDocs(API, ['a', 'b'], fetchImpl)
    expect(Object.keys(result.docs).sort()).toEqual(['a', 'b'])
    expect(result.docs.a?.root).toBe('r1')
    expect(result.missing).toEqual([])
  })

  it('reports a refused story as missing, not as an error', async () => {
    const fetchImpl = fakeFetch({ [url('a')]: found(doc('r1')), [url('dead')]: gone() })
    const result = await loadReferencedDocs(API, ['a', 'dead'], fetchImpl)
    expect(Object.keys(result.docs)).toEqual(['a'])
    expect(result.missing).toEqual(['dead'])
  })

  it('treats a body with no document as missing', async () => {
    const fetchImpl = fakeFetch({ [url('a')]: new Response('{}', { status: 200 }) })
    expect(await loadReferencedDocs(API, ['a'], fetchImpl)).toEqual({ docs: {}, missing: ['a'] })
  })

  it('leaves a transport failure out of both lists, so it is asked again', async () => {
    const fetchImpl = fakeFetch({ [url('a')]: new Error('offline') })
    // Never rejects: this runs inside an effect, where a rejection is unhandled.
    expect(await loadReferencedDocs(API, ['a'], fetchImpl)).toEqual({ docs: {}, missing: [] })
  })

  it('encodes the id into the path', async () => {
    const fetchImpl = fakeFetch({ [url('a%2Fb')]: found(doc('r1')) })
    const result = await loadReferencedDocs(API, ['a/b'], fetchImpl)
    expect(result.docs['a/b']?.root).toBe('r1')
  })
})

describe('the negative cache', () => {
  const settled = (docs: Record<string, Doc>, missing: string[]): ReferencedDocs => ({
    docs,
    missing: new Set(missing),
  })

  it('asks for everything it knows nothing about', () => {
    expect(idsToFetch(['a', 'b'], NO_REFERENCED_DOCS)).toEqual(['a', 'b'])
  })

  it('does not re-ask for a document it already holds', () => {
    expect(idsToFetch(['a', 'b'], settled({ a: doc('r1') }, []))).toEqual(['b'])
  })

  it('does not re-ask for a document the server already refused', () => {
    // The point of the cache: a reference to a deleted page would otherwise be
    // re-requested every time any *other* reference resolves, forever.
    expect(idsToFetch(['a', 'dead'], settled({ a: doc('r1') }, ['dead']))).toEqual([])
  })

  it('remembers a miss across merges', () => {
    const first = mergeReferencedDocs(NO_REFERENCED_DOCS, { docs: {}, missing: ['dead'] })
    expect(idsToFetch(['dead'], first)).toEqual([])
    const second = mergeReferencedDocs(first, { docs: { a: doc('r1') }, missing: [] })
    expect(second.missing.has('dead')).toBe(true)
    expect(idsToFetch(['a', 'dead'], second)).toEqual([])
  })

  it('is the same object when a load settled nothing, so the effect cannot loop', () => {
    const prev = mergeReferencedDocs(NO_REFERENCED_DOCS, { docs: { a: doc('r1') }, missing: [] })
    expect(mergeReferencedDocs(prev, { docs: {}, missing: [] })).toBe(prev)
  })
})

describe('wantedReferencedIds', () => {
  const schema: SchemaIndex = {
    card: { name: 'card', label: 'Card', fields: { who: reference({ types: ['person'] }) } },
  }

  /** A `card` blok whose `who` reference is set only on a translation, never on the source. */
  const cardWithTranslationOnlyRef = (locale: string, targetId: string): Doc => {
    const blok: Blok = {
      uid: 'card-1',
      type: 'card',
      parent: null,
      slot: null,
      order: 'a0',
      data: {},
      i18n: { [locale]: { who: targetId } },
    }
    return { root: blok.uid, bloks: { [blok.uid]: blok } }
  }

  it('includes a target only a translation points at, not the source value', () => {
    // The bug this closes: the admin's copy used to walk `reference` values in
    // the source locale only, so a target a translation alone points at was
    // never fetched even though the server's own resolution (which walks every
    // locale, `core/refs.ts`'s header) would render it fine on a live page.
    const wanted = wantedReferencedIds(cardWithTranslationOnlyRef('fr', 'person-1'), schema)
    expect(wanted.split(',')).toEqual(['person-1'])
  })

  it('is empty with no document open', () => {
    expect(wantedReferencedIds(null, schema)).toBe('')
  })
})
