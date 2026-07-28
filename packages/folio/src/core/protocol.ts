import type { Doc } from './doc'
import type { Mutation } from './mutations'

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
  | ({ type: 'delta' } & Delta)
  | { type: 'presence'; peer: Presence; gone?: boolean }

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
