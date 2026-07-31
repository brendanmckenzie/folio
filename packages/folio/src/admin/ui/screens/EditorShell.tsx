import type { CSSProperties, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Blok, Doc } from '../../../core/doc'
import type { LocaleConfig, LocaleContext } from '../../../core/locales'
import type { Presence } from '../../../core/protocol'
import type { Resolution } from '../../../core/resolve'
import { type DocumentType, type SchemaIndex, singletonId } from '../../../core/schema'
import type { StoryMeta } from '../../../core/story'
import { formatWhen } from '../../History'
import type { Blocks } from '../../hooks/useBlocks'
import { canPublish, type Me, whyNot } from '../../me'
import { behindNotice } from '../../Migrations'
import type { StoryStore } from '../../store'
import { publishStatus } from '../../TopBar'
import { describeAgainstDraft } from '../../ViewingBar'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { EmptyState } from '../EmptyState'
import { Menu } from '../Menu'
import { BlockRail } from './BlockRail'
import { stateTone } from './content-rows'
import css from './EditorShell.module.css'
import {
  type AddTarget,
  clampInspector,
  DEFAULT_INSPECTOR,
  editorLayout,
  hasNestedBloks,
  isNarrowedViewport,
  MAX_INSPECTOR,
  MIN_INSPECTOR,
  type Viewport,
  VIEWPORT_NAMES,
  VIEWPORTS,
} from './editor-model'
import { useEditor } from './useEditor'

/**
 * What the inspector — port phase 7b — is handed.
 *
 * A render prop rather than a `ReactNode`, and that is the whole seam: the store,
 * the selection and the block mutations are created *inside* this component by
 * `useEditor`, so a node built by the caller could not reach any of them. This
 * hands over exactly the set `admin/Inspector.tsx` plus `FolioContextValue` need
 * between them, which is what makes 7b a port of that component rather than a
 * redesign of its inputs.
 *
 * The same shape is what `history` receives, because the history slide-over (7c)
 * needs a strict subset of it — `versions`, `store` and the document.
 */
export interface EditorSlot {
  store: StoryStore
  schema: SchemaIndex
  types: readonly DocumentType[]
  globals: readonly string[]
  apiBase: string
  /** The bare mount, for asset URLs and a global's preview page. */
  mount: string
  locales: LocaleConfig | undefined
  locale: string
  localeCtx: LocaleContext | undefined
  isSourceLocale: boolean
  setLocale: (code: string) => void
  resolution: Resolution
  translation: ReturnType<typeof useEditor>['translation']
  /** The blok to draw: out of the version being viewed, when one is on screen. */
  blok: Blok | null
  /** What is on screen — the version being viewed, or the live draft. */
  doc: Doc | null
  /** Viewing a past version, or a role that may not edit. */
  readOnly: boolean
  blocks: Blocks
  /** Per-story presence, off the document socket. The inspector's field rings read
   * `selection.field`; the history panel's `peerNames` reads `actor` → `name`. */
  peers: readonly Presence[]
  /** The whole store state, for the two things a pane may need that are not broken
   * out above: `connected` / `inflight` for a saving indicator, `focus` for which
   * field this client is in. */
  state: ReturnType<typeof useEditor>['state']
  story: StoryMeta
  /** The document has a URL of its own, so the root block's row also edits its
   * address (`PageAddress`). False for a record and for a global. */
  routed: boolean
  /** The selection is the document root, and it is editable. */
  isRootBlok: boolean
  /** A block inside a global was clicked while previewing something else. */
  globalHint: { name: string; label: string } | null
  onEditGlobal: (name: string) => void
  versions: ReturnType<typeof useEditor>['versions']
  /** The version list's paged trail. See `useEditor`'s own comment for why it is a
   * second name rather than a second read. */
  versionTrail: ReturnType<typeof useEditor>['versionTrail']
  onNotice: (message: string) => void
  /**
   * There is no stage: this document is a form, so the inspector *is* the screen
   * and is rendered centred at a readable measure rather than in a 340px column.
   * The fields do not change; their measure does, which a richtext field wants to
   * know about.
   */
  form: boolean

  /* ------------------------------------------------- port phase 7c's seams --- */

  /** Whether the history slide-over should be showing. `⌘H` is the shell's, not
   * this screen's, so it arrives as a prop and is passed straight through. */
  historyOpen: boolean
  onCloseHistory: () => void
  /**
   * The slot a block is being added to, or null. Set by `+ Add` in the rail and by
   * `⌘⇧A`; the picker reads it, and `onAddBlock` is what a pick calls — so the
   * picker never learns where in the slot the block lands.
   */
  adding: AddTarget | null
  onRequestAdd: (target: AddTarget) => void
  onCloseAdd: () => void
  onAddBlock: (type: string, preset?: string) => void
}

interface Props {
  /**
   * `StoryMeta`, not `StoryNode`: a record or a global is not in the tree and has
   * no children to speak of.
   */
  story: StoryMeta | undefined
  /**
   * The iframe src for the **source locale**, or undefined when this document has
   * no page to be seen in. Computed by the caller because two of the three cases
   * need something the editor does not hold: a page carries its own `previewUrl`
   * from the host's `route` function, a global borrows a host page's and appends
   * `&as=`, and a record has none at all. `editor-model.ts`'s `previewFrame` adds
   * the third fact, which is this screen's own — the locale being edited.
   */
  preview: string | undefined
  /**
   * The story row is not here yet.
   *
   * Includes the row's own fetch, not only the shell's boot: with `loading` false
   * and `story` undefined this screen says "no such document", so a caller that
   * passes only its boot flag makes that flash on every open.
   */
  loading: boolean
  apiBase: string
  /** The bare mount, for asset URLs and a global's preview page. */
  mount: string
  schema: SchemaIndex
  types: readonly DocumentType[]
  globals: readonly string[]
  locales?: LocaleConfig
  me: Me
  onNotice: (message: string) => void
  /** Opens another document — the "Edit ‹global› →" affordance, and nothing else
   * yet. Absent turns that offer off rather than making it fail. */
  onOpenDocument?: (id: string) => void
  /** The caller's story row is stale after a publish. See `EditorOptions`. */
  onStoryChanged?: () => void
  /** Collapsed by `⌘\` from the shell, so the state lives above this component. */
  railCollapsed: boolean
  onToggleRail: () => void
  inspectorCollapsed: boolean
  onToggleInspector: () => void
  /** Port phase 7b. Absent draws a placeholder rather than an empty column. */
  inspector?: (slot: EditorSlot) => ReactNode
  /**
   * Port phase 7c: the history slide-over, over the inspector, full height. It
   * mounts itself against `slot.historyOpen`, so this is called on every render
   * rather than conditionally — `HistoryPanel` returns null when closed.
   */
  history?: (slot: EditorSlot) => ReactNode
  /** `⌘H`, which belongs to the shell's shortcut map rather than to this screen. */
  historyOpen?: boolean
  onCloseHistory?: () => void
  /**
   * Port phase 7c: the block picker. Present, and the rail's `+ Add` opens it
   * instead of the grouped menu; absent, the menu stays and the rail is complete
   * without it.
   */
  picker?: (slot: EditorSlot) => ReactNode
}

/**
 * The editor: rail, stage, inspector.
 *
 * `docs/ui-architecture.md` calls the surface this replaces the thing it serves
 * worst — a top bar, then `280px | preview | 300px`, with the 280px holding seven
 * tabs that mixed document concerns with site concerns and two of which could not
 * be clicked. Four things changed and every one of them is structural:
 *
 * 1. **The rail holds the block tree and nothing else.** Seven tabs become zero.
 *    History is a slide-over, and redirects, the content model and access are
 *    screens that landed in port phase 5.
 * 2. **The preview is edge to edge** — no card, no shadow, no radius, one
 *    hairline. It keeps the amber frame while a past version is on screen, which
 *    is the one time a coloured frame has something true to say.
 * 3. **A record has no preview**, so it is a single centred form at a readable
 *    measure with the rail out of the way (`editorLayout`).
 * 4. **`⌘\` and `⌘.`** collapse the rail and the inspector; both collapsed is the
 *    page alone, edge to edge.
 *
 * What did *not* change is everything underneath: the sync engine, presence, undo,
 * the preview bridge, versions, publish and the migration banner are the hooks
 * they always were, composed by `useEditor`. This file is the view.
 */
export function EditorShell(props: Props) {
  // The guard is out here so the hooks are not: `useEditor` opens a socket and a
  // store for a specific story, and running it for an id that resolves to nothing
  // would connect to a Durable Object that should not be woken. Splitting the
  // component is the standard shape for that and it is why `EditorBody` exists.
  if (props.loading) {
    return (
      <div className={css.booting} aria-hidden="true">
        <div className={css.bootRail} />
        <div className={css.bootStage} />
        <div className={css.bootInspector} />
      </div>
    )
  }
  if (!props.story) {
    return (
      <div className={css.missing}>
        <EmptyState
          title="No such document"
          body="It may have been deleted, or the id in this URL was never one."
        />
      </div>
    )
  }
  return <EditorBody {...props} story={props.story} />
}

/** Which confirmation is open, or null. Three of them, and none is "open" as a
 * bare boolean: a dialog that outlives the reason it was opened for is the bug
 * `Editor.tsx` guarded against by storing the story it was confirming *for*. */
type Confirm = 'publish' | 'unpublish' | 'discard'

function EditorBody({ story, ...props }: Props & { story: StoryMeta }) {
  const [viewport, setViewport] = useState<Viewport>('Desktop')
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  /**
   * Which slot the picker is open for. Held here rather than in the rail because
   * `⌘⇧A` can open it too and the rail may be collapsed at the time — the same
   * reason `railCollapsed` lives above this component.
   */
  const [adding, setAdding] = useState<AddTarget | null>(null)

  /**
   * A block was picked in the preview. There are no tabs to bring forward any
   * more, so the only thing left for this to mean is "reveal the rail if it is
   * hidden" — which is worth doing, because a click in the page is how most
   * selections happen and the tree is where you then see where you are.
   */
  const onPick = useCallback(() => {
    if (props.railCollapsed) props.onToggleRail()
  }, [props.railCollapsed, props.onToggleRail])

  const editor = useEditor({
    storyId: story.id,
    story,
    apiBase: props.apiBase,
    base: props.mount,
    schema: props.schema,
    types: props.types,
    globals: props.globals,
    locales: props.locales,
    me: props.me,
    preview: props.preview,
    notify: props.onNotice,
    ...(props.onStoryChanged ? { onStoryChanged: props.onStoryChanged } : {}),
    historyOpen: props.historyOpen ?? false,
    onPick,
  })

  const routed = story.path !== null
  const layout = editorLayout({
    routed,
    preview: editor.src,
    nested: hasNestedBloks(editor.shownDoc),
    railCollapsed: props.railCollapsed,
    inspectorCollapsed: props.inspectorCollapsed,
  })

  const width = useInspectorWidth()
  const viewing = editor.versions.viewing
  const live = editor.versions.source.mode === 'live'
  const mayPublish = canPublish(props.me)
  const status = publishStatus(
    editor.state.connected,
    editor.state.inflight,
    editor.published.version !== null,
    story.state === 'live',
    editor.published.delta,
  )
  const banner = behindNotice(editor.migrations.status)

  /**
   * Publish, warning first when a locale is incomplete. A complete page — and
   * every page on a single-locale site — publishes on one click, exactly as
   * before: a confirmation that always appears is a confirmation nobody reads.
   */
  const requestPublish = () => {
    if (editor.gaps.length > 0) setConfirm('publish')
    else void editor.publish.publish()
  }

  const slot: EditorSlot = {
    store: editor.store,
    schema: props.schema,
    types: props.types,
    globals: props.globals,
    apiBase: props.apiBase,
    mount: props.mount,
    locales: props.locales,
    locale: editor.locale,
    localeCtx: editor.localeCtx,
    isSourceLocale: editor.isSourceLocale,
    setLocale: editor.setLocale,
    resolution: editor.resolution,
    translation: editor.translation,
    blok: editor.selected,
    doc: editor.shownDoc,
    readOnly: editor.readOnly,
    blocks: editor.blocks,
    peers: editor.state.peers,
    state: editor.state,
    story,
    routed,
    isRootBlok: Boolean(
      !editor.readOnly && editor.liveDoc && editor.state.selection === editor.liveDoc.root,
    ),
    globalHint: editor.globalHint
      ? {
          name: editor.globalHint,
          label:
            props.types.find((type) => type.name === editor.globalHint)?.label ?? editor.globalHint,
        }
      : null,
    onEditGlobal: (name) => props.onOpenDocument?.(singletonId(name)),
    versions: editor.versions,
    versionTrail: editor.versionTrail,
    onNotice: props.onNotice,
    form: layout.form,
    historyOpen: props.historyOpen ?? false,
    onCloseHistory: () => props.onCloseHistory?.(),
    adding,
    onRequestAdd: setAdding,
    onCloseAdd: () => setAdding(null),
    onAddBlock: (type, preset) => {
      if (!adding) return
      editor.blocks.add(adding.parent, adding.slot, type, adding.index, preset)
      // Closed by the pick rather than by the picker, so a picker that forgets to
      // close cannot leave a dialog over a block it has already inserted.
      setAdding(null)
    },
  }

  const inspectorNode = props.inspector ? (
    props.inspector(slot)
  ) : (
    <div className={css.pending}>
      <EmptyState
        title="Fields land with port phase 7b"
        body="The store, the selection and the block mutations are already here — this column is the seam they are handed through."
      />
    </div>
  )

  return (
    <div className={css.editor} style={{ '--inspector-w': `${width.value}px` } as CSSProperties}>
      {layout.rail ? (
        <BlockRail
          doc={editor.shownDoc}
          schema={props.schema}
          localeCtx={editor.localeCtx}
          selection={editor.state.selection}
          peers={editor.state.peers}
          readOnly={editor.readOnly}
          onSelect={(uid) => editor.store.select(uid)}
          onAdd={editor.blocks.add}
          onMove={(move) => editor.blocks.move(move.uid, move.parent, move.slot, move.index)}
          onDuplicate={editor.blocks.duplicate}
          onCopy={(uid) => void editor.blocks.copy(uid)}
          onNotice={props.onNotice}
          {...(props.picker ? { onRequestAdd: setAdding } : {})}
          onCollapse={props.onToggleRail}
        />
      ) : null}

      <div className={css.main}>
        <div className={css.bar}>
          {props.railCollapsed ? (
            <Button
              size="sm"
              variant="subtle"
              onClick={props.onToggleRail}
              title="Show the rail (⌘\)"
            >
              »
            </Button>
          ) : null}

          <span className={css.path} title={routed ? (story.url ?? story.path ?? '') : story.type}>
            {routed ? (story.path === '' ? '/' : `/${story.path}`) : story.title || story.type}
          </span>
          <Badge tone={stateTone(story.state)}>{story.state}</Badge>

          {/* The one place the socket's state is visible, and it is a sentence
              rather than a dot: "Connecting…", "Saving…", "Up to date", "3
              unpublished changes" — and the last of those is the door into the
              comparison view, which is the only way in without 7c's slide-over. */}
          {status.clickable && editor.published.version ? (
            <button
              type="button"
              className={css.status}
              onClick={() => {
                if (editor.published.version) void editor.versions.view(editor.published.version)
              }}
            >
              {status.label}
            </button>
          ) : (
            <span className={css.statusFlat}>{status.label}</span>
          )}

          <span className={css.spacer} />

          {/* Only where there is more than one language to switch between: a
              switcher offering one option is furniture. */}
          {props.locales && props.locales.available.length > 1 ? (
            <select
              className={css.locale}
              aria-label="Editing language"
              value={editor.locale}
              onChange={(e) => editor.setLocale(e.target.value)}
            >
              {props.locales.available.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                  {props.locales && l.code === props.locales.default ? ' (source)' : ''}
                </option>
              ))}
            </select>
          ) : null}

          {/* No viewport switcher for a document with no page of its own: it
              would be three controls that cannot do anything. */}
          {layout.form ? null : (
            <fieldset className={css.viewports}>
              <legend className={css.srOnly}>Preview width</legend>
              {VIEWPORT_NAMES.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`${css.segment} ${viewport === name ? css.segmentOn : ''}`}
                  aria-pressed={viewport === name}
                  onClick={() => setViewport(name)}
                >
                  {name}
                </button>
              ))}
            </fieldset>
          )}

          <Button
            size="sm"
            variant="subtle"
            disabled={!editor.state.canUndo}
            reason="Nothing to undo"
            title="Undo (⌘Z)"
            onClick={() => editor.store.undo()}
          >
            Undo
          </Button>
          <Button
            size="sm"
            variant="subtle"
            disabled={!editor.state.canRedo}
            reason="Nothing to redo"
            title="Redo (⇧⌘Z)"
            onClick={() => editor.store.redo()}
          >
            Redo
          </Button>

          {story.url && !layout.form ? (
            <a className={css.live} href={story.url} target="_blank" rel="noreferrer">
              View live
            </a>
          ) : null}

          {/* Publish has no chord, deliberately (`design-system.md`, Resolved 3):
              it is reachable by click and from ⌘K, neither of which can be hit by
              muscle memory. */}
          <Button
            size="sm"
            variant="primary"
            disabled={
              editor.publish.publishing ||
              !editor.liveDoc ||
              !live ||
              status.nothingToPublish ||
              !mayPublish
            }
            reason={
              whyNot(props.me, 'publish') ??
              (!live
                ? 'Close the version preview first'
                : status.nothingToPublish
                  ? 'No changes to publish'
                  : 'Publishing…')
            }
            onClick={requestPublish}
          >
            {editor.publish.publishing ? 'Publishing…' : 'Publish'}
          </Button>
          <Menu
            align="end"
            label="More publishing actions"
            trigger="▾"
            items={[
              {
                id: 'unpublish',
                label: 'Unpublish…',
                danger: true,
                disabled: !(story.state === 'live' && live && mayPublish),
                reason: whyNot(props.me, 'publish') ?? 'Only a live page can be unpublished',
                run: () => setConfirm('unpublish'),
              },
            ]}
          />

          {props.inspectorCollapsed && !layout.form ? (
            <Button
              size="sm"
              variant="subtle"
              onClick={props.onToggleInspector}
              title="Show the inspector (⌘.)"
            >
              «
            </Button>
          ) : null}
        </div>

        {/* A banner, never a lock: refusing to serve the editor until somebody
            runs a migration would turn a schema drift into an outage, and an
            empty field that is explained is a different experience from an empty
            field that is mysterious. In flow, never an overlay — an explanation
            an editor reads once and carries on past is not an alert. */}
        {banner ? (
          <p className={css.banner} role="status">
            {banner}
          </p>
        ) : null}

        {viewing ? (
          <div className={css.viewbar} role="status">
            <span className={css.viewdot} />
            <span className={css.viewtext}>
              Viewing{' '}
              <strong>
                {viewing.version.label ||
                  (viewing.version.kind === 'publish' ? 'a published version' : 'a checkpoint')}
              </strong>{' '}
              from {formatWhen(viewing.version.createdAt)} ·{' '}
              {describeAgainstDraft(editor.versions.delta)}
            </span>
            <Button size="sm" variant="subtle" onClick={editor.versions.exit}>
              Close
            </Button>
            {editor.published.version?.id === viewing.version.id ? (
              <Button
                size="sm"
                variant="danger"
                disabled={editor.versions.busy || editor.versions.delta?.total === 0}
                reason="This version is identical to the draft"
                onClick={() => setConfirm('discard')}
              >
                Discard changes
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={editor.versions.busy || editor.versions.delta?.total === 0}
                reason="This version is identical to the draft"
                onClick={() => void editor.versions.restore(viewing.version, viewing.doc)}
              >
                Restore this version
              </Button>
            )}
          </div>
        ) : null}

        {layout.form ? (
          // No stage at all, and not a stage apologising for having nothing in it:
          // a record's fields *are* the screen, at a measure prose can be read at.
          <div className={css.form}>
            <div className={css.formInner}>{inspectorNode}</div>
          </div>
        ) : (
          <div
            className={css.stage}
            data-narrow={isNarrowedViewport(viewport) ? '' : undefined}
            data-viewing={viewing ? '' : undefined}
          >
            {editor.src ? (
              <div className={css.frameWrap} style={{ width: VIEWPORTS[viewport] }}>
                <iframe
                  // Keyed on the story *and* the locale: switching language is a
                  // reload, because the host's own chrome and `<html lang>` change
                  // and no postMessage reaches those.
                  key={`${story.id}:${editor.locale}`}
                  ref={editor.frame}
                  className={css.frame}
                  title={`Preview of ${story.title || story.id}`}
                  src={editor.src}
                />
              </div>
            ) : (
              <div className={css.blank}>
                <EmptyState
                  title="No page to preview yet"
                  body={`This ${labelOf(props.types, story.type)} is routed, but the host's own route function returned no URL for ${story.path === '' ? '/' : `/${story.path}`}.`}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {layout.form || !layout.inspector ? null : (
        <>
          <InspectorGrip width={width} />
          <aside className={css.inspector} aria-label="Inspector">
            <div className={css.inspectorHead}>
              <span className={css.inspectorTitle}>
                {editor.selected
                  ? (props.schema[editor.selected.type]?.label ?? 'Block')
                  : 'Fields'}
              </span>
              <Button
                size="sm"
                variant="subtle"
                onClick={props.onToggleInspector}
                title="Hide the inspector (⌘.)"
              >
                »
              </Button>
            </div>
            <div className={css.inspectorBody}>{inspectorNode}</div>
          </aside>
        </>
      )}

      {props.history?.(slot)}
      {props.picker?.(slot)}

      {confirm === 'publish' ? (
        <Dialog
          title="Publish with an incomplete translation?"
          description="Publishing sends every locale, including the ones with gaps."
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button size="sm" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={editor.publish.publishing}
                reason="Publishing…"
                onClick={() => {
                  void editor.publish.publish().then(() => setConfirm(null))
                }}
              >
                Publish anyway
              </Button>
            </>
          }
        >
          <ul className={css.gaps}>
            {editor.gaps.map((gap) => (
              <li key={gap.locale}>
                <strong>{localeLabel(props.locales, gap.locale)}</strong> — {gap.missing.length}{' '}
                {gap.missing.length === 1 ? 'field' : 'fields'} untranslated
              </li>
            ))}
          </ul>
        </Dialog>
      ) : null}

      {confirm === 'unpublish' ? (
        <Dialog
          title={`Unpublish ${story.title || 'this page'}?`}
          description="The page stops being served. The draft is kept, and publishing again brings it back."
          danger
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button size="sm" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={editor.publish.unpublishing}
                reason="Unpublishing…"
                onClick={() => {
                  void editor.publish.unpublish().then(() => setConfirm(null))
                }}
              >
                Unpublish
              </Button>
            </>
          }
        />
      ) : null}

      {confirm === 'discard' && viewing ? (
        <Dialog
          title="Discard the unpublished changes?"
          description={`${describeAgainstDraft(editor.versions.delta)} — all of it goes back to what is published.`}
          danger
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button size="sm" onClick={() => setConfirm(null)}>
                Keep editing
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={editor.versions.busy}
                reason="Discarding…"
                onClick={() => {
                  void editor.versions
                    .restore(viewing.version, viewing.doc)
                    .then(() => setConfirm(null))
                }}
              >
                Discard
              </Button>
            </>
          }
        >
          {/* Not destructive in the sense a delete is, and saying so is the
              honest reassurance: a restore is a transaction like any other. */}
          <p className={css.note}>
            This lands as one edit, so <kbd>⌘Z</kbd> undoes it.
          </p>
        </Dialog>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ resize --- */

interface InspectorWidth {
  value: number
  set: (next: number) => void
  reset: () => void
  begin: () => void
}

/**
 * The inspector's width, dragged or typed.
 *
 * The listeners are on the window rather than on the grip, and that is the part
 * worth stating: the iframe swallows every pointer event the moment the cursor
 * crosses into it, which during a leftward drag is immediately. `user-select` and
 * `pointer-events` are suppressed on the body for the duration for the same
 * reason.
 */
function useInspectorWidth(): InspectorWidth {
  const [value, setValue] = useState(DEFAULT_INSPECTOR)
  const dragging = useRef(false)

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return
      // Measured from the right edge, because that is the edge the inspector is
      // pinned to: anything else drifts as the window resizes mid-drag.
      setValue(clampInspector(window.innerWidth - e.clientX))
    }
    const stop = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [])

  return {
    value,
    set: (next) => setValue(clampInspector(next)),
    reset: () => setValue(DEFAULT_INSPECTOR),
    begin: () => {
      dragging.current = true
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
  }
}

function InspectorGrip({ width }: { width: InspectorWidth }) {
  return (
    // A real separator with a role and a keyboard: the old editor's fixed 300px
    // column had no resize at all, and adding one as a bare `<div onMouseDown>`
    // would be the same a11y hole its tree rows were.
    //
    // The suppression has to sit here, before the element, rather than beside the
    // `role` it is about — a `//` comment inside a JSX attribute list does not
    // attach to the element's own diagnostic.
    //
    // biome-ignore lint/a11y/useSemanticElements: <hr> is the semantic separator and cannot be this one — a focusable grip carrying aria-valuenow is a widget, not a rule
    <div
      className={css.grip}
      role="separator"
      aria-label="Resize inspector"
      aria-orientation="vertical"
      aria-valuenow={width.value}
      aria-valuemin={MIN_INSPECTOR}
      aria-valuemax={MAX_INSPECTOR}
      tabIndex={0}
      onPointerDown={width.begin}
      onKeyDown={(e) => {
        // ← widens, because the inspector is on the right: the arrow points the
        // way the edge moves, not the way the value goes.
        const step = e.shiftKey ? 40 : 8
        if (e.key === 'ArrowLeft') width.set(width.value + step)
        else if (e.key === 'ArrowRight') width.set(width.value - step)
        else if (e.key === 'Home') width.reset()
        else return
        e.preventDefault()
      }}
      onDoubleClick={width.reset}
    />
  )
}

/* ------------------------------------------------------------------ labels --- */

/** A type's label, falling back to its name — which is what an orphaned document
 * of a type nobody declares any more has. */
function labelOf(types: readonly DocumentType[], name: string): string {
  return types.find((type) => type.name === name)?.label.toLowerCase() ?? name
}

/** A locale's declared label, falling back to its code. */
function localeLabel(locales: LocaleConfig | undefined, code: string): string {
  return locales?.available.find((l) => l.code === code)?.label ?? code
}
