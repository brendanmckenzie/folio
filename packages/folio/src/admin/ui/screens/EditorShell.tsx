import type { CSSProperties } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StoryMeta } from '../../../core/story'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { stateTone } from './content-rows'
import css from './EditorShell.module.css'

interface Props {
  /** `StoryMeta`, not `StoryNode`: a record or a global is not in the tree and has
   * no children to speak of. */
  story: StoryMeta | undefined
  /**
   * The iframe src, or undefined when this document has no page to be seen in.
   * Computed by the caller because the three cases are three different sources: a
   * page carries its own `previewUrl` from the host's `route` function, a global
   * borrows a host page's and appends `&as=`, and a record has none at all.
   */
  preview: string | undefined
  loading: boolean
  /** Collapsed by ⌘\ from the shell, so the state lives above this component. */
  railCollapsed: boolean
  onToggleRail: () => void
  inspectorCollapsed: boolean
  onToggleInspector: () => void
}

/** The inspector's width, in px. 340 up from today's fixed 300 — the design's
 * number, and the resize below is what makes it a starting point rather than a
 * new fixed value. */
const DEFAULT_INSPECTOR = 340
const MIN_INSPECTOR = 260
const MAX_INSPECTOR = 640

/**
 * The editor's **shell**: rail, edge-to-edge preview, resizable inspector, and
 * the two collapses. Not the editor — the block tree, the fields, the sync store
 * and history are phase 7 of the port plan, and every one of them needs the
 * document out of its Durable Object rather than the story row this has.
 *
 * What it is for is the geometry, which is the part `docs/ui-architecture.md`
 * asserts and cannot prove: that a hairline-only preview at `100dvh - 40px` reads
 * as the hero, that 340px is enough for an inspector, and that `⌘\` plus `⌘.`
 * getting you to the page alone is worth two shortcuts. Those are judgements a
 * browser has to settle.
 *
 * The iframe is real. `StoryMeta.previewUrl` is computed by the host's own `route`
 * function server-side (`hooks/useSpace.ts` explains why it has to be), so the
 * preview here is the same URL the current editor loads — no bridge, no
 * postMessage, no keystroke sync, which is exactly the seam phase 7 adds back.
 */
export function EditorShell({
  story,
  preview,
  loading,
  railCollapsed,
  onToggleRail,
  inspectorCollapsed,
  onToggleInspector,
}: Props) {
  const [width, setWidth] = useState(DEFAULT_INSPECTOR)
  const dragging = useRef(false)

  const onDrag = useCallback((e: PointerEvent) => {
    if (!dragging.current) return
    // Measured from the right edge, because that is the edge the inspector is
    // pinned to: anything else drifts as the window resizes mid-drag.
    const next = window.innerWidth - e.clientX
    setWidth(Math.min(MAX_INSPECTOR, Math.max(MIN_INSPECTOR, next)))
  }, [])

  useEffect(() => {
    const stop = () => {
      dragging.current = false
      document.body.style.removeProperty('cursor')
      // While dragging, the iframe would otherwise swallow every pointer event
      // the moment the cursor crossed into it — which is most of the drag.
      document.body.style.removeProperty('user-select')
    }
    window.addEventListener('pointermove', onDrag)
    window.addEventListener('pointerup', stop)
    return () => {
      window.removeEventListener('pointermove', onDrag)
      window.removeEventListener('pointerup', stop)
    }
  }, [onDrag])

  if (loading) return <div className={css.loading}>Loading…</div>
  if (!story) {
    return (
      <div className={css.missing}>
        <EmptyState
          title="No such document"
          body="It may have been deleted, or the id in this URL was never one."
        />
      </div>
    )
  }

  const routed = story.path !== null

  return (
    <div
      className={css.editor}
      style={{ '--inspector-w': `${inspectorCollapsed ? 0 : width}px` } as CSSProperties}
    >
      {railCollapsed ? null : (
        <aside className={css.rail} aria-label="Blocks">
          <div className={css.railHead}>
            <span className={css.railTitle}>Blocks</span>
            <Button size="sm" variant="subtle" onClick={onToggleRail} title="Collapse rail (⌘\)">
              «
            </Button>
          </div>
          {/*
            The rail holds the block tree and nothing else — seven tabs become
            zero (decision 4). The tree itself needs the live document, so this
            says what will be here rather than faking a plausible list: a mock
            block tree would be the one thing in this prototype that could be
            mistaken for working software.
          */}
          <p className={css.placeholder}>
            The block tree lands with the editor port, which is where the sync store, presence and
            the <code>⌘⇧A</code> picker arrive together.
          </p>
        </aside>
      )}

      <div className={css.stage}>
        <div className={css.stageBar}>
          {railCollapsed ? (
            <Button size="sm" variant="subtle" onClick={onToggleRail} title="Expand rail (⌘\)">
              »
            </Button>
          ) : null}
          <span className={css.path}>
            {routed ? (story.path === '' ? '/' : story.path) : story.type}
          </span>
          <Badge tone={stateTone(story.state)}>{story.state}</Badge>
          <span className={css.spacer} />
          {inspectorCollapsed ? (
            <Button
              size="sm"
              variant="subtle"
              onClick={onToggleInspector}
              title="Expand inspector (⌘.)"
            >
              «
            </Button>
          ) : null}
        </div>

        {/*
          Edge to edge: no card, no shadow, no radius, one hairline. The whole
          point of the redesign's stage, and the thing a screenshot judges rather
          than a spec.
        */}
        {preview ? (
          <iframe className={css.frame} title={`Preview of ${story.title}`} src={preview} />
        ) : (
          <div className={css.noPreview}>
            <EmptyState
              title="No preview for this document"
              body={
                routed
                  ? 'This page has no URL yet.'
                  : `A ${story.type} is not routed and is not a global, so there is no page to render it in. Records edit as a centred form — the other half of this screen, and it arrives with the port.`
              }
            />
          </div>
        )}
      </div>

      {inspectorCollapsed ? null : (
        <>
          {/*
            A real separator with a role and a keyboard: the current editor's
            fixed 300px column has no resize at all, and adding one as a bare
            `<div onMouseDown>` would be the same a11y hole the tree rows are.
          */}
          <div
            className={css.grip}
            role="separator"
            aria-label="Resize inspector"
            aria-orientation="vertical"
            aria-valuenow={width}
            aria-valuemin={MIN_INSPECTOR}
            aria-valuemax={MAX_INSPECTOR}
            tabIndex={0}
            onPointerDown={() => {
              dragging.current = true
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
            }}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 40 : 8
              if (e.key === 'ArrowLeft') setWidth((w) => Math.min(MAX_INSPECTOR, w + step))
              else if (e.key === 'ArrowRight') setWidth((w) => Math.max(MIN_INSPECTOR, w - step))
              else return
              e.preventDefault()
            }}
            onDoubleClick={() => setWidth(DEFAULT_INSPECTOR)}
          />
          <aside className={css.inspector} aria-label="Inspector">
            <div className={css.railHead}>
              <span className={css.railTitle}>{story.title || 'Untitled'}</span>
              <Button
                size="sm"
                variant="subtle"
                onClick={onToggleInspector}
                title="Collapse inspector (⌘.)"
              >
                »
              </Button>
            </div>
            <p className={css.placeholder}>
              Fields land with the editor port. What this column is proving now is its width:{' '}
              {width}px, drag the grip or use ← → on it, double-click to return to{' '}
              {DEFAULT_INSPECTOR}.
            </p>
            <dl className={css.facts}>
              <dt>Type</dt>
              <dd>{story.type}</dd>
              <dt>Slug</dt>
              <dd>{story.slug === '' ? '(root)' : story.slug}</dd>
              <dt>Id</dt>
              <dd className={css.mono}>{story.id}</dd>
            </dl>
          </aside>
        </>
      )}
    </div>
  )
}
