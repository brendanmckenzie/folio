# Feature: Draft mode — the real site, rendered from drafts

> **Group:** platform
> **Build order:** 25, per docs/specs/README.md
> **Size:** M
> **Status:** done
> **Wire version:** none
> **Migration:** none
> **Last updated:** 2026-08-30

## Summary

An editor cannot browse the site as it *would* look, and a reviewer sent a share link
does not see the host's page. Both land on `?_folio=draft`, which `folio.handle()`
answers itself — so the host's own render never runs and what appears is Folio's preview
shell: the document's content on the host's block CSS, with globals stacked above it
rather than placed the way the host places them. `server/pages.tsx` has said so in place
since long before this ("a simplification, not a claim of visual fidelity").

This makes a draft renderable **inside the host's own layout, at the page's own URL,
across navigations** — which is the same feature `ROADMAP.md` records twice, once as "a
draft has no render inside the host's own layout" and once as *Uncovered*'s
"cookie-based draft mode". They are one thing seen from two ends.

Nothing new has to be invented to store or read a draft: `folio.draft(env, id)` already
returns one, `folio.render(doc, { mode: 'mark' })` already renders one without editing
chrome, and `GET {base}/share?t=…` already exchanges a token for a cookie. What is
missing is a *contract*: a way for a host to ask "is this request in draft mode, and may
it see this document", and an answer to what a share link does on a host that has not
wired it up.

## Ground truth

Verified against the tree at `dde1d4d`.

**server (`packages/folio/src/server/`):**
- **`folio.draft(env, id)` already exists** (`index.tsx:368`), delegating to `rt.draft`
  (`runtime.ts:212`) and returning a `Doc`. So reading a draft outside the editor is
  already a supported, public call — this spec adds no way to *get* a draft.
- **`folio.render(doc, opts)` already takes a mode** (`index.tsx:450`), passing
  `opts.mode` through to `FolioDoc`. `RenderMode` is `'off' | 'mark' | 'edit'` and
  `'mark'` is exactly what this needs: `data-folio-uid` on host elements, no marker
  wrappers, no bridge, no placeholders.
- **`folio.storyAt(env, path)`** (`index.tsx:363`) resolves a path to a `StoryMeta` with
  urls attached, which is how a host turns the request's path into the id `folio.draft`
  wants.
- **The share cookie exists and is already scoped to a grant.**
  `SECURE_SHARE_COOKIE = '__Host-folio_share'` / `PLAIN_SHARE_COOKIE = 'folio_share'`
  (`auth/cookie.ts:32-33`), read by `shareCookieTokens` (`index.tsx:279`) and capped at
  `MAX_SHARE_COOKIE_TOKENS` so an editor sending three links does not overflow a
  reviewer's browser (`auth/shares.ts:329`).
- **`GET {base}/share?t=…` exchanges the token for that cookie and redirects to
  `rt.withUrls(story).draftUrl`** (`routes/preview.ts`, header comment). That
  destination is the thing this spec changes.
- **The "no D1 read for a request with no credential" discipline is already
  established** by spec 21: the cookie's *presence* is tested up at the actor check and
  null is returned there when it is absent, so a stranger appending a flag to a random
  URL costs the database nothing. This spec must preserve that exactly.
- **`folio.handle()` returns null for anything Folio does not own**, which is why a
  host's own routes win at any path and why draft mode can be a host-side branch at all.

**preview (`packages/folio/src/preview/`):**
- `Render.tsx` returns early for `mode === 'off'` before any attribute, and again for
  `'mark'` before the `folio-marker` wrapper. Placeholders (`folio-unknown`,
  `folio-unrendered`, `EmptySlot`) are `edit`-only. Default is `'off'`.

**config:**
- `FolioConfig` has no draft-mode key. `PreviewMode = 'preview' | 'draft'`
  (`server/types.ts`) is the query-parameter mode, not this.

**tests:**
- `test/workers/preview-modes.test.ts` pins the three render modes, including a
  node-for-node comparison that a `mark` render carries no wrapper.
- `test/workers/shares.test.ts` pins the share gate and that a share link lands on
  `?_folio=draft` with no chrome and no bridge.

## Owner decision checkpoints

1. **A share link's destination changes for a host that opts in.** Today every share
   link lands on `?_folio=draft`. With `draftMode: true` configured it will land on the
   story's *real* URL instead, so the reviewer sees the host's page. Recommended,
   because it is the whole point — but it means a host that opts in and has not written
   the branch serves the *published* page to a reviewer, which is a worse failure than
   Folio's shell (it looks correct and is stale). Mitigated by decision 4.
2. **Draft mode for an editor is site-wide, not per-story.** An editor browsing the site
   in draft wants every page drafted, including ones they have not opened. Recommended.
   The alternative — draft only the pages you have visited — has no coherent rule.

## User stories

### An editor checks the site before publishing
**As** an editor **I want to** browse the real site with my unpublished changes in place
**so that** I can see whether a change looks right in the layout it will ship in, and
follow links between pages while doing it.

### A reviewer opens a share link
**As** a client sent a link **I want to** see the page as it will actually appear **so
that** my approval means something about the page rather than about an approximation.

### A host adds draft mode in a few lines
**As** a developer **I want to** support draft mode with an explicit branch in my own
`fetch` **so that** nothing about my routing is taken over by the CMS.

## Architecture decisions

### 1. The host renders the draft. Folio answers "may this request see it"

`folio.draftAt(env, req, path, locale?)` returns a `Doc` when the request is in draft
mode *and* is allowed this document, and `null` otherwise. The host's miss branch becomes
one extra call before `folio.published`:

```tsx
const draft = await folio.draftAt(env, req, path, locale)
const doc = draft ?? (await folio.published(env, path, locale))
if (!doc) { /* redirect / status / 404, exactly as now */ }
const resolution = await folio.resolve(env, doc, { locale, draft: draft !== null })
return render(
  <Shell>
    {folio.renderGlobal(resolution, 'header')}
    {folio.render(doc, { resolution, mode: draft ? 'mark' : 'off' })}
  </Shell>,
  draft ? { headers: folio.noStore() } : { headers: folio.cacheHeaders(resolution, { story }) },
)
```

**Rejected: `handle()` hands the draft back for the host to render.** It inverts a
contract that today returns either a `Response` or `null` — a host that ignored the new
third case would serve nothing at all, and every existing host's `if (handled) return
handled` would silently stop being correct. The value of `handle()` is that it is total:
it either owns the request or it does not.

**Rejected: Folio renders the host's layout.** Folio owns no layout and has never
wrapped a page in one; that is `renderGlobal`'s whole shape. A host cannot hand its
`<Shell>` to a library that runs before its own code.

### 2. Draft mode is a cookie, and the same cookie a share already sets

A share link's cookie already means "this browser may see the draft of story X". An
editor's draft mode means "this browser may see every draft", and the credential for that
already exists too — the session cookie, with a role. So `draftAt` reads:

- the **share cookie**, granting the story ids in it, or
- the **session cookie**, granting everything, when the actor's role reaches
  `READ_DRAFT` — plus a second flag so an editor is not permanently in draft mode.

That second flag is a small cookie of Folio's own (`folio_draft`), set by
`GET {base}/draft/enter?next=…` and cleared by `GET {base}/draft/exit?next=…`, both
behind `READ_DRAFT`. **Rejected a query parameter** (`?_draft=1`): it does not survive a
navigation, which is the entire requirement, and it would end up in shared URLs and
search indexes.

**No D1 read when neither cookie is present**, preserving spec 21's discipline: the
presence test is a string check on the `Cookie` header, and `draftAt` returns null before
touching a binding.

### 3. A draft response is never cached, and Folio says so rather than trusting the host

`folio.noStore()` returns the `private, no-store` headers a draft response must carry —
the same constant `NO_STORE` the preview branch already uses. It is exported because the
failure it prevents is catastrophic and silent: a draft cached at the edge under the
page's real URL serves unpublished content to the public until it evicts. A host that
forgets is one `Cache-Tag` away from that, and `cacheHeaders` cannot help because it
answers for a *published* render.

**Rejected leaving it to the host** on the grounds that the host already sets cache
headers. The two calls look interchangeable and are not, so the safe one has to be as
easy to reach as the dangerous one.

### 4. A share link's destination depends on config, and the config key is the host's promise

`createFolio({ draftMode: true })` means "my `fetch` has the branch above". With it, a
share link redirects to the story's real URL; without it, to `?_folio=draft`, exactly as
today. So an unwired host keeps working and a wired one gets the real page.

**Rejected inferring it.** There is nothing to infer from — Folio cannot see whether a
host's miss branch calls `draftAt`. **Rejected making it the default**, because the
failure mode of a wrong guess is a reviewer confidently approving a stale published page.

### 5. `?_folio=draft` stays, and keeps its one honest job

It is what `preview_document` screenshots (spec 24), what an unwired host's share links
use, and the only draft render available to a host that has no page for a document.
Keeping it is not compatibility: it is the answer for a document with no URL.

## Wire & schema changes

### D1 migration

None. A cookie is not stored, and the `shares` table already holds every grant.

### Core types

`FolioConfig` gains `draftMode?: boolean` (default false). `ResolveOptions` gains
`draft?: boolean`, so a `reference` inside a drafted page resolves the *target's* draft
too — which is what preview already does and what makes a drafted page internally
consistent.

### New or changed routes

| Method | Path | Auth | Answers |
| --- | --- | --- | --- |
| `GET` | `{base}/draft/enter?next=` | `READ_DRAFT` | 302 to `next`, `Set-Cookie: folio_draft` |
| `GET` | `{base}/draft/exit?next=` | none | 302 to `next`, cookie cleared |
| `GET` | `{base}/share?t=` | share token | 302 to the story's real URL when `draftMode`, else `draftUrl` |

`next` is refused unless it is same-origin and path-only, the same screen
`lookupRedirect` already applies to a redirect target — an open redirect behind an
authenticated route is worse than one in front of it. `exit` is deliberately ungated: a
reviewer whose grant has expired must still be able to get out.

## Acceptance criteria

### An editor browses in draft

```
GIVEN an editor with an unpublished change to /about
WHEN they visit {base}/draft/enter?next=/about and follow the redirect
THEN /about renders the host's own layout with the unpublished change
AND the response carries private, no-store
AND following a link to /about/team also renders that page's draft
WHEN they visit {base}/draft/exit?next=/about
THEN /about renders the published content again
```

### A reviewer sees one page and no others

```
GIVEN a share grant for /pricing on a host with draftMode: true
WHEN the reviewer opens the share link
THEN they are redirected to /pricing itself, not to /pricing?_folio=draft
AND /pricing renders the draft inside the host's layout
WHEN they navigate to /about
THEN /about renders published content, because the grant names one story
```

### An unwired host is unchanged

```
GIVEN a host with no draftMode key
WHEN a reviewer opens a share link
THEN they land on ?_folio=draft exactly as before
```

### Cost of a stranger

```
GIVEN a request with no session cookie and no share cookie
WHEN the host calls folio.draftAt
THEN it answers null without reading D1
```

## Implementation plan

### Phase 1 — `draftAt`, `noStore` and the resolve flag

1. `folio.draftAt(env, req, path, locale?)` in `server/index.tsx`, with the
   cookie-presence short-circuit first.
2. Export `folio.noStore()`.
3. `ResolveOptions.draft`, threaded to reference resolution.

### Phase 2 — the enter/exit routes and the cookie

1. `server/routes/draft.ts`, mounted like `shareRoutes`.
2. `next` validation shared with the redirect screen rather than re-written.

### Phase 3 — the share destination

1. `FolioConfig.draftMode`, and the branch in `routes/preview.ts`'s share handler.
2. Amend `platform/draft-sharing.md`'s implementation notes in place, the way spec 24
   amended them: this is the second time that link's destination has moved.

### Phase 4 — the demo wires it, because a contract with no consumer is prose

1. `examples/demo`'s `fetch` gains the branch, `draftMode: true`, and a banner when
   `folio.inDraftMode(req)`.
2. `README.md` and `docs/api.md` gain the pattern.

## Edge cases

- **A drafted page linking to a page with no draft of its own** → resolves to the
  published target. A draft is per document; there is no "draft of the whole site".
- **A drafted page that has never been published** → renders. This is the case the
  feature exists for, and the host's own `if (!doc)` never fires.
- **An expired share cookie** → `draftAt` returns null, the published page renders, and
  the reviewer sees a live page rather than an error. `{base}/share` still answers the
  expired-link page for the link itself.
- **Draft mode on with no draft changes** → renders the same bytes as published. Not a
  special case, and worth not special-casing.
- **A host that sets `draftMode: true` and never calls `draftAt`** → share links land on
  a published page. Named in the config's own doc comment as the one way to hold this
  wrong.
- **`{base}/draft/enter` with a cross-origin `next`** → 400. See decision 4's note.

## Testing requirements

**Unit (`packages/folio/test/unit/`):**
- The `next` screen: same-origin path-only accepted, scheme-relative, absolute and
  `javascript:` refused.
- The cookie-presence short-circuit as a pure predicate.

**Workers (`packages/folio/test/workers/`):**
- `draftAt` answers null with no cookies **and makes no D1 call** (a binding spy, the
  same shape `shares.test.ts` uses for its no-read assertion).
- A session cookie plus the draft cookie drafts every page; without the draft cookie,
  none.
- A share cookie drafts exactly the granted story and no other.
- The share redirect target flips with `draftMode`.
- A drafted response carries `private, no-store` and no `Cache-Tag`.

**End to end (`scripts/draft-mode-test.mjs`):**
- Enter draft mode, fetch a page, assert the unpublished heading is in the *host's* HTML
  (a `<html>` the demo's `Shell` produced, not `previewPage`'s), navigate to a second
  page, assert the same, exit, assert published bytes return.

## Dependencies

- Spec 21 (`platform/draft-sharing.md`) for the share cookie and grant table.
- Spec 24 (`platform/mcp-server.md`) for `RenderMode` and `?_folio=draft`.
- No Cloudflare resources.

## Out of scope

- **Draft mode for an anonymous visitor.** There is no credential for it and no want.
- **A draft of the whole site as a snapshot.** "Every document's current draft" is what
  this renders; a named, shareable snapshot of many documents at once is releases, which
  `../completion-plan.md` parks with a reason.
- **Rendering a draft of an unrouted document in the host's layout.** It has no URL;
  `?_folio=draft` remains the answer, which is decision 5.
- **Draft mode in the admin's own iframe.** It keeps `?_folio=preview`: the editing
  render is what the bridge needs, and that is spec 24 decision 5.

## Open questions

None. Both checkpoints have a recommendation and decision 4 answers the unwired-host
question `ROADMAP.md` left open.

## Implementation notes

Built 2026-08-30, all four phases, and the plan held: `draftAt` as the whole
contract, a cookie that is a flag rather than a credential, `noStore` exported
beside `cacheHeaders`, and `draftMode` as the host's promise. Nothing in the
architecture decisions was overturned.

**Four corrections to Ground truth**, all of which were accurate when written and
stale by the time it was built:

- **`ResolveOptions.draft` already existed.** The spec said the type "gains" it.
  What actually needed changing was `HostResolveOptions`, which was deliberately
  `Omit<ResolveOptions, 'draft'>` with a comment saying a published render always
  resolves published content — the exact premise this feature breaks. It is now
  the full type, and the comment says why.
- **`shares.test.ts` has no binding spy**, though the spec's testing section cites
  "the same shape `shares.test.ts` uses for its no-read assertion". No such
  assertion exists there. `draft-mode.test.ts` writes the first one, a `Proxy`
  counting `prepare` calls, and it is the single most load-bearing test in the
  file: `draftAt` runs ahead of `published` on every page a wired host serves, so
  a D1 read to decide "no" would double the query count of an entire site.
- **The `next` screen is `safeNext` in `validate.ts`**, not something belonging to
  `lookupRedirect`. It **falls back to a default rather than answering 400**, and
  the routes follow it rather than the spec's edge case: consistency with the
  login route beat a distinction no caller can act on. The edge-case table's
  "→ 400" is wrong and the behaviour is a 302 to `/`.
- **File paths moved.** Ground truth cites `packages/folio/src/...`; the package
  is the repository root since spec 26, so those are `src/...`.

**One behaviour worth stating plainly, because it surprised the implementation.**
`READ_DRAFT` is `{ role: 'viewer', scope: 'content:read:draft' }` — the *lowest*
role — so **every signed-in account can enter draft mode**, viewer included. That
is correct rather than lax: a viewer can already open any draft in the admin's
preview, and refusing them the identical bytes at the page's real URL would be a
distinction with nothing behind it. A test pins it, because the reflex on reading
`draftAt` is that browsing the live site in draft feels more privileged than
opening the editor, and it is not.

**`draftAt` deliberately does not share code with `handle()`'s preview branch.**
They agree on who may see a draft and differ on everything else — the render, the
response, the shape of a refusal. Folding them together would be one function with
a mode flag deciding four unrelated things.

**The e2e script found the thing no unit test could.** Its discriminator is that
the unpublished heading appears inside the *demo's own* `Shell` — asserted through
`/site.css`, which only the host's page links. The first attempt keyed on the
`header` global's wrapper and failed against a perfectly ordinary published page,
because the demo's seed leaves that singleton empty and `renderGlobal` then emits
nothing. Also worth knowing for the next script: **`signInGlobally` keeps no cookie
jar** — it wraps `fetch` with one fixed session header and never records a
`Set-Cookie` — so a script needing a second cookie has to carry it by hand.

Deferred: nothing. The demo wires it, so the contract has a consumer.
