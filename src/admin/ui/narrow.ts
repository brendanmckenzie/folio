import { useEffect, useState } from "react";

/**
 * Below this the sidebar stops sharing the row with the screen. 240px of
 * labelled sidebar on a 390px viewport left `main` about 150px wide, so every
 * list scrolled sideways. Held as a media query string so the stylesheet and
 * this hook cannot name different widths: `Shell.module.css` repeats the number
 * and `narrow.test.ts` pins that they agree.
 */
export const NARROW_QUERY = "(max-width: 720px)";

/**
 * Whether the sidebar is drawn as the 48px rail. At a narrow width it always
 * is, whatever was remembered: the remembered value is a desktop preference
 * (`remembered.ts`), and a labelled sidebar in the row is the thing that is
 * unusable there. Expanding it is a transient overlay (`Shell`), not a change
 * to the remembered value.
 */
export function railShown(narrow: boolean, remembered: boolean): boolean {
  return narrow || remembered;
}

/** Tracks `NARROW_QUERY`. False until mounted, and wherever `matchMedia` is absent. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => matches());
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

function matches(): boolean {
  return typeof matchMedia === "function" && matchMedia(NARROW_QUERY).matches;
}
