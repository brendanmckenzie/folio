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
import { type AssetTag, tagSlug } from '../core/assets'
import { isImageAsset } from '../core/values'
import { type AssetRow, assetById, toAssetValue } from './assets'
import { listTags } from './asset-tags'
import { bindChunks, type FolioDb } from './db'
import { clampText } from './validate'
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
  return images ? `${src}?w=512&f=webp` : src
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
    bytes: async () => (await deps.media.get(row.key))?.arrayBuffer() ?? new ArrayBuffer(0),
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
