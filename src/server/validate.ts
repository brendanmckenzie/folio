/**
 * Schemas for every value the HTTP routes read from outside: request bodies,
 * path params, query params, and the headers a route reads.
 *
 * valibot here and only here. The shapes are shallow but numerous, and the
 * length caps are the point of the file: they bound what reaches a D1 column or
 * an R2 key *before* the write, so a 10MB title never becomes a row. The wire
 * protocol (core/protocol.ts) keeps its own hand-rolled guards and takes no
 * dependency — nothing under core/ imports this module.
 *
 * Everything fails the same way: a `FolioError('bad_request', …)` whose message
 * is assembled here. Every schema carries its own message, including the
 * object-level ones, so no failure can echo valibot's rendering of the value it
 * refused back to the client.
 *
 * The one input this file does not bound is the transform query on
 * `GET /folio/asset/:key`, which parseTransform (assets.ts) parses and clamps
 * itself.
 */
import * as v from 'valibot'
import { FolioError } from './errors'

/**
 * Ceiling on a validation message. A backstop rather than the defence: a schema
 * added here without its own message would fall back to valibot's, which
 * stringifies the value it received, and this bounds how much of it travels.
 */
const MAX_MESSAGE = 200

/* ----------------------------------------------------------- primitives --- */

/**
 * A row id arriving as a path param or inside a body.
 *
 * Ids are minted server-side (`sty_`/`ver_`/`ast_` plus hex) but the demo
 * seed's rows (examples/demo/seed.sql) use readable names, so this bounds and
 * screens rather than matching
 * a mint format: no control characters, no path separators, and short enough
 * that junk can never become a large bind.
 */
const ID = v.pipe(
  v.string('must be a string'),
  v.trim(),
  v.minLength(1, 'is required'),
  v.maxLength(64, 'must be 64 characters or fewer'),
  v.regex(/^[A-Za-z0-9_.:-]+$/, 'contains unsupported characters'),
)

/**
 * A document type name, as a body field or a query param. Names are written by
 * a developer in `createFolio`'s config, not by a person in the CMS, so this is
 * the identifier charset rather than `PRINTABLE`: it bounds the bind before the
 * route looks the name up in the config.
 */
const TYPE_NAME = v.pipe(
  v.string('must be a string'),
  v.trim(),
  v.minLength(1, 'is required'),
  v.maxLength(64, 'must be 64 characters or fewer'),
  v.regex(/^[A-Za-z0-9_-]+$/, 'contains unsupported characters'),
)

export function typeNameQuery(raw: string | undefined): string {
  return parseOrThrow(TYPE_NAME, raw, 'type')
}

/**
 * What a person can type into a CMS: everything except the characters that make
 * a stored string lie about itself.
 *
 * `Cc` is the C0/C1 controls, `Cs` a lone surrogate (a well-formed pair is a
 * single non-Cs code point under `/u`, so astral characters pass and a broken
 * half does not), and the two explicit ranges are the bidi overrides and
 * isolates, which can reorder a rendered title away from what was stored.
 *
 * `\p{C}` as a whole would be wrong: it includes `Cf`, and U+200D ZERO WIDTH
 * JOINER is what holds together every multi-codepoint emoji ("👨‍💻", "🏳️‍🌈"), plus
 * `Cn`, which would make the screen tighten with each Unicode release.
 */
const PRINTABLE = /^[^\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]*$/u

const bounded = (max: number) =>
  v.pipe(
    v.string('must be a string'),
    v.trim(),
    v.maxLength(max, `must be ${max} characters or fewer`),
    v.regex(PRINTABLE, 'contains unsupported characters'),
  )

/** Required, non-empty once trimmed. */
const required = (max: number) => v.pipe(bounded(max), v.minLength(1, 'is required'))

/* --------------------------------------------------------------- bodies --- */

/**
 * The object-level message every body schema passes. Without it valibot's
 * default stringifies the received value, which turns a rejected `"…"` body into
 * a reflection of whatever the client sent — the one leak `MAX_MESSAGE` alone
 * would be left bounding.
 */
const OBJECT = 'must be a JSON object'

/**
 * `slug` is capped before slugify, which then truncates to 64 (core/story.ts):
 * the cap exists so an unbounded string is never parsed or slugified, not to
 * describe the stored value.
 */
export const StoryCreateBody = v.object(
  {
    title: required(300),
    slug: v.optional(bounded(200)),
    parentId: v.nullish(ID),
    /**
     * Document type name (`document-types.md`). Absent means the default page
     * type, so a client written before types existed keeps working. Screened
     * like an id rather than checked against the config here: whether the type
     * is *declared* is the route's answer to give, and it answers
     * `unsupported` — the request is well-formed, the server just has no such
     * type.
     */
    type: v.optional(TYPE_NAME),
  },
  OBJECT,
)

/**
 * `index` is a sibling position, not a stored `ord`: stories.ts turns it into a
 * fractional key, and `keyAtIndex` clamps anything past the end of the sibling
 * list — so only NaN and negatives need refusing here.
 */
export const StoryPatchBody = v.object(
  {
    title: v.optional(required(300)),
    slug: v.optional(bounded(200)),
    parentId: v.nullish(ID),
    /**
     * Accepted so a client that round-trips a whole story object is not
     * punished for it, then refused by `updateStoryStatement` when it actually
     * differs from the row: retyping a document is a schema migration
     * (`schema-migrations.md`), not a patch. Declaring the key rather than
     * letting valibot strip it silently is what makes that a refusal instead of
     * a change that appears to succeed and does nothing.
     */
    type: v.optional(TYPE_NAME),
    index: v.optional(
      v.pipe(
        v.number('must be a number'),
        v.integer('must be a whole number'),
        v.minValue(0, 'must be 0 or greater'),
      ),
    ),
  },
  OBJECT,
)

/**
 * `duplicate-and-paste.md`'s `POST /stories/:id/duplicate`. Both optional:
 * an absent `title` falls back to `"{source title} (copy)"`
 * (`duplicateStory`), an absent `parentId` to the source's own parent.
 */
export const StoryDuplicateBody = v.object(
  {
    title: v.optional(required(300)),
    parentId: v.nullish(ID),
  },
  OBJECT,
)

export const CheckpointBody = v.object(
  {
    label: v.optional(bounded(120)),
    actor: v.optional(bounded(64)),
  },
  OBJECT,
)

export const AssetPatchBody = v.object({ alt: v.optional(bounded(500)) }, OBJECT)

/**
 * A manual redirect (redirects.md). `to` is capped generously: it is either an
 * in-site path or an absolute URL, and the row is re-checked with `isSafeHref`
 * on every read regardless of what this schema let through.
 */
export const RedirectCreateBody = v.object(
  {
    from: required(500),
    to: required(2000),
    status: v.optional(v.picklist([301, 302, 307, 308])),
  },
  OBJECT,
)

export type StoryCreateInput = v.InferOutput<typeof StoryCreateBody>
export type StoryPatchInput = v.InferOutput<typeof StoryPatchBody>
export type StoryDuplicateInput = v.InferOutput<typeof StoryDuplicateBody>
export type CheckpointInput = v.InferOutput<typeof CheckpointBody>
export type AssetPatchInput = v.InferOutput<typeof AssetPatchBody>
export type RedirectCreateInput = v.InferOutput<typeof RedirectCreateBody>

/* --------------------------------------------------------------- parsing --- */

/**
 * Parses or throws the client-facing error. `label` names the value for a
 * failure that carries no path of its own (a scalar param, or a body that is
 * not an object at all).
 */
export function parseOrThrow<S extends v.GenericSchema>(
  schema: S,
  input: unknown,
  label: string,
): v.InferOutput<S> {
  const result = v.safeParse(schema, input)
  if (result.success) return result.output as v.InferOutput<S>

  const issue = result.issues[0]!
  const where = v.getDotPath(issue) ?? label
  throw new FolioError('bad_request', `${where} ${issue.message}`.slice(0, MAX_MESSAGE))
}

/**
 * The JSON body, parsed. A malformed body is the client's mistake, so it is a
 * 400 here rather than a thrown SyntaxError that `onError` would have to report
 * as a 500. Structurally typed on purpose: this file stays free of Hono.
 */
export async function parseBody<S extends v.GenericSchema>(
  req: { json: () => Promise<unknown> },
  schema: S,
  label = 'body',
): Promise<v.InferOutput<S>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new FolioError('bad_request', 'Request body must be JSON.')
  }
  return parseOrThrow(schema, raw, label)
}

/** An optional JSON body: absent or malformed both parse as `{}`. */
export async function parseOptionalBody<S extends v.GenericSchema>(
  req: { json: () => Promise<unknown> },
  schema: S,
  label = 'body',
): Promise<v.InferOutput<S>> {
  const raw = await req.json().catch(() => ({}))
  return parseOrThrow(schema, raw, label)
}

/* ---------------------------------------------------- params and headers --- */

export function idParam(label: string, raw: string | undefined): string {
  return parseOrThrow(ID, raw, label)
}

/**
 * The same screen as `idParam` without the throw, for the two routes where a
 * malformed id must not become a 400: the sync socket (a failed *upgrade* is
 * indistinguishable on the wire from a dropped connection, so it takes the
 * terminal-close path a deleted story takes) and the admin HTML routes (which
 * answer 404 for an id nothing is behind).
 */
export function isId(raw: string | undefined): boolean {
  return v.is(ID, raw)
}

/**
 * An R2 object key from the public asset route. Keys are always
 * `ast_<hex>-<safeFilename>` (assets.ts: 12 hex characters, then
 * `safeFilename`'s own output charset capped at 80), so this is anchored to
 * that exact mint format rather than a charset/length screen. A screen alone
 * — any string of the right characters and length — turns this public,
 * unauthenticated route into a read primitive for *any* flat key in the same
 * bucket: Folio's own keys are unguessable, but `logo.png`, `config.json` or
 * `.env` co-tenanted in the same bucket under a guessable key are not.
 */
const ASSET_KEY = v.pipe(
  v.string('must be a string'),
  v.regex(/^ast_[0-9a-f]{12}-[a-z0-9.-]{1,80}$/, 'must be a Folio asset key'),
)

export function assetKeyParam(raw: string | undefined): string {
  return parseOrThrow(ASSET_KEY, raw, 'key')
}

/**
 * The upload filename. Capped before assets.ts's `safeFilename`, which strips
 * it to `[a-z0-9.-]` and truncates to 80 for the R2 key.
 */
export function filenameQuery(raw: string | undefined): string {
  return parseOrThrow(required(200), raw, 'filename')
}

/**
 * The types `serveAsset` is allowed to echo back as a response `Content-Type`,
 * and therefore the only ones an upload may store: the raster formats the
 * transform path in assets.ts actually reads and writes.
 *
 * This is an allowlist rather than a screen because the stored value *is* the
 * served value on a public, currently unauthenticated route that published pages
 * point their `<img>` tags at. A stored `text/html` would be script running on
 * the site's own origin; `image/svg+xml` is the same hazard wearing an image
 * type, and assets.ts deliberately streams it back untransformed.
 *
 * Adding a type here is a deliberate act: it says the render path can serve that
 * type inline.
 */
export const SERVED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])

/** What anything else is stored and served as: kept, but never rendered. */
export const DOWNLOAD_CONTENT_TYPE = 'application/octet-stream'

/**
 * The `content-type` of an upload, reduced to something safe to store and later
 * serve.
 *
 * Anything outside the allowlist — including SVG, HTML and every non-image file
 * a media library might legitimately hold — is stored as
 * `application/octet-stream`, which is already what an absent header produces in
 * assets.ts: the file is kept and downloads rather than rendering. Refusing the
 * upload outright would lose the file over a header the client chose, and
 * nothing needs the original string: the only reader of the column is
 * `isImageAsset` (core/values.ts), which falls back to the filename extension.
 */
export function contentTypeHeader(raw: string | undefined): string {
  // Parameters (`; charset=…`) are not part of the type being allowlisted.
  const type = (raw ?? '').split(';')[0]!.trim().toLowerCase()
  return SERVED_CONTENT_TYPES.has(type) ? type : DOWNLOAD_CONTENT_TYPE
}

/**
 * The declared body size of an upload, refused before the body is read.
 *
 * assets.ts applies the same ceiling, but only once the isolate has already
 * buffered the bytes: the Worker's own memory limit sits well below the
 * platform's request-body limit, so that check is reached by first doing the
 * thing it exists to prevent. It stays as the backstop for a chunked body, which
 * arrives with no `content-length` to read here.
 */
export function contentLengthHeader(raw: string | undefined, max: number): void {
  const declared = Number(raw)
  if (Number.isFinite(declared) && declared > max) {
    // Worded exactly as assets.ts's post-read check, so which of the two
    // refused a request is not something a client can tell apart.
    throw new FolioError('too_large', `File is larger than ${Math.floor(max / 1024 / 1024)}MB`)
  }
}

/**
 * `x-folio-actor`, recorded on every version row and shown in history.
 * Self-reported until auth lands, so it is bounded and screened like any other
 * client input; absent or blank is `null`, which is what the column stores.
 */
export function actorHeader(raw: string | undefined): string | null {
  if (raw === undefined) return null
  return parseOrThrow(bounded(64), raw, 'x-folio-actor') || null
}

/**
 * A query-string limit, defaulted and bounded, for the one place a query param
 * reaches a SQL bind.
 *
 * `Number(undefined)` and `Number('not-a-number')` are both `NaN`, which must
 * never reach the bind inside the Durable Object (`Math.max(NaN, 1)` is itself
 * `NaN`, not 1) — so absent and non-numeric fall back before the clamp rather
 * than trusting the DO's own bound to catch it. Out-of-range clamps instead of
 * 400ing: a stale bookmark should not break a panel.
 */
// `number()` already refuses NaN; `finite()` covers the infinities.
const LIMIT = v.pipe(v.string(), v.transform(Number), v.number(), v.finite())

export function limitParam(raw: string | undefined, fallback: number, max: number): number {
  const n: number = v.parse(v.fallback(LIMIT, fallback), raw)
  return Math.min(Math.max(Math.trunc(n), 1), max)
}
