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
 *
 * `opts.locale` is the `?locale=` the admin's switcher put on the URL
 * (`../../../docs/specs/content-model/localisation.md` decision 6). It reaches
 * the `Resolution` and nothing else: the *document* is the same one in every
 * language, so switching locale is a reload of this page rather than a new frame
 * pushed into a live iframe — the host's own chrome and `<html lang>` change too,
 * and no postMessage can reach those.
 */
export async function previewPage(
  rt: FolioRuntime,
  bindings: FolioBindings,
  story: StoryMeta,
  opts?: { as?: string; bare?: boolean; locale?: string },
): Promise<Response> {
  const doc = await rt.draftFor(bindings, story)
  const resolution = await rt.resolve(bindings, doc, { draft: true, locale: opts?.locale })
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
      // The one piece of chrome Folio's own preview shell can get right about a
      // locale. A host's real page sets its own.
      lang={resolution.locale?.code}
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

/* ------------------------------------------------------------------ login --- */

/** Styles for the login page, inline for the reason `loginPage` documents. */
const LOGIN_STYLE = `
  body.folio-login { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #111;
    background: #f6f6f7; display: grid; place-items: center; min-height: 100vh; }
  .folio-login__card { background: #fff; border: 1px solid #e3e3e6; border-radius: 10px;
    padding: 28px 32px; width: 340px; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
  .folio-login__card h1 { font-size: 17px; margin: 0 0 4px; }
  .folio-login__card p { margin: 0 0 18px; color: #666; font-size: 13px; }
  .folio-login__card label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 5px; }
  .folio-login__card input { width: 100%; box-sizing: border-box; padding: 8px 10px;
    border: 1px solid #ccc; border-radius: 6px; font: inherit; }
  .folio-login__card button, .folio-login__provider { display: block; width: 100%;
    box-sizing: border-box; margin-top: 12px; padding: 9px 12px; border-radius: 6px;
    border: 1px solid transparent; background: #111; color: #fff; font: inherit;
    font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
  .folio-login__provider { background: #fff; color: #111; border-color: #ccc; }
  .folio-login__notice { margin: 0 0 16px; padding: 9px 11px; border-radius: 6px;
    font-size: 13px; background: #eef6ff; border: 1px solid #cfe4fb; color: #14477d; }
  .folio-login__notice--bad { background: #fff0f0; border-color: #f6c9c9; color: #8a1f1f; }
  .folio-login__rule { margin: 18px 0 0; border: 0; border-top: 1px solid #eee; }
`

export interface LoginPageOptions {
  /** Where to send the browser once signed in. Already screened same-origin. */
  next: string
  /** Shown in a blue banner: "check your email". */
  sent?: string | null
  /** Shown in a red banner: a refused or expired link. */
  error?: string | null
}

/**
 * The sign-in page. Server-rendered, and deliberately ships **no JavaScript**
 * (architecture decision 7): a CMS login page that cannot work without a client
 * bundle is a worse failure than an ugly one, and it is the same rule this
 * project already applies to published pages.
 *
 * That is also why the styling is an inline `<style>` rather than the admin
 * stylesheet: the admin's CSS is a Vite-built asset at a hashed URL, so a page
 * that depended on it would render unstyled in exactly the situation — a broken
 * or unbuilt bundle — where someone needs to sign in and look at the CMS to find
 * out what is wrong.
 *
 * Providers are rendered from the config, so the page shows the email form only
 * when a `send`-style provider is configured and a button per redirect provider.
 */
export function loginPage(rt: FolioRuntime, opts: LoginPageOptions): Promise<Response> {
  const providers = rt.auth.mode === 'session' ? rt.auth.config.providers : []
  const mail = providers.filter((p) => !p.redirect)
  const redirects = providers.filter((p) => p.redirect)
  const next = opts.next

  return html(
    <Shell
      title="Sign in · Folio"
      bodyClass="folio-login"
      head={
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a static literal stylesheet, no interpolation
        <style dangerouslySetInnerHTML={{ __html: LOGIN_STYLE }} />
      }
    >
      <div className="folio-login__card">
        <h1>Sign in to Folio</h1>
        <p>You need an account to edit this site.</p>

        {opts.error ? (
          <p className="folio-login__notice folio-login__notice--bad">{opts.error}</p>
        ) : null}
        {opts.sent ? <p className="folio-login__notice">{opts.sent}</p> : null}

        {mail.length > 0 ? (
          <form method="post" action={`${rt.base}/login/email`}>
            <input type="hidden" name="next" value={next} />
            <label htmlFor="folio-login-email">Email address</label>
            <input
              id="folio-login-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
            <button type="submit">{mail[0]?.label ?? 'Email me a sign-in link'}</button>
          </form>
        ) : null}

        {mail.length > 0 && redirects.length > 0 ? <hr className="folio-login__rule" /> : null}

        {redirects.map((provider) => (
          <a
            key={provider.id}
            className="folio-login__provider"
            href={`${rt.base}/login/${provider.id}?next=${encodeURIComponent(next)}`}
          >
            {provider.label}
          </a>
        ))}
      </div>
    </Shell>,
    // No client entry: that is the point.
    [],
  )
}

async function html(node: ReactElement, bootstrapModules: string[]) {
  const stream = await renderToReadableStream(node, { bootstrapModules })
  return new Response(stream, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
