import type { ReactNode } from 'react'

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

/** Applies a wrapper, or does not. The one place the optionality is handled. */
export function wrapPreview(wrap: PreviewWrap | undefined, tree: ReactNode): ReactNode {
  return wrap ? wrap({ children: tree }) : tree
}
