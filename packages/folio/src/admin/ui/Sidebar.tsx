import { useState } from 'react'
import { ICONS } from './icons'
import { href, type Screen } from './route'
import css from './Sidebar.module.css'
import type { NavGroup } from './nav'

interface Props {
  groups: readonly NavGroup[]
  /** Which item is lit. `nav.ts`'s `activeItem`, which is not always the current
   * screen — an open document lights up the list it came from. */
  active: Screen
  mount: string
  collapsed: boolean
  onToggle: () => void
}

const key = (screen: Screen): string =>
  screen.name === 'documents'
    ? `documents:${screen.type}`
    : screen.name === 'edit'
      ? `edit:${screen.id}`
      : screen.name

/**
 * The left sidebar: labelled, collapsible to a 48px icon rail, and the same on
 * every screen including the editor (`docs/ui-architecture.md`, the shell).
 *
 * Two things it does that the admin's current rail does not. Every item is an
 * `<a href>`, so the whole nav is copyable, cmd-clickable and crawlable by the
 * browser's own affordances — `useRouter` intercepts the click, it does not
 * replace the link. And **collapsed items keep their accessible name**: the
 * review's complaint about the two bare `↻` buttons was an unlabelled glyph, and
 * a 48px rail is nothing but icons, so each carries a `title` and the label text
 * stays in the DOM for a screen reader. The icons themselves are `aria-hidden`
 * (`icons.tsx`), which is what keeps that one name from being announced twice.
 */
export function Sidebar({ groups, active, mount, collapsed, onToggle }: Props) {
  const activeKey = key(active)
  return (
    <nav
      className={`${css.sidebar} ${collapsed ? css.collapsed : ''}`}
      aria-label="Sections"
      data-collapsed={collapsed ? '' : undefined}
    >
      <div className={css.brand}>
        {collapsed ? null : <span className={css.wordmark}>Folio</span>}
        <button
          type="button"
          className={css.toggle}
          onClick={onToggle}
          title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (⌘\\)`}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} sidebar`}
          aria-expanded={!collapsed}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {groups.map((group, i) => (
        <Group
          // Groups have no id of their own — an unlabelled primary group and an
          // unlabelled admin group are both legitimate — so the index is the
          // honest key here rather than a fabricated one.
          key={group.label ?? `group-${i}`}
          group={group}
          activeKey={activeKey}
          mount={mount}
          collapsed={collapsed}
        />
      ))}
    </nav>
  )
}

function Group({
  group,
  activeKey,
  mount,
  collapsed,
}: {
  group: NavGroup
  activeKey: string
  mount: string
  collapsed: boolean
}) {
  const [open, setOpen] = useState(true)
  // A collapsed rail has no room for a heading, so a collapsible group is drawn
  // open: hiding items behind a heading nobody can see would make them
  // unreachable rather than tidy.
  const shown = collapsed || !group.collapsible || open

  return (
    <div className={css.group}>
      {group.label && !collapsed ? (
        group.collapsible ? (
          <button
            type="button"
            className={css.heading}
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            <span className={css.chevron} data-open={open ? '' : undefined}>
              ›
            </span>
            {group.label}
          </button>
        ) : (
          <h2 className={css.heading}>{group.label}</h2>
        )
      ) : null}

      {shown
        ? group.items.map((item) => {
            const on = key(item.screen) === activeKey
            return (
              <a
                key={key(item.screen)}
                className={`${css.item} ${on ? css.on : ''}`}
                href={href(item.screen, mount)}
                aria-current={on ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
              >
                {/* The lookup lives here, not in `nav.ts`: the nav is data and
                    stays free of React, so it carries the icon's name and this
                    is where a name becomes a drawing. `ICONS` is a `Record` over
                    the same union, so there is no missing case to fall back
                    for. */}
                <span className={css.icon} aria-hidden="true">
                  {ICONS[item.icon]}
                </span>
                <span className={collapsed ? css.hidden : css.label}>{item.label}</span>
              </a>
            )
          })
        : null}
    </div>
  )
}
