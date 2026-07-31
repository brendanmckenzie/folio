import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Blok, Doc } from '../../../core/doc'
import {
  type LocaleConfig,
  localeContext,
  translationGaps,
  translationStatus,
} from '../../../core/locales'
import { linkedIds, referencedIdsAllLocales } from '../../../core/refs'
import { buildResolution, type Resolution } from '../../../core/resolve'
import type { DocumentType, SchemaIndex } from '../../../core/schema'
import type { StoryMeta } from '../../../core/story'
import { useBlocks } from '../../hooks/useBlocks'
import { useClipboardShortcuts } from '../../hooks/useClipboardShortcuts'
import { useCollections } from '../../hooks/useCollections'
import { useGlobalDocs } from '../../hooks/useGlobalDocs'
import { useMigrations } from '../../hooks/useMigrations'
import { usePreviewBridge } from '../../hooks/usePreviewBridge'
import { usePublish } from '../../hooks/usePublish'
import { usePublishedDoc } from '../../hooks/usePublishedDoc'
import { useReferencedDocs } from '../../hooks/useReferencedDocs'
import { useUndoShortcut } from '../../hooks/useUndoShortcut'
import { useVersions, useVersionsList } from '../../hooks/useVersions'
import { canEdit, type Me } from '../../me'
import { StoryStore, useStoreState } from '../../store'
import { previewFrame } from './editor-model'

/**
 * Everything the editor screen is, assembled from hooks that already existed.
 *
 * **This hook builds nothing new.** `docs/editor-port-plan.md`'s first rule is
 * that the sync engine, presence, undo, versions, publish, the preview bridge and
 * the migration status are done and reusable, and the port is a *view* change; so
 * this is `admin/Editor.tsx`'s composition read as the dependency graph it always
 * was, minus the seven rail tabs and the layout. One thing genuinely is new and it
 * is named where it lives: `useRefStories`, below, which replaces the whole-tree
 * fetch the old editor's `Resolution` was built from.
 *
 * It exists as a hook rather than as the top of `EditorShell.tsx` for one reason:
 * `EditorShell` has three panes and two of them are other agents' (the inspector,
 * the history slide-over), so the state they share has to be nameable and
 * hand-off-able. `EditorApi` is that name.
 */
export interface EditorOptions {
  /** From the URL, so the store exists before the story row has loaded. */
  storyId: string
  /** The story row, or undefined while it is in flight. */
  story: StoryMeta | undefined
  apiBase: string
  /** The bare mount, for asset URLs and a global's preview page. */
  base: string
  schema: SchemaIndex
  types: readonly DocumentType[]
  globals: readonly string[]
  locales: LocaleConfig | undefined
  me: Me
  /**
   * The source-locale iframe src the caller computed — a page's own `previewUrl`,
   * or a global's borrowed one. Undefined for a record. See `previewFrame`, which
   * is what turns it into the URL for the locale being edited.
   */
  preview: string | undefined
  notify: (message: string) => void
  /**
   * The story row this screen was handed is out of date — a publish or an
   * unpublish moved its state, and it is the *caller's* row.
   *
   * The seam is here rather than a second fetch of the same row from in here,
   * which is how two views of one document start disagreeing. `Prototype` supplies
   * it; `useStory` grew a `reload` for the purpose, and a global's row is refreshed
   * from the boot's singleton call instead, because that is where it came from.
   *
   * **It is optional in the type and must not be treated as optional in practice**,
   * and an earlier version of this comment got that wrong. It claimed the shell
   * worked without it because "only the state badge goes stale". The state is also
   * `publishStatus`'s `isLive` argument, and `everPublished && !isLive && delta 0`
   * is how a *taken-down* page looks — so an unrefreshed row left the Publish
   * button **enabled on a document that had just been published**, next to a status
   * line reading "Up to date". Pinned by `editor-shell.test.ts`'s
   * "the open row is refreshed after a write".
   */
  onStoryChanged?: () => void
  /** True while the history slide-over is open: the activity trail loads with it,
   * exactly as the old History rail's `active` flag did. */
  historyOpen: boolean
  /** A block was picked in the preview. The shell reveals the rail if it is
   * collapsed; there are no tabs to bring forward any more. */
  onPick: () => void
}

export interface EditorApi {
  store: StoryStore
  state: ReturnType<typeof useStoreState>
  /** The live draft. Null until the store has bootstrapped. */
  liveDoc: Doc | null
  /**
   * What is **on screen** — the version being viewed, or the live draft. The rail
   * and the inspector both draw this; only a write ever touches `liveDoc`.
   */
  shownDoc: Doc | null
  /** The selected blok, out of `shownDoc`. */
  selected: Blok | null
  /** Looking at a past version, or holding a role that may not edit. Deliberately
   * one flag: the inspector already knew how to be read-only for the first. */
  readOnly: boolean
  blocks: ReturnType<typeof useBlocks>
  locale: string
  isSourceLocale: boolean
  localeCtx: ReturnType<typeof localeContext>
  setLocale: (code: string) => void
  resolution: Resolution
  translation: ReturnType<typeof translationStatus> | null
  /** Locales that are incomplete on the draft as it stands, for the publish
   * warning. Computed from the document the store already holds, so it is right
   * at the instant Publish is clicked rather than as of the last fetch. */
  gaps: ReturnType<typeof translationGaps>
  versions: ReturnType<typeof useVersions>
  /**
   * The **version** list's paged trail, which `versions` does not carry.
   *
   * `useVersionsList` and `useVersions` are two hooks over two routes, and only the
   * second's return value was exposed here — so the history slide-over could reach
   * the activity trail and not the version one. Found by wiring 7a's slot to 7c's
   * panel: two agents agreed on the shape of every field except this one, which
   * neither could see was missing from its own side.
   *
   * The list itself stays where it is (`usePublishedDoc` needs its newest `publish`
   * on every load, unconditionally), so this is the same array under a second name
   * rather than a second read.
   */
  versionTrail: ReturnType<typeof useVersionsList>['trail']
  published: ReturnType<typeof usePublishedDoc>
  publish: ReturnType<typeof usePublish>
  migrations: ReturnType<typeof useMigrations>
  /** The iframe's ref callback. Nothing else in the editor talks to the frame. */
  frame: (node: HTMLIFrameElement | null) => void
  /** The src for the frame in the locale being edited. */
  src: string | undefined
  /**
   * A block inside a global was clicked while previewing something else: the name
   * of the global to offer "Edit … →" for, until the next selection or story
   * switch clears it (`globals.md` checkpoint 3).
   */
  globalHint: string | null
}

export function useEditor(opts: EditorOptions): EditorApi {
  const { storyId, story, apiBase, base, schema, types, globals, locales, me, notify } = opts

  // The active locale, defaulting to the source. Editor state rather than a URL
  // parameter: it is a property of this editing session, and the *preview* URL is
  // what carries it into the iframe (`localisation.md` decision 6).
  const [locale, setLocale] = useState(locales?.default ?? '')
  const isSourceLocale = !locales || locale === locales.default
  const localeCtx = useMemo(() => localeContext(locales, locale), [locales, locale])

  const store = useMemo(() => new StoryStore(storyId, apiBase), [storyId, apiBase])
  const state = useStoreState(store)
  const blocks = useBlocks(store, schema, notify, story?.path ?? '')

  // Which language this client is editing in, announced with its presence so a
  // peer ring can say so. Null on the source locale, so a single-locale site
  // announces nothing new at all.
  useEffect(() => {
    store.setLocale(isSourceLocale ? null : locale)
  }, [isSourceLocale, locale, store])

  // Loaded unconditionally, not only while history is open: the publish state
  // needs the newest publish version on every load.
  const versionsList = useVersionsList(apiBase, storyId)
  const versions = useVersions({
    store,
    apiBase,
    storyId,
    liveDoc: state.doc,
    notify,
    active: opts.historyOpen,
    versions: versionsList.versions,
    reloadVersions: versionsList.reload,
  })
  const published = usePublishedDoc({
    apiBase,
    versions: versionsList.versions,
    liveDoc: state.doc,
  })

  // A publish or an unpublish adds a retained version and moves the story's state.
  // Unpublish adds none, but reloading unconditionally costs nothing extra and
  // keeps both writes sharing one afterWrite path.
  const { onStoryChanged } = opts
  const afterPublish = useCallback(async () => {
    await versions.reload()
    onStoryChanged?.()
  }, [versions.reload, onStoryChanged])
  const publish = usePublish({ apiBase, storyId, notify, onPublished: afterPublish })

  const migrations = useMigrations(apiBase, storyId, notify)

  /* ------------------------------------------------------------ resolution --- */

  const refStories = useRefStories(apiBase, state.doc, schema)
  const docs = useReferencedDocs(apiBase, state.doc, schema)
  // Fetched once per global, not per keystroke: the admin's own copy exists only
  // so a clicked uid can be traced back to the global it belongs to; the preview
  // iframe renders every global server-side, fresh, on its own.
  const globalDocs = useGlobalDocs(apiBase, types, globals)
  const collections = useCollections(apiBase, state.doc, schema, localeCtx)
  const resolution = useMemo<Resolution>(
    () => ({
      // The open story is always in the map, whether or not anything links to it:
      // a page that links to itself, and a host template reading the current
      // page's own ref, both want it there.
      ...buildResolution(story ? [story, ...refStories] : refStories, `${base}/asset`),
      docs,
      globals: globalDocs.docs,
      collections,
    }),
    [story, refStories, base, docs, globalDocs.docs, collections],
  )

  /* ---------------------------------------------------------------- bridge --- */

  const [globalHint, setGlobalHint] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: storyId and state.selection are deliberate — neither is read in the body, both are what should clear a stale hint
  useEffect(() => setGlobalHint(null), [storyId, state.selection])

  const frame = usePreviewBridge({
    store,
    resolution,
    source: versions.source,
    selection: state.selection,
    root: state.doc?.root,
    blocks,
    onPick: opts.onPick,
    onGlobalClick: setGlobalHint,
  })

  const live = versions.source.mode === 'live'
  useUndoShortcut(store, live)
  useClipboardShortcuts(blocks, state.selection, live)

  /**
   * The object's refusals — a rejected transaction, an unreadable or wrongly
   * versioned frame — reach the screen through the same toast as local failures.
   * Without this the only sign of a refused edit is the value snapping back.
   */
  useEffect(() => {
    if (state.notice) notify(state.notice)
  }, [notify, state.notice])

  /**
   * Select the root as soon as the document arrives and nothing else is selected.
   *
   * The old editor did this in form mode only, because there the preview does not
   * exist to be clicked and the inspector would sit asking to be clicked in a pane
   * that is not there. Doing it always is a small deliberate change: the inspector
   * opens on the page's own fields — its title, its description — which is what an
   * editor arriving at a page most often wants, and it makes the rail's first row
   * `aria-current` so the tree says where you are before you touch it.
   *
   * It costs nothing in the preview: `usePreviewBridge` posts `select` as null for
   * the root uid deliberately (the root wraps the whole page, so outlining it would
   * frame everything), so selecting the root highlights nothing in the frame.
   *
   * Only while nothing is selected, so an editor who has clicked into a nested
   * block keeps their place.
   */
  useEffect(() => {
    if (state.doc && !state.selection) store.select(state.doc.root)
  }, [state.doc, state.selection, store])

  /* ----------------------------------------------------------------- reads --- */

  const shownDoc = versions.viewing?.doc ?? state.doc
  const selected = state.selection && shownDoc ? (shownDoc.bloks[state.selection] ?? null) : null
  const readOnly = !live || !canEdit(me)

  const gaps = useMemo(
    () => (state.doc ? translationGaps(state.doc, schema, locales) : []),
    [locales, schema, state.doc],
  )
  const translation = useMemo(
    () => (state.doc && !isSourceLocale ? translationStatus(state.doc, schema, locale) : null),
    [isSourceLocale, locale, schema, state.doc],
  )

  return {
    store,
    state,
    liveDoc: state.doc,
    shownDoc,
    selected,
    readOnly,
    blocks,
    locale,
    isSourceLocale,
    localeCtx,
    setLocale,
    resolution,
    translation,
    gaps,
    versions,
    versionTrail: versionsList.trail,
    published,
    publish,
    migrations,
    frame,
    src: previewFrame(story, opts.preview, locale, isSourceLocale),
    globalHint,
  }
}

/* ------------------------------------------------------------ story refs --- */

/**
 * The story ids this document points at, sorted and joined — so an unchanged set
 * is an unchanged effect dependency.
 *
 * Both walks, because both are ids the render needs and they mean different
 * things: `linkedIds` is `multilink` fields **and the link marks inside every
 * richtext value** (a Folio-native link mark stores a structured `attrs.link` and
 * derives its href from the resolution, so narrowing this walk makes every
 * internal prose link render as unstyled text — `core/refs.ts`'s header), and
 * `referencedIdsAllLocales` is what `reference` and `references` pull in.
 *
 * Pure and exported so the union is tested without a fetch.
 */
export function wantedStoryIds(doc: Doc | null, schema: SchemaIndex): string {
  if (!doc) return ''
  const ids = new Set([...linkedIds(doc, schema), ...referencedIdsAllLocales(doc, schema)])
  return [...ids].sort().join(',')
}

/** Ids that are wanted and not already settled, either way. `useReferencedDocs`'
 * `idsToFetch` by another name, over story rows instead of documents. */
export function storyIdsToFetch(
  wanted: readonly string[],
  known: { rows: Readonly<Record<string, StoryMeta>>; missing: ReadonlySet<string> },
): string[] {
  return wanted.filter((id) => !known.rows[id] && !known.missing.has(id))
}

interface KnownStories {
  rows: Readonly<Record<string, StoryMeta>>
  /** Ids the server answered for with no row: a deleted story. Never asked for
   * again, or a broken link would be re-requested on every keystroke forever. */
  missing: ReadonlySet<string>
}

const NO_STORIES: KnownStories = { rows: {}, missing: new Set() }

/**
 * The story rows the preview's `Resolution` needs, fetched by id.
 *
 * **This is what replaced `buildResolution(flat)`.** The old editor held every
 * story on the site — `useStories`' own comment calls that a stopgap that "dies
 * with this file" — because a link, a reference and the parent picker all wanted
 * the whole tree. A link only needs the rows it points at, so this asks for those:
 * one `GET {base}/api/stories?ids=` per *change to the set*, never per keystroke,
 * the same discipline `useReferencedDocs` and `useCollections` follow one level up.
 * `?ids=` is uncursored and chunked server-side, so a document with two hundred
 * links is one request rather than a walk.
 */
function useRefStories(apiBase: string, doc: Doc | null, schema: SchemaIndex): StoryMeta[] {
  const [known, setKnown] = useState<KnownStories>(NO_STORIES)
  const wanted = useMemo(() => wantedStoryIds(doc, schema), [doc, schema])

  useEffect(() => {
    const ids = storyIdsToFetch(wanted ? wanted.split(',') : [], known)
    if (ids.length === 0) return
    let alive = true
    const query = new URLSearchParams({ ids: ids.join(',') })
    fetch(`${apiBase}/stories?${query}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ rows: StoryMeta[] }>) : { rows: [] }))
      .then(({ rows }) => {
        if (!alive) return
        setKnown((prev) => {
          const found = Object.fromEntries(rows.map((row) => [row.id, row]))
          const missing = ids.filter((id) => !found[id])
          // The same object when nothing was settled, which is what stops this
          // effect looping on its own state — `mergeReferencedDocs`' rule.
          if (rows.length === 0 && missing.length === 0) return prev
          return {
            rows: rows.length ? { ...prev.rows, ...found } : prev.rows,
            missing: missing.length ? new Set([...prev.missing, ...missing]) : prev.missing,
          }
        })
      })
      .catch(() => {
        // A transport failure is not an answer about the story, so it is not
        // remembered as a miss: the next change to the linked set asks again.
      })
    return () => {
      alive = false
    }
  }, [apiBase, known, wanted])

  return useMemo(() => Object.values(known.rows), [known.rows])
}
