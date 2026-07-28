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

/** The frame `raw` carries, or null if it is unreadable. Never throws. */
export function parseClientFrame(raw: string | ArrayBuffer): ClientFrame | null {
  if (typeof raw !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  return isClientMsg(value) ? value : null
}
