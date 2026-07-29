import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react'
import type { LocaleConfig, LocaleContext, TranslationStatus } from '../core/locales'
import type { Resolution } from '../core/resolve'
import type { DocumentType, SchemaIndex } from '../core/schema'
import type { StoryNode } from '../core/story'
import type { StoreState, StoryStore } from './store'

/**
 * What every panel in the editor needs and none of it owns.
 *
 * These four travelled as props from Editor through Inspector, through each field
 * input, into LinkInput and out again into AssetInput — five components deep, none
 * of which read them, purely so the leaf could. A context is what that shape is.
 * It is deliberately small: only values that are the same for the whole editor
 * belong here, so anything a panel *owns* stays a prop.
 */
export interface FolioContextValue {
  store: StoryStore
  schema: SchemaIndex
  /** Every declared document type (`document-types.md`), off the manifest. What
   * labels a row, and what a picker filters against. */
  types: readonly DocumentType[]
  /** `FolioConfig.globals` (`../../../docs/specs/content-model/globals.md`),
   * off the manifest: the subset of `singleton` types the Globals rail lists. */
  globals: readonly string[]
  /** Where Folio's routes are mounted, for uploads and the media library. */
  apiBase: string
  /**
   * Every document, flattened, so a link or a reference can be picked by name.
   * Includes unrouted ones: a `reference` to a record is the point of records,
   * even though a link to one can never resolve.
   */
  stories: readonly StoryNode[]
  /**
   * The locale state, in the context rather than as props, for the reason this
   * whole file exists: the inspector, both trees and the preview bridge all read
   * one value, and none of the components between them cares
   * (`../../../docs/specs/content-model/localisation.md` phase 3).
   */
  locales: LocaleConfig | undefined
  /** Which locale the editor is currently in. The source locale on a site with
   * no locales configured, and on first load of one that has them. */
  locale: string
  /** `undefined` while the source locale is active — the same "no locale" the
   * renderer means, so the inspector's own reads take one code path. */
  localeCtx: LocaleContext | undefined
  /** True when the active locale is the source. Everything about the editor's
   * behaviour hinges on this one boolean. */
  isSourceLocale: boolean
  setLocale: (code: string) => void
  /**
   * The resolution the preview is rendered with, so the inspector's read-only
   * source column can render richtext with real formatting and real link hrefs —
   * which is the reason the source is a column rather than a placeholder (the
   * spec's resolved open question).
   */
  resolution: Resolution
  /**
   * How complete the **open** story's translation is in the active locale, or
   * null on the source locale.
   *
   * Computed from the draft the store already holds, so it is live per keystroke
   * and costs no request at all. Deliberately only the open story: badging every
   * row would be one `GET {base}/story/:id/translation` per row, and a tree of
   * two hundred pages is not a place to spend two hundred requests. That route
   * exists for a caller that wants one story's answer without opening it — a
   * translation dashboard, the content API — not for this list.
   */
  translation: TranslationStatus | null
}

const FolioCtx = createContext<FolioContextValue | null>(null)

export function FolioProvider({
  value,
  children,
}: {
  value: FolioContextValue
  children: ReactNode
}) {
  return <FolioCtx.Provider value={value}>{children}</FolioCtx.Provider>
}

export function useFolio(): FolioContextValue {
  const value = useContext(FolioCtx)
  if (!value) throw new Error('useFolio must be used inside a FolioProvider')
  return value
}

/** The document store's state, subscribed to. Safe to call from any panel. */
export function useStoreState(store: StoryStore): StoreState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
