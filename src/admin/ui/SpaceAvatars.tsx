import type { SpaceAvatar } from '../spaceStore'
import css from './SpaceAvatars.module.css'
import { avatarLabel, initialsOf } from './space-mount'

/**
 * Who else is in this site, in the top bar's `presence` slot
 * (`../../../docs/specs/editing/live-collaboration.md`, and `docs/handbook.md`'s
 * "What it buys, on every open editor").
 *
 * One circle per *actor*, not per socket: `avatarsOf` dedupes two tabs into one
 * entry carrying a `tabs` count, because two presences is the truth on the wire
 * and two identical circles side by side is noise. The count is in the label
 * rather than on a badge, since it is a curiosity rather than something to act
 * on.
 *
 * **Renders nothing when nobody else is here**, which is most of the time on a
 * one-editor site, and is also what a deployment with no `SPACE` binding gets:
 * `useSpace` builds no store and opens no socket, so `avatars` is empty and the
 * bar looks exactly as it did before this existed. No empty row holding layout,
 * no "0 online".
 *
 * Deferred, and deliberately not here (owner, 2026-09-07): dots on tree rows,
 * and follow mode on click. This is a status display, so it is not a button —
 * a control that looks clickable and is not is worse than a plain one.
 *
 * No `scoped()`: this renders inside `Shell`, which declares the scope on its
 * root. Only a portal has to re-declare it, and this does not portal — if a
 * hovercard is ever added here it will, and `test/unit/admin/ui-scope.test.ts`
 * will say so.
 */
export function SpaceAvatars({ avatars }: { avatars: readonly SpaceAvatar[] }) {
  if (avatars.length === 0) return null
  return (
    <span className={css.avatars}>
      {avatars.map((avatar) => {
        const label = avatarLabel(avatar)
        return (
          <span
            key={avatar.actor}
            className={css.avatar}
            // The actor's own colour, from presence. Derived from the actor id
            // by `fallbackColour`, so it is stable per person across tabs — and
            // it matches their field ring in the editor only on a deployment
            // with accounts. Under `auth: 'open'` `StoryStore` generates a
            // separate actor and picks randomly from its own palette, so the two
            // will not agree; that is a property of having no identity, not
            // something this row can fix.
            style={{ background: avatar.colour }}
            // Both, and they say the same thing: `title` for a pointer, and a
            // real accessible name because a coloured circle has none. `role`
            // is what makes the label be read at all on a `span`.
            title={label}
            aria-label={label}
            role="img"
          >
            {initialsOf(avatar.name)}
          </span>
        )
      })}
    </span>
  )
}
