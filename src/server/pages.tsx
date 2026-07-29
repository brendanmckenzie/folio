/**
 * The two HTML documents Folio serves itself: the editor, and a story's preview.
 *
 * The preview is not a route on the mounted app, and cannot be: it answers the
 * story's *own* public URL with `?_folio=preview` on it, anywhere in the host's
 * URL space. `handle()` recognises it, and hands anything that turns out not to
 * be a story straight back to the host (see index.tsx).
 */
import type { ReactElement } from 'react'
import { renderToReadableStream } from 'react-dom/server.edge'
import type { StoryMeta } from '../core/story'
import { FolioDoc, renderGlobalNode } from '../preview/Render'
import { Bootstrap, ReactRefreshPreamble, Shell } from './Document'
import type { FolioRuntime } from './runtime'
import type { FolioBindings } from './types'

/** The editor shell. The admin bundle takes over from `__FOLIO_ADMIN__`. */
export function adminPage(rt: FolioRuntime, story: StoryMeta): Promise<Response> {
  const { entries, stylesheets } = rt.page('admin')
  return html(
    <Shell
      title={`${story.title} · Folio`}
      stylesheets={stylesheets}
      head={
        <>
          {rt.dev ? <ReactRefreshPreamble /> : null}
          <Bootstrap global="__FOLIO_ADMIN__" value={{ storyId: story.id, apiBase: rt.base }} />
        </>
      }
    >
      <div id="folio-admin" />
    </Shell>,
    entries,
  )
}

/**
 * The story's live draft, rendered for the editor's iframe.
 *
 * Every configured global rides along too (`../../../docs/specs/content-model/
 * globals.md`), read-only in the sense that clicking one is the admin's cue to
 * offer "Edit header →" (checkpoint 3) rather than a signal handled here — the
 * marker that makes a block clickable at all (`edit`) is the same one any
 * block gets, so the delegated bridge in `preview/mount.tsx` needs no change
 * to reach them.
 *
 * `opts.as` names the one global that is instead *the* editable document on
 * screen: the page's own doc renders with no markers and nothing to hydrate
 * (decision 3's "one editable document at a time"), and the bootstrap points
 * the preview client at the global's own wrapper instead of `#folio-root`.
 *
 * `opts.bare` is for a singleton with no `previewPath` declared: there is no
 * host page to render at all, so no context globals are drawn around it and a
 * note says why.
 */
export async function previewPage(
  rt: FolioRuntime,
  bindings: FolioBindings,
  story: StoryMeta,
  opts?: { as?: string; bare?: boolean },
): Promise<Response> {
  const doc = await rt.draftFor(bindings, story)
  const resolution = await rt.resolve(bindings, doc, { draft: true })
  const { entries, stylesheets } = rt.page('preview')

  const editingName = opts?.as
  const editingDoc = editingName ? resolution.globals?.[editingName] : undefined
  const editing =
    editingName && editingDoc
      ? { global: editingName, mount: `[data-folio-global="${editingName}"]` }
      : undefined

  // Every configured global, in declared order, above the page itself: Folio's
  // own preview shell knows nothing of the host's real layout (checkpoint 2),
  // so this is a simplification, not a claim of visual fidelity — the host's
  // own render is what a live page actually looks like.
  const contextGlobals = opts?.bare
    ? null
    : rt.globals.map((name) => renderGlobalNode(rt.registry, resolution, name, { edit: true }))

  return html(
    <Shell
      title={`Preview · ${story.title}`}
      stylesheets={stylesheets}
      bodyClass="folio-editing"
      head={
        <>
          {rt.dev ? <ReactRefreshPreamble /> : null}
          {/* The resolution rides along with the document so the client can
              re-render per keystroke without going back to the network. */}
          <Bootstrap
            global="__FOLIO__"
            value={editing ? { doc: editingDoc, resolution, editing } : { doc, resolution }}
          />
        </>
      }
    >
      {contextGlobals}
      <div id="folio-root">
        <FolioDoc doc={doc} registry={rt.registry} edit={!editing} resolution={resolution} />
      </div>
      {opts?.bare ? (
        <p style={{ padding: '1em', font: '13px system-ui', color: '#666' }}>
          No host page is configured to preview “{story.title}” in context (no `previewPath` on its
          document type) — shown on its own.
        </p>
      ) : null}
    </Shell>,
    entries,
  )
}

async function html(node: ReactElement, bootstrapModules: string[]) {
  const stream = await renderToReadableStream(node, { bootstrapModules })
  return new Response(stream, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
