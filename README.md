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
  // Every shape of document this site has. `root: 'page'` is sugar for exactly
  // the first entry and still works; see "Document types" below.
  types: [
    { name: 'page', label: 'Page', kind: 'page', root: 'page' },
    { name: 'person', label: 'Person', kind: 'record', root: 'personRecord', titleField: 'fullName' },
    { name: 'settings', label: 'Site settings', kind: 'singleton', root: 'settingsRoot' },
  ],
  // Loaded into every page's Resolution, so any render can place them. See
  // "Globals" below.
  globals: ['settings'],
  // The languages this site is available in, or omit for one language. `default`
  // is the *source* locale. See "Localisation" below.
  locales: { default: 'en', available: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }] },
  // The public URL for a story path, and the only place a locale reaches a URL:
  // Folio owns no URL shape, so a prefix, a subdomain or `?lang=` are all yours.
  route: (path, locale) => `${locale && locale !== 'en' ? `/${locale}` : ''}${path ? `/${path}` : '/'}`,
  bindings: (env) => ({ db: env.DB, story: env.STORY }),
  // Required, with no default. Either name sign-in providers or say 'open' —
  // there is no third option, because a host that forgets this key would
  // otherwise be serving a publicly editable CMS. See "Auth" below.
  auth: 'open',
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
    // Your own `route` above decides how a locale is encoded, so reading it back
    // out is yours too. Paths are locale-independent: /about and /fr/about are
    // the same story. Passing the locale here refuses one you never declared.
    const { locale, path } = parseLocale(url.pathname)
    const doc = await folio.published(env, path, locale)
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
    // The locale rides on the resolution, which is what makes the whole render
    // French: every field read goes through it, falling back to the source
    // wherever a field is untranslated.
    const resolution = await folio.resolve(env, doc, { locale })
    return render(
      <Shell title={title}>
        {folio.renderGlobal(resolution, 'settings')}
        {folio.render(doc, { resolution })}
      </Shell>,
    )
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

## Document types

A document is not necessarily a page. `types` declares each shape one, with its
own root block and therefore its own fields — an insight is not a page with six
unused fields and a comment explaining which ones matter.

`kind` is the whole routing story:

| kind | routable | in the page tree | how many | example |
| --- | --- | --- | --- | --- |
| `page` | yes | yes, with `parent_id`/`path` | many | Page, Insight |
| `record` | no | no (both columns null) | many | Person, Office |
| `singleton` | no | no | exactly one | Site settings, Header |

An **unrouted** document (a record or a singleton) leaves the page tree
entirely: `parent_id` and `path` are both null, and it is ordered by `ord`
within its own type. That is what stops a record called "Contact" taking
`/contact` away from the page that needs it — the two are in different slug
namespaces, so the collision is not merely resolved, it is unrepresentable. A
record's slug is unique *per type* instead, because the content API needs a
stable machine-readable handle for it.

There are **no per-type routing rules**. Folio derives a path from the tree, so
an insight created under the "Insights" page already serves at
`/insights/whatever` with nothing to configure.

A **singleton**'s id is derived from its type name (`sng_settings`), which is
the entire uniqueness mechanism: there is no other id a second one could be
created under. It is created on first *access* — the admin's Data rail asking
for it — never by an editor, because it exists because the schema says so, and
deleting it would only mean it comes back empty. `DELETE` and `duplicate` both
refuse it.

Optional keys on a type:

- `titleField` — which root field is the display title, cached into
  `stories.title` on publish. Defaults to `title` when the root block has one,
  then to the root block's `summary` field. A `person` whose root has
  `fullName` and no `title` needs this, or the tree would cache nothing.
- `under` — the parent types a document of this type may live under. Constrains
  creation *and* drag targets, with a refusal notice rather than a silent
  no-op. Declaring it also means the type can never sit at the top level.
- `default` — the type a bare "New page" creates. Implicitly the first `page`
  type.

`reference` and `multilink` can both be narrowed by type:

```ts
person: reference({ types: ['person'] })       // only Person records are offered
href: multilink({ types: ['page'] })           // only Pages, and never a record
```

Enforced twice, the same discipline `richtext`'s `marks` follow: the admin's
picker only offers matching documents, *and* resolution re-checks, because
content also arrives from importers and over the API. A `reference` of the wrong
type resolves to `null` and the block renders its empty state; a `multilink`
pointing at an unrouted or wrong-type document resolves to
`{ broken: true, href: '#' }`, because "there is no URL for this" and "this URL
is gone" are the same problem for an editor.

Routes: `GET /folio/stories` is the page tree (page types only), `GET
/folio/documents?type=person` is the flat per-type list, and `GET
/folio/documents` returns every unrouted document — which is also what brings
each declared singleton into being. `POST /folio/stories` takes a `type`;
an undeclared one answers `501 unsupported`, because the request is
well-formed and the server simply has no such type. Changing a document's type
is refused: that is a schema migration, not a patch.

A row whose `type` is no longer declared in code is not an error. The tree
shows it with an "Unknown type" chip and the Data rail gives it its own
heading — deleting rows because the code changed is worse.

`createFolio` validates all of this at construction, before a request is
served: an unknown root block, a duplicate name, two defaults, a `titleField`
the root block lacks, an `under` chain that never reaches the top level, or both
`types` and `root` at once.

## Globals

A header, a footer, a bag of site-wide settings: content that is on every
page but is not itself a page. A global is a `singleton` document — nothing
new — plus a way for a host's shell to render one and a way to edit one when
it has no page of its own to be previewed in.

```ts
const folio = createFolio<Env>({
  types: [
    { name: 'page', label: 'Page', kind: 'page', root: 'page' },
    { name: 'header', label: 'Header', kind: 'singleton', root: 'headerRoot',
      previewPath: '' },   // the root story, so an edit previews in context
    { name: 'footer', label: 'Footer', kind: 'singleton', root: 'footerRoot' },
  ],
  // Loaded into every page's Resolution — a subset of the declared
  // singletons, explicit rather than "every one of them", so a singleton
  // read once at boot (folio.global) costs nothing on the hot path.
  globals: ['header', 'footer'],
})
```

`resolve()` folds each configured global's id into the same query
`reference` fields already run, so a site with globals costs no extra D1
read. The result rides on `Resolution.globals`, keyed by *type name* rather
than story id, next to (never merged into) `Resolution.docs`: `RenderBlok`'s
one-level bound empties `docs` on the way into a reference's own content so
a self-referencing story cannot recurse forever, but a header rendered
inside a referenced document still needs its own content.

The host places a global in its own shell — Folio never wraps a page in a
layout:

```tsx
<Shell>
  {folio.renderGlobal(resolution, 'header')}
  <div id="folio-root">{folio.render(doc, { resolution })}</div>
  {folio.renderGlobal(resolution, 'footer')}
</Shell>
```

`renderGlobal` returns the same `<div data-folio-global="header">` wrapper
in every mode — a published page, an ordinary page preview, or the
in-context editor below — so a client hydrating into it never meets a
markup mismatch. A global nothing has been published for renders nothing,
with no error. `folio.global(env, name)` is the plain server-side read: a
singleton's published document by name, whether or not it is a configured
global — for a "read once at boot" singleton that has no business in a
per-request resolution.

A singleton has no URL of its own to be previewed at, so its type declares
`previewPath` — a routed document's own path (`''` for the root story) — and
opening the singleton in the admin loads that page's own preview with
`&as=<name>` appended. The named global becomes the one editable document on
screen, hydrated into its own wrapper; the page around it stays static and
is not clickable. Every other configured global still renders read-only,
with the ordinary edit markers, so clicking a block inside one from an
ordinary page preview offers "Edit `<name>` →" instead of selecting it —
there is exactly one editable document at a time. A singleton with no
`previewPath` gets a bare preview instead: itself, alone, with a note that
no host page was configured.

A global is a document like any other: it drafts, versions, undoes and
publishes the same way, through the same inspector. What it does not do is
string interpolation — `{{ settings.phone }}` inside a text field is out of
scope; a block that needs the phone number reads it off the settings global
directly.

## Localisation

One document per story holds **every language**. A translatable field's source
value lives in `Blok.data` exactly where it always did; a translation is an entry
in `Blok.i18n[code]`:

```ts
{ uid: 'hero1', type: 'hero', /* … */
  data: { heading: 'Hello', sub: 'World' },
  i18n: { fr: { heading: 'Bonjour' } } }
```

The reason for that shape rather than a story row per language: **a translation is
an ordinary `set` mutation with a locale on it.** So translations inherit
multiplayer, undo, versioning, the activity trail, atomic publish and
per-keystroke preview without one new mechanism. Two translators working in
different languages on the same page never conflict, because they are writing
different keys of the same blok.

The cost is stated plainly: a translator cannot restructure a page. Adding a block
adds it to every language. That is the same trade Storyblok's field-level
translation makes, and for the same reason.

**Translatable is opt-in per field.** `text({ translatable: true })`. Most
`select`, `boolean`, `number` and `asset` fields should not diverge per language,
and a default of "everything is translatable" turns every schema into a
translation surface nobody asked for. The cost of opt-in is annotating existing
blocks, so `GET /folio/audit` reports the text-ish fields that are *not* marked —
the omissions are findable rather than invisible. `blocks` cannot be translatable
and does not compile if you try.

The renderer **does not check the flag**: if a value is in `i18n`, it wins. That
asymmetry is deliberate — the same one richtext already has, where the editor
constrains input and the renderer sanitises output — and it means un-marking a
field cannot silently hide content somebody already translated. The audit reports
that case too.

### Reading a value

```ts
import { fieldValue, dataOf } from 'folio/core'

fieldValue(blok, 'heading', resolution.locale) // one field, in the active language
dataOf(blok, resolution.locale)                // the whole blok's data, layered
```

Everything Folio renders goes through `fieldValue`, and it implements one rule in
one place: the first **defined and non-null** candidate wins — the active locale,
then each fallback in the chain, then the source. Which means:

| in `i18n[fr]`     | `/fr/about` renders | reads as     |
| ----------------- | ------------------- | ------------ |
| absent            | the source value    | untranslated |
| `'Bonjour'`       | `Bonjour`           | translated   |
| `''`              | *empty*             | translated   |
| `null`            | the source value    | untranslated |

`''` versus absent is what makes "clear this heading in French" expressible.
`null` is how *un*-translating is expressible at all, since the mutation
vocabulary has no delete-key — so writing `{ locale: 'fr', value: null }` is the
undo of a translation.

A locale may declare a `fallback` to try before the source, and a chain is
followed to its end. A cycle is refused at construction, along with a default that
is not in `available`, a duplicate code, and a fallback that does not exist.

### The locale in a URL

**Paths are locale-independent.** `/about` and `/fr/about` are the same story, one
row, one path, one Durable Object. Translated slugs are out of scope: they make
`path` per-locale, which forks the unique index, the `derivePaths` walk, the tree
and every link resolution.

**The host owns the URL shape**, because only the host knows how it encoded it:

```ts
route: (path, locale) => `${locale && locale !== 'en' ? `/${locale}` : ''}/${path}`
```

A prefix, a subdomain, `?lang=` — Folio only ever needs the *inverse*, for its own
preview branch, and derives that by calling your `route` rather than by assuming a
convention. So reading the locale back out of a request is host code:

```ts
const { locale, path } = parseLocale(url.pathname)   // yours, one line
const doc = await folio.published(env, path, locale) // refuses an undeclared code
const resolution = await folio.resolve(env, doc, { locale })
```

`published()` hands back the same document whatever the locale — there is only one
— and the locale rides on the `Resolution`, which keeps "which language" in
exactly one place instead of two. What the argument *does* do is refuse a locale
this site never declared, so `/xx/about` answers your own 404 rather than serving
English under a URL that means nothing.

`folio.stories(env)` gives each routed row a `urls` and a `previewUrls` map, one
entry per declared locale, built from your own `route` — so a sitemap covering
every language needs no second call and no knowledge of the shape.

### In the editor

A language switcher sits in the top bar. On the source locale the editor is
exactly what it was; on any other, each field is in one of two states:

- **translatable** — the input is bound to that locale's own *raw* value, so an
  untranslated field is empty rather than pre-filled with the source (a
  pre-filled input would copy the English into the French the moment somebody
  typed one character). The source appears beside it in a read-only column, with
  richtext rendered formatted, because that is what a translator is translating
  from.
- **shared** — the input is disabled and labelled *shared across all languages*.
  Nothing writes a locale-scoped value from there.

Switching language **reloads the preview iframe** at that locale's own preview
URL. The per-keystroke rule (no network in the loop) applies to *editing*, not to
switching language: the host's own chrome, its `<html lang>` and possibly its
stylesheet all change, and no postMessage reaches those.

### Publishing

**Publishing publishes every language at once.** One document, one `published_doc`,
one atomic snapshot. So a half-translated page goes live with fallbacks — which is
what Storyblok does under field-level translation, and is usually what you want,
since launching one language first is how most sites ship. The admin warns before
publishing when a locale is incomplete and *names what is missing*; a complete page
publishes on one click, because a confirmation that always appears is a
confirmation nobody reads.

`stories.title_i18n` caches translated titles so a translator's content tree is
not in English. Best-effort by definition: it is written by publish, so a French
title that exists only in the draft reads in the source language until the page
goes live. A stale entry costs a wrong label in a tree, never wrong content on a
page.

### Notes and limits

- **Bytes, not bloks.** Eight languages of a long richtext field is eight times
  the payload against `MAX_DOC_BYTES` (8 MB) with the same block count. One `set`
  is still one field value, so `MAX_FRAME_BYTES` is unaffected.
- **Removing a locale from config** leaves its values inert — nothing reads that
  code — and the audit reports them. Nothing strips them automatically, because a
  locale is at least as often removed by mistake as on purpose.
- **Adding one** needs no migration and no write: every field reads as
  untranslated and falls back.
- **Changing the source locale** is not a config edit. `data` holds the source
  values, so it means a content migration that swaps `data` with `i18n[new]`.
- **`GET {base}/story/:id/translation?locale=fr`** answers `{ total, translated,
  missing }` for one story, for a caller that wants the number without opening the
  document.

## Stories, paths and page metadata

A story is keyed by an opaque, stable `id`, which is also its Durable Object
name — so renaming or moving a page never orphans its draft or mutation log.
`path` is derived from the ancestor chain and recomputed for the whole subtree
on rename or move. The root story has `path = ''` and serves `/`, so there is no
`home` special-case anywhere.

D1 holds only routing structure: `id`, `type`, `parent_id`, `slug`, `path`,
`ord`.

D1 also holds each row's `type`, and `path` is null for an unrouted document
(see "Document types" above).

**Page metadata lives in the document, not the database.** `title`,
`description`, `socialImage`, `noindex` are ordinary fields on the root block,
selectable in the tree as "Page settings" — or "Person settings", since the
label comes from the root block's own. That means editing them is the same
inspector as everything else, and they inherit multiplayer, undo, versioning and
atomic publish for free. Which fields exist is per type, so a record's root
carries none of the four; `titleField` says which one the tree caches.
`title` is denormalised into D1 purely so the tree can render without loading
every Durable Object; the document is the source of truth.

Sibling order is a fractional index, the same primitive used for blocks.

Slug and parent are edited in the **Address** panel that appears at the top of
the inspector when "Page settings" is selected. Pages can also be reparented and
reordered by dragging in the Content tree, subject to `under`. Switching pages is
client-side, so the rail keeps its tab and there is no reload. An unrouted
document has no Address panel and no preview iframe: it has no URL, so there is
no page to show. Records and singletons live in the **Data** rail instead.

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

## Data documents

Some content is not a page and is not a block: a person, an office, a product
specification, a partner logo with a link and an alt text. It has fields, it is
edited by editors, it is referenced from many places, and it has **no layout of its
own**.

A `kind: 'record'` type (see *Document types* above) makes such a thing storable —
no route, out of the page tree. Two things make it usable.

### `render` is optional, and `defineRecord` says so

```tsx
export const officeRecord = defineRecord({
  name: 'officeRecord',
  label: 'Office',
  summary: 'city',
  fields: {
    city:    text({ required: true, indexed: true }),
    address: text(),
    phone:   text({ indexed: true }),
  },
  // No `render`. There is no layout for an office; every page shows one
  // differently.
})
```

`defineRecord` is `defineBlock` with a name that says what the definition is for —
`render` is optional on every `BlockDef` now, so there is no second definition kind
and no fork in the schema pipeline. A record root still flows through
`toSchemaIndex`, `blankBlok`, the manifest and the inspector unchanged.

A block with no renderer draws **nothing at all** on a published page and a neutral
`folio-unrendered` placeholder in the editor, naming the type. That is the same
posture as an unknown block type, and the same reason: an editor must be able to
see that something is there and not renderable, and a published page must never
show scaffolding.

A record **may** still have a renderer, and then it is what `reference.content`
renders. A "Person card" is genuinely useful — a block referencing a person drops
`{person.content}` and gets a consistent card wherever a person appears. A record
without one gives `content: null`, and blocks read `data`:

```tsx
render: ({ office }) =>
  office ? (
    <section>
      {office.content ?? <h3>{String(office.data.city)}</h3>}
    </section>
  ) : null
```

`content` is **literally null**, not an element that renders nothing, so that `??`
means what it looks like it means.

### `references()` — a hand-picked, ordered list

```tsx
fields: { team: references({ types: ['person'], min: 1, max: 6 }) },
render: ({ team }) => <ul>{team.map((p) => <li key={p.id}>{p.content}</li>)}</ul>
```

Stored as an array of story ids in the editor's chosen order. Resolves to
`ResolvedReference[]` — the same shape `reference` hands back, one per entry — so a
block author who can render a reference can render a list of them.

**An unresolvable entry is dropped, not left as a hole.** A person since deleted
should not render an empty card, and `team.map(…)` should need no per-item guard.
The editor's input shows that entry as "missing (deleted)" with a remove action, so
the list does not silently get shorter with nobody able to say why. Renderer hides
the damage; editor surfaces it — the same split `multilink`'s `broken` flag makes.

`types` narrows the picker and is re-checked at resolution, exactly like
`reference`'s. `max` is enforced by the input; `min` only warns, because `required`
is declared-and-ignored across the whole field system and this field should not
invent its own enforcement ahead of the rest. A reorder is one `set` of the whole
array, so it is one undo step.

Why not a collection with a manual filter: **order**. A query cannot express "these
three, in this order", and `ord` on the records themselves is one global order, not
a per-usage one — a leadership section and an "authors in this issue" section want
different orders over the same people.

### The Data section

The admin's left rail gains a Data tab listing every non-page type with a count.
Selecting one opens a **table**: the type's title, its root block's `indexed`
fields, its draft state and when it was last touched. Sortable, searchable, twenty
rows a page — all client-side, over the list `GET /folio/documents` already
returned in full.

It lists **documents, not published content**, so a person nobody has published yet
is in it with a `draft` badge. The consequence is stated in the footer rather than
hidden: the *columns* come from `content_index`, which is written at publish, so a
draft document's cells stay blank until it is published.

Selecting a record opens the editor in **form mode**: full width, no preview iframe,
no viewport switcher, no "View live". There is nothing to preview, and previewing
the record inside a page that references it is ambiguous the moment two pages
reference it differently. (A singleton is the exception, via its type's
`previewPath` — a header genuinely renders in one place; a person does not.)
Publish, History, undo, presence and multiplayer are unchanged; none of them ever
depended on there being a preview. A record whose root has a `blocks` field still
shows the block tree, so "a person with a list of accreditations" works exactly
like a page's body.

### Deleting one

```
GET /folio/documents/:id/usage
→ { published: [{ id, title, path, url, kind }], total, links, references }
```

The delete confirmation reads "Used on 4 published documents", lists them, and
**proceeds**. It warns; it does not block. Maintaining referential integrity across
draft documents nobody can see would be a large feature, and the failure it would
prevent already degrades safely: a broken reference resolves to nothing and the
block renders its own empty state.

The count comes from `content_refs`, which is written inside the publish batch, so
it is **published references only** — and the dialog says so, because a draft
pointing at the record is genuinely not counted. `total` is distinct documents; a
page that both links to and references the same target is two rows and one
document.

Everything else about a record is ordinary. It has a Durable Object, so drafts,
multiplayer, undo and the activity trail work. It publishes into `published_doc`
with a retained version, which is why a live page referencing it renders published
values while a preview renders the draft. It is indexed by the query API, so it is
queryable. It carries per-locale values for free. The only thing it does not have
is a URL, and that is the point.

## Collections

An insights index, a news list, a team grid, a paginated archive and a sitemap are
all the same missing primitive: **list the documents matching a query**. Folio has
one, and it starts by declaring which fields are worth querying.

```tsx
export const insightPage = defineBlock({
  name: 'insightPage',
  fields: {
    title:     text({ required: true, translatable: true, indexed: true }),
    topic:     select({ options: TOPICS, indexed: true }),
    published: text({ label: 'Publish date', indexed: true }),   // ISO 8601
    body:      blocks({ allow: [...] }),
  },
  render: …,
})
```

`indexed: true` projects the field into `content_index` **inside the batch that
publishes the document**, so a query can never return something that is not live,
and a failed publish leaves neither. Only the five scalar kinds accept it —
`richtext({ indexed: true })` does not compile, because the table exists to filter
and sort, not to render. Only a **root** block is projected: the index is a fixed
projection of a document, so which rows it holds must not depend on which blocks
happen to be inside one. `GET /folio/audit` reports an `indexed` flag that can
never take effect, either way round.

One row per field **per locale**, holding the value that locale renders — the
translation where there is one, the fallback where there is not. So a French index
page filtering a French topic matches, and so does the English page filtering the
English one, on the same story.

### The `collection` field

```tsx
fields: {
  list: collection({
    type: 'insight',
    filterable: ['topic'],                        // what the editor may narrow by
    maxPerPage: 12,
    defaultOrder: { field: 'published', dir: 'desc' },
  }),
}

render: ({ list }) => (
  <ul>{list.items.map((i) => <li key={i.id}><a href={i.url}>{i.title}</a></li>)}</ul>
)
```

The whole list is one field. The field declares the shape of the query; the stored
value is only the editor's choices within it, and both are enforced on the way in
*and* on the way out — the same double enforcement `richtext`'s `marks` has,
because a value can also arrive from an importer or over the API.

Items are `ReferenceTarget`s, the shape `reference` already resolves to, so a block
author who can render a reference can render a collection item with no new
knowledge. An empty result is an empty page, never null, so `list.items.map(…)`
needs no guard.

`list.total`, `list.page` and `list.pages` are there because a design will ask for
"page 4 of 9". Pagination is the **host's**: read `?page=` and pass it in, and it
offsets every collection in the document.

```tsx
const page = Number(url.searchParams.get('page') ?? '1')
const resolution = await folio.resolve(env, doc, { locale, page })
```

A page with no collection field runs no query at all. Two blocks with the same
configuration cost one query between them: the queries a document contains are
collected, deduplicated by a canonical key, run once each, and their answers pushed
onto the `Resolution` — the same treatment `reference` gets, one level up. So the
preview still re-renders per keystroke against data it already holds.

**A preview lists published content, and says so.** Querying drafts would mean
opening every candidate Durable Object on every keystroke, so the list is marked
`stale` in the editor and a block can say "shows published items". The one
exception is the document being previewed: if it is a member of its own list, its
draft values are patched in, because that draft is already in hand.

### Querying from your own code

```ts
const { items, total, pages } = await folio.query(env, {
  type: 'insight',
  where: [{ field: 'topic', op: 'eq', value: 'policy' }],
  order: { field: 'published', dir: 'desc' },
  perPage: 6,
  page: 2,
})
```

Two D1 statements: a `count(*)` and the page with its documents. `GET
/folio/content?type=insight&where=topic:eq:policy&order=published:desc&perPage=6`
is the same thing over HTTP.

Operators: `eq`, `ne`, `in`, `contains`, `startsWith`, and `gt`/`gte`/`lt`/`lte`. A
numeric bound compares the numeric column; a string bound compares the text one,
and an ISO date is stored in both, so either spelling of "since March" works. `ne`
is a `NOT EXISTS`, so "topic is not ai" is true of a document with no topic —
which is what it means in English. `contains` is a scan and is refused unless
something else can narrow first; full-text search is FTS5's job and its own spec.

**A `where` or `order` on a field nobody marked `indexed` is a 400 naming the
field**, and listing the ones that work. Never a silent empty result: that is the
failure mode that costs an afternoon.

Every value is bound. The only names a caller supplies — a type, a field, a locale
— are *values* in this schema rather than column names, so there is no string a
client can send that reaches SQL as SQL.

### Rebuilding the index

Publish writes these rows, so the only case left is a schema change that marks an
*existing* field `indexed`, where nothing republishes:

```
POST /folio/reindex     # or folio.reindex(env, { batch: 50 })
```

Batched and resumable — re-call with the previous answer's `continueFrom` until it
is null — and idempotent, so racing a publish is harmless.

### What resolution loads

`folio.resolve(env, doc)` used to load **every story in the site**, on every page
render. It now loads the ids the document needs: the targets of its `multilink`
fields *and of the link marks inside its richtext* (a story link in prose stores an
id and has no href — the href is derived here), the targets of its `reference`
fields, the same two sets again for each document it pulls in, and the ancestors of
`opts.story` when you pass one.

For the full map — a navigation built from the whole tree — ask for it:

```ts
await folio.resolve(env, doc, { stories: 'all' })
```

A sitemap should use `folio.stories(env, { page, perPage })` or `folio.query`
instead.

`content_refs` is written in the same publish batch and records the outbound edges
of every published document, which is what "used by N documents" will read before
letting you delete something.

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

## Hooks

Folio needs no webhooks. Payload, Strapi, Contentful and Storyblok all give a host
an HTTP callback for "something changed" — a shared secret, a retry queue, a
delivery log — because the host and the CMS are different processes. Here they are
the same Worker, so a hook is a typed function call, not a round trip to yourself:

```ts
const folio = createFolio<Env>({
  blocks, types: [{ name: 'page', label: 'Page', kind: 'page', root: 'page' }],
  bindings: (env) => ({ db: env.DB, story: env.STORY }),
  hooks: {
    async published({ story, doc, env, waitUntil }) {
      await caches.default.delete(new Request(`https://site${story.path ? `/${story.path}` : ''}`))
      waitUntil(indexForSearch(env, story, doc))
    },
    async unpublished({ story, env }) {
      await removeFromIndex(env, story.id)
    },
  },
})
```

Six events, each after its write has already committed: `published`, `unpublished`,
`pathsChanged` (a rename or move — the only one that knows both the old and the new
path), `created`, `deleted`, `checkpointed`. There is no `before` hook and no way to
veto or rewrite a publish: a hook that could reject one would have to run inside the
atomic batch, which is exactly the failure that batch exists to prevent. A throwing
hook is caught and logged with the event name — a broken integration never stops an
editor from publishing — and every hook rides `waitUntil` by default, so it never
delays the response; a cache purge that must land before the next read opts in with
`await: ['published']`. Not delivery-guaranteed: at most once, no retries, no
ordering between hooks. A host that needs that writes one line to a Cloudflare Queue
inside the hook, which is the right tool for it.

## Auth

`auth` is a **required** key on `createFolio`. Either it names sign-in providers,
or it says `auth: 'open'` — one line, deliberately — and construction throws if
it says neither. Folio is a library, and a host that simply forgot the key used
to get a publicly editable CMS silently, whose failure mode is a defaced site. So
the mistake is not representable.

```ts
import { createFolio, magicLink, oidc } from 'folio/server'

const folio = createFolio<Env>({
  blocks, types,
  bindings: (env) => ({ db: env.DB, story: env.STORY, media: env.MEDIA }),
  auth: {
    providers: [
      // Folio renders the URL and stores the challenge; the host sends the mail,
      // because only the host has the binding and the from-address. In local dev,
      // `send` can simply log the link — which is what examples/demo does.
      magicLink({
        send: (env, { email, url, expiresAt }) => sendEmail(env, email, url, expiresAt),
      }),
      // OIDC with PKCE, driven by the discovery document, so one shape covers
      // Entra ID, Google and Okta. A verified email matching no user row is
      // refused by default: access is a list someone maintains, not a
      // consequence of holding an account at the provider.
      oidc({
        issuer: 'https://login.microsoftonline.com/<tenant>/v2.0',
        clientId: (env) => env.OIDC_CLIENT_ID,
        clientSecret: (env) => env.OIDC_CLIENT_SECRET,
        provision: 'refuse',
      }),
    ],
    sessionDays: 30,
  },
})
```

**Sessions are rows in D1 behind an opaque cookie.** 32 bytes from
`crypto.getRandomValues`, handed out once, stored only as a SHA-256. There is no
HMAC secret to configure, rotate or leak; revocation is a `delete` rather than a
blocklist; and a dumped database yields no usable cookies. A signed or JWT cookie
would be stateless and could not be revoked, which is the wrong trade for a CMS
where "remove that person's access now" is the whole point. The cookie is
`HttpOnly`, `SameSite=Lax`, `Path=/`, and named `__Host-folio_session` over HTTPS
or plain `folio_session` otherwise — both are read on the way in, so moving
between `wrangler dev` on localhost and a deployed worker never leaves you
holding a cookie the server will not accept.

**Roles are global**, on the user row, and each route declares its own minimum:

| | read drafts | edit | publish / checkpoint | create / delete / move | manage access |
| --- | --- | --- | --- | --- | --- |
| `viewer` | yes | no | no | no | no |
| `editor` | yes | yes | no | no | no |
| `publisher` | yes | yes | yes | yes | no |
| `admin` | yes | yes | yes | yes | yes |

Create, delete, move and rename are `publisher` rather than `editor` because all
four change what URLs the site serves, which is a publishing act even when
nothing is published in the same breath.

A `viewer` **does** get the sync socket, read-only: watching live changes is the
point of read access, and the object answers their `tx` frames with the ordinary
`reject` envelope, so a read-only editor degrades into a read-only editor rather
than a broken one. `GET /folio/asset/:key` stays public — published pages point
`<img>` tags at it, so it is exactly as public as the page that embeds it.

**Editor identity is server-supplied.** The Worker validates the session before
the WebSocket upgrade and hands the verified identity to the Durable Object as a
request header. That header is trustworthy for one specific reason: a Durable
Object namespace is not publicly addressable, so the only way to reach the object
is through the Worker that set it. `hello`'s `actor`, `name` and `colour` are
still accepted and are now ignored — an old tab keeps working, it just cannot lie
— so the activity trail, the version list and the presence dots all name a real
person. `versions.actor` stores `usr_<id>`, or `token:<name>` for a script, or
null under `auth: 'open'`, where there is genuinely nobody to attribute a change
to.

**A revoked session closes an open socket within a bounded window.** The
session's expiry rides in the socket attachment and is checked on every frame,
which costs nothing; an explicit revocation is picked up by a D1 re-check that
runs at most once a minute per socket. A query per frame would put a database
read in the keystroke path. A socket refused for any reason is *accepted and then
closed* with an application code — 4003 for no session, 4004 for a credential
that may not hold an editing session — because a failed HTTP upgrade is
indistinguishable on the wire from a dropped connection, and the client would
reconnect on a backoff forever. The admin's queue of unsent edits survives a
4003 by design, and the notice says so.

**API tokens** carry scopes rather than a role, because a token is not a person:
`content:read`, `content:read:draft`, `content:write`, `publish`, `assets:write`,
`admin`. Presented as `Authorization: Bearer folio_<hex>`, stored as a hash, and
`POST /folio/tokens` is the only response in the server that ever contains the
raw value. A token cannot open the sync socket (4004): a script is not a person
with a cursor.

**CSRF is handled by three overlapping defences and no token plumbing.** Every
mutating route is a JSON `POST`/`PATCH`/`DELETE`, the cookie is `SameSite=Lax`,
and the middleware additionally refuses a mutating request whose `Origin` is not
the worker's own — narrowed to cookie-authenticated requests, since a cookie is
the only credential a browser attaches ambiently, and allowing an absent `Origin`,
since that is a script rather than a page that can borrow anyone's cookie.

`GET /folio/login` is server-rendered and ships **no JavaScript**: a login page
that cannot work without a client bundle is a worse failure than an ugly one.

**Bootstrapping the first admin is a deploy step, not a route.** An endpoint that
creates the first admin is an endpoint that creates an admin, and no check it
could make would be worth more than:

```sh
wrangler d1 execute folio --remote --command \
  "insert into users (id, email, name, role, created_at)
   values ('usr_first', 'you@example.com', 'You', 'admin', unixepoch() * 1000)"
```

After that, an `admin` manages editors and tokens from the **Access** rail in the
editor. Adding an editor sends no mail: the row *is* the invitation, and they
sign in through whichever provider the site configured.

Out of scope, deliberately: **site-visitor auth** — who may *read* a published
page. That is a different problem (`ROADMAP.md` has it), and reading a published
page still needs no account at all.

## Content migrations

Block schemas are code and documents are data, and nothing reconciles the two on
its own. Rename `heading` to `title` in a block's `fields` and every stored
document keeps writing to `heading`, which no longer renders: the old value is
still in `blok.data`, invisible, and the field the admin now draws is empty.
Rename a *block type* and every existing instance renders "Unknown block type" in
the editor and nothing at all on the live page. Both failures are quiet by
construction, because `RenderBlok` iterates `def.fields` and reads
`blok.data[name]` — so a key the schema no longer declares is never read again.

A migration is a **pure function from a document to a list of mutations**:

```ts
// src/migrations.ts
import { defineMigration, field } from 'folio/engine'

export const migrations = [
  defineMigration({
    id: '0001-hero-heading-to-title',
    description: 'Hero: heading → title',
    up: (_doc, ctx) => ctx.each('hero', (blok) => field.rename(blok, 'heading', 'title')),
  }),
]
```

```ts
const folio = createFolio<Env>({ blocks, types, bindings, auth, migrations })
```

That one shape is what lets the same function reach all three copies of a
document, which live in three unrelated places:

| Target | How the mutations are applied |
| --- | --- |
| A story's live draft | `StoryDO.commit` — the real log path, so it syncs to open editors, lands in the activity trail, and Cmd+Z undoes it |
| `stories.published_doc` | `applyAll` and one D1 write, batched with the watermark |
| `versions.doc` | `applyAll` **at read time**, never written back |

The alternative — rewrite the DO's `doc` row, rewrite `published_doc` and hope
the draft catches up — bypasses the mutation log, which means no sync, no
activity trail, no undo, and an open editor whose document has silently diverged
from the object's.

**Idempotence is the correctness mechanism, not a nicety.** A migration applied
to an already-migrated document produces *zero* mutations. That makes the runner
re-runnable after a partial failure, makes the ledger an optimisation rather than
a guarantee, and makes "did that actually work" answerable by running it again
and seeing nothing happen. It is implemented once, in the helpers, rather than in
every migration you write:

```ts
field.rename(blok, 'heading', 'title')            // set new, clear old — [] once done
field.remove(blok, 'legacyFlag')
field.default(blok, 'align', 'left')              // only where the key is absent
field.map(blok, 'topic', (v) => String(v).toLowerCase())
field.split(blok, 'name', { firstName, lastName })
block.retype(blok, 'quote', { size: 'large' })    // retype + seed the new fields
block.wrap(doc, blok, 'container', 'body')        // insert a parent, move the blok in
```

`ctx.each(type, fn)` walks the document's bloks of a type in uid order and
flattens what `fn` returns. Anything the helpers do not cover is written by hand
against `Blok` and `Mutation` — which is what `folio/engine` exists for, and what
its own doc comment already promised: *"host-side tooling that legitimately needs
to manipulate documents — bulk-import scripts, content migrations"*. A migration
gets no network and no clock: one that depends on either is not re-runnable, and
re-runnability is the mechanism.

Two details worth knowing. `field.rename` **clears** the old key by setting it to
`null`, because the mutation vocabulary has no delete-key — and null is already
what `resolveValue` renders as empty and what `diff` treats as equal to an absent
key. And `field.default` fills only a key that is *absent*, never one holding
`''`, `false`, `0` or an explicit `null`: those are values an editor could have
chosen, and this is a tool for filling holes rather than for overwriting
decisions. (It is the retroactive half of a field's own `default`, which is read
at creation only, so that a schema edit never changes what an already-published
page says.)

**`Mutation` gained `retype`, and the wire went to v2.** It is the one edit the
vocabulary could not express: `insert` refuses a duplicate uid and `remove`
cascades over the subtree, so "remove and re-insert under the same uid" is not a
transaction that can be written at all. A retype keeps the uid, the position and
the children, and touches no field data — a retype that needs fields added emits
`set`s alongside it. The Durable Object does **not** check that the new type
exists, deliberately: an unknown type renders as "Unknown block type" and is
fixable by another migration, whereas an object that had to hold the block
registry and keep it in step is a far worse coupling than a bad type name.
Retyping a document's *root* is refused, because a root's type is its **document**
type and changing that needs a `stories.type` update in the same breath.

**The runner is explicit, never automatic on boot.** A migration that runs itself
on the first request after a deploy runs inside a request whose CPU limit it can
exceed, on a cold Worker, with nobody watching. So it is a call:

```ts
const report = await folio.migrate(env, { dryRun: true })
// { pending: ['0001-hero-heading-to-title'], stories: 142, changed: 139,
//   unchanged: 3, mutations: 388, oversized: [{ storyId, mutations: 450,
//   transactions: 3 }], failed: [], continueFrom: 'sty_…', complete: false }
```

or `POST /folio/migrate` (`admin`), which the **Model** rail in the editor drives
with a Preview and a Run button. One call sweeps a batch of documents in `id`
order and answers a `continueFrom` cursor; the caller re-calls until it is null.
Batched rather than streamed, because a stream would have to hold a response open
across exactly the CPU limit this design exists to stay under.

A document over `MAX_TX_MUTATIONS` is **chunked, not refused**: several
transactions, and therefore several undo steps. That is the honest trade — the
alternative is refusing to migrate documents over a size, and a CMS that cannot
migrate its biggest pages is not much use — and the dry run names them, so it is
never a surprise. A chunk the object refuses is recorded per story, the story's
watermark is left alone, and the run carries on; re-running picks it up.

Two ledgers, doing different jobs. `schema_migrations` records a *completed*
sweep — a row means "this migration reached every document" — and is the audit
trail. `stories.schema_id` is the per-document watermark, which is what makes a
partial run resumable and what the editor's banner reads: a document created
today is stamped with the latest migration, because `blankSubtree` seeded it from
the current schema and it is therefore already correct. `versions.schema_id`
records the shape of the bytes in that row, so `getVersion` can apply what a
version is missing on the way out. History is never rewritten: that keeps the
record of what was actually published, and it is what makes a restore across a
migration correct, since `diff(live, target)` has to be computed between two
documents in the same shape.

**A drifted database shows a banner; it does not lock the editor.** Refusing to
serve the admin until somebody runs a migration would turn a schema drift into an
outage. An editor opening a page that is behind gets "This page has not been
updated for the latest content model", with the pending descriptions, and carries
on editing.

### The drift audit

```
GET /folio/audit   (admin)
```

A read-only report over every *published* document — one D1 query, no Durable
Objects, because it reports on what the site is actually serving:

- **orphan keys**: a key the schema no longer declares, still holding a value.
  (A `null` orphan is not reported: clearing a field *is* setting it to null, so
  counting those would mean every completed rename left permanent drift behind
  it.)
- **unknown types**: a blok whose type nothing declares any more.
- **missing fields**: a declared field a document has no key for — what
  `field.default` fills.

Plus two checks over the *schema* alone, which are code mistakes with no runtime
symptom: a `showIf` naming a field the block does not declare (`matches` is total,
so the input is simply never drawn and nothing says why), and a `summary` naming
a hidden field (the tree labels every row with a value the inspector never
shows).

It is deliberately not part of the migrate path: an audit that runs as a side
effect of a write is an audit nobody reads. Adding a check is one entry in
`DOCUMENT_CHECKS` or `SCHEMA_CHECKS` (`src/server/audit.ts`) — every finding
carries its own `check` name and travels in the report's `content` / `schema`
arrays, so no route, response shape or admin screen changes.

## Content API

Everything above assumes a person in a browser. `/folio/api/v1` is the same
content for a script: token-authenticated, versioned, documented in
[`docs/api.md`](docs/api.md), and — the part that matters — **writing through the
same mutation log the editor writes through**.

```sh
TOKEN=folio_…
curl -H "authorization: Bearer $TOKEN" \
     http://localhost:5199/folio/api/v1/documents/by-path/about
```

```jsonc
{
  "id": "sty_9f3c1a02",
  "type": "page",
  "title": "About us",
  "path": "about",
  "url": "/about",
  "state": "live",
  "source": "published",
  "content": {
    "uid": "9f3c1a02bb47de10",
    "type": "page",
    "fields": {
      "title": "About us",
      "body": [
        {
          "uid": "1a2b3c4d5e6f7081",
          "type": "hero",
          "fields": { "heading": "Hello", "align": "center" },
          "i18n": { "fr": { "heading": "Bonjour" } },
          "actions": []
        }
      ]
    }
  }
}
```

A stored document is normalised — a flat map keyed by uid, each blok holding its
own `parent`, `slot` and fractional `order`. That is the right shape for a mutation
log and the wrong one to ask somebody's import script to construct, so the API
speaks trees: **a `blocks` field becomes an array in `fields`**, which is the shape
a block author already sees in `render`. `toNested` and `fromNested`
(`folio/engine`) are the conversion, and they are public because an importer needs
them too.

### A write is read, diff, commit

```
PUT /api/v1/documents/sty_9f3c1a02/content
  → current  = the story's live draft, from its Durable Object
  → target   = fromNested(body.content, schema, current)
  → mutations = diff(current, target)
  → StoryDO.commit(chunk, actor) per MAX_TX_MUTATIONS
  → 200 { "changed": 1, "transactions": 1, "syncId": 42 }
```

Nothing about that is a special path, which is the whole point:

- an editor with the page open **receives the delta and re-renders**, through the
  per-keystroke machinery, with no reload;
- the activity trail says `token:import-script`;
- **Cmd+Z undoes it**, because it is an ordinary transaction;
- an unchanged payload produces zero mutations and writes nothing, so a nightly
  sync of 400 products of which 3 changed is three writes;
- the document caps refuse an oversized write at the door, with the reason.

The alternative — writing `published_doc`, or the Durable Object's `doc` row —
would have been quicker to build and would have broken all five silently, visible
only to whoever happened to have the page open at the time.

### uids, and why they are in the payload

`uid` is **optional on the way in**. Present means "this blok, updated in place";
absent means "a new one, placed between its neighbours". So a read-modify-write
preserves identity, and version diffs stay minimal, presence stays attached to the
right block, and undo stays granular. A shape without uids would make every write
a wholesale replace.

Order is **positional**: send the array in the order you want. `fromNested` keeps
the longest run of existing sibling keys it can and mints keys only for the gaps,
so inserting an item at the front of a list of fifty is one insert and zero moves.

### `merge` is the default

`PUT /content` merges unless told otherwise. An absent field, an absent `i18n` and
an absent slot all leave what is stored alone, so a partial payload is safe:

```sh
curl -X PUT -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"content":{"uid":"9f3c1a02bb47de10","fields":{"title":"About"}}}' \
  http://localhost:5199/folio/api/v1/documents/sty_9f3c1a02/content
```

A slot that *is* present is authoritative for that slot, which is how a block is
removed through `PUT` at all. `mode: 'replace'` is opt-in, and is the only mode
that can discard content it was not told about — so a replace omitting `i18n` on a
blok that holds translations is **refused**, with the locales named, rather than
diffing them away. `"i18n": {}` is how you clear them deliberately.

`PATCH /fields` is the narrower tool, and skips the diff entirely:

```json
{ "fields": { "title": "New title" },
  "bloks": [ { "uid": "1a2b3c4d5e6f7081", "fields": { "heading": "Changed" } } ],
  "locale": "fr" }
```

`fields` addresses the root blok (where a document's own metadata lives), `bloks`
addresses any other by uid, and `locale` scopes every write in the request to one
language. It becomes one `set` per field and touches no structure — which is what
a bulk price update wants.

### Idempotency

`Idempotency-Key: <anything>` is hashed to a txId and handed to the log, whose
`log_tx_id` unique index already answers a resend with the delta it produced the
first time. So a retry gets `"replayed": true` with the original `syncId`, and the
log holds one transaction. Scoped **per document**, because the log is: a batch
across documents needs a key each, and the per-document results make a retry after
a partial failure precise.

Reusing a key with a *different* body is answered by the first write. That is the
contract, not a bug: the key is the identity of the write, and `replayed: true` is
how a caller notices.

### Reading a locale

`?locale=fr` reads every field through the fallback chain and drops `i18n`, because
the values are already resolved. That payload is for **reading**; writing it back
would put French into the source locale. Its `locale` field is the flag that says
so. Omit the parameter and you get the authoring shape, which round-trips.

### From the host's own Worker

A host Worker already holds the bindings and should not make an HTTP request to
itself:

```ts
const doc = await folio.draft(env, id)
const target = fromNested({ uid: doc.root, fields }, toSchemaIndex(folio.registry), doc)
await folio.write(env, id, diff(doc, target), { actor: 'sync-job', txId: 'nightly-1' })
```

Same `commit`, same chunking, same guarantees — see `POST /dev/sync` in
`examples/demo/src/index.tsx`, which is that call and a JSON body.

### Globals are ordinary documents

A singleton's id is derived (`sng_settings`), and it is addressable through every
route here: read it, write it, publish it. Reading one that nothing has opened yet
creates its row, exactly as the admin's own document list does. Creating a second
one is refused (there is no other id it could have) and so is deleting it.

### Scopes

`content:read`, `content:read:draft`, `content:write`, `publish`, `assets:write`,
`admin` — the implications are in the auth section above. Notably `content:read`
alone cannot read a draft, and `assets:write` implies nothing about content.

A **session cookie works on these routes too**, at the equivalent role, so the
admin could use them and there is one enforcement point rather than two. What
Folio does *not* do is declare its own admin routes public: those ship inside the
library and change with it, and `/api/v1` is a contract with somebody's script.
Two surfaces over one set of services.

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

`scripts/migrate-test.mjs` (38 checks) covers content migrations against the
demo's own two (`examples/demo/src/migrations.ts`): the seeded rows, which
genuinely predate them, reaching all three copies of a document — a connected
editor receiving the change as a delta with no reload, the published page
rendering the new field, and an old version previewing correctly because it is
migrated on read while its stored bytes stay untouched. Plus the two properties
everything else leans on: a dry run that writes nothing at all, and a second run
that reports zero changes.

`scripts/auth-test.mjs` (42 checks) covers identity and access against the demo's
own `magicLink` provider: the editor redirecting when signed out and the API
answering 401, an unauthenticated socket upgrading and then closing 4003, an
unknown address answered byte-identically to a known one with no link sent, a
sign-in link that works exactly once, a transaction and a publish attributed to
the session rather than to what `hello` and `x-folio-actor` claimed, an editor
refused a publish and a create, a viewer given a read-only socket whose `tx` comes
back as a `reject`, a read-only token refused a write and refused a socket
entirely, a cross-origin mutation refused, and — after signing out — the editor and
the socket both refused while the published page carries on serving to anyone.

`scripts/collections-test.mjs` (45 checks) covers collections against the demo's
`insight` type and its `insightList` block: twenty-five insights, one left
unpublished, filtered and sorted and paged over HTTP; `total` counting every match
rather than the page; a filter on an unindexed field answering 400 with the field
named; a French query matching a translated title while an untranslated field falls
back; an index page rendering the right six in the right order with no `<script>`;
`?page=2` continuing where page one stopped; a preview saying it lists published
items while the document being previewed shows its own draft title in a list it
belongs to; delete and unpublish each dropping the rows and the total; the host's
own `/archive` route querying with no block involved; and `POST /folio/reindex`
sweeping every document and then changing nothing. One is a regression guard rather
than a feature test: **a story id reachable only from a richtext link mark still
resolves to a real `href`**, because a link mark stores an id and no href, so a
resolution narrowed to link *fields* would render every internal prose link as
plain text with nothing failing.

Every script runs against a live dev server on port 5199 (and the engine tests
against the production build via `vite preview`). They sign in first, through
`scripts/lib/auth.mjs`: the demo's `send` logs the link and stashes it at a
localhost-only `/dev/last-signin`, which is the stand-in for a mailbox that lets
these run with no mail credentials at all.

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

Custom field types defined by a host project, and a real package build (the
library currently ships TypeScript source and the host compiles it).

Within localisation: translated slugs (a French URL contains English words), and
per-locale publishing. Both are deliberate and both are additive later — see the
section above.

Within auth: site-visitor access control (who may *read* a published page — see
`ROADMAP.md`), per-story editor permissions, multi-tenant spaces, SSO group → role
mapping, passwords/passkeys/TOTP, and a separate `auth_events` audit log. Sign-in
link rate limiting is per address only; the IP dimension wants a Cloudflare
rate-limiting rule at the zone.

Within collections: **full-text search** (D1 has FTS5; it is a separate index, a
separate write path and a separate ranking question, so it is its own spec), a
`collection` on a nested block's field (only a root block is projected, so the index
stays a fixed projection of a document), **faceted counts** ("Policy (12), AI (8)" —
one `group by` over the same predicate, genuinely easy and deliberately unbuilt
until a design asks), per-field pagination on a page with two independently paged
lists (`?page` is one number), **draft-status queries** (the index is published-only
by construction, and the admin lists documents from `stories` instead — a list of
documents, not a query over content), and a per-type admin list view with columns
from the indexed fields, which belongs with the rest of the Data section.

Within content migrations: no `down`, and no automated migration of a document
from one *document type* to another (it needs a root retype plus a `stories.type`
update in the same breath, with no atomicity available across the two stores;
expressible by hand). No per-block schema versioning with lazy up-conversion on
read, deliberately — a document whose shape depends on when it was last read
makes the diff, the audit and any query index ambiguous.

Within the field types: no tables in richtext, no text colour mark, and no
embedded bloks inside richtext. Host projects cannot override how a richtext node
renders, which is fine while the output is semantic HTML that CSS can style, and
will need revisiting when it is not.

Note also that `vite preview` does not proxy the browser's WebSocket upgrade, so
the admin only connects under `vite dev` or a real deploy. The test scripts use a
Node client and pass against both.
