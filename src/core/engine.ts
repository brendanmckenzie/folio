/**
 * The engine surface: the mutation log itself (`Mutation`, `apply`/`invert`/
 * `diff`), the sync and iframe wire protocols, and the doc walkers.
 *
 * Who imports what: Folio's own admin, server and preview modules deep-import
 * the leaf files directly (they live in this package; a self-referencing
 * `folio/engine` import would only launder the same paths). This entry exists
 * for HOST-SIDE TOOLING that legitimately needs to manipulate documents —
 * bulk-import scripts, content migrations — and for tests of embedding apps.
 * Ordinary block/host code has no business here: calling `apply` outside a
 * transaction bypasses the mutation log, which means no sync, no undo and no
 * multiplayer. If you only define blocks and render pages, `folio/core` is
 * the whole contract.
 */

// Shared document shape, re-exported here (as well as from `folio/core`) so
// engine consumers can type a `Doc` without a second import just for that.
export type { Blok, Doc, Json } from './doc'

export { ancestorsOf, childrenOf, compareSiblings, keyAtIndex, newUid, subtree } from './doc'

export { apply, applyAll, invert, invertAll, mutationError } from './mutations'
export type { Mutation } from './mutations'

export { deepEqual, diff, summariseDiff } from './diff'

// `blankBlok` needs `SchemaIndex` to look up a type's field defaults; re-exported
// here for the same reason `Doc`/`Blok`/`Json` are.
export type { SchemaIndex } from './schema'
export { blankBlok } from './schema'

export {
  PROTOCOL_VERSION,
  docCapError,
  fallbackColour,
  isBlok,
  isMutation,
  isClientMsg,
  isPreviewMsg,
  parseClientFrame,
  txCapError,
  MAX_ACTOR_LEN,
  MAX_DOC_BLOKS,
  MAX_DOC_BYTES,
  MAX_FRAME_BYTES,
  MAX_NAME_LEN,
  MAX_SELECTION_LEN,
  MAX_TX_MUTATIONS,
} from './protocol'
export type {
  AdminToPreviewMsg,
  ClientFrame,
  ClientMsg,
  Delta,
  Framed,
  Presence,
  PreviewFrame,
  PreviewMsg,
  PreviewMsgSource,
  PreviewToAdminMsg,
  ServerFrame,
  ServerMsg,
} from './protocol'
