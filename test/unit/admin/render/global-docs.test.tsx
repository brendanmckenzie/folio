import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useGlobalDocs } from '../../../../src/admin/hooks/useGlobalDocs'
import type { DocumentType } from '../../../../src/core/schema'

/**
 * "Edit ‹global› →" traces a clicked uid to its global through this hook's copy of
 * each global's document. On a deployment with `sites` that copy must be the *scope's
 * layer* (`sng_<type>:<scope>`, `sng_<type>` for `default`), or a block in the layer
 * being edited is never recognised; single-site keeps `sng_<type>`.
 */
const TYPES = [{ name: 'header', label: 'Header', kind: 'singleton', root: 'h' }] as DocumentType[]
const DOC = {
  root: 'r',
  bloks: { r: { uid: 'r', type: 'h', parent: null, slot: null, order: 'a0', data: {} } },
}

async function asked(apiBase: string): Promise<{ urls: string[]; names: string[] }> {
  const urls: string[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input))
    return Promise.resolve(new Response(JSON.stringify({ doc: DOC }), { status: 200 }))
  }) as typeof fetch
  const { result } = renderHook(() => useGlobalDocs(apiBase, TYPES, ['header']))
  await waitFor(() => expect(Object.keys(result.current.docs)).toEqual(['header']))
  return { urls, names: Object.keys(result.current.docs) }
}

describe('useGlobalDocs', () => {
  it('reads the scope’s own layer on a multi-site deployment', async () => {
    expect((await asked('/folio/~alpha/api')).urls).toEqual([
      '/folio/~alpha/api/story/sng_header%3Aalpha/document',
    ])
  })

  it('reads the bare singleton for `default`', async () => {
    expect((await asked('/folio/~default/api')).urls).toEqual([
      '/folio/~default/api/story/sng_header/document',
    ])
  })

  it('reads sng_<type> on a single-site deployment, unchanged', async () => {
    expect((await asked('/folio/api')).urls).toEqual(['/folio/api/story/sng_header/document'])
  })
})
