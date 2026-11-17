import { type ReactNode, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { MenuItem } from "./Menu";
import type { NavGroup, ScopeOptionGroup } from "./nav";
import type { Crumb, Screen } from "./route";
import { railShown, useNarrow } from "./narrow";
import { scoped } from "./scope";
import css from "./Shell.module.css";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

interface Props {
  groups: readonly NavGroup[];
  active: Screen;
  crumbs: readonly Crumb[];
  mount: string;
  /** Held above this component so `⌘\` can reach it — the shortcut and the
   * sidebar's own toggle have to drive the same value, and the remembering is
   * per-surface (`remembered.ts`). */
  collapsed: boolean;
  onToggleSidebar: () => void;
  presence?: ReactNode;
  onSearch: () => void;
  actor: string | null;
  user: readonly MenuItem[];
  children: ReactNode;
  /** Lets the editor take the whole area with no padding, while a platform screen
   * gets the gutter every list wants. */
  bare?: boolean;
  /** The scope switcher, on a deployment with `sites`. See `Sidebar`. */
  switcher?: {
    groups: readonly ScopeOptionGroup[];
    current: string | null;
    onSwitch: (scope: string) => void;
  };
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
  switcher,
}: Props) {
  const narrow = useNarrow();
  // Narrow: the rail is always the 48px strip and `»` opens the full sidebar over
  // the screen, so the screen keeps the viewport. Wide: unchanged.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!narrow) setOpen(false);
  }, [narrow]);
  const sidebar = (
    <Sidebar
      groups={groups}
      active={active}
      mount={mount}
      collapsed={railShown(narrow, collapsed)}
      onToggle={narrow ? () => setOpen(true) : onToggleSidebar}
      {...(switcher ? { switcher } : {})}
    />
  );
  return (
    // `scoped`, not `css.shell` alone: this is the root of every screen, and
    // `tokens.css`'s global layer only exists under `UI_SCOPE`. See `scope.ts`.
    <div className={scoped(css.shell)}>
      {narrow ? <div className={css.slot}>{sidebar}</div> : sidebar}
      {narrow && open ? (
        <NavOverlay onClose={() => setOpen(false)}>
          <Sidebar
            groups={groups}
            active={active}
            mount={mount}
            collapsed={false}
            onToggle={() => setOpen(false)}
            {...(switcher ? { switcher } : {})}
          />
        </NavOverlay>
      ) : null}
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
  );
}

/**
 * The sidebar opened over a narrow screen. Rendered inside the shell, not
 * portalled, so it inherits `.folio-ui` and needs no `scoped()` of its own. The
 * trap is mounted with it, so focus moves in on open and returns to the `»` that
 * opened it on close.
 */
function NavOverlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, onClose);
  return (
    <div className={scoped(css.overlay)}>
      <button
        type="button"
        className={css.scrim}
        tabIndex={-1}
        aria-label="Close sidebar"
        onClick={onClose}
      />
      {/* A link click navigates (`useRouter` intercepts it), and the sidebar has
          done its job once it has. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the click is delegated from links, which are already keyboard operable. */}
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Sections"
        tabIndex={-1}
        className={css.panel}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) onClose();
        }}
      >
        {children}
      </div>
    </div>
  );
}
