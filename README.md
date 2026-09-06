# Folio

**A block CMS with a real visual editor, schema you write in TypeScript, and
multiplayer editing — running on nothing but Cloudflare.**

Every CMS is excellent at three or four things and asks you to live with the
rest. The one with the beautiful click-a-block-in-the-page editor keeps your
content model in a web form, so it drifts from your components. The one with
schema-as-code has no visual editor at all. The one with genuine real-time
collaboration has no publishing workflow, and the one with the workflow renders
your pages on somebody else's boxes, in somebody else's region, behind somebody
else's cache.

Folio is what came of refusing to pick. Take the best idea out of each of them,
then keep going until they agree with one another:

| From | What |
| --- | --- |
| Storyblok | Nested blocks, click-a-block-in-the-page-to-edit-it, draft/published split |
| Payload | Schema as code, colocated with the component |
| Linear | Local-first mutation log: optimistic apply, delta sync, undo, multiplayer |
| EmDash | Cloudflare-only target: Workers, D1, Durable Objects, R2 |

It is a **library, not an application**. Your project owns its Worker, its
routing and its public pages. Folio owns the editor, the sync engine and the
block render, and returns `null` for every path it does not own — so it can
never swallow one of yours.

---

## A block, end to end

This is the whole of what a content type is. The admin form, the prop types and
the HTML all come from this one file, so they cannot drift apart:

```tsx
// src/blocks/hero.tsx
import { blocks, defineBlock, select, text } from 'folio/core'

export const hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  summary: 'heading',        // what the block shows in the editor's outline
  fields: {
    heading: text({ required: true, translatable: true }),
    align: select({
      options: [
        { label: 'Left', value: 'left' },
        { label: 'Centre', value: 'center' },
      ],
      default: 'center',     // a new hero starts centred, not on option one by accident
    }),
    actions: blocks({ allow: ['button'], max: 2 }),
  },
  // `align` is typed 'left' | 'center'. `actions` arrives already rendered.
  render: ({ heading, align, actions }) => (
    <section className={`hero hero--${align}`}>
      <h1>{heading}</h1>
      <div>{actions}</div>
    </section>
  ),
})
```

An editor sees a Hero with a heading box, a two-option dropdown and a slot that
accepts up to two buttons. They click the heading *on the page* and type into
it. Another editor, in another window, watches it change.

---

## Quick start

```bash
npx github:brendanmckenzie/folio init my-site
cd my-site
npm install
npm run db:local && npm run db:seed
npm run dev
```

Open <http://localhost:5173/folio/login> and enter the address the scaffolder
seeded — it prints it, and asks for it. There is no mail binding on a fresh
project, so the sign-in link is **logged to your terminal**. Follow it, and you
land in the editor on the home page.

Add a Hero, type into it, hit **Publish**. It is live at `/`.

Open the editor in a second window to watch multiplayer.

`init` scaffolds a complete, working Cloudflare project: a Worker that mounts
Folio and renders published pages, three example blocks, a `wrangler.jsonc` with
every binding wired up, and the D1 migrations pointed at the package's copy. It
pins the current `main` as a full SHA — see [Versioning](#versioning) for why
that is the version number.

> Two things about that first command. It is `npx github:…` rather than
> `npm create folio`, because `npm create` needs a package on the npm registry
> and Folio is not on one. And it takes a minute the first time: npm builds the
> library on your machine before it can run anything from it. Nothing has hung.

What it writes is [`examples/starter`](examples/starter), which is a real
package in this workspace and typechecked on every commit — so it compiles
before it reaches you.

Prefer to do it by hand, or adding Folio to a project that already exists?
[`AGENTS.md`](AGENTS.md) is the integration guide — it is written for a coding
agent and reads perfectly well as a checklist for a person.

**Requirements:** Node 20.19+ or 22.12+ (Vite's floor), a Cloudflare account,
React 19, and Vite 7 or 8.

---

## What it does

Grouped roughly the way you meet them.

### Authoring

- **Visual editing.** Your real page in an iframe; click any block to select it.
  Edits apply optimistically and stream to the preview without a reload.
- **Multiplayer.** Cursors, selections and presence across the whole site, over
  a Durable Object. Undo is per-user, not per-document.
- **Nested blocks** with per-slot `allow` lists and maximums, drag to reorder,
  duplicate, and copy/paste between documents and between sites.
- **Richtext** built on TipTap, constrainable per field down to "bold, italic
  and links, one paragraph". Internal links store a document *id*, so renaming
  a page fixes every link pointing at it.
- **Conditional fields**, field **defaults and presets**, and a **history** tab
  with versions, restore, minimal diffs and an activity trail.

### The content model

- **Three kinds of document.** `page` lives in the tree and owns a URL;
  `record` is unrouted data (people, offices, products); `singleton` is exactly
  one of a thing (site settings, a header).
- **Globals** — singletons loaded into every page's resolution, so your layout
  can place a header and footer that editors control.
- **References and collections.** Point at another document, hand-pick an
  ordered list of them, or query published content by an indexed field with
  filtering, sorting and pagination.
- **Full-text search** over published content, with snippets, gate-aware.
- **Localisation.** One document holds every language; translations live
  alongside the source value per field. You own the URL shape.
- **Forms.** Built in the admin, embedded by id, submitted to a route Folio
  owns. Responses are stored, exportable as CSV that Excel will not execute,
  and forwarded by a hook.

### Assets

- A **media library** on R2 with folders, tags, bulk edits and usage counts.
- On-the-fly **resizing** and format conversion through the Images binding,
  with focal points and per-usage alt text.
- Optional **machine-written alt text**, descriptions and tags — you supply the
  model call; Folio holds no API key and picks no vendor.

### Publishing and the platform

- **Draft / published split**, with **draft mode**: browse the real site from
  its drafts at real URLs, and **share links** that give a reviewer one page
  and no account.
- **Scheduled publish and unpublish**, off one cron trigger.
- **Redirects**, and a 404 branch that can tell "taken down on purpose" (410)
  from "never existed" (404).
- **Caching** that actually invalidates: cache tags are computed from what a
  render *loaded*, and a publish purges by tag, globally.
- **D1 read replication**, wired through a per-request session so a reader in
  Sydney is not waiting on a primary in Virginia.
- **Publish hooks** — typed after-commit callbacks in your own Worker, not
  webhooks to yourself.

### Access and integration

- **Auth with no default**: magic links, OIDC, Cloudflare Access, passkeys, or
  `auth: 'open'` said out loud. Roles, per-domain provider enforcement, and an
  auth event log with a retention sweep.
- **Visitor access** — members-only pages, where *your* membership system
  answers who the visitor is and Folio does the cheap part.
- **A versioned Content API** (`{base}/api/v1`) with token scopes, plus an
  in-process `folio.write()` for your own Worker.
- **An MCP server** at `{base}/mcp`, so an assistant can read and write content
  with a scoped credential.
- **Content migrations** — pure functions from a document to a list of
  mutations, applied through the same log the editor writes to, plus a drift
  audit that tells you which schema changes have stranded data.

Not built, deliberately or not yet: host-defined custom field types, multi-site
in one deployment, collaborative richtext (a CRDT), and an admin surface for
outbound webhooks. The handbook's "Not built yet" section is the honest list.

---

## The integration, in three pieces

**1. Define your blocks** — the file above. Export them as one array.

**2. Mount Folio in your Worker.** It goes first, and misses through:

```tsx
import { createFolio, magicLink } from 'folio/server'
import { blocks } from './blocks'

export { SpaceDO, StoryDO } from 'folio/server'

const folio = createFolio<Env>({
  blocks,
  types: [{ name: 'page', label: 'Page', kind: 'page', root: 'page' }],
  bindings: (env) => ({ db: env.DB, story: env.STORY, space: env.SPACE, media: env.MEDIA }),
  auth: { providers: [magicLink({ send: (env, { email, url }) => sendMail(env, email, url) })] },
  route: (path) => `/${path}`,
})

export default {
  async fetch(req, env, ctx) {
    // Your own routes win. Folio returns null for anything it does not own.
    const handled = await folio.handle(req, env, ctx)
    if (handled) return handled

    return renderPage(req, env)      // …your router, unchanged
  },
}
```

**3. Render published pages from your own route.** One call gives you the
document, the story, the resolution, whether this request may see a draft, and
the exact cache headers the response must carry:

```tsx
const reader = folio.reader(env, req)          // one D1 session for the whole render
const page = await reader.page(path)
if (!page) {
  const miss = await reader.miss(path)         // redirect + state, one round trip
  if (miss.kind === 'redirect') return Response.redirect(miss.to, miss.status)
  return new Response('Not found', { status: miss.kind === 'gone' ? 410 : 404 })
}

return html(
  <YourLayout>{folio.render(page.doc, { resolution: page.resolution })}</YourLayout>,
  page.headers,
)
```

Because `Resolution` is plain JSON, that survives a loader boundary — so this
works inside React Router, TanStack Start, or whatever else owns your routes.
Your layout, your `<head>`, your error boundaries.

**Plus the Vite plugin**, which supplies the prebuilt admin, the preview bundle
and the asset constants:

```ts
import { folio } from 'folio/vite'

plugins: [react(), folio({ blocks: './src/blocks/index.ts' }), cloudflare()]
```

---

## Configuring it

`createFolio()` takes one object. Two keys are required and the rest are
opt-in — and every optional key's absence is a complete, defined behaviour
rather than a gap:

| Key | | What it turns on |
| --- | --- | --- |
| `blocks` | **required** | Your block definitions |
| `auth` | **required** | Sign-in providers, or `'open'` said deliberately |
| `bindings` | **required** | `env` → D1, Durable Objects, R2, Images |
| `types` | | Document types: pages, records, singletons |
| `basePath` | | Where the admin mounts. Default `/folio` |
| `route` | | Story path → public URL. You own the URL shape |
| `locales` | | Languages. Absent is a single-locale site |
| `globals` | | Singletons loaded into every page's resolution |
| `hooks` | | After-commit callbacks: publish, delete, form submitted |
| `gate` | | Members-only pages, against your membership system |
| `forms` | | Human verification and the submission rate limit |
| `describe` | | Machine-written alt text — your model call |
| `migrations` | | Content migrations, in run order |
| `draftMode` | | A promise that your route calls `reader.page()` |
| `mcp` | | `false` removes `{base}/mcp`. Default on |
| `assets`, `previewWrap`, `adminCss`, `previewCss` | | Preview and admin wiring |

**[`docs/configuration.md`](docs/configuration.md) is the full reference** —
every key with its default, its failure mode, and what happens when you leave
it out. It also covers the `wrangler.jsonc` bindings, the Vite plugin options,
and the two things (a seeded admin user, a cron trigger) that nothing will
remind you about.

Most misconfiguration is refused at construction rather than at request time. A
gate on a translatable field, a locale fallback cycle, a typo in `hooks`, a
migration list whose declared order and sort order disagree: all of them throw
when `createFolio` runs, because a configuration mistake in a CMS should not
become a 500 on whichever code path reaches it first.

---

## Documentation

| | |
| --- | --- |
| [`docs/handbook.md`](docs/handbook.md) | **Every feature**, what it is for and why it is shaped that way. The long one. |
| [`docs/configuration.md`](docs/configuration.md) | Every `createFolio()` key, binding, and Vite option. |
| [`AGENTS.md`](AGENTS.md) | Adding Folio to a project: order of operations, and the traps that read as library bugs. Written for a coding agent. |
| [`UPGRADING.md`](UPGRADING.md) | Bumping the pin, applying schema migrations, and what each one needs. |
| [`docs/api.md`](docs/api.md) | The `{base}/api/v1` contract. |
| [`docs/mcp.md`](docs/mcp.md) | Pointing an assistant at a running site. |
| [`examples/starter`](examples/starter) | The project `folio init` scaffolds. Small and real. |
| [`examples/demo`](examples/demo) | Everything at once: locales, records, gating, forms, search. |
| [`docs/specs/`](docs/specs) | One spec per feature, each recording the alternative its design beat. |
| [`ROADMAP.md`](ROADMAP.md) | What is deferred, and why. |

Working **on** Folio rather than with it? [`CLAUDE.md`](CLAUDE.md) is the
contributor's guide: the gates, the end-to-end scripts, and the invariants that
are easy to break by accident.

---

## Versioning

There is no npm package and no tag. **A full 40-character SHA is the version:**

```
npm install github:brendanmckenzie/folio#<full-sha>
```

A pinned SHA keeps resolving as long as it stays reachable from a pushed ref, so
an upgrade is something you opt into rather than something that happens to you.
Never pin a branch or a short SHA — both resolve differently later.

[`UPGRADING.md`](UPGRADING.md) is the procedure, including the one step that
bites everybody: `rm -rf node_modules/folio` before reinstalling, or npm skips
the package's build and leaves you with no `dist/`.

## Status

One site runs on Folio in production today — plus its staging deployment —
pinned to a SHA, with real editors and real content. It is not on npm, has no
version number, and the name is still a placeholder, so read "production" as
"the author's own client work" rather than "battle-tested by strangers".

Breaking changes are made when a design turns out to be wrong, and land as a
line in a consumer's upgrade commit rather than a deprecation cycle.

MIT licensed.
