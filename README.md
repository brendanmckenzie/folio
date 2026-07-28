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
    align: select({ options: [{ label: 'Left', value: 'left' }, { label: 'Centre', value: 'center' }] }),
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
examples/demo/   a consuming project
```

## Running it

```bash
pnpm install
cd examples/demo
pnpm exec wrangler d1 execute folio --local --file=../../packages/folio/schema.sql
pnpm dev
```

- `/` index of stories
- `/folio/edit/home` the editor
- `/home` the published page (after you hit Publish)

Open the editor in two windows to see multiplayer.

R2 and Images need no setup locally: `wrangler dev` simulates the bucket, and
without an Images binding assets simply serve at their original size.

Before deploying, run `wrangler d1 create folio` and put the real id in
`wrangler.jsonc`, and `wrangler r2 bucket create folio-media` for uploads. Note
that `new_sqlite_classes` cannot be changed for an already-deployed Durable Object
class.

## History

The **History** tab lists versions and recent activity.

A **version** is coarse and meaningful: every publish writes one, and editors can
name a checkpoint at any time. They live in D1, so listing them is a cheap query
that does not touch the Durable Object.

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

## Verified

`scripts/sync-test.mjs` (12 checks) exercises the engine against both `vite dev`
and the production build: bootstrap, cross-client delta, self-ack, presence,
draft persistence, watermark catchup, publish, and that a published page contains
no `<script>`.

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
