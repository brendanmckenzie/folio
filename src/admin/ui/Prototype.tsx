import { useEffect, useMemo, useState } from 'react'
import './tokens.css'
import {
  type DocumentType,
  indexManifest,
  type Manifest,
  type SchemaIndex,
} from '../../core/schema'
import { DEFAULT_FLAT_SORT, type FlatSort, type StoryMeta } from '../../core/story'
import { globalPreviewUrl } from '../GlobalsList'
import { actorLabel, fetchMe, type Me, OPEN } from '../me'
import { Kitchen } from './Kitchen'
import type { MenuItem } from './Menu'
import { activeItem, nav } from './nav'
import { Palette, type PaletteAction } from './Palette'
import { type Crumb, type CrumbContext, crumbs, documentTitle, href, type Screen } from './route'
import { useRemembered, useRememberedString } from './remembered'
import { Access } from './screens/Access'
// `ASSET_VIEW_KEY` and not a string literal: the picker is mounted by an asset
// *field* and reads the remembered view itself, so the two mounts of one grid have to
// agree on the key or they remember different views. `AssetPicker` itself is not
// mounted here — it belongs to a field, and the field is port phase 7's.
import { ASSET_VIEW_KEY } from './screens/AssetPicker'
import { Assets } from './screens/Assets'
import { Content } from './screens/Content'
import { Documents } from './screens/Documents'
import { Model } from './screens/Model'
import { Redirects } from './screens/Redirects'
import { Settings } from './screens/Settings'
import type { ViewMode } from './screens/content-model'
import { EditorShell } from './screens/EditorShell'
import { BlockPicker } from './screens/BlockPicker'
import { HistoryPanel } from './screens/HistoryPanel'
import { Home } from './screens/Home'
import { Inspector } from './screens/Inspector'
import { Keys } from './screens/Keys'
import { Stub } from './screens/Stub'
import { Shell } from './Shell'
import { type Bindings, SAVE_NOTICE, useShortcuts } from './shortcuts'
import { Toast } from './Toast'
import { useRouter } from './useRouter'
import { useSearch } from './useSearch'
import { usePreviewHost, useStory } from './useStory'

export interface PrototypeBoot {
  /**
   * Where Folio is mounted, and therefore where every screen lives: the router is
   * relative to it, which is what made the prefix move free on the client.
   */
  base: string
  /** Where the admin's internal JSON lives — `${base}/api`. */
  apiBase: string
}

/**
 * The shell.
 *
 * Phase 1 of `docs/ui-architecture.md`'s port plan, carrying phases 2 and 3 — the
 * Content and Documents screens — as real screens rather than stubs.
 *
 * **The boot path holds no unbounded read.** That is worth stating because it was
 * this file's standing finding through two phases: four requests, two of which
 * returned every row in a table. The tree went with phase 2 (Content pages its own
 * levels); the records went with phase 3. What is left is the schema, who you are,
 * and `?kind=singleton` — a set bounded by the host's own `types` literal, so it
 * cannot grow when somebody publishes.
 *
 * The three things the shell genuinely needs about a *document* — the row, its
 * ancestors, and a global's preview host — come from `useStory` and `usePreviewHost`,
 * each asking for the ids or paths it needs
 * (`docs/specs/foundation/pagination.md` decision 7).
 */
export function Prototype({ boot }: { boot: PrototypeBoot }) {
  const { route, go, replace } = useRouter(boot.base)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [me, setMe] = useState<Me>(OPEN)
  const [globals, setGlobals] = useState<readonly StoryMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [palette, setPalette] = useState(false)
  const [keys, setKeys] = useState(false)
  /**
   * The history slide-over, opened by `⌘H`.
   *
   * Shell state rather than the editor's, because the chord is the shell's:
   * `useShortcuts` is bound once here and the editor is one screen among eight. Named
   * `historyOpen` and not `history`, because `history` is a DOM global and shadowing
   * it inside the component that owns the router is asking for the wrong one.
   */
  const [historyOpen, setHistoryOpen] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([
      fetch(`${boot.apiBase}/schema`).then((r) => r.json() as Promise<Manifest>),
      fetchMe(boot.apiBase, boot.base),
      /**
       * The **singletons**, which are not in the tree: `storyTree` drops every
       * unrouted row, so a global's document is not in the paged `/stories` walk at
       * all.
       *
       * A finding the prototype produced by failing: the sidebar links a global
       * straight at `sng_<type>` (its id is derived), the router resolved the id
       * against the tree, found nothing, and drew "No such document" under a
       * correctly highlighted nav item. Asking is also what *creates* a singleton on
       * first access, so this call is load-bearing rather than merely convenient.
       *
       * **This used to be every record too**, and was the last unbounded read in the
       * boot path. `?kind=singleton` is the load-bearing half on its own: the set is
       * bounded by the *schema* — `types` is a literal in the host's `createFolio`
       * call — so it cannot grow when somebody publishes, which is why it is
       * uncursored and why that is not an exception to the rule. Records left the
       * boot path entirely: the Documents screen pages them, `useStory` resolves an
       * open one by id, and the palette searches for them.
       */
      fetch(`${boot.apiBase}/documents?kind=singleton`, {
        headers: { accept: 'application/json' },
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ rows: StoryMeta[] }>) : { rows: [] }))
        .then((body) => body.rows),
    ])
      .then(([m, who, singletons]) => {
        if (!live) return
        setManifest(m)
        setMe(who)
        setGlobals(singletons)
        setLoading(false)
      })
      .catch((e: Error) => {
        if (!live) return
        setNotice(e.message)
        setLoading(false)
      })
    return () => {
      live = false
    }
  }, [boot.apiBase, boot.base])

  const types = manifest?.types ?? []
  const schema = useMemo(() => (manifest ? indexManifest(manifest) : {}), [manifest])
  const pageTypes = useMemo(() => types.filter((t) => t.kind === 'page'), [types])
  const screen = route.screen

  /**
   * The open document, resolved by id rather than looked up in a tree the shell no
   * longer holds. A **global** is already in `globals`, so it is answered without a
   * request — which matters because that list is also what brought the singleton
   * into existence. Everything else, records included, is one `?ids=` fetch.
   */
  const local = screen.name === 'edit' ? globals.find((n) => n.id === screen.id) : undefined
  const fetched = useStory(boot.apiBase, screen.name === 'edit' && !local ? screen.id : undefined)
  const open = local ?? fetched.story

  const groups = useMemo(
    () => nav({ types, globals: manifest?.globals ?? [], me }),
    [types, manifest?.globals, me],
  )

  const label = (name: string) => types.find((t) => t.name === name)?.label
  const crumbContext = useMemo(
    (): CrumbContext => ({
      label: (name) => types.find((t) => t.name === name)?.label,
      ...(open
        ? {
            chain: local
              ? // A global is one crumb: it has no ancestor chain, because it is
                // not in the tree. A record is the same shape and reaches it
                // through `fetched.chain`, which `?ancestors=1` answers as one
                // entry for a row whose path is null.
                [{ id: local.id, title: local.title || local.id }]
              : fetched.chain,
            root: rootCrumbFor(types.find((t) => t.name === open.type)),
          }
        : {}),
    }),
    [types, open, local, fetched.chain],
  )
  const trail = crumbs(route, crumbContext)

  const editing = route.screen.name === 'edit'
  const sidebar = useRemembered(`folio.sidebar.${editing ? 'editor' : 'platform'}`, editing)
  const blockRail = useRemembered('folio.editor.rail', false)
  const inspector = useRemembered('folio.editor.inspector', false)
  const contentView = useRememberedString<ViewMode>('folio.content.view', 'tree', isViewMode)
  const contentSort = useRememberedString<FlatSort>('folio.content.sort', DEFAULT_FLAT_SORT, isSort)
  /**
   * The Assets screen's grid/table choice, on **the key the picker reads for
   * itself** (`ASSET_VIEW_KEY`) rather than one spelled out here.
   *
   * The picker is mounted by an asset *field*, which has no shell above it to be
   * wired from, so it reads the remembered value directly. Two mounts of one grid
   * remembering two different views is the bug that key exists to prevent, and
   * importing the constant is what stops the two drifting apart in a rename.
   */
  const assetView = useRememberedString<AssetView>(ASSET_VIEW_KEY, 'grid', isAssetView)

  useEffect(() => {
    document.title = documentTitle(route, crumbContext)
  }, [route, crumbContext])

  /**
   * `g` then a letter, from `ui-architecture.md`'s keyboard map.
   *
   * Built as a table rather than eight entries in the map below, because the *set* is
   * the thing worth reading: a chord that goes to a screen the site does not have is
   * the failure mode, and `nav.ts` already role-gates Access and Model. So a
   * destination that is not in the nav is not bound — the chord does nothing rather
   * than navigating a viewer into a 403.
   *
   * `g d` is the odd one: Documents needs a *type*, and `ui-architecture.md`'s map
   * writes it as one letter. The first declared record type is the honest reading —
   * it is the one the sidebar lists first — and on a site with no record types the
   * chord is absent rather than pointing at `/documents/undefined`.
   */
  const goTo = useMemo((): Bindings => {
    const reachable = new Set(groups.flatMap((group) => group.items.map((i) => i.screen.name)))
    const firstRecord = types.find((t) => t.kind === 'record')
    const table: [string, Screen][] = [
      ['h', { name: 'home' }],
      ['c', { name: 'content' }],
      ['a', { name: 'assets' }],
      ['m', { name: 'model' }],
      ['r', { name: 'redirects' }],
      ['x', { name: 'access' }],
      ['s', { name: 'settings' }],
      ...(firstRecord
        ? ([['d', { name: 'documents', type: firstRecord.name }]] as [string, Screen][])
        : []),
    ]
    return Object.fromEntries(
      table
        .filter(([, screen]) => screen.name === 'home' || reachable.has(screen.name))
        .map(([letter, screen]) => [`g ${letter}`, () => go(screen)]),
    )
  }, [groups, types, go])

  useShortcuts({
    ...goTo,
    'mod+k': () => setPalette(true),
    // `?` and not `shift+/`: `chord()` names shift only when it is not already
    // encoded in the character, and a question mark arrives as `?`.
    '?': () => setKeys(true),
    // One chord, one meaning: hide the left column. In the editor that is the
    // block rail — the sidebar is already a 48px strip there by default — and on a
    // platform screen it is the sidebar itself. `ui-architecture.md` calls both
    // "the rail", which is an ambiguity worth resolving by context rather than by
    // inventing a second chord.
    'mod+\\': () => (editing ? blockRail.toggle() : sidebar.toggle()),
    'mod+.': () => inspector.toggle(),
    // Only where there is a document to have a history. Bound unconditionally and
    // guarded here rather than added to the map conditionally, so the binding map is
    // one literal and `?`'s row for it is always true.
    'mod+h': () => {
      if (editing) setHistoryOpen((open) => !open)
    },
    // The owner's call: ⌘S saves nothing because nothing needs saving, and says
    // so rather than being swallowed silently.
    'mod+s': () => setNotice(SAVE_NOTICE),
  })

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  const search = useSearch(boot.apiBase, palette)
  const actions = usePaletteActions({ groups, found: search.rows, mount: boot.base, go, label })

  const user: MenuItem[] = [
    { id: 'ui', label: 'Design system', run: () => go({ name: 'ui' }) },
    {
      id: 'signout',
      label: 'Sign out',
      danger: true,
      disabled: me.mode === 'open',
      reason: 'This deployment has no accounts',
      // Deliberately a navigation rather than a POST: the prototype does not
      // write, and a sign-out that half-worked would be a confusing way to find
      // that out.
      run: () => setNotice('Sign out is wired up with the Access port'),
    },
  ]

  const previewType = open && !open.previewUrl ? types.find((t) => t.name === open.type) : undefined
  const previewHost = usePreviewHost(
    boot.apiBase,
    previewType?.kind === 'singleton' ? previewType.previewPath : undefined,
  )

  return (
    <>
      <Shell
        groups={groups}
        active={activeItem(groups, route.screen, open?.type)}
        crumbs={trail}
        mount={boot.base}
        collapsed={sidebar.value}
        onToggleSidebar={sidebar.toggle}
        onSearch={() => setPalette(true)}
        actor={actorLabel(me)}
        user={user}
        bare={editing}
      >
        {screenFor({
          route,
          boot,
          loading,
          // `useStory`'s own flight, separate from the boot's: the editor needs to
          // tell "the row is on its way" from "there is no such row".
          openLoading: fetched.loading,
          globals: manifest?.globals ?? [],
          manifest,
          me,
          types,
          schema,
          pageTypes,
          open,
          label,
          go,
          replace,
          blockRail,
          inspector,
          notify: setNotice,
          contentView,
          contentSort,
          assetView,
          historyOpen,
          setHistoryOpen,
          preview: previewFor(open, previewType, previewHost, boot.base),
        })}
      </Shell>
      {palette ? (
        <Palette actions={actions} onQuery={search.setQuery} onClose={() => setPalette(false)} />
      ) : null}
      {keys ? <Keys onClose={() => setKeys(false)} /> : null}
      <Toast message={notice} />
    </>
  )
}

type AssetView = 'grid' | 'table'
const isAssetView = (raw: string): raw is AssetView => raw === 'grid' || raw === 'table'
const isViewMode = (raw: string): raw is ViewMode => raw === 'tree' || raw === 'flat'
const isSort = (raw: string): raw is FlatSort =>
  raw === 'edited' || raw === 'title' || raw === 'path'

/* ------------------------------------------------------------------ routing --- */

interface ScreenArgs {
  route: ReturnType<typeof useRouter>['route']
  boot: PrototypeBoot
  loading: boolean
  /** The open document's own fetch is in flight (`useStory`). Distinct from
   * `loading`, which is the shell's boot: only the editor cares about the
   * difference, and it cares because "no such document" must not flash. */
  openLoading: boolean
  /** `FolioConfig.globals` — a subset of the declared singleton types, so Home can
   * draw a card per global without a second request. Off the manifest, which the
   * shell already holds. */
  globals: readonly string[]
  /** The whole manifest, for the one screen that mirrors it. Passed rather than
   * re-fetched: the shell already holds it, and a second fetch of the same thing is
   * how two views of one declaration start disagreeing. Null while the boot is in
   * flight, which is the screen's cue to draw skeletons. */
  manifest: Manifest | null
  /** Who is signed in, and the auth mode. Screens that gate on a role read it;
   * `admin/me.ts`'s `OPEN` is the optimistic default until `/me` answers, which is
   * why `loading` travels beside it. */
  me: Me
  types: Manifest['types']
  /** The block schema, indexed by name. Documents needs it to read a type's
   * `indexed` fields and their labels; nothing else does yet. */
  schema: SchemaIndex
  pageTypes: readonly DocumentType[]
  open: StoryMeta | undefined
  label: (name: string) => string | undefined
  go: ReturnType<typeof useRouter>['go']
  replace: ReturnType<typeof useRouter>['replace']
  blockRail: ReturnType<typeof useRemembered>
  inspector: ReturnType<typeof useRemembered>
  notify: (message: string) => void
  contentView: ReturnType<typeof useRememberedString<ViewMode>>
  contentSort: ReturnType<typeof useRememberedString<FlatSort>>
  assetView: ReturnType<typeof useRememberedString<AssetView>>
  /** The history slide-over's open state and its setter. Not `useRemembered`: a
   * reference surface you consult and dismiss should not be open because it was open
   * last week. */
  historyOpen: boolean
  setHistoryOpen: (open: boolean) => void
  /** The open document's iframe src. See `EditorShell`'s `preview`. */
  preview: string | undefined
}

/**
 * The route table's other half: which component a screen is. Kept as a function
 * rather than a map so each screen names its own props — the alternative is every
 * screen taking one context object, which is how a screen ends up depending on
 * data it does not use.
 */
function screenFor(a: ScreenArgs) {
  const { route, boot } = a
  switch (route.screen.name) {
    case 'home':
      return (
        <Home
          apiBase={boot.apiBase}
          mount={boot.base}
          types={a.types}
          globals={a.globals}
          me={a.me}
          onOpen={a.go}
          onNotice={a.notify}
        />
      )

    case 'content':
      return (
        <Content
          mount={boot.base}
          apiBase={boot.apiBase}
          query={route.query}
          onQuery={(next) => a.replace({ name: 'content' }, { ...route.query, ...next })}
          onOpen={a.go}
          onNotice={a.notify}
          {...(a.open ? { selected: a.open.id } : {})}
          pageTypes={a.pageTypes}
          remembered={{ view: a.contentView.value, sort: a.contentSort.value }}
          onRemember={(next) => {
            a.contentView.set(next.view)
            a.contentSort.set(next.sort)
          }}
        />
      )

    case 'edit':
      return (
        <EditorShell
          story={a.open}
          preview={a.preview}
          // The boot flag *and* the row's own fetch: with `loading` false and no
          // story, the editor says "no such document", so passing only the boot
          // flag makes that flash on every open.
          loading={a.loading || a.openLoading}
          apiBase={boot.apiBase}
          mount={boot.base}
          schema={a.schema}
          types={a.types}
          globals={a.globals}
          {...(a.manifest?.locales ? { locales: a.manifest.locales } : {})}
          me={a.me}
          onNotice={a.notify}
          onOpenDocument={(id) => a.go({ name: 'edit', id })}
          railCollapsed={a.blockRail.value}
          onToggleRail={a.blockRail.toggle}
          inspectorCollapsed={a.inspector.value}
          onToggleInspector={a.inspector.toggle}
          /*
           * The three panels, as **render props over the slot** rather than nodes.
           *
           * `EditorShell` creates the store, the selection and the block mutations
           * inside itself — a node built out here could not reach any of them, so a
           * `ReactNode` prop would have forced the store up into the shell and made
           * every screen pay for the editor's machinery. `EditorSlot` is the seam,
           * and `Inspector`'s props are a strict subset of it: a compile-time
           * assertion in `inspector.test.ts` fails if a key is ever renamed, so this
           * spread cannot drift into a runtime `undefined`.
           */
          inspector={(slot) => <Inspector {...slot} />}
          history={(slot) =>
            // No document yet means no history to consult, and `HistoryPanel` needs a
            // `Doc` to phrase an activity entry against. The slide-over cannot be open
            // in that state anyway — it is opened from a document.
            slot.doc ? (
              <HistoryPanel
                open={slot.historyOpen}
                onClose={slot.onCloseHistory}
                doc={slot.doc}
                schema={slot.schema}
                versionTrail={slot.versionTrail}
                activityTrail={slot.versions.activityTrail}
                onReload={slot.versions.reload}
                busy={slot.versions.busy}
                viewingId={slot.versions.viewing?.version.id ?? null}
                onCheckpoint={slot.versions.checkpoint}
                onView={slot.versions.view}
                onExitView={slot.versions.exit}
                onRestore={slot.versions.restore}
                peerNames={Object.fromEntries(slot.peers.map((p) => [p.actor, p.name]))}
              />
            ) : null
          }
          historyOpen={a.historyOpen}
          onCloseHistory={() => a.setHistoryOpen(false)}
          picker={(slot) =>
            slot.adding ? (
              <BlockPicker
                schema={slot.schema}
                parentType={slot.doc?.bloks[slot.adding.parent]?.type ?? ''}
                slot={slot.adding.slot}
                filled={slot.adding.filled}
                onClose={slot.onCloseAdd}
                onPick={slot.onAddBlock}
              />
            ) : null
          }
        />
      )

    case 'documents': {
      const wanted = route.screen.type
      const type = a.types.find((t) => t.name === wanted)
      // A type the manifest does not declare. Not a `missing` route — the path is
      // perfectly well formed and the shell knows what it *was* — so it says which
      // type, which is the only useful thing it can say. An orphaned document of
      // that type is reachable through the audit panel (port phase 5), which is
      // where `DataList.tsx`'s "Unknown type" heading goes.
      if (!type) {
        return (
          <Stub title={wanted}>
            No document type named <code>{wanted}</code> is declared. It was renamed or removed in
            code; documents still carrying it are listed by <code>GET {boot.apiBase}/audit</code>.
          </Stub>
        )
      }
      return (
        <Documents
          type={type}
          schema={a.schema}
          apiBase={boot.apiBase}
          query={route.query}
          onQuery={(next) =>
            a.replace({ name: 'documents', type: type.name }, { ...route.query, ...next })
          }
          onOpen={a.go}
          onNotice={a.notify}
          {...(a.open ? { selected: a.open.id } : {})}
        />
      )
    }

    case 'assets':
      return (
        <Assets
          apiBase={boot.apiBase}
          mount={boot.base}
          query={route.query}
          onQuery={(next) => a.replace({ name: 'assets' }, { ...route.query, ...next })}
          onNotice={a.notify}
          remembered={{ view: a.assetView.value }}
          onRemember={(next) => a.assetView.set(next.view)}
        />
      )

    case 'access':
      return (
        <Access
          apiBase={boot.apiBase}
          me={a.me}
          // The boot is in flight, so `me` is still the optimistic `OPEN` guess
          // (`admin/me.ts` argues that default well, and it is harmless everywhere
          // else). On *this* screen it is a false statement — an admin arriving cold
          // would read "this deployment has no accounts" for one round trip — so the
          // screen draws skeletons instead.
          loading={a.loading}
          query={route.query}
          onQuery={(next) => a.replace({ name: 'access' }, { ...route.query, ...next })}
          onNotice={a.notify}
        />
      )

    case 'model':
      return <Model apiBase={boot.apiBase} mount={boot.base} me={a.me} onNotice={a.notify} />

    case 'redirects':
      return (
        <Redirects
          apiBase={boot.apiBase}
          query={route.query}
          onQuery={(next) => a.replace({ name: 'redirects' }, { ...route.query, ...next })}
          onNotice={a.notify}
        />
      )

    case 'settings':
      return (
        <Settings
          manifest={a.manifest}
          me={a.me}
          mount={boot.base}
          query={route.query}
          onQuery={(next) => a.replace({ name: 'settings' }, { ...route.query, ...next })}
        />
      )

    case 'ui':
      return <Kitchen />

    case 'missing':
      return (
        <Stub title="Not found">
          Nothing is routed at <code>{route.screen.path}</code>.
        </Stub>
      )
  }
}

/* ------------------------------------------------------------------ palette --- */

/**
 * The palette's actions: every screen, plus the documents matching what has been
 * typed.
 *
 * **Nothing is held; everything is searched.** The first version ranked the two boot
 * payloads in memory, which was only possible because one of them was every story on
 * the site. The second replaced half of that with `?flat=1&q=` and kept ranking the
 * records it still held — so a page was findable on a site of any size and a person
 * was findable only because the admin had already fetched every person.
 *
 * `GET {base}/api/search` (decision 8) closes it: one route, every kind, and
 * `content_index`'s values as well as the three columns on the row. So the palette
 * finds a record by the field that identifies it, and holds nothing.
 */
function usePaletteActions({
  groups,
  found,
  mount,
  go,
  label,
}: {
  groups: ReturnType<typeof nav>
  /** Documents matching what has been typed, from `useSearch`. */
  found: readonly StoryMeta[]
  mount: string
  go: ReturnType<typeof useRouter>['go']
  label: (name: string) => string | undefined
}): PaletteAction[] {
  return useMemo(() => {
    const screens: PaletteAction[] = groups.flatMap((group) =>
      group.items.map((item) => ({
        id: `nav:${href(item.screen, mount)}`,
        label: item.label,
        group: group.label ?? 'Go to',
        hint: href(item.screen, mount),
        run: () => go(item.screen),
      })),
    )
    const documents: PaletteAction[] = found.map((node) => {
      // The path, because that is the thing that tells two pages with the same
      // title apart — and `design-system.md`'s third commitment says an identifier
      // is a typographic citizen rather than something to hide. It is also a
      // `keyword`, so typing a path finds the page whose title does not contain it.
      const where = node.path === null ? label(node.type) : node.path === '' ? '/' : node.path
      return {
        id: `doc:${node.id}`,
        label: node.title || node.slug || node.id,
        group: 'Documents',
        ...(where ? { hint: where, keywords: where } : {}),
        run: () => go({ name: 'edit', id: node.id }),
      }
    })
    return [...screens, ...documents]
  }, [groups, found, mount, go, label])
}

/* ------------------------------------------------------------------ preview --- */

/**
 * The iframe src for the open document, or undefined when there is nothing to
 * show. Three sources, and the second is the one the prototype missed at first:
 *
 * - A **page** carries its own `previewUrl`, computed server-side by the host's
 *   `route` function.
 * - A **global** has none, but is not unpreviewable: `globalPreviewUrl` puts its
 *   draft on top of a real host page via `&as=<name>`, falling back to the bare
 *   `/preview/global/:name` route. Reused rather than reimplemented — it is
 *   already pure and already tested.
 * - A **record** has neither, and the editor says so instead of showing a frame.
 *
 * The host page is now passed in as one row rather than found in a whole tree
 * (`usePreviewHost`), which is why `globalPreviewUrl` gets a one-element list: its
 * signature takes the candidates to search, and the search is now the server's.
 */
function previewFor(
  story: StoryMeta | undefined,
  type: DocumentType | undefined,
  host: StoryMeta | undefined,
  /** The bare mount: a global's preview is an HTML page. */
  base: string,
): string | undefined {
  if (!story) return undefined
  if (story.previewUrl) return story.previewUrl
  if (type?.kind !== 'singleton') return undefined
  return globalPreviewUrl(type, host ? [{ ...host, children: [] }] : [], base)
}

/* -------------------------------------------------------------- breadcrumbs --- */

/**
 * What sits above an open document — the decision `route.ts` deliberately does not
 * make, because it needs the content model.
 *
 * - A **page** belongs to Content, and its ancestor chain fills in the rest.
 * - A **record** belongs to its own type's list, which is the way back the review
 *   found missing from form mode.
 * - A **global** has nothing above it: it is linked straight from the sidebar and
 *   there is exactly one of it, so a crumb would point at a list of one.
 * - A type that is not in the manifest at all falls back to Content rather than
 *   inventing a screen.
 */
function rootCrumbFor(type: DocumentType | undefined): Crumb | null {
  if (type?.kind === 'singleton') return null
  if (type?.kind === 'record') {
    return { text: type.label, screen: { name: 'documents', type: type.name } }
  }
  return { text: 'Content', screen: { name: 'content' } }
}
