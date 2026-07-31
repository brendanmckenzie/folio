import type { ReactNode } from 'react'
import type { MenuItem } from './Menu'
import type { NavGroup } from './nav'
import type { Crumb, Screen } from './route'
import { scoped } from './scope'
import css from './Shell.module.css'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

interface Props {
  groups: readonly NavGroup[]
  active: Screen
  crumbs: readonly Crumb[]
  mount: string
  /** Held above this component so `⌘\` can reach it — the shortcut and the
   * sidebar's own toggle have to drive the same value, and the remembering is
   * per-surface (`remembered.ts`). */
  collapsed: boolean
  onToggleSidebar: () => void
  presence?: ReactNode
  onSearch: () => void
  actor: string | null
  user: readonly MenuItem[]
  children: ReactNode
  /** Lets the editor take the whole area with no padding, while a platform screen
   * gets the gutter every list wants. */
  bare?: boolean
}

/**
 * The frame: sidebar, top bar, screen. Constant on every screen including the
 * editor, which is decision 2 — focus comes from collapsing a persistent thing,
 * not from swapping shells, because a collapse is reversible in one keystroke and
 * does not cost the user their orientation.
 */
export function Shell({
  groups,
  active,
  crumbs,
  mount,
  collapsed,
  onToggleSidebar,
  presence,
  onSearch,
  actor,
  user,
  children,
  bare,
}: Props) {
  return (
    // `scoped`, not `css.shell` alone: this is the root of every screen, and
    // `tokens.css`'s global layer only exists under `UI_SCOPE`. See `scope.ts`.
    <div className={scoped(css.shell)}>
      <Sidebar
        groups={groups}
        active={active}
        mount={mount}
        collapsed={collapsed}
        onToggle={onToggleSidebar}
      />
      <div className={css.main}>
        <TopBar
          crumbs={crumbs}
          mount={mount}
          presence={presence}
          onSearch={onSearch}
          actor={actor}
          user={user}
        />
        <main className={bare ? css.bare : css.screen}>{children}</main>
      </div>
    </div>
  )
}
