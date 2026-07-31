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
import { NO_STORE } from '../core/cache-tags'
import type { StoryMeta } from '../core/story'
import { FolioDoc, renderGlobalNode } from '../preview/Render'
import { Bootstrap, ReactRefreshPreamble, Shell } from './Document'
import type { FolioRuntime } from './runtime'
import type { FolioBindings } from './types'

/*
 * `adminPage` was here — the old single-screen editor's HTML, bootstrapping
 * `__FOLIO_ADMIN__`. **Deleted** with the admin it served (`ui-architecture.md` port
 * phase 8); `routes/editor.ts` has served `shellPage` at `{base}/edit/:id` since
 * phase 7, so it had no caller.
 *
 * One field of its bootstrap was **not** dead and has moved below: `space`. It is how
 * the admin feature-detects the space channel, and losing it would have quietly closed
 * off cross-story presence for the rebuilt editor.
 */

/**
 * The rebuilt admin's shell, for any screen under its mount.
 *
 * One handler for every screen, because the router is on the client: the server's
 * only job is to answer the same HTML at every path the shell owns and let
 * `admin/ui/route.ts` decide what it means. That is what makes a deep link work on
 * a cold load rather than only after a click — which is the whole of "everything
 * must be linkable".
 *
 * It carries no story id. The old editor page needs one because the editor *is*
 * the application there; here `/edit/:id` is one route among eleven and the id is
 * in the URL where it belongs.
 */
export function shellPage(rt: FolioRuntime, bindings?: FolioBindings): Promise<Response> {
  const { entries, stylesheets } = rt.page('admin')
  return html(
    <Shell
      title="Folio"
      stylesheets={stylesheets}
      head={
        <>
          {rt.dev ? <ReactRefreshPreamble /> : null}
          {/*
            Two values, not one, and the distinction is the point: `base` is the
            mount, for screens, the sign-in flow and asset URLs; `apiBase` is where
            the internal JSON lives. They were one field until the prefix move, and
            four of its uses turned out not to be JSON at all.
          */}
          {/*
            `space` is how the admin **feature-detects the space channel**
            (`../../../docs/specs/editing/live-collaboration.md`): a host that has not
            declared the binding must not have its console filled with a socket
            retrying forever, so the answer travels in the bootstrap rather than being
            discovered by a failed upgrade.
            
            It arrives here from the deleted `adminPage`, which was the only place it
            had ever been answered. **`bindings` is optional and only the editor route
            passes it** — `routes/shell.ts`'s wildcard deliberately does not, because
            `app.test.ts` builds a Folio whose accessor *throws* and asserts the shell
            still answers 200. Making the wildcard resolve the environment would give
            eight screens a dependency on it for a boolean one of them needs. Absent
            means `false`, which is the safe reading: no channel announced is no channel
            attempted.
          */}
          <Bootstrap
            global="__FOLIO_SHELL__"
            value={{
              base: rt.base,
              apiBase: `${rt.base}/api`,
              space: Boolean(bindings?.space),
            }}
          />
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
  // `story` is what lets the narrowed resolution reach this page's ancestors (a
  // breadcrumb still has to resolve) and what lets a collection listing this very
  // document show its **draft** title rather than its published one
  // (`../content-model/collections.md` decision 3).
  const resolution = await rt.resolve(bindings, doc, {
    draft: true,
    locale: opts?.locale,
    story,
  })
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

/* ------------------------------------------------------- a lapsed share --- */

/** Styles for the lapsed-link page. Inline, for the reason `loginPage` documents:
 * a page whose whole job is to explain a failure must not depend on a built asset. */
const LAPSED_STYLE = `
  body.folio-lapsed { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #111;
    background: #f6f6f7; display: grid; place-items: center; min-height: 100vh; }
  .folio-lapsed__card { background: #fff; border: 1px solid #e3e3e6; border-radius: 10px;
    padding: 28px 32px; max-width: 420px; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
  .folio-lapsed__card h1 { font-size: 17px; margin: 0 0 10px; }
  .folio-lapsed__card p { margin: 0 0 10px; color: #555; font-size: 14px; }
  .folio-lapsed__card p:last-child { margin-bottom: 0; }
`

/**
 * What `GET {base}/share?t=…` answers for a link that does not work.
 *
 * **A page rather than a bare 404, and 404 rather than 410.** The two halves of
 * that are answering different questions. The *prose* is there because the reader is
 * a client with no account who was sent a URL and has no way to interpret a status
 * code — "ask whoever sent this for a new one" is the entire useful content of the
 * response, and a plain 404 conveys none of it. The *status* is 404 because there is
 * nothing here to serve, and because 410 would be a claim about history.
 *
 * **The text is identical for expired, revoked, and never-issued**, which is the
 * part that matters. Distinguishing them would make this route an oracle for
 * "was this string ever one of our tokens" — harmless in practice against a
 * 256-bit secret, and worth nothing, because the reader's next action is the same
 * in all three cases. Usefulness comes from the explanation, not from the diagnosis.
 *
 * No JavaScript, for `loginPage`'s reason, and `no-store`: it is a response to a
 * credential.
 *
 * Takes no runtime, unlike every other page here, and that is the honest signature
 * rather than an oversight: it must not name the site, link into it, or say which
 * document the dead link was for. A reviewer whose link has lapsed has no standing
 * to be told any of those, and the page they get should not imply otherwise.
 */
export function expiredLinkPage(): Promise<Response> {
  return html(
    <Shell
      title="This preview link has expired"
      bodyClass="folio-lapsed"
      head={
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a static literal stylesheet, no interpolation
        <style dangerouslySetInnerHTML={{ __html: LAPSED_STYLE }} />
      }
    >
      <div className="folio-lapsed__card">
        <h1>This preview link no longer works</h1>
        <p>
          Preview links are temporary. This one has either run out or been turned off, so there is
          nothing to show you.
        </p>
        <p>Ask whoever sent it to you for a new link.</p>
      </div>
    </Shell>,
    // No client entry: there is nothing here to hydrate.
    [],
    404,
  )
}

/**
 * All four pages here are private by construction — the editor, a story's
 * *draft* preview, the sign-in form, and a lapsed preview link — so all of them
 * say `no-store` and none of them carries a `Cache-Tag`
 * (`../../../docs/specs/platform/caching.md` decision 7).
 *
 * The preview is the one that matters. The same URL returns draft HTML to an
 * editor and published HTML to a visitor, decided by the session cookie, and a
 * `Cookie` header neither bypasses Workers Cache nor forms part of its key — so
 * without this an editor's draft and a visitor's page would collide on one
 * entry, in the direction that serves an unpublished draft to the public. Belt
 * and braces: the README also tells a host not to cache a request carrying
 * `_folio=preview`, because the failure mode is bad enough to be worth saying
 * twice.
 */
async function html(node: ReactElement, bootstrapModules: string[], status = 200) {
  const stream = await renderToReadableStream(node, { bootstrapModules })
  return new Response(stream, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': NO_STORE,
    },
  })
}
