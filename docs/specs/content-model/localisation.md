# Feature: Localisation — field-level locales in one document

> **Group:** content model
> **Build order:** 12
> **Size:** L
> **Status:** draft
> **Wire version:** bumps `PROTOCOL_VERSION` to 3 (`set` gains `locale`; `hello` sheds its identity fields)
> **Migration:** `0009_locales.sql`
> **Last updated:** 2026-07-29

## Summary

Folio has no i18n at all (`README.md` → *Not built yet*). This spec adds
**field-level locales**: one document per story, holding every translation, with
translatable field values stored per locale and page structure shared across them.

The alternative — one story per locale, linked by a translation group — was
considered and rejected (checkpoint 1). The deciding argument is that field-level
locales fall out of the mutation log almost for free: a translation is a `set` with
a locale on it, so translations inherit multiplayer, undo, versioning, the activity
trail, atomic publish and per-keystroke preview without a single new mechanism.
Two translators working in different languages on the same page never conflict,
because they are writing different keys in the same document.

The cost is stated plainly: a translator cannot restructure a page. Adding a block
adds it to every locale. That is the same trade Storyblok's field-level translation
makes, and for the same reason.

## Ground truth

**core (`packages/folio/src/core/`):**
- `Blok = { uid, type, parent, slot, order, data: Record<string, Json> }`
  (`doc.ts:13-21`). Nothing else. `data` is the only place a value lives.
- `Mutation`'s `set` is `{ t: 'set', uid, field, value }` (`mutations.ts:8`).
  `apply` writes `{ ...b, data: { ...b.data, [m.field]: m.value } }`; `invert`
  reads `b.data[m.field] ?? null` (`mutations.ts:103`) — so undo of a `set` is
  already a per-field value snapshot, and locale-scoping it is symmetric work.
- `isMutation`'s `set` case requires `uid`, `field` and the *presence* of `value`
  (`protocol.ts:234-237`) — an explicit `null` is a value, an absent key is
  malformed. A locale must follow the same discipline: absent means source locale,
  and that is a legal frame forever.
- `diff` compares `new Set([...Object.keys(prev.data), ...Object.keys(blok.data)])`
  per blok (`diff.ts`) — it must gain the same walk over locale maps, or a version
  restore would silently drop translations.
- `resolveValue(field, value, resolution)` (`resolve.ts`) is exhaustive over field
  kinds and takes a single `Json` value. It never sees the blok, so a locale-aware
  read has to happen in its caller.
- `RenderBlok` (`preview/Render.tsx`) reads `blok.data[name]` in **four** places:
  richtext, reference, the non-`blocks` default, and (indirectly) the `blocks`
  children walk. All four become one `valueOf(blok, name, locale)` call.
- `summarise(schema, data)` (`schema.ts`) labels a block in the tree from a field
  value, taking `data` directly.
- `MAX_DOC_BYTES = 8 MB`, `MAX_DOC_BLOKS = 20_000` (`protocol.ts:113-116`).
  Locales multiply **bytes**, not bloks: eight locales of a long richtext field is
  eight times the payload with the same block count.
- `MAX_FRAME_BYTES = 256 KB` bounds one `set`, which is unchanged by locales — one
  translation is one field value.

**server (`packages/folio/src/server/`):**
- `withUrls` / `previewUrlFor` (`runtime.ts:63-76`) build a story's URL from
  `config.route(path)` and append `?_folio=preview`. `route` takes a path and
  nothing else, so a locale prefix has nowhere to come from today.
- `publishStoryStatement` (`stories.ts`) caches
  `doc.bloks[doc.root]?.data.title` into `stories.title` — the source of the tree's
  labels.
- `publish()` snapshots the whole document into one `published_doc` column.
- `previewPage` renders the draft and bootstraps `{ doc, resolution }`
  (`pages.tsx`).

**admin (`packages/folio/src/admin/`):**
- `useBlocks.setField(uid, field, value)` is the single door every input writes
  through, and it deliberately takes the uid as a parameter rather than reading the
  selection (see its comment about uploads landing late). A locale parameter joins
  it there.
- `Inspector.tsx` draws inputs from `schema[blok.type].fields`; `BlockTree.tsx`
  labels rows via `summarise`.

## Owner decision checkpoints

1. **Field-level locales, one document (confirmed by the owner).** Rejected
   alternative: a story row per locale with `translation_of`, which gives structural
   freedom per locale and needs no protocol change, but forks drafts, DOs, publish
   and history N ways and gives no per-field "untranslated" signal.
2. **Translatable is opt-in per field (recommended).** `text({ translatable: true })`.
   Most `select`, `boolean`, `number` and `asset` fields should not diverge per
   locale, and a default of "everything is translatable" turns every schema into a
   translation surface nobody asked for. Cost: annotating existing blocks. Mitigation:
   `/folio/audit` (from `../foundation/schema-migrations.md`) reports text-ish fields
   that are not marked, so the omissions are findable rather than invisible.
3. **Publishing publishes every locale at once (recommended).** One document, one
   `published_doc`, one atomic snapshot. A half-translated page therefore goes live
   with fallbacks, which is what Storyblok does under field-level translation. The
   alternative — per-locale published snapshots — means a locale column on the
   publish path, N version rows per publish, and an editor able to publish a page
   whose English is three revisions ahead of its French. Mitigation: the admin warns
   before publishing when a locale is incomplete, and names what is missing.
4. **Paths are locale-independent; the locale is a URL prefix (recommended).**
   `/about` and `/fr/about` are the same story. Translated slugs (`/fr/a-propos`)
   are out of scope: they make `path` per-locale, which forks the unique index, the
   `derivePaths` walk, the tree and every link resolution. Cost: French URLs contain
   English words. This is the item most likely to need revisiting, and it is
   additive when it does — `stories.path_i18n` and a locale-aware `storyByPath`.
5. **An untranslated field falls back; an empty translated field does not
   (recommended).** Absent key means untranslated. `''` means deliberately empty.
   The alternative — treating empty as untranslated — makes "clear this heading in
   French" impossible to express.

## User stories

### Translator works in their language
**As** a translator **I want to** switch the editor to French and see every
translatable field with its English source beside it **so that** I can translate in
place without a spreadsheet.

### Translator cannot break the page
**As** a site owner **I want** structure to be shared across locales **so that** a
translator cannot delete a section in French and leave the layout inconsistent.

### Two translators work at once
**As** a translator **I want** the French and German translators to be able to work
on the same page as me at the same time **so that** a launch does not serialise
through one person.

### Editor knows what is missing
**As** an editor **I want** to see that French is 80% translated and which fields
are missing **so that** I can chase the gap before launch.

### Visitor gets a whole page
**As** a visitor to `/fr/about` **I want** untranslated fields to fall back to
English **so that** I get a complete page rather than holes.

### Developer renders a locale
**As** a developer **I want** `folio.published(env, path, locale)` and a resolution
that knows the locale **so that** my Worker renders the right language without
reaching into document internals.

## Architecture decisions

### 1. `Blok.i18n` holds translations; `data` stays the source locale

```ts
export interface Blok {
  uid: string
  type: string
  parent: string | null
  slot: string | null
  order: string
  /** The source locale's values. Unchanged. */
  data: Record<string, Json>
  /** Per-locale overrides, by locale code then field name. Absent = untranslated. */
  i18n?: Record<string, Record<string, Json>>
}
```

Two properties make this the right shape:

- **Every existing document is already valid**, and every existing read path
  (`data[field]`) still returns the source locale. A single-locale site never grows
  the field, and `resolveValue` never learns about locales at all.
- **The source locale is not a special case of the map.** Writing English into
  `i18n.en` as well would mean two places to read a default from, and the first
  time they disagreed nobody would know which was authoritative.

Rejected: `data[field] = { __i18n: { en, fr } }` per value. It makes every field's
stored shape polymorphic, so every reader, every diff, every `deepEqual` and every
importer has to unwrap it, and a field whose legitimate value is an object becomes
ambiguous.

### 2. `set` carries an optional locale, and the log stays readable forever

```ts
| { t: 'set'; uid: string; field: string; value: Json; locale?: string }
```

- Absent `locale` means the source locale and writes `data`. That is what every
  logged mutation written before this change means, so **the entire existing log
  replays correctly with no migration** — the property `protocol.ts` calls out as
  the one that has to hold across versions.
- `apply` with a locale writes `i18n[locale][field]`, creating the maps as needed.
- `invert` reads the prior value from the same place, so undo is per-locale for
  free and a translator's Cmd+Z cannot revert someone else's language.
- `isMutation` accepts a `locale` only as a string; an unknown code is not a wire
  concern (the same reason `retype` does not check the schema — the object is
  deliberately ignorant of configuration).
- `diff` walks `data` **and** every locale map, emitting locale-scoped `set`s.
  Without this, restoring a version would drop or resurrect translations silently.
- Setting a locale value to `undefined` is not expressible (`isMutation` requires
  `value` to be present). "Untranslate this field" is therefore an explicit
  `{ locale, value: null }`, and `valueOf` treats `null` as *untranslated* while
  `''` is *empty* — decision 5's rule, implemented in one function.

`PROTOCOL_VERSION` → 3. Since a bump is spent, `hello` sheds `actor`, `name` and
`colour` in the same release — they have been advisory since
`../foundation/identity-and-access.md`.

### 3. One function reads a value, and everything goes through it

```ts
// core/values.ts
export function valueOf(blok: Blok, field: string, locale?: LocaleContext): Json | undefined
```

`LocaleContext` is `{ code, fallbacks: readonly string[] }` — the active locale and
the chain to try, derived once from config, carried on the `Resolution`. `valueOf`
returns the first *defined and non-null* candidate from
`i18n[code]`, then each fallback, then `data`.

Callers: `RenderBlok`'s four reads, `summarise`, `titleOf`
(`../foundation/document-types.md`), the query index
(`collections.md`), and the admin's inputs. `resolveValue` keeps its signature and
stays locale-blind, which is what keeps the change small.

### 4. `translatable` is a field flag, enforced in the editor and ignored by the renderer

```ts
fields: {
  heading: text({ translatable: true }),
  align:   select({ options: […] }),            // shared across locales
  body:    richtext({ translatable: true }),
  hero:    asset(),                              // one image everywhere
}
```

The admin refuses to write a locale-scoped value to a non-translatable field and
shows it disabled with "shared across all languages" while a non-source locale is
active. The **renderer does not check the flag**: if a value is in `i18n`, it wins.
That asymmetry is deliberate — the same one richtext already has, where the editor
constrains input and the renderer sanitises output — and it means un-marking a
field does not silently hide content somebody already translated. `/folio/audit`
reports translated values sitting in non-translatable fields so they can be
migrated away on purpose.

A `blocks` field cannot be translatable: children are separate bloks, not a value,
and per-locale structure is exactly what decision 1 trades away.

### 5. Locales are site configuration; the locale is a URL prefix

```ts
const folio = createFolio<Env>({
  blocks, types,
  locales: {
    default: 'en',
    available: [
      { code: 'en', label: 'English' },
      { code: 'fr', label: 'Français' },
      { code: 'de', label: 'Deutsch', fallback: 'en' },
    ],
  },
  // The locale reaches the URL here, in the host's own routing function.
  route: (path, locale) =>
    `${locale && locale !== 'en' ? `/${locale}` : ''}${path ? `/${path}` : '/'}`,
})
```

`route` gains a second parameter, optional, so every existing host keeps compiling.
The host owns the URL shape — prefix, subdomain, or `?lang=` if it must — and Folio
only needs the inverse: `folio.handle()` and `folio.published()` take a locale the
host has already parsed out of its own URL, because the host is the only thing that
knows how it encoded it.

```ts
const { locale, path } = parseLocale(url.pathname)      // host code, one line
const doc = await folio.published(env, path, locale)     // locale for the resolution
const resolution = await folio.resolve(env, doc, { locale })
```

`published()` returns the same document whatever the locale — there is only one —
and the locale rides on the `Resolution`, which is what the renderer reads. That
keeps "which language" in exactly one place instead of two.

### 6. Preview switches locale by reloading the iframe

The per-keystroke rule (no network in the loop) applies to *editing*, not to
switching language. Switching locale changes the host's own chrome, its
`<html lang>`, and possibly its stylesheet, none of which the admin can push
through a postMessage. So the locale switcher reloads the iframe at the locale's
preview URL, and everything after that is per-keystroke as usual.

The alternative — pushing a new `resolve` frame with a different locale and
re-rendering the document in place — is faster and *almost* right, and it would
leave the host-rendered parts of the page in the previous language. Rejected for
that reason; recorded because it is tempting.

### 7. `stories.title` stays the source locale, with a best-effort per-locale cache

The tree needs labels without opening Durable Objects, so `stories.title` remains a
denormalised cache of the source-locale title. A `title_i18n` JSON column caches
translated titles, written by the same paths that write `title` (publish, and the
Address panel's patch). Best-effort by definition: the document is the source of
truth, and a stale cache costs a wrong label in a tree, not wrong content on a page.

## Wire & schema changes

### D1 migration `0009_locales.sql`

```sql
-- Per-locale title cache for the content tree, so a translator's tree is not in
-- English. Best-effort: `title` remains the source-locale cache and the document
-- remains the source of truth for both.
alter table stories add column title_i18n text;   -- JSON: { "fr": "À propos" }
```

That is the whole migration. Documents carry their own translations, and publish
still writes one snapshot — which is the strongest evidence that decision 1 fits
the existing model rather than fighting it.

### Core types

- `Blok.i18n?: Record<string, Record<string, Json>>`.
- `Mutation`'s `set` gains `locale?: string`; `PROTOCOL_VERSION` → 3; `hello`
  drops `actor`/`name`/`colour`.
- `valueOf(blok, field, locale?)` in `core/values.ts`.
- `LocaleContext = { code: string; fallbacks: readonly string[] }`;
  `Resolution.locale?: LocaleContext`.
- `Field` gains `translatable?: boolean` on every kind except `blocks` (typed as
  such, so `blocks({ translatable: true })` does not compile).
- `LocaleConfig` on `FolioConfig`; `route: (path: string, locale?: string) => string`.
- `Folio.published(env, path, locale?)`, `Folio.resolve(env, doc?, { locale })`,
  `Folio.stories(env)` returns per-locale URLs (`urls: Record<string, string>`)
  alongside `url`.
- `translationStatus(doc, schema, locale)` → `{ total, translated, missing:
  Array<{ uid, field }> }`, in core so the admin and the API agree.

### Routes

- `GET /<path>?_folio=preview&locale=fr` — the existing preview branch reads the
  locale, passes it into the resolution, and the admin's switcher points here.
- `GET /folio/schema` — response gains `locales`.
- `GET /folio/story/:id/translation?locale=fr` — completeness for the admin's
  badge. Cheap: computed from the draft the admin already has, so this route exists
  only for the tree's per-story badges.

## Acceptance criteria

### A translated field renders in its locale and falls back otherwise
```
GIVEN a hero with data.heading 'Hello' and i18n.fr.heading 'Bonjour', and a
      translatable subheading translated in neither
WHEN /fr/about is rendered
THEN the heading is 'Bonjour' and the subheading is the English source
AND /about renders 'Hello'
AND the French page ships no JavaScript, like any published page
```

### An empty translation is not a missing one
```
GIVEN i18n.fr.heading = ''
WHEN /fr/about is rendered
THEN the heading is empty, not 'Hello'
AND WHEN i18n.fr.heading is set to null
    THEN it renders 'Hello' again and the field reads as untranslated
```

### Fallback chains
```
GIVEN locales en (default), fr, and de with fallback fr
WHEN a field is translated in fr but not de
THEN /de/x renders the French value
AND a field translated in neither renders the English source
```

### Two locales, one document, no conflict
```
GIVEN two editors on the same story, one in fr and one in de
WHEN both type into the same field at the same time
THEN both values land, both editors see both arrive, and neither overwrites the
     other (they wrote different keys)
AND each editor's Cmd+Z reverts only their own locale
```

### Structure is shared
```
GIVEN an editor in fr
WHEN they add a block
THEN it appears in every locale (it is one insert, with no locale)
AND WHEN they try to edit a non-translatable field
    THEN the input is disabled and labelled shared, and no locale-scoped set is sent
```

### Publish is whole-document
```
GIVEN a story with complete English and 60% French
WHEN it is published
THEN one version row and one published_doc are written containing both locales
AND the admin warned before publishing, naming the missing French fields
AND /fr/x serves with fallbacks
```

### Version restore preserves translations
```
GIVEN a version whose French heading differs from the live draft's
WHEN it is restored
THEN diff() emits a locale-scoped set for the French heading, the restore lands as
     one transaction, and no other locale is touched
```

### The old log still replays
```
GIVEN a Durable Object whose log was written before this version
WHEN it bootstraps a client
THEN every logged set with no locale applies to the source locale and the document
     is byte-identical to what the previous build produced
```

### Locale switching in the editor
```
GIVEN an editor on /about in English
WHEN they switch to French
THEN the iframe reloads at /fr/about?_folio=preview&locale=fr, the inspector shows
     French values with the English source beside each field, and typing updates
     the preview per keystroke as usual
```

### Tree labels
```
GIVEN a story titled 'About' with a French title 'À propos'
WHEN a translator views the tree in French
THEN the row reads 'À propos'
AND with no French title it reads 'About'
```

## Implementation plan

Deploy order: phases 1 and 2 ship together (wire bump). Phase 3 and 4 can follow.

### Phase 1 — the document model

1. `core/doc.ts`: `Blok.i18n`.
2. `core/mutations.ts`: `set.locale` in `apply`, `invert`, and `mutationError`
   (nothing to validate beyond what exists — a locale is opaque).
3. `core/protocol.ts`: `isMutation` accepts `locale`; `PROTOCOL_VERSION` → 3;
   remove the identity fields from `hello` and from `normalizeHello`'s contract
   (keep the normalisation helpers — the login flow reuses the control-character
   stripping).
4. `core/diff.ts`: walk locale maps; `summariseDiff` gains a per-locale count.
5. `core/values.ts`: `valueOf`, `LocaleContext`.
6. `core/fields.ts`: `translatable` on every kind but `blocks`.
7. Tests: `mutations.test.ts` (locale set/invert, absent-locale compatibility),
   `diff.test.ts` (locale-scoped emission, and the existing round-trip property
   extended over documents with translations), `values.test.ts` (`valueOf`'s
   fallback and the null/`''` rule), `protocol.test.ts` (guard, and an old
   unversioned-shape frame still refused for the right reason).

### Phase 2 — server and rendering

1. `server/types.ts`: `LocaleConfig`, `route(path, locale)`, the `Folio` signature
   changes. Validate at construction: a default that is not in `available`, a
   duplicate code, a fallback that does not exist, a fallback cycle.
2. `server/runtime.ts`: `withUrls` produces `urls` per locale; `resolve` takes a
   locale and puts a `LocaleContext` on the `Resolution`; `seed` unchanged.
3. `preview/Render.tsx`: the four reads become `valueOf`.
4. `server/stories.ts`: `title_i18n` read/write; `titleOf` becomes locale-aware.
5. `server/pages.tsx` + `handle()`: read `locale` from the preview query.
6. `core/schema.ts`: `summarise` takes a blok and a locale rather than `data`.
7. Migration `0009_locales.sql`.
8. Tests: `test/workers/app.test.ts` (render per locale, fallback chain, zero-JS),
   `test/workers/stories.test.ts` (title caches), construction validation.

### Phase 3 — admin

1. `useBlocks.setField(uid, field, value, locale?)` — the one door, so every input
   inherits it.
2. A locale switcher in `TopBar.tsx`; the active locale in `FolioContext` so the
   inspector, tree and preview bridge all read one value.
3. `Inspector.tsx`: source value shown beside each translatable field (proposed:
   the source as the input's placeholder plus a "translated / from English" chip,
   which is less noisy than a second column and works for richtext too);
   non-translatable fields disabled with an explanation while a non-source locale
   is active.
4. `BlockTree.tsx` / `StoryTree.tsx`: locale-aware labels; a completeness badge per
   story from `translationStatus`.
5. Publish confirmation naming incomplete locales (checkpoint 3's mitigation).
6. Tests: `test/unit/admin/store.test.ts` for locale-scoped transactions and
   per-locale undo; inspector tests for the disabled state.

### Phase 4 — docs

1. `README.md`: an i18n section; remove i18n from *Not built yet*; update the
   `route` signature in the mount snippet.
2. `ROADMAP.md` / `PARITY.md`: record what shipped and that translated
   slugs did not.
3. `docs/sync-design.md`: add the locale rule to the log-compatibility section —
   an absent locale means the source locale, forever.

## Edge cases

- **A locale removed from config with values still in documents** → the values are
  inert (nothing reads that code) and `/folio/audit` reports them. A migration can
  strip them; nothing does automatically, because a locale is often removed by
  mistake.
- **A locale added** → every field reads as untranslated and falls back. No
  migration, no write.
- **Eight locales of long richtext** → bloks are unchanged but bytes multiply
  against `MAX_DOC_BYTES` (8 MB). A `set` is still one field value, so
  `MAX_FRAME_BYTES` is unaffected. Worth a note in the docs: the document cap is
  now per-site-times-locales, and the audit should report documents within 20% of
  it.
- **A translated `multilink` pointing at a different story per locale** → allowed
  (`translatable: true` on the field) and resolution is per-locale because the
  resolution already carries the locale. A translated link to a deleted story is
  `broken: true` like any other.
- **A translated `asset` with per-locale alt text** → already works: alt text is
  part of the field value, and the field value is per locale.
- **`richtext` in two locales** → two whole ProseMirror trees in one blok. Still
  last-write-wins per locale, as it is per field today. The 12 kB-per-keystroke cost
  noted in `README.md` is per locale being edited, not multiplied.
- **Source locale changed in config** (`default: 'en'` → `'fr'`) → not supported as
  a config edit: `data` holds the source values, so switching means a migration that
  swaps `data` with `i18n.fr`. Expressible with
  `../foundation/schema-migrations.md`; refused at construction if the ledger shows
  a different previous default.
- **A `set` with a locale on a non-translatable field, from the API or an
  importer** → applied. The renderer honours it (decision 4) and the audit reports
  it. Refusing it in the object would require schema knowledge the object
  deliberately does not have.
- **Presence and selection** → unchanged: selection is a uid, and two people on the
  same block in different locales is a normal, non-conflicting state. Showing *which
  locale* a peer is editing belongs to `../editing/live-collaboration.md`.
- **`noindex` per locale** → falls out if the host marks the field translatable;
  otherwise one value covers every locale. No special case.

## Testing requirements

**Unit:** `valueOf`'s full matrix (translated / empty / null / absent / fallback
chain / no locale); locale-scoped `apply`, `invert`, `diff` round-trips; the
absent-locale compatibility property (a log of pre-v3 mutations produces an
identical document).

**Workers:** rendering per locale including fallbacks and zero-JS; construction
validation of the locale config; the title caches; preview with `?locale=`.

**End to end (`scripts/i18n-test.mjs`, new):** two clients on one story in
different locales — assert both edits land, neither overwrites, each undoes only its
own; publish once and assert both language URLs serve; restore a version and assert
translations survive; assert an old-format log still bootstraps identically.

## Dependencies

- `../foundation/schema-migrations.md` — for the source-locale swap case, for the
  audit that finds unmarked and mis-marked fields, and because both spend a wire
  version and should not do so in the same release by accident.
- `../foundation/document-types.md` — `titleOf` and `summarise` become locale-aware
  in the same edit.
- Consumers: `collections.md`'s index is per `(story, locale)`;
  `../platform/content-api.md` takes a locale on reads and writes; `globals.md`
  needs nothing — a global is a document and inherits all of this.

## Out of scope

- **Translated slugs / per-locale paths** (checkpoint 4). Additive later:
  `stories.path_i18n` plus a locale-aware `storyByPath`.
- **Per-locale publishing.** Checkpoint 3.
- **Locale-specific structure** (a block that exists only in French). The trade this
  model makes; the story-per-locale model is what buys it back, and that is a
  different spec.
- **Machine translation.** A "translate this page with an LLM" action is
  application code over the content API, not a CMS primitive — and it should write
  through `commit` like anything else.
- **Locale-scoped roles** ("this person may edit French only"). Needs per-field
  permission checks in the Durable Object; the shape is obvious (the attachment
  already carries a role) and it is not needed until a real translation team is.
- **Right-to-left layout.** A host stylesheet concern; the locale config carries a
  `dir` hint at most, and even that is deferred until asked for.

## Open questions

- Should the source value appear as a placeholder or as a second read-only column in
  the inspector? Placeholder is proposed for noise reasons, but it is wrong for
  richtext (a placeholder cannot show formatting), so richtext may need the column
  anyway — in which case consistency argues for the column everywhere.
