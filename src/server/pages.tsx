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
import { FolioDoc } from '../preview/Render'
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

/** The story's live draft, rendered for the editor's iframe. */
export async function previewPage(
  rt: FolioRuntime,
  bindings: FolioBindings,
  story: StoryMeta,
): Promise<Response> {
  const doc = await rt.draftFor(bindings, story)
  const resolution = await rt.resolve(bindings, doc, { draft: true })
  const { entries, stylesheets } = rt.page('preview')

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
          <Bootstrap global="__FOLIO__" value={{ doc, resolution }} />
        </>
      }
    >
      <div id="folio-root">
        <FolioDoc doc={doc} registry={rt.registry} edit resolution={resolution} />
      </div>
    </Shell>,
    entries,
  )
}

async function html(node: ReactElement, bootstrapModules: string[]) {
  const stream = await renderToReadableStream(node, { bootstrapModules })
  return new Response(stream, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
