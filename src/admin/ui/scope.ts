/**
 * The class that turns `tokens.css`'s global layer on.
 *
 * **Everything in `tokens.css` outside `:root` is scoped under `.folio-ui`**, and
 * that scoping is deliberate — the admin mounts into a *host's* document and must
 * not restyle it, the same discipline that keeps `folio.handle()` from
 * intercepting a host's routes. The cost of the choice is that the layer is
 * opt-in, and a subtree that forgets the class silently loses:
 *
 *   - `box-sizing: border-box`, so every `width: 100%` control overflows its
 *     parent by exactly its own padding plus border;
 *   - the one focus treatment, so only components that draw their own ring have
 *     any focus at all;
 *   - the UI font, the app background, and the reduced-motion override.
 *
 * That is not hypothetical. For the whole of the port the class was on
 * `Kitchen.tsx` and **nowhere else** — the design system was reviewed on the
 * kitchen-sink page, which is the one page that had it — so in the real admin
 * every text input in the inspector and every field in a record's form was 18px
 * wider than the panel containing it, clipped at the panel's edge. It read as
 * "the right panel has no padding", which is what it was reported as.
 *
 * So: a constant rather than a string literal in six files, because the failure
 * mode of forgetting it is a layout that looks like a padding bug three
 * components away from the omission. `scope-test.ts` asserts every portal root
 * carries it.
 *
 * **A portal must re-declare it.** `createPortal` moves a subtree to
 * `document.body`, which is outside the shell, so CSS scoping does not follow it
 * — a dialog inherits nothing from the screen that opened it. Four surfaces
 * portal today (`Dialog`, `Palette`, `FocusMode`, `HistoryPanel`) and each one
 * puts this on its own outermost node.
 */
export const UI_SCOPE = 'folio-ui'

/** `UI_SCOPE` joined with a component's own classes, skipping the falsy ones. */
export const scoped = (...classes: (string | false | undefined)[]): string =>
  [UI_SCOPE, ...classes].filter(Boolean).join(' ')
