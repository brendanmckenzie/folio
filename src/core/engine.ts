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

export {
  ancestorsOf,
  childrenOf,
  compareSiblings,
  keyAtIndex,
  keysBetween,
  newUid,
  subtree,
} from './doc'

/**
 * The nested document shape (`../../../docs/specs/platform/content-api.md`) — the
 * two functions the Storyblok importer (`PARITY-MCKINNON.md` Phase 6) and any
 * other bulk-import script build on, rather than reaching into the normalised
 * graph and allocating uids and fractional orders by hand. `folio/engine` is
 * exactly the entry point that doc comment above describes.
 */
export { fieldShapeError, fromNested, NestedError, toNested } from './nested'
export type {
  FromNestedOptions,
  NestedBlok,
  NestedDoc,
  NestedInput,
  NestedValue,
  ToNestedOptions,
} from './nested'

export { apply, applyAll, invert, invertAll, mutationError } from './mutations'
export type { Mutation } from './mutations'

export { deepEqual, diff, summariseDiff } from './diff'

/**
 * Content migrations (`../../../docs/specs/foundation/schema-migrations.md`) —
 * the use case this entry point's own doc comment already named. A host writes
 * `defineMigration({ id, description, up })` and reaches for `field` / `block`
 * for the ordinary cases, `ctx.each` plus `Blok`/`Mutation` by hand for the rest.
 */
export {
  block,
  defineMigration,
  field,
  latestMigrationId,
  migrateDoc,
  migrationContext,
  pendingFor,
  validateMigrations,
} from './migrate'
export type { Migration, MigrationContext } from './migrate'

// `cloneSubtree`/`cloneDoc` (duplicate-and-paste.md) build on `allocateSubtree`
// below: fresh uids and orders for an existing subtree, rather than a preset's
// recipe. `parseClipboard` validates untrusted clipboard text the same way a
// socket frame is validated — total over malformed input, refusing rather
// than throwing.
export { cloneDoc, cloneSubtree } from './clone'
export { parseClipboard } from './clipboard'
export type { ClipboardPayload, ParsedClipboard } from './clipboard'

// `blankBlok` needs `SchemaIndex` to look up a type's field defaults; re-exported
// here for the same reason `Doc`/`Blok`/`Json` are.
export type { SchemaIndex } from './schema'
export { blankBlok } from './schema'

// `allocateSubtree` is the uid-and-fractional-order primitive shared by a
// preset's recipe (`blankSubtree`, schema-aware) and `duplicate-and-paste.md`
// (an existing subtree's recipe) — engine work, since both allocate uids and
// orders rather than read a schema.
export {
  allocateSubtree,
  blankSubtree,
  validatePresets,
  validateGlobals,
  validateTypes,
} from './schema'
export type { SubtreeBlok } from './schema'

// `validateLocales` sits with the other construction-time validators; `fieldValue`
// and `dataOf` are re-exported here as well as from `folio/core` because a
// bulk-import or migration script writing `i18n` needs to read it back.
export { dataOf, validateLocales, fieldValue } from './locales'
export type { LocaleConfig, LocaleContext } from './locales'

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
  HelloIdentity,
  Presence,
  PreviewFrame,
  PreviewMsg,
  PreviewMsgSource,
  PreviewToAdminMsg,
  ServerFrame,
  ServerMsg,
} from './protocol'
