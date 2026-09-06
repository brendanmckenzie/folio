import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineBlock, asset, text } from '../../src/core'
import type { AssetFilter } from '../../src/core/assets'
import type { BulkSelection } from '../../src/core/bulk'
import { wasRefused } from '../../src/core/bulk'
import type { Doc } from '../../src/core/doc'
import type { DocumentType } from '../../src/core/schema'
import { createFolio, magicLink } from '../../src/server'
import type {
  AuthConfig,
  DescribeInput,
  DescribeResult,
  FolioBindings,
  FolioDescribe,
  Role,
} from '../../src/server'
import { ensureTag, tagsForAssets } from '../../src/server/asset-tags'
import { assetById, countAssets, toAssetValue } from '../../src/server/assets'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import { createSession } from '../../src/server/auth/session'
import { createUser } from '../../src/server/auth/users'
import type { FolioDb } from '../../src/server/db'
import {
  DEFAULT_DESCRIBE_CONCURRENCY,
  type DescribeDeps,
  type DescribeRunOutcome,
  type DescribeRunReport,
  describeAsset,
  describeOnUpload,
  describeUrl,
  MAX_DESCRIBE_DESCRIPTION,
  matchTags,
  runDescribe,
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

/* ------------------------------------------------------------------- run --- */

/**
 * The batched run (phase 7, decision 10): a bounded batch per call, the cursor
 * in the caller's hand between them, **no job record and nothing to reconcile**
 * if the tab closes.
 *
 * Three of these tests are about money rather than correctness, which is what
 * makes them worth more than the arithmetic ones:
 *
 *  - **`dryRun` calls `fn` zero times.** The question a dry run is asked here is
 *    "how many, and what will this cost"; a dry run that found out by calling
 *    the model would be answering it by spending it. The assertion is the *call
 *    count*, not the absence of writes — a run that called `fn` and then threw
 *    the answer away would pass the second and fail the first.
 *  - **The vocabulary is read once per call.** Once per asset is one query per
 *    tag list per image, which over a run of forty thousand is forty thousand
 *    reads of a table that cannot change while the batch is in flight.
 *  - **`undescribed` reaches the composer.** The clause and
 *    `CAPTURED_ASSET_FILTER`'s key are two halves of one thing: with the key
 *    stripped, a backlog run is a run over the whole library, silently, every
 *    time it is pressed.
 */

/** Deps against a stub, over a db a test may have wrapped. */
function runDeps(
  fn: (input: DescribeInput, env: unknown) => Promise<DescribeResult>,
  over: { db?: FolioDb; concurrency?: number } = {},
): DescribeDeps {
  const describe = validateDescribe<unknown>({
    fn,
    ...(over.concurrency === undefined ? {} : { concurrency: over.concurrency }),
  })
  if (!describe) throw new Error('unreachable: a config was passed')
  return {
    db: over.db ?? env.DB,
    media: env.MEDIA,
    assetBase: `${ORIGIN}/folio/asset`,
    describe,
    env: {},
  }
}

/** A report, or a thrown assertion — the refusal branch is tested where it is
 * expected rather than absorbed everywhere. */
function reported(outcome: DescribeRunOutcome): DescribeRunReport {
  if (wasRefused(outcome)) throw new Error(`refused: expected ${outcome.expected}`)
  return outcome
}

/**
 * Drives a run to completion the way the run panel does — **loop on
 * `continueFrom`, never on `seen < total`** — and sums what the batches said.
 */
async function drive(
  deps: DescribeDeps,
  selection: BulkSelection<AssetFilter>,
  opts: { batch?: number; dryRun?: boolean } = {},
): Promise<{
  calls: number
  done: number
  skipped: number
  tagsIgnored: number
  failed: string[]
}> {
  let continueFrom: string | null = null
  const totals = { calls: 0, done: 0, skipped: 0, tagsIgnored: 0, failed: [] as string[] }
  for (;;) {
    const report = reported(
      await runDescribe(deps, selection, { ...opts, ...(continueFrom ? { continueFrom } : {}) }),
    )
    totals.calls++
    totals.done += report.done
    totals.skipped += report.skipped
    totals.tagsIgnored += report.tagsIgnored
    totals.failed.push(...report.failed.map((one) => one.message))
    if (report.continueFrom === null || report.continueFrom === continueFrom) {
      expect(report.seen).toBe(report.total)
      return totals
    }
    continueFrom = report.continueFrom
    // A wedged cursor is a hang, not a failure, so the loop is bounded.
    expect(totals.calls).toBeLessThan(50)
  }
}

describe('runDescribe', () => {
  it('walks a selection in batches and stops on a null cursor', async () => {
    const ids: string[] = []
    for (let i = 0; i < 7; i++) ids.push(await seedAsset({ filename: `shot-${i}.png` }))
    const fn = vi.fn(async () => ({ alt: 'A photograph' }))

    const totals = await drive(runDeps(fn), { ids }, { batch: 3 })

    // Seven files, three at a time: 3 + 3 + 1, and the fourth call is the one
    // that answers a null cursor rather than a fourth batch of nothing.
    expect(totals.calls).toBe(3)
    expect(totals.done).toBe(7)
    expect(fn).toHaveBeenCalledTimes(7)
    for (const id of ids) expect((await stored(id)).altAuto).toBe('A photograph')
  })

  it('walks a captured filter, and the count guard refuses a set that moved', async () => {
    for (let i = 0; i < 4; i++) await seedAsset({ filename: `filtered-${i}.png` })
    const filter: AssetFilter = { q: 'filtered' }
    const expected = await countAssets(env.DB, filter)
    expect(expected).toBe(4)

    // The number somebody read, then three more files arrive underneath them.
    await seedAsset({ filename: 'filtered-late.png' })
    const refusal = await runDescribe(
      runDeps(async () => ({})),
      {
        all: true,
        filter,
        expected,
      },
    )
    expect(wasRefused(refusal) && refusal).toMatchObject({
      refused: 'count',
      expected: 4,
      actual: 5,
    })

    // A door, not a wall: re-confirming at the new count runs.
    const fn = vi.fn(async () => ({ alt: 'Described' }))
    const totals = await drive(runDeps(fn), { all: true, filter, expected: 5 }, { batch: 2 })
    expect(totals.done).toBe(5)
    expect(fn).toHaveBeenCalledTimes(5)
  })

  it('honours the ticked-off half of a select-all', async () => {
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(await seedAsset({ filename: `excl-${i}.png` }))
    const filter: AssetFilter = { q: 'excl-' }
    const fn = vi.fn(async () => ({ alt: 'Described' }))

    const totals = await drive(
      runDeps(fn),
      { all: true, filter, expected: 4, exclude: [ids[0] as string, ids[3] as string] },
      { batch: 4 },
    )

    expect(totals.done).toBe(2)
    expect(fn).toHaveBeenCalledTimes(2)
    expect((await stored(ids[0] as string)).describedAt).toBeNull()
    expect((await stored(ids[1] as string)).altAuto).toBe('Described')
  })

  /**
   * The expensive assertion, and it is on the **call count**: a dry run that
   * asked the model and discarded the answer would leave the columns exactly as
   * clean as this one does.
   */
  it('costs nothing on a dry run and still says how many and how many are free', async () => {
    const ids = [
      await seedAsset({ filename: 'a.png' }),
      await seedAsset({ filename: 'b.png' }),
      await seedAsset({ filename: 'deck.pdf', contentType: 'application/pdf' }),
    ]
    const fn = vi.fn(async () => ({ alt: 'Never written' }))

    const report = reported(await runDescribe(runDeps(fn), { ids }, { dryRun: true }))

    expect(fn).toHaveBeenCalledTimes(0)
    expect(report.dryRun).toBe(true)
    expect(report.total).toBe(3)
    expect(report.done).toBe(3)
    // The PDF is the one that would cost nothing, and saying so is the whole
    // point of counting it separately from `done`.
    expect(report.skipped).toBe(1)
    for (const id of ids) {
      const row = await stored(id)
      expect([row.altAuto, row.describedAt]).toEqual(['', null])
    }
  })

  it('runs at most `concurrency` model calls at once', async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(await seedAsset({ filename: `c-${i}.png` }))

    const peakAt = async (concurrency: number) => {
      let live = 0
      let peak = 0
      const deps = runDeps(
        async () => {
          live++
          peak = Math.max(peak, live)
          await new Promise((resolve) => setTimeout(resolve, 2))
          live--
          return {}
        },
        { concurrency },
      )
      await drive(deps, { ids }, { batch: 6 })
      return peak
    }

    // Exactly, not "at most": a pool that never fills is a run four times
    // slower than the host asked for, and a ceiling that leaks is a bill.
    expect(await peakAt(2)).toBe(2)
    expect(await peakAt(1)).toBe(1)
  })

  it('reads the tag vocabulary once per call, not once per asset', async () => {
    await ensureTag(env.DB, 'headshot')
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await seedAsset({ filename: `v-${i}.png` }))

    let reads = 0
    const db = new Proxy(env.DB, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver)
        if (prop !== 'prepare') return value
        return (...args: unknown[]) => {
          // The vocabulary read, and nothing else: `asset_taggings` is a
          // different table and the insert below must not be counted as one.
          if (typeof args[0] === 'string' && /from asset_tags\b/.test(args[0])) reads++
          return (value as (...a: unknown[]) => D1PreparedStatement).apply(t, args)
        }
      },
    }) as unknown as FolioDb

    const report = reported(
      await runDescribe(
        runDeps(async () => ({ tags: ['headshot'] }), { db }),
        { ids },
        { batch: 5 },
      ),
    )

    expect(report.done).toBe(5)
    expect(reads).toBe(1)
  })

  it('finishes the batch when one file fails, and names it', async () => {
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(await seedAsset({ filename: `f-${i}.png` }))
    const fn = vi.fn(async (input: DescribeInput) => {
      if (input.filename === 'f-1.png') throw new Error('429 rate limited by the provider')
      return { alt: 'Described' }
    })

    const totals = await drive(runDeps(fn), { ids }, { batch: 4 })

    expect(fn).toHaveBeenCalledTimes(4)
    // Three described, one named — not three described and one silently
    // counted as a success, which is what `done` would say if a recorded model
    // failure were not lifted into `failed`.
    expect(totals.done).toBe(3)
    expect(totals.failed).toEqual(['429 rate limited by the provider'])
    expect((await stored(ids[3] as string)).altAuto).toBe('Described')
    const failed = await stored(ids[1] as string)
    expect(failed.describeError).toBe('429 rate limited by the provider')
    // Stamped anyway, so the backlog does not offer it forever.
    expect(failed.describedAt).toBeGreaterThan(0)
  })

  it('reports an id with no row behind it rather than stopping', async () => {
    const id = await seedAsset()
    const totals = await drive(
      runDeps(async () => ({ alt: 'Described' })),
      {
        ids: ['ast_ds77777777', id],
      },
    )
    expect(totals.done).toBe(1)
    expect(totals.failed).toEqual(['No such file'])
  })

  it('sums tagsIgnored across a batch, so a prompt proposing a missing tag is visible', async () => {
    await ensureTag(env.DB, 'headshot')
    const ids = [await seedAsset({ filename: 't-0.png' }), await seedAsset({ filename: 't-1.png' })]

    const totals = await drive(
      runDeps(async () => ({ tags: ['headshot', 'product-shot', 'lifestyle'] })),
      { ids },
      { batch: 1 },
    )

    expect(totals.done).toBe(2)
    // Two files, two drops each, and the count survives being summed across two
    // separate calls of the run.
    expect(totals.calls).toBe(2)
    expect(totals.tagsIgnored).toBe(4)
  })

  it('walks only the backlog when the captured filter says undescribed', async () => {
    const done = await seedAsset({ filename: 'u-done.png' })
    const waiting = await seedAsset({ filename: 'u-waiting.png' })
    await env.DB.prepare('update assets set described_at = ? where id = ?')
      .bind(Date.now(), done)
      .run()

    const filter: AssetFilter = { undescribed: true }
    const expected = await countAssets(env.DB, filter)
    expect(expected).toBe(1)

    const fn = vi.fn(async () => ({ alt: 'From the backlog' }))
    const totals = await drive(runDeps(fn), { all: true, filter, expected })

    expect(totals.done).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect((await stored(waiting)).altAuto).toBe('From the backlog')
    // A failed attempt is *not* in the backlog — `described_at` is stamped on
    // that path too — so it is not swept again by the default run.
    expect((await stored(done)).altAuto).toBe('')
  })
})

/* ------------------------------------------------- POST /assets/describe --- */

describe('POST {base}/api/assets/describe', () => {
  const run = (folio: ReturnType<typeof makeFolio>, body: unknown) =>
    folio.handle(
      new Request(`${ORIGIN}/folio/api/assets/describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      createExecutionContext(),
    )

  it('is a legible refusal with nothing configured', async () => {
    const res = await run(makeFolio(), { selection: { ids: [await seedAsset()] } })
    expect(res?.status).toBe(501)
    const body = (await res!.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('unsupported')
    expect(body.error.message).toMatch(/describe/)
  })

  it('answers a report, and a dry run that spent nothing', async () => {
    const ids = [await seedAsset({ filename: 'r-0.png' }), await seedAsset({ filename: 'r-1.png' })]
    const fn = vi.fn(async () => ({ alt: 'A photograph' }))
    const folio = makeFolio({ fn })

    const dry = await run(folio, { selection: { ids }, dryRun: true })
    expect(dry?.status).toBe(200)
    expect((await dry!.json()) as DescribeRunReport).toMatchObject({
      action: 'describe',
      dryRun: true,
      total: 2,
      done: 2,
      continueFrom: null,
    })
    expect(fn).toHaveBeenCalledTimes(0)

    const real = await run(folio, { selection: { ids } })
    expect(((await real!.json()) as DescribeRunReport).done).toBe(2)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('keeps `undescribed` through the validator rather than stripping it', async () => {
    const described = await seedAsset({ filename: 'v-done.png' })
    await seedAsset({ filename: 'v-waiting.png' })
    await env.DB.prepare('update assets set described_at = ? where id = ?')
      .bind(Date.now(), described)
      .run()

    const fn = vi.fn(async () => ({ alt: 'Backlog only' }))
    const res = await run(makeFolio({ fn }), {
      selection: { all: true, filter: { undescribed: true }, expected: 1 },
    })

    // A stripped key would make this a run over both files: the count guard
    // would refuse it (2 !== 1), and if the number happened to agree it would
    // describe the one an editor already paid for.
    expect(res?.status).toBe(200)
    expect(((await res!.json()) as DescribeRunReport).done).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect((await stored(described)).altAuto).toBe('')
  })

  it('answers 409 with the new count when the set moved', async () => {
    await seedAsset({ filename: 'moved-0.png' })
    await seedAsset({ filename: 'moved-1.png' })
    const res = await run(makeFolio({ fn: async () => ({}) }), {
      selection: { all: true, filter: { q: 'moved-' }, expected: 1 },
    })
    expect(res?.status).toBe(409)
    expect((await res!.json()) as { refused: string; actual: number }).toMatchObject({
      refused: 'count',
      expected: 1,
      actual: 2,
    })
  })

  it('refuses a batch larger than a run may ask for', async () => {
    const res = await run(makeFolio({ fn: async () => ({}) }), {
      selection: { ids: [await seedAsset()] },
      batch: 200,
    })
    expect(res?.status).toBe(400)
  })

  it('reports whether it is configured, and whether images will keep it cheap', async () => {
    const get = (folio: ReturnType<typeof makeFolio>) =>
      folio.handle(
        new Request(`${ORIGIN}/folio/api/assets/describe`),
        env,
        createExecutionContext(),
      )

    // No config: the admin draws no control at all, rather than one that 501s
    // when it is pressed.
    expect(await (await get(makeFolio()))!.json()).toEqual({ configured: false })

    const body = (await (await get(
      makeFolio({ fn: async () => ({}), onUpload: false }),
    ))!.json()) as {
      configured: boolean
      onUpload: boolean
      images: boolean
    }
    expect(body.configured).toBe(true)
    expect(body.onUpload).toBe(false)
    // This test environment binds no Images, which is the bare `wrangler dev`
    // shape: originals are described and the run panel says it costs more.
    expect(body.images).toBe(false)
  })
})

/* -------------------------------------------------------------- role gate --- */

/**
 * **Decision 16, which is the one gate in this feature chosen on consequence
 * rather than on symmetry**: describing one asset is `ASSETS`, like the patch it
 * sits beside, and the *run* is `ADMIN` because it is the only route in Folio
 * that spends the host's money against a third party over a set that can be all
 * forty thousand. The count guard bounds the set; it does not bound the bill.
 *
 * Its own `createFolio` with a provider configured, for `bulk.test.ts`'s reason:
 * the folio built above runs `auth: 'open'`, where there is nothing to refuse.
 */
describe('the run is ADMIN and the single asset is ASSETS', () => {
  const auth: AuthConfig<Cloudflare.Env> = {
    providers: [magicLink<Cloudflare.Env>({ send: () => {} })],
  }

  const gated = createFolio<Cloudflare.Env>({
    blocks: [pageRoot],
    types,
    bindings,
    basePath: '/folio',
    assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
    auth,
    route: (p) => (p ? `/${p}` : '/'),
    describe: { fn: async () => ({ alt: 'A photograph' }) },
  })

  let people = 0
  async function cookieFor(role: Role): Promise<string> {
    people += 1
    const user = await createUser(env.DB, {
      email: `${role}-${people}@describe.test`,
      name: role,
      role,
    })
    const session = await createSession(env.DB, user.id)
    return `${SECURE_COOKIE}=${session.token}`
  }

  const call = (path: string, cookie: string, body?: unknown) =>
    gated.handle(
      new Request(`${ORIGIN}/folio/api${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      createExecutionContext(),
    )

  it('lets an editor describe one file and refuses them the run', async () => {
    const cookie = await cookieFor('editor')
    const id = await seedAsset()
    expect((await call(`/assets/${id}/describe`, cookie))?.status).toBe(200)
    expect((await call('/assets/describe', cookie, { selection: { ids: [id] } }))?.status).toBe(403)
  })

  it('lets an admin do both', async () => {
    const cookie = await cookieFor('admin')
    const id = await seedAsset()
    expect((await call('/assets/describe', cookie, { selection: { ids: [id] } }))?.status).toBe(200)
    expect((await stored(id)).altAuto).toBe('A photograph')
  })

  it('refuses a viewer both', async () => {
    const cookie = await cookieFor('viewer')
    const id = await seedAsset()
    expect((await call(`/assets/${id}/describe`, cookie))?.status).toBe(403)
    expect((await call('/assets/describe', cookie, { selection: { ids: [id] } }))?.status).toBe(403)
  })
})

/* -------------------------------------------------------------- on upload --- */

/** 1×1 transparent PNG — the fixture `assets.test.ts` and `http.test.ts` use.
 * It has to be a real image: `uploadAsset` stores what the bytes say, and a
 * describe skips anything that is not an image before `fn` is reached. */
const PNG_1X1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (ch) => ch.charCodeAt(0),
)

describe('describing a new upload', () => {
  const upload = async (folio: ReturnType<typeof makeFolio>) => {
    const ctx = createExecutionContext()
    const res = await folio.handle(
      new Request(`${ORIGIN}/folio/api/assets?filename=uploaded.png`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: PNG_1X1,
      }),
      env,
      ctx,
    )
    // The background work is what `waitUntil` holds, so a test that did not
    // wait on the context would assert against a describe still in flight.
    await waitOnExecutionContext(ctx)
    return res
  }

  it('describes it in the background without slowing or failing the upload', async () => {
    const fn = vi.fn(async () => ({ alt: 'A tiny transparent square' }))
    const res = await upload(makeFolio({ fn }))

    expect(res?.status).toBe(201)
    const { asset } = (await res!.json()) as { asset: { id: string; altAuto: string } }
    // The response is the row as it was written, *before* the describe: the
    // upload does not wait for a model call and its body cannot claim to.
    expect(asset.altAuto).toBe('')
    expect(fn).toHaveBeenCalledTimes(1)
    expect((await stored(asset.id)).altAuto).toBe('A tiny transparent square')
  })

  it('does not describe it when the host turned onUpload off', async () => {
    const fn = vi.fn(async () => ({ alt: 'Never asked for' }))
    const res = await upload(makeFolio({ fn, onUpload: false }))

    expect(res?.status).toBe(201)
    expect(fn).toHaveBeenCalledTimes(0)
    const { asset } = (await res!.json()) as { asset: { id: string } }
    expect((await stored(asset.id)).describedAt).toBeNull()
  })

  it('does not describe anything at all with no describe configured', async () => {
    const res = await upload(makeFolio())
    expect(res?.status).toBe(201)
    const { asset } = (await res!.json()) as { asset: { id: string } }
    expect((await stored(asset.id)).describedAt).toBeNull()
  })

  it('is a 201 even when the model call fails, and records why', async () => {
    const res = await upload(
      makeFolio({
        async fn() {
          throw new Error('the provider timed out')
        },
      }),
    )

    expect(res?.status).toBe(201)
    const { asset } = (await res!.json()) as { asset: { id: string } }
    expect((await stored(asset.id)).describeError).toBe('the provider timed out')
  })

  /**
   * The half a route test cannot reach: `describeAsset` records a *model*
   * failure, but a D1 or R2 failure it propagates — and by the time this runs
   * the response has gone, the object is in R2 and the row is in D1. A rejected
   * promise handed to `waitUntil` is an unhandled rejection in the host's Worker
   * for an upload that succeeded, so the wrapper has to swallow it.
   */
  it('swallows a platform failure rather than rejecting inside waitUntil', async () => {
    const broken = {
      prepare() {
        throw new Error('D1 is having a day')
      },
      batch: async () => [],
    } as unknown as FolioDb
    const row = await stored(await seedAsset())

    await expect(
      describeOnUpload({ ...runDeps(async () => ({ alt: 'x' })), db: broken }, row),
    ).resolves.toBeUndefined()
  })
})
