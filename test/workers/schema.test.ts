import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { asset, defineBlock, select, text } from '../../src/core'
import { createFolio } from '../../src/server'
import type { FolioBindings } from '../../src/server'

// conditional-fields.md's testing requirements: `showIf` and `hidden` are
// plain JSON, so the guard against someone "simplifying" them into a function
// later is that the manifest round-trips one unchanged.

const hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  summary: 'title',
  fields: {
    title: text({ label: 'Title' }),
    layout: select({
      options: [
        { label: 'Full', value: 'full' },
        { label: 'Split', value: 'split' },
      ],
    }),
    image: asset({ showIf: { field: 'layout', eq: 'split' } }),
    legacyId: text({ hidden: true }),
  },
  render: () => null,
})

const ORIGIN = 'https://example.com'

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

describe('GET /folio/schema: showIf and hidden survive the trip', () => {
  it('carries a showIf condition and a hidden flag through, structurally unchanged', async () => {
    const folio = createFolio<Cloudflare.Env>({
      blocks: [hero],
      root: 'hero',
      bindings,
      basePath: '/folio',
    })

    const res = await folio.handle(
      new Request(`${ORIGIN}/folio/schema`),
      env,
      createExecutionContext(),
    )
    expect(res?.status).toBe(200)

    const manifest = await res?.json<{
      blocks: { name: string; fields: Record<string, unknown> }[]
    }>()
    const fields = manifest?.blocks.find((b) => b.name === 'hero')?.fields
    expect(fields?.image).toEqual({ kind: 'asset', showIf: { field: 'layout', eq: 'split' } })
    expect(fields?.legacyId).toEqual({ kind: 'text', hidden: true })
  })
})
