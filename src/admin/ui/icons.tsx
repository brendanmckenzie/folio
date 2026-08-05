/**
 * The admin's icons, drawn here rather than imported.
 *
 * These replace the unicode placeholders the sidebar shipped with, and the defect
 * they fix is not "the glyphs were ugly" — it is that a set assembled from
 * whatever the UI font happens to contain has no consistent weight, grid or
 * optical size. `▤` is a striped box, `⬚` is nearly invisible, `⚿` has no glyph
 * at all in most UI fonts and rendered as tofu, `◆` is solid black next to `⌂`'s
 * hairline, and `⚙` was used for two different nav items. Consistency is the
 * whole feature, so it is enforced in one place: **`svg()` below owns the grid
 * (24), the stroke (1.5), the caps and the joins, and no icon states them.** An
 * icon that wants a different weight cannot express it without editing the
 * wrapper, which is the point.
 *
 * Drawn by hand, in a 24-unit box with roughly 4 units of padding, and rendered
 * at 16px. That is small enough that detail is worse than useless — it fills in.
 * Two to four shapes each (`content` is five and says why), and no gap narrower
 * than about 3 units, because a 1.5 stroke eats 1 unit either side of one.
 *
 * **Judge them at 16px, in the running admin, not at the size you draw them.**
 * Every note below about a rejected alternative is a shape that looked better in
 * a 72px preview and turned to mush or to something else entirely in the rail.
 *
 * `stroke="currentColor"` and no `fill` is what makes them free in dark mode:
 * `Sidebar.module.css` colours the wrapper and the icon follows, including the
 * accent it takes on the active item.
 *
 * Every `<svg>` is `aria-hidden` and unfocusable. The name comes from the item's
 * label text, which stays in the DOM even on the 48px rail (see `Sidebar`); an
 * icon with its own accessible name would announce every nav item twice.
 */
import type { ReactElement, ReactNode } from 'react'

/**
 * The names a nav item may ask for, which is a closed set on purpose. `nav.ts`
 * types `NavItem.icon` as this and `ICONS` is a `Record` over it, so a tenth nav
 * item that forgets to add a drawing is a type error in two places rather than a
 * blank 16px box in the rail.
 *
 * Named for the role, not the drawing — `records` rather than `table` — because
 * the role is what the nav knows and what has to stay stable if a drawing is
 * later redrawn.
 */
export type IconName =
  | 'home'
  | 'content'
  | 'records'
  | 'assets'
  | 'global'
  | 'model'
  | 'redirects'
  | 'schedules'
  | 'access'
  | 'settings'

/** The one place the grid, the weight, the caps and the joins are stated. */
const svg = (children: ReactNode): ReactElement => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
)

/**
 * Elements, not components, and shared between renders — a React element is
 * immutable, so one `ICONS.home` rendered in two places is not a hazard.
 */
export const ICONS: Record<IconName, ReactElement> = {
  /** A house: roof, walls, door. The door is what stops it reading as a pentagon
   * on a box at 16px. */
  home: svg(
    <>
      <path d="M3.75 11 12 4l8.25 7" />
      <path d="M5.75 9.75V20h12.5V9.75" />
      <path d="M10.25 20v-4.25h3.5V20" />
    </>,
  ),
  /** A sitemap: one node over two, joined. Content is the page *tree*, and depth
   * is the only thing that distinguishes it from `records`, so the drawing has to
   * carry depth or it is carrying nothing.
   *
   * Five shapes, which is more than anything else here, and they were bought
   * rather than spent. The obvious drawing — a trunk with indented rows, the file
   * tree of every editor sidebar — was tried at 16px in three variants and every
   * one of them read as `☰` with a bracket, which is exactly the glyph this set
   * replaced. Nodes are what make it a hierarchy at this size; rows are not. */
  content: svg(
    <>
      <rect x="9" y="3.5" width="6" height="5" rx="1.25" />
      <rect x="4" y="15.5" width="6" height="5" rx="1.25" />
      <rect x="14" y="15.5" width="6" height="5" rx="1.25" />
      <path d="M12 8.5v3.5" />
      <path d="M7 15.5v-3.5h10v3.5" />
    </>,
  ),
  /** A table: frame, header rule, column divider. Every declared record type gets
   * this one — a per-type drawing would be a manifest field, and the nav cannot
   * invent an icon for a type it has never seen.
   *
   * The divider runs the full height rather than stopping under the header, which
   * looks like the more careful drawing and is not: stopped, the three regions
   * read as a wide band over two panes, which is a layout, not a table. Crossed,
   * it is a grid. */
  records: svg(
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
      <path d="M4.5 9.5h15" />
      <path d="M12 4.5v15" />
    </>,
  ),
  /** A picture: frame, sun, horizon. Same frame as `records`, which is fine —
   * what is inside it differs at a glance, and both are genuinely "a rectangle
   * with contents". */
  assets: svg(
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
      <circle cx="9.25" cy="9.5" r="1.75" />
      <path d="M19.5 15.5 15.25 11.25 7 19.5" />
    </>,
  ),
  /** A globe, for the group literally labelled Globals. The meridian is two arcs
   * of a much larger circle, which is what keeps it a lens rather than an
   * ellipse that reads as a second ring. */
  global: svg(
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M4.5 12h15" />
      <path d="M12 4.5a10.9 10.9 0 0 0 0 15 10.9 10.9 0 0 0 0-15" />
    </>,
  ),
  /**
   * A box, for the content model. Deliberately the only non-flat silhouette in
   * the set: the alternative — three rectangles as "blocks" — needs two 3-unit
   * gaps to survive, and at 16px a 1.5 stroke closes them into one grey mass.
   *
   * It was drawn with the reservation that a box says "package" rather than
   * "content model", and the reservation is withdrawn: a cube is the conventional
   * mark for a *component* — Figma's, Storybook's — and a component is exactly what
   * Folio's unit is. The screen it labels is mostly block types. So the metaphor is
   * the domain's own, and it is unmistakably not the Settings sliders, which was the
   * defect being fixed (both nav items used to draw `⚙`).
   */
  model: svg(
    <>
      <path d="M12 4.25 20 8.5v7l-8 4.25-8-4.25v-7z" />
      <path d="M4 8.5 12 12.75 20 8.5" />
      <path d="M12 12.75v7" />
    </>,
  ),
  /** An arrow that turns a corner: one path in, one path out, which is what a
   * redirect is. */
  redirects: svg(
    <>
      <path d="M4.5 4.5v7a4 4 0 0 0 4 4h11" />
      <path d="M16 12l3.5 3.5L16 19" />
    </>,
  ),
  /**
   * A clock: face, hour hand up, minute hand to the lower right.
   *
   * Two shapes, and the hands are one path rather than two because a join at the
   * centre is what reads as a pivot — drawn as two separate strokes they meet at a
   * point and the 1.5 weight makes that point a blob at 16px.
   *
   * Rejected a calendar page, which is the more literal "schedule": at this size the
   * grid inside it fills to a grey rectangle, and it would also be the third
   * rounded-square outline in the rail after Content and Records. A clock is the only
   * circular icon in the set, which is exactly what a nav item wants.
   */
  schedules: svg(
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 7.5v5l3.25 2" />
    </>,
  ),
  /** A key: bow, shaft, one tooth. One rather than the usual two — two teeth
   * 2 units apart merge at 16px, and one is enough to stop the shaft reading as
   * a stray diagonal. */
  access: svg(
    <>
      <circle cx="15.5" cy="8.5" r="4" />
      <path d="M12.7 11.3 4.5 19.5" />
      <path d="M7.5 16.5 10 19" />
    </>,
  ),
  /** Two sliders. A gear would be the obvious answer and it is the wrong one at
   * this size — eight teeth on a 16px circle is a fuzzy ring — and a gear is
   * also what the placeholder used for `model` *and* `settings`, which is the
   * collision being fixed. Each track stops short of its knob rather than
   * running under it. */
  settings: svg(
    <>
      <circle cx="7.75" cy="8.25" r="2.75" />
      <path d="M11.5 8.25h8" />
      <circle cx="16.25" cy="15.75" r="2.75" />
      <path d="M4.5 15.75h8" />
    </>,
  ),
}
