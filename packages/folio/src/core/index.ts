/**
 * Public surface for block authors and hosts: schema, fields, resolution and
 * rendering helpers, story utilities. Nothing here touches the mutation log —
 * a host wiring up blocks and rendering resolved values never needs to reach
 * further than this file; anything that mutates or syncs a `Doc` lives in
 * `folio/engine` instead.
 */

export { defineBlock, defineRecord, toRegistry, toSchemaIndex, toManifest } from './block'
export type { AnyBlockDef, BlockDef, Registry } from './block'

export { matches } from './conditions'
export type { FieldCondition } from './conditions'

export {
  asset,
  blocks,
  boolean,
  collection,
  multiasset,
  multilink,
  number,
  reference,
  references,
  richtext,
  select,
  text,
  textarea,
  defaultValue,
} from './fields'
export type { Field, PropsOf, SelectOption, ValueOf } from './fields'

// Collections (`../../../docs/specs/content-model/collections.md`). A block author
// needs `ResolvedCollection` to type what `collection()` hands `render`; a host
// writing its own filtered archive route needs `ContentQuery` and `ContentPage`.
// The SQL is `folio/server`'s.
export {
  BUILT_IN_ORDERS,
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  collectionQueries,
  collectionQuery,
  emptyContentPage,
  isRangeOp,
  isTextOp,
  normaliseQuery,
  queryKey,
  WHERE_OPS,
} from './query'
export type {
  CollectionField,
  CollectionValue,
  ContentOrder,
  ContentOrderSpec,
  ContentPage,
  ContentQuery,
  ContentWhere,
  RangeOp,
  ResolvedCollection,
  TextOp,
} from './query'

// The publish-time projection and the outbound-edge walk. Exported because a host
// importer or a one-off script that writes `published_doc` directly has to be able
// to write the same index rows a publish would.
export { indexedFieldNames, indexedFields, indexRowsFor, isIndexed } from './index-projection'
export type { IndexRow } from './index-projection'
export { linkedIds, outboundRefs, referencedIdsAllLocales } from './refs'
export type { OutboundRef } from './refs'

export {
  asAsset,
  asAssets,
  asLink,
  asStoryIds,
  isImageAsset,
  isLinkEmpty,
  isSafeHref,
  LINK_KINDS,
} from './values'
export type { AssetValue, FocalPoint, LinkKind, LinkValue } from './values'

export {
  asRichtext,
  EMPTY_DOC,
  fromPlainText,
  isRichtextEmpty,
  richtextToText,
  sanitiseRichtext,
  RICHTEXT_MARKS,
  RICHTEXT_NODES,
} from './richtext'
export type {
  RichtextDoc,
  RichtextLimits,
  RichtextMark,
  RichtextMarkName,
  RichtextNode,
  RichtextNodeName,
} from './richtext'

export {
  buildResolution,
  DEFAULT_ASSET_BASE,
  EMPTY_RESOLUTION,
  referencedIds,
  resolveAsset,
  resolveAssets,
  resolveCollection,
  resolveLink,
  resolveReference,
  resolveReferences,
  resolveValue,
} from './resolve'
export type {
  AssetTransform,
  ReferenceTarget,
  Resolution,
  ResolvedAsset,
  ResolvedLink,
  ResolvedReference,
  StoryRef,
} from './resolve'

// Reader types only: `Doc`/`Blok` describe the shape a resolver or renderer
// reads, but walking or mutating one is engine work (see `folio/engine`).
export type { Blok, Doc, Json } from './doc'

// Locales (`localisation.md`) are core, not server: `fieldValue`/`dataOf` are how a
// host reads a field in the active language, and a block author needs them the
// moment they read a value off a root block rather than through `render`.
export {
  dataOf,
  isKnownLocale,
  isTranslatable,
  localeChain,
  localeContext,
  translatableFields,
  translationGaps,
  translationStatus,
  fieldValue,
} from './locales'
export type {
  LocaleConfig,
  LocaleContext,
  LocaleDef,
  TranslationGap,
  TranslationStatus,
} from './locales'

export {
  ancestorPaths,
  buildTree,
  derivePaths,
  descendants,
  joinPath,
  newStoryId,
  slugify,
} from './story'
export type { StoryMeta, StoryNode } from './story'

// Document types (`document-types.md`) are core, not server, config: the admin
// reads them off the manifest and a host's own code needs `isRouted`/`titleOf`
// to make sense of a `StoryMeta` it was handed.
export {
  canNest,
  defaultType,
  isRouted,
  SINGLETON_PREFIX,
  singletonId,
  titleFieldOf,
  titleOf,
  typeByName,
} from './schema'
export type {
  BlockPreset,
  BlockSchema,
  DocumentKind,
  DocumentType,
  Manifest,
  SchemaIndex,
} from './schema'

// The activity trail is a read model (who changed what, when), not a mutation
// primitive, so it ships with the public API even though it is defined
// alongside the sync wire in `protocol.ts`.
export type { ActivityEntry } from './protocol'
