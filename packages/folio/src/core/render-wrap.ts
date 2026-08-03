import { createElement, type ReactNode } from 'react'

/**
 * A host-supplied wrapper around a previewed document.
 *
 * Lives in `core` because both halves of the seam need it and they live on
 * opposite sides of the package: `FolioConfig.previewWrap` in `server/` for the
 * server render, and `mountPreview`'s `wrap` in `preview/` for the hydration.
 * Whichever one imported the other would be the wrong dependency.
 *
 * A plain function of `{ children }` rather than a `ComponentType`, so a host
 * can write either an arrow or a component and neither needs `React.FC`.
 */
export type PreviewWrap = (props: { children: ReactNode }) => ReactNode

/**
 * Applies a wrapper, or does not. The one place the optionality is handled.
 *
 * **`createElement`, not a call.** This was `wrap({ children: tree })`, which is
 * a plain function call: React never sees a component, so there is no fibre, no
 * dispatcher, and the *first hook* in the wrapper throws
 * `Cannot read properties of null (reading 'useState')` — from the server render,
 * so the whole preview becomes a stack trace rather than one broken section.
 *
 * It survived because the first host's wrapper had no hooks of its own: it
 * returned `<MemoryRouter>{children}</MemoryRouter>`, and *that* was an element,
 * so the router's own hooks were fine. The bug only appeared when the wrapper
 * needed state — which is the ordinary case, since a data router has to be built
 * once and held rather than rebuilt per keystroke.
 *
 * The type stays a function of `{ children }` on purpose: a host writing an
 * arrow is the point of the seam, and an arrow is a valid component. What was
 * wrong was treating the type signature as an instruction for how to invoke it.
 */
export function wrapPreview(wrap: PreviewWrap | undefined, tree: ReactNode): ReactNode {
  return wrap ? createElement(wrap, null, tree) : tree
}
