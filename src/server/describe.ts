/**
 * The describe seam: machine-written alt text, descriptions and tags
 * (`../../docs/specs/content-model/media-library.md` decisions 8, 9 and 11).
 *
 * **Folio calls a host function and stores what comes back. That is all it
 * does.** It holds no API key, chooses no model, writes no prompt and makes no
 * outbound request of its own — `types.ts`'s `FolioDescribe` argues why, and the
 * short version is that owning the call means owning the retries, the timeout
 * and a vendor list, forever. What this file owns instead is the half a CMS
 * should own: what a model is allowed to say, and where it is allowed to say it.
 *
 * Three rules run through everything below, and each is load-bearing:
 *
 *  - **A human edit always wins.** `alt` is the editor's column and `alt_auto`
 *    is the model's; nothing here writes `alt` or `description`, ever, and
 *    `toAssetValue` (`assets.ts`) reads `alt || altAuto` so the machine text is
 *    a *default* that a typed value silently replaces. That is also what makes a
 *    run over 3,000 images structurally safe: `assets.alt` is copied into a
 *    field value at pick time and the two are independent from then on, so no
 *    published document, no draft and no rendered page changes by a byte
 *    (decision 9). Nothing here purges, republishes or writes a mutation log,
 *    and nothing here should ever start to.
 *  - **The model may only choose tags that already exist** (decision 11), and
 *    **drops are counted, not silent**. An open vocabulary earns a near-synonym
 *    per image — `portrait`, `headshot`, `head-shot`, `person` — and a filter
 *    over that is worse than no filter because it looks like it works.
 *    `tagsIgnored` is what tells a host their prompt keeps proposing a tag
 *    nobody created.
 *  - **A model is a caller.** Everything it answers is clamped, truncated and
 *    type-checked before it is stored (`clampText`, `matchTags`), and a failure
 *    is *recorded* rather than thrown away: `describe_error` holds a bounded
 *    message and `described_at` is set either way, which is what stops a
 *    permanently failing asset being retried forever by a backlog walk.
 */
import { type AssetFilter, type AssetTag, tagSlug } from '../core/assets'
import {
  type BulkFailure,
  type BulkRefusal,
  type BulkReport,
  type BulkSelection,
  type FilterSelection,
  readBulkCursor,
  writeBulkCursor,
} from '../core/bulk'
import { isImageAsset } from '../core/values'
import {
  type AssetRow,
  assetById,
  assetsFor,
  assetsMatching,
  countAssets,
  toAssetValue,
} from './assets'
import { listTags } from './asset-tags'
import { bindChunks, type FolioDb } from './db'
import { FolioError, rethrow } from './errors'
import { clampText, SERVED_CONTENT_TYPES } from './validate'
import type { DescribeInput, DescribeResult, FolioDescribe } from './types'

/** In-flight model calls per batch when a host names none. */
export const DEFAULT_DESCRIBE_CONCURRENCY = 4

/** The range `concurrency` is refused outside. A batch is *N model calls*, not
 * N D1 writes, and a Worker has a wall-clock budget; past eight, a batch is more
 * likely to run out of it than to finish sooner. */
export const MIN_DESCRIBE_CONCURRENCY = 1
export const MAX_DESCRIBE_CONCURRENCY = 8

/** `DescribeResult.alt`, matching `AssetPatchBody.alt`. */
export const MAX_DESCRIBE_ALT = 500
/** `DescribeResult.description`, matching `AssetPatchBody.description`. */
export const MAX_DESCRIBE_DESCRIPTION = 2000

/** How many tags one result may apply. `MAX_ASSET_TAGS`'s fifty, and for its
 * reason: `addAssetTags` chunks its binds, so this bounds what a model can turn
 * into statements rather than the statements themselves. */
export const MAX_DESCRIBE_TAGS = 50

/**
 * How much of the vocabulary a prompt is handed.
 *
 * A cap rather than a page: the tag list rides in a prompt, and a host with
 * 5,000 tags has a taxonomy problem no truncation here would fix. Five hundred
 * is `listTags`' own ceiling and far past what an editor curates by hand.
 */
export const MAX_PROMPT_TAGS = 500

/** How much of a failure is kept. Long enough to name a provider's own error,
 * short enough that a stack trace cannot become the column. */
export const MAX_DESCRIBE_ERROR = 500

/**
 * `FolioConfig.describe`, validated, with the two defaults applied — or null for
 * a host that configured none, which is the case that must stay entirely free.
 *
 * Mirrors `ResolvedGate`: the host's config nested rather than spread, so there
 * is one place its keys live, and widened to `unknown` for `FolioRuntime.auth`'s
 * reason — the only thing an `Env` parameter is ever handed is the same `env`
 * the host's own `bindings` accessor gets.
 */
export interface ResolvedDescribe {
  config: FolioDescribe<unknown>
  /** `config.concurrency`, defaulted. */
  concurrency: number
  /** `config.onUpload`, defaulted to true. */
  onUpload: boolean
}

const KEYS = ['fn', 'onUpload', 'concurrency']

/**
 * Construction-time validation, alongside `validateGate` and `validateHooks` and
 * for their reason: a configuration mistake in a CMS should throw once, before a
 * request is served, rather than becoming a 500 on whichever code path reaches
 * it first — here, a background `waitUntil` after an upload, where nobody is
 * looking and the only symptom is alt text that never appears.
 *
 * Unknown keys are refused, the treatment `hooks` gets: `onUploaded` instead of
 * `onUpload` would otherwise be a silently ignored preference.
 */
export function validateDescribe<Env>(
  describe: FolioDescribe<Env> | undefined,
): ResolvedDescribe | null {
  if (!describe) return null

  for (const key of Object.keys(describe)) {
    if (!KEYS.includes(key)) {
      throw new Error(`folio: unknown \`describe\` key "${key}" (valid: ${KEYS.join(', ')})`)
    }
  }
  if (typeof describe.fn !== 'function') {
    throw new Error('folio: `describe.fn` must be a function — the host makes the model call')
  }
  if (describe.onUpload !== undefined && typeof describe.onUpload !== 'boolean') {
    throw new Error('folio: `describe.onUpload` must be true or false')
  }

  const concurrency = describe.concurrency ?? DEFAULT_DESCRIBE_CONCURRENCY
  if (
    !Number.isInteger(concurrency) ||
    concurrency < MIN_DESCRIBE_CONCURRENCY ||
    concurrency > MAX_DESCRIBE_CONCURRENCY
  ) {
    throw new Error(
      `folio: \`describe.concurrency\` is ${JSON.stringify(describe.concurrency)}; it must be a whole number from ${MIN_DESCRIBE_CONCURRENCY} to ${MAX_DESCRIBE_CONCURRENCY}`,
    )
  }

  return {
    config: describe as FolioDescribe<unknown>,
    concurrency,
    onUpload: describe.onUpload !== false,
  }
}

/**
 * What one describe needs. Two bindings, the resolved config, the host's `env`,
 * and one string.
 *
 * `assetBase` is **absolute** — `https://host/folio/asset` — because
 * `DescribeInput.url` is handed to somebody else's API to fetch, and a
 * root-relative path is not a URL to anyone but a browser that already has the
 * page open. The route builds it from the request's own origin, which is the
 * only place that knows it.
 *
 * `images` is read for its presence and never called: with the binding, the URL
 * carries the transform query the serving route already honours; without it, the
 * original is described and it costs more (`media-library.md`'s edge cases).
 */
export interface DescribeDeps {
  db: FolioDb
  media: R2Bucket
  images?: ImagesBinding | undefined
  assetBase: string
  describe: ResolvedDescribe
  env: unknown
}

/** What one asset's attempt did. Every field is aggregable, because phase 7's
 * batch report is the sum of a batch of these. */
export interface DescribeOutcome {
  /** The row as stored afterwards — machine columns, `describedAt` and
   * `describeError` all as a re-read would find them. */
  row: AssetRow
  /** Skipped without calling `fn`, and therefore without cost: a non-image.
   * `describedAt` is still set, so it leaves the backlog rather than being
   * offered forever. */
  skipped: boolean
  /** Tag slugs the model chose that existed, and are now on the asset. */
  tagged: string[]
  /** Answers that matched no existing slug and were dropped (decision 11). */
  tagsIgnored: number
  /** A bounded failure message, or null. Stored, not thrown. */
  error: string | null
}

/**
 * The vocabulary a prompt is handed, read once.
 *
 * Exported so phase 7's batch reads it **once per run** rather than once per
 * asset: ten assets in a batch is ten identical reads of a table that does not
 * change during the run, and `describeAsset` takes the answer as an optional
 * dependency for exactly that reason.
 */
export async function describeVocabulary(db: FolioDb): Promise<AssetTag[]> {
  const page = await listTags(db, { limit: MAX_PROMPT_TAGS })
  return page.rows
}

/**
 * The transformed URL a model fetches.
 *
 * **512px WebP wherever `images` is bound.** A 20MB original is an order of
 * magnitude more tokens than the thumbnail a model needs to say "a woman cycling
 * past a red brick wall", and the route that produces one already exists,
 * clamped and cached (`assets.ts`'s `serveAsset`). Sending originals would be
 * the default that quietly costs the most.
 *
 * The key is encoded segment by segment, matching `core/resolve.ts`'s
 * `encodeKey`: R2 keys are free-form, and a `?` or a `#` in one truncates the
 * URL it is pasted into.
 */
export function describeUrl(
  assetBase: string,
  row: AssetRow,
  images: ImagesBinding | undefined,
): string {
  const key = row.key.split('/').map(encodeURIComponent).join('/')
  const src = `${assetBase.replace(/\/$/, '')}/${key}`
  return images ? `${src}?w=${DESCRIBE_WIDTH}&f=webp` : src
}

/** One number, so the URL and the rendition `inline()` builds cannot disagree. */
export const DESCRIBE_WIDTH = 512

/**
 * The bytes a provider is sent: a 512px WebP where `images` is bound, the stored
 * original where it is not.
 *
 * **Transformed here, from the R2 stream — never by fetching `describeUrl`.**
 * That was tried and it is the wrong shape twice over. `handbook.md`'s Resizing
 * section already records why the serving route takes the stream directly: a
 * Worker fetching its own asset URL needs an `image-resizing` loop guard, which
 * is the cost `/cdn-cgi/image/` was passed over for. And it fails in a way that
 * hides: a self-fetch that does not come back leaves the *original* as the only
 * thing left to send, so a 13MB photograph goes to the provider — or is refused
 * by it — while every smaller asset in the same run quietly succeeds and nothing
 * says the cheap path stopped working. Observed on `staging.allaboutafrica.au`
 * on 2026-09-07: 87 assets fine, one 12.8MB JPEG refused, the transform behind
 * the very same URL answering a 113kB WebP to `curl` the whole time.
 *
 * The failure policy is `serveAsset`'s, for the same reason: a transform that
 * throws or yields nothing falls back to the original and logs, because a
 * described asset at full cost beats an undescribed one. Both branches report
 * the media type of the bytes they actually produced.
 */
async function renditionOf(
  deps: DescribeDeps,
  row: AssetRow,
): Promise<{ media: string; bytes: ArrayBuffer }> {
  const object = await deps.media.get(row.key)
  if (!object) return { media: row.contentType, bytes: new ArrayBuffer(0) }

  // SVG is deliberately absent from `SERVED_CONTENT_TYPES`: vector, so a resize
  // means nothing, and the Images binding has no business parsing it.
  if (deps.images && SERVED_CONTENT_TYPES.has(row.contentType)) {
    try {
      const result = await deps.images
        .input(object.body)
        .transform({ width: DESCRIBE_WIDTH })
        .output({ format: 'image/webp' })
      const bytes = await result.response().arrayBuffer()
      // An empty result still arrives as a 200 — the same trap `serveAsset`
      // buffers to catch, and here it would be an image with no pixels in it.
      if (bytes.byteLength === 0) throw new Error('Transform produced no output')
      return { media: result.contentType(), bytes }
    } catch (e) {
      // Never silent: indistinguishable otherwise from a library of originals.
      console.error(`folio: describe transform failed for ${row.key}`, e)
    }
  }

  // The original, re-read because a failed transform consumed the body above.
  const original = deps.images ? await deps.media.get(row.key) : object
  return {
    media: row.contentType,
    bytes: (await original?.arrayBuffer()) ?? new ArrayBuffer(0),
  }
}

/**
 * The model's tag answers, matched to the vocabulary — and what it lost.
 *
 * Pure, and the single most important function in this file. Matching is on the
 * **slug**, which is the tag's identity (`asset-tags.ts`), so a model answering
 * `Headshots` finds the tag an editor created as `headshot` while one answering
 * `head-shot` finds nothing and is counted. Everything unmatched is dropped:
 * nothing here creates a tag, and nothing here may ever be allowed to, because a
 * model that can create tags *is* the open vocabulary decision 11 refuses.
 *
 * Duplicates collapse before they are counted, so a result naming
 * `['Headshot', 'headshot']` is one match rather than a match plus a drop, and
 * `['x', 'x']` is one ignored rather than two. A non-string entry, or one that
 * slugifies to nothing, counts as ignored — the model answered something, and it
 * was not usable.
 */
export function matchTags(
  answered: DescribeResult['tags'],
  vocabulary: readonly AssetTag[],
): { tags: AssetTag[]; ignored: number } {
  if (!Array.isArray(answered)) return { tags: [], ignored: 0 }

  const bySlug = new Map(vocabulary.map((tag) => [tag.slug, tag]))
  const matched = new Map<string, AssetTag>()
  const missed = new Set<string>()

  for (const raw of answered) {
    const slug = typeof raw === 'string' ? tagSlug(raw) : ''
    // A non-string, or a string of punctuation: the model answered and it was
    // not usable, which is a drop rather than a silence. Keyed by what it
    // actually said so two spellings of one nonsense answer count once.
    if (slug === '') {
      missed.add(typeof raw === 'string' ? raw : JSON.stringify(raw))
      continue
    }
    const tag = bySlug.get(slug)
    if (tag) matched.set(tag.id, tag)
    else missed.add(slug)
  }

  return { tags: [...matched.values()].slice(0, MAX_DESCRIBE_TAGS), ignored: missed.size }
}

/**
 * Describes one asset: build the input, call the host, store what survives.
 *
 * **The write is one statement over four columns, and none of them is a human's.**
 * A column the model did not answer for is left exactly as it was — the same
 * "absent is not empty" rule `AssetPatchBody` follows — so a re-run that returns
 * only a description does not wipe the alt text a previous run produced.
 *
 * **Tags are added, never replaced** (`asset-bulk.ts`'s `tag` action, not
 * `setAssetTags`). Replacing would let a model delete the tags an editor applied
 * by hand, which is decision 9's rule about `alt` applied to the one other thing
 * a run touches.
 *
 * **A throw is recorded, not propagated.** `fn` is somebody else's HTTP call:
 * it will time out, rate-limit and answer junk, and every one of those has to
 * leave a row that says so rather than a batch that stops. The only thing that
 * escapes this function is a failure of D1 itself.
 */
export async function describeAsset(
  deps: DescribeDeps,
  row: AssetRow,
  vocabulary?: readonly AssetTag[],
): Promise<DescribeOutcome> {
  const { db } = deps
  const now = Date.now()

  // A non-image costs nothing and is skipped before `fn` is reached: there is
  // nothing to look at, and a model asked to describe a PDF invents. It still
  // leaves the backlog, because "tried and there was nothing to do" and "never
  // tried" should not look the same to the walk that offers the next batch.
  if (!isImageAsset(toAssetValue(row))) {
    await stamp(db, row.id, {}, now, null)
    return { row: await reread(db, row), skipped: true, tagged: [], tagsIgnored: 0, error: null }
  }

  const tags = vocabulary ?? (await describeVocabulary(db))
  const input: DescribeInput = {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    width: row.width,
    height: row.height,
    url: describeUrl(deps.assetBase, row, deps.images),
    // Lazy, and R2 is only reached if the host asks. A `null` object — deleted
    // between the row being read and the host calling — is an empty buffer
    // rather than a throw the host has to guard: `fn` is where the failure
    // belongs and it is recorded either way.
    inline: () => renditionOf(deps, row),
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name })),
  }

  let result: DescribeResult
  try {
    result = await deps.describe.config.fn(input, deps.env)
  } catch (e) {
    const message = clampText(e instanceof Error ? e.message : String(e), MAX_DESCRIBE_ERROR)
    const error = message || 'The describe function failed'
    await stamp(db, row.id, {}, now, error)
    return { row: await reread(db, row), skipped: false, tagged: [], tagsIgnored: 0, error }
  }

  // Junk that did not throw. `fn`'s type says `DescribeResult`; a host's own
  // adapter forwarding a provider's JSON straight through does not, and a
  // `null` here would otherwise be a `TypeError` two lines below with a message
  // about property access rather than about the model.
  if (!result || typeof result !== 'object') {
    const error = 'The describe function did not return a result object'
    await stamp(db, row.id, {}, now, error)
    return { row: await reread(db, row), skipped: false, tagged: [], tagsIgnored: 0, error }
  }

  const alt = clampText(result.alt, MAX_DESCRIBE_ALT)
  const description = clampText(result.description, MAX_DESCRIBE_DESCRIPTION)
  const { tags: chosen, ignored } = matchTags(result.tags, tags)

  await stamp(db, row.id, { alt, description }, now, null)
  if (chosen.length > 0) await addAssetTags(db, row.id, chosen)

  return {
    row: await reread(db, row),
    skipped: false,
    tagged: chosen.map((tag) => tag.slug),
    tagsIgnored: ignored,
    error: null,
  }
}

/**
 * The machine columns, `described_at` and `describe_error`, in one statement.
 *
 * **`alt` and `description` are not in this list and must not be added to it.**
 * The whole safety argument of decision 9 is that a run writes only columns no
 * human types into; the moment this statement can reach `alt`, a re-run over a
 * library silently overwrites every caption an editor ever checked.
 */
async function stamp(
  db: FolioDb,
  id: string,
  text: { alt?: string | undefined; description?: string | undefined },
  at: number,
  error: string | null,
): Promise<void> {
  const sets = ['described_at = ?', 'describe_error = ?']
  const binds: unknown[] = [at, error]
  // Absent is *leave it alone*, not empty: a re-run answering only a description
  // must not clear the alt text the previous one produced.
  if (text.alt !== undefined) {
    sets.push('alt_auto = ?')
    binds.push(text.alt)
  }
  if (text.description !== undefined) {
    sets.push('description_auto = ?')
    binds.push(text.description)
  }
  await db
    .prepare(`update assets set ${sets.join(', ')} where id = ?`)
    .bind(...binds, id)
    .run()
}

/**
 * Adds tags without removing any — `insert or ignore`, so an asset already
 * carrying one is a success rather than a constraint failure. The same statement
 * `runAssetBulk`'s `tag` action issues, chunked at two binds a row because the
 * list is bounded by a model's answer rather than by anything Folio counted.
 */
async function addAssetTags(
  db: FolioDb,
  assetId: string,
  tags: readonly AssetTag[],
): Promise<void> {
  await db.batch(
    bindChunks(tags, 2).map((chunk) =>
      db
        .prepare(
          `insert or ignore into asset_taggings (asset_id, tag_id)
             values ${chunk.map(() => '(?, ?)').join(', ')}`,
        )
        .bind(...chunk.flatMap((tag) => [assetId, tag.id])),
    ),
  )
}

/** The row after the write. Falls back to what was passed in only if the asset
 * was deleted mid-describe, which is a real race and not worth a 404 for: the
 * caller asked what happened, and what happened is recorded. */
async function reread(db: FolioDb, row: AssetRow): Promise<AssetRow> {
  return (await assetById(db, row.id)) ?? row
}

/* -------------------------------------------------------------------- run --- */

/**
 * How many assets one call of a run acts on before handing back a cursor.
 *
 * **Deliberately far below `DEFAULT_ASSET_BULK_BATCH`'s 25 and
 * `MAX_BULK_BATCH`'s 200** (decision 10): a batch here is *N calls to somebody
 * else's model API*, not N D1 writes. Ten at `concurrency: 4` is three waves of
 * a call that takes seconds, which is comfortably inside a Worker's wall-clock
 * budget; two hundred is not, and a batch that runs out of time reports nothing
 * at all — the caller cannot even tell how far it got, because the cursor rides
 * on the response.
 */
export const DEFAULT_DESCRIBE_BATCH = 10
export const MAX_DESCRIBE_BATCH = 25

/**
 * What one call of a run did.
 *
 * `BulkReport<'describe'>` plus the two numbers this run has and a bulk write
 * does not. `action` is a literal rather than one of `AssetBulkAction`'s four
 * because this is a fifth thing done to a selection, run by a different runner
 * (see `runDescribe`), and a client reading `report.action` should be able to
 * tell them apart.
 *
 * **`done` counts assets the host's function answered for, and a recorded model
 * failure is in `failed` instead** — `describeAsset` never throws for one, so
 * without this split a batch of ten timeouts would report ten successes. The row
 * still leaves the backlog either way: `described_at` is stamped on the failure
 * path too, which is what stops a permanently failing asset being offered
 * forever.
 */
export interface DescribeRunReport extends BulkReport<'describe'> {
  /** Rows that **cost nothing**: a non-image is skipped before `fn` is reached.
   * Counted in `done` as well, because the run did account for them. */
  skipped: number
  /** Tag answers that matched no existing slug, summed over this call
   * (decision 11). A host whose prompt keeps proposing `product-shot` finds out
   * here rather than by wondering why the filter never has it. */
  tagsIgnored: number
}

export type DescribeRunOutcome = DescribeRunReport | BulkRefusal

export interface DescribeRunOptions {
  /** Rows per call. Defaulted and clamped to `MAX_DESCRIBE_BATCH`, which is
   * much lower than a bulk write's for the reason above. */
  batch?: number
  /** The previous call's `continueFrom`. An opaque `(id, seen)` pair, not an id. */
  continueFrom?: string | null
  /**
   * Answers what the run *would* do and **calls `fn` exactly zero times**.
   *
   * The whole question a dry run is asked here is "how many, and what will it
   * cost" (decision 10), so a dry run that reached the host's model API to find
   * out would be answering it by spending it. It reads rows, counts the
   * non-images that would be free, and writes nothing.
   */
  dryRun?: boolean
}

/**
 * One batch of an enrichment run over a selection of library rows
 * (`../../docs/specs/content-model/media-library.md` decision 10).
 *
 * **A third runner beside `runBulk` and `runAssetBulk`, and the same argument
 * covers it** (decision 6): the walk is shared vocabulary rather than shared
 * code, because the three differ in everything that surrounds it — this one has
 * no action to switch on, no per-action arguments, a concurrency pool instead of
 * a sequential loop, a batch ceiling an order of magnitude lower, and a report
 * with two fields no bulk write has. What it does share it *imports*:
 * `core/bulk.ts`'s selection shapes, report shapes and cursor codec, and
 * `assetsMatching` / `assetsFor` / `countAssets` for the reads. The batch walk
 * below is duplicated from `asset-bulk.ts` and is the one place the two overlap;
 * extracting it would mean reshaping that file, which this phase did not own.
 *
 * Four properties are load-bearing, and the first two are the expensive ones:
 *
 * **The vocabulary is read once per call, never once per asset.** Ten assets in
 * a batch is ten identical reads of a table that cannot change during the batch;
 * over a run of forty thousand it is forty thousand.
 *
 * **`concurrency` in flight, and one failure never abandons the batch.** Every
 * asset is its own `try`, exactly as `runAssetBulk` does it — a run that died on
 * the file whose provider rate-limited it and skipped the other nine would be
 * paying for nine calls to report one error.
 *
 * **The report is assembled in position order**, though the work is not done in
 * it. `runAssetBulk` gets a deterministic failure list by being sequential;
 * that is not available here, so the results land in a slot per row and the
 * report is built from the slots afterwards. Without it the same batch reports
 * its failures in whichever order the network answered.
 *
 * **The count guard runs once, at the start of the job.** It bounds the *set* —
 * it cannot bound the bill, which is why the route above it is `ADMIN`
 * (decision 16).
 */
export async function runDescribe(
  deps: DescribeDeps,
  selection: BulkSelection<AssetFilter>,
  opts: DescribeRunOptions = {},
): Promise<DescribeRunOutcome> {
  const { db } = deps
  const dryRun = opts.dryRun === true
  const batch = Math.min(
    Math.max(Math.trunc(opts.batch ?? DEFAULT_DESCRIBE_BATCH), 1),
    MAX_DESCRIBE_BATCH,
  )
  const resume = opts.continueFrom ? readCursor(opts.continueFrom) : null

  // Before the ceiling check, matching `runAssetBulk`: a cursor that disagrees
  // with the list it was issued against is a client bug whatever the arithmetic
  // says, and an exhausted allowance would otherwise report a placid "nothing
  // left to do" for it.
  if (!selection.all && resume !== null && selection.ids[resume.seen - 1] !== resume.after) {
    throw new FolioError(
      'bad_request',
      'The selection changed between batches. Start the run again.',
    )
  }

  const total = selection.all
    ? Math.max(selection.expected - (selection.exclude?.length ?? 0), 0)
    : selection.ids.length
  const seen = resume?.seen ?? 0

  // Once, at the start of the job — never on a resumed call (`bulk-writes.md`
  // decision 3). It confirms *intent* over a set somebody read a number for; a
  // run whose set moved by three files while an admin was reading it is refused
  // as a value, with the new count, rather than thrown.
  if (selection.all && resume === null) {
    const actual = await countAssets(db, selection.filter)
    if (actual !== selection.expected) {
      return { refused: 'count', expected: selection.expected, actual }
    }
  }

  const report: DescribeRunReport = {
    action: 'describe',
    done: 0,
    failed: [],
    total,
    seen,
    continueFrom: null,
    dryRun,
    skipped: 0,
    tagsIgnored: 0,
  }

  // The ceiling. A job that has consumed everything it agreed to is finished
  // even if the filter still matches rows: those are files nobody agreed to
  // spend money on.
  const allowance = total - seen
  if (allowance <= 0) return report

  const { rows, consumed, exhausted, last } = selection.all
    ? await filterBatch(db, selection, resume?.after ?? null, batch, allowance)
    : await idBatch(db, selection.ids, seen, Math.min(batch, allowance))

  /**
   * **Once per call, and passed into every `describeAsset`.** `describeAsset`
   * reads it for itself when it is not given one, which is right for the
   * single-asset route and wrong here by a factor of the batch size.
   *
   * Not read at all on a dry run: nothing consumes it, and a dry run is the
   * call that is meant to be free.
   */
  const vocabulary = dryRun ? [] : await describeVocabulary(db)

  const slots: (Slot | null)[] = new Array(rows.length).fill(null)
  await inFlight(rows.length, deps.describe.concurrency, async (at) => {
    const row = rows[at] ?? null
    if (row === null) {
      // An id an explicit selection named and D1 no longer has. Unlike a bulk
      // delete, there is no reading of this under which the job got what it
      // asked for.
      slots[at] = {
        kind: 'failed',
        failure: { id: idAt(selection, seen + at), title: '', message: 'No such file' },
      }
      return
    }
    if (dryRun) {
      // `fn` is not reached, and the only question asked of the row is the free
      // one: would this have cost anything?
      slots[at] = { kind: 'dry', skipped: !isImageAsset(toAssetValue(row)) }
      return
    }
    try {
      slots[at] = { kind: 'done', outcome: await describeAsset(deps, row, vocabulary) }
    } catch (err) {
      // `describeAsset` records a model failure rather than throwing, so what
      // reaches here is D1 or R2 itself — and even that must not take the other
      // nine calls of the batch down with it.
      slots[at] = {
        kind: 'failed',
        failure: { id: row.id, title: row.filename, message: reasonOf(err) },
      }
    }
  })

  for (const slot of slots) {
    if (slot === null) continue
    if (slot.kind === 'failed') {
      report.failed.push(slot.failure)
      continue
    }
    if (slot.kind === 'dry') {
      report.done++
      if (slot.skipped) report.skipped++
      continue
    }
    const { outcome } = slot
    report.tagsIgnored += outcome.tagsIgnored
    if (outcome.error !== null) {
      // Recorded on the row *and* named in the report. The asset has left the
      // backlog either way — `described_at` is stamped — so a retry is an
      // explicit run over `describe_error is not null`, not the next sweep.
      report.failed.push({
        id: outcome.row.id,
        title: outcome.row.filename,
        message: outcome.error,
      })
      continue
    }
    report.done++
    if (outcome.skipped) report.skipped++
  }

  report.seen = seen + consumed
  // `exhausted`, not `consumed < batch`: a filter batch drops the rows a
  // select-all ticked off *after* the read, so it can act on fewer rows than it
  // read and still have the whole rest of the table in front of it.
  report.continueFrom =
    exhausted || report.seen >= total || last === null ? null : writeBulkCursor(last, report.seen)
  return report
}

/** One row's result, held by position so the report can be assembled in list
 * order however the concurrent calls actually finished. */
type Slot =
  | { kind: 'done'; outcome: DescribeOutcome }
  | { kind: 'dry'; skipped: boolean }
  | { kind: 'failed'; failure: BulkFailure }

/**
 * `count` positions, at most `limit` of them in flight.
 *
 * A fixed pool of workers pulling the next index rather than
 * `Promise.all(rows.map(…))` with a semaphore: the pool is the shape where
 * "four at once" is a property of the code rather than of a counter that has to
 * be decremented on every path out, including the throwing one. `next++` between
 * `await`s is safe for the reason it always is in this runtime — the increment
 * cannot interleave, because nothing else runs until the loop yields.
 *
 * `job` is expected to record its own failures; a throw out of it would abandon
 * one worker and take `Promise.all` with it, which is why every call site wraps
 * its body in a `try`.
 */
async function inFlight(
  count: number,
  limit: number,
  job: (at: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(Math.min(limit, count), 0) }, async () => {
    for (;;) {
      const at = next++
      if (at >= count) return
      await job(at)
    }
  })
  await Promise.all(workers)
}

/**
 * Describes an upload in the background, and **cannot fail the upload**
 * (decision 10).
 *
 * This runs under `ctx.waitUntil`, after the response has gone: the object is
 * in R2 and the row is in D1, and there is nobody left to tell. So every failure
 * — including a D1 or R2 one, which `describeAsset` does propagate — is a log
 * line, and the asset is left in the backlog exactly where a never-attempted one
 * is. A rejected promise handed to `waitUntil` is an unhandled rejection in the
 * host's Worker for an upload that succeeded.
 */
export async function describeOnUpload(deps: DescribeDeps, row: AssetRow): Promise<void> {
  try {
    await describeAsset(deps, row)
  } catch (e) {
    console.error('folio: describing an upload failed', e)
  }
}

/* ------------------------------------------------------------- the walk --- */

/**
 * One batch's worth of rows, and the three numbers the cursor needs —
 * `asset-bulk.ts`'s `Batch`, and it means the same thing here.
 */
interface Batch {
  rows: (AssetRow | null)[]
  /** How much of the ceiling this batch used. Not the number of rows read, for
   * a filter batch that dropped exclusions. */
  consumed: number
  /** Whether the walk has reached the end of what it can read. Reported by the
   * batch rather than inferred, because the two branches are asked for
   * different limits and only they know what they asked for. */
  exhausted: boolean
  /** The id to resume after, or null when there is nothing left. */
  last: string | null
}

/**
 * One batch of a captured filter.
 *
 * **The exclusions are applied here, in JavaScript, and not in the `where`** —
 * `asset-bulk.ts`'s `filterBatch` argues it in full: a selection's `exclude` is
 * up to 500 ids, five times `D1_BIND_CAP`, and no chunking rescues a single
 * statement.
 */
async function filterBatch(
  db: FolioDb,
  selection: FilterSelection<AssetFilter>,
  after: string | null,
  limit: number,
  allowance: number,
): Promise<Batch> {
  const rows = await assetsMatching(db, selection.filter, { limit, after })
  const excluded = new Set(selection.exclude ?? [])
  const kept = excluded.size === 0 ? rows : rows.filter((row) => !excluded.has(row.id))
  const acting = kept.length > allowance ? kept.slice(0, allowance) : kept
  return {
    rows: acting,
    consumed: acting.length,
    exhausted: rows.length < limit,
    last: rows.at(-1)?.id ?? null,
  }
}

/**
 * One batch of an explicit id list. `consumed` is the *slice* length rather than
 * the row count, because `assetsFor` omits an id with no row behind it and
 * counting rows would read a stale id as the end of the list.
 */
async function idBatch(
  db: FolioDb,
  ids: readonly string[],
  seen: number,
  limit: number,
): Promise<Batch> {
  const slice = ids.slice(seen, seen + limit)
  const found = new Map((await assetsFor(db, slice)).map((row) => [row.id, row]))
  return {
    rows: slice.map((id) => found.get(id) ?? null),
    consumed: slice.length,
    exhausted: slice.length < limit,
    last: slice.at(-1) ?? null,
  }
}

/** The id at a job position, for a failure that has no row to name itself with. */
function idAt(selection: BulkSelection<AssetFilter>, position: number): string {
  return selection.all ? '' : (selection.ids[position] ?? '')
}

/** `core/bulk.ts`'s codec, with this module's refusal for a cursor that is not
 * one of ours. */
function readCursor(raw: string): { after: string; seen: number } {
  const at = readBulkCursor(raw)
  if (!at) throw new FolioError('bad_request', 'Malformed pagination cursor')
  return at
}

/** Why one file could not be described, as text that may travel — `runBulk`'s
 * `reasonOf` and `runAssetBulk`'s, for their reason: a run report is prose
 * rendered straight into a panel, and anything `rethrow` declines to translate
 * is a bug or a platform failure that gets the generic message here and the real
 * one in the log. */
function reasonOf(err: unknown): string {
  try {
    rethrow(err)
  } catch (translated) {
    if (translated instanceof FolioError) return translated.message
  }
  console.error('folio: unreportable failure during a describe run', err)
  return 'Something went wrong.'
}
