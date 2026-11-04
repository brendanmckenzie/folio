import type { CSSProperties, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import css from "./Menu.module.css";
import { nextIndex } from "./rank";

export interface MenuItem {
  id: string;
  label: ReactNode;
  /** Disabled with a reason, never disabled silently. */
  disabled?: boolean;
  reason?: string;
  danger?: boolean;
  run: () => void;
}

interface Props {
  /** The trigger's label. */
  trigger: ReactNode;
  /** Accessible name when the trigger is a glyph. The review found two bare `↻`
   * buttons with no name at all, so this is required whenever `trigger` is not
   * text. */
  label?: string;
  align?: "start" | "end";
  items: readonly MenuItem[];
}

/**
 * The only popover. Replaces five hand-rolled ones — the publish split button,
 * the user menu, "who's here", the block picker and the type picker — each of
 * which had its own scrim element and its own z-index.
 *
 * Items are **data, not JSX handlers**, because the command palette reads the
 * same shape. An action declared once can appear in a menu, in the palette and
 * behind a shortcut without being written three times.
 */
export function Menu({ trigger, label, align = "end", items }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);

  // The list is absolutely positioned under the trigger, so there is no ancestor
  // whose height a percentage could resolve against (and a percentage of its own
  // track is the circularity Dialog.module.css documents). Measure what is actually
  // left below the trigger instead and hand it to the stylesheet as a variable; the
  // CSS keeps a viewport-relative cap for the one frame before this runs.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const bottom = box.current?.getBoundingClientRect().bottom;
      if (bottom === undefined) return;
      // 4px gap under the trigger (`.list` top) plus 8px breathing room at the edge.
      setRoom(Math.max(120, window.innerHeight - bottom - 12));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  // Keep the keyboard-active item visible when the list scrolls.
  useEffect(() => {
    if (!open || active < 0) return;
    const el = list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[active];
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  // Close on an outside click, and on Escape, without a scrim element: a scrim
  // has to be excluded from the tab cycle, sized, z-indexed and given a name,
  // and a document listener does the same job with none of that.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    setOpen(false);
    item.run();
  };

  return (
    <div ref={box} className={css.wrap}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${css.trigger} ${open ? css.triggerOpen : ""}`}
        onClick={() => {
          setActive(-1);
          setOpen((v) => !v);
        }}
      >
        {trigger}
      </button>
      {open ? (
        <div
          className={`${css.list} ${align === "start" ? css.start : css.end}`}
          role="menu"
          ref={list}
          style={room === null ? undefined : ({ "--menu-max-h": `${room}px` } as CSSProperties)}
          // Roving focus is overkill for a five-item menu; a single keydown
          // handler on the container with an active index reads the same to a
          // user and is one place to get right.
          onKeyDown={(e) => {
            const next = nextIndex(e.key, active, items.length);
            if (next !== null) {
              e.preventDefault();
              setActive(next);
              return;
            }
            if (e.key === "Enter" && active >= 0) {
              e.preventDefault();
              const item = items[active];
              if (item) choose(item);
            }
          }}
        >
          {items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.disabled ? item.reason : undefined}
              className={[
                css.item,
                item.danger ? css.danger : "",
                i === active ? css.active : "",
              ].join(" ")}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
