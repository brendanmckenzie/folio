/**
 * The thirteen components under `ui/screens/` that **no route reaches**: the
 * dialogs, the two pickers and the shortcut sheet, each opened by an interaction
 * rather than by a URL.
 *
 * `screens.test.tsx` mounts the shell at nineteen URLs, which covers eighteen of
 * the thirty-three files there, and `ui-scope-render.test.tsx` covers two more
 * through their portals. Without this file the answer to "every screen renders"
 * would be twenty of thirty-three, with the missing thirteen being exactly the
 * surfaces that appear at the moment somebody is about to destroy something.
 *
 * Mounted directly rather than driven to through a click, deliberately. Whether
 * the Delete button opens `DeleteDialog` is the screen's behaviour and belongs
 * with the screen's model tests; what is asserted here is that the dialog itself
 * assembles. Driving the interaction would make thirteen tests depend on
 * thirteen unrelated click paths, and a change to any one of them would fail this
 * file for a reason that has nothing to do with rendering.
 *
 * Every one is given the smallest props that render it, typed against the real row
 * interfaces rather than `as never` — and that immediately earned itself:
 * `AssetDetail` renders `row.tags.length`, which is on `assets-model`'s `AssetRow`
 * and not on the server's, so a fixture typed against the narrower one compiled
 * and then threw at mount. A dialog reading a field the fixture omits is the
 * finding this file exists to produce, and it produced one about itself first.
 */
import { render } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
// `assets-model`'s row, not `server/assets`' — it extends the server type with the
// `tags` array `withTags` attaches to every read, and `AssetDetail` renders
// `row.tags.length` directly. Typing the fixture against the narrower server row
// compiled and then failed at mount, which is the fixture bug this file is meant
// to surface early rather than the admin's.
import type { AssetRow } from '../../../../src/admin/ui/screens/assets-model'
import type { DocumentType, SchemaIndex } from '../../../../src/core/schema'
import { indexManifest } from '../../../../src/core/schema'
import type { DocumentRow } from '../../../../src/admin/ui/screens/documents-model'
import { AccessInviteDialog } from '../../../../src/admin/ui/screens/AccessInviteDialog'
import { AccessTokenDialog } from '../../../../src/admin/ui/screens/AccessTokenDialog'
import { AccountPasskeyDialog } from '../../../../src/admin/ui/screens/AccountPasskeyDialog'
import { AssetDeleteDialog } from '../../../../src/admin/ui/screens/AssetDeleteDialog'
import { AssetDetail } from '../../../../src/admin/ui/screens/AssetDetail'
import { AssetPicker } from '../../../../src/admin/ui/screens/AssetPicker'
import { BlockPicker } from '../../../../src/admin/ui/screens/BlockPicker'
import { ConfirmBulkDialog } from '../../../../src/admin/ui/screens/ConfirmBulkDialog'
import { CreateDialog } from '../../../../src/admin/ui/screens/CreateDialog'
import { DeleteDialog } from '../../../../src/admin/ui/screens/DeleteDialog'
import { FormDeleteDialog } from '../../../../src/admin/ui/screens/FormDeleteDialog'
import { Keys } from '../../../../src/admin/ui/screens/Keys'
import { MoveDialog } from '../../../../src/admin/ui/screens/MoveDialog'
import { API, MANIFEST, MOUNT, stubFetch } from './fixture'

const SCHEMA: SchemaIndex = indexManifest(MANIFEST)
const PAGE_TYPE = MANIFEST.types[0] as DocumentType

const ASSET: AssetRow = {
  id: 'ast_one',
  key: 'assets/one.jpg',
  filename: 'one.jpg',
  contentType: 'image/jpeg',
  size: 1024,
  width: 800,
  height: 600,
  alt: 'One',
  createdAt: 1,
  folderId: null,
  description: 'A photograph',
  altAuto: '',
  descriptionAuto: '',
  describedAt: null,
  describeError: null,
  tags: [],
}

/** A real `StoryMeta` plus `indexed`, with no cast: every field is declared. */
const DOCUMENT: DocumentRow = {
  id: 'sty_person',
  type: 'person',
  parentId: null,
  slug: 'ada',
  path: 'people/ada',
  ord: 'a0',
  title: 'Ada',
  publishedAt: null,
  unpublishedAt: null,
  updatedAt: 1,
  draftSyncId: 1,
  draftUpdatedAt: 1,
  publishedSyncId: 0,
  state: 'draft',
  hasUnpublishedChanges: false,
  indexed: {},
}

const noop = () => {}
const asyncNoop = async () => {}

/**
 * Each entry builds the element as its opener does. A **factory** rather than the
 * element itself: `render` is called once per test, so a held element would be
 * shared across the retry of a failing one — and JSX sitting in an array reads to
 * `useJsxKeyInIterable` as a list needing keys, which these are not. Named so a
 * failure says which surface rather than which index.
 */
const SURFACES: [name: string, mount: () => React.ReactElement][] = [
  ['AccessInviteDialog', () => <AccessInviteDialog onClose={noop} onInvite={asyncNoop} />],
  ['AccessTokenDialog', () => <AccessTokenDialog onClose={noop} onMint={asyncNoop} />],
  [
    'AccountPasskeyDialog',
    () => <AccountPasskeyDialog apiBase={API} onClose={noop} onEnrolled={noop} />,
  ],
  [
    'AssetDeleteDialog',
    () => (
      <AssetDeleteDialog apiBase={API} mount={MOUNT} row={ASSET} onClose={noop} onConfirm={noop} />
    ),
  ],
  [
    'AssetDetail',
    () => (
      <AssetDetail
        apiBase={API}
        mount={MOUNT}
        row={ASSET}
        onClose={noop}
        onDelete={noop}
        onChanged={noop}
        onNotice={noop}
      />
    ),
  ],
  ['AssetPicker', () => <AssetPicker apiBase={API} mount={MOUNT} onPick={noop} onClose={noop} />],
  [
    'BlockPicker',
    () => (
      <BlockPicker
        schema={SCHEMA}
        parentType="pageRoot"
        slot="main"
        filled={0}
        onClose={noop}
        onPick={noop}
      />
    ),
  ],
  [
    'ConfirmBulkDialog',
    () => (
      <ConfirmBulkDialog
        confirmation={{ title: 'Delete 2 pages?', body: 'This cannot be undone.', danger: true }}
        confirmLabel="Delete"
        onClose={noop}
        onConfirm={noop}
      />
    ),
  ],
  [
    'CreateDialog',
    () => (
      <CreateDialog
        type={PAGE_TYPE}
        schema={SCHEMA}
        pending={false}
        onClose={noop}
        onCreate={noop}
      />
    ),
  ],
  [
    'DeleteDialog',
    () => <DeleteDialog apiBase={API} row={DOCUMENT} onClose={noop} onConfirm={noop} />,
  ],
  [
    'FormDeleteDialog',
    () => (
      <FormDeleteDialog
        apiBase={API}
        id="frm_one"
        label="Contact"
        onClose={noop}
        onConfirm={noop}
      />
    ),
  ],
  ['Keys', () => <Keys onClose={noop} />],
  ['MoveDialog', () => <MoveDialog apiBase={API} count={2} onClose={noop} onConfirm={noop} />],
]

describe('every interaction-only surface mounts', () => {
  for (const [name, build] of SURFACES) {
    it(name, async () => {
      stubFetch()
      const { baseElement } = render(build())
      // Several of these fetch a usage count on mount — a delete dialog's whole
      // job is to say what a delete would destroy — so the flush is not optional
      // decoration: an unsettled fetch becomes an unhandled rejection after the
      // test, which `setup.ts` fails on and would attribute to the next test.
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve()
        })
      }
      expect(baseElement.textContent?.length ?? 0).toBeGreaterThan(0)
    })
  }
})

/**
 * The accounting, and the reason it is a test rather than a line in a commit
 * message: "every screen renders" is only true until somebody adds a screen.
 *
 * Every `.tsx` directly under `ui/screens/` is in exactly one of three sets — the
 * eighteen the route sweep reaches, the two the portal test reaches, and the
 * thirteen above — so a thirty-fourth file fails here until it is classified.
 * `fields/` is deliberately excluded: those render inside `Inspector`, which the
 * `edit` routes mount, and they have no props of their own to give.
 */
describe('the thirty-three screens are all accounted for', () => {
  /** Reached by `screens.test.tsx`'s nineteen URLs, directly or nested. */
  const BY_ROUTE = [
    'Access',
    'Account',
    'AssetBrowser',
    'Assets',
    'BlockRail',
    'Content',
    'Documents',
    'EditorShell',
    'FormBuilder',
    'Forms',
    'Home',
    'Inspector',
    'Model',
    'Redirects',
    'Responses',
    'Schedules',
    'Settings',
    'Stub',
  ]

  /** Reached by `ui-scope-render.test.tsx`, which mounts them for their portals. */
  const BY_PORTAL = ['FocusMode', 'HistoryPanel']

  it('is the whole directory, with nothing unclassified', async () => {
    const { readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const files = readdirSync(join(import.meta.dirname, '../../../../src/admin/ui/screens'), {
      withFileTypes: true,
    })
      .filter((e) => e.isFile() && e.name.endsWith('.tsx'))
      .map((e) => e.name.replace('.tsx', ''))
      .sort()

    const covered = [...BY_ROUTE, ...BY_PORTAL, ...SURFACES.map(([name]) => name)].sort()

    expect(files.length).toBe(33)
    expect(covered).toEqual(files)
  })
})
