/**
 * **Every portal's rendered root carries the scope class.**
 *
 * `ui-scope.test.ts` asserts this by reading source text and is not replaced by
 * this file — the two catch different things and both are worth keeping:
 *
 *   - the static check walks *every* `.tsx` under `src/admin/`, so a fifth portal
 *     added tomorrow is covered without anybody remembering to add it here, and it
 *     also checks the stylesheet's own selectors, which no render can see;
 *   - it can only prove the class is *applied somewhere in the file*. It cannot
 *     prove it lands on the node `createPortal` actually mounts. Move
 *     `scoped(css.wrap)` one element inwards and the static check still passes
 *     while every token silently stops applying — which is the exact failure mode
 *     that shipped for eight phases, one level up.
 *
 * So this is the "does it land on the outermost node" half, and the count guard at
 * the bottom is what stops the enumeration below going stale.
 *
 * Rendered directly rather than through the shell, deliberately: the claim is
 * about each portal component, not about the shortcut or the screen that opens it.
 * Whether `⌘K` opens the palette is `ui-shortcuts.test.ts`'s business.
 */
import { render } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Doc } from '../../../../src/core/doc'
import type { Trail } from '../../../../src/admin/hooks/useVersions'
import { UI_SCOPE } from '../../../../src/admin/ui/scope'
import { Dialog } from '../../../../src/admin/ui/Dialog'
import { Palette } from '../../../../src/admin/ui/Palette'
import { FocusMode } from '../../../../src/admin/ui/screens/FocusMode'
import { HistoryPanel } from '../../../../src/admin/ui/screens/HistoryPanel'
import { MANIFEST } from './fixture'

const DOC: Doc = {
  root: 'r1',
  bloks: {
    r1: { uid: 'r1', type: 'pageRoot', parent: null, slot: null, order: 'a0', data: {} },
  },
}

const trail = <T,>(): Trail<T> => ({
  rows: [] as readonly T[],
  cursor: null,
  loading: false,
  more: async () => {},
  reload: async () => {},
})

/**
 * The four surfaces that portal, each as the element `createPortal` is given.
 *
 * Every one is mounted with the smallest props that render it, because the claim
 * is about one class name and nothing else. `HistoryPanel` needs `open` because
 * its early return is what makes `open` mean *mounted*. Factories rather than held
 * elements, for the reason `dialogs.test.tsx` gives.
 */
const PORTALS: [name: string, mount: () => React.ReactElement][] = [
  ['Dialog', () => <Dialog title="A dialog" onClose={() => {}} />],
  ['Palette', () => <Palette actions={[]} onClose={() => {}} />],
  [
    'FocusMode',
    () => (
      <FocusMode title="Body" onClose={() => {}}>
        <p>prose</p>
      </FocusMode>
    ),
  ],
  [
    'HistoryPanel',
    () => (
      <HistoryPanel
        open
        onClose={() => {}}
        doc={DOC}
        schema={{}}
        versionTrail={trail()}
        activityTrail={trail()}
        onReload={async () => {}}
        busy={false}
        viewingId={null}
        onCheckpoint={async () => {}}
        onView={async () => {}}
        onExitView={() => {}}
        onRestore={async () => {}}
        peerNames={{}}
      />
    ),
  ],
]

describe('every portal carries the scope on the node it mounts', () => {
  for (const [name, build] of PORTALS) {
    it(name, () => {
      // `baseElement`, not `container`: a portal's subtree is under
      // `document.body` and is not in the container Testing Library made. That is
      // the whole property being asserted — a portal leaves the shell, so CSS
      // scoping does not follow it and it has to re-declare the class itself.
      const { baseElement, container } = render(build())
      const mounted = [...baseElement.children].filter((el) => el !== container)

      expect(mounted.length, `${name} rendered no portal subtree`).toBeGreaterThan(0)
      for (const root of mounted) {
        expect(
          root.classList.contains(UI_SCOPE),
          `${name}'s portal root is <${root.tagName.toLowerCase()} class="${root.className}">, ` +
            `which does not carry .${UI_SCOPE} — every token in tokens.css is off inside it`,
        ).toBe(true)
      }
    })
  }
})

/**
 * The guard on the list above.
 *
 * A fifth portal is the case a render test is supposed to catch that a static
 * check misses, and the way it would actually go uncaught is by nobody adding it
 * to `PORTALS`. So the count is asserted rather than trusted: this file fails the
 * moment `createPortal` appears in a file that is not one of the four, and the
 * failure names the file.
 */
describe('the list of portals is complete', () => {
  /**
   * `node:path` against `import.meta.dirname`, and **not** `new URL(relative,
   * import.meta.url)` — which is what `ui-scope.test.ts` uses one directory up and
   * which does not work here. In this project `globalThis.URL` is happy-dom's
   * implementation, not Node's, and it resolves that pair to `/src/admin/ui/index.ts`
   * instead of an absolute path into the repo. A DOM environment replaces more
   * globals than `document`, and this is the one that bites a test reading files.
   */
  const ADMIN = join(import.meta.dirname, '../../../../src/admin')

  const tsxUnder = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(join(ADMIN, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(...tsxUnder(`${dir}/${entry.name}`))
      else if (entry.name.endsWith('.tsx')) out.push(`${dir}/${entry.name}`)
    }
    return out
  }

  // A text match, so a *comment* containing `createPortal(` reds this too. That is
  // how the check was verified — planting the string in a comment in `Stub.tsx` is
  // the cheapest way to prove the guard fires — and it is the right trade: a
  // parser here would be more code than the thing it guards, and a false positive
  // is a one-word comment edit while a false negative is an unscoped portal.
  it('is every file in the tree that calls createPortal', () => {
    const portalling = tsxUnder('ui')
      .filter((path) => readFileSync(join(ADMIN, path), 'utf8').includes('createPortal('))
      .map((path) => path.split('/').pop()?.replace('.tsx', ''))
      .sort()

    expect(portalling).toEqual(PORTALS.map(([name]) => name).sort())
  })
})

/** Kept honest: the fixture's manifest is imported, so this file fails if it rots. */
it('mounts against the shared fixture', () => {
  expect(MANIFEST.types.length).toBeGreaterThan(0)
})
