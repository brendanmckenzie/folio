/**
 * The URL model, as a pure function both directions.
 *
 * `docs/design-system.md`'s first commitment is that the URL is the state: if a
 * person can see it, they can link to it. That only holds if there is exactly one
 * place that knows what a URL means, and it has to be testable without a browser —
 * the admin's whole suite runs in Node and mounts no components
 * (`vitest.config.ts`), so the router is parsing and formatting, and the hook that
 * talks to `history` holds no knowledge of its own.
 *
 * **Every path here is relative to a mount prefix**, and that is not only about
 * `basePath` being host-configurable. It is what lets the prototype live under
 * `{base}/ui` while the admin's internal JSON still owns the bare namespace:
 * `{base}/content`, `{base}/assets`, `{base}/documents` and `{base}/redirects` are
 * all JSON routes today, so a screen cannot take those paths until they move.
 * See `server/routes/shell.ts`, which records the finding and what it costs.
 */

/** The screens. `docs/ui-architecture.md`'s table, minus `login`, which is
 * server-rendered and ships no JavaScript on purpose. */
export type Screen =
  | { name: 'home' }
  | { name: 'content' }
  | { name: 'documents'; type: string }
  | { name: 'assets' }
  | { name: 'edit'; id: string }
  | { name: 'access' }
  | { name: 'model' }
  | { name: 'redirects' }
  | { name: 'settings' }
  /** The kitchen sink. Dev only, and the one screen whose URL is a little silly
   * while the prototype is mounted at `{base}/ui`: `{base}/ui/ui`. Left alone
   * deliberately — the awkwardness is a reminder the prefix is temporary, and
   * the table needs no edit when it goes. */
  | { name: 'ui' }
  | { name: 'missing'; path: string }

export type ScreenName = Screen['name']

export interface Route {
  screen: Screen
  /**
   * Everything after `?`, flattened. Screens read their own keys from it —
   * `state`, `type` and `q` on Content; `blok`, `locale`, `version` and `panel`
   * in the editor — so adding a filter is a screen's business, not the router's.
   *
   * Repeated keys keep the last value. Nothing in the design needs a list, and
   * the alternative (`URLSearchParams` itself) is not comparable by value, which
   * makes it a poor thing to hold in state.
   */
  query: Readonly<Record<string, string>>
}

/** Screens with no parameters, by their single path segment. */
const FLAT = ['content', 'assets', 'access', 'model', 'redirects', 'settings', 'ui'] as const

/**
 * Splits a `pathname` + `search` string into a screen and its query.
 *
 * `mount` is the prefix the shell is served under, with no trailing slash. A path
 * outside it is `missing` rather than an exception: a stale link or a host route
 * that reached us by mistake is a screen saying so, not a crash.
 */
export function parse(url: string, mount: string): Route {
  const cut = url.indexOf('?')
  const path = cut === -1 ? url : url.slice(0, cut)
  const query = parseQuery(cut === -1 ? '' : url.slice(cut + 1))

  const rest = relative(path, mount)
  if (rest === null) return { screen: { name: 'missing', path }, query }

  const segments = rest.split('/').filter(Boolean).map(decodeURIComponent)
  return { screen: screenOf(segments, path), query }
}

function screenOf(segments: string[], path: string): Screen {
  const [head, second] = segments
  if (head === undefined) return { name: 'home' }

  if (segments.length === 1) {
    const flat = FLAT.find((name) => name === head)
    if (flat) return { name: flat }
  }

  if (segments.length === 2 && second) {
    // Two two-segment screens, and both refuse an empty parameter above rather
    // than routing to a screen that would immediately fetch `/documents/`.
    if (head === 'documents') return { name: 'documents', type: second }
    if (head === 'edit') return { name: 'edit', id: second }
  }

  return { name: 'missing', path }
}

/**
 * The path inside `mount`, or null when `url` is not under it at all.
 *
 * `''` and `'/'` both mean the mount root, which is Home — a sidebar link to
 * `{base}/ui` and one to `{base}/ui/` must not be two different screens.
 */
function relative(path: string, mount: string): string | null {
  if (path === mount) return ''
  if (path.startsWith(`${mount}/`)) return path.slice(mount.length + 1)
  return null
}

function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(search)) out[key] = value
  return out
}

/**
 * A screen's URL. The inverse of `parse`, and pinned as a round trip by test:
 * a link the sidebar writes and a URL the router reads have to be the same
 * language, or a screen becomes reachable but not linkable.
 *
 * Empty and undefined query values are dropped, so a cleared filter leaves the
 * URL rather than sitting in it as `?state=`.
 */
export function href(
  screen: Screen,
  mount: string,
  query?: Readonly<Record<string, string | undefined>>,
): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') search.append(key, value)
  }
  const tail = search.toString()
  return `${mount}${pathOf(screen)}${tail ? `?${tail}` : ''}`
}

function pathOf(screen: Screen): string {
  switch (screen.name) {
    case 'home':
      return ''
    case 'documents':
      return `/documents/${encodeURIComponent(screen.type)}`
    case 'edit':
      return `/edit/${encodeURIComponent(screen.id)}`
    case 'missing':
      return screen.path
    default:
      // Exhaustive over the flat screens: `Screen` is a closed union and every
      // other variant is handled above, so a new parameterless screen needs a
      // `FLAT` entry and nothing else.
      return `/${screen.name}`
  }
}

/** True when two routes are the same place, so the hook can skip a `pushState`
 * that would add a history entry for the URL already showing. */
export function same(a: Route, b: Route): boolean {
  return href(a.screen, '', a.query) === href(b.screen, '', b.query)
}

/* ------------------------------------------------------------- breadcrumbs --- */

export interface Crumb {
  text: string
  /** Absent for the last crumb, which is where you already are. */
  screen?: Screen
}

export interface CrumbContext {
  /** A document type's label, by name. */
  label?: (type: string) => string | undefined
  /**
   * The open document's ancestors, root first, the document itself last. What
   * turns `Content / About / Our team` from a claim into three links — and the
   * answer to `docs/ui-review.md`'s finding that a record in form mode had no
   * way back to the list it came from.
   */
  chain?: readonly { id: string; title: string }[]
  /**
   * What sits above the open document: `Content` for a page, its own type's list
   * for a record, and **nothing at all** for a global — a singleton is linked
   * straight from the sidebar and has no list to go back to, so a crumb pointing
   * at one would be a link to a list of one.
   *
   * Passed in rather than derived, deliberately. Deciding it needs the document's
   * kind, and this module is pure string handling with no dependency on the
   * content model; the first version guessed from the presence of an ancestor
   * chain and rooted every global at `Content`, which was wrong in a way only the
   * running shell showed.
   */
  root?: Crumb | null
}

const TITLES: Record<Exclude<ScreenName, 'documents' | 'edit' | 'missing'>, string> = {
  home: 'Home',
  content: 'Content',
  assets: 'Assets',
  access: 'Access',
  model: 'Model',
  redirects: 'Redirects',
  settings: 'Settings',
  ui: 'Design system',
}

/**
 * The top bar's breadcrumb: a trail, never a title. The last crumb has no
 * screen, so it renders as text rather than a link to the page you are on.
 */
export function crumbs(route: Route, ctx: CrumbContext = {}): Crumb[] {
  const s = route.screen
  if (s.name === 'home') return [{ text: 'Home' }]
  if (s.name === 'missing') return [{ text: 'Not found' }]

  if (s.name === 'documents') {
    return [{ text: ctx.label?.(s.type) ?? s.type }]
  }

  if (s.name === 'edit') {
    const chain = ctx.chain ?? []
    const trail = chain.map((node, i) => ({
      text: node.title,
      // Every ancestor is a link to itself; the open document is not.
      ...(i === chain.length - 1 ? {} : { screen: { name: 'edit' as const, id: node.id } }),
    }))
    // `root === undefined` means "not known yet" — the manifest has not landed —
    // and Content is the stable answer, so the bar does not reflow a moment later.
    // `root === null` means "there is nothing above this", which is a global.
    const above =
      ctx.root === undefined ? { text: 'Content', screen: { name: 'content' as const } } : ctx.root
    return above ? [above, ...trail] : trail
  }

  return [{ text: TITLES[s.name] }]
}

/** `document.title`. Deepest crumb first, because a tab strip truncates from the
 * right and "Our team" is what tells two tabs apart. */
export function documentTitle(route: Route, ctx: CrumbContext = {}): string {
  const trail = crumbs(route, ctx)
  const last = trail[trail.length - 1]
  return `${last ? `${last.text} · ` : ''}Folio`
}
