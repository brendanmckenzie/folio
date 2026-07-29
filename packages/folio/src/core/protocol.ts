import type { Blok, Doc } from './doc'
import type { Mutation } from './mutations'
import type { Resolution } from './resolve'

/**
 * Wire format version, carried by every frame in both directions. Persisted logs
 * already outlive deploys and the wire format will too, so a peer that speaks a
 * version we do not recognise is refused at the handshake rather than guessed at.
 *
 * The rule every bump has to satisfy: **the mutation log outlives every deploy**,
 * so a change must be *additive* to a logged mutation and every entry already in
 * a log must replay under its old meaning forever. Bumping is how a peer finds
 * out it cannot read what this deploy sends, never a licence to reinterpret what
 * an older one wrote.
 *
 * | v | what changed |
 * | - | ------------ |
 * | 1 | the original: `set`, `insert`, `move`, `remove` |
 * | 2 | `Mutation` gains `retype` (`schema-migrations.md`) — a new variant, so a
 *       `set` written under v1 is still a `set` |
 * | 3 | `set` gains an optional `locale` (`localisation.md`), and `hello` sheds
 *       its three top-level identity fields. **A `set` with no `locale` is a
 *       source-locale write, permanently** — that is the whole of the
 *       compatibility story for this bump, and it is why the field is optional
 *       rather than required with a default written down somewhere. The bump is
 *       needed even so: a v2 *client* handed a locale-scoped delta would drop
 *       the locale and write the value into `data`, which is silent divergence,
 *       so it must be refused at the handshake instead. |
 */
export const PROTOCOL_VERSION = 3

export interface Presence {
  actor: string
  name: string
  colour: string
  selection: string | null
}

/**
 * An identity a client asserts about itself, and the **only** thing left of
 * `hello`'s old `actor`/`name`/`colour` trio (v3, `localisation.md`).
 *
 * Advisory by construction now rather than by comment. On a deployment with
 * accounts the Worker attaches a verified identity to the socket at upgrade time
 * (`identity-and-access.md` architecture decision 3) and the object ignores this
 * entirely — it does not merge, it does not prefer, it does not look. It is read
 * in exactly one situation: `auth: 'open'`, where there are no accounts and this
 * random pair is the only thing that tells two anonymous tabs apart in presence.
 *
 * Hence optional and nested: a client with a session need not send it at all,
 * and the shape of the frame says which case is which instead of three
 * always-present fields that are believed only sometimes.
 */
export interface HelloIdentity {
  actor: string
  name: string
  colour: string
}

export type ClientMsg =
  | { type: 'hello'; lastSyncId: number; identity?: HelloIdentity }
  | { type: 'tx'; txId: string; mutations: Mutation[] }
  | { type: 'presence'; selection: string | null }

export type ServerMsg =
  /** Full state. Sent when the client has no watermark or has fallen too far behind. */
  | { type: 'bootstrap'; doc: Doc; syncId: number; peers: Presence[] }
  /** Everything the client missed, replayed from the log. */
  | { type: 'catchup'; deltas: Delta[]; syncId: number; peers: Presence[] }
  /**
   * One logged transaction. `replay` marks the idempotent ack for a resend: it
   * carries the syncId that tx already had, so a client whose watermark has
   * moved past it must drop the frame rather than apply the mutations again.
   */
  | ({ type: 'delta'; replay?: true } & Delta)
  | { type: 'presence'; peer: Presence; gone?: boolean }
  /**
   * A transaction refused at the door: nothing was logged, nothing broadcast,
   * and the sender must drop it from `pending` rather than wait for a delta.
   */
  | { type: 'reject'; txId: string; reason: string }
  /** A frame the peer could not read, or a handshake it refused. */
  | { type: 'error'; reason: string }

/** A message body as it crosses the socket. */
export type Framed<T> = T & { v: number }

export type ServerFrame = Framed<ServerMsg>

/**
 * An inbound frame: a structurally valid body plus the version it claims. The
 * version is deliberately not checked by the shape guards, so a mismatch is
 * reported as itself instead of as an unreadable frame.
 */
export type ClientFrame = ClientMsg & { v?: number }

export interface Delta {
  syncId: number
  txId: string
  actor: string
  mutations: Mutation[]
}

/** One logged transaction, for the activity trail. */
export interface ActivityEntry {
  syncId: number
  actor: string
  actorName: string | null
  at: number
  mutations: Mutation[]
}

/*
 * Shape guards for the socket. Hand-rolled and total over `unknown`: the
 * WebSocket path takes no validation dependency, because a frame arriving from a
 * hibernated peer of unknown vintage must be answerable, never throwable. Field
 * *values* inside a `set` are whatever JSON.parse produced, which is Json by
 * construction and needs no walk.
 */

/** A `hello` identity's name longer than this is truncated, not rejected. */
export const MAX_NAME_LEN = 64

/** Same cap for `actor`: both ride on every presence broadcast for the life of the socket. */
export const MAX_ACTOR_LEN = 64

/** A presence `selection` is a uid reference; generous headroom over the 16-hex-char uids in use. */
export const MAX_SELECTION_LEN = 64

/**
 * Beyond this many mutations, one tx is refused at the door rather than admitted:
 * the per-mutation validation in `mutationError` walks the whole document once per
 * mutation, so an unbounded array is an unbounded amount of work per message.
 */
export const MAX_TX_MUTATIONS = 200

/**
 * Raw frame ceiling, checked in the DO before `JSON.parse`. A cheap stand-in for
 * capping every `set` value at 64KB individually: a tx holding an oversized value
 * has already produced an oversized frame, so bounding the frame bounds the value
 * without a walk over `mutations` on every message.
 */
export const MAX_FRAME_BYTES = 256 * 1024

/**
 * Ceiling on the whole document, in bloks. Per-frame caps (`MAX_TX_MUTATIONS`,
 * `MAX_FRAME_BYTES`) bound the cost and size of one message; nothing else bounds
 * what an unbounded run of admitted, individually-legal txs can grow the document
 * to, and every admitted tx already copies `doc.bloks` wholesale once per
 * mutation (`apply`) and serialises the whole document into the doc row. Checked
 * after a tx's mutations are applied, so it refuses growth the same way an
 * invalid mutation is refused: atomically, at the door, nothing logged.
 */
export const MAX_DOC_BLOKS = 20_000

/** Ceiling on the serialised document, in UTF-8 bytes. Same rationale as `MAX_DOC_BLOKS`. */
export const MAX_DOC_BYTES = 8 * 1024 * 1024

/**
 * Why `doc` cannot be admitted for its accumulated size, or null when it is
 * within both ceilings. `json`, when given, is the serialised form the caller
 * already produced for persistence — this only re-measures it, rather than
 * stringifying the document twice.
 */
export function docCapError(doc: Doc, json?: string): string | null {
  const count = Object.keys(doc.bloks).length
  if (count > MAX_DOC_BLOKS) {
    return `document too large: ${count} bloks exceeds the ${MAX_DOC_BLOKS} cap`
  }
  const bytes = new TextEncoder().encode(json ?? JSON.stringify(doc)).byteLength
  if (bytes > MAX_DOC_BYTES) {
    return `document too large: ${bytes} bytes exceeds the ${MAX_DOC_BYTES} byte cap`
  }
  return null
}

const COLOUR_RE = /^#[0-9a-fA-F]{6}$/

/** True for the C0 and DEL control characters a display name has no business carrying. */
const isControlChar = (code: number): boolean => code <= 0x1f || code === 0x7f

/**
 * True for the bidi overrides and isolates (U+202A-202E, U+2066-2069): the same
 * ranges validate.ts's PRINTABLE screens on the HTTP side, because they can
 * reorder a rendered name away from what was stored. A lone surrogate is not
 * screened here — `for...of` walks code points, so a broken half never appears
 * as its own character to test.
 */
const isBidiControl = (code: number): boolean =>
  (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)

/**
 * Drops control characters and bidi overrides instead of a regex: biome flags
 * literal control chars in a pattern, and every display name on the socket
 * (`hello.name`, `hello.actor`) rides on presence and the log's activity trail
 * for as long as the connection lives, same as every CMS string on the HTTP side.
 */
function stripControlChars(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (!isControlChar(code) && !isBidiControl(code)) out += ch
  }
  return out
}

/**
 * A colour the client cannot spoof by omission: deterministic in `actor` so every
 * peer that recomputes it (there is only ever one, the DO itself) lands on the
 * same value, and stable across reconnects since `actor` does not change.
 */
export function fallbackColour(actor: string): string {
  let hash = 0
  for (let i = 0; i < actor.length; i++) {
    hash = (Math.imul(hash, 31) + actor.charCodeAt(i)) | 0
  }
  return `#${(hash >>> 0).toString(16).padStart(6, '0').slice(0, 6)}`
}

/**
 * Caps and defaults the identity a `hello` asserts about itself. Not part of the
 * shape guard: these values are still a valid `hello` if oversized or malformed,
 * just not ones a broadcast should carry verbatim to every peer.
 *
 * Kept whole through the v3 bump that moved these three fields into an optional
 * `identity`: nothing about a name riding on every presence broadcast changed
 * because the frame's shape did, and `stripControlChars` is the same screening
 * `validate.ts`'s `PRINTABLE` applies on the HTTP side.
 */
function normalizeIdentity(identity: HelloIdentity | undefined): HelloIdentity | undefined {
  if (!identity) return undefined
  const actor = stripControlChars(identity.actor).slice(0, MAX_ACTOR_LEN)
  const trimmed = stripControlChars(identity.name).trim().slice(0, MAX_NAME_LEN)
  return {
    actor,
    name: trimmed.length > 0 ? trimmed : 'Anonymous',
    colour: COLOUR_RE.test(identity.colour) ? identity.colour : fallbackColour(actor),
  }
}

/** Shape guard for `hello.identity`; absent is valid, malformed is not. */
function isHelloIdentity(x: unknown): x is HelloIdentity {
  return isRecord(x) && isString(x.actor) && isString(x.name) && isString(x.colour)
}

/** Bounds a presence selection; `null` (no selection) passes through unchanged. */
function normalizeSelection(selection: string | null): string | null {
  return selection === null ? null : selection.slice(0, MAX_SELECTION_LEN)
}

/**
 * Why a tx cannot be admitted for its size alone, or null when it is within cap.
 * Deliberately separate from `isClientMsg`: the cap is rejected with a `reject`
 * envelope naming the sender's `txId`, which requires the frame to have parsed as
 * a structurally valid tx first — failing the shape guard instead would report it
 * as an unreadable frame and lose the txId a targeted reject depends on.
 */
export function txCapError(mutations: Mutation[]): string | null {
  return mutations.length > MAX_TX_MUTATIONS
    ? `too many mutations: ${mutations.length} exceeds the ${MAX_TX_MUTATIONS} cap`
    : null
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const isString = (x: unknown): x is string => typeof x === 'string'

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

export function isBlok(x: unknown): x is Blok {
  return (
    isRecord(x) &&
    isString(x.uid) &&
    isString(x.type) &&
    (x.parent === null || isString(x.parent)) &&
    (x.slot === null || isString(x.slot)) &&
    isString(x.order) &&
    isRecord(x.data) &&
    // Absent on every document written before locales existed, and on every
    // single-locale one. Checked one level deep only: a locale's field values are
    // whatever JSON.parse produced, which is `Json` by construction — the same
    // reason `data` itself needs no walk.
    (x.i18n === undefined || isLocaleMap(x.i18n))
  )
}

/** `Record<string, Record<string, Json>>`, shallowly. */
function isLocaleMap(x: unknown): boolean {
  return isRecord(x) && Object.values(x).every(isRecord)
}

export function isMutation(x: unknown): x is Mutation {
  if (!isRecord(x)) return false
  switch (x.t) {
    case 'set':
      // An explicit null is a value; an absent key is a malformed mutation.
      // An absent `locale` is a source-locale write and always legal — that is
      // the property every log entry written before v3 depends on. A `locale`
      // that is present must be a string; whether the *site* declares that code
      // is not a wire concern, for the same reason `retype` does not check the
      // schema (the object is deliberately ignorant of configuration).
      return (
        isString(x.uid) &&
        isString(x.field) &&
        'value' in x &&
        (x.locale === undefined || isString(x.locale))
      )
    case 'insert':
      return isBlok(x.blok)
    case 'move':
      return isString(x.uid) && isString(x.parent) && isString(x.slot) && isString(x.order)
    case 'remove':
      return isString(x.uid)
    case 'retype':
      return isString(x.uid) && isString(x.type)
    default:
      return false
  }
}

export function isClientMsg(x: unknown): x is ClientFrame {
  if (!isRecord(x)) return false
  if (x.v !== undefined && !isNumber(x.v)) return false
  switch (x.type) {
    case 'hello':
      return isNumber(x.lastSyncId) && (x.identity === undefined || isHelloIdentity(x.identity))
    case 'tx':
      return isString(x.txId) && Array.isArray(x.mutations) && x.mutations.every(isMutation)
    case 'presence':
      return x.selection === null || isString(x.selection)
    default:
      return false
  }
}

/**
 * The frame `raw` carries, or null if it is unreadable. Never throws.
 *
 * Rebuilds the message from only the fields each type declares rather than
 * returning the parsed value as-is: a guard that mirrors its input carries
 * forward whatever else a client's JSON had, which is exactly how junk keys
 * would reach a broadcast. `hello.identity`, when a client sends one, is capped
 * and defaulted here too, since every field it asserts rides on every peer's
 * presence list for as long as the socket is open.
 */
export function parseClientFrame(raw: string | ArrayBuffer): ClientFrame | null {
  if (typeof raw !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isClientMsg(value)) return null
  const version = value.v !== undefined ? { v: value.v } : {}
  switch (value.type) {
    case 'hello': {
      const identity = normalizeIdentity(value.identity)
      return {
        type: 'hello',
        lastSyncId: value.lastSyncId,
        ...(identity ? { identity } : {}),
        ...version,
      }
    }
    case 'tx':
      return { type: 'tx', txId: value.txId, mutations: value.mutations, ...version }
    case 'presence':
      return { type: 'presence', selection: normalizeSelection(value.selection), ...version }
  }
}

/*
 * ---------------------------------------------------------------------------
 * Admin <-> preview postMessage protocol.
 *
 * A second, unrelated wire: the admin and its preview iframe, talking over
 * `window.postMessage` instead of a socket. Same-origin is a hard requirement
 * here, not a courtesy check — both sides post with an explicit target origin
 * of `window.location.origin` and refuse anything whose `event.origin` is not
 * that origin, so a `previewUrl` (see core/story.ts, computed in a host's
 * `route` config) pointed at a different origin does not degrade gracefully,
 * it simply never talks to the editor at all. `v` rides on every frame for
 * the same reason it rides the socket: a mismatch should be visible, not
 * silently misapplied, even though in practice both ends of this channel are
 * the same deploy loaded a moment apart.
 * ---------------------------------------------------------------------------
 */

/** What the admin pushes into the preview: document state and where it stands. */
export type AdminToPreviewMsg =
  | { type: 'apply'; mutations: Mutation[] }
  | { type: 'replace'; doc: Doc }
  | { type: 'resolve'; resolution: Resolution }
  | { type: 'select'; uid: string | null }

/** What the preview reports back: handshake, picks, and add-block requests. */
export type PreviewToAdminMsg =
  | { type: 'ready' }
  | { type: 'select'; uid: string }
  | { type: 'add'; parent: string; slot: string }

/** Every shape that can cross the iframe boundary, in either direction. */
export type PreviewMsg = AdminToPreviewMsg | PreviewToAdminMsg

/** Tag on every frame identifying which side of the iframe sent it. */
export type PreviewMsgSource = 'folio-admin' | 'folio-preview'

/** A postMessage frame as it actually crosses the iframe boundary. */
export type PreviewFrame = Framed<PreviewMsg> & { source: PreviewMsgSource }

/**
 * Total over `unknown`, same discipline as `isClientMsg`: `event.data` on a
 * `message` listener is whatever the other side's JS handed to `postMessage`,
 * not JSON, so nothing here throws on a shape neither end would ever send.
 */
export function isPreviewMsg(x: unknown): x is PreviewMsg {
  if (!isRecord(x)) return false
  if (x.v !== undefined && !isNumber(x.v)) return false
  switch (x.type) {
    case 'apply':
      return Array.isArray(x.mutations) && x.mutations.every(isMutation)
    case 'replace':
      return isRecord(x.doc)
    case 'resolve':
      return isRecord(x.resolution)
    case 'select':
      // Admin-to-preview select may clear the selection; preview-to-admin
      // select always names a clicked block. One guard covers both: the
      // narrower requirement (a real uid) is enforced by direction, not shape.
      return x.uid === null || isString(x.uid)
    case 'ready':
      return true
    case 'add':
      return isString(x.parent) && isString(x.slot)
    default:
      return false
  }
}
