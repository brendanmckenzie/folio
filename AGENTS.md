# Building a host on Folio

Instructions for a coding agent adding Folio to a project. `README.md` explains
what each feature *is*; this file says what to do, in what order, and what you
will get wrong. Where they disagree, this file is about integration and the
README is about features — neither overrides the other.

Folio is a library, not an application. **The host owns its Worker, its routing
and its public pages.** Folio owns the editor, the sync engine and the block
render. Everything below follows from that.

## Install

```
npm install github:brendanmckenzie/folio#<full-sha>
```

Pin a **full 40-character SHA**, never a branch. There is no npm package and no
tag; a SHA is the version. `npm install` runs the package's `prepare`, which
builds `dist/` on your machine — expect the install to take a few seconds and to
need `esbuild` and `typescript` to succeed.

Peer dependencies: React 19, React DOM 19, Vite 7 or 8.

**When you bump the pin, delete `node_modules/folio` first.** npm skips the
package's build if the directory is already there, leaving no `dist/`.

## Point your own agent at this file

An agent working in *your* repository reads *your* root instructions, not this
file buried in `node_modules`. Paste this into your `AGENTS.md` or `CLAUDE.md`
so it knows to come here. The markers exist so it can be replaced wholesale on
an upgrade without disturbing anything around it.

```markdown
<!-- folio:begin -->
## Folio (CMS)

This project uses Folio, a Cloudflare-native block CMS mounted as a library.
**Before changing anything that touches it — blocks, the Worker entry, routing,
the Vite config — read `node_modules/folio/AGENTS.md`.** It states the one
sanctioned integration shape and the traps that read as library bugs when you
hit them.

The three rules broken most often:

- `folio.handle()` runs **first** in the Worker's `fetch` and returns `null` for
  anything it does not own. Your router runs after it, not before.
- A published page is **your** route, calling `folio.published()` in its loader.
  Never render pages in the Worker entry — it works, and silently bypasses your
  framework's layout, meta and error boundaries.
- Read fields with `fieldValue()` / `dataOf()` from `folio/core`, never
  `blok.data[name]`, or translations silently fall back to the source locale.

After bumping the pinned SHA, `rm -rf node_modules/folio` before installing.
<!-- folio:end -->
```

## The integration shape

There is one correct arrangement. Use it.

**1. Folio goes first in your Worker's `fetch`, as a miss-through.**

```tsx
export { SpaceDO, StoryDO } from 'folio/server'

export default {
  async fetch(req, env, ctx) {
    // Your own routes win. Put them before folio.handle() if they could collide.
    const handled = await folio.handle(req, env, ctx)
    if (handled) return handled

    // …then your router, unchanged.
    return router.fetch(req, env, ctx)
  },
}
```

`folio.handle()` returns a `Response` for surfaces Folio owns (the admin, its
JSON API, `{base}/mcp`, preview) and **`null` for everything else**. It never
intercepts, so it needs no blocklist and cannot swallow one of your paths.

**2. A published page stays *your* route.** Do not render pages inside the
Worker entry. In your framework's loader (or handler, or controller):

```tsx
const doc = await folio.published(env, path, locale)
if (!doc) {
  const hit = await folio.redirect(env, path)          // a rename left a redirect
  if (hit) return Response.redirect(hit.to, hit.status)
  const status = await folio.status(env, path)         // 'unpublished' vs never existed
  return new Response('Not found', { status: status === 'unpublished' ? 410 : 404 })
}
const resolution = await folio.resolve(env, doc, { locale })
return <YourLayout>{folio.render(doc, { resolution })}</YourLayout>
```

This keeps your framework's layout, `meta`/`head` exports, error boundaries and
SEO helpers. It works because `Resolution` is plain JSON — the rich objects
(`asset.srcFor`, a reference's `content`) are rebuilt from it at render time, so
it survives a loader boundary.

**3. Add the Vite plugin.** `folio/vite` supplies the admin entry, the client
build and the asset constants. Do not hand-roll them.

## Rules

- **`folio.handle()` first, and it returns `null`.** If a Folio path 404s, your
  router ran first.
- **`redirect()` and `status()` belong in your own miss branch.** Folio will not
  answer them for you, deliberately — it does not own your 404.
- **Read fields with `fieldValue(blok, name, locale)` / `dataOf(blok, locale)`**
  from `folio/core`. Never `blok.data[name]`: translations live in `i18n`, a
  sibling of `data`, and a direct read silently returns the source locale.
- **`folio/core` is the contract** for defining blocks and rendering resolved
  pages. `folio/engine` is bulk-import and migration tooling — its `apply()`
  outside a transaction bypasses sync, undo and multiplayer, so it must never
  run against content someone might have open.
- **A block's `render` is a pure function of its own fields.** It receives
  `PropsOf<fields> & { uid: string }` and nothing else.
- **Pin a full SHA.** A short SHA or a branch will resolve differently later.

## Do not

- **Do not render published pages in the Worker entry** when you have a router.
  It works, and it silently bypasses your framework's layout, meta and error
  boundaries. The demo in `examples/demo` does exactly this because it is a bare
  Worker with nowhere to hand off to — that part of it is not a template.
- **Do not install by directory path or symlink.** It resolves `vite` from
  Folio's own tree and TypeScript then sees two incompatible `Plugin` types. Use
  a git SHA, or `npm pack` a tarball.
- **Do not override `optimizeDeps` without re-including `react-dom/server.edge`.**
  See the table below.
- **Do not write `published_doc` or a story's `doc` row directly.** Writes go
  through the mutation log or they break sync, undo, presence and the activity
  trail — visibly only to whoever had the page open.
- **Do not add a `{base}/api/v1/*` route of your own.** A version segment is a
  promise to somebody's script; unversioned `{base}/api/*` is internal to the
  admin and changes shape freely.

## When something breaks

| What you see | What it is |
| --- | --- |
| `ReferenceError: require is not defined` at Worker startup, from a stack naming nothing you wrote | `react-dom/server.edge` is CommonJS and was left external. `folio/vite` force-includes it in `optimizeDeps`; a host that replaced that config dropped it. |
| Admin renders unstyled; its stylesheet 404s behind a 200 | `build.cssCodeSplit: false` reached the build without being set in your own `vite.config.ts` — usually a framework plugin set it. The plugin cannot see that and throws at `configResolved` naming the cause. Set it in your own config. |
| A referenced document's asset field is empty | A block's `render` gets no `Resolution`, so it cannot resolve an asset belonging to a *referenced* document. Only the `url` arm works today. Known limitation. |
| Typecheck reports two incompatible `Plugin` types | Folio installed by directory path. Use a SHA or a tarball. |
| A path Folio should own returns your 404 | Your router ran before `folio.handle()`. |
| A page taken down reads as 404 instead of 410 | You did not call `folio.status()`. It exists to tell "unpublished on purpose" from "never existed". |
| Login appears to do nothing | The `users` table is empty. The login route answers 200 identically whether or not an address is known, so it cannot enumerate accounts — an unknown email looks exactly like a successful one. |
| Editor loads but shows no other cursors and the tree never updates | The optional `space` binding is absent. Nothing else depends on it. |
| After bumping the pinned SHA, imports fail or `dist/` is missing from `node_modules/folio` | npm skipped the package's `prepare` build because a `node_modules/folio` directory was already there. `rm -rf node_modules/folio` and install again. A clean install has never had this problem, which is why it survives so long unnoticed. |

## Limitations worth knowing before you design around them

- **A block's `render` receives no `Resolution`** (above). If a block must show
  data from a document it references, that data has to arrive through the
  reference's own resolved `content`.
- **Draft preview is Folio's shell, not your layout.** A share link and the
  editor preview render the document on your block CSS but with Folio's chrome
  around it, not your page. Rendering a draft inside the host's own layout is
  specified (`docs/specs/platform/draft-mode.md`) and not built.
- **One site per deployment.** There is no site dimension in the schema; several
  brand sites in one Folio is specified (`docs/specs/foundation/multi-site.md`)
  and not built.
- **No host-defined custom field types.** The field set is what `folio/core`
  exports.

## Where to look next

- `README.md` — every feature, with worked examples.
- `docs/api.md` — the `{base}/api/v1` contract.
- `docs/mcp.md` — pointing an assistant at a running site.
- `examples/demo` — a working host. Read it for block definitions and config;
  see the "Do not" note above about its page rendering.
