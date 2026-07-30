import { useEffect, useMemo, useState } from 'react'
import './tokens.css'
import type { DocumentType, Manifest } from '../../core/schema'
import type { StoryMeta, StoryNode } from '../../core/story'
import { globalPreviewUrl } from '../GlobalsList'
import { actorLabel, fetchMe, type Me, OPEN } from '../me'
import { Kitchen } from './Kitchen'
import type { MenuItem } from './Menu'
import { activeItem, nav } from './nav'
import { Palette, type PaletteAction } from './Palette'
import { type Crumb, type CrumbContext, crumbs, documentTitle, href } from './route'
import { useRemembered } from './remembered'
import { Content } from './screens/Content'
import { EditorShell } from './screens/EditorShell'
import { Home } from './screens/Home'
import { Stub } from './screens/Stub'
import { Shell } from './Shell'
import { SAVE_NOTICE, useShortcuts } from './shortcuts'
import { Toast } from './Toast'
import { useRouter } from './useRouter'

export interface PrototypeBoot {
  /** Where the admin's JSON lives: `rt.base`. */
  apiBase: string
  /** Where the shell is mounted — `{base}/ui` today, `{base}` once the screens
   * take the bare namespace (`server/routes/shell.ts`). Every URL in the router is
   * relative to it, so this is the whole cost of that move on the client. */
  mount: string
}

/**
 * The shell, wired to real data.
 *
 * This is phase 1 of `docs/ui-architecture.md`'s port plan built as a prototype
 * rather than as the port: the sidebar, the top bar, the breadcrumb, the router,
 * the palette and the shortcut map, with the Content screen and the editor's
 * geometry real enough to judge. Nothing here writes.
 *
 * It boots from the same four requests the current admin does — the manifest, the
 * actor, the story tree, and the unrouted documents — and two of them are the
 * finding: `/stories` returns **every** story and `/documents` returns **every**
 * record, which is `ROADMAP.md`'s next foundation item and the reason the port is
 * sequenced behind pagination rather than in front of it.
 */
export function Prototype({ boot }: { boot: PrototypeBoot }) {
  const { route, go, replace } = useRouter(boot.mount)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [me, setMe] = useState<Me>(OPEN)
  const [tree, setTree] = useState<readonly StoryNode[]>([])
  const [unrouted, setUnrouted] = useState<readonly StoryMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [palette, setPalette] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([
      fetch(`${boot.apiBase}/schema`).then((r) => r.json() as Promise<Manifest>),
      fetchMe(boot.apiBase),
      fetch(`${boot.apiBase}/stories`, { headers: { accept: 'application/json' } }).then((r) =>
        r.ok ? (r.json() as Promise<StoryNode[]>) : [],
      ),
      /**
       * The records and singletons, which are **not in the tree**: `storyTree`
       * drops every unrouted row, so a global's document is not in `/stories` at
       * all.
       *
       * A finding, and one the prototype produced by failing: the sidebar links a
       * global straight at `sng_<type>` (its id is derived), the router resolved
       * the id against the tree, found nothing, and drew "No such document" under
       * a correctly highlighted nav item. Two requests is what the current admin
       * does too, and asking is also what *creates* a singleton on first access
       * (`stories.ts`'s `ensureSingleton`) — so this call is load-bearing, not
       * merely convenient.
       *
       * It is also the second unpaged fetch in the boot path, which is the same
       * argument for `ROADMAP.md`'s pagination item as the tree is.
       */
      fetch(`${boot.apiBase}/documents`, { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? (r.json() as Promise<{ documents: StoryMeta[] }>) : { documents: [] }))
        .then((body) => body.documents),
    ])
      .then(([m, who, stories, documents]) => {
        if (!live) return
        setManifest(m)
        setMe(who)
        setTree(stories)
        setUnrouted(documents)
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
  }, [boot.apiBase])

  const types = manifest?.types ?? []
  // Tree first, then the unrouted documents: one list for the palette, the
  // breadcrumb's chain, and resolving whatever `/edit/:id` names.
  const flat = useMemo(() => [...flatten(tree), ...unrouted], [tree, unrouted])
  // Held in a local so the narrowing survives into the callback below.
  const screen = route.screen
  const open = screen.name === 'edit' ? flat.find((n) => n.id === screen.id) : undefined

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
            chain: chainOf(flat, open),
            root: rootCrumbFor(types.find((t) => t.name === open.type)),
          }
        : {}),
    }),
    [types, open, flat],
  )
  const trail = crumbs(route, crumbContext)

  const editing = route.screen.name === 'edit'
  const sidebar = useRemembered(`folio.sidebar.${editing ? 'editor' : 'platform'}`, editing)
  const blockRail = useRemembered('folio.editor.rail', false)
  const inspector = useRemembered('folio.editor.inspector', false)

  useEffect(() => {
    document.title = documentTitle(route, crumbContext)
  }, [route, crumbContext])

  useShortcuts({
    'mod+k': () => setPalette(true),
    // One chord, one meaning: hide the left column. In the editor that is the
    // block rail — the sidebar is already a 48px strip there by default — and on a
    // platform screen it is the sidebar itself. `ui-architecture.md` calls both
    // "the rail", which is an ambiguity worth resolving by context rather than by
    // inventing a second chord.
    'mod+\\': () => (editing ? blockRail.toggle() : sidebar.toggle()),
    'mod+.': () => inspector.toggle(),
    // The owner's call: ⌘S saves nothing because nothing needs saving, and says
    // so rather than being swallowed silently.
    'mod+s': () => setNotice(SAVE_NOTICE),
  })

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  const actions = usePaletteActions({ groups, flat, mount: boot.mount, go, label })

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

  return (
    <>
      <Shell
        groups={groups}
        active={activeItem(groups, route.screen, open?.type)}
        crumbs={trail}
        mount={boot.mount}
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
          tree,
          loading,
          types,
          open,
          label,
          go,
          replace,
          blockRail,
          inspector,
          pageTypesInUse: new Set(flat.filter((n) => n.path !== null).map((n) => n.type)).size,
          preview: previewFor(open, types, flatten(tree), boot.apiBase),
        })}
      </Shell>
      {palette ? <Palette actions={actions} onClose={() => setPalette(false)} /> : null}
      <Toast message={notice} />
    </>
  )
}

/* ------------------------------------------------------------------ routing --- */

interface ScreenArgs {
  route: ReturnType<typeof useRouter>['route']
  boot: PrototypeBoot
  tree: readonly StoryNode[]
  loading: boolean
  types: Manifest['types']
  open: StoryMeta | undefined
  label: (name: string) => string | undefined
  go: ReturnType<typeof useRouter>['go']
  replace: ReturnType<typeof useRouter>['replace']
  blockRail: ReturnType<typeof useRemembered>
  inspector: ReturnType<typeof useRemembered>
  /** Distinct document types actually present in the page tree. See `Content`'s
   * `showType`. */
  pageTypesInUse: number
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
      return <Home types={a.types} tree={a.tree} mount={boot.mount} />

    case 'content':
      return (
        <Content
          tree={a.tree}
          loading={a.loading}
          mount={boot.mount}
          query={route.query}
          onQuery={(next) => a.replace({ name: 'content' }, { ...route.query, ...next })}
          onOpen={a.go}
          showType={a.pageTypesInUse > 1}
        />
      )

    case 'edit':
      return (
        <EditorShell
          story={a.open}
          preview={a.preview}
          loading={a.loading}
          railCollapsed={a.blockRail.value}
          onToggleRail={a.blockRail.toggle}
          inspectorCollapsed={a.inspector.value}
          onToggleInspector={a.inspector.toggle}
        />
      )

    case 'documents':
      return (
        <Stub title={a.label(route.screen.type) ?? route.screen.type}>
          One type&rsquo;s records as a table, with columns from its <code>indexed</code> fields.
          Replaces <code>DataList.tsx</code> and <code>DataTable.tsx</code>, and stops the inspector
          sitting beside a list describing an unrelated page.
        </Stub>
      )

    case 'assets':
      return (
        <Stub
          title="Assets"
          needs={
            <>
              <li>
                Paged listing: the route caps at 200 today, and with no search, asset 201 is
                unreachable.
              </li>
              <li>Usage counts, so a delete can name what references the file.</li>
            </>
          }
        >
          The media library as a place: grid or table, search, filters, a detail panel with alt text
          and where it is used. The field picker becomes the same grid in a <code>Dialog</code>.
        </Stub>
      )

    case 'access':
      return (
        <Stub title="Access">
          Editors and API tokens, as two tables with room for an email address — the review&rsquo;s
          sharpest illustration was this surface rendered in 280px with every address truncated.
        </Stub>
      )

    case 'model':
      return (
        <Stub title="Model">
          Migrations with their dry-run report, and <b>the audit panel</b>:{' '}
          <code>GET {boot.apiBase}/audit</code> answers in full across four families today and
          nothing renders it.
        </Stub>
      )

    case 'redirects':
      return (
        <Stub title="Redirects">
          The table it already is — and the one list route in the codebase that already pages
          properly, over a keyset cursor.
        </Stub>
      )

    case 'settings':
      return (
        <Stub title="Settings">
          A <b>mirror of code, not a form</b>: locales, globals, document types, block types, auth
          providers, cache configuration, each read-only and each showing where the host declared
          it. Editing any of it would be a second source of truth for the one thing that must have
          exactly one.
        </Stub>
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

function usePaletteActions({
  groups,
  flat,
  mount,
  go,
  label,
}: {
  groups: ReturnType<typeof nav>
  flat: readonly StoryMeta[]
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
    const documents: PaletteAction[] = flat.map((node) => {
      // The path, because that is the thing that tells two pages with the same
      // title apart — and `design-system.md`'s third commitment says an
      // identifier is a typographic citizen rather than something to hide. It is
      // also a `keyword`, so typing a path finds the page whose title does not
      // contain it.
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
  }, [groups, flat, mount, go, label])
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
 */
function previewFor(
  story: StoryMeta | undefined,
  types: readonly DocumentType[],
  tree: readonly StoryNode[],
  apiBase: string,
): string | undefined {
  if (!story) return undefined
  if (story.previewUrl) return story.previewUrl
  const type = types.find((t) => t.name === story.type)
  return type?.kind === 'singleton' ? globalPreviewUrl(type, tree, apiBase) : undefined
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

/* -------------------------------------------------------------------- trees --- */

function flatten(nodes: readonly StoryNode[]): StoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)])
}

/**
 * The open document's ancestors, root first, itself last — the breadcrumb's
 * chain. Derived from the flat list by walking `parentId` rather than by
 * searching the tree, which is the same walk `core/refs.ts` does server-side.
 */
function chainOf(flat: readonly StoryMeta[], node: StoryMeta): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = []
  let at: StoryMeta | undefined = node
  const seen = new Set<string>()
  while (at && !seen.has(at.id)) {
    seen.add(at.id)
    out.unshift({ id: at.id, title: at.title || at.slug || at.id })
    const parent: string | null = at.parentId
    at = parent === null ? undefined : flat.find((n) => n.id === parent)
  }
  return out
}
