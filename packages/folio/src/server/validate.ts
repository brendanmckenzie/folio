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
import { decodeCursor } from '../core/pagination'
import type { DocumentType } from '../core/schema'
import {
  type AssetSort,
  DEFAULT_ASSET_SORT,
  DEFAULT_DOCUMENT_SORT,
  DEFAULT_FLAT_SORT,
  DEFAULT_SEARCH_SORT,
  type DocumentSort,
  type FlatSort,
  type SearchSort,
  type StoryFilter,
} from '../core/story'
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
 * A locale code, as a body field or a query param. Bounded and screened here;
 * whether the code is *declared* is `isKnownLocale`'s answer, and the route
 * answers `unsupported` for one that is not — the request is well-formed, the
 * server simply has no such locale (`localisation.md`).
 */
const LOCALE_CODE = v.pipe(
  v.string('must be a string'),
  v.trim(),
  v.minLength(1, 'is required'),
  v.maxLength(32, 'must be 32 characters or fewer'),
  v.regex(/^[A-Za-z0-9_-]+$/, 'contains unsupported characters'),
)

export function localeQuery(raw: string): string {
  return parseOrThrow(LOCALE_CODE, raw, 'locale')
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

/**
 * `actor` used to be a field here. It is gone (`identity-and-access.md` phase 5):
 * the client sent its own display name, which made "who checkpointed this" a
 * value anybody could type. The route reads `c.var.actor` instead. Undeclared
 * rather than declared-and-refused, unlike `StoryPatchBody.type`: a client that
 * still sends one is a stale tab, not a caller asking for something the server
 * will not do, and valibot strips an undeclared key silently.
 */
export const CheckpointBody = v.object({ label: v.optional(bounded(120)) }, OBJECT)

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

/**
 * `POST /folio/migrate` (`schema-migrations.md`). Every field is optional, so an
 * empty body means "run everything from the start in default-sized batches",
 * which is what a deploy step wants to be able to write.
 *
 * `batch` is bounded here as well as clamped by the runner: this bounds what
 * reaches the D1 `limit`, the runner bounds what one request will actually
 * attempt, and neither is redundant with the other.
 */
export const MigrateBody = v.object(
  {
    dryRun: v.optional(v.boolean('must be true or false')),
    /** The previous call's `continueFrom`, so it is a story id. */
    continueFrom: v.nullish(ID),
    batch: v.optional(
      v.pipe(
        v.number('must be a number'),
        v.integer('must be a whole number'),
        v.minValue(1, 'must be at least 1'),
        v.maxValue(200, 'must be 200 or fewer'),
      ),
    ),
  },
  OBJECT,
)

/**
 * `POST /folio/reindex` (`../content-model/collections.md`). Shaped exactly like
 * `MigrateBody` above, because it is the same kind of run: batched, resumable by an
 * id cursor, and safe to dry-run. An empty body means "sweep the first batch from
 * the start", which is what a one-off `curl` wants to be able to write.
 */
export const ReindexBody = v.object(
  {
    dryRun: v.optional(v.boolean('must be true or false')),
    continueFrom: v.nullish(ID),
    batch: v.optional(
      v.pipe(
        v.number('must be a number'),
        v.integer('must be a whole number'),
        v.minValue(1, 'must be at least 1'),
        v.maxValue(200, 'must be 200 or fewer'),
      ),
    ),
  },
  OBJECT,
)

export type ReindexInput = v.InferOutput<typeof ReindexBody>

/* ------------------------------------------------------------ content API --- */

/**
 * The nested content trees `PUT /content` and `POST /documents` carry
 * (`../../../docs/specs/platform/content-api.md`).
 *
 * Deliberately **`v.unknown()`**, and that is not a gap. The shape a payload has
 * to satisfy is the *schema's* — which block types nest where, which field names
 * exist, what JSON shape each kind stores — and none of that is expressible in a
 * valibot schema written here, because it is derived from the host's config at
 * construction. `fromNested` (core/nested.ts) is the validator, it names the path
 * that failed, and `rethrow` turns its refusal into the same `bad_request`
 * envelope everything in this file produces. A second, weaker shape check here
 * would only be able to disagree with it.
 *
 * What this file still owns is the wrapper: the `mode`, the locale, the caps.
 */
const CONTENT = v.unknown()

/** `merge` (the default) leaves absent fields alone; `replace` makes the payload whole. */
const WRITE_MODE = v.optional(v.picklist(['merge', 'replace'], "must be 'merge' or 'replace'"))

export const ContentPutBody = v.object({ content: CONTENT, mode: WRITE_MODE }, OBJECT)

/**
 * `PATCH /documents/:id/fields` — the targeted write, which skips the diff
 * entirely and becomes one `set` per field.
 *
 * `fields` addresses the root blok by name (where a document's own metadata
 * lives); `bloks` addresses any other by uid. `locale` scopes every `set` in the
 * request to one language, which is what a translation job wants to be able to
 * say once rather than per field.
 *
 * The per-field values are `unknown` for the same reason `CONTENT` is: `fieldShapeError`
 * checks them against the block's own declaration, which this file cannot see.
 */
export const FieldsPatchBody = v.object(
  {
    fields: v.optional(v.record(bounded(120), v.unknown())),
    bloks: v.optional(
      v.pipe(
        v.array(
          v.object(
            { uid: ID, fields: v.record(bounded(120), v.unknown()) },
            'each entry must be a JSON object',
          ),
        ),
        v.maxLength(500, 'must name 500 blocks or fewer'),
      ),
    ),
    locale: v.optional(LOCALE_CODE),
  },
  OBJECT,
)

/** `POST /api/v1/documents` — `StoryCreateBody` plus optional starting content. */
export const DocumentCreateBody = v.object(
  {
    title: required(300),
    slug: v.optional(bounded(200)),
    parentId: v.nullish(ID),
    type: v.optional(TYPE_NAME),
    content: v.optional(CONTENT),
  },
  OBJECT,
)

export type ContentPutInput = v.InferOutput<typeof ContentPutBody>
export type FieldsPatchInput = v.InferOutput<typeof FieldsPatchBody>
export type DocumentCreateInput = v.InferOutput<typeof DocumentCreateBody>

/**
 * The `Idempotency-Key` header, bounded before it is hashed. Opaque to Folio: it
 * is the *identity of the write*, chosen by the caller, and the only thing done
 * with it is `txIdFromKey`.
 */
export function idempotencyKeyHeader(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  return parseOrThrow(required(200), raw, 'Idempotency-Key')
}

/**
 * A URL path from `GET /api/v1/documents/by-path/*`. `''` is the root story, so
 * empty is legal — unlike every other screened value here, where empty is the
 * mistake.
 */
export function storyPathParam(raw: string | undefined): string {
  return parseOrThrow(bounded(500), raw ?? '', 'path')
}

/* ------------------------------------------------- identity and access --- */

/**
 * An email address, bounded and screened rather than pattern-matched against a
 * grammar. 254 is the RFC 5321 ceiling on a path; the shape check is deliberately
 * only "one `@`, something either side" because every stricter regex in
 * circulation refuses addresses that genuinely exist, and the address is
 * *verified* by whether the sign-in link is ever clicked, not by this schema.
 */
const EMAIL = v.pipe(
  v.string('must be a string'),
  v.trim(),
  v.toLowerCase(),
  v.minLength(3, 'is required'),
  v.maxLength(254, 'must be 254 characters or fewer'),
  v.regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'must be an email address'),
)

/** `POST /folio/login/email`. `next` is screened by `safeNext`, not here: this
 * only bounds it, since where it may point is a URL question. */
export const LoginEmailBody = v.object({ email: EMAIL, next: v.optional(bounded(500)) }, OBJECT)

export const UserCreateBody = v.object(
  {
    email: EMAIL,
    name: v.optional(bounded(120)),
    role: v.optional(v.picklist(['viewer', 'editor', 'publisher', 'admin'])),
  },
  OBJECT,
)

export const UserPatchBody = v.object(
  {
    name: v.optional(required(120)),
    role: v.optional(v.picklist(['viewer', 'editor', 'publisher', 'admin'])),
  },
  OBJECT,
)

/**
 * `POST /folio/tokens`. `scopes` is checked against the picklist here rather
 * than silently filtered, so asking for a scope that does not exist is a 400
 * naming it instead of a token quietly weaker than requested.
 */
export const TokenCreateBody = v.object(
  {
    name: required(80),
    scopes: v.pipe(
      v.array(
        v.picklist(
          [
            'content:read',
            'content:read:draft',
            'content:write',
            'publish',
            'assets:write',
            'admin',
          ],
          'is not a scope',
        ),
      ),
      v.minLength(1, 'must name at least one scope'),
    ),
    /** Days from now. Absent means no expiry. */
    expiresInDays: v.optional(
      v.pipe(
        v.number('must be a number'),
        v.integer('must be a whole number'),
        v.minValue(1, 'must be 1 or greater'),
        v.maxValue(3650, 'must be 3650 or fewer'),
      ),
    ),
  },
  OBJECT,
)

export type LoginEmailInput = v.InferOutput<typeof LoginEmailBody>
export type UserCreateInput = v.InferOutput<typeof UserCreateBody>
export type UserPatchInput = v.InferOutput<typeof UserPatchBody>
export type TokenCreateInput = v.InferOutput<typeof TokenCreateBody>

/**
 * Where to send a browser after signing in, screened to a same-origin path.
 *
 * The `?next=` parameter is attacker-controllable — it is in a link anyone can
 * write — so anything that is not a plain absolute path on this site falls back
 * to the editor. `//evil.example` is the case a naive `startsWith('/')` misses:
 * browsers read it as a protocol-relative URL to another host, which is an open
 * redirect out of a login page, the single most useful kind.
 */
export function safeNext(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback
  // A backslash is normalised to a slash by some browsers, so `/\evil.example`
  // is the same trick wearing a different character.
  if (raw.includes('\\')) return fallback
  return raw.length > 500 ? fallback : raw
}

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

/**
 * Refuses a malformed pagination cursor with the one error envelope.
 *
 * A **400, never a silent first page** (`../../../docs/specs/foundation/
 * pagination.md`, edge cases): the cursor is opaque, so a client that sent a bad
 * one has a bug, and quietly restarting surfaces as a list that jumped — which
 * nobody can act on.
 *
 * Note the asymmetry with `limitParam`, which clamps rather than refusing. An
 * out-of-range limit is a stale bookmark and still has an obvious right answer;
 * "resume after ???" has none.
 */
export function requireCursor(raw: string | undefined): void {
  if (raw !== undefined && decodeCursor(raw) === null) {
    throw new FolioError('bad_request', 'Malformed pagination cursor')
  }
}

/* ------------------------------------------------------------ story lists --- */

/**
 * How many ids or paths one batch request may name.
 *
 * `storiesForChunked` will chunk any number of them, so this is not a technical
 * bound — it is the bound on how much work one request may ask for. A document
 * with three hundred links is legitimate; three thousand ids in a query string is
 * a client with a bug or a URL somebody built by accident, and answering it would
 * be twenty round trips to D1 inside one request.
 */
const MAX_BATCH = 500

/**
 * A comma-separated id list off a query string, screened id by id.
 *
 * Empty in, empty out — an absent `?ids=` and `?ids=` with nothing after it are
 * the same request, which is what lets a client build the URL without a
 * conditional. A malformed id is a 400 rather than being dropped: silently
 * ignoring one means the caller gets a short list back and no way to tell whether
 * the row is missing or its id was rejected.
 */
export function idListQuery(raw: string | undefined): string[] {
  return listQuery(raw, 'ids', (value, label) => parseOrThrow(ID, value, label))
}

/**
 * The same, for paths. Not `ID`: a path contains `/`, is empty for the root
 * story, and is the one identifier here a person types.
 *
 * The root's `''` is why the empty *segments* of a list are kept rather than
 * filtered — `?paths=,about` legitimately means the root and `/about`, and a
 * breadcrumb over a top-level page asks for exactly that (`ancestorPaths`
 * returns `['']`).
 */
export function pathListQuery(raw: string | undefined): string[] {
  return listQuery(raw, 'paths', (value, label) => parseOrThrow(STORY_PATH, value, label))
}

/**
 * A stored path, as a query parameter.
 *
 * Not `bounded()`, which trims: a trimmed path is a *different* path, so a lookup
 * for one with a trailing space would silently find its neighbour instead. No
 * leading slash either — `derivePaths` writes none, so `/about` is not a stored
 * value and asking for it is a client bug worth surfacing rather than normalising.
 * `''` is allowed, and is the root story.
 */
const STORY_PATH = v.pipe(
  v.string('must be a string'),
  v.maxLength(1024, 'must be 1024 characters or fewer'),
  v.regex(PRINTABLE, 'contains unsupported characters'),
  v.regex(/^(?!\/)\S*$/, 'is not a story path'),
)

function listQuery(
  raw: string | undefined,
  label: string,
  screen: (value: string, label: string) => string,
): string[] {
  if (raw === undefined || raw === '') return []
  const parts = raw.split(',')
  if (parts.length > MAX_BATCH) {
    throw new FolioError('bad_request', `\`${label}\` names more than ${MAX_BATCH} documents`)
  }
  return parts.map((part, at) => screen(part, `${label}[${at}]`))
}

/** The four states `core/story.ts`'s `StoryState` names. Screened here so a chip
 * value from a stale bookmark is a 400 rather than a filter that matches nothing
 * and looks like an empty site. */
const STORY_STATE = v.picklist(
  ['draft', 'unpublished', 'live', 'changed'],
  'must be one of: draft, unpublished, live, changed',
)

/**
 * A free-text search term. Bounded, and that is the whole screen: it reaches SQL
 * as a bound `like` parameter, so `%` and `_` in it are the user's wildcards
 * rather than an injection — a substring search where `_` matched any character
 * is a surprise, not a vulnerability.
 */
const SEARCH_Q = v.pipe(v.string('must be a string'), v.trim(), v.maxLength(200))

/**
 * `StoryFilter` off a query string — the same object the Content screen keeps in
 * its URL and the same one a captured selection would serialise
 * (`../../../docs/specs/foundation/pagination.md` decision 9).
 *
 * `parentId` is deliberately **not** read here. It is structure rather than a
 * filter, and its absent-versus-null distinction is load-bearing enough
 * (`null` is the top level; absent is every level) that it belongs as a
 * positional argument at the one route that means it, not as a key that can be
 * forgotten inside an options object.
 */
export function storyFilterQuery(req: { query: (key: string) => string | undefined }): StoryFilter {
  const type = req.query('type')
  const state = req.query('state')
  const q = req.query('q')
  const locale = req.query('locale')
  return {
    ...(type ? { type: typeNameQuery(type) } : {}),
    ...(state ? { state: parseOrThrow(STORY_STATE, state, 'state') } : {}),
    ...(q ? { q: parseOrThrow(SEARCH_Q, q, 'q') } : {}),
    ...(locale ? { locale: localeQuery(locale) } : {}),
  }
}

/**
 * Flat mode's ordering, defaulting to `edited`.
 *
 * Defaulted rather than required, because the default is the answer to the
 * question the flat list exists for — "what changed lately" — and a client that
 * omits it wants that rather than an error. An *unknown* sort still 400s: it is a
 * typo or a stale link, and quietly serving `edited` would make the URL lie about
 * what is on screen.
 */
export function flatSortQuery(raw: string | undefined): FlatSort {
  if (raw === undefined || raw === '') return DEFAULT_FLAT_SORT
  return parseOrThrow(
    v.picklist(['edited', 'title', 'path'], 'must be one of: edited, title, path'),
    raw,
    'sort',
  )
}

/**
 * The Documents screen's ordering, defaulting to `title` — same rule as
 * `flatSortQuery`: the default is the answer to the question the list exists for,
 * and an *unknown* sort still 400s because it is a typo or a stale link and
 * quietly serving the default would make the URL lie about what is on screen.
 *
 * `ord` and not the name of an `indexed` field, deliberately. `core/story.ts`'s
 * `DocumentSort` carries the argument; the refusal here is what a client written
 * against the old client-side sort meets, and the message names what it can have.
 */
export function documentSortQuery(raw: string | undefined): DocumentSort {
  if (raw === undefined || raw === '') return DEFAULT_DOCUMENT_SORT
  return parseOrThrow(
    v.picklist(['ord', 'title', 'edited'], 'must be one of: ord, title, edited'),
    raw,
    'sort',
  )
}

/**
 * The Assets screen's ordering, defaulting to `created` — the same rule as the two
 * above: the default answers the question the list exists for ("what did I just
 * upload"), and an *unknown* sort 400s rather than quietly serving the default,
 * because a URL that silently means something else than it says is worse than a
 * refusal somebody can read.
 *
 * `core/story.ts`'s `AssetSort` carries which direction each one runs in and why
 * `size` is the one that descends.
 */
export function assetSortQuery(raw: string | undefined): AssetSort {
  if (raw === undefined || raw === '') return DEFAULT_ASSET_SORT
  return parseOrThrow(
    v.picklist(['created', 'filename', 'size'], 'must be one of: created, filename, size'),
    raw,
    'sort',
  )
}

/**
 * `?dir=` — reverses a sort. Absent means the ordering's own natural direction,
 * which is what a column header shows on its first click, so this is only ever
 * present once somebody has clicked twice.
 */
export function sortDirQuery(raw: string | undefined): 'asc' | 'desc' | undefined {
  if (raw === undefined || raw === '') return undefined
  return parseOrThrow(v.picklist(['asc', 'desc'], 'must be one of: asc, desc'), raw, 'dir')
}

/** `?sort=` on the search route. See `core/story.ts`'s `SearchSort` for why the
 * two values are `title` and `edited` and why the choice matters at all when the
 * consumer does the ranking. */
export function searchSortQuery(raw: string | undefined): SearchSort {
  if (raw === undefined || raw === '') return DEFAULT_SEARCH_SORT
  return parseOrThrow(v.picklist(['title', 'edited'], 'must be one of: title, edited'), raw, 'sort')
}

/**
 * `?kind=` on the search route: which *declared kind* of document to look in.
 *
 * Absent means every kind, which is what the palette wants. A picker narrowed to
 * pages passes `page`; a `reference()` picker passes `record`. Resolved by the
 * route into a list of type names, because nothing on a `stories` row records a
 * kind — it is a property of the type the host declared.
 */
export function searchKindQuery(raw: string | undefined): DocumentType['kind'] | undefined {
  if (raw === undefined || raw === '') return undefined
  return parseOrThrow(
    v.picklist(['page', 'record', 'singleton'], 'must be one of: page, record, singleton'),
    raw,
    'kind',
  )
}
