/**
 * The sidebar, as data derived from the manifest.
 *
 * `docs/ui-architecture.md` decision 3: document types are named individually,
 * because `People` is what an editor is looking for and `Data` is what a
 * developer called the category. That makes the nav generated rather than
 * written, and it makes the grouping rule — flat under about eight types,
 * grouped past it — a pure function with a threshold worth pinning by test.
 *
 * Pure and free of React on purpose, like `route.ts` and `rank.ts`: the admin's
 * tests run in Node and mount nothing (`vitest.config.ts`).
 */
import { type DocumentType, singletonId } from '../../core/schema'
import { canManageAccess, type Me } from '../me'
import type { Screen } from './route'

export interface NavItem {
  label: string
  screen: Screen
  /**
   * A single glyph, which is what the 48px collapsed rail shows. Deliberately
   * data rather than JSX so this module stays free of React — and a placeholder:
   * `docs/ui-architecture.md` lists an icon set as a dependency, and
   * `docs/ui-review.md`'s complaint about the two bare `↻` buttons applies to any
   * glyph without an accessible name, which is why `Sidebar` gives every one of
   * these a label even when it is drawing only the icon.
   */
  icon: string
}

export interface NavGroup {
  /** Absent for the first group, which needs no heading over five items. */
  label?: string
  items: NavItem[]
  /** Collapsible groups remember their state; the primary and admin groups are
   * not collapsible, because a nav you can hide the whole of is a nav you can
   * lose. */
  collapsible?: boolean
}

export interface NavInput {
  types: readonly DocumentType[]
  globals: readonly string[]
  me: Me
}

/**
 * The threshold from decision 3, named so the test and the comment cannot drift.
 * "About eight" in prose; eight here, and the rule is *more than* eight groups.
 */
export const GROUP_AT = 8

export function nav(input: NavInput): NavGroup[] {
  const groups: NavGroup[] = [{ items: primary(input.types) }]

  const singles = input.types.filter((t) => t.kind === 'singleton')
  if (singles.length > 0) groups.push(globalsGroup(singles, input.globals))

  const records = input.types.filter((t) => t.kind === 'record')
  if (records.length > GROUP_AT || records.some((t) => t.group)) {
    groups.push(...recordGroups(records))
  }

  groups.push({ items: administration(input.me) })
  return groups
}

/**
 * Home, Content, the record types, Assets — the shape of the mock in
 * `docs/ui-architecture.md`. Record types are here **only while they are few**:
 * past `GROUP_AT`, or the moment any type declares a `group`, they move to
 * headed groups below and this list is Home, Content and Assets alone.
 */
function primary(types: readonly DocumentType[]): NavItem[] {
  const records = types.filter((t) => t.kind === 'record')
  const inline = records.length > GROUP_AT || records.some((t) => t.group) ? [] : records
  return [
    { label: 'Home', icon: '⌂', screen: { name: 'home' } },
    { label: 'Content', icon: '☰', screen: { name: 'content' } },
    ...inline.map(itemFor),
    { label: 'Assets', icon: '⬚', screen: { name: 'assets' } },
  ]
}

const itemFor = (type: DocumentType): NavItem => ({
  label: type.label,
  icon: '▤',
  screen: { name: 'documents', type: type.name },
})

/**
 * One group per declared `group`, in first-appearance order — the same rule the
 * palette uses for its headings, and the answer to `ui-architecture.md`'s open
 * question 1: a declared group implies an order, and alphabetical would be a
 * guess that fights the declaration order every other list in Folio respects.
 *
 * Types with no `group` on a site where others have one fall under `Documents`,
 * last. That is the honest place for them: they are the ones nobody classified.
 */
function recordGroups(records: readonly DocumentType[]): NavGroup[] {
  const named = new Map<string, NavItem[]>()
  const rest: NavItem[] = []
  for (const type of records) {
    if (!type.group) {
      rest.push(itemFor(type))
      continue
    }
    const bucket = named.get(type.group)
    if (bucket) bucket.push(itemFor(type))
    else named.set(type.group, [itemFor(type)])
  }

  const groups: NavGroup[] = [...named].map(([label, items]) => ({
    label,
    items,
    collapsible: true,
  }))
  if (rest.length > 0) groups.push({ label: 'Documents', items: rest, collapsible: true })
  return groups
}

/**
 * Every singleton, linking straight to its one document — a singleton's id is
 * derived from its type name (`singletonId`), so the nav can address the document
 * without a request, and a list screen for it would be a list of one.
 *
 * The label is `Globals`, and it is doing slightly more work than the word
 * implies: `Manifest.globals` is a *subset* of the singleton types, and a
 * singleton that is not a global is still exactly one document somebody has to
 * reach. Declared globals come first, then the rest in declaration order, because
 * that ordering is a real distinction even though the heading is not.
 */
function globalsGroup(singles: readonly DocumentType[], globals: readonly string[]): NavGroup {
  const declared = globals.filter((name) => singles.some((t) => t.name === name))
  const order = [...declared, ...singles.map((t) => t.name).filter((n) => !declared.includes(n))]
  const byName = new Map(singles.map((t) => [t.name, t]))
  return {
    label: 'Globals',
    collapsible: true,
    items: order.flatMap((name) => {
      const type = byName.get(name)
      if (!type) return []
      return [
        {
          label: type.label,
          // `·` first, matching the mock in `ui-architecture.md` — and illegible
          // at 48px, where the glyph is the only thing on screen. A placeholder
          // still has to be visible.
          icon: '◆',
          screen: { name: 'edit' as const, id: singletonId(type) },
        },
      ]
    }),
  }
}

/**
 * The administration group. `Access` is absent rather than disabled when the
 * actor cannot manage it — the rule `ui-architecture.md` states as
 * "controls that cannot act are absent, not disabled", and the reason
 * `canManageAccess` already refuses it under `auth: 'open'`, where the server
 * 404s the surface too.
 *
 * `Model` and `Settings` stay: a migration list and a read-only mirror of the
 * host's configuration are things a non-admin editor can legitimately read, and
 * both explain a document being *behind the model*, which is a state an editor
 * sees in the inspector and currently cannot investigate.
 */
function administration(me: Me): NavItem[] {
  return [
    { label: 'Model', icon: '⚙', screen: { name: 'model' } },
    { label: 'Redirects', icon: '↪', screen: { name: 'redirects' } },
    ...(canManageAccess(me)
      ? [{ label: 'Access', icon: '⚿', screen: { name: 'access' as const } }]
      : []),
    { label: 'Settings', icon: '⚙', screen: { name: 'settings' } },
  ]
}

/**
 * Which nav item a route lights up. Not `===` on the screen, because the editor
 * is reached *from* Content and from a type's list, and a sidebar that highlights
 * nothing while a document is open loses the user their orientation — the exact
 * thing decision 2 says a persistent nav is for.
 *
 * `type` is the open document's type, which is what tells a record's editor from
 * a page's. Undefined means "not known yet", and Content is the safe answer:
 * the tree is where most documents live.
 */
export function activeItem(groups: readonly NavGroup[], screen: Screen, type?: string): Screen {
  if (screen.name !== 'edit') return screen
  const match = groups
    .flatMap((g) => g.items)
    .find((i) => i.screen.name === 'edit' && i.screen.id === screen.id)
  if (match) return match.screen
  if (type) {
    const list = groups
      .flatMap((g) => g.items)
      .find((i) => i.screen.name === 'documents' && i.screen.type === type)
    if (list) return list.screen
  }
  return { name: 'content' }
}
