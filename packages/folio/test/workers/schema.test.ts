import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { asset, blocks, defineBlock, select, text } from '../../src/core'
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

// field-defaults-and-presets.md's testing requirements: a new story's seeded
// document contains the root preset's children, and defaults/presets survive
// the manifest round trip unchanged, same reasoning as showIf/hidden above.

const button = defineBlock({
  name: 'button',
  label: 'Button',
  fields: {
    label: text({ default: 'Read more' }),
  },
  render: () => null,
})

const prose = defineBlock({
  name: 'prose',
  label: 'Prose',
  fields: { body: text() },
  render: () => null,
})

const insightRoot = defineBlock({
  name: 'insightRoot',
  label: 'Insight',
  fields: {
    title: text(),
    body: blocks({ allow: ['button', 'prose'] }),
  },
  presets: [
    {
      name: 'default',
      label: 'Insight',
      children: [
        { slot: 'body', type: 'button' },
        { slot: 'body', type: 'prose' },
      ],
    },
  ],
  render: () => null,
})

describe('a starting document is the root block’s own default preset', () => {
  it('seeds a new story with the preset’s children already in the document', async () => {
    const folio = createFolio<Cloudflare.Env>({
      blocks: [insightRoot, button, prose],
      root: 'insightRoot',
      bindings,
      basePath: '/folio',
    })

    const doc = await folio.draft(env, 'sty_insight_defaults_presets')

    const root = doc.bloks[doc.root]
    expect(root?.type).toBe('insightRoot')

    const children = Object.values(doc.bloks).filter((b) => b.parent === doc.root)
    expect(children.map((b) => b.type).sort()).toEqual(['button', 'prose'])

    const buttonBlok = children.find((b) => b.type === 'button')
    expect(buttonBlok?.data.label).toBe('Read more')
    expect(buttonBlok?.slot).toBe('body')
  })

  it('seeds a bare root when the root type has no default preset, exactly as before this spec', async () => {
    const folio = createFolio<Cloudflare.Env>({
      blocks: [button],
      root: 'button',
      bindings,
      basePath: '/folio',
    })

    const doc = await folio.draft(env, 'sty_bare_root')

    expect(Object.keys(doc.bloks)).toHaveLength(1)
    expect(doc.bloks[doc.root]?.type).toBe('button')
  })
})

describe('GET /folio/schema: field defaults and block presets survive the trip', () => {
  it('carries a field default and a block’s presets/presetsOnly through, structurally unchanged', async () => {
    const folio = createFolio<Cloudflare.Env>({
      blocks: [insightRoot, button, prose],
      root: 'insightRoot',
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
      blocks: {
        name: string
        fields: Record<string, unknown>
        presets?: unknown
        presetsOnly?: boolean
      }[]
    }>()

    const buttonSchema = manifest?.blocks.find((b) => b.name === 'button')
    expect(buttonSchema?.fields.label).toEqual({ kind: 'text', default: 'Read more' })

    const rootSchema = manifest?.blocks.find((b) => b.name === 'insightRoot')
    expect(rootSchema?.presets).toEqual([
      {
        name: 'default',
        label: 'Insight',
        children: [
          { slot: 'body', type: 'button' },
          { slot: 'body', type: 'prose' },
        ],
      },
    ])
  })
})
