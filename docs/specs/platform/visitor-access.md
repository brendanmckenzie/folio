# Feature: Visitor access — the host's members, Folio's page read

> **Group:** platform
> **Build order:** 31
> **Size:** M
> **Status:** draft
> **Wire version:** none
> **Migration:** none
> **Build sequence:** 1 of 4 — 31 → 30 → 28 → 29 (owner, 2026-09-05). The **Build order** above is this spec's identity, not its place in the queue.
> **Last updated:** 2026-09-05

## Summary

A site whose membership lives outside Folio — the host's own accounts, Auth0,
Memberstack — has pages only members may read, or only members with a certain
privilege. Folio never knows who a visitor is, and must not start to. This spec adds
one config key, `gate`, that names a root-block field and two host predicates;
`reader.page()` consults them and answers `access: 'public' | 'granted' | 'denied'`,
hands back a **redacted** document on deny so the host can render a teaser, and
answers `private, no-store` for anything whose content varied by visitor.

`src/server/index.tsx:518-520` is the gap. Every published render today gets
`cacheHeaders`, so a members-only page answered through `page.headers` is members-only
content in a shared cache under its real URL — the same trap `draft-mode.md`
decision 3 closed for drafts, open again for a second kind of restricted content.
`ROADMAP.md:578-587` has named the attachment point since July: "a field on the root
block … and a host check before `folio.published()`". Nothing is built.

## Ground truth

Verified 2026-09-05 against `main` at `0f0df54`.

**core (`src/core/`):**
- `Indexable` (`fields.ts:72-74`) is mixed into exactly the five scalar kinds
  (`fields.ts:83-87`); `richtext({ indexed: true })` does not compile. `translatable`
  is on `Common` (`fields.ts:48`), so a `select` *can* be marked translatable today.
- `defaultValue(select)` is `options[0]?.value ?? ''` (`fields.ts:258-265`): a seeded
  document always carries the **first option**, never an absent value. A gate's
  "public" value therefore has to be named, not defaulted.
- `indexRowsFor` (`index-projection.ts:152`) writes one `content_index` row per
  (locale, field) for the root block's indexed fields, reading through `fieldValue`
  (`:179`). `indexedFieldNames` (`:87`) is the set `where` and `order` are checked
  against.
- `fieldValue` lets an `i18n` value win over `data` unconditionally (`locales.ts:81-91`);
  `dataOf` layers the same way (`:103-112`). Both are the *renderer's* rule.
- `TextOp` includes `'in'` (`query.ts:25`); `server/query.ts:87-92` compiles it to
  `text_value in (…)`. A host can filter a list on a gate field's values with nothing
  added.
- `ReferenceTarget` carries `data: dataOf(root)` **and `doc: Doc`** (`resolve.ts:318-326`,
  filled at `:363`); `server/query.ts:253-265` fills both from `published_doc`.
  **Every `folio.query` item and every `collection` item is the whole published
  document.** This is the fact the "lists untouched" decision has to be honest about.
- `asRichtext(null)` is `null` (`richtext.ts:94-106`). `RenderBlok` hands a `richtext`
  field through `asRichtext` (`preview/Render.tsx:107-115`) and renders an empty
  `blocks` slot as `null` outside edit mode (`:136-140`). A document with only its
  root blok and nulled richtext renders cleanly with `mode: 'off'`.
- `NO_STORE = 'private, no-store'` (`cache-tags.ts:47`); `cacheHeaders` (`:225-230`) is
  the only producer of a `cache-tag` header.
- `Json` is `doc.ts:3`, `Blok` `:13`, `Doc` `:42`; `StoryMeta` is `story.ts:8`.

**server (`src/server/`):**
- `reader(env, req)` closes over both `env` and the optional `req` (`index.tsx:389-392`).
  `wantsDraft()` (`:404-407`) is a string test on the `Cookie` header and reads no
  binding; `draftFor()` (`:422-442`) is the authority half: an editor with
  `READ_DRAFT`, or a share grant for this story. `page()` (`:477-522`) is `pageAt` →
  `drafted` → `rt.resolve` → `headers: drafted ? NO_STORE : cacheHeaders(...)`
  (`:518-520`).
- `FolioPage` is `types.ts:170-199`; `FolioPageOptions` `:202-210`; `FolioReader.page`
  `:212-218`. `FolioConfig` is `types.ts:270-446` and has no `gate` or `access` key;
  `hooks?` is `:386`, `draftMode?` `:445`. `folio.noStore()` is `types.ts:698`,
  implemented at `index.tsx:569`.
- Construction-time validators run in `createRuntime` (`runtime.ts:346-379`):
  `validatePresets` (`:352`), `validateTypes` (`:357`), `validateHooks` (`:360`),
  `validateGlobals`, `validateMigrations`, `validateLocales`, `resolveAuth`.
  `validateHooks` (`hooks.ts:196-204`) is the throw-naming-the-key pattern;
  `validateTypes` (`schema.ts:294-365`) is the "a key that reads as a constraint and
  enforces nothing throws" pattern — `under` on a record (`:325-327`).
- `cacheVerdictFor` (`cache-request.ts:131-152`) answers `bypass` for any Folio
  credential and `null` for host paths. **Nothing in `src/` sets `Vary`.** A request
  `Cookie` is not a Workers Cache bypass and not in its key
  (`docs/specs/platform/caching.md:365-371`, `README.md:1704-1716`).
- `?_folio=preview|draft` (`index.tsx:258`, `:304`) requires `READ_DRAFT` or a share
  grant and is answered with `NO_STORE` (`pages.tsx:473`). `api/v1` reads need a token
  (`docs/api.md`); MCP dispatches to v1 routes. All editor-credentialed.
- `Access` is already an exported type — the role/scope pair (`index.tsx:165`,
  `auth/roles.ts`) — and `NO_STORE` is exported at `:210`.

**admin (`src/admin/`):**
- A Content row draws two badges, type and state, from the `stories` row alone
  (`ui/screens/Content.tsx:814-815`); it holds no document and no `content_index`
  row. The inspector already edits any root-block field under "Page settings".

**tests:**
- `test/workers/read-session.test.ts:386-448` pins `reader.page()` today: both
  headers on a published page (`:387-398`), `no-store` and no `cache-tag` on a draft
  (`:418-429`, using `auth: 'open'` plus `folio_draft=1`), null for nothing to show,
  refused unknown locale. `spyOn(db)` is `:79`.
- `test/workers/draft-mode.test.ts:104-122` has the `prepare`-counting Proxy for
  "never touched the database"; the file builds its own `createFolio` (`:43`).
- `test/unit/server/pure.test.ts:1226-1266` is the validator test shape
  (`validateHooks`: accepts undefined, accepts every key, throws naming the unknown
  one).

**demo (`examples/demo/src/`):**
- `index.tsx:250` `folio.handle`, `:260` `folio.reader(env, req)`, `:301-304`
  `reader.page(path, { locale, page })`, `:313` `reader.miss`, `:339` `page.headers`.
  `/archive` is `:220`, a `folio.query` at `:510`. `dataOf(root, resolution.locale)`
  at `:429` is the locale-correct metadata read.
- `blocks/page.tsx:11-50` is the `page` root (title, description, socialImage,
  noindex, body slot). `blocks/insight.tsx:50-56` has an `indexed: true` `select`
  (`topic`), deliberately *not* translatable, with the reason in its comment.
- `migrations.ts:62-64` is the `field.default` content migration that backfills a
  field added after documents existed — the remedy edge case 1 below points at.

**docs:**
- `ROADMAP.md:578-587` and `identity-and-access.md:593-596` name the two attachment
  points. `README.md:589-598`: page metadata lives on the root block, per type; there
  is no per-story JSON bag on `stories`. `AGENTS.md:88-98` is the host snippet that
  gains a branch.

## Owner decision checkpoints

1. **The key is `gate`; the outcome is `page.access`.** `Access` is already the
   exported role/scope type and the admin has an "Access" screen for users. The
   mechanism is a gate; the result is access. Recommended.
2. **Only `gate.public` is ungated; an absent value goes to `allows`.** Fail closed on
   a missing key. Cost: `visitor` runs and the page is `no-store` until a one-line
   `field.default` migration backfills it — the pattern `examples/demo/src/migrations.ts`
   `0002` already teaches. The alternative, absent-means-public, fails in the
   disclosure direction. Recommended.
3. **A page type whose root lacks the field is public**, and `visitor` is never called
   for it. At least one `page`-kind root must declare the field or construction throws
   (a `gate` that gates nothing). Recommended over "throw if any page root lacks it":
   a root without the input cannot mislead an editor into thinking a page is gated,
   and a site with one members-only type and five public ones should not have to add
   a dead field to five roots.
4. **The field must be `indexed: true`**, or construction throws. Lists are untouched
   by decision, so the host's ability to filter them is the whole remedy; forgetting
   `indexed` would leave gated titles in every public list with no fix short of a
   schema change plus a reindex. Recommended. **A second reason, from 2026-09-05:**
   spec 30 decision 11 compiles the gate into a `content_index` predicate to keep
   gated rows out of a search, and it can only do that because the field is indexed.
5. **Deny answers a redacted document**, not `null`: root blok kept, every child blok
   dropped, every `richtext` on the root nulled in `data` and `i18n`. Recommended over
   a per-type `teaser: [...]` list (decision 4).
6. **Lists stay untouched, including `item.doc`.** A `collection` or `folio.query` item
   is the full published document (Ground truth). The spec states it and the README
   warns: filter with `where`, render a lock from `item.data.<field>`, never serialise
   `item.doc` or `item.data` wholesale. Flipping this — applying `redactDoc` to gated
   items inside `runQuery` — is visitor-independent and S-sized; offered as a
   follow-up, not built here. Recommended: untouched, per the owner's decision.
   **One exception, decided 2026-09-05: full-text search.** Spec 30's `snippet()`
   returns a marked extract of exactly the prose `redactDoc` withholds, so an
   unfiltered search page does not merely list a gated document, it renders the
   withheld half of it with the matched words highlighted. Spec 30 decision 11 scopes
   any query carrying a `search` term to `gate.public` unless the caller filters the
   field itself. Nothing in *this* spec changes; the clause is compiled in
   `contentSql`, which is why 31 lands before 30 (Dependencies).
7. **No request-side knowledge of the visitor credential**: `cacheVerdict` is
   unchanged, no `gate.cookies`. The response header carries the property (decision 5).
   Recommended.
8. **No admin change.** No lock glyph in the tree; the inspector already edits the
   field. Recommended.
9. **The demo wires it with a fake cookie visitor, plus a short e2e.** The workers
   suite carries the weight; the demo exists because a contract with no consumer is
   prose (`draft-mode.md` phase 4's reasoning). Recommended.

## User stories

### A member reads a members-only page
**As** a site visitor signed in to the host's membership system **I want to** open a
members-only page at its ordinary URL **so that** the host's own login is the only
one I ever see, and the page is the same page a public visitor would get if it were
public.

### A stranger sees the teaser, not the body
**As** a visitor without membership **I want to** land on a members-only page and see
its title, standfirst and a way to join **so that** I know what I am missing, without
the body leaking through view-source or a cached copy.

### An editor marks a page members-only
**As** an editor **I want to** set one field under "Page settings" **so that** the
page is gated on the next publish, with no developer involved and no second place to
remember.

### A host adds gating in a dozen lines
**As** a host developer **I want to** declare who a visitor is and what they may read
**so that** Folio decides per request, keeps gated pages out of the edge cache, and
my page route stays one `reader.page()` call.

## Architecture decisions

### 1. `gate` names the field and splits *who* from *may*: `visitor(req, env)` and `allows(visitor, value, ctx)`

```ts
// src/server/types.ts
import type { Json } from '../core/doc'

export interface FolioGateContext {
  story: StoryMeta
  doc: Doc
  locale?: string
}

/**
 * Method signatures, deliberately, not property-typed arrows: a host-built
 * `FolioGate<Env, Member>` has to be assignable to the `FolioGate<Env, unknown>` this
 * config holds, and under `strictFunctionTypes` only *method* parameters are
 * bivariant. Property-typed functions would force every host to write `unknown`
 * and cast.
 */
export interface FolioGate<Env, V = unknown> {
  /** A root-block field: `indexed: true`, never `translatable`, one of the five scalar kinds. */
  field: string
  /** The one stored value that means "no gate". Anything else — including no value at all — reaches `allows`. */
  public: string | number | boolean
  /** Who is asking. Runs at most once per reader, and never for an ungated page. */
  visitor(req: Request, env: Env): V | null | Promise<V | null>
  /** May this visitor read a document whose field holds `value`. */
  allows(visitor: V | null, value: Json | undefined, ctx: FolioGateContext): boolean | Promise<boolean>
}

// FolioConfig<Env> gains:
gate?: FolioGate<Env>
```

Folio decides "ungated" by one strict comparison, `root.data[field] === gate.public`,
**before** touching `visitor`. That is the property the whole design turns on: a
public page stays cached and costs no host call, and the host's `visitor` — which may
verify a token or call an API — runs only when a document has asked for it.

**Rejected: a single `gate(ctx) => 'public' | 'allow' | 'deny'`.** Folio cannot know
the answer is request-independent without calling it, so every public page view runs
host code holding a `Request`; the host re-derives "read the field off the root" (and
the `dataOf`/locale trap with it); and nothing names the field, so Folio can neither
refuse `translatable` nor require `indexed`.

**Rejected: `visitor` + `allows` without `field`.** The same failure in a smaller
coat: with no field to read, "is this page gated at all" is a host call.

**Rejected: `FolioConfig<Env, V>` to infer `V`.** Every host writes
`createFolio<Env>(…)` with an explicit type argument (the demo, `AGENTS.md`), and an
explicit argument disables inference for the rest, so `V` would always be `unknown`.
Method signatures let a host declare `const gate: FolioGate<Env, Member> = {…}` and
pass it.

**Rejected: `public` optional with a default of absent/null/`''`.** A `select` seeds
its first option (`fields.ts:264`), so that default gates every new page silently, and
every page goes `no-store` with nothing saying so.

### 2. The value is read from `data`, never `i18n`, and `translatable` is refused at construction

A gate that differs by language is a hole: a French translation of "members" that
reads "public" opens the English page to anyone who asks in French. So `validateGate`
throws on `translatable: true`, and the read is `doc.bloks[doc.root].data[field]`,
not `fieldValue`. A value an importer put in `i18n` anyway is ignored by the gate, and
the audit already reports an `i18n` value on an untranslatable field. `content_index`
rows for other locales carry the same source value (there is no translation to win),
so a host's `where` filter agrees with the gate.

**Rejected: read through `fieldValue` like every other field.** The renderer's "if it
is in `i18n` it wins" rule (`fields.ts:40-44`) exists so un-marking a field does not
hide translated content. For a gate the same rule would let a stray locale value open
a page, which is the one direction this spec must not fail in.

### 3. The outcome rides on `FolioPage.access`; `page()` never returns `null` for a gated page

```ts
// src/core/gate.ts (pure) — re-exported from folio/server and folio/core
export type PageAccess = 'public' | 'granted' | 'denied'

// src/server/types.ts
export interface FolioPage {
  doc: Doc            // on 'denied', the redacted document (decision 4)
  story: StoryMeta
  resolution: Resolution
  draft: boolean
  /** Always present. 'public' for every page on a host with no `gate`. */
  access: PageAccess
  headers: Record<string, string>
}
```

The host's page route reads one more field and branches once:

```tsx
const page = await reader.page(path, { locale })
if (!page) { /* miss, as today */ }
return html(
  <Page doc={page.doc} resolution={page.resolution}
        paywall={page.access === 'denied'} />,
  page.headers,        // already right: no-store for granted and denied
)
```

**Rejected: `null` on deny.** The host's miss branch turns it into 404/410, which is
both wrong (the page exists) and loses the teaser.

**Rejected: a separate `reader.access(path)`.** Reads the row twice and is
forgettable — the two reasons `page()` exists (`types.ts:161-168`) apply verbatim.

**Rejected: gating `published()` and `draftAt()` too.** `published` promises "the
published document or null"; it has no way to spell denied, and answering a redacted
doc from it would be the surprising kind of wrong. They stay raw reads. The README and
`AGENTS.md` already say a page route calls `page()`, and this spec adds one more reason.

### 4. Deny hands back a redacted document: the root, minus its body

```ts
// src/core/gate.ts
export function redactDoc(doc: Doc, schema: SchemaIndex): Doc {
  const root = doc.bloks[doc.root]
  if (!root) return { root: doc.root, bloks: {} }
  const fields = schema[root.type]?.fields ?? {}
  const data = { ...root.data }
  let i18n = root.i18n
  for (const [name, field] of Object.entries(fields)) {
    if (field.kind !== 'richtext') continue
    data[name] = null
    if (i18n) {
      i18n = Object.fromEntries(
        Object.entries(i18n).map(([code, map]) => [code, { ...map, [name]: null }]),
      )
    }
  }
  // Only the root survives, so every `blocks` slot is empty by construction.
  return { root: doc.root, bloks: { [doc.root]: { ...root, data, ...(i18n ? { i18n } : {}) } } }
}
```

Children and richtext are *the prose*. Every scalar, asset, link and reference left
on the root is page metadata by the sanctioned model (`README.md:589-598`) and is the
same set a `collection` item renders a card from. The host renders `<Page
doc={page.doc}>` unchanged — `folio.render` draws the root with `body = null`
(`Render.tsx:136-140`) — and puts its paywall where the body was. `resolve()` runs over
the redacted doc, so the resolution loads the root's own targets (hero asset, author
record) and every configured global, and nothing the body pointed at.

**Rejected: the full doc plus "the host promises not to render the body".** It is the
`cacheHeaders`/`noStore` trap again: two shapes that look interchangeable, one of them
leaks, and the leaking one is the default.

**Rejected: no doc, `story` and `resolution` only.** Loses title, description,
standfirst and hero for the teaser, and a resolution built from the full doc still
carries the titles and URLs of everything the body links to.

**Rejected: a per-type `teaser: ['title', 'description', 'hero']` list.** A second
description of the schema, and the default rule already draws the line where the
content model draws it. A type that wants a scalar hidden can move it into a child
block, which is where hidden-from-strangers content belongs.

### 5. `granted` and `denied` are `private, no-store`; `public` keeps `cacheHeaders`

```ts
headers:
  drafted || access !== 'public'
    ? { 'cache-control': NO_STORE }
    : cacheHeaders(resolution, { story: found.story.id }),
```

The same URL answering differently to different visitors is the one thing a shared
cache cannot represent. `denied` is `no-store` too: a cached teaser would be served
from the edge to a member who has just signed in. The publish that turns a public page
into a gated one purges `story:<id>` through the internal cache hook (`caching.md`), so
no public copy outlives the change.

**Rejected: `Vary: Cookie`.** Workers Cache does not honour it (`README.md:1716`), the
credential may not be a cookie at all (an `Authorization` header, a Memberstack token
in a query string), and a `Cookie` variant would be per-visitor anyway. `no-store` is
the only header that is right whatever `visitor` reads.

**Rejected: `gate.cookies?: string[]` feeding `cacheVerdict`.** Duplicates what the
response header already guarantees, teaches Folio the shape of the host's credential,
and is wrong for a header credential. `cacheVerdict` is about Folio's own paths; the
host's page is the host's.

**The cost, stated so nobody discovers it in production.** `cacheVerdictFor` answers
`null` for a host path (`cache-request.ts:151`), which means Folio has no opinion and
the response header is the whole of the control. So this decision is exactly as
strong as it reads: **every gated page is uncacheable at the edge, forever, for
everyone** — `denied` as well as `granted`. On a mostly-members site that is the whole
of the cache hit rate, and every view becomes an origin render plus one `visitor`
call. The teaser is visitor-independent and therefore *looks* cacheable, which is
precisely why it must not be: Workers Cache has no way to answer it to a stranger and
not to the member who signed in a second later. A host that wants a cached teaser
serves it from a URL of its own, where it owns both halves of the decision.

### 6. A Folio credential skips the gate

In `page()`, `drafted !== null` means an editor in draft mode or a reviewer holding a
share grant for this story (`index.tsx:422-442`). `visitor` and `allows` are not
called; `access` is `'public'` if the draft's field value equals `gate.public`, else
`'granted'`; the headers are already `no-store`. Reviewers and editors therefore always
see gated content, which is what a review is. `?_folio=preview|draft`, `{base}/share`,
`api/v1` and MCP reads all sit behind `READ`/`READ_DRAFT` or a grant and are unaffected
by this spec.

**Rejected: running the gate on editors too.** The editor is not a member of the
host's site and has no host credential; gating them would make the draft they are
about to publish unreadable to the person publishing it.

### 7. A gate that cannot decide denies, logs, and never throws

`visitor` or `allows` throwing — the IdP is down, a token is malformed — is
`console.error('folio: gate.visitor threw; denying', err)`, `access: 'denied'`, the
redacted doc, `no-store`. The host's route answers a paywall, not a 500, and the log is
where the outage shows. A reader built without a `Request` (a sitemap build, a warm-up)
cannot call `visitor`; it calls `allows(null, value, ctx)`, because "no request" is
"nobody".

**Rejected: rethrow and let the host's error handler decide.** The host's handler has
no idea which headers to answer with, and the natural one — whatever it answers
everything else with — is cacheable.

### 8. Validation at construction, in the existing chain

```ts
// src/server/gate.ts
export function validateGate<Env>(
  gate: FolioGate<Env> | undefined,
  types: readonly DocumentType[],
  schema: SchemaIndex,
): ResolvedGate | null
```

Called from `createRuntime` after `validateTypes` (it needs `types` and `schema`), and
throws, naming the type and field and rule, when:

- no `kind: 'page'` root declares `field` (a gate that gates nothing);
- a declaring root's field is not `text`, `textarea`, `number`, `boolean` or `select`;
- the field is `translatable` (decision 2);
- the field lacks `indexed: true` (checkpoint 4);
- `public` is a `select` value not among its `options`, or the wrong primitive for a
  `boolean`/`number`/`text` field.

A `record` or `singleton` root declaring the field is ignored: unrouted documents
never reach `page()`. `ResolvedGate` carries the config plus a precomputed
`roots: Set<string>` of declaring root block names, so `page()`'s ungated check is
`roots.has(root.type) && root.data[field] === public` and nothing else.

It carries a second set, `types: ReadonlySet<string>` — the **document type** names
whose root is one of those roots. `page()` never needs it; spec 30 decision 11 does,
because a SQL predicate can see `stories.type` and cannot see a root block's name. The
two sets are built in the same walk. Note they are not interchangeable: two types may
share a root, and a root block name is not a type name.

**Rejected: tolerate every misconfiguration and treat it as public.** That is
`validateTypes`' `under`-on-a-record case (`schema.ts:325`): a key that reads as a
constraint and enforces nothing. Here the silent failure is a page everyone can read
while the editor believes it is gated.

## Wire & schema changes

### D1 migration

None. The gate field is an ordinary `indexed` root-block field, and `indexRowsFor`
already projects it into `content_index` on publish. There is nothing new to store:
the decision is per request, and the inputs are the document and the host.

### Core types

- `PageAccess` (new, `src/core/gate.ts`), `redactDoc(doc, schema)`, `gateValue(doc,
  field): Json | undefined`, `isUngated(value, publicValue)` — all pure, exported from
  `folio/core` beside `dataOf`.
- `FolioPage.access: PageAccess` — additive and always present, so a host that reads
  it on a gate-less deployment gets `'public'` rather than `undefined`.
- `FolioConfig.gate?: FolioGate<Env>`, `FolioGate`, `FolioGateContext` (new,
  `src/server/types.ts`, exported from `folio/server`). `ResolvedGate` (internal,
  `src/server/gate.ts`) carries `roots` and `types` (decision 8).
- No `Doc`, `Blok`, `Field` or `Mutation` change. `PROTOCOL_VERSION` unchanged.

### New or changed routes

None. `reader.page()` is a library call, not a route, and the host's page route is the
host's.

## Acceptance criteria

### A host without a gate is unchanged

```
GIVEN a host with no `gate` configured
WHEN reader.page(path) answers a published page
THEN access is 'public'
AND headers carry Cache-Control s-maxage and Cache-Tag
AND the response is byte-identical to today's
```

### A public page costs no host call

```
GIVEN gate: { field: 'access', public: 'public', visitor, allows }
AND a page whose root holds access = 'public'
WHEN a visitor with no credential requests it
THEN visitor is never called
AND allows is never called
AND headers are cacheHeaders
```

### A member is granted

```
GIVEN a page whose root holds access = 'members'
WHEN visitor answers a member and allows answers true
THEN access is 'granted'
AND doc is the full document
AND headers are exactly { 'cache-control': 'private, no-store' }
AND no cache-tag header is present
```

### A stranger is denied a teaser

```
GIVEN a page whose root holds access = 'members'
WHEN visitor answers null and allows answers false
THEN access is 'denied'
AND doc holds only the root blok
AND every richtext on the root is null in data and in every i18n locale
AND the root's scalars, asset, link and reference values are intact
AND resolution carries every configured global
AND headers are private, no-store
```

### A root without the field is public

```
GIVEN a page type whose root block does not declare the gate field
WHEN any visitor requests a page of that type
THEN access is 'public'
AND visitor is never called
```

### An editor is never gated

```
GIVEN a gated page
AND an editor holding the draft cookie, or a reviewer holding this story's share cookie
WHEN reader.page() runs
THEN draft is true
AND access is 'granted'
AND visitor is never called
```

### The gate fails closed

```
GIVEN visitor throws
WHEN reader.page() runs on a gated page
THEN page() resolves rather than rejects
AND access is 'denied' with private, no-store
AND the error is logged
```

### Construction refuses a gate that cannot work

```
GIVEN createFolio with a gate whose field is translatable,
  OR not indexed,
  OR declared on no page root,
  OR whose public value is not one of the select's options
THEN construction throws naming the type, the field and the rule
```

## Implementation plan

### Phase 1 — pure core

1. `src/core/gate.ts`: `PageAccess`, `redactDoc(doc, schema)`, `gateValue(doc, field)`,
   `isUngated(value, publicValue)` (strict equality).
2. Export from `src/core/index.ts`.
3. `test/unit/core/gate.test.ts`.

Nothing consumes it yet; the tree stays green.

### Phase 2 — config and validation

1. `src/server/types.ts`: `FolioGate`, `FolioGateContext`, `FolioConfig.gate`,
   `FolioPage.access` (typed now, filled in phase 3 as `'public'` unconditionally so
   the tree compiles).
2. `src/server/gate.ts`: `validateGate` and `ResolvedGate`, including the
   `types: ReadonlySet<string>` set spec 30 decision 11 compiles its predicate from
   (decision 8). Built here even though nothing in this spec reads it, because it
   falls out of a walk `validateGate` already does and the alternative is 30 walking
   `types` a second time.
3. `src/server/runtime.ts`: call it in `createRuntime` after `validateTypes`; add
   `FolioRuntime.gate: ResolvedGate | null`.
4. Re-export the types from `src/server/index.tsx`.
5. `test/unit/server/gate.test.ts`.

### Phase 3 — `reader.page()`

1. `src/server/index.tsx`: a per-reader memoised `visitorOnce()`; the decision after
   `drafted` is known and before `rt.resolve`; `access` on the return; the header rule
   from decision 5. `FolioPage.access`'s doc comment states the trap the header rule
   closes, in the voice `headers`' comment already uses.
2. `test/workers/gate.test.ts`, with its own `createFolio` like `draft-mode.test.ts`.

### Phase 4 — the consumer and the prose

1. Demo: an `access` `select` on `examples/demo/src/blocks/page.tsx` (`Everyone` /
   `Members`, `indexed: true`, help text saying what it does); `gate` in
   `examples/demo/src/index.tsx` with a `demo_member=1` cookie stand-in, commented as a
   fake and as the pattern a host replaces with its real membership check; a `paywall`
   prop on `<Page>` rendered when `page.access === 'denied'`; the `/archive` route
   gains `where: [{ field: 'access', op: 'eq', value: 'public' }]` as the list-filter
   example.
2. `scripts/gate-test.mjs`: publish `about` as members via
   `PATCH /api/v1/documents/:id/fields`, fetch with and without the cookie, assert
   headers and body.
3. README: `## Visitor access` after `## Auth`; amendments to "One page, one call",
   Caching "Traps", Collections, "Not built yet", and one sentence in "Prose pages".
4. `AGENTS.md:88-98`: the snippet gains the `page.access` branch.
5. `ROADMAP.md:578-587` moves to Done pointing here; `identity-and-access.md` Out of
   scope points here; `docs/specs/README.md` row 31.

## Edge cases

- **Field absent from a document** → not `=== public` → `allows(visitor, undefined,
  ctx)`; `visitor` runs; the page is `no-store` until backfilled. Remedy: a
  `field.default` content migration (`examples/demo/src/migrations.ts:62-64`), which
  rewrites the published snapshot too. Stated in the README beside the `tone`
  precedent.
- **Root type lacks the field** → public, `visitor` never called (checkpoint 3).
- **Record or singleton root declares the field** → inert: unrouted documents never
  reach `page()`. Globals are singletons and are always resolved into a denied page's
  resolution, because the host needs its header and footer.
- **`translatable: true` on the field** → throws at construction. **An `i18n` value
  written by an importer** → ignored by the gate (decision 2), found by the audit.
- **`visitor` or `allows` throws** → denied, logged, `no-store`; never a rejection out
  of `page()`.
- **Reader with no `Request`** → `visitor` not called; `allows(null, value, ctx)`.
- **Editor in draft mode, or a reviewer with this story's grant** → gate skipped,
  `granted`, `no-store`. **A share cookie for a different story** → not drafted; the
  gate runs as the anonymous visitor.
- **`auth: 'open'` plus `folio_draft=1`** → drafted → gate skipped. Not new: `'open'`
  already means anyone who reaches the editor may edit.
- **A public page that becomes gated on publish** → `story:<id>` purged by the
  internal hook; no public copy survives. **Gated → public** → nothing cached to go
  stale.
- **A `reference` field on a public page pointing at a gated page** →
  `resolution.docs` holds the full target and `reference.content` renders it. Named,
  out of scope; the remedy is `reference({ types: [...records] })` so a page block
  cannot inline another page.
- **`collection` and `folio.query` items for gated documents** → `item.doc` and
  `item.data` are the full document (Ground truth). Filter with `where: [{ field:
  'access', op: 'in', value: [...] }]`, render a lock from `item.data.access`, never
  serialise items wholesale. Checkpoint 6.
- **Search engines are visitors** → a gated page answers its teaser to a crawler; a
  host that does not want the teaser indexed sets `noindex` on that page. README note.
- **The denied response's status** → the host's: a 200 teaser, a 401/403, or a
  redirect to sign-in. Folio returns no status because it returns no response.
- **`page()` called twice on one reader** → `visitor` runs once (memoised).
- **`public` compared strictly** → `0`, `false` and `''` are three different values;
  a boolean field with `public: 'false'` throws at construction rather than gating
  everything.

## Testing requirements

**Unit (`test/unit/core/gate.test.ts`):**
- `redactDoc` keeps root scalars, asset, reference and the gate field itself; nulls
  every richtext in `data` and in each `i18n` locale; drops all children whatever slot
  they were in; handles a doc whose root is missing.
- `isUngated` is strict equality (`0` vs `false` vs `''` are three values).
- `gateValue` reads `data`, never `i18n`.

**Unit (`test/unit/server/gate.test.ts`):**
- `validateGate` accepts a good config and returns the declaring roots; throws for no
  declaring page root; for kind `blocks`/`richtext`/`asset`; for `translatable`; for
  missing `indexed`; for a `select` `public` not in `options`; for a boolean field
  with a string `public`; ignores a record root declaring the field. Each message
  names type, field and rule (the `validateHooks` shape at `pure.test.ts:1226-1266`).
- `ResolvedGate.types` holds the document type names, not the root block names, and
  holds both of two types sharing one declaring root. This is what spec 30 decision
  11's predicate binds, so getting it backwards would scope a search by a name
  `stories.type` never holds and silently exclude nothing.

**Workers (`test/workers/gate.test.ts`, real workerd, own `createFolio` like
`draft-mode.test.ts`):**
- `a host without gate answers access public and both cache headers, exactly as before`
- `a public page keeps both cache headers and never calls visitor`
- `a page whose root lacks the field is public and never calls visitor`
- `a gated page calls visitor once and allows once; granted answers the full doc with private, no-store and no cache-tag`
- `denied answers the redacted doc, resolves globals, and answers private, no-store`
- `a visitor that throws denies and logs, and page() resolves`
- `an allows that throws denies`
- `a missing value is not public: allows receives undefined`
- `a reader with no Request never calls visitor and hands allows null`
- `an editor in draft mode is never gated` (`auth: 'open'` plus `folio_draft=1`, as
  `read-session.test.ts:418-429`)
- `a share cookie for this story skips the gate; for another story the gate runs`
- `visitor resolves once per reader across two page() calls`
- `the gate reads data, never i18n`
- `folio.query where access in [...] excludes gated rows`

**End to end (`scripts/gate-test.mjs` against a live dev server on port 5199, requires
phase 4's demo):**
- `/` is public with `s-maxage`; `PATCH` about to members; `/about` anonymous →
  paywall marker present, body text absent, `private, no-store`; with `demo_member=1`
  → body present, `private, no-store`; `/archive` omits about. Follows the
  `scripts/*-test.mjs` conventions: `signInGlobally()` for the write,
  `PROTOCOL_VERSION` on every frame if a socket is opened.

## Dependencies

- Spec 13 (collections): `indexed`, `content_index`, the `in` operator the host
  filters lists with.
- Spec 17 (caching): `cacheHeaders`, `NO_STORE`, the internal purge hook that clears a
  page the moment it becomes gated.
- Spec 25 (draft mode): `wantsDraft`/`draftFor`, and the "Folio decides, the host
  renders" shape this spec extends to a second kind of restricted read.
- **Spec 30 (full-text search): this spec lands first.** 30's decision 11 reads
  `ResolvedGate` to keep gated documents out of an unfiltered search, so the gate has
  to exist before that compiler is written. `validateGate` therefore answers
  `types: ReadonlySet<string>` — the document type names whose root declares the field —
  beside the `roots` set `page()` uses, because `stories.type` is what the SQL predicate
  can see. Building the set here costs nothing: `validateGate` already walks `types`.
- No Cloudflare resources, bindings or host config beyond the `gate` key.

## Out of scope

- **Gating lists, `folio.query` and collections** — owner decision. The exposure is
  stated (`item.doc` is the whole document) and the host filter is the remedy;
  checkpoint 6 offers the S-sized `redactDoc`-in-`runQuery` follow-up.
  **Search is no longer part of this exclusion** (checkpoint 6, revised 2026-09-05):
  spec 30 decision 11 scopes a search to `gate.public` unless the caller filters the
  field. The row is kept out of the result; the `item.doc` half of the exposure is
  unchanged for anything a caller does surface, which is what stays out of scope.
- **Any knowledge of who a visitor is** — no visitor table, no cookie, no session.
  `visitor` is the host's, and `identity-and-access.md`'s `users` stay editors.
- **Gating `published()` and `draftAt()`** — raw reads stay raw (decision 3).
- **Per-story editor permissions** — still `identity-and-access.md`'s other half,
  and a different question (who may *write*).
- **Admin surface** — no lock glyph, no gate column; the inspector already edits the
  field and the tree draws from the `stories` row alone.
- **Request-side cache bypass for host credentials** — decision 5; the response header
  is the guarantee.
- **Hiding a gated page's existence** — a denied page answers its metadata by design;
  a host that wants a 404 for strangers answers one from the `denied` branch.

## Open questions

None. **All nine checkpoints answered by the owner on 2026-09-05**, each to its
recommendation, with two amendments recorded in place: checkpoint 6 now carves out
full-text search (spec 30 decision 11) and checkpoint 4 gains the second reason that
follows from it.

Checkpoint 3 was put to the owner again in that sitting, because it is the one place
this design fails **open** — a `page`-kind root that does not declare the field is
public and `visitor` is never called for it, so a page type added later and not
thought about publishes ungated with no signal, which sits oddly beside checkpoint 2's
fail-closed rule for a missing *value* and beside decision 8's "a key that reads as a
constraint and enforces nothing throws". **Confirmed as specced**, with the two
alternatives on the table and rejected: requiring every page root to declare the field
(a dead field on every genuinely public type), and a per-type `gate: false` opt-out
(a second config key to say what silence already says). Recorded here so it is a
decision taken twice rather than an oversight.

**Build order: this spec is first of the four**, ahead of 30, then 28, then 29.
