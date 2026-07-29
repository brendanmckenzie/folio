# Folio

A Cloudflare-native block CMS with a Storyblok-style visual editor, built as a
library rather than an application.

Proof of concept. Name is a placeholder.

## What it borrows

| From | What |
| --- | --- |
| Storyblok | Nested blocks, click-a-block-in-the-page-to-edit-it, draft/published split |
| Payload | Schema as code, colocated with the component |
| Linear | Local-first mutation log: optimistic apply, delta sync, undo, multiplayer |
| EmDash | Cloudflare-only target: Workers, D1, Durable Objects |

## The integration surface

Folio is not the running application. A host project owns its Worker, its
routing and its public pages; Folio owns the editor, the sync engine and the
preview render. Three touch points:

**1. Define blocks.** Schema and renderer in one file, so the admin form, the
prop types and the HTML cannot drift.

```tsx
// src/blocks/hero.tsx
import { defineBlock, blocks, select, text } from 'folio/core'

export const hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  summary: 'heading',
  fields: {
    heading: text({ required: true }),
    align: select({
      options: [{ label: 'Left', value: 'left' }, { label: 'Centre', value: 'center' }],
      default: 'center', // a new hero starts centred, not on the first option by accident
    }),
    actions: blocks({ allow: ['button'], max: 2 }),
  },
  // `align` is typed 'left' | 'center'; `actions` arrives already rendered.
  render: ({ heading, align, actions }) => (
    <section className={`hero hero--${align}`}>
      <h1>{heading}</h1>
      <div>{actions}</div>
    </section>
  ),
})
```

**2. Mount it in your Worker.**

```tsx
import { createFolio, Shell } from 'folio/server'
import { blocks } from './blocks'

export { StoryDO } from 'folio/server'

const folio = createFolio<Env>({
  blocks,
  root: 'page',
  bindings: (env) => ({ db: env.DB, story: env.STORY }),
  assets: __FOLIO_ASSETS__,
})

export default {
  async fetch(req, env, ctx) {
    // Your own routes win: put them before folio.handle().
    if (url.pathname === '/health') return Response.json({ ok: true })

    // Returns null for anything Folio does not own, including a preview
    // request for a path with no story behind it. No blocklist required.
    const handled = await folio.handle(req, env, ctx)
    if (handled) return handled

    // Published pages look however you want them to. `resolve` supplies the
    // context a document deliberately lacks — story ids to current URLs.
    const doc = await folio.published(env, path)
    if (!doc) {
      // A rename or move recorded a redirect for the path just vacated;
      // folio.redirect is the one indexed read that answers it. Checked only
      // once folio.published has already said null, so a live page always
      // wins — Folio never intercepts inside handle() either.
      const hit = await folio.redirect(env, path)
      if (hit) {
        const location = new URL(hit.to, url.origin)
        location.search = url.search // query strings survive a redirect
        return Response.redirect(location.toString(), hit.status)
      }
      // folio.status tells apart a page taken down on purpose from one that
      // never existed, so a host can answer 410 for the former and 404 for
      // the latter instead of guessing. Folio itself never assumes either.
      const status = await folio.status(env, path)
      return new Response('Not found', { status: status === 'unpublished' ? 410 : 404 })
    }
    const resolution = await folio.resolve(env, doc)
    return render(<Shell title={title}>{folio.render(doc, { resolution })}</Shell>)
  },
}
```

**3. Add the Vite plugin.**

```ts
plugins: [react(), folio({ blocks: './src/blocks/index.ts' }), cloudflare()]
```

### Why this works

`defineBlock` holds two separable things: `fields` (pure data) and `render`
(code). The editor UI is driven entirely by `fields`.

So **the admin never sees your components.** It ships prebuilt inside the
package and fetches `/folio/schema` at runtime. Your block code never enters
that bundle, and you never rebuild the admin.

Only two surfaces need real components, and both are already your build:

- the **Worker**, which SSRs pages, and
- the **preview client**, which re-renders on every mutation.

The Vite plugin generates the preview entry as a virtual module that imports
your block registry, and adds the library's prebuilt admin to your client build.

### Conditional fields

A field can hide its *input* until a sibling field says otherwise, so a `hero`
with a `layout` select and four fields that only apply when `layout ===
'split'` can be one block instead of three:

```tsx
fields: {
  layout: select({ options: [{ label: 'Full', value: 'full' }, { label: 'Split', value: 'split' }] }),
  image: asset({ showIf: { field: 'layout', eq: 'split' } }),
  imageAlt: text({ showIf: { all: [{ field: 'layout', eq: 'split' }, { field: 'image', isSet: true }] } }),
  legacyId: text({ hidden: true }), // superseded field, kept only so a later migration can read it
}
```

`showIf` takes a small condition object — `eq`/`ne`/`in`/`isSet` plus
`all`/`any`/`not` — evaluated against the same block's own data, never a parent
block or another document. Conditions are data, not functions: the admin ships
prebuilt and learns your schema by fetching `/folio/schema`, and a function
cannot survive that trip. `hidden: true` is shorthand for a field that never
shows regardless of any condition.

Hiding a field hides the input, never the value: the stored value persists and
still renders exactly as a visible field's does, so toggling a select back and
forth loses nothing, and a block that wants different *output* per layout
still decides that in `render`.

`matches` is exported from `folio/core`, so `render` can reuse the identical
condition instead of restating it in JavaScript and risking the two drifting
apart:

```tsx
import { matches } from 'folio/core'

render: ({ layout, image }) =>
  matches({ field: 'layout', eq: 'split' }, { layout }) ? <img src={image?.url} alt="" /> : null
```

### Field defaults and presets

A new block starts as its kind's zero value — `''`, `0`, the first select
option — unless a field says otherwise:

```tsx
fields: {
  label: text({ default: 'Read more' }),
  variant: select({ options: [{ label: 'Primary', value: 'primary' }, { label: 'Ghost', value: 'ghost' }], default: 'ghost' }),
}
```

`default` is written once, when the block is created, never at render: adding
one to a field does not change what an already-published page says, because
nothing re-reads the schema for a document that already exists. Backfilling
existing documents is a content migration (`field.default(blok, name, value)`),
not this.

A **preset** is a named, reusable variant — field values layered over the
field defaults, optionally with children of its own:

```tsx
export const hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  fields: {
    heading: text(),
    theme: select({ options: THEMES, default: 'light' }),
    actions: blocks({ allow: ['button'], max: 2 }),
  },
  presets: [
    { name: 'dark', label: 'Hero — dark', data: { theme: 'dark' } },
    {
      name: 'cta',
      label: 'Hero — with button',
      children: [{ slot: 'actions', type: 'button', preset: 'primary' }],
    },
  ],
  render: /* … */,
})
```

Picking "Hero — with button" in the add menu inserts the hero *and* the
button as one transaction — one undo step, one delta, one activity entry. A
preset naming an unknown type, an unknown slot, a type its slot's `allow`
forbids, or a field the block does not declare fails at startup, not from
inside a request. `presetsOnly: true` hides a block's bare version from the
add menu, for a block that must always be one of its named variants.

A document's starting content is nothing new: it is the root block's own
preset named `'default'`. A root block with no such preset seeds a bare root,
exactly as before this feature existed.

### Duplicate and paste

Every block-level copy is `insert` mutations through the ordinary store, so it
is one transaction: one undo step, one delta, one activity entry, whatever
sync, undo and multiplayer already give any other edit. Duplicating a block
clones its whole subtree with fresh uids, dropped in right after the
original:

```tsx
onDuplicate={(uid) => blocks.duplicate(uid)}
```

Copy (`Cmd+C`, or a menu action) writes a small self-describing JSON payload
to the system clipboard — `{ folio: 1, bloks, from }` — with
`navigator.clipboard.writeText`. Paste (`Cmd+V`) reads the browser's own
`paste` event instead of asking for clipboard-read permission, and validates
before building a single mutation: the payload's shape, every block's type
against the schema, and every child's type against its actual parent's
declared slot. Uids are always re-allocated, so pasting the same clipboard
twice inserts two independent copies, and a payload from another site or an
older schema is refused with a message naming what was wrong rather than
silently doing nothing.

Duplicating a whole document works the same way one level up: `POST
/folio/stories/:id/duplicate` clones the *draft* (what the editor is actually
looking at, unpublished changes included), re-allocates every uid, and seeds a
brand-new story — unpublished, with no version history of its own. The
source page is never touched.

## Stories, paths and page metadata

A story is keyed by an opaque, stable `id`, which is also its Durable Object
name — so renaming or moving a page never orphans its draft or mutation log.
`path` is derived from the ancestor chain and recomputed for the whole subtree
on rename or move. The root story has `path = ''` and serves `/`, so there is no
`home` special-case anywhere.

D1 holds only routing structure: `id`, `parent_id`, `slug`, `path`, `ord`.

**Page metadata lives in the document, not the database.** `title`,
`description`, `socialImage`, `noindex` are ordinary fields on the root block,
selectable in the tree as "Page settings". That means editing them is the same
inspector as everything else, and they inherit multiplayer, undo, versioning and
atomic publish for free. `title` is denormalised into D1 purely so the tree can
render without loading every Durable Object; the document is the source of
truth.

Sibling order is a fractional index, the same primitive used for blocks.

Slug and parent are edited in the **Address** panel that appears at the top of
the inspector when "Page settings" is selected. Pages can also be reparented and
reordered by dragging in the Content tree. Switching pages is client-side, so
the rail keeps its tab and there is no reload.

## How editing works

An edit is never a form save. It is a mutation against a normalized document:

```
{ root: 'u0', bloks: { u0: { type: 'page', … }, u1: { type: 'hero', parent: 'u0', slot: 'body', order: 'a1', data: {…} } } }
```

```
keystroke
  → apply locally (store + preview iframe, same reducer, no network)
  → send to the story's Durable Object over WebSocket
      → append to mutation log, update draft
      → broadcast delta to every other editor
      → echo to sender as the acknowledgement
```

Consequences that fall out of the model rather than being built:

- **Preview updates per keystroke.** The iframe holds the same document and the
  same reducer; the admin posts mutations to it. Zero network in the loop.
- **Undo/redo** is `invertAll()` against pre-apply state, replayed as a new
  transaction. Typing on one field coalesces into a single undo entry.
- **Multiplayer** is the same broadcast, including per-block presence dots.
- **Reconnect** sends a `lastSyncId` watermark and gets only the deltas it
  missed, falling back to a full bootstrap past 200.
- **Reordering never conflicts.** Position is a fractional index, so a move
  writes one field instead of renumbering an array.

Published pages read a snapshot from D1 and **ship no JavaScript at all** —
hydration is a preview-mode concern.

Blocks get their `data-folio-uid` marker injected by the renderer via
`cloneElement`, so unlike Storyblok's `{...storyblokEditable(blok)}` a block
author cannot forget to make one editable.

## Links

A `multilink` field points at one of four things: another story, an external URL,
an email address, or an anchor on the current page.

A story link stores `{ kind: 'story', id }` and nothing else. It never stores a
path, because paths are derived from the ancestor chain and recomputed for the
whole subtree on rename or move — a link that captured a path would rot silently
the first time someone reorganised the tree. Storyblok stores `cached_url` and
has exactly that problem.

So a link is resolved at render time, and a block author receives it already
resolved:

```tsx
fields: { href: multilink({ label: 'Link' }) },
render: ({ href }) => <a href={href?.href ?? '#'} target={href?.target} rel={href?.rel} />
```

`rel="noopener noreferrer"` is filled in whenever `target` is `_blank`, so a
block cannot forget it. A link whose story has since been deleted arrives with
`broken: true` rather than vanishing, so the mistake is visible.

Resolution comes from a **`Resolution`**: a plain map of story id to current URL,
passed to the renderer alongside the document. It exists because the preview
re-renders in the browser on every keystroke with no network in the loop, so
resolution can never be a per-render fetch. Both sides build it from data they
already hold — D1 on the server, and in the admin the story tree it has already
loaded, so links cost no extra requests. It is rebuilt only when structure
changes, which is exactly when a URL can have moved.

## Assets

`asset` and `multiasset` upload into an R2 bucket through the Worker, and record
a row in a media library table so a file can be reused rather than re-uploaded.

Uploads are proxied rather than presigned. `env.MEDIA.put(key, body)` needs no
credentials and no S3-compatible endpoint, so it works against `wrangler dev`'s
local R2 with nothing configured. Presigning is a later optimisation that would
not change a single stored value.

**Alt text and the focal point are stored per usage, not per file.** The library
row holds a default that is copied in when you pick something, and after that the
two are independent — the same photograph is a portrait in one place and a
background texture in another, and it needs different alt text in each.

The focal point is normalised 0..1 from the top-left, so it survives any resize.
A block gets it two ways:

```tsx
render: ({ file }) => (
  <img
    src={file.srcFor({ width: 1440, fit: 'cover' })}
    width={file.width}                          // known, so the page reserves space
    height={file.height}
    alt={file.alt}
    style={{ objectPosition: file.objectPosition }}
  />
)
```

Dimensions are read out of the file header on upload (PNG, JPEG, GIF, WebP), so
they are recorded whether or not an Images binding is configured.

### Resizing

`srcFor()` builds a URL against Folio's own `/folio/asset/:key` route, which does
the transform with the **`IMAGES` binding**. That route is the only place that
knows how resizing is done, so a stored value never names a resizing service and
a document written against a `workers.dev` preview renders identically on a zone.

`/cdn-cgi/image/` was the other candidate and is zone-gated, but note that the
`fetch(url, { cf: { image } })` form is *not*: it works on `workers.dev` and is
mocked by `wrangler dev`. It was passed over only because it requires the Worker
to fetch its own asset URL, which needs a `Via: image-resizing` loop guard, while
the binding takes the R2 stream directly.

With no `images` binding, assets serve at their original size. A transform that
fails, or that returns an empty body, also falls back to the original — a broken
image is a worse outcome than an unoptimised one.

## Richtext

`richtext` stores a TipTap (ProseMirror) document as the field's JSON value, and
**the renderer never imports TipTap**. The editor is an admin-bundle concern; a
published page walks the JSON on the server and still ships no JavaScript. That
separation is easy to undo by accident, which is why the build is checked for it.

A whole tree is one field value, so two people editing the same richtext field is
last-write-wins — exactly what a `text` field already does. Storyblok behaves the
same way. Decomposing prose into the blok graph would give finer-grained merging
but means translating ProseMirror transactions into mutations, which is
`y-prosemirror` rewritten from scratch. The cost worth knowing: a `set` carries
the whole tree, so a ~1000-word article logs about 12 kB per keystroke.

Like a `blocks` field, richtext **arrives already rendered**, so there is no way
to reach the page without going through sanitising and link resolution:

```tsx
fields: { body: richtext({ headingLevels: [2, 3] }) },
render: ({ body }) => <div className="prose">{body}</div>
```

### Constraining a field

`marks` and `nodes` narrow what a field permits, and both the editor and the
renderer enforce it:

```tsx
quote: richtext({ marks: ['bold', 'italic', 'link'], nodes: ['paragraph'] })
```

The toolbar shrinks to match. More usefully, the editor's ProseMirror schema is
built from the same list, and ProseMirror will not hold a node its schema does not
define — so **pasting formatted HTML is cleaned up on the way in** rather than
afterwards. The renderer sanitises again, because content can also arrive from an
importer or straight over the API, and a caption that renders an `<h1>` because
something bypassed the editor is exactly the sort of quiet breakage worth
preventing.

Dropping a node unwraps it rather than deleting it, so the words survive: a pasted
heading becomes a paragraph instead of a hole.

Links inside prose store a `LinkValue`, the same shape a `multilink` field uses,
so an internal link in the middle of a sentence survives the page it points at
being renamed. TipTap's own Link extension stores a bare `href`, which is the
failure this whole design avoids — so Folio replaces it.

A plain string is accepted as a value and split into paragraphs on blank lines,
which keeps content written against the old `textarea` placeholder rendering.

## References

`reference` points at another story and resolves its content at render time.

```tsx
fields: { source: reference({ label: 'Page to embed' }) },
render: ({ source }) =>
  source ? <div>{source.content}</div> : null   // or read source.data yourself
```

Storyblok needs `resolve_relations: 'Form Selection.form'` passed at the fetch
call, which is a thing you can forget. Folio derives the id set from the schema,
so a page with no references costs no extra reads and one with references needs no
per-call configuration.

**Preview resolves drafts; a live page resolves published content.** An editor
previewing a page that embeds a form sees the form as they just edited it, while
the public page never shows another story's unpublished work. A target with
nothing published resolves to nothing, and the block renders its own empty state.

Resolution is bounded to one level, which is both what Storyblok does and what
stops a story that references itself from rendering until the stack runs out.

In the admin, referenced documents are fetched when the *set* of referenced ids
changes — never per render, because the preview re-renders on every keystroke with
no network in the loop. Selecting a story that is already loaded costs nothing.

## Layout

```
packages/folio/
  src/core/      document model, mutations, field builders, schema  (isomorphic)
  src/server/    createFolio, StoryDO, SSR
  src/preview/   renderer + the client that hydrates a previewed page
  src/admin/     the editor SPA (prebuilt, schema-driven)
  src/vite/      the plugin
  migrations/    the D1 schema, as ordered migrations
examples/demo/   a consuming project
```

## Running it

```bash
pnpm install
cd examples/demo
pnpm db:local    # wrangler d1 migrations apply folio --local
pnpm db:seed     # a root story and one nested page, so the editor has somewhere to open
pnpm dev
```

Two steps, because the schema and the content are not the same thing.
`packages/folio/migrations/` is the schema, and a consuming project points
`migrations_dir` at it (see the demo's `wrangler.jsonc`) so it shares one
migration history with the package. `wrangler d1 migrations apply` records what
it ran, so it is re-runnable and never drops a table. Deploying is the same
command with `--remote`: `pnpm db:remote`.

`seed.sql` is local-dev convenience only, with fixed ids and no `on conflict`, so
run it once and never against a real deployment. `node scripts/seed-demo.mjs`
adds the field-type showcase through the running dev server's API afterwards, and
is safe to rerun because it creates its own stories.

If you have a database from before migrations existed — created by the old
`packages/folio/schema.sql` — it has no `d1_migrations` table, so the first apply
runs the whole history against it. `0001_initial.sql` is written to adopt exactly
that database untouched; `0002_slug_unique.sql` adds a unique index over sibling
slugs and will refuse a database that already contains a duplicate pair (its own
comment has the query that finds them). Locally, deleting `.wrangler/state` and
starting from `pnpm db:local` is the shorter route.

- `/folio/edit` the editor (redirects to the root story)
- `/` the root story's published page — 404 until you hit Publish
- `/about/team` a nested page, same rule: published only after you publish it

Open the editor in two windows to see multiplayer.

R2 and Images need no setup locally: `wrangler dev` simulates the bucket, and
without an Images binding assets simply serve at their original size.

Before deploying, run `wrangler d1 create folio` and put the real id in
`wrangler.jsonc`, then `pnpm db:remote` to apply the migrations against it, and
`wrangler r2 bucket create folio-media` for uploads. Note that
`new_sqlite_classes` cannot be changed for an already-deployed Durable Object
class.

## History

The **History** tab lists versions and recent activity.

A **version** is coarse and meaningful: every publish writes one, and editors can
name a checkpoint at any time. They live in D1, so listing them is a cheap query
that does not touch the Durable Object.

**Unpublish is publish's pair, not delete's.** It clears `published_doc` and
`published_at` — the entire liveness switch — and leaves the draft, the version
history and the Durable Object untouched, so taking a page down costs nothing
you cannot get back with one more click of Publish. There is no cascade: paths
are independent, so `/about/team` keeps serving whether or not `/about` does,
and the confirmation names the descendants that stay live rather than
surprising anyone. It is idempotent, because taking a page down is exactly the
kind of action someone double-clicks. `folio.status(env, path)` (see "Mount it
in your Worker" above) lets a host tell a page taken down on purpose apart from
one that never existed, and answer `410 Gone` instead of guessing at `404`.

**Activity** is the fine-grained trail, read from the DO's mutation log and
summarised ("Changed Hero · Heading +2 more"). Useful for finding who changed
something; not useful for restoring, which is why the two are separate. The log
is per-transaction, so a few minutes of typing is hundreds of entries.

**Versions can be previewed read-only** before restoring. Choosing *View* pushes
that version's document into the preview iframe without touching the store; live
edits stop being forwarded so they cannot corrupt what is on screen, the inspector
goes read-only, and Publish is disabled. The banner reports how the version
differs from the current draft. Restore is only reachable from that banner, so a
version is always seen before it is applied.

**Restore does not overwrite the document.** It diffs the live document against
the version and applies the result as one ordinary transaction:

```
diff(live, target) -> Mutation[]  -> store.tx(mutations)
```

So a restore reaches other editors, lands in the activity trail, and Cmd+Z undoes
it. Reverting a title change plus one added block produces exactly two mutations.

## Redirects

**Internal links never need a redirect.** A link stores the story's `id`, not its
path, so renaming or moving the page it points at is fixed for every link the
moment `resolve` runs — there is nothing to redirect *to*, because nothing broke.
Redirects exist for the links Folio does not own: bookmarks, a search index, a
newsletter that already went out, a partner site linking to `/services/strategy`.

`updateStory` already computes every old path and its replacement in one batch, at
the exact moment the change is true, so capturing a redirect there is nearly free.
Renaming or moving a page writes a `301` for every path it vacates; deleting one
offers a redirect to its parent, checked by default in the confirmation. Chains are
collapsed at write time — renaming `a` to `b` and then `b` to `c` repoints the `a`
row straight at `c` — so a lookup is always one indexed read and a loop is
unrepresentable. Editors can also add a redirect by hand, for a URL that never
existed in Folio at all (a print campaign, a legacy CMS); the **Redirects** tab
lists both kinds, filterable by source, with add and delete.

Folio never intercepts a redirect inside `handle()` — that would shadow a host
route that legitimately lives at the same path now. Instead the host asks:
`folio.redirect(env, path)` returns `{ to, status } | null`, checked only once
`folio.published` has already answered null, so a live page always wins (creating
a story at a redirected path deletes the row anyway). See "Mount it in your
Worker" above for the three lines this takes, and note that `to` is only ever a
path or an absolute URL that has passed `isSafeHref` — safe to hand straight to a
`Location` header.

## Verified

`scripts/sync-test.mjs` (16 checks) exercises the engine against both `vite dev`
and the production build: bootstrap, cross-client delta, self-ack, presence,
draft persistence, watermark catchup, that a client-side `cloneSubtree` duplicate
arrives at another connected client as one transaction and both converge, publish,
and that a published page contains no `<script>`.

`scripts/history-test.mjs` (19 checks) covers versioning: checkpoints, publish
writing a version, list ordering, that the list omits document payloads, that a
restore diff is minimal, that restoring leaves the published page untouched until
re-published, diff round-tripping, and the activity trail.

`scripts/fields-test.mjs` (75 checks) covers the richer field types: link
resolution for every kind, upload and header dimension sniffing, serving and
resizing, focal points, per-usage alt text, richtext rendering and per-field
constraints, reference resolution in both draft and published modes, tolerance of
values written before these fields existed, and that nested field objects diff
correctly. Two are load-bearing:

- renaming a page updates every link pointing at it — including links inside
  richtext — while leaving the linking documents byte-for-byte unchanged, and
- a story that references itself renders once rather than forever.

All three run against a live dev server on port 5199, and against the production
build via `vite preview`.

## Content tree

Not built. The structure is flat: one row per story, keyed by slug.

It is, however, deliberately not blocked. Slugs are path-shaped and every layer
already handles multiple segments, verified end to end for `about/team`:
editor, preview, publish and the published page. Durable Object identity is
`idFromName(slug)`, so nesting needs no change to sync or storage.

Adding an Umbraco/Sitecore-style tree therefore means adding metadata and UI,
not migrating the document model:

- `parent_slug` and a fractional `order` column on `stories` (the same ordering
  primitive already used for blocks, so sibling reordering is one write)
- a tree pane in the admin beside the existing block tree
- move/rename cascade, which is the one genuinely fiddly part, since renaming a
  branch rewrites descendant slugs and therefore their DO names

## Not built yet

Auth (there is none — anyone can edit), i18n, custom field types defined by a host
project, and a real package build (the library currently ships TypeScript source
and the host compiles it).

Within the field types: no tables in richtext, no text colour mark, and no
embedded bloks inside richtext. Host projects cannot override how a richtext node
renders, which is fine while the output is semantic HTML that CSS can style, and
will need revisiting when it is not. `reference` cannot filter candidates by
document type, because there is only one document type so far.

Note also that `vite preview` does not proxy the browser's WebSocket upgrade, so
the admin only connects under `vite dev` or a real deploy. The test scripts use a
Node client and pass against both.
