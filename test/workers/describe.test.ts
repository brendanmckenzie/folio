import { createExecutionContext, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineBlock, asset, text } from '../../src/core'
import type { Doc } from '../../src/core/doc'
import type { DocumentType } from '../../src/core/schema'
import { createFolio } from '../../src/server'
import type { DescribeInput, DescribeResult, FolioBindings, FolioDescribe } from '../../src/server'
import { ensureTag, tagsForAssets } from '../../src/server/asset-tags'
import { assetById, toAssetValue } from '../../src/server/assets'
import {
  DEFAULT_DESCRIBE_CONCURRENCY,
  type DescribeDeps,
  describeAsset,
  describeUrl,
  MAX_DESCRIBE_DESCRIPTION,
  matchTags,
  validateDescribe,
} from '../../src/server/describe'

/**
 * The describe seam (`docs/specs/content-model/media-library.md` phase 6),
 * against real D1, real R2 and a **stub** `fn`.
 *
 * The stub is the point rather than a shortcut. Decision 8 puts the model call
 * in the host's hands precisely so Folio never holds a key, picks a provider or
 * writes a prompt — which means every behaviour worth pinning here is reachable
 * with a function that returns a literal, and a suite that needed an API key
 * would be evidence the seam had been drawn in the wrong place.
 *
 * Three properties carry the weight, and none of them is visible from a
 * successful describe:
 *
 *  - **A human edit always wins, and a run cannot touch a published page**
 *    (decision 9). `alt` is the editor's column, `alt_auto` the model's, and
 *    `toAssetValue` reads `alt || alt_auto` — so the stored alt is a *default*
 *    copied into a field value at pick time and independent from then on. The
 *    `published_doc` assertion below is the whole safety argument for running
 *    this over three thousand images: it is byte-identical afterwards.
 *  - **The model may only choose tags that already exist, and drops are
 *    counted** (decision 11). Verified by breaking it: letting an unmatched slug
 *    through instead of counting it turns *the model may not invent a tag* red on
 *    both halves — `tagsIgnored` falls to 0 and the asset carries a tag nothing
 *    created.
 *  - **A model is a caller.** Junk, over-long text and a throwing `fn` are each
 *    *recorded* — `describe_error` set, `described_at` set — rather than thrown,
 *    because a batch of ten must not stop on the one that rate-limited.
 *
 * D1 and R2 state is isolated per *file*, not per test, so ids are prefixed
 * `ds` and every test resets what it touches.
 */

/* --------------------------------------------------------------- schema --- */

const pageRoot = defineBlock({
  name: 'dsPage',
  label: 'Page',
  summary: 'title',
  fields: { title: text(), hero: asset() },
  render: () => null,
})

const types: DocumentType[] = [
  { name: 'dsPageType', label: 'Page', kind: 'page', root: 'dsPage', default: true },
]

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

function makeFolio(describeConfig?: FolioDescribe<Cloudflare.Env>) {
  return createFolio<Cloudflare.Env>({
    blocks: [pageRoot],
    types,
    bindings,
    basePath: '/folio',
    assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
    auth: 'open',
    route: (p) => (p ? `/${p}` : '/'),
    ...(describeConfig ? { describe: describeConfig } : {}),
  })
}

const ORIGIN = 'https://example.com'

/* ------------------------------------------------------------- fixtures --- */

let minted = 0

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('delete from asset_taggings'),
    env.DB.prepare('delete from asset_tags'),
    env.DB.prepare('delete from assets'),
    env.DB.prepare('delete from stories'),
  ])
}

/** One library row plus its object, so `bytes()` has something real to read. */
async function seedAsset(
  opts: { filename?: string; contentType?: string; alt?: string; body?: string } = {},
): Promise<string> {
  minted += 1
  const id = `ast_ds${String(minted).padStart(8, '0')}`
  const filename = opts.filename ?? 'shoot.png'
  const key = `${id}-${filename}`
  const body = opts.body ?? 'PNGBYTES'
  await env.MEDIA.put(key, body)
  await env.DB.prepare(
    `insert into assets (id, key, filename, content_type, size, width, height, alt, created_at)
     values (?, ?, ?, ?, ?, 1200, 800, ?, ?)`,
  )
    .bind(
      id,
      key,
      filename,
      opts.contentType ?? 'image/png',
      body.length,
      opts.alt ?? '',
      Date.now(),
    )
    .run()
  return id
}

/** Deps around a stub, with no `images` binding — the bare `wrangler dev` shape
 * this test environment actually has (`test/workers/wrangler.jsonc` binds none). */
function depsFor(
  fn: (input: DescribeInput, env: unknown) => Promise<DescribeResult>,
  images?: ImagesBinding,
): DescribeDeps {
  const describe = validateDescribe<unknown>({ fn })
  if (!describe) throw new Error('unreachable: a config was passed')
  return {
    db: env.DB,
    media: env.MEDIA,
    images,
    assetBase: `${ORIGIN}/folio/asset`,
    describe,
    env: {},
  }
}

/** The stored row, straight from D1, so an assertion reads the columns rather
 * than whatever the outcome claims about them. */
async function stored(id: string) {
  const row = await assetById(env.DB, id)
  if (!row) throw new Error(`no such asset ${id}`)
  return row
}

beforeEach(reset)

/* --------------------------------------------------------- construction --- */

describe('config validation', () => {
  it('defaults concurrency and onUpload', () => {
    const resolved = validateDescribe<unknown>({ fn: async () => ({}) })
    expect(resolved?.concurrency).toBe(DEFAULT_DESCRIBE_CONCURRENCY)
    expect(resolved?.onUpload).toBe(true)
  })

  it('is null for a host that configured none', () => {
    expect(validateDescribe(undefined)).toBeNull()
  })

  it('takes onUpload false at its word', () => {
    expect(validateDescribe<unknown>({ fn: async () => ({}), onUpload: false })?.onUpload).toBe(
      false,
    )
  })

  it('refuses an unknown key, a non-function fn, and a concurrency out of range', () => {
    const fn = async () => ({})
    expect(() =>
      validateDescribe({ fn, onUploaded: true } as unknown as FolioDescribe<unknown>),
    ).toThrow(/unknown `describe` key "onUploaded"/)
    expect(() =>
      validateDescribe({ fn: 'anthropic' } as unknown as FolioDescribe<unknown>),
    ).toThrow(/`describe.fn` must be a function/)
    for (const concurrency of [0, 9, 1.5, Number.NaN]) {
      expect(() => validateDescribe<unknown>({ fn, concurrency })).toThrow(/`describe.concurrency`/)
    }
    expect(validateDescribe<unknown>({ fn, concurrency: 8 })?.concurrency).toBe(8)
  })

  /**
   * The timing is the claim, not the message: `validateGate`'s reason applies
   * here with one extra turn of the screw, because the request that would
   * otherwise discover a bad `describe` is a background `waitUntil` after an
   * upload, where nobody is watching and the symptom is alt text that never
   * appears.
   */
  it('throws at construction rather than on the first request', () => {
    expect(() =>
      makeFolio({ fn: async () => ({}), concurrency: 40 } as FolioDescribe<Cloudflare.Env>),
    ).toThrow(/`describe.concurrency`/)
  })
})

/* ---------------------------------------------------------------- input --- */

describe('what the host is handed', () => {
  it('sends a transformed URL when images is bound and the original when it is not', async () => {
    const row = await stored(await seedAsset({ filename: 'a b.png' }))
    // Encoded segment by segment, matching `core/resolve.ts`: a space in a key
    // that reached a model API unencoded would truncate the URL.
    expect(describeUrl(`${ORIGIN}/folio/asset`, row, undefined)).toBe(
      `${ORIGIN}/folio/asset/${row.id}-a%20b.png`,
    )
    expect(describeUrl(`${ORIGIN}/folio/asset`, row, {} as ImagesBinding)).toBe(
      `${ORIGIN}/folio/asset/${row.id}-a%20b.png?w=512&f=webp`,
    )
  })

  it('hands over the row, the vocabulary, and bytes it does not read unless asked', async () => {
    await ensureTag(env.DB, 'Headshot')
    const id = await seedAsset({ body: 'REALBYTES' })

    // A bucket that counts its reads. The laziness is the assertion that
    // matters: at `concurrency: 4` against a 20MB ceiling, eagerly reading every
    // one would put 80MB of ArrayBuffer live in one isolate per batch.
    const gets = vi.fn((key: string) => env.MEDIA.get(key))
    const counting = { ...env.MEDIA, get: gets } as unknown as R2Bucket

    const seen: DescribeInput[] = []
    await describeAsset(
      { ...depsFor(async () => ({})), media: counting },
      await stored(id),
      undefined,
    )
    await describeAsset(
      depsFor(async (input) => {
        seen.push(input)
        return {}
      }),
      await stored(id),
    )

    const [input] = seen
    expect(input?.id).toBe(id)
    expect(input?.filename).toBe('shoot.png')
    expect(input?.contentType).toBe('image/png')
    expect(input?.width).toBe(1200)
    expect(input?.height).toBe(800)
    expect(input?.url).toBe(`${ORIGIN}/folio/asset/${id}-shoot.png`)
    expect(input?.tags).toEqual([{ id: expect.any(String), name: 'Headshot' }])
    expect(gets).not.toHaveBeenCalled()

    // Lazy, but real: the host that does call it gets the object.
    const bytes = await input!.bytes()
    expect(new TextDecoder().decode(bytes)).toBe('REALBYTES')
  })
})

/* -------------------------------------------------------- what it stores --- */

describe('describing one asset', () => {
  it('writes the machine columns and stamps described_at', async () => {
    const id = await seedAsset()
    const outcome = await describeAsset(
      depsFor(async () => ({
        alt: 'A cyclist by a red brick wall',
        description: 'A street scene',
      })),
      await stored(id),
    )

    expect(outcome.skipped).toBe(false)
    expect(outcome.error).toBeNull()
    const row = await stored(id)
    expect(row.altAuto).toBe('A cyclist by a red brick wall')
    expect(row.descriptionAuto).toBe('A street scene')
    expect(row.describedAt).toBeGreaterThan(0)
    expect(row.describeError).toBeNull()
  })

  /**
   * The acceptance criterion, in full: an editor's text is never clobbered, the
   * machine text lands beside it, `toAssetValue` answers the editor's, and the
   * published document does not move by a byte.
   */
  it('cannot clobber a human, and cannot touch a published page', async () => {
    const id = await seedAsset({ alt: 'Ama outside the studio, Accra' })
    const row = await stored(id)

    const doc: Doc = {
      root: 'd0',
      bloks: {
        d0: {
          uid: 'd0',
          type: 'dsPage',
          parent: null,
          slot: null,
          order: 'a0',
          data: {
            title: 'Team',
            hero: {
              key: row.key,
              filename: row.filename,
              contentType: 'image/png',
              size: 8,
              alt: 'Ama outside the studio, Accra',
            },
          },
        },
      },
    }
    const published = JSON.stringify(doc)
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at,
                            published_doc, published_at)
       values ('sty_ds1', 'dsPageType', null, 'team', 'team', 'a0', 'Team', ?, ?, ?)`,
    )
      .bind(Date.now(), published, Date.now())
      .run()

    await describeAsset(
      depsFor(async () => ({ alt: 'A woman standing outside a building' })),
      row,
    )

    const after = await stored(id)
    expect(after.alt).toBe('Ama outside the studio, Accra')
    expect(after.altAuto).toBe('A woman standing outside a building')
    expect(toAssetValue(after).alt).toBe('Ama outside the studio, Accra')

    const story = await env.DB.prepare('select published_doc from stories where id = ?')
      .bind('sty_ds1')
      .first<{ published_doc: string }>()
    expect(story?.published_doc).toBe(published)
  })

  it('falls back to the machine text once an editor clears their own', async () => {
    const id = await seedAsset({ alt: 'Typed by hand' })
    await describeAsset(
      depsFor(async () => ({ alt: 'Written by a model' })),
      await stored(id),
    )
    expect(toAssetValue(await stored(id)).alt).toBe('Typed by hand')

    await env.DB.prepare("update assets set alt = '' where id = ?").bind(id).run()
    expect(toAssetValue(await stored(id)).alt).toBe('Written by a model')
  })

  it('leaves a column the model said nothing about alone', async () => {
    const id = await seedAsset()
    await describeAsset(
      depsFor(async () => ({ alt: 'First pass', description: 'A description' })),
      await stored(id),
    )
    // A re-run answering only a description must not wipe the alt text the
    // first one produced — `AssetPatchBody`'s "absent is not empty", applied to
    // a caller that happens to be a model.
    await describeAsset(
      depsFor(async () => ({ description: 'Second pass' })),
      await stored(id),
    )

    const row = await stored(id)
    expect(row.altAuto).toBe('First pass')
    expect(row.descriptionAuto).toBe('Second pass')
  })
})

/* ----------------------------------------------------------------- tags --- */

describe('the vocabulary constraint', () => {
  it('matches on the slug, so a display spelling still finds the tag', () => {
    const vocabulary = [{ id: 'tag_1', name: 'Head Shots', slug: 'headshots' }]
    expect(matchTags(['  HEAD  SHOTS '], vocabulary)).toEqual({
      tags: vocabulary,
      ignored: 0,
    })
  })

  it('counts a drop once however many ways the model spelled it', () => {
    const vocabulary = [{ id: 'tag_1', name: 'Headshot', slug: 'headshot' }]
    // Two spellings of one real tag are one match, not a match plus a drop;
    // two spellings of one absent tag are one drop, not two.
    expect(matchTags(['Headshot', 'headshot', 'product-shot', 'product-shot'], vocabulary)).toEqual(
      {
        tags: vocabulary,
        ignored: 1,
      },
    )
  })

  it('treats a tag list that did not come back as a list as nothing at all', () => {
    expect(matchTags('headshot' as unknown as string[], [])).toEqual({ tags: [], ignored: 0 })
    expect(matchTags(undefined, [])).toEqual({ tags: [], ignored: 0 })
    // An entry that is not a string, or is punctuation only, is a *drop*: the
    // model answered and it was not usable.
    expect(matchTags([42 as unknown as string, '  '], [])).toEqual({ tags: [], ignored: 2 })
  })

  /**
   * Decision 11's acceptance criterion, and the reason the enrichment and the
   * vocabulary live in one spec. Broken deliberately once — returning the
   * unmatched slug as if it had matched — this fails on `tagsIgnored` and on the
   * tag list together.
   */
  it('the model may not invent a tag', async () => {
    const { tag: headshot } = await ensureTag(env.DB, 'headshot')
    await ensureTag(env.DB, 'bw')
    const id = await seedAsset()

    const outcome = await describeAsset(
      depsFor(async () => ({ tags: ['headshot', 'product-shot'] })),
      await stored(id),
    )

    expect(outcome.tagged).toEqual(['headshot'])
    expect(outcome.tagsIgnored).toBe(1)

    const carried = (await tagsForAssets(env.DB, [id])).get(id) ?? []
    expect(carried.map((t) => t.slug)).toEqual(['headshot'])
    expect(carried[0]?.id).toBe(headshot.id)

    // Nothing was created: the vocabulary is still the two an editor curated.
    const all = await env.DB.prepare('select slug from asset_tags order by slug').all<{
      slug: string
    }>()
    expect(all.results.map((r) => r.slug)).toEqual(['bw', 'headshot'])
  })

  it('adds without replacing, so a tag an editor applied by hand survives', async () => {
    const { tag: byHand } = await ensureTag(env.DB, 'approved')
    const { tag: model } = await ensureTag(env.DB, 'headshot')
    const id = await seedAsset()
    await env.DB.prepare('insert into asset_taggings (asset_id, tag_id) values (?, ?)')
      .bind(id, byHand.id)
      .run()

    await describeAsset(
      depsFor(async () => ({ tags: ['headshot'] })),
      await stored(id),
    )

    const carried = (await tagsForAssets(env.DB, [id])).get(id) ?? []
    expect(carried.map((t) => t.id).sort()).toEqual([byHand.id, model.id].sort())
  })

  it('is a success when the asset already carries the tag', async () => {
    const { tag } = await ensureTag(env.DB, 'headshot')
    const id = await seedAsset()
    await describeAsset(
      depsFor(async () => ({ tags: ['headshot'] })),
      await stored(id),
    )
    const outcome = await describeAsset(
      depsFor(async () => ({ tags: ['Headshot'] })),
      await stored(id),
    )

    expect(outcome.error).toBeNull()
    expect(outcome.tagged).toEqual(['headshot'])
    const carried = (await tagsForAssets(env.DB, [id])).get(id) ?? []
    expect(carried.map((t) => t.id)).toEqual([tag.id])
  })
})

/* ------------------------------------------------------- clamp and bound --- */

describe('a model is a caller', () => {
  it('truncates over-long text rather than discarding the whole answer', async () => {
    const id = await seedAsset()
    await describeAsset(
      depsFor(async () => ({ alt: 'a'.repeat(4000), description: 'b'.repeat(4000) })),
      await stored(id),
    )

    const row = await stored(id)
    expect(row.altAuto).toHaveLength(500)
    expect(row.descriptionAuto).toHaveLength(MAX_DESCRIBE_DESCRIPTION)
    // The alt text still landed, which is the point of clamping rather than
    // refusing: one over-long field must not throw away a paid-for call.
    expect(row.describeError).toBeNull()
  })

  it('ignores a field that is not a string and strips what a stored string may not hold', async () => {
    const id = await seedAsset()
    await describeAsset(
      depsFor(async () => ({
        alt: { text: 'nope' } as unknown as string,
        description: '  A caption\u0000 with a \u202e bidi override  ',
      })),
      await stored(id),
    )

    const row = await stored(id)
    // A non-string is "the model said nothing about this field", not an error.
    expect(row.altAuto).toBe('')
    // The characters `bounded()` refuses a person for are stripped rather than
    // fatal, and the result is trimmed: there is nobody to show a message to.
    expect(row.descriptionAuto).toBe('A caption with a  bidi override')
    expect(row.describedAt).toBeGreaterThan(0)
  })

  it('records a throwing fn instead of propagating it', async () => {
    const id = await seedAsset()
    const outcome = await describeAsset(
      depsFor(async () => {
        throw new Error('429 rate limited by the provider')
      }),
      await stored(id),
    )

    expect(outcome.error).toBe('429 rate limited by the provider')
    const row = await stored(id)
    expect(row.describeError).toBe('429 rate limited by the provider')
    // Stamped anyway: "tried and failed" has to be distinguishable from "never
    // tried", or a backlog walk offers the same broken asset forever.
    expect(row.describedAt).toBeGreaterThan(0)
    expect(row.altAuto).toBe('')
  })

  it('records junk that did not throw', async () => {
    const id = await seedAsset()
    const outcome = await describeAsset(
      depsFor(async () => null as unknown as DescribeResult),
      await stored(id),
    )
    expect(outcome.error).toMatch(/did not return a result object/)
    expect((await stored(id)).describeError).toMatch(/did not return a result object/)
  })

  it('skips a non-image without calling fn, and still stamps it', async () => {
    const id = await seedAsset({ filename: 'deck.pdf', contentType: 'application/pdf' })
    const fn = vi.fn(async () => ({ alt: 'should never be written' }))

    const outcome = await describeAsset(depsFor(fn), await stored(id))

    expect(fn).not.toHaveBeenCalled()
    expect(outcome.skipped).toBe(true)
    const row = await stored(id)
    expect(row.altAuto).toBe('')
    expect(row.describedAt).toBeGreaterThan(0)
    expect(row.describeError).toBeNull()
  })
})

/* ---------------------------------------------------------------- route --- */

describe('POST {base}/api/assets/:id/describe', () => {
  const post = (folio: ReturnType<typeof makeFolio>, path: string) =>
    folio.handle(new Request(`${ORIGIN}${path}`, { method: 'POST' }), env, createExecutionContext())

  it('is a legible refusal with nothing configured', async () => {
    const id = await seedAsset()
    const res = await post(makeFolio(), `/folio/api/assets/${id}/describe`)
    expect(res?.status).toBe(501)
    const body = (await res!.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('unsupported')
    // Names the config key, so the fix is in the message.
    expect(body.error.message).toMatch(/describe/)
  })

  it('describes one asset and reports what it ignored', async () => {
    await ensureTag(env.DB, 'headshot')
    const id = await seedAsset()
    const folio = makeFolio({
      async fn(input) {
        // The URL is absolute and points back at this deployment's own asset
        // route, which is the half a host cannot supply for itself.
        expect(input.url.startsWith(`${ORIGIN}/folio/asset/`)).toBe(true)
        return { alt: 'A portrait', tags: ['headshot', 'product-shot'] }
      },
    })

    const res = await post(folio, `/folio/api/assets/${id}/describe`)
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as {
      asset: { alt: string; altAuto: string; tags: { slug: string }[] }
      tagsIgnored: number
      tagged: string[]
      error: string | null
    }
    expect(body.asset.altAuto).toBe('A portrait')
    expect(body.asset.alt).toBe('')
    expect(body.asset.tags.map((t) => t.slug)).toEqual(['headshot'])
    expect(body.tagsIgnored).toBe(1)
    expect(body.error).toBeNull()
  })

  it('answers 200 with the recorded failure rather than 500', async () => {
    const id = await seedAsset()
    const folio = makeFolio({
      async fn() {
        throw new Error('the provider timed out')
      },
    })
    const res = await post(folio, `/folio/api/assets/${id}/describe`)
    expect(res?.status).toBe(200)
    expect((await res!.json()) as { error: string }).toMatchObject({
      error: 'the provider timed out',
    })
  })

  it('404s an unknown id', async () => {
    const folio = makeFolio({ fn: async () => ({}) })
    const res = await post(folio, '/folio/api/assets/ast_ds99999999/describe')
    expect(res?.status).toBe(404)
  })
})
