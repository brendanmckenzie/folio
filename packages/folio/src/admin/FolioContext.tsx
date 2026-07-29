import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react'
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
  /** Where Folio's routes are mounted, for uploads and the media library. */
  apiBase: string
  /**
   * Every document, flattened, so a link or a reference can be picked by name.
   * Includes unrouted ones: a `reference` to a record is the point of records,
   * even though a link to one can never resolve.
   */
  stories: readonly StoryNode[]
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
