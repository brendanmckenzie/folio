import type { Blok, Doc } from './doc'
import type { Mutation } from './mutations'

/**
 * Wire format version, carried by every frame in both directions. Persisted logs
 * already outlive deploys and the wire format will too, so a peer that speaks a
 * version we do not recognise is refused at the handshake rather than guessed at.
 */
export const PROTOCOL_VERSION = 1

export interface Presence {
  actor: string
  name: string
  colour: string
  selection: string | null
}

export type ClientMsg =
  | { type: 'hello'; actor: string; name: string; colour: string; lastSyncId: number }
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

/** A `hello` name or actor longer than this is truncated, not rejected. */
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
 */
function normalizeHello(actor: string, name: string, colour: string) {
  const cleanActor = stripControlChars(actor).slice(0, MAX_ACTOR_LEN)
  const trimmedName = stripControlChars(name).trim().slice(0, MAX_NAME_LEN)
  return {
    actor: cleanActor,
    name: trimmedName.length > 0 ? trimmedName : 'Anonymous',
    colour: COLOUR_RE.test(colour) ? colour : fallbackColour(cleanActor),
  }
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
    isRecord(x.data)
  )
}

export function isMutation(x: unknown): x is Mutation {
  if (!isRecord(x)) return false
  switch (x.t) {
    case 'set':
      // An explicit null is a value; an absent key is a malformed mutation.
      return isString(x.uid) && isString(x.field) && 'value' in x
    case 'insert':
      return isBlok(x.blok)
    case 'move':
      return isString(x.uid) && isString(x.parent) && isString(x.slot) && isString(x.order)
    case 'remove':
      return isString(x.uid)
    default:
      return false
  }
}

export function isClientMsg(x: unknown): x is ClientFrame {
  if (!isRecord(x)) return false
  if (x.v !== undefined && !isNumber(x.v)) return false
  switch (x.type) {
    case 'hello':
      return isString(x.actor) && isString(x.name) && isString(x.colour) && isNumber(x.lastSyncId)
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
 * would reach a broadcast. `hello`'s identity fields are capped and defaulted
 * here too, since every field it asserts rides on every peer's presence list
 * for as long as the socket is open.
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
      const { actor, name, colour } = normalizeHello(value.actor, value.name, value.colour)
      const { lastSyncId } = value
      return { type: 'hello', actor, name, colour, lastSyncId, ...version }
    }
    case 'tx':
      return { type: 'tx', txId: value.txId, mutations: value.mutations, ...version }
    case 'presence':
      return { type: 'presence', selection: normalizeSelection(value.selection), ...version }
  }
}
