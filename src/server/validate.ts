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
import { type AssetSort, DEFAULT_ASSET_SORT, tagSlug } from '../core/assets'
import { MAX_FORM_FIELDS } from '../core/forms'
import { decodeCursor } from '../core/pagination'
import type { DocumentType } from '../core/schema'
import {
  DEFAULT_DOCUMENT_SORT,
  DEFAULT_FLAT_SORT,
  DEFAULT_SEARCH_SORT,
  type DocumentSort,
  type FlatSort,
  type ScheduleAction,
  type ScheduleStatus,
  type SearchSort,
  type StoryFilter,
} from '../core/story'
import { MAX_ASSET_TAGS, MAX_TAG_FILTER } from './asset-tags'
import { FolioError } from './errors'
import type { ResponseFilter } from './forms'

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

/**
 * `bounded()`'s screen for text that **nobody typed** — what a model answered
 * (`../content-model/media-library.md` decision 8's `DescribeResult`).
 *
 * Same characters, same caps, opposite failure. `bounded` refuses, because a
 * person is holding the form and can be told which field is wrong; there is
 * nobody to tell here, and refusing a 2,010-character description would throw
 * away the whole model call — including the alt text that came back perfect —
 * over ten characters. So this **clamps**: a non-string is `undefined` (the
 * model said nothing about that field), the characters `PRINTABLE` excludes are
 * stripped rather than fatal, and the rest is trimmed and truncated.
 *
 * Truncation is by code point, not by `.slice`: cutting a UTF-16 string at a
 * fixed index can land between the halves of a surrogate pair and store a lone
 * `\uD83D` — exactly the `\p{Cs}` that `PRINTABLE` exists to keep out, put back
 * by the thing enforcing the cap.
 */
export function clampText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const clean = raw.replace(/[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/gu, '').trim()
  const points = [...clean]
  return points.length > max ? points.slice(0, max).join('').trim() : clean
}

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

/**
 * What an editor can change about one library row
 * (`../content-model/media-library.md` decision 4 and phase 3).
 *
 * Every field is `v.optional`, and absent means *leave it alone* — so `alt: ''`
 * clears the alt text while `{}` does not, and `folderId: null` unfiles the asset
 * while an absent `folderId` leaves it filed. `assets.ts`'s `updateAsset` builds
 * its `set` list from exactly that distinction.
 *
 * `tags` is the **whole** set of tag ids, replacing whatever is stored: the chip
 * list an editor sees is the truth, so removing a chip has to remove the tagging.
 * Adding or removing across a *selection* is phase 5's bulk route, deliberately
 * not this. `MAX_ASSET_TAGS` bounds the array so an unbounded list cannot be
 * parsed and turned into statements — `setAssetTags` chunks its binds, so this is
 * a bound on the body rather than on the SQL.
 *
 * `description` is capped at 2000 against `alt`'s 500, matching what phase 6's
 * `DescribeResult` is allowed to write into the machine columns beside them: a
 * description says what the file *is* and a sentence of alt text says what a
 * screen reader should announce.
 */
export const AssetPatchBody = v.object(
  {
    alt: v.optional(bounded(500)),
    description: v.optional(bounded(2000)),
    folderId: v.optional(v.nullable(ID)),
    tags: v.optional(
      v.pipe(
        v.array(ID, 'must be an array of tag ids'),
        v.maxLength(MAX_ASSET_TAGS, `must name ${MAX_ASSET_TAGS} tags or fewer`),
      ),
    ),
  },
  OBJECT,
)

/**
 * A tag, created or renamed (`../content-model/media-library.md` decision 4).
 *
 * `name` is what was typed and is what is displayed; the identity is
 * `core/assets.ts`'s `tagSlug` of it, which is why there is no `slug` field for a
 * client to send. 60 rather than the folder's 120: a tag renders as a chip beside
 * others in a sidebar, and `tagSlug` truncates nothing, so the typed length *is*
 * the stored identity's length.
 *
 * One schema for both the create and the patch, unlike folders — a tag has
 * exactly one editable field, so the two bodies cannot drift apart the way
 * `{ name?, parentId? }` can.
 */
export const AssetTagBody = v.object({ name: required(60) }, OBJECT)

/**
 * A media-library folder (`../content-model/media-library.md` decision 3).
 *
 * `name` is what was typed and is what is displayed; the identity is `path`, the
 * slash-joined chain of *slugified* ancestor names that `asset-folders.ts`
 * derives from it. So this bounds the typed string and nothing more: 120 is the
 * cap on what a person types, and `slugify` truncates its own output to 64 for
 * the segment.
 *
 * `parentId` is optional **and** nullable, and the two mean different things:
 * absent is "the top level" on a create and "leave the parent alone" on a patch,
 * while an explicit `null` is "the top level" in both. That distinction is the
 * whole of what makes `PATCH { name }` a rename rather than a move to the root.
 */
export const AssetFolderCreateBody = v.object(
  { name: required(120), parentId: v.optional(v.nullable(ID)) },
  OBJECT,
)

/** The same fields, both optional: `{ name }` renames, `{ parentId }` moves, and
 * both together is one subtree rewrite rather than two. */
export const AssetFolderPatchBody = v.object(
  { name: v.optional(required(120)), parentId: v.optional(v.nullable(ID)) },
  OBJECT,
)

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

/* -------------------------------------------------------------- schedules --- */

/**
 * The two things a schedule can do (`../../../docs/specs/platform/
 * scheduled-publishing.md`). Screened against the picklist rather than any string,
 * so a typo is a 400 naming what it can be instead of a pending row whose action
 * the sweep will refuse three times.
 */
const SCHEDULE_ACTION = v.picklist(['publish', 'unpublish'], 'must be one of: publish, unpublish')

/** `?action=` on the cancel route, where it is **required**: cancelling "the
 * schedule" for a document is ambiguous when a campaign window has two. */
export function scheduleActionQuery(raw: string | undefined): ScheduleAction {
  return parseOrThrow(SCHEDULE_ACTION, raw, 'action')
}

/** The same as an optional list filter, where absent means both. */
export function scheduleActionFilter(raw: string | undefined): ScheduleAction | undefined {
  if (raw === undefined || raw === '') return undefined
  return scheduleActionQuery(raw)
}

/** `?status=`. Absent means both, which is what "what is scheduled" means. */
export function scheduleStatusQuery(raw: string | undefined): ScheduleStatus | undefined {
  if (raw === undefined || raw === '') return undefined
  return parseOrThrow(
    v.picklist(['pending', 'failed'], 'must be one of: pending, failed'),
    raw,
    'status',
  )
}

/**
 * `POST {base}/api/story/:id/schedule`.
 *
 * `at` is bounded here only as "a whole non-negative number of milliseconds";
 * whether it is in the future, and not absurdly far into it, is
 * `checkScheduleTime`'s answer in `server/schedules.ts` — it needs the current
 * time, which a static schema does not have, and it is a rule about the product
 * rather than about what may reach a column.
 *
 * `actor` is deliberately not a field, for the reason `CheckpointBody` records:
 * "who scheduled this" is not a value anybody should be able to type. The route
 * reads `c.var.actor`.
 */
export const ScheduleBody = v.object(
  {
    action: SCHEDULE_ACTION,
    at: v.pipe(
      v.number('must be a number'),
      v.integer('must be a whole number of milliseconds'),
      v.minValue(0, 'must be 0 or greater'),
    ),
  },
  OBJECT,
)

export type ScheduleInput = v.InferOutput<typeof ScheduleBody>

/**
 * `POST {base}/api/schedules/run`. Shaped like `MigrateBody` and `ReindexBody`,
 * because it is the same kind of run — batched, resumable, safe to dry-run — so an
 * empty body means "fire the first batch of whatever is due".
 *
 * `continueFrom` is a **cursor**, not an id, and that is the one difference from
 * the two bodies above: the sweep runs in due order, so its resume key is the
 * `(at, id)` pair rather than a primary key (`dueSchedules`). It is screened for
 * length here and decoded by `requireCursor` at the route.
 *
 * **`now` is deliberately absent.** The runner takes one so a test can fire next
 * Tuesday's schedule today, and exposing it over HTTP would turn a `publisher` into
 * somebody who can fire *every* future schedule on the site at once by posting a
 * date far enough ahead — a real capability nothing else in this surface grants.
 */
export const RunSchedulesBody = v.object(
  {
    dryRun: v.optional(v.boolean('must be true or false')),
    continueFrom: v.nullish(
      v.pipe(v.string('must be a string'), v.maxLength(500, 'is not a pagination cursor')),
    ),
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

export type RunSchedulesInput = v.InferOutput<typeof RunSchedulesBody>

/* ------------------------------------------------------------ content API --- */

/**
 * The nested content trees `PUT /content` and `POST /documents` carry
 * (`../../docs/specs/platform/content-api.md`).
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

/**
 * `POST /api/v1/documents/:id/restore`. The version id, and nothing else — the
 * route checks it against `getVersion`'s own `storyId`, so a mismatch is a 400
 * from the route rather than something this schema could catch.
 */
export const RestoreBody = v.object({ versionId: ID }, OBJECT)

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
            'forms:read',
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

/* ------------------------------------------------------------ passkeys --- */

/**
 * base64url, bounded. **The one screen that keeps a browser's own JSON off a
 * decoder that has to be total** (`../../docs/specs/foundation/passkeys.md`):
 * every field of a WebAuthn response arrives base64url-encoded from a page that
 * serialised it by hand, and `webauthn.ts` is fed the decoded bytes.
 *
 * Anchored to the alphabet rather than merely bounded, so a value with `+`, `/`
 * or `=` in it is a 400 here instead of a surprise inside `atob`. The caps are
 * generous by design — an RSA attestation object is a couple of kilobytes and
 * some authenticators pad — but they are caps: an unbounded body would be a
 * megabyte reaching a CBOR decoder before anything had decided it was a
 * credential at all.
 */
const b64url = (max: number) =>
  v.pipe(
    v.string('must be a string'),
    v.minLength(1, 'is required'),
    v.maxLength(max, `must be ${max} characters or fewer`),
    v.regex(/^[A-Za-z0-9_-]+$/, 'must be base64url'),
  )

/** A credential id as the authenticator minted it. 1023 bytes is the WebAuthn
 * ceiling; base64url of that is 1364. */
const CREDENTIAL_ID = b64url(1400)

const CREDENTIAL_TYPE = v.literal('public-key', "must be 'public-key'")

/**
 * `POST {base}/api/me/passkeys`. The enrolment half.
 *
 * `name` is optional because the route defaults it to `Passkey · <host>`, which
 * is the name that tells somebody later *where* the credential was enrolled —
 * the only hint they get when a passkey made on `localhost` silently fails on
 * the deployed host.
 */
export const PasskeyRegisterBody = v.object(
  {
    credential: v.object(
      {
        id: CREDENTIAL_ID,
        rawId: CREDENTIAL_ID,
        type: CREDENTIAL_TYPE,
        response: v.object(
          {
            clientDataJSON: b64url(4096),
            attestationObject: b64url(16384),
            /** `getTransports()`, advisory. Screened again in `webauthn.ts`,
             * which drops anything that is not a short string. */
            transports: v.optional(v.array(bounded(32))),
          },
          OBJECT,
        ),
      },
      OBJECT,
    ),
    name: v.optional(bounded(60)),
  },
  OBJECT,
)

/**
 * `POST {base}/login/passkey`. The assertion half.
 *
 * A failure here is a **401 with the route's one generic body**, not the 400
 * this schema would otherwise produce: the route catches it, because a
 * validation message is exactly the kind of difference that turns a uniform
 * refusal into an oracle.
 */
export const PasskeyAssertionBody = v.object(
  {
    credential: v.object(
      {
        id: CREDENTIAL_ID,
        rawId: CREDENTIAL_ID,
        type: CREDENTIAL_TYPE,
        response: v.object(
          {
            clientDataJSON: b64url(4096),
            authenticatorData: b64url(4096),
            signature: b64url(4096),
            /** Absent from some security keys' non-discoverable assertions, and
             * `null` from browsers that send the key regardless. */
            userHandle: v.nullish(b64url(1400)),
          },
          OBJECT,
        ),
      },
      OBJECT,
    ),
    next: v.optional(bounded(500)),
  },
  OBJECT,
)

/** `PATCH {base}/api/me/passkeys/:id`. 1–60 characters, matching the column's
 * own bound in `auth/passkeys.ts`. */
export const PasskeyPatchBody = v.object({ name: required(60) }, OBJECT)

export type PasskeyRegisterInput = v.InferOutput<typeof PasskeyRegisterBody>
export type PasskeyAssertionInput = v.InferOutput<typeof PasskeyAssertionBody>

/**
 * `POST {base}/api/story/:id/share` (`../../docs/specs/platform/draft-sharing.md`).
 *
 * Both fields optional, so an empty body means "a link for this document, on the
 * default terms" — which is the request an editor actually makes.
 *
 * `expiresInDays` is bounded here *and* in `shareExpiry`, and neither is redundant:
 * this bounds what may reach the column, and that states the product rule
 * (`MAX_SHARE_DAYS`) so a programmatic caller and `folio.handle`'s own callers meet
 * the same refusal. The pairing `POST /migrate` uses for `batch`.
 *
 * There is no `storyId` field: which document is in the path, so a body cannot ask
 * for a link to something other than the document whose gate was just checked. And
 * no `createdBy` — "who made this link" is not a value anybody should be able to
 * type, for the reason `CheckpointBody` and `ScheduleBody` both record.
 */
export const ShareCreateBody = v.object(
  {
    expiresInDays: v.optional(
      v.pipe(
        v.number('must be a number'),
        v.integer('must be a whole number of days'),
        v.minValue(1, 'must be 1 or greater'),
        v.maxValue(90, 'must be 90 or fewer'),
      ),
    ),
    /** What the editor calls it, for the list. "For Rachel's Friday review". */
    note: v.optional(bounded(200)),
  },
  OBJECT,
)

/** `?state=` on the share list. Absent means both, which is what "which links exist"
 * means; `live` is "what is outstanding right now" and is the interesting one. */
export function shareStateQuery(raw: string | undefined): 'live' | 'lapsed' | undefined {
  if (raw === undefined || raw === '') return undefined
  return parseOrThrow(v.picklist(['live', 'lapsed'], 'must be one of: live, lapsed'), raw, 'state')
}

export type LoginEmailInput = v.InferOutput<typeof LoginEmailBody>
export type UserCreateInput = v.InferOutput<typeof UserCreateBody>
export type UserPatchInput = v.InferOutput<typeof UserPatchBody>
export type TokenCreateInput = v.InferOutput<typeof TokenCreateBody>
export type ShareCreateInput = v.InferOutput<typeof ShareCreateBody>

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
export type AssetFolderCreateInput = v.InferOutput<typeof AssetFolderCreateBody>
export type AssetFolderPatchInput = v.InferOutput<typeof AssetFolderPatchBody>
export type AssetTagInput = v.InferOutput<typeof AssetTagBody>
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
 * and therefore the only ones the transform path in assets.ts will hand to the
 * Images binding: the raster formats it actually reads and writes.
 *
 * This is an allowlist rather than a screen because the stored value *is* the
 * served value on a public, currently unauthenticated route that published pages
 * point their `<img>` tags at. A stored `text/html` would be script running on
 * the site's own origin.
 *
 * Adding a type here is a deliberate act: it says the transform path can decode
 * and re-encode that type. To serve a type inline *without* transforming it, see
 * `SANDBOXED_CONTENT_TYPES`.
 */
export const SERVED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])

/**
 * Types served **inline but never transformed**, and never decoded by anything
 * on this origin.
 *
 * SVG is the whole set, and it sits apart from `SERVED_CONTENT_TYPES` because
 * the two properties that make it awkward are separate. It cannot be
 * transformed: it is vector, so a resize is meaningless, and the Images binding
 * has no business parsing attacker-supplied XML. And it cannot simply be
 * declared safe: an inline SVG on the site's own origin is a script-execution
 * vector the moment a browser is allowed to try.
 *
 * What makes serving it acceptable is that `serveAsset` already sends
 * `Content-Security-Policy: default-src 'none'; sandbox` and
 * `X-Content-Type-Options: nosniff` on **every** response from this route,
 * whatever the branch. A `sandbox` without `allow-scripts` forbids script, forms
 * and origin-privileged execution outright — the same defence GitHub and GitLab
 * serve user-uploaded SVG behind. So the file renders in an `<img>` and cannot
 * execute, and this split keeps that reasoning attached to the type rather than
 * to a reader's memory.
 *
 * What remains is a bug in the browser's own SVG parser, which neither `nosniff`
 * nor the sandbox helps with. That is the exposure the five raster decoders
 * above already carry, not a new one.
 */
export const SANDBOXED_CONTENT_TYPES: ReadonlySet<string> = new Set(['image/svg+xml'])

/** Every type this route will send with `content-disposition: inline`. */
export function isInlineContentType(type: string): boolean {
  return SERVED_CONTENT_TYPES.has(type) || SANDBOXED_CONTENT_TYPES.has(type)
}

/** What anything else is stored and served as: kept, but never rendered. */
export const DOWNLOAD_CONTENT_TYPE = 'application/octet-stream'

/**
 * The `content-type` of an upload, reduced to something safe to store and later
 * serve.
 *
 * Anything outside both allowlists — HTML, PDFs, and every other file a media
 * library might legitimately hold — is stored as `application/octet-stream`,
 * which is already what an absent header produces in assets.ts: the file is kept
 * and downloads rather than rendering. Refusing the upload outright would lose
 * the file over a header the client chose, and nothing needs the original
 * string: the only reader of the column is `isImageAsset` (core/values.ts),
 * which falls back to the filename extension.
 */
export function contentTypeHeader(raw: string | undefined): string {
  // Parameters (`; charset=…`) are not part of the type being allowlisted.
  const type = (raw ?? '').split(';')[0]!.trim().toLowerCase()
  return isInlineContentType(type) ? type : DOWNLOAD_CONTENT_TYPE
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
 * `storiesFor` will chunk any number of them, so this is not a technical
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
 * and looks like an empty site.
 *
 * Exported for one reason: `mcp/tools.ts` advertises this domain to a model in an
 * input schema, and an advertised list that drifts from this one is a refusal on
 * every call. `test/unit/mcp/tools.test.ts` pins the two together by value, which
 * needs the picklist itself rather than a second copy of its options. */
export const STORY_STATE = v.picklist(
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
 * (`../../docs/specs/foundation/pagination.md` decision 9).
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
 * `?parentId=` on `GET /api/v1/search` — the one caller `storyFilterQuery`
 * deliberately excludes it for (`:887-891` above) that actually wants it as a
 * filter rather than as a list's positional scope, because this route has no
 * positional scope of its own to lean on.
 *
 * Carries `StoryFilter.parentId`'s own absent-vs-null distinction over a query
 * string: absent means every level, `parentId=` (empty) means the top level
 * (`null`), and anything else names a specific parent.
 */
export function parentIdQuery(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  return raw === '' ? null : idParam('parentId', raw)
}

/**
 * `?routed=` on `GET /api/v1/search` — the other key `storyFilterQuery`
 * excludes. Absent means both routed and unrouted documents, matching
 * `StoryFilter.routed`'s own absent-means-both rule (`core/story.ts:250`).
 * Anything other than `true`/`false` is refused rather than defaulted, the same
 * choice `requireCursor` makes for a malformed cursor: a stale bookmark with a
 * typo here has no silently-correct answer.
 */
export function routedQuery(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined
  return (
    parseOrThrow(v.picklist(['true', 'false'], 'must be `true` or `false`'), raw, 'routed') ===
    'true'
  )
}

/* ------------------------------------------------------------ bulk writes --- */

/**
 * How many ids one selection may name, on either side.
 *
 * The same 500 a `?ids=` query is capped at, and it is a bound on *what a person can
 * have ticked* rather than a technical one: you can only tick what you can see, a
 * page at a time, and a list page is 200 rows at most. Past this, "select all
 * matching" is the shape that exists — it names no ids at all.
 */
const MAX_SELECTION_IDS = 500

const SELECTION_IDS = v.pipe(
  v.array(ID, 'must be an array of document ids'),
  v.minLength(1, 'must name at least one document'),
  v.maxLength(MAX_SELECTION_IDS, `must name ${MAX_SELECTION_IDS} documents or fewer`),
)

/**
 * The `StoryFilter` a select-all **captured**, as a body field rather than a query
 * string (`../../docs/specs/foundation/pagination.md` decision 9 — the third of the
 * three things that read this shape).
 *
 * Two keys `storyFilterQuery` never produces are readable here, and both are
 * deliberate: `parentId` (where `null` is the top level and absent is every level) and
 * `routed`. A list route states its scope positionally because for a list the scope is
 * an identity; a captured selection has only JSON, and it has to be able to count the
 * exact set the list header counted or the guard refuses every select-all Content
 * makes.
 */
const CAPTURED_FILTER = v.object(
  {
    parentId: v.nullish(ID),
    type: v.optional(TYPE_NAME),
    state: v.optional(STORY_STATE),
    q: v.optional(SEARCH_Q),
    locale: v.optional(LOCALE_CODE),
    routed: v.optional(v.boolean('must be true or false')),
  },
  OBJECT,
)

/**
 * A selection, in the two shapes `core/story.ts`'s `BulkSelection` describes:
 * `{ ids }`, or `{ all: true, filter, expected, exclude? }`.
 *
 * A union of two shapes rather than one object with everything optional, so a body
 * that names both an id list *and* a filter is **refused** rather than silently
 * reconciled: that client has not decided which selection it made, and guessing for
 * it means writing to a set nobody described.
 *
 * **`v.strictObject`, which nothing else in this file uses**, and this is the one
 * place it earns the departure. Everywhere else an undeclared key is stripped in
 * silence and that is right — a stale tab still sending `actor` is not asking for
 * anything (`CheckpointBody` says so). Here a stripped key changes *which documents
 * get written to*: `{ ids, expected }` would become a plain id list with the count
 * guard quietly dropped, and `{ all: true, filter, expected, ids }` would ignore the
 * ids entirely. Both are silent, both are wrong in the direction of doing more than
 * was asked.
 *
 * **`expected` is required with `all` and unrepresentable without it.** The count is
 * the guard, and an explicit id list needs none — the ids *are* the version of the
 * set, and one that has since been deleted is reported as a single named failure
 * rather than refusing the other eleven.
 */
const SELECTION = v.union(
  [
    v.strictObject(
      {
        all: v.literal(true, 'must be true'),
        filter: CAPTURED_FILTER,
        expected: v.pipe(
          v.number('must be a number'),
          v.integer('must be a whole number'),
          v.minValue(0, 'must be 0 or greater'),
        ),
        exclude: v.optional(
          v.pipe(
            v.array(ID, 'must be an array of document ids'),
            v.maxLength(MAX_SELECTION_IDS, `must name ${MAX_SELECTION_IDS} documents or fewer`),
          ),
        ),
      },
      OBJECT,
    ),
    v.strictObject({ ids: SELECTION_IDS }, OBJECT),
  ],
  'must be either { ids } or { all: true, filter, expected }',
)

/**
 * The job-control half of every bulk body, shaped exactly like `MigrateBody`,
 * `ReindexBody` and `RunSchedulesBody` because it is the same kind of run: batched,
 * resumable, safe to dry-run.
 *
 * `continueFrom` is an opaque cursor rather than an id, like the schedule sweep's and
 * for a related reason — it carries a second component, the count of documents the job
 * has already consumed against its ceiling. Screened for length here and decoded by
 * `runBulk`.
 */
const BULK_CONTROL = {
  selection: SELECTION,
  dryRun: v.optional(v.boolean('must be true or false')),
  continueFrom: v.nullish(
    v.pipe(v.string('must be a string'), v.maxLength(500, 'is not a pagination cursor')),
  ),
  batch: v.optional(
    v.pipe(
      v.number('must be a number'),
      v.integer('must be a whole number'),
      v.minValue(1, 'must be at least 1'),
      v.maxValue(200, 'must be 200 or fewer'),
    ),
  ),
}

/** `POST {base}/api/bulk/publish`, `/unpublish` and `/duplicate` — the three actions
 * that take no argument beyond the selection. */
export const BulkBody = v.object(BULK_CONTROL, OBJECT)

/**
 * `POST {base}/api/bulk/move`. `parentId` is **required** and nullable: null is the
 * top level, and leaving it out would make "move" mean "move to wherever you already
 * are", which is not an operation anybody asked for.
 *
 * `index` is where the first document lands among its new siblings; the rest follow it
 * in order. Absent is 0, which is the top.
 */
export const BulkMoveBody = v.object(
  {
    ...BULK_CONTROL,
    parentId: v.nullable(ID),
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
 * `POST {base}/api/bulk/delete`. `redirect` defaults to **true**, matching
 * `DELETE {base}/api/stories/:id?redirect=` (`../platform/redirects.md` decision 4):
 * a bulk delete has to leave the redirects a hundred single deletes would, and the
 * escape hatch is for a page that should genuinely 404.
 *
 * In the body rather than the query string, unlike the single-document route, because
 * everything else about a bulk call is in the body and a caller assembling one should
 * not have to know that one parameter went somewhere else.
 */
export const BulkDeleteBody = v.object(
  { ...BULK_CONTROL, redirect: v.optional(v.boolean('must be true or false')) },
  OBJECT,
)

export type BulkInput = v.InferOutput<typeof BulkBody>
export type BulkMoveInput = v.InferOutput<typeof BulkMoveBody>
export type BulkDeleteInput = v.InferOutput<typeof BulkDeleteBody>

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
 * `core/assets.ts`'s `AssetSort` carries which direction each one runs in and why
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
 * `?folder=` on the asset list — a folder **`path`**, not an id, because the
 * filter is a range over `asset_folders.path` and includes descendants
 * (`../content-model/media-library.md` decision 3 and checkpoint 10). It is what
 * a captured *select all* stores too, which is why the URL carries the path
 * rather than an id a later delete could invalidate.
 *
 * Not `bounded()`, which trims: a trimmed path is a *different* path, and one
 * with a trailing space would silently find its neighbour. No leading or trailing
 * slash and no empty segment either — `asset-folders.ts` writes none, so asking
 * for `/clients/` is a client bug worth surfacing rather than normalising.
 *
 * The segment shape is "anything but a slash or whitespace" rather than an ASCII
 * slug charset: `slugify` keeps `\p{Letter}` and `\p{Number}`, so a folder called
 * `Café` slugifies to `café` and an ASCII-only screen would refuse to filter by
 * a folder Folio itself created.
 */
const ASSET_FOLDER_PATH = v.pipe(
  v.string('must be a string'),
  v.maxLength(1024, 'must be 1024 characters or fewer'),
  v.regex(PRINTABLE, 'contains unsupported characters'),
  v.regex(/^[^/\s]+(\/[^/\s]+)*$/u, 'is not a folder path'),
)

export function folderQuery(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  return parseOrThrow(ASSET_FOLDER_PATH, raw, 'folder')
}

/**
 * One `?tags=` value: a tag **slug**, which is the identity
 * (`../content-model/media-library.md` decision 4).
 *
 * The charset is `tagSlug`'s own output — anything printable with no whitespace
 * in it — rather than an ASCII slug screen, for `ASSET_FOLDER_PATH`'s reason:
 * `tagSlug` lowercases and strips whitespace but keeps letters, so a tag called
 * `Café` is `café` and an ASCII-only screen would refuse to filter by a tag Folio
 * itself minted.
 */
const ASSET_TAG_SLUG = v.pipe(
  v.string('must be a string'),
  v.maxLength(60, 'must be 60 characters or fewer'),
  v.regex(PRINTABLE, 'contains unsupported characters'),
  v.regex(/^\S+$/u, 'is not a tag'),
)

/**
 * `?tags=` on the asset list, repeated once per tag and **ANDed** by
 * `assetFilterSql`.
 *
 * Each value is put through `tagSlug` before it is screened, so `?tags=Headshots`
 * finds the tag whose slug is `headshots`. That is not leniency for its own sake:
 * the slug is the identity precisely so that what somebody typed and what is
 * stored do not have to match, and a URL a person edited by hand is exactly the
 * place that shows up.
 *
 * The count is capped here as well as inside `assetFilterSql`, and neither is
 * redundant: this turns nine chips into a 400 that names the limit, while the
 * composer is what stops a captured *select all* — which never passes through a
 * query string — from binding past `D1_BIND_CAP`.
 */
export function tagsQuery(raw: string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const slugs = [...new Set(raw.map((value) => tagSlug(value)).filter((value) => value !== ''))]
  if (slugs.length === 0) return undefined
  if (slugs.length > MAX_TAG_FILTER) {
    throw new FolioError('bad_request', `tags must name ${MAX_TAG_FILTER} tags or fewer`)
  }
  return slugs.map((slug) => parseOrThrow(ASSET_TAG_SLUG, slug, 'tags'))
}

/* ------------------------------------------------------ bulk asset writes --- */

/**
 * The `AssetFilter` a media-library select-all **captured**
 * (`../content-model/media-library.md` decision 6), as a body field rather than a
 * query string.
 *
 * Every member of `core/assets.ts`'s `AssetFilter` that a list route parses, and
 * **nothing more** — a filter key the composer ignores is a selection that means
 * something other than what it says. **`undescribed` and `failed` are here and
 * their clauses are in `assetFilterSql`, and each pair arrived together on
 * purpose**: this object is a `v.object`, so a key it does not declare is
 * *stripped in silence*, and a describe run whose "only the ones never
 * described" — or "only the ones that failed" — was stripped is the whole
 * library described again, every time, at the host's expense. The two mutual
 * exclusions the list route refuses with a 400 (`folder`/`unfiled`,
 * `tags`/`untagged`) are *not* re-checked here — `assetFilterSql` composes both
 * honestly and yields an empty set, which for a bulk write is the safest possible
 * reading of a contradictory request: it acts on nothing.
 *
 * `q` and `kind` are bounded here rather than trusted, because this shape reaches
 * `assetFilterSql` from a request body that never passed through the query-string
 * parser — the same reason `MAX_TAG_FILTER` is enforced inside the composer.
 */
const CAPTURED_ASSET_FILTER = v.object(
  {
    q: v.optional(bounded(200)),
    kind: v.optional(bounded(100)),
    folder: v.optional(ASSET_FOLDER_PATH),
    tags: v.optional(
      v.pipe(
        v.array(ASSET_TAG_SLUG, 'must be an array of tag slugs'),
        v.maxLength(MAX_TAG_FILTER, `must name ${MAX_TAG_FILTER} tags or fewer`),
      ),
    ),
    unfiled: v.optional(v.boolean('must be true or false')),
    untagged: v.optional(v.boolean('must be true or false')),
    undescribed: v.optional(v.boolean('must be true or false')),
    failed: v.optional(v.boolean('must be true or false')),
  },
  OBJECT,
)

/**
 * A selection of library rows, in the same two shapes `SELECTION` describes for
 * documents — and `v.strictObject` for the identical reason: a stripped key here
 * changes *which files get written to*, and one of the four actions deletes them.
 */
const ASSET_SELECTION = v.union(
  [
    v.strictObject(
      {
        all: v.literal(true, 'must be true'),
        filter: CAPTURED_ASSET_FILTER,
        expected: v.pipe(
          v.number('must be a number'),
          v.integer('must be a whole number'),
          v.minValue(0, 'must be 0 or greater'),
        ),
        exclude: v.optional(
          v.pipe(
            v.array(ID, 'must be an array of asset ids'),
            v.maxLength(MAX_SELECTION_IDS, `must name ${MAX_SELECTION_IDS} files or fewer`),
          ),
        ),
      },
      OBJECT,
    ),
    v.strictObject(
      {
        ids: v.pipe(
          v.array(ID, 'must be an array of asset ids'),
          v.minLength(1, 'must name at least one file'),
          v.maxLength(MAX_SELECTION_IDS, `must name ${MAX_SELECTION_IDS} files or fewer`),
        ),
      },
      OBJECT,
    ),
  ],
  'must be either { ids } or { all: true, filter, expected }',
)

/** The job-control half of every asset bulk body — `BULK_CONTROL` with the other
 * selection. Same fields, same bounds, same cursor rule. */
const ASSET_BULK_CONTROL = {
  selection: ASSET_SELECTION,
  dryRun: v.optional(v.boolean('must be true or false')),
  continueFrom: v.nullish(
    v.pipe(v.string('must be a string'), v.maxLength(500, 'is not a pagination cursor')),
  ),
  batch: v.optional(
    v.pipe(
      v.number('must be a number'),
      v.integer('must be a whole number'),
      v.minValue(1, 'must be at least 1'),
      v.maxValue(200, 'must be 200 or fewer'),
    ),
  ),
}

/**
 * `POST {base}/api/assets/bulk/tag` and `/untag`.
 *
 * `tagIds` is required and non-empty: "tag these forty files with nothing" is not
 * an operation, and defaulting it to the empty list would answer a placid report
 * of forty successes that changed nothing. Bounded by `MAX_ASSET_TAGS`, the same
 * ceiling `AssetPatchBody.tags` carries — `runAssetBulk` chunks its binds, so this
 * is a bound on the body rather than on the SQL.
 */
export const AssetBulkTagBody = v.object(
  {
    ...ASSET_BULK_CONTROL,
    tagIds: v.pipe(
      v.array(ID, 'must be an array of tag ids'),
      v.minLength(1, 'must name at least one tag'),
      v.maxLength(MAX_ASSET_TAGS, `must name ${MAX_ASSET_TAGS} tags or fewer`),
    ),
  },
  OBJECT,
)

/**
 * `POST {base}/api/assets/bulk/move`. `folderId` is **required and nullable**:
 * `null` is *Unfiled*, a real destination, and leaving it out would make "move"
 * mean "move to wherever you already are" — which is not an operation anybody
 * asked for. Exactly `BulkMoveBody.parentId`'s rule, one level over.
 */
export const AssetBulkMoveBody = v.object(
  { ...ASSET_BULK_CONTROL, folderId: v.nullable(ID) },
  OBJECT,
)

/** `POST {base}/api/assets/bulk/delete`. Nothing beyond the selection: there is
 * no redirect switch to offer, because an asset has no path to redirect from. */
export const AssetBulkBody = v.object(ASSET_BULK_CONTROL, OBJECT)

/**
 * `POST {base}/api/assets/describe` — the batched enrichment run
 * (`../content-model/media-library.md` decision 10).
 *
 * The same selection and the same job control as a bulk write, with **one
 * deliberate difference: `batch` is capped at 25, not 200.** A batch here is N
 * calls to somebody else's model API rather than N D1 writes, and 200 of those
 * do not fit in a Worker's wall-clock budget — see `MAX_DESCRIBE_BATCH`
 * (`describe.ts`), whose value this is. Written as a literal rather than
 * imported, exactly as `ASSET_BULK_CONTROL` writes 200: `describe.ts` imports
 * `clampText` from this file, and importing a `const` back the other way is a
 * cycle whose failure mode is a module-evaluation `ReferenceError` that depends
 * on which file the bundler reaches first.
 *
 * No `concurrency` and no per-run overrides of anything else in `describe`: the
 * rate at which a host's money is spent is a **configuration** decision made
 * once at construction, not something a request body may raise.
 */
export const AssetDescribeBody = v.object(
  {
    selection: ASSET_SELECTION,
    dryRun: v.optional(v.boolean('must be true or false')),
    continueFrom: v.nullish(
      v.pipe(v.string('must be a string'), v.maxLength(500, 'is not a pagination cursor')),
    ),
    batch: v.optional(
      v.pipe(
        v.number('must be a number'),
        v.integer('must be a whole number'),
        v.minValue(1, 'must be at least 1'),
        v.maxValue(25, 'must be 25 or fewer'),
      ),
    ),
  },
  OBJECT,
)

export type AssetBulkTagInput = v.InferOutput<typeof AssetBulkTagBody>
export type AssetBulkMoveInput = v.InferOutput<typeof AssetBulkMoveBody>
export type AssetBulkInput = v.InferOutput<typeof AssetBulkBody>
export type AssetDescribeInput = v.InferOutput<typeof AssetDescribeBody>

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

/* ---------------------------------------------------------------- forms --- */

/**
 * A form id from a path param, on the admin routes **and on the public submit
 * route** (`../../docs/specs/content-model/forms.md` architecture decision 3).
 *
 * Anchored to the mint format the way `ASSET_KEY` is, and for the same reason
 * its header gives: `{base}/f/:id` is public and unauthenticated, and a
 * parameter screened by charset rather than by shape is a primitive somebody
 * finds a use for. Ids are minted `frm_<12 hex>` and nothing else is a form.
 */
const FORM_ID = v.pipe(
  v.string('must be a string'),
  v.regex(/^frm_[0-9a-f]{12}$/, 'must be a Folio form id'),
)

export function formIdParam(raw: string | undefined): string {
  return parseOrThrow(FORM_ID, raw, 'id')
}

/**
 * `?ids=` on `GET {base}/api/forms/resolved` — `idListQuery`'s screen with
 * `FORM_ID` in place of `ID`, and it exists rather than reusing that one for the
 * reason `FORM_ID` exists at all: an id list that reaches a statement binding it
 * should be screened by mint format, not by charset.
 */
export function formIdListQuery(raw: string | undefined): string[] {
  return listQuery(raw, 'ids', (value, label) => parseOrThrow(FORM_ID, value, label))
}

/**
 * `?page=` on the same route: the URL of the page the descriptor is being
 * compiled for, which becomes its `_folio_page` hidden input.
 *
 * A host's `route()` answers this, so it is whatever that function returns — a
 * path today, an absolute URL for a host that emits one — and neither shape is
 * ours to insist on. Bounded and screened for control characters, no more.
 */
const FORM_PAGE = v.pipe(
  v.string('must be a string'),
  v.maxLength(2048, 'must be 2048 characters or fewer'),
  v.regex(PRINTABLE, 'contains unsupported characters'),
)

export function formPageQuery(raw: string): string {
  return parseOrThrow(FORM_PAGE, raw, 'page')
}

/** A response id from a path param. `res_<12 hex>`, anchored the way `FORM_ID`
 *  is — these routes are behind `FORMS`, but a screened-by-charset id parameter
 *  on a route that reads rows keyed by it is the same primitive either way. */
const RESPONSE_ID = v.pipe(
  v.string('must be a string'),
  v.regex(/^res_[0-9a-f]{12}$/, 'must be a Folio response id'),
)

export function responseIdParam(raw: string | undefined): string {
  return parseOrThrow(RESPONSE_ID, raw, 'rid')
}

/**
 * A form field's slug from a path param — the `:name` in the gated download
 * route, which names the *question* rather than the object, because one question
 * holds one file (`../../docs/specs/content-model/forms.md` decision 15).
 *
 * **The R2 key is deliberately not what the URL carries.** A route taking a key
 * would be a route whose parameter is a bucket path, and the thing it reads back
 * would be whatever that path names; a field slug can only be looked up inside a
 * response the caller already named, so the object served is one this response
 * actually holds. Same shape as `core/forms.ts`'s own `NAME`.
 */
const FIELD_NAME = v.pipe(
  v.string('must be a string'),
  v.regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be a field name'),
)

export function fieldNameParam(raw: string | undefined): string {
  return parseOrThrow(FIELD_NAME, raw, 'name')
}

/**
 * How many choices one `select`, `radio` or `checkboxes` question may offer.
 *
 * A request-size bound rather than a model one, which is why it lives here and
 * not beside `MAX_FORM_FIELDS` in `core/forms.ts`: `validateFormFields` decides
 * what a *form* may be, and this decides how much JSON one PATCH may carry into
 * a D1 column. A hundred options is a country list; more is a mistake or a
 * script.
 */
const MAX_FORM_OPTIONS = 100

/**
 * One question, bounded. Every string cap here exists for the reason this file
 * exists: they bound what reaches `forms.fields` before the write.
 *
 * **`kind` is `bounded`, not a picklist, and that is deliberate.** Screening the
 * kinds is `validateFormFields`' job and its rule is to *drop* one this build
 * does not know rather than refuse the save (`parseScopes`' posture). A picklist
 * here would turn that narrowing into a 400 and put the same list in two places
 * for the two to drift.
 */
const FORM_FIELD = v.object(
  {
    name: required(64),
    kind: required(32),
    label: required(200),
    help: v.optional(bounded(500)),
    placeholder: v.optional(bounded(200)),
    required: v.optional(v.boolean()),
    max: v.optional(v.pipe(v.number(), v.finite())),
    min: v.optional(v.pipe(v.number(), v.finite())),
    pattern: v.optional(bounded(200)),
    options: v.optional(
      v.pipe(
        v.array(v.object({ value: required(120), label: v.optional(bounded(200)) }, OBJECT)),
        v.maxLength(MAX_FORM_OPTIONS, `must be ${MAX_FORM_OPTIONS} options or fewer`),
      ),
    ),
    accept: v.optional(bounded(32)),
    maxBytes: v.optional(v.pipe(v.number(), v.finite())),
    value: v.optional(bounded(2000)),
    text: v.optional(bounded(2000)),
    i18n: v.optional(
      v.record(
        LOCALE_CODE,
        v.object(
          {
            label: v.optional(bounded(200)),
            help: v.optional(bounded(500)),
            placeholder: v.optional(bounded(200)),
            options: v.optional(v.record(bounded(120), bounded(200))),
          },
          OBJECT,
        ),
      ),
    ),
  },
  OBJECT,
)

/**
 * The whole field array. Bounded at `MAX_FORM_FIELDS` here as well as in
 * `validateFormFields`, which is not a duplicated rule so much as the same one
 * asked at two different times: this refuses the *request* before it is parsed
 * into anything, and the core function refuses the *form*.
 */
const FORM_FIELDS = v.pipe(
  v.array(FORM_FIELD, 'must be an array of fields'),
  v.maxLength(MAX_FORM_FIELDS, `must be ${MAX_FORM_FIELDS} fields or fewer`),
)

/**
 * `{ label, name? }`. `name` is capped before `formSlug`, which truncates its
 * own output to 64 — the cap is so an unbounded string is never slugified, not a
 * description of the stored value.
 */
export const FormCreateBody = v.object(
  { label: required(200), name: v.optional(bounded(200)) },
  OBJECT,
)

/**
 * A builder save. `expectedUpdatedAt` is **required and never optional**: it is
 * the whole of this table's concurrency story (decision 18), and a client that
 * may omit it is a client that omits it.
 *
 * `closesAt` and `redirectTo` are nullable *and* optional, and the two mean
 * different things — absent is "leave it alone", an explicit `null` is "clear
 * it". Without the distinction there is no way to remove a closing date at all.
 */
export const FormPatchBody = v.object(
  {
    expectedUpdatedAt: v.pipe(v.number('must be a number'), v.finite()),
    label: v.optional(required(200)),
    name: v.optional(bounded(200)),
    fields: v.optional(FORM_FIELDS),
    open: v.optional(v.boolean()),
    closesAt: v.optional(v.nullable(v.pipe(v.number(), v.finite()))),
    successMessage: v.optional(bounded(500)),
    closedMessage: v.optional(bounded(500)),
    submitLabel: v.optional(bounded(60)),
    /** A path on this site or an absolute URL, the same latitude
     *  `RedirectCreateBody.to` takes. */
    redirectTo: v.optional(v.nullable(bounded(2000))),
  },
  OBJECT,
)

export type FormCreateInput = v.InferOutput<typeof FormCreateBody>
export type FormPatchInput = v.InferOutput<typeof FormPatchBody>

/** An epoch-millisecond bound off a query string. */
const TIMESTAMP = v.pipe(v.string(), v.transform(Number), v.number(), v.finite())

/**
 * `?from=`, `?to=` and `?q=` on the responses table and on the CSV export, which
 * honours the same filter the table is showing (decision 16). One parser, so the
 * two cannot narrow to different sets.
 *
 * Structurally typed on `query` for the reason `parseBody` is: this file stays
 * free of Hono.
 */
export function responseFilterQuery(req: {
  query: (key: string) => string | undefined
}): ResponseFilter {
  const filter: ResponseFilter = {}
  const from = req.query('from')
  const to = req.query('to')
  const q = req.query('q')
  if (from !== undefined && from !== '') filter.from = parseOrThrow(TIMESTAMP, from, 'from')
  if (to !== undefined && to !== '') filter.to = parseOrThrow(TIMESTAMP, to, 'to')
  // Trimmed and bounded rather than refused, the `limit` side of this file's
  // asymmetry: a 300-character search term is a paste accident with an obvious
  // right answer, and truncating one leaves a client in no state at all.
  const term = q?.trim().slice(0, 200)
  if (term) filter.q = term
  return filter
}

/* -------------------------------------------------- bulk response writes --- */

/**
 * The `ResponseFilter` a select-all **captured**, as a body field rather than a
 * query string.
 *
 * Every member `responseFilterQuery` produces and **nothing more** — a filter key
 * the composer ignores is a selection that means something other than what it
 * says. `q` is bounded here rather than trusted, because this shape reaches
 * `responseFilterSql` from a request body that never passed through the
 * query-string parser; the two bounds are the same 200 characters, which is what
 * lets a captured filter count the same set the header counted.
 */
const CAPTURED_RESPONSE_FILTER = v.object(
  {
    from: v.optional(v.pipe(v.number('must be a number'), v.finite())),
    to: v.optional(v.pipe(v.number('must be a number'), v.finite())),
    q: v.optional(bounded(200)),
  },
  OBJECT,
)

/**
 * A selection of responses, in the same two shapes `SELECTION` and
 * `ASSET_SELECTION` describe — and `v.strictObject` for their reason, which is
 * sharper here than in either: a stripped key changes *which rows get deleted*,
 * and the only action this selection has is a delete.
 *
 * The ids are `res_<12 hex>`, screened by their mint format rather than by the
 * generic `ID` the other two use: this body reaches a statement that binds them,
 * and `RESPONSE_ID`'s anchoring is the same property `formIdParam`'s header
 * argues for one route up.
 */
const SELECTION_RESPONSE_IDS = v.pipe(
  v.array(RESPONSE_ID, 'must be an array of response ids'),
  v.maxLength(MAX_SELECTION_IDS, `must name ${MAX_SELECTION_IDS} responses or fewer`),
)

const RESPONSE_SELECTION = v.union(
  [
    v.strictObject(
      {
        all: v.literal(true, 'must be true'),
        filter: CAPTURED_RESPONSE_FILTER,
        expected: v.pipe(
          v.number('must be a number'),
          v.integer('must be a whole number'),
          v.minValue(0, 'must be 0 or greater'),
        ),
        exclude: v.optional(SELECTION_RESPONSE_IDS),
      },
      OBJECT,
    ),
    v.strictObject(
      {
        ids: v.pipe(SELECTION_RESPONSE_IDS, v.minLength(1, 'must name at least one response')),
      },
      OBJECT,
    ),
  ],
  'must be either { ids } or { all: true, filter, expected }',
)

/**
 * `POST {base}/api/forms/:id/responses/delete`. Nothing beyond the selection and
 * the job control: there is one action, and a response has no path to redirect
 * from and no folder to move to.
 */
export const ResponseBulkBody = v.object(
  {
    selection: RESPONSE_SELECTION,
    dryRun: v.optional(v.boolean('must be true or false')),
    continueFrom: v.nullish(
      v.pipe(v.string('must be a string'), v.maxLength(500, 'is not a pagination cursor')),
    ),
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

export type ResponseBulkInput = v.InferOutput<typeof ResponseBulkBody>

/* ------------------------------------------------------ form submissions --- */

/**
 * How many keys one submission body may carry.
 *
 * A request-size bound, like `MAX_FORM_OPTIONS` above and for the same reason: a
 * form has at most `MAX_FORM_FIELDS` questions, and a real browser adds the
 * honeypot, `_folio_page`, the submit button's name and whatever a password
 * manager injected — a couple of dozen in the worst honest case. Two hundred is
 * generous for that and a hard stop for a body of three thousand one-character
 * keys, which the byte cap alone would allow.
 *
 * **This is the one input on a public, unauthenticated write path**
 * (`{base}/f/:id`), so the bound is on the *count* as well as on the bytes: the
 * map built from it is sized by whoever posted.
 */
export const MAX_SUBMISSION_KEYS = 200

/**
 * The ceiling on one answer's characters, whatever `max` the builder set on the
 * question.
 *
 * Two caps rather than one, deliberately: the question's own `max` is what an
 * editor promised a visitor, and this is what the column will take from a
 * stranger. A question with no `max` is bounded by this; a question whose `max`
 * is larger does not raise it.
 */
export const MAX_ANSWER_CHARS = 10_000

/**
 * `PRINTABLE`'s screen with the three whitespace controls a `textarea` carries
 * legitimately allowed back in.
 *
 * Written as an alternation rather than by subtracting from the negated class,
 * because there is no subtraction to write: `[^\p{Cc}\n]` still excludes every
 * control including the newline, so the three have to be admitted by a second
 * branch rather than carved out of the first.
 */
const PRINTABLE_MULTILINE = /^(?:[^\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]|[\n\r\t])*$/u

/**
 * Whether one submitted answer holds only characters a stored string may hold.
 *
 * The same screen every other typed value in this file gets, with one difference
 * that has to be made per question rather than per file: a `textarea` answer with
 * newlines in it is a paragraph, and the identical string under a `text` question
 * is somebody trying to make one stored value look like two.
 */
export function isPrintableAnswer(raw: string, multiline: boolean): boolean {
  return (multiline ? PRINTABLE_MULTILINE : PRINTABLE).test(raw)
}

/**
 * Whether this request wants JSON rather than a browser's redirect.
 *
 * Two conditions because there are two callers with different clients: a script
 * that sets `accept: application/json`, and one that sets no `accept` worth
 * reading but posts a JSON body. A browser navigating a `<form>` sends
 * `accept: text/html,…` and matches neither, which is the case that must never
 * be answered with JSON — a visitor with scripting off would be looking at a
 * page of it (`../../docs/specs/content-model/forms.md` decision 5).
 */
export function wantsJson(req: { headers: Headers }): boolean {
  const accept = req.headers.get('accept') ?? ''
  if (accept.includes('application/json')) return true
  return !accept.includes('text/html') && (req.headers.get('content-type') ?? '').includes('json')
}
