# Feature: Form option sources

> **Group:** content model
> **Build order:** 37
> **Size:** L
> **Status:** done (built 2026-11-03)
> **Wire version:** none. Forms cross neither the socket nor the admin↔preview frame shape; the new descriptor keys ride inside the `Resolution` JSON the bridge already carries.
> **Migration:** `0016_option_sources.sql` (a new `option_lists` table and one additive column, `form_responses.option_labels`)
> **Build sequence:** after 35 (form logic, landed). Builds first of the pair, then spec 36 (form actions, `0017_form_actions.sql`); the two ship together as **v1.3.0** (owner, 2026-11-03). Absorbs issue #54 and `ROADMAP.md` §4 item 7. Steps and the `folio/form` hook (#55) follow both.
> **Last updated:** 2026-11-03

## Summary

A `select`, `radio` or `checkboxes` question takes its choices only from a list the
editor types: `FormField.options` (`src/core/forms.ts:121`), required non-empty by
`validateOptions` (`src/core/forms.ts:227-233`) and capped at 100 by `FORM_FIELD`
(`src/server/validate.ts:1838`, `:1875`). A form asking "which trip?" repeats a list
the site already publishes, and drifts from it the first time a trip is added or
retired. A list that lives somewhere else entirely, such as Jambo's country list,
cannot be used at all. group-web's traveller form bypasses Folio for exactly this
reason: it fetches about 250 countries on every load and every submit
(`group-web/app/brands/allaboutafrica/routes/traveller-form.server.ts:61-70`,
`:193-204`). That is over the cap, and the form is hand-built around it.

This adds **option sources**. A question names a source and its settings in
`optionsFrom`, and may keep a short typed list of extras beside it. There is one
registry per brand, under `forms.sources`, and the built-in source is `content`: a
narrowed query over published documents of one type, which resolves on the same
pass as a `collection` field and is localised, cache-tagged and purged the same way.
A host source is a function that returns a list. It is resolved per form and never
per visitor, kept in a D1 table with a last-good copy, and refreshed off the render
path. Every submission is validated server-side against the same list the page was
built from, so a crafted POST naming an unpublished trip, or a country the source
never offered, is `invalid`.

## Ground truth

Read at `0d769b9` (v1.2.4) with a clean tree.

**core (`src/core/`):**

- `FormFieldOption` is `{ value: string; label: string }` (`forms.ts:90-93`).
  `FormField.options` is `readonly FormFieldOption[]` (`forms.ts:121`). The option kinds
  are `select`, `radio` and `checkboxes` (`OPTION_KINDS`, `forms.ts:194`).
- `validateOneField` (`forms.ts:262`) calls `validateOptions(raw.options, name)` for every
  option kind (`forms.ts:298-300`). That call throws on a missing or empty list
  (`forms.ts:227-233`). Unknown keys are not copied: the function builds `field` key by
  key, so a stored key this build does not name disappears on read.
- `readFields` (`server/forms.ts:196-203`) catches a throw from `validateFormFields`,
  logs it and answers `[]`. **A structural failure in one question therefore reads as a
  form with no questions.** Decision 19 follows from this.
- `leafRefusal` (`forms.ts:544`) checks a condition on an option question against
  `declared = new Set(source.options …)` (`forms.ts:553`). A value not in the typed list
  is refused for `select`/`radio`/`checkboxes` (`forms.ts:556-567`). `checkFormLogic`
  (`forms.ts:594`) runs on write only.
- `FORM_FIELD_KEYS` (`forms.ts:670-693`) is `Record<keyof FormField, 'shape' |
  'presentation'>`. A new key does not compile until it is classified there.
  `shapeOf` (`forms.ts:703-719`) projects `options` as values only (`forms.ts:713`).
- `ResolvedFormField.options` (`forms.ts:848`) is what a host renders.
  `ResolvedForm` (`forms.ts:881-910`) is the descriptor.
- `answerOf` (`form-logic.ts:63`) checks `select`/`radio`/`checkboxes` answers against
  `field.options` (`form-logic.ts:75-81`). `formState` (`form-logic.ts:143`),
  `answersFrom` (`form-logic.ts:187`) and `prefillAnswers` (`form-logic.ts:208`) all
  reach options only through it. `LogicField.options` (`form-logic.ts:41`) is
  structural, so the stored `FormField[]` and the compiled `ResolvedForm` both satisfy
  it.
- `ContentQuery` (`query.ts:75-128`), `normaliseQuery` (`query.ts:221-277`) and
  `queryKey` (`query.ts:289-312`). `clampPerPage` caps at `MAX_PER_PAGE` = 100
  whatever `perPageMax` says (`query.ts:192-195`, `:178`). `CollectionValue`
  (`query.ts:358-370`) stores `where` and `order`. `collectionQuery`
  (`query.ts:430-478`) drops a `where` or `order` naming a field the declaration does
  not permit. This is the "double enforcement" this spec repeats.
- `titleFieldOf(type, def)` (`schema.ts:247-254`) gives the root field holding a
  document's title. `titleOf` reads it through the locale chain (`schema.ts:263-278`).
- `cacheTags` (`cache-tags.ts:204`) emits `form:<id>` for every key of
  `resolution.forms` (`:224`). It emits `type:<name>` (scoped per chain scope on a
  multi-site render) for every type named in a collection key (`:226-235`), and
  `story:<id>` for every collection item (`:244-246`). The budget is 1000 tags and
  16 KB (`:41-42`), and going over it coarsens the whole page (`:252-265`).
- `Manifest` (`schema.ts:136-197`) carries `hooks` (names only, `ManifestHooks`
  `:129-134`), `brand` and `settings`. It is served **ungated** by `GET {base}/api/schema`
  (`server/app.ts:154`), and `app.ts:126-150` states the rule for what may go in it:
  only "the declarations a client needs before it can authenticate", and anything that
  would need a caveat in an unauthenticated `curl` goes behind `withActor`.

**server (`src/server/`):**

- `FolioForms<Env>` is declared in `form-responses.ts:2229-2272` with two keys,
  `verify` and `ratePerHour`. `FORMS_KEYS` (`:2280`) refuses any other key at
  construction (`validateForms`, `:2297`). `FolioBrand.forms` (`types.ts:667`) and
  `FolioSingleConfig.forms` (`types.ts:896`) are the same type, so a key added to
  `FolioForms` is per brand on a branded deployment with no further change.
- `BrandRuntime.forms` (`runtime.ts:243`) is the brand's validated forms config.
  `BrandRuntime.manifest` is assembled at `runtime.ts:1844-1849`.
  `BrandRuntime.query` (`runtime.ts:268-273`) requires a `SiteRef` on a branded
  deployment.
- Resolve: form rows are read alongside pass one (`runtime.ts:1356`), nested form rows
  after pass two (`:1567-1573`), and compiled at `:1587-1596`, **before** pass four.
  Pass four runs the collection queries (`:1615-1627`) and returns early when there
  are none (`:1619`). In draft mode, collections are resolved against published
  content and marked `stale` (`:1633-1666`). `queryDeps` (`:1672-1691`) carries the
  db, the indexed set, the locale key, the chain and the gate.
- `compileForm` (`server/forms.ts:555-600`) and `compileField` (`:442-496`) build the
  descriptor key by key. Options are translated through `translateOption` (`:476`).
  `updateForm` (`:913-1013`) bumps `version` when `shapeOf` changes (`:933-934`). It
  receives no brand.
- `GET {base}/api/forms/resolved` (`routes/forms.ts:243-258`) compiles forms for the
  admin's preview. The PATCH route (`routes/forms.ts:282-317`) is the only writer of
  `forms.fields` (`createForm` takes a label and a name only, `validate.ts:1970-1973`).
  It fires `formChanged` on a structural save and otherwise calls `purgeFormLayout`.
- `FORM_FIELD` (`validate.ts:1861-1929`) is a `v.object`, which strips unknown keys.
  `ROADMAP.md:859` names this trap, and the comment at `validate.ts:1898-1901` repeats
  it for logic keys.
- The submit route (`routes/forms.ts:785-1016`) follows the documented order at
  `:744-776`: id, form (the chain check at `:800-813`, where `within` is block-scoped
  inside the `rt.sites` branch), body under `capFor(form)` (`:842`), closed (`:852`),
  honeypot (`:865`), `verify` (`:877-886`), rate (`:888-905`), `prepareUploads`
  (`:912`), `validateSubmission` (`:913-918`), duplicate, put, insert (`:969-985`),
  then `submitted` (`:997`). The locale is `rt.localeOf(body.get(LOCALE_INPUT))`
  (`:977`). `SubmitStatus` is `ok | invalid | closed | rate | verify | error` (`:641`).
- `c.var.site` is `{ id, surface } | null` (`types.ts:1469`), not a `SiteRef`.
- `reader.page()` answers `cache-control: no-store` for a draft, a gated page or
  uncertified params, and `cacheHeaders(resolution, …)` otherwise
  (`server/index.tsx:1370-1372`). This is the one place a published page's caching is
  decided.
- The built-in `title` order sorts by `stories.title` (`server/query.ts:62`), the
  source-locale title.
- `purgeSite` purges once, then again `SITE_PURGE_DELAY_MS` (25 s, `cache-purge.ts:107`)
  later under the request's `waitUntil` (`:292-312`), for the race in which a render
  that began before a write lands after its purge.
- `capFor` (`form-responses.ts:162-172`) is computed **before** the body is read.
  `answerBudget` budgets an option question at `max(1, options.length) × 120`
  characters (`:129-133`).
- `validateSubmission` (`form-responses.ts:546-578`) runs `formState` over
  `answersFrom`, then `validateAnswer` per asked question. `validateAnswer`'s option
  branches check `optionValues(field)` (`:392-394`, `:437-451`).
- `FormResponse` (`form-responses.ts:1023-1034`) is the `submitted` payload's
  `response`. `ResponseRow` (`:1262-1273`) and `RESPONSE_COLS` (`:1278-1279`) are the
  read side. The responses search is `data like ?` (`responseFilterSql`, `:1423-1426`).
- The CSV writes the stored value verbatim (`csvValue`, `:2060-2074`). An option answer
  is therefore its *value*, not its label, today. Columns come from
  `responseCsvColumns` (`:2027-2048`) over keys from `submittedKeys` (`:2130-2150`).
  Field names cannot contain `:` (`CSV_KEY`, `:2050`).
- Purges: `purgeFormLayout` (`cache-purge.ts:331-337`) is a direct purge with no host
  event. A publish purges `story:`, `type:` and `type:*` (`tagsFor`, `:178-182`), and
  the scoped forms (`scopedTagsFor`, `:201-216`). A title-only patch changes
  `stories.title` (`stories.ts:2811`) and purges only `story:<id>`, not `type:`.
- The demo's cron calls `runSchedules` and then `sweepAuth`, side by side
  (`examples/demo/src/index.tsx:510-541`). `sweepAuth` is "not folded into
  `runSchedules`: … a different table" (`types.ts:1221-1223`).

**admin (`src/admin/ui/screens/`):**

- `FormBuilder` (`FormBuilder.tsx:97`) is mounted from `Admin.tsx:1014-1024` with
  `locales` but no manifest. The options editor is `OptionsEditor`
  (`FormBuilder.tsx:1035`), shown when `needsOptions(field.kind)` (`:940`). In this file,
  `source` names the **source locale**, so the new key is named `optionsFrom` to keep
  the two apart.
- `blankField` seeds one option for an option kind (`form-model.ts:204-216`). The
  field reducers copy a field with a spread (for example `form-model.ts:238`), and
  `save` sends `draft.fields` as held (`FormBuilder.tsx:234-248`), so a key the admin
  does not know survives a round trip through it. The builder's own pre-save check is
  `logicRefusal` (`FormBuilder.tsx:175`).
  `removeOption` refuses while a rule compares against the value (`form-model.ts:800-833`).
- `ConditionEditor` offers a question's `options` as the value picker
  (`ConditionEditor.tsx:204-244`).
- `CollectionField` (`fields/CollectionField.tsx:78-269`) fixes the type from the
  schema and renders the filters (`:169-215`), a count (`:217-232`) and a sort
  (`:234-251`). `filterField` (`:47-53`) finds the indexed declaration for a filter name.
- `DocumentPicker` (`fields/DocumentPicker.tsx:61`) picks a routed document.
- Responses show the stored value (`answerText`, `responses-model.ts:181-186`).

**consumer (`takeoffgo/group-web`, read only):**

- One `createFolio` serves two brands. The traveller form needs Jambo `GetCountries`
  (`traveller-form.server.ts:61-70`) and sorts by name (`:93-96`). Its Jambo client is
  built from the request's hostname (`:58`). A source's `load` has no request, so its
  adoption has to choose the endpoint from `env`.

**tests:** `test/unit/core/forms.test.ts`, `form-logic.test.ts`, `query.test.ts`,
`cache-tags.test.ts`; `test/unit/server/form-validate.test.ts`, `form-csv.test.ts`,
`forms.test.ts` (holds the `Required<FormField>` fixture that pins `FORM_FIELD`);
`test/workers/forms.test.ts` (pins the descriptor's exact shape), `form-submit.test.ts`,
`form-responses.test.ts`, `migrations.test.ts`; `test/unit/admin/forms-model.test.ts`,
`responses-model.test.ts`, `collections.test.ts`; `scripts/forms-test.mjs`.

## Owner decision checkpoints

1. **A host source that is down at submit time is validated against its last-good
   list, and a submission is refused only if the list has never loaded** (owner,
   2026-11-03). Decision 8 is how this is applied.
2. **The stored value of a content option is the story id.** Decision 3.
3. **The `content` source lists exactly one document type, published only.** Decision 4.
4. **Sourced options are capped at 500.** The typed list stays at 100. Decision 10.
5. **Responses keep the label the visitor chose, as it read when they submitted.**
   Decision 13.
6. **The builder's source and action metadata come from one signed-in, brand-scoped
   route, `GET {base}/api/forms/registry` (`READ`), answering `{ sources, actions }`.
   Nothing goes on the public Manifest** (owner, 2026-11-03). This spec introduces the
   route with `actions: []`; spec 36 fills `actions`. Decision 17.
7. **v1.3.0 is roll-forward only** (owner, 2026-11-03). `UPGRADING.md` says plainly
   that it cannot be rolled back to v1.2.x, and lists what would break. There is no
   tolerance patch on 1.2.x. Decision 19.
8. **Specs 36 and 37 ship together as v1.3.0, 37 built first. This spec takes
   `0016_option_sources.sql`, spec 36 `0017_form_actions.sql`, and next free becomes
   `0018`** (owner, 2026-11-03).
9. **The merged submit order is fixed and stated identically in both specs**
   (owner, 2026-11-03). Decision 8.

## User stories

### Editor offers the published trips
**As** an editor **I want to** make "Which trip?" list the published trips under
/trips **so that** a new trip appears in the form the moment it is published, and a
retired one disappears.

### Developer offers a list that lives elsewhere
**As** a developer **I want to** register a `countries` source that calls our CRM once
an hour **so that** editors can put a country question on any form without me
building the form by hand.

### Visitor picks from a long list
**As** a visitor **I want** the full country list, in my language **so that** I can
find mine.

### Marketer links to a preselected trip
**As** a marketer **I want** the trip page's "Enquire" button to open the form with
that trip already chosen (`?trip=<id>`, through `prefill: 'query'`) **so that** a
visitor does not have to find it again.

### Publisher reads a response about a retired trip
**As** a publisher **I want** a two-year-old response to say which trip it was about,
even after the trip was deleted **so that** the record still means something.

### Visitor during a CRM outage
**As** a visitor **I want** the form to keep working when the country source is down
**so that** somebody else's outage does not lose my enquiry.

## Architecture decisions

### 1. One option-source registry per brand, under `forms.sources`, with `content` built in, and one descriptor on the question

A question carries `optionsFrom?: { source: string; settings?: Record<string, Json> }`.
`source` is either `'content'` or the id of a host source registered under the
brand's `forms.sources`. The registry is a record keyed by id, like `brands`:

```ts
forms: {
  sources: {
    countries: {
      label: 'Countries (Jambo)',
      settings: { sort: select({ options: [{ value: 'name', label: 'Name' }, …] }) },
      ttl: 86_400,
      async load({ settings, locale, signal }, env) { … return [{ value, label }, …] },
    },
  },
}
```

It sits under `FolioForms` because that type is already per brand
(`types.ts:667`, `:896`). A branded deployment therefore gets per-brand sources with
no new plumbing, and every source lookup goes through `c.var.brand` or `rt.forScope`
like every other registry read. Construction refuses an id that is not
`/^[a-z][a-z0-9-]{0,47}$/`, the reserved id `content`, a `load` that is not a
function, a `ttl` outside 60 to 604 800 seconds, and a `settings` field of any kind
other than `text`, `number`, `boolean` or `select`. `FORMS_KEYS` gains `sources`.

**Rejected: two descriptors, a `ContentQuery` for content and a `source` for host
data** (#54's "a question stores a `ContentQuery`"). Validation, cache tagging,
submit-time checking and the builder would each fork on which key is present, and a
question holding both would need a rule. With one key, the built-in source is one
entry in a lookup.
**Rejected: a deployment-wide registry at the top of `createFolio`.** On a branded
deployment, a source written for one brand would be offered to another brand's
editors. The brand invariant ("every registry read goes through the scope's brand")
exists to prevent that.

### 2. A source's list is materialised onto the question before compiling and before validating, and the engine does not change

`materialiseOptions(field, list)` (core, pure) returns the question with `options`
set to the sourced list followed by the typed extras. A sourced entry whose value
collides with an extra is dropped, so the editor's label wins. Render, the admin's
`/forms/resolved` and the submit route call it on every sourced question before they
call `compileForm` or `validateSubmission`. From then on, `answerOf`, `formState`,
`prefillAnswers`, `formLayout`, `validateAnswer`, `optionValues` and `answerBudget`
see an ordinary option question. A host running the engine on the descriptor sees the
same list the server validates against, because the descriptor carries it.

**Rejected: an `options`-list parameter on `answerOf`, `formState` and
`validateSubmission`** (#54's "must check against the resolved list"). Every caller,
host code included, would have to thread the lists through, and a caller that forgot
would read every sourced answer as blank. Spec 35 already made the descriptor the
input those functions read (form-logic.md decision 1). Filling in the descriptor
keeps that true.

### 3. A content option's stored value is the story id

The value posted, stored, compared by a condition and put on a `?trip=` link is the
story id (`stry_…`).

- It never changes. A slug changes on an explicit rename and a path changes on every
  move, so a value derived from either would orphan every stored response and
  silently break every condition (`showIf: { eq: 'serengeti' }`) the first time the
  trip is renamed.
- It is unique within the chain. A slug is unique only among siblings: two `safari`
  pages under different parents would be one option value.
- It is what the host has in hand. A trip page knows its own story id
  (`opts.story.id`), which is what an "Enquire" link puts in the query string. A
  `submitted` hook that wants the trip calls `folio.reader(env).recordBy`/`doc` with it.

**Rejected: the slug, for a readable CSV** (#54's alternative). Readability is solved
where it belongs, in the response, by decision 13: the CSV's column reads the trip's
title and a sibling column carries the id. Stability cannot be added to a slug after
the fact.

### 4. The `content` source lists published documents of one type, labelled by that type's title field in the render's locale

Settings are `ContentOptionSettings`:
`{ type: string; parent?: string | null; where?: ContentWhere[]; order?: ContentOrderSpec }`.
`contentOptionQuery(settings, rootIndexed)` (core) turns them into a `ContentQuery`
of `status: 'published'`. It keeps only the `where` entries and the `order` that name
a field indexed **on that type's root block**, or a built-in order other than
`relevance`. The default order is `title` ascending. This is the double enforcement
`collectionQuery` applies (`query.ts:430-478`): a value imported or saved before a
field stopped being indexed never reaches `contentSql`, which would otherwise throw
`unknownField` in the middle of a page render.

An item's label is `item.data[titleFieldOf(type, rootDef)]` read in the render's
locale (`item.data` is already localised by `runQuery`). If that is not a non-empty
string, the label is `item.title`. The value is `item.id`. **A content label goes
through the same screen a host label does** (decision 7, step 3): trimmed, checked
printable, and truncated to 200 characters with a trailing `…`. `titleFieldOf` falls
back to a type's `summary` field (`schema.ts:247-254`), which can be a paragraph, and
the descriptor-size figure in decision 10 holds only if a label is bounded.

**When the order is `title`, the materialised list is re-sorted by label**, with
`Intl.Collator(locale)` for the render's or submission's locale. The query's
`title` order sorts by `stories.title`, the source-locale title
(`server/query.ts:62`), so a French dropdown would otherwise follow English
alphabetical order. The query still decides **which** 500 are listed, and the
re-sort decides only their order, so render and submit still agree on membership.
Any other order is left as the query returned it.

Exactly one type, and never a `singleton` kind. One type means one root block, so
there is one title field and one set of filterable fields, and the builder's filter
controls mean something. `page` and `record` kinds are both allowed. "Destinations"
as records is as natural a list as "trips" as pages.

**Rejected: several types, or every type** (`ContentQuery.type` allows both). A list
mixing two root blocks has no common title field or filter. An untyped list carries
`type:*`, which every publish on the site purges.
**Rejected: a `label` setting naming any root field.** It is additive later. The
title field is what every type already declares as its name, and it is what the
publish purge keeps fresh (decision 5).

### 5. The content source resolves on pass four, is tagged by type, and carries no per-item story tags

`resolve()` gathers every sourced question on every form the render compiles: the
document's own forms (`runtime.ts:1356`) and nested ones (`:1567-1573`). It runs their
content queries in the **same `Promise.all` as pass four's collection queries**, on
the render's session, chain and locale (`queryDeps(db, chain, render?.site)`,
`{ locale: active }`). It compiles the forms only after that. The early return at
`runtime.ts:1619` moves below both.

The cost, stated exactly. A source of 100 or fewer documents is one read, issued
alongside the collection queries, so a page that already has a collection pays no
extra round trip, and a page with a sourced form and no collection pays one. **A
source over 100 documents pays one more sequential round trip**, on every cache-miss
render and every submission. That is because `clampPerPage` will not go past
`MAX_PER_PAGE` (`query.ts:192-195`): page one carries `total`, and pages 2 to
`ceil(min(total, 500) / 100)` then run concurrently.

**Rejected: issuing all five pages speculatively in the first `Promise.all`.** Every
render of every sourced form would pay four extra D1 reads to save one round trip
on the uncommon list over 100. The extra trip is paid only on a cache miss.

Each compiled sourced question carries `optionsFrom: { source: 'content', types:
[type] }` on the descriptor. `cacheTags` folds those types into the same set it builds
from collection keys, so a page gets `type:<name>`, or `type:<name>@<scope>` for every
chain scope on a multi-site render, exactly as an index page over that type does.
Publishing, unpublishing or deleting any document of the type purges it. A title
change reaches the page through that purge, because the label is read from the
published document and only a publish changes the published document. A title-only
*patch* changes `stories.title` and does not purge `type:` (`stories.ts:2811`). It
can therefore leave a stale label only on a type with no title field, where the label
falls back to `stories.title`. That case is named in Edge cases.

In draft mode, sourced options resolve against published content, the posture
collections take (`collections.md` checkpoint 3). No `stale` flag is put on a
question: options are not content being edited.

**Rejected: putting the answer on `resolution.collections` under its `queryKey`.**
Tagging would then be free, but `cacheTags` adds `story:<id>` for every collection item
(`cache-tags.ts:244-246`). Five hundred trips at about 30 bytes a tag is 15 KB, which
puts a page with one form against the 16 KB budget, and going over coarsens the whole
page to `site`. The same items would also travel twice in the payload, once as a
collection and once as options.
**Rejected: per-item story tags on sourced options.** The same budget, for a staleness
the type tag already covers.

### 6. A host source's list is kept in a D1 table, read on the request's session, and the render path never calls `load`

`option_lists` holds one row per `(brand, source, key)`. `key` is the canonical JSON
of `[settings, locale]`. For a source that is not `localised`, `locale` is always `''`
(decision 7). A row holds the last good list, its digest, when it last loaded, when it
was last attempted, and a failure count with a failure category. Every reader takes
`FolioDb` and runs on the request's session: a render on the reader's session, the
submit route on `c.var.bindings().db`. A replica is fine for a list whose freshness
is measured in TTLs. The refresh writes go to the primary, the way every write on a
session does.

The render path **only reads rows**. It never calls a host's `load`. A missing row,
or a source no longer registered, compiles the question with its typed extras only
and `optionsFrom.unavailable: true`. Three properties follow. A page render's latency
never depends on a vendor. A draft or preview render cannot write (the multi-site
invariant "a preview never writes" holds by construction). And a page cached for a
week is refreshed by a purge rather than by a re-render that a cached page never
gets.

**A page that rendered any `unavailable` question is never edge-cached.** `reader.page()`
(`server/index.tsx:1370-1372`) answers `no-store` when any form in the resolution has
a question with `optionsFrom.unavailable`. This is the same branch that already
refuses to cache a draft or a gated page, and it is exposed for a host assembling
headers itself as `hasUnavailableOptions(resolution)` from `folio/core`. Without
this rule, two races would each leave a broken page cached for its whole week:

1. A render on a replica that has not yet seen a list's first load caches the page
   as `unavailable` after the load's purge has already gone out.
2. A source unregistered by a bad deploy and then registered again comes back with
   an unchanged digest, so it issues no purge.

With the rule, an unavailable page is rendered fresh on every request until the list
reads, which costs only a D1 point read while it lasts. Both refresh paths also purge
on the transition from never-loaded to loaded (decision 7), so any page tagged in
between is reached as well.

**Rejected: the Cache API (`caches.default`).** It is per colo and nothing in this
codebase can purge it (CLAUDE.md, "The Cache API is a different store"). A refreshed
list would reach one data centre while every other one validated against its own
copy. An evicted entry is gone, which breaks owner decision 1's "last good": in a
colo that has never cached the list, a vendor outage would be read as "never
loaded".
**Rejected: KV.** It needs a new binding in every host's `wrangler.jsonc` and
`bindings`, the change `caching.md` decision 1 refused for the same reason. Its
global propagation is "up to 60 seconds or more", so a refreshed list would disagree
with itself across colos for a minute.
**Rejected: isolate memory in front of D1.** It is a third copy that no purge can
reach and that dies with the isolate. It saves one indexed point read on a request
that is already reading D1.
**Rejected: a Durable Object per source.** It is a new class, which means a migration
tag in every host's `wrangler.jsonc` (`UPGRADING.md`, "Durable Object migration
tags"). It is also a cross-colo round trip on every submit.
**Rejected: snapshotting the list into the `forms` row.** It would couple a background
refresh to the editor's concurrency token (`updated_at`, forms.md decision 18). Every
refresh would move it, and the next save would fail with a spurious conflict.
**Rejected: a short `s-maxage` for an unavailable page instead of `no-store`.** The
page would still be broken for that window, and `cacheHeaders` keeps one edge TTL on
purpose (`cache-tags.ts:124-131`, "a host that wants a short edge TTL wants a
different design").

### 7. A list is refreshed under a lease, mostly in the background, and a changed list purges its tag

`refreshList(deps, key, timeoutMs)` (server) does the following:

1. **Claims a lease** in one statement: `insert … on conflict (brand, source, key) do
   update set attempted_at = ? where option_lists.attempted_at <= ?`, with the second
   bind `now - LEASE_MS` (30 s). If no row changes, another request holds the lease.
   Across every isolate, one load per key per 30 seconds is the most a vendor ever
   sees.
2. **Calls `load({ settings, locale, brand, signal }, env)`**, with
   `signal = AbortSignal.timeout(timeoutMs)`, and races the call against the same
   timeout. A `load` that ignores the signal is still abandoned.
3. **Screens the result.** It must be an array. An entry needs a string `value` of 1
   to 120 characters and a string `label`, trimmed, printable (`isPrintableAnswer`'s
   rule) and truncated to 200 characters (if absent, the value is used). The first
   occurrence of a value wins. At most `MAX_SOURCED_OPTIONS` (500) entries are kept,
   and a longer list is truncated and logged once with `rt.logger.warn`. A result
   that is not an array, or that leaves no valid entry, is a failed load. An empty
   list is a failure, not an answer: a source that answers `[]` because the vendor
   broke would otherwise replace the last good list with nothing, and every
   submission would then be refused.
4. **On success**, it writes the options, their digest (SHA-256 of the canonical JSON),
   `loaded_at`, `failures = 0` and `failure = null`. It purges `sourceTag(id, brand)`
   when the digest differs from the stored one **or no options were stored before**
   (the never-loaded to loaded transition). The purge goes through the `createPurger`
   path `purgeFormLayout` uses. When the caller has a `waitUntil`, it purges a second
   time `SITE_PURGE_DELAY_MS` later, as `purgeSite` does (`cache-purge.ts:292-312`),
   to reach a page whose render started on a replica before the write and finished
   after the first purge. **On failure**, it keeps the options, increments
   `failures`, sets `failure` to a category (`timeout`, `threw`, `malformed`,
   `empty`), and logs the thrown value with `rt.logger.error`.

**`localised`.** A source declares `localised?: boolean`, default `false`. A
non-localised source is loaded once per settings combination, with `locale: null`,
and that one key serves every locale. A localised source is loaded per locale, for
the source locale and every declared locale. The default is `false` because the
common host list (a CRM's countries, a booking system's departure ports) has one set
of labels. If the default is wrong for a source, the harm differs by direction: a
translating source left at `false` shows source-locale labels on a French page, which
somebody sees and fixes by setting the flag, while a non-translating source left at
`true` multiplies vendor calls by the locale count, which nobody sees.

The callers:

| Caller | Which keys | How |
| --- | --- | --- |
| `PATCH {base}/api/forms/:id` | every host-sourced question in the saved fields: one key, or one per locale when `localised`, whose row is missing or stale | under `c.executionCtx.waitUntil`, **concurrently, at most 4 in flight, all sharing one 25-second deadline** that is also each load's timeout. A key left unattempted at the deadline is left for the cron, the next submission or the next save. |
| The submit route | every sourced question on the form (decision 8), for the submission's locale | **stale-while-revalidate**: validates against the row as read, and refreshes a stale one under `waitUntil` (10 s). It awaits a load **only for a row that has never held options** (3 s). |
| `folio.refreshOptionSources(env, opts?)` | every key any form references, whose row is missing or stale | awaited, 10 s each, `opts.batch` at a time |
| `POST {base}/api/forms/:id/option-preview` | the key previewed | awaited, 10 s. It persists only when a saved form already references the key (decision 14). |

`stale` means `loaded_at + ttl × 1000 <= now`. The tag is `source:<id>` on a
deployment with no brands and `source:<id>@<brand>` with them. It is encoded like
every other tag (`cache-tags.ts:61`). A purge from the submit route or the cron is
issued from whichever entrypoint ran it, which is the trap CLAUDE.md already
documents for publishes and `runSchedules`: a host that caches on one entrypoint
routes its writes and its cron through it.

**When the submit route cannot claim the lease for a never-loaded row**, another
request is loading it, and the row the submit route read on its session may be a
replica that has not seen that load. Before answering `source_unavailable`, it
re-reads the row once on the primary (`db.withSession(PRIMARY_FIRST)`,
`server/db.ts:62`). If that row holds options, the submission is validated against
them.

**`folio.refreshOptionSources(env, opts?)`**
- **Reads every form** whose `fields` mention `optionsFrom`. This is a whole-table read
  spelled with a `null` chain and commented as spanning every scope, the cron's
  sanctioned exception. It runs on every call, so the referenced set is always the
  whole deployment's and never one batch's.
- **Finds each form's brand** with `rt.forScope(registry, site_id)`, skipping a null
  brand, and derives the referenced keys: registered host sources × (`['']`, or
  `['', …declared locale codes]` when `localised`).
- **Sorts the keys by `brand`, `source`, `key`.** `opts.continueFrom` is the last key
  processed in that order, as the canonical string `brand\u0000source\u0000key`.
- **Refreshes the due keys after the cursor**, `opts.batch` at a time (default 10,
  ceiling 50), and answers `{ due, loaded, failed, unchanged, pruned, continueFrom }`.
- **Prunes rows that no referenced key names and that nobody has attempted for 7
  days.** Because the referenced set is always whole, any call may prune.
- **Takes `opts.waitUntil`** for the delayed second purge. Without it, only the first
  purge is issued.

**Rejected: refreshing on render.** A vendor's latency would become a page's latency
on every cache miss. A page cached for a week never re-renders, so the refresh
would rarely happen anyway.
**Rejected: an awaited refresh at submit whenever the row is stale.** The page the
visitor filled in was drawn from the stored row, so a synchronous refresh cannot add
a choice they could have made. It can only remove one the vendor has since dropped,
turning a valid choice into `invalid`, and during an outage it would make the visitor
wait out the 3-second timeout.
**Rejected: folding the sweep into `runSchedules`.** That would change
`ScheduleRunReport`, which is exported, in the same release in which spec 36 adds
`deliveries` to it, so two specs would be editing one function's report.
`sweepAuth` set the precedent for a separate call over a separate table
(`types.ts:1221-1223`). Without a cron, lists still refresh on save and on submit.
The page a visitor sees can then be as old as the last submission, which
`docs/configuration.md` says.
**Rejected: the form's save awaiting its loads.** A vendor timeout would then be a
slow Save button. The builder's preview has already shown the editor whether the
list loads.
**Rejected: serial save-time loads.** Twelve keys at 10 seconds each would outlive
`waitUntil`'s window, and the keys past it would never load.

### 8. Submit validates every sourced question against the same list. The last good copy carries an outage, and only a list that never loaded refuses

**The route loads the list of every sourced question on the form, asked or not.**
Whether a question is asked is decided by `formState`, and `formState` reads an
option answer through `answerOf`, which checks it against `field.options`. Suppose a
sourced `region` has `showIf: { country: { eq: 'AU' } }` and `country` is sourced
too. Computed on unmaterialised fields, `country` reads as blank, `region` reads as
not asked, and its list is never loaded. Once `country = AU` materialises, `region`
is asked but has no list, so its legitimate answer is refused. Loading every list
first and running `validateSubmission` once on the fully materialised fields removes
that ordering problem. The cost is bounded: each list is a store row or a content
query the page's own render already paid for.

- **content**: the same `contentOptionQuery`, on the request's session, for the
  submitting site's chain (`within`, hoisted out of its block at `routes/forms.ts:807`,
  or the single-site chain) and the submission's locale. The `SiteRef` is looked up
  from the registry snapshot the chain check already read. A query that throws is a
  500, like any other D1 failure.
- **host**: the row, as decision 7's submit row describes. A row that holds options is
  used whether or not it is stale, and whether or not a refresh is in flight or has
  failed: that is owner decision 1, exactly. A source not registered in the brand, or
  a row that has still never held options after the awaited load and the primary
  re-read, is **unavailable**.

The fields are materialised (decision 2, and decision 18 for an empty content list)
and validated. If any refusal falls on a question whose list is unavailable, the
submission is answered `status: 'error'` with code `source_unavailable`, HTTP 503,
and the message "This form cannot take submissions right now. Try again later." It
is not `invalid`. Such a question can be refused only because it was asked and either
answered or required: an unanswered optional question, or one the engine did not
ask, never triggers this. No new `SubmitStatus` is added, and `error` already exists
for "the visitor cannot fix this".

**The merged submit order** (owner, 2026-11-03; spec 36 states it word for word):

```
chain check → body cap → closed → honeypot → verify → rate limit (spec 36: counts
refused attempts too) → uploads + option-list load for every sourced question
(37) → validateSubmission on materialised fields (37 maps refusals on unavailable
lists to source_unavailable) → duplicate check → spec 36 checks → insert (option
labels + delivery rows, one batch) → spec 36 deliveries + hooks.submitted
```

A `source_unavailable` answer is a refused attempt: spec 36's `form_refusals` table
(migration `0017`) records it, and `ratePerHour` counts it, so a visitor cannot use a
never-loaded list to make unlimited vendor calls. This spec builds first and ships in
the same v1.3.0 as 36, so no release carries the gap between them.

`routes/forms.ts:744-776` is re-documented to this order. The lists load after
`verify` and the rate limit so that a bot caught by the honeypot, or a flood, never
triggers a vendor call or a content query.

`capFor` runs before the lists exist, so `answerBudget` budgets a sourced `select` or
`radio` at `OPTION_VALUE_CHARS` (120) and a sourced `checkboxes` at
`MAX_SOURCED_OPTIONS × OPTION_VALUE_CHARS`. That is 60 000 characters, or 240 KB under
`BYTES_PER_CHAR`.

**Rejected: loading only the lists of asked questions.** It refuses valid
submissions whenever one sourced question's visibility depends on another (the
example above).
**Rejected: failing open when a list is unavailable (accept any value).** A crafted
POST could then store anything under a sourced question. That would be the opposite
of #54's acceptance criterion, and the same failure `verify` refuses to have
(forms.md decision 11).
**Rejected: refusing whenever a refresh fails.** Every vendor outage would become the
visitor's problem. Owner decision 1 rules that out.
**Rejected: validating against the list the page was rendered with** (a hidden input
or a signed digest). It is client-asserted, the exact argument forms.md decision 7
makes against `_folio_v`.

### 9. The content source is re-run in full at submit, not narrowed to the posted ids

Submit runs the same paged query the render ran. It does not add an id filter that
asks "are these ids members".

**Rejected: an `id in (…)` membership query.** `ContentQuery` has no id filter, so it
would be a new query feature. It would also disagree with the render at the
truncation boundary: in a 600-trip type, the render shows the first 500 by order,
while a membership check accepts all 600. Submissions are rare next to renders, and
up to five indexed reads on a replica is the price of "the same list".

### 10. Sourced options are capped at 500. The typed list stays at 100

`MAX_SOURCED_OPTIONS = 500` (core). It is enforced on a host's result (decision 7) and
on the content query's paging (decision 5). Typed extras on a sourced question keep
`FORM_FIELD`'s cap of 100 and are not counted toward the 500. The typed cap does not
move: it bounds a PATCH body and a D1 column (`validate.ts:1830-1838`), and a sourced
list is never in either. Five hundred options is about 20 KB of descriptor, carried
once per form in the page's `Resolution`.

**Rejected: no cap.** The body cap (decision 8) and the descriptor size are then
whatever a vendor sends.
**Rejected: 250.** It is the size of today's country list, with no headroom for a
vendor that adds territories.

### 11. A condition on a sourced question accepts any well-formed value at save, and the builder offers the current list

`leafRefusal` keeps its operator rules for a sourced `select`, `radio` or
`checkboxes`. For values, it accepts any string of 1 to 120 characters (the option
value bound) as well as the typed extras. `checkFormLogic` stays pure and does no I/O.
The builder's value picker offers the previewed list plus the extras. A stored value
that is no longer in the list shows as its raw value with "no longer offered" beside
it. A condition naming a trip that has since been unpublished never matches, which is
how `matches` already reads an absent answer.

**Rejected: refusing a value outside the current list.** The list changes without a
save. A form whose condition named a since-retired trip would then fail its next save
for reasons unrelated to the edit, and `checkFormLogic` would need a database to
answer.

### 12. `optionsFrom` is shape. The resolved list is not

`FORM_FIELD_KEYS.optionsFrom = 'shape'`. `shapeOf` adds `optionsFrom: { source,
settings }` per question. `validateOneField` writes settings with their keys sorted
(content settings through `contentOptionSettings`, host settings as a sorted
record), so two spellings of one source compare equal and produce one store key.
Changing the source, the type, a filter or a setting bumps `version`, fires
`formChanged` and purges `form:<id>`. The list changing is not a save, never touches
`forms`, and never bumps anything: the type tag or the source tag purges the page.

### 13. A response snapshots the labels of its sourced answers, in a new column

`form_responses.option_labels` holds `{ [question]: { [value]: label } }` for every
answered sourced question. It is written by `insertResponse` from the materialised
list, so the labels are in the submission's locale, as the visitor read them.
`FormResponse.optionLabels` and `ResponseRow.optionLabels` expose it, always present
and `{}` when empty. A response stored before `0016` reads `{}`.

- **Responses screen**: `cellText` maps each value through the snapshot and falls
  back to the raw value. The drawer shows the label, with the stored value in muted
  text beneath it.
- **CSV**: a question's column holds the label or labels (`, ` joined, as now). If any
  response carries labels for the question, a second column headed `<name>:value`
  follows it with the stored values. `:` cannot occur in a field name (`CSV_KEY`,
  `form-responses.ts:2050`), so the header cannot collide with a question.
  `submittedKeys` also unions the keys of `option_labels`.
- **Search**: `responseFilterSql`'s `q` matches `data like ? or option_labels like ?`,
  so searching "Serengeti" finds responses that stored only an id.
- **A deleted or unpublished story, or a value the vendor dropped**, reads as the label
  it had when the visitor chose it. A response is a record of what somebody sent
  (forms.md, "Editing a response"), and the label they read is part of that.

Typed option questions keep today's behaviour of showing the value. Their labels are
in the form row, and changing that is outside this spec.

**Rejected: looking labels up at read time.** A deleted story would read as
`stry_9f2…`, which is the case #54 names. A host source's row can be pruned or
changed. And the CSV would need a stories read per page of 200 rows.
**Rejected: storing `{ value, label }` objects in `data`.** It changes
`ResponseValue`, which is the `submitted` payload's type and which group-web redefines
locally (`group-web/app/brands/allaboutafrica/folio/enquiry.server.ts:36`). That makes it a major bump for a
CSV nicety.

### 14. The builder chooses a source per question, reuses the collection field's filter and sort controls, and previews the list

On an option question, an **Options come from** select offers "Options I type", then
"Published content", then each host source the registry route returns (decision 17),
by label.

- **Published content**: a **Type** select (the brand's `page` and `record` types), an
  optional **Under** that opens `DocumentPicker` (`routed: true`), and the filter and
  sort controls. Those controls are extracted from `CollectionField` into
  `QueryControls` (`fields/QueryControls.tsx`): its filters (`:169-215`) and its sort
  (`:234-251`), with `filterField`, `withFilter`, `filterValue` and `sortLabel` moving
  beside them. `CollectionField` composes `QueryControls` with its count and its note,
  and its rendered output does not change. The form builder composes `QueryControls`
  with a filterable set computed from the chosen type's root block (every field with
  `indexed: true`), no search, and no count.
- **Host source**: one control per declared setting, built by a `SettingControl` from
  the `Input` and `Select` primitives `Control` already uses, for the four permitted
  kinds.
- **Preview**: below either editor,
  `POST {base}/api/forms/:id/option-preview` with the unsaved `optionsFrom` and the
  builder's locale. It runs when a setting is **committed**, not on every keystroke:
  on change for a `select`, a `boolean`, the type, the parent, a filter or the sort,
  and on blur (or Enter) for a `text` or `number` setting. It shows the count, the
  first ten labels, a "first 500 shown" note when truncated, and for a host source the
  status (`fresh`, `stale since <time>`, `never loaded: <category>`). For a required
  content-sourced question with no typed extras and an empty list, it warns: "No
  published documents match. Until one does, this question is not asked"
  (decision 18). The typed list's editor stays below, headed **Also offer**. With a
  source chosen it may be empty, and `blankField`'s seeded option is removed when a
  source is picked.
- **The preview route validates and persists narrowly.** It runs `checkOptionSources`
  on the body and answers `bad_request` as PATCH does. A host's `load` therefore never
  sees an undeclared key, a value of the wrong kind or a `select` value outside its
  options. It writes to `option_lists` only when a saved form already references the
  key. Otherwise it calls `load` (through the same lease, so a burst of previews of
  one key costs one call per 30 s), answers the list, and stores nothing. Typing
  through settings therefore leaves no rows behind.
- `ConditionEditor` receives the previewed list merged with the extras as its
  `options` (decision 11).
- `FormBuilder` gains a `manifest` prop from `Admin.tsx:1014`, for the types and the
  schema (`indexManifest`), which the Manifest carries legitimately. It fetches the
  host sources from `GET {base}/api/forms/registry` through a `useFormRegistry` hook.
  Spec 36 reads `actions` from the same hook.

**Rejected: mounting `CollectionField` unchanged.** Its type is fixed by a block
declaration that a form does not have, and its count control means "show N of them",
which a dropdown does not want.
**Rejected: mounting `Control` for settings.** It needs a document's `FieldEnv`,
`Resolution` and richtext chrome, which a form builder does not have, for the sake
of four scalar inputs.
**Rejected: a per-session cap on preview loads.** The route is `EDIT`-gated. It
previews on commit, not on keystroke. The lease bounds repeats of a key to one load
per 30 seconds. So a vendor's exposure is bounded by what an editor deliberately
does, and a cap would need per-session state (a table or a Durable Object) to stop an
abuse the role model already prevents.

### 15. Sources are per brand, not per site, and `load` is given no site

`load` receives `{ settings, locale, brand, signal }` and the host's `env`. The store
key has no site.

**Rejected: passing the site** (the brief's sketch). The store, the save-time load and
the cron would each multiply by the brand's sites. On the fifty-site client
`multi-site.md` was written for, that is fifty loads of one country list per TTL for
nothing. A list that genuinely differs per site is the case for the `content` source,
which already follows the chain. A host source that varies per site is out of scope.

### 16. The admin sees a failure category, never the thrown message

`option_lists.failure` and the preview's `status` carry `timeout`, `threw`,
`malformed` or `empty`. The thrown value goes to `rt.logger.error`.

**Rejected: storing and showing the error message.** A `fetch` failure can quote the
URL it called, and a vendor URL often carries its API key in the query string. An
editor's screen is the wrong place for it. The rule is general: any failure of host
code that Folio stores for people to read is stored as a category. The boundary
section says how this applies to spec 36.

### 17. Source metadata is served by a signed-in, brand-scoped route, `GET {base}/api/forms/registry`, and never by the Manifest

`GET {base}/api/forms/registry`, at `READ` on the request's scope, answers
`{ sources: FormSourceInfo[]; actions: [] }`. `FormSourceInfo` is `{ id, label,
settings: Record<string, Field>, ttl, localised }`, holding no functions. It reads the
request's brand (`brandOf(c)`), so a branded deployment asked with no scope answers
`400 site_required`. It is registered beside `GET /forms/resolved`. `content` is not
listed: it is built in, and the builder always offers it. This spec introduces the
route and answers `actions` as `[]`. Spec 36 fills `actions` and adds nothing else.

**Rejected: `Manifest.forms.sources`.** The Manifest is served unauthenticated, and
`app.ts:126-150` keeps it to what a client needs before signing in. A source's label
names the vendor ("Countries (Jambo)"), its `ttl` is the refresh cadence, and its
settings list the choices a host passes to its vendor. All three fail the file's own
test: would you be content to see it in an unauthenticated `curl`? Only the signed-in
builder needs them.
**Rejected: separate `GET /forms/sources` and `GET /forms/actions`.** The builder
needs both and would make two requests. One route also keeps the two specs from
drifting apart on scoping and access.

### 18. A content-sourced question whose list and extras are both empty is not asked

When the content query answers nothing and the question has no typed extras,
`materialiseOptions` returns the question with `showIf: { any: [] }`, the never-true
condition `validateOneField` already uses for an unusable `showIf` (`forms.ts:339`).
This happens at render and at submit alike, and is never stored. The engine then
does what it already does for a question that does not apply. The page omits it, a
`required` cannot block, an answer posted for it is dropped, and the response lists
it in `unasked`. The question comes back with the first published document that
matches, through the `type:` purge. The builder warns (decision 14). The server logs
nothing, because an empty list is a legitimate state of published content: every trip
is off sale for the season.

For a host source an empty list is a failed load (decision 7), so this case cannot
arise there.

**Rejected: compiling it `unavailable`.** The form would be unsubmittable for as long
as the type is empty, which may be months. A visitor would be refused a contact form
over a question about a catalogue that is temporarily empty, and the page could not
be cached for the whole period (decision 6).
**Rejected: leaving it as it is.** A required question with no choices refuses every
submission silently, on a cached page, with nothing logged.

### 19. v1.3.0 is roll-forward only, and `readFields` drops a bad question rather than the whole form

**Roll-forward only** (owner, 2026-11-03). A v1.2.x build cannot read a v1.3.0 form
correctly, and the damage is data loss rather than degradation. `UPGRADING.md` says
plainly that v1.3.0 cannot be rolled back to v1.2.x and lists what would break. No
1.2.x tolerance release is made. The list, from this spec:

- **Every answer on an affected form is discarded while the visitor is told it
  succeeded.** v1.2.x drops `optionsFrom`, finds a sourced question with no typed
  options invalid, and `readFields` answers `[]` for the whole form
  (`server/forms.ts:196-203`). `validateSubmission([], body)` then stores `data: {}`
  and answers `ok`. Pages cached by v1.3.0 keep showing the form for up to a week, so
  every enquiry posted to it in that window is lost, and the `submitted` hook receives
  an empty response.
- **A sourced question with typed extras is silently un-sourced for good** by any
  builder save made during the rollback: v1.2.x's `FORM_FIELD` strips `optionsFrom`
  (`validate.ts:1861`), and rolling forward does not restore it.
- **The builder shows an affected form with no questions.** An editor who "fixes" it
  and saves overwrites the stored questions permanently.
- **Option labels stop being written**: responses taken during the rollback carry no
  `option_labels`, so a content-sourced answer reads as a story id in Responses and
  the CSV, permanently.

Spec 36's entry adds its own consequences (every check stops running, and every
delivery stops until the roll-forward). The `UPGRADING.md` text under "Documentation
entries" carries both.

**Forward hardening in v1.3.0.** `readFields` validates per question:
`validateFormFields` gains a `{ onInvalid }` option. On the read path, a question
that fails validation is dropped and logged (`folio: form <id> question <name>
unreadable`) and the rest of the form is kept. A duplicate name still drops the later
question. The write path (`fieldsFromInput`) still throws, so the builder and PATCH
refuse exactly what they refuse today. From this release on, a stored question a
build cannot read costs that one question, not every answer on the form. This is
the `parseScopes` posture `validateFormFields` already takes toward an unknown kind
(`forms.ts:381-384`). It does not help a rollback to v1.2.x, because that build lacks
it, which is why the owner's answer is roll-forward only.

**Rejected: a v1.2.x patch that tolerates `optionsFrom`, as the rollback target.**
Every consumer would have to upgrade twice in a set order, and the patch would still
lose option labels and the outage posture. The owner chose roll-forward.

## The boundary with spec 36 (form actions)

Spec 36 owns actions. Both specs ship in v1.3.0, and this one is built first. They
meet in five places.

**The submit route.** The order in decision 8 is the merged order, and spec 36 states
it word for word. This spec owns the option-list load, which runs concurrently with
the uploads. It owns the materialisation before `validateSubmission`, the
`source_unavailable` mapping after it, and the `option_labels` value written by the
insert. Spec 36 owns the rate limit's counting of refused attempts, the checks after
the duplicate check, the delivery rows written in the same batch as the insert, and
the deliveries. Actions receive the stored `FormResponse`, which carries
`optionLabels`, so an action needing a country's name reads it there rather than
calling the source again.

**The registry route.** This spec creates `GET {base}/api/forms/registry` with
`actions: []` and the `useFormRegistry` hook (decision 17). Spec 36 fills `actions`.

**FormBuilder.** This spec adds the `manifest` prop (types and schema only) and the
registry hook, and changes only the option question's inspector. Spec 36 owns the
form-level actions panel. The builds are serialised because both edit
`FormBuilder.tsx`, `validate.ts`'s `FORM_FIELD`/`FormPatchBody` and `server/forms.ts`.

**Migrations.** This spec writes `0016_option_sources.sql` and, in its docs phase, the
`UPGRADING.md` and `CLAUDE.md` ledgers. It marks `0016` landed, `0017` as spec 36's
`0017_form_actions.sql`, and states "Next free is `0018`". Spec 36's docs phase adds
its own ledger row and does not touch the "Next free" sentence.

**Failure text.** Decision 16's rule (store a category, log the message) applies
equally to any delivery error spec 36 stores for publishers to read. Spec 36 is being
revised to the same rule.

## Wire & schema changes

### D1 migration `0016_option_sources.sql`

```sql
-- Form option sources (docs/specs/content-model/form-option-sources.md).
--
-- Additive. Read by the release that carries it (render reads option_lists, response
-- reads select option_labels), so it is applied BEFORE that Worker is deployed.
-- v1.3.0 also carries 0017_form_actions.sql (spec 36); the two are independent.

-- The last good list a host option source returned, per brand, source and
-- canonical [settings, locale] key (locale '' for a source that is not localised).
-- Content sources have no rows: they are D1 already. options is null until the
-- first good load; attempted_at is the lease.
create table option_lists (
  brand text not null,           -- '' on a deployment with no brands
  source text not null,
  key text not null,
  options text,                  -- JSON FormFieldOption[], screened, at most 500
  digest text,                   -- SHA-256 of options, for change detection
  loaded_at integer,             -- last good load, epoch ms
  attempted_at integer not null, -- last attempt, epoch ms; the 30-second lease
  failures integer not null default 0,
  failure text,                  -- 'timeout' | 'threw' | 'malformed' | 'empty'
  primary key (brand, source, key)
) without rowid;

-- { [question]: { [value]: label } } for each answered sourced question, in the
-- locale the response was submitted in. '{}' for every row before this migration.
alter table form_responses add column option_labels text not null default '{}';
```

Every read of `option_lists` is by primary key, so it needs no other index. The cron's
prune reads the table whole, and the table holds one row per source, setting
combination and locale.

### Core types (`src/core/forms.ts`, new `src/core/option-sources.ts`)

```ts
// option-sources.ts
export const CONTENT_SOURCE = 'content'
export const MAX_SOURCED_OPTIONS = 500
export interface OptionsFrom { source: string; settings?: Readonly<Record<string, Json>> }
export interface ContentOptionSettings {
  type: string
  parent?: string | null
  where?: readonly ContentWhere[]
  order?: ContentOrderSpec
}
export function readOptionsFrom(raw: unknown, field: string): OptionsFrom          // throws on a structural fault
export function contentOptionSettings(raw: Readonly<Record<string, Json>> | undefined): ContentOptionSettings | null
export function contentOptionQuery(s: ContentOptionSettings, rootIndexed: ReadonlySet<string>, page?: number): ContentQuery
export function optionListKey(settings: Readonly<Record<string, Json>> | undefined, locale: string): string
/** Sourced entries first, then extras; an extra wins a collision; `null` (unavailable)
 *  gives the extras only; an empty content list with no extras gives `showIf: { any: [] }`
 *  (decision 18); `collate` re-sorts sourced entries by label for a `title` order. */
export function materialiseOptions(
  field: FormField,
  list: readonly FormFieldOption[] | null,
  opts?: { emptyIsNotAsked?: boolean; collate?: string },
): FormField
/** True when any form in the resolution has a question compiled `unavailable`. */
export function hasUnavailableOptions(resolution: Resolution): boolean

// forms.ts
interface FormField { …; optionsFrom?: OptionsFrom }
interface ResolvedFormField { …; optionsFrom?: ResolvedOptionsFrom }
export interface ResolvedOptionsFrom {
  source: string
  /** `content` only: the one type listed, for `cacheTags`. */
  types?: readonly string[]
  /** The list could not be read: the question carries its typed extras only. */
  unavailable?: true
}

// cache-tags.ts
export const sourceTag = (id: string, brand?: string) => …   // source:<id>, or source:<id>@<brand>
```

- `validateOneField`: for an option kind, `raw.optionsFrom` is read with
  `readOptionsFrom`. A non-object, a `source` failing `/^[a-z][a-z0-9-]{0,47}$/`, or
  settings that are not a plain object over 4096 bytes of JSON all throw. With
  `optionsFrom`, `options` is optional and may be empty (each entry still goes through
  `validateOption`). Without it, the rule is unchanged. For `content`,
  `contentOptionSettings` must answer non-null: `type` a non-empty string, `where` and
  `order` in `asCollectionValue`'s shapes (`query.ts:372-410`), and `parent` a string
  or null. It is a structural check, so it throws.
- `validateFormFields(input, opts?: { onInvalid?: (name: string, err: Error) => void })`:
  with `onInvalid`, a question that fails `validateOneField` is reported and dropped
  instead of throwing (decision 19). `readFields` passes it; every write path does not.
- Every exported addition is re-exported from `src/core/index.ts`. The admin needs
  `materialiseOptions` and `CONTENT_SOURCE`. A host types its descriptor with
  `ResolvedOptionsFrom` and, if it assembles its own headers, calls
  `hasUnavailableOptions`.
- Backward compatible for every stored form. No form has `optionsFrom`, and an
  unsourced question compiles byte-for-byte as before (the workers descriptor-shape
  test pins it).

### Server types

```ts
// form-responses.ts
export interface FolioForms<Env> { verify?…; ratePerHour?…; sources?: Readonly<Record<string, FolioOptionSource<Env>>> }
export interface FolioOptionSource<Env> {
  label: string
  /** Block field definitions (`folio/core`), text | number | boolean | select only. */
  settings?: Readonly<Record<string, OptionSourceSetting>>
  /** Seconds a list stays fresh. Default 3600, valid 60–604800. */
  ttl?: number
  /** Labels differ by locale: load once per locale. Default false, one load serves all. */
  localised?: boolean
  /** A method, for `verify`'s bivariance reason. */
  load(input: OptionSourceInput, env: Env): readonly OptionSourceItem[] | Promise<readonly OptionSourceItem[]>
}
export interface OptionSourceInput {
  settings: Readonly<Record<string, string | number | boolean>>
  /** The locale code the labels are wanted in; null for the source locale, and always
   *  null for a source that is not `localised`. */
  locale: string | null
  brand: BrandRef | null
  /** Aborts at the caller's timeout. */
  signal: AbortSignal
}
export interface OptionSourceItem { value: string; label?: string }
export interface ResolvedForms { …; sources: ReadonlyMap<string, FolioOptionSource<unknown> & { ttl: number; localised: boolean }> }  // defaulted
// routes/forms.ts, the registry route's answer (spec 36 types `actions`)
export interface FormSourceInfo { id: string; label: string; settings: Record<string, Field>; ttl: number; localised: boolean }
export interface FormResponse { …; optionLabels: Readonly<Record<string, Readonly<Record<string, string>>>> }
export interface ResponseRow { …; optionLabels: Record<string, Record<string, string>> }

// types.ts (FolioServer, beside runSchedules and sweepAuth)
refreshOptionSources: (env: Env, opts?: { batch?: number; continueFrom?: string | null; now?: number; waitUntil?: (p: Promise<unknown>) => void })
  => Promise<{ due: number; loaded: number; failed: number; unchanged: number; pruned: number; continueFrom: string | null }>
```

`FolioOptionSource`, `OptionSourceInput` and `OptionSourceItem` are exported from
`folio/server`. These are additive exports and a new optional config key, so the
release is a minor, v1.3.0, shared with spec 36. It is a minor by semver and
roll-forward only by owner decision (decision 19).

### New or changed routes

- **`GET {base}/api/forms/registry`**, `READ`, on the request's scope. Answers
  `200 { sources: FormSourceInfo[]; actions: [] }` for the request's brand, and
  `sources: []` when it registers none. On a branded deployment with no scope it
  answers `400 site_required`. Registered beside `/forms/resolved`, ahead of
  `/forms/:id`, so `registry` is never read as an id. `actions` is spec 36's.
- **`POST {base}/api/forms/:id/option-preview`**, `EDIT`, `fenceForm('read')`. Body
  (`v.strictObject`): `{ optionsFrom: { source, settings? }, locale?: string }`, bounded
  like `FORM_FIELD`'s, then `checkOptionSources` on it (`400 bad_request` on any
  refusal PATCH would make). Answers `{ options: FormFieldOption[] (≤ 500), total: number,
  truncated: boolean, status: 'fresh' | 'stale' | 'never-loaded' | 'unknown-source',
  loadedAt: number | null, failure?: 'timeout' | 'threw' | 'malformed' | 'empty' }`.
  Content: the same paged query, in the form's chain. `total` is the query's total, so
  `truncated` is `total > 500`. Host: the row, refreshed if stale (10 s), and written
  only if a saved form already references the key (decision 14). Unversioned
  and internal ("a version segment is a promise"). It is an id route, so
  `scope-partition.test.ts` needs its fence test.
- **`PATCH {base}/api/forms/:id`**: before `updateForm`, `checkOptionSources(fields,
  brand)` refuses with `bad_request`, naming the question by label and slug, in any of
  these cases: a `source` the brand does not register; host settings with an
  undeclared key, a value of the wrong kind, a `select` value not among its options,
  or a missing `required` one (`default` fills an absent one); a content `type` that
  is not one of the brand's `page` or `record` types; a `where` or `order` field not
  indexed on that type's root block. After the save, it refreshes the saved host
  sources' rows under `waitUntil`, concurrently and under one deadline (decision 7).
- **`GET {base}/api/forms/resolved`**: materialises sourced questions before
  `compileForm`, through `BrandRuntime.optionLists` with refresh `never`, so the
  admin's preview shows the list the page will.
- **`POST {base}/f/:id`**: decision 8. A new error code, `source_unavailable`, under
  `status: 'error'`, HTTP 503. The redirect carries `folio_status=error` as every
  `error` already does.

## Acceptance criteria

### A content-sourced question lists published documents

```
GIVEN a form with a select "trip" sourced from content, type "trip", under /trips
AND three published trips under /trips and one draft trip
WHEN a page embedding the form is resolved
THEN the descriptor's "trip" options are the three published trips, value = story id, label = title
AND the descriptor carries optionsFrom { source: 'content', types: ['trip'] }
AND the response's Cache-Tag includes type:trip (type:trip@<scope> for each chain scope on a multi-site render)
AND it does not include story:<id> for any listed trip
```

### Publishing changes the list without a save

```
GIVEN that page is cached
WHEN a fourth trip is published
THEN the publish purges type:trip and the next render lists four
AND forms.version and forms.updated_at are unchanged
```

### A crafted POST is refused

```
GIVEN the form above
WHEN a POST names the draft trip's id, an unpublished trip's id, or "stry_doesnotexist"
THEN the reply is status invalid with "trip" in folio_invalid
AND no row is written
```

### A host source loads off the render path

```
GIVEN a brand registering "countries" whose load returns 250 entries
WHEN an editor saves a form with a select sourced from "countries"
THEN the save answers before load completes
AND option_lists gains one row, keyed with locale '' (the source is not localised)
AND with localised: true it gains one row per locale, the loads running at most 4 at a time
AND no page render ever calls load
```

### An outage uses the last good list

```
GIVEN "countries" loaded once and its row is now stale
AND load now throws
WHEN a visitor submits "AU"
THEN the submission is stored without waiting for load
AND after the waitUntil refresh, option_lists.failures is 1 and failure is 'threw'
AND the stored options are unchanged
```

### A list that never loaded refuses only what needs it

```
GIVEN "countries" has never loaded and load throws
WHEN a visitor submits with "country" answered
THEN the reply is status error, code source_unavailable, HTTP 503
WHEN a visitor submits with an optional "country" left blank
THEN the submission is stored
GIVEN another request holds the lease and has just loaded the row on the primary
WHEN the submission's session reads no options
THEN the route re-reads on the primary and validates against the loaded list
```

### A sourced question gated on another sourced question

```
GIVEN "country" (host-sourced) and "region" (content-sourced, showIf country eq "AU")
WHEN a visitor submits country=AU and a valid region id
THEN both lists were loaded and the submission is stored with both answers
AND submitting country=AU with an unlisted region is invalid on "region"
```

### A page with an unavailable question is never cached

```
GIVEN a form whose host source has never loaded
WHEN reader.page() renders a page embedding it
THEN the question carries optionsFrom.unavailable and the page answers cache-control: no-store
WHEN the list loads for the first time
THEN source:<id> is purged, and again 25 s later where a waitUntil exists
AND the next render answers the cache headers it would otherwise have had
```

### An empty content list is not asked

```
GIVEN a required content-sourced "trip" with no typed extras, and no published trip
WHEN the page renders
THEN "trip" carries showIf { any: [] } and formLayout omits it
WHEN a visitor submits the rest of the form
THEN the submission is stored with "trip" in unasked
```

### Preview validates and does not litter

```
GIVEN a host source declaring select "region" with options all|africa
WHEN option-preview is posted with region "europe", or an undeclared key
THEN the reply is 400 bad_request and load is not called
WHEN it is posted with a valid key no saved form references
THEN the list is answered and option_lists gains no row
```

### The registry is signed-in and scoped

```
WHEN GET {base}/api/schema is fetched without a session
THEN the manifest holds no source metadata
WHEN GET {base}/api/forms/registry is fetched without a session
THEN it is refused like every READ route
WHEN it is fetched on a branded deployment with no scope
THEN it answers 400 site_required
```

### A changed list purges its tag

```
GIVEN pages tagged source:countries are cached
WHEN a refresh loads a list whose digest differs
THEN purge is called with source:countries (source:countries@<brand> on a branded deployment)
WHEN a refresh loads an identical list
THEN no purge is issued
```

### The lease bounds the vendor

```
GIVEN a stale row
WHEN two submissions arrive within 30 seconds
THEN load is called once
```

### Shape, not list

```
GIVEN a form at version 3
WHEN an editor changes the content source's type or a filter
THEN version is 4 and formChanged fires
WHEN the source's list changes
THEN version is 3
```

### A response stays readable after its story is gone

```
GIVEN a response that chose trip stry_a, titled "Serengeti" when submitted
WHEN stry_a is deleted
THEN the responses table reads "Serengeti"
AND the CSV's "trip" column reads "Serengeti" and its "trip:value" column reads "stry_a"
AND searching responses for "Serengeti" finds it
```

### The cap

```
GIVEN a host source returns 600 entries
THEN 500 are stored, one warning is logged, and the builder preview says so
GIVEN a content type with 600 published documents
THEN the descriptor lists the first 500 by the chosen order, and a POST naming the 501st is invalid
```

### Nothing changes for an unsourced form

```
GIVEN a form with no optionsFrom anywhere
THEN its descriptor, its Cache-Tag set and its submit path are byte-for-byte what v1.2.4 produced
```

## Implementation plan

Each phase leaves the tree green. Phase order is by dependency. Phases 3 and 4 both
edit `src/server/routes/forms.ts` and run serially. Phase 5 can run beside 3 and 4
once 2 has landed. Phase 6 needs 5's preview route.

### Phase 1: the vocabulary (core only)

1. New `src/core/option-sources.ts` with the types and functions under Core types.
   `contentOptionQuery` reuses `asCollectionValue`'s narrowing for `where` and `order`,
   defaults the order to `{ field: 'title', dir: 'asc' }`, and sets `perPage: 100`,
   `status: 'published'` and the page.
2. `src/core/forms.ts`: `FormField.optionsFrom`; `validateOneField` (`:298-300`) per
   Core types; `validateFormFields`' `onInvalid` (decision 19), with `readFields`
   (`server/forms.ts:196-203`) passing it so that a bad question is dropped and
   logged and the rest of the form is kept; `FORM_FIELD_KEYS.optionsFrom = 'shape'`; `shapeOf` adds
   `optionsFrom`; `leafRefusal` (`:553-567`) per decision 11 when `source.optionsFrom`
   is set; `ResolvedFormField.optionsFrom` and `ResolvedOptionsFrom`.
3. `src/core/cache-tags.ts`: `sourceTag`. `cacheTags` walks
   `resolution.forms[*].fields[*].optionsFrom`, adding `types` into the collection
   type set before the scoped/unscoped split (`:226-235`), and adding
   `sourceTag(source, resolution.site?.brand)` for every non-content source.
4. `src/core/option-sources.ts`: `materialiseOptions` per its doc comment (extras,
   collision, `null`, the empty-content not-asked case, the label collation) and the
   200-character label screen shared with host items; `hasUnavailableOptions`.
5. `src/core/index.ts`: export the additions.
6. Unit tests (Testing requirements, core).

### Phase 2: migration, config and the store

1. `migrations/0016_option_sources.sql` as above. `test/workers/migrations.test.ts`
   asserts the table, its primary key, `without rowid` and the column default.
2. `src/server/form-responses.ts`: `FolioOptionSource` and friends; `FORMS_KEYS` gains
   `sources`; `validateForms` validates per decision 1, defaults `ttl` and
   `localised`, and builds `ResolvedForms.sources`.
3. New `src/server/option-sources.ts`: `readLists(db, brand, keys)` (point reads,
   chunked under the bind ceiling as `formsByIds` chunks), `listStatus(row, ttl, now)`,
   `refreshList` (decision 7: the lease, the screen, the purge on change or on first
   load, the delayed second purge when given `waitUntil`, with the purge capability
   injectable as `purgeFormLayout`'s is), `readListOnPrimary` (the re-read in
   decision 7), `refreshKeys(keys, { concurrency: 4, deadlineMs })`, `screenItems`,
   and `checkOptionSources(fields, brand)`.
4. `src/server/runtime.ts`: `BrandRuntime.optionLists(bindings, forms, ctx: { chain,
   site?: SiteRef, locale?: LocaleContext, refresh: 'never' | 'submit', waitUntil?, env })`.
   It answers `Map<formId, Map<fieldName, { options: FormFieldOption[] | null;
   resolved: ResolvedOptionsFrom }>>` for **every** sourced question. Content is
   answered by paged `runQuery` over this brand's `queryDeps`, host sources by the
   store. `'submit'` means decision 7's submit row: as read, a background refresh when
   stale, an awaited 3-second load only when never loaded, and the primary re-read on
   a lost lease. The manifest is **not** changed.
5. `src/server/validate.ts`: `FORM_FIELD` gains `optionsFrom: v.optional(v.object({
   source: required(48), settings: v.optional(<plain JSON object, ≤ 4096 bytes>) },
   OBJECT))`. Add `optionsFrom` to the `Required<FormField>` fixture in
   `test/unit/server/forms.test.ts`.

### Phase 3: render

1. `src/server/runtime.ts` resolve: once `nestedFormRows` is known, start
   `optionLists(…, { refresh: 'never' })` over own and nested form rows. Await it in
   the same `Promise.all` as pass four. Move the early return at `:1619` below both,
   and move `compileForm` (`:1587-1596`) and the `resolution` assembly after it,
   compiling each form from `materialiseOptions`'d fields.
2. `src/server/index.tsx` `reader.page()` (`:1370-1372`): add
   `hasUnavailableOptions(resolution)` to the `no-store` condition, with a comment
   naming decision 6's two races.
3. `src/server/forms.ts` `compileField`: emit `optionsFrom` (`source`, `types`,
   `unavailable`) when the stored field has one. Pass the resolved part to
   `compileForm` through `FormRenderContext.sources?: Map<fieldName,
   ResolvedOptionsFrom>`.
4. `GET /forms/resolved` (`routes/forms.ts:243-258`): the same materialisation.
5. Workers tests: render, tags and the `no-store` rule.

### Phase 4: submit and responses

1. `routes/forms.ts` submit: hoist `within` and look up the receiving `SiteRef`. After
   the rate limit, run `optionLists(…, { refresh: 'submit', waitUntil })` for every
   sourced question, concurrently with `prepareUploads`. Materialise every sourced
   question, run `validateSubmission` once, and map refusals on unavailable lists to
   `source_unavailable` (503). Rewrite the order comment (`:744-776`) to decision 8's
   merged order, leaving spec 36's steps as named placeholders in the comment only
   where 36 has not yet landed, which it has not when this phase is built.
2. `form-responses.ts`: `answerBudget` per decision 8; `NewResponse.optionLabels`;
   `insertResponse` writes `option_labels` (seventeen binds);
   `FormResponse.optionLabels`; `RESPONSE_COLS`, `ResponseDbRow`, `toResponse` read
   it, screened to string maps; `responseFilterSql`'s `q` covers it;
   `submittedKeys` unions its keys and answers which are labelled;
   `responseCsvColumns` emits `<name>:value`; `csvValue` reads labels for a labelled
   column and raw values for its `:value` column.
3. Workers tests: submit and CSV.

### Phase 5: save, cron and preview

1. PATCH (`routes/forms.ts:282`): `checkOptionSources` before `updateForm`; afterwards,
   `waitUntil(refreshKeys(…, { concurrency: 4, deadlineMs: 25_000 }))` over every
   missing or stale host-sourced key in the saved fields.
2. `GET /forms/registry` (decision 17), registered beside `/forms/resolved`.
3. `POST /forms/:id/option-preview` and its validator in `validate.ts`, running
   `checkOptionSources` and persisting only for a referenced key.
4. `src/server/index.tsx`: `refreshOptionSources`, beside `runSchedules` (`:1896`).
   Implemented in `server/option-sources.ts` over `rt.brands`, `rt.forScope` and
   `rt.sites.registry`, with the key cursor and whole-set prune of decision 7.
5. `examples/demo/src/index.tsx`: a `scheduled()` call to
   `folio.refreshOptionSources(env, { waitUntil: ctx.waitUntil.bind(ctx) })` beside
   `sweepAuth` (`:541`), and a demo source `countries` returning a static list from
   the Worker, so the demo needs no network.

### Phase 6: admin

1. `fields/QueryControls.tsx` extracted from `CollectionField.tsx`. `CollectionField`
   composes it. `test/unit/admin/collections.test.ts` keeps passing unchanged, and
   the helpers' imports move.
2. `FormBuilder.tsx`: a `manifest` prop (from `Admin.tsx:1014`, types and schema
   only); `useFormRegistry` over `GET {apiBase}/forms/registry`; an
   `OptionSourceEditor` beside `OptionsEditor`; `SettingControl`; the preview hook
   `useOptionPreview` (on commit, decision 14, keyed by `optionListKey`); the
   empty-required warning; `ConditionEditor` given the merged list.
3. `form-model.ts`: `withOptionsFrom(field, next)` (drops the seeded option when the
   typed list is the untouched `blankField` default); `needsOptions` callers allow an
   empty typed list when sourced; `optionRefusal` unchanged for extras.
4. `responses-model.ts` and `Responses.tsx`: labels per decision 13.

### Phase 7: demo, end-to-end, prose

1. `examples/demo`: the demo contact form gains a content-sourced question and a
   `countries` question.
2. `scripts/option-sources-test.mjs` (run by `./scripts/e2e.sh`). It signs in, stamps
   `v` on every frame, and covers four things. It publishes two trips and saves a
   sourced form, then asserts the resolved options. It POSTs an unpublished id and
   asserts `invalid`. It POSTs a published one and asserts the stored row's
   `option_labels`. It flips the demo source into failure through a demo-only
   `/dev/` switch that 404s off localhost, like `/dev/last-signin`, and asserts that a
   stale list still accepts while a never-loaded key answers `source_unavailable`. It
   submits a sourced question gated on another sourced question and asserts both
   answers are stored.
3. Docs, all in this phase:
   - `docs/configuration.md`: a `forms.sources` block under `#### forms`
     (`:594-617`), with the shape, the `ttl` default and range, the settings kinds, the
     four callers that load, and the cron call. In the `FolioBrand` table row for
     `forms` (`:408`), add "and its option sources". Add a construction-error row
     beside `:911`.
   - `docs/handbook.md` `## Forms` (`:1988`): "Options from a source", covering the
     content source, the stored id and `?name=<id>` prefill, the labels in responses
     and the CSV, the host source, the outage rule and the purge-entrypoint caveat.
   - `UPGRADING.md`: the ledger row for `0016`; the "Next free" sentence (`:111`),
     rewritten to say `0016` and `0017` are v1.3.0's and **next free is `0018`**
     (spec 36's docs phase adds its own `0017` row and leaves this sentence alone);
     the section "Form option sources (v1.3.0)"; and the shared section
     "v1.3.0 is roll-forward only", both as written under Documentation entries.
     Spec 36 appends its own consequences to the shared section.
   - `CLAUDE.md`'s migration ledger (`0016` landed, `0017` spec 36's, next free
     `0018`); `docs/specs/README.md` row 37;
     `ROADMAP.md` §4 items 2 and 7 marked done with a pointer here; `AGENTS.md` one
     line under forms.
   - This spec: Implementation notes, and its status restamped.

**Deploy order:** apply `0016` (and spec 36's `0017`), then deploy v1.3.0.
**Rollback:** none to v1.2.x. A fault in v1.3.0 is fixed by a v1.3.x patch
(decision 19).

## Documentation entries

These are written here so the build copies them rather than composing them. Phase 7
places them.

**`docs/configuration.md`, appended to `#### forms: FolioForms<Env>`:**

````md
`sources` gives a `select`, `radio` or `checkboxes` question its choices from a
list you supply. Editors pick the source and its settings in the form builder.

```ts
forms: {
  sources: {
    countries: {
      label: 'Countries',                        // what an editor sees
      settings: { region: select({ options: [{ value: 'all', label: 'All' }, { value: 'africa', label: 'Africa' }], default: 'all' }) },
      ttl: 86_400,                               // seconds fresh. Default 3600, valid 60–604800
      localised: false,                          // default: one list serves every locale
      async load({ settings, locale, signal }, env) {
        const rows = await crm(env).countries(settings.region, { signal })
        return rows.map((c) => ({ value: c.iso2, label: c.name }))
      },
    },
  },
},
```

`content` is built in and needs nothing here: it lists published documents of one
type, and a chosen value is the story id.

**Folio never calls `load` while rendering a page.** It calls it in four situations:

- in the background after an editor saves a form;
- when an editor previews a list in the builder;
- during a submission, but only for a list that has never loaded (3 s), with a
  stale list refreshed in the background;
- from `folio.refreshOptionSources(env, { waitUntil })`, which belongs in your
  `scheduled()` beside `runSchedules`.

Without that cron call, a list refreshes only on saves and submissions. A list that
changes, or loads for the first time, purges the pages showing it. The purge comes
from whichever entrypoint ran the refresh, so route your cron through the entrypoint
you cache on. While a list has never loaded, a page showing it answers
`cache-control: no-store` from `reader.page()`. If you assemble headers yourself,
check `hasUnavailableOptions(resolution)`.

Set `localised: true` only if your labels differ by language. The source is then
loaded once per locale, and `locale` is the code wanted. Otherwise `locale` is
always `null`.

`load` gets an `AbortSignal` that fires at the caller's timeout. It must return 1–500
`{ value, label }` entries:

- a value is 1–120 characters;
- a label is truncated at 200 characters;
- a repeated value keeps its first label;
- anything past 500 is dropped, with a warning.

An empty list, a throw or a timeout counts as a failure and leaves the last good list
in place. **A submission during an outage is checked against the last list that
loaded, and is refused only if the list has never loaded.** Folio stores the error
category for editors and logs the error itself.

`settings` takes `text`, `number`, `boolean` and `select` fields from `folio/core`.
An id is lowercase letters, digits and hyphens, and `content` is reserved. Editors
see your sources through a signed-in admin route, never the public schema.
````

**`docs/configuration.md`, the construction-errors table (beside `:911`):**

```md
| `forms.sources`: an id that is not `[a-z][a-z0-9-]*` or is `content`, a `load` that is not a function, `ttl` outside 60–604800, `localised` not a boolean, a setting of another kind | A form naming the source would fail on an anonymous POST |
```

**`UPGRADING.md`, the ledger row:**

```md
| `0016_option_sources.sql` | `option_lists` (the last good list per host option source) and `form_responses.option_labels` | **Apply it before you deploy**: v1.3.0 reads `option_lists` when it renders a form and selects `option_labels` in every response read, so a Worker deployed first fails both with `no such table` / `no such column`. Additive and safe ahead of the deploy. v1.3.0 is **roll-forward only**: read [that section](#v130-is-roll-forward-only) first. |
```

**`UPGRADING.md`, the section this spec owns:**

````md
### Form option sources (v1.3.0)

`0016_option_sources.sql` adds one table and one column. Apply it before you deploy.
Nothing changes for a form until an editor gives a question a source. What changes
in the code regardless:

- **`FolioForms` gains `sources`**, per brand on a deployment with `brands`. It is
  optional, and absent means only the built-in `content` source is offered.
- **`ResolvedFormField` gains `optionsFrom`** on a sourced question: `{ source, types?,
  unavailable? }`. `options` already holds the full list, so a host that renders
  `field.options` needs no change. `unavailable: true` means the list could not be
  read and only the editor's typed extras are present. Render that however your
  design says "temporarily unavailable". `reader.page()` does not edge-cache such a
  page.
- **A content-sourced question whose list is empty, and which has no typed options,
  is not asked**: it arrives with `showIf: { any: [] }`, so `formLayout` omits it,
  and the response lists it in `unasked`.
- **`FormResponse` and the response reads gain `optionLabels`**, `{ [question]: {
  [value]: label } }`, holding what the visitor read when they chose. It is `{}` for
  every response stored before `0016`. A content option's value is a story id, so a
  `submitted` hook that showed the raw value now shows `stry_…`: read the label from
  here.
- **A new submit refusal**: `folio_status=error`, JSON `code: 'source_unavailable'`,
  HTTP 503, sent only when a question's list has never loaded and the visitor
  answered it or it is required.
- **The CSV** puts a sourced question's labels in its column and the stored values
  in a following `<name>:value` column.
- **Add `await folio.refreshOptionSources(env, { waitUntil: ctx.waitUntil.bind(ctx) })`
  to `scheduled()`** if you register a host source. Without it, a list refreshes only
  on saves and submissions.
- **A question Folio cannot read is now dropped on its own**, and logged, rather than
  emptying its whole form.
- **New exports**: `folio/core` gains `CONTENT_SOURCE`, `MAX_SOURCED_OPTIONS`,
  `materialiseOptions`, `hasUnavailableOptions` and the types `OptionsFrom`,
  `ContentOptionSettings` and `ResolvedOptionsFrom`. `folio/server` gains the types
  `FolioOptionSource`, `OptionSourceInput` and `OptionSourceItem`.
````

**`UPGRADING.md`, the shared section (this spec writes it; spec 36 appends its
bullets):**

````md
### v1.3.0 is roll-forward only

**v1.3.0 cannot be rolled back to v1.2.x.** If something is wrong after the upgrade,
deploy a v1.3.x fix. Do not redeploy a v1.2.x pin. A v1.2.x build reading a v1.3.0
database breaks the following, and some of it cannot be repaired afterwards:

- **Enquiries are lost while visitors are told they were received.** On any form
  with a sourced question that has no typed options, v1.2.x reads the whole form as
  having no questions. Pages cached by v1.3.0 keep showing it for up to a week, and
  every submission to it is stored empty, answered `ok`, and handed to your
  `submitted` hook with no answers.
- **A sourced question is un-sourced for good** if anyone saves its form in the
  v1.2.x builder: the older build strips the source on save, and rolling forward does
  not bring it back.
- **The builder shows those forms with no questions**, and a save from there
  overwrites the stored questions permanently.
- **Responses taken meanwhile have no option labels**, so their content-sourced
  answers read as story ids in Responses and the CSV, permanently.

The new table and columns stay in the database, and an older build ignores them.
That is the only part of this release that a rollback leaves alone.
````

## Edge cases

- **A source is removed from the brand's config** → every question naming it compiles
  `unavailable` with its extras, and submissions answering it get
  `source_unavailable`, and the pages showing it answer `no-store` (decision 6), so
  restoring the source restores those pages on their next request with no purge
  needed. The builder shows "Unknown source <id>". This is the `parseScopes`
  posture: removing a source narrows every stored form instead of breaking it.
- **A field stops being indexed after a form filtered on it** → `contentOptionQuery`
  drops the filter at render and at submit alike, so the two still agree, and the
  next save refuses until the filter is removed. The list widens rather than the page
  failing. The builder marks the filter.
- **A form shared by a group** → each site's page lists its own chain's documents, and
  each submission validates against the submitting site's chain. The two agree
  because the page and the POST both name the receiving site.
- **Replica lag at submit** → a trip published seconds ago may not be on the replica the
  submit's session reads, so an answer naming it is `invalid` for that window. A trip
  unpublished seconds ago may be accepted for that window. Both are bounded by the
  replica lag, which is seconds, and the second stores a choice that was valid when
  the page was drawn.
- **A list changes between render and submit** → a host list is validated as stored,
  which is the list the page was drawn from unless a refresh landed in between; that
  refresh purged the page, so the next visitor sees the new list. A content list is
  re-queried, so a trip unpublished in between is `invalid`. That is the price of
  never validating against a client-asserted list (decision 8).
- **A content source matches nothing** → for a question with no typed extras, it is
  not asked, at render and at submit alike (decision 18). With extras, only the
  extras are offered.
- **A non-source-locale render with the default order** → sorted by the localised
  label (decision 4). The 500 listed are still the first 500 by source-locale title,
  which matters only for a type over 500 documents.
- **A type with no title field** → the label falls back to `stories.title`, which a
  title-only patch changes without purging `type:`. That label is stale until the
  next publish of any document of the type. The builder notes it when the chosen type
  has no title field.
- **A `checkboxes` question over 500 countries, all ticked** → within the body cap
  (decision 8), and the stored answer is 500 ids plus their labels.
- **`prefill: 'query'` with an id not in the list** → dropped, as `prefillAnswers`
  already drops an undeclared option.
- **A host value colliding with a typed extra** → the extra wins and the sourced entry
  is dropped, so the editor's label is the one shown.
- **A locale added after a form was saved** → for a `localised` source its row is
  missing, so the question compiles `unavailable` in that locale, and the page answers
  `no-store`, until the cron, a submission in that locale, or the next save loads it.
  A source that is not `localised` is unaffected, because its one key serves every
  locale.
- **A save on a brand with many locales and several localised sources** → loads run
  four at a time under one 25-second deadline. Any key not reached is left
  `unavailable` (`no-store`, so never cached broken) until the cron or a submission
  reaches it.
- **No cron** → lists refresh on save and on submit only. `docs/configuration.md`
  says so, and the builder shows "stale since <time>".
- **A stale admin tab saves** → there are two cases.
  - An open v1.3.0 tab keeps `optionsFrom` through its own edits, because the field
    reducers copy fields with a spread (`form-model.ts:238`) and `save` sends
    `draft.fields` as held (`FormBuilder.tsx:234-248`). The server therefore keeps
    the source.
  - A tab still running the v1.2.x bundle after the deploy also holds the fetched
    JSON with `optionsFrom` and sends it back. What it cannot do is show or edit the
    source, so the editor sees a sourced question as having no options. Its client
    check may then disable Save. Either way nothing is lost, and the next reload
    picks up the new bundle.
- **A gated (members-only) trip** → listed. A collection lists it too: the gate
  redacts a document's body, not its existence (visitor-access.md).
- **A draft-mode render or a preview origin** → reads rows and runs published-content
  queries only. Nothing writes.
- **A stored question this build cannot read** → dropped on its own and logged, and
  the rest of the form renders and validates (decision 19). Before v1.3.0 the whole
  form would have read as empty.
- **Two submissions race a never-loaded key** → one claims the lease and loads it. The
  other re-reads on the primary, and is refused `source_unavailable` only if the
  load has not landed by then.

## Testing requirements

**Unit (`test/unit/`):**

- `core/option-sources.test.ts` covers four functions. `readOptionsFrom` throws on
  each structural fault. `contentOptionQuery` drops a non-root-indexed filter, drops a
  `relevance` order, and defaults to `title` ascending. `optionListKey` is the same for
  two key orders. `materialiseOptions` puts sourced entries first, lets an extra win a
  collision, and given `null` returns the extras only. With `emptyIsNotAsked`, an
  empty list and no extras give `showIf: { any: [] }`, and with extras do not.
  `collate: 'fr'` re-sorts by label and keeps membership. A 600-character content
  label is truncated to 200. `hasUnavailableOptions` is true for one flagged question
  and false otherwise.
- `core/forms.test.ts`: `validateFormFields` accepts a sourced question with no typed
  options and refuses an unsourced one with none. With `onInvalid`, a form holding one
  unreadable question returns the others and reports that one. Without it, the same
  input still throws. The `FORM_FIELD_KEYS`-driven
  `shapeOf` test covers `optionsFrom` and passes with the new key classified.
  `checkFormLogic` accepts an arbitrary id on a sourced `select` and refuses one over
  120 characters. Its operator rules are unchanged.
- `core/form-logic.test.ts`: `formState` and `prefillAnswers` on a materialised
  descriptor accept a sourced value and drop an unlisted one.
- `core/cache-tags.test.ts`: a sourced form adds `type:trip`, or the scoped tags with
  a site, and adds no `story:` tags for its items. A host-sourced form adds
  `source:countries`, or `source:countries@brand` with a site brand. An unsourced form
  produces the same set as before.
- `server/form-validate.test.ts`: `validateSubmission` over materialised fields refuses
  an unlisted value and accepts a listed one. `capFor` budgets a sourced `checkboxes`
  at 500 × 120.
- `server/form-csv.test.ts`: the label column, the `:value` column, retired labelled
  keys, and formula de-fanging applied to labels.
- `server/option-sources.test.ts` (new) covers four areas. `screenItems` drops
  duplicates, over-length and unprintable entries, truncates at 500, and treats empty
  and non-array results as failures. `validateForms` refuses each bad `sources` entry,
  including a non-boolean `localised`. `refreshKeys` never has more than four loads
  in flight and abandons the rest at the deadline. `refreshOptionSources`' cursor
  resumes after the last key, and a batch never prunes a row referenced by a form
  outside it.
  `checkOptionSources` refuses each case listed under the PATCH route. The digest
  stays stable across key order.
- `admin/forms-model.test.ts`: `withOptionsFrom` drops the seeded option.
  `responses-model.test.ts`: `cellText` maps through `optionLabels` and falls back to
  the value.

**Workers (`test/workers/`, real workerd):**

- `forms.test.ts`: the descriptor's exact shape with `optionsFrom`, plus the unchanged
  shape for an unsourced form. A content-sourced form resolves published documents
  only, labelled in the render's locale, with values as story ids. A host-sourced form
  with no row compiles `unavailable`, and `reader.page()` answers it `no-store`. Resolve
  never calls `load`: give it a `load` that throws and count the calls, which must be
  zero. `/forms/resolved` materialises. An empty content list on a required question
  with no extras compiles not asked. A French render with the default order is sorted
  by French label. A form whose stored `fields` hold one unreadable question renders
  the others.
- `form-submit.test.ts`:
  - A crafted unpublished id is `invalid`.
  - A stale row is accepted without awaiting `load`. A `load` that throws is
    recorded by the `waitUntil` refresh, and a `load` that never settles does not
    delay the reply.
  - A never-loaded row refuses an answered question with 503 `source_unavailable`
    and accepts a blank optional one.
  - A lost lease re-reads on the primary: the proxy sees a `PRIMARY_FIRST` session.
  - A sourced question gated on another sourced question accepts a valid pair.
  - Two submits inside the lease call `load` once.
  - `option_labels` is stored.
  - The purge capability is called on a changed digest and on a first load, and not
    on an unchanged one.
- `read-session.test.ts`: the submit's content query and the store read go through
  `withSession`. Follow `bind`, as that file's proxy already does.
- `scope-partition.test.ts`: the fence test for `POST /forms/:id/option-preview`.
- `forms.test.ts` (PATCH): each `checkOptionSources` refusal. A settings change bumps
  `version` and fires `formChanged`. The save answers without awaiting `load`.
- `forms.test.ts` (preview): an invalid setting is `400` and `load` is not called. An
  unreferenced key answers a list and writes no row. A referenced key writes one.
- `forms.test.ts` (registry): `GET /forms/registry` requires a session, answers the
  brand's sources with no functions and `actions: []`, and answers `400
  site_required` unscoped on a branded deployment. `GET /api/schema` carries no source
  metadata.
- `migrations.test.ts`: `0016_option_sources.sql`'s table and column.
- Multi-brand: two brands registering the same source id keep separate rows and
  tags. A branded unscoped preview is `400 site_required`.

**End to end:** `scripts/option-sources-test.mjs` as in Phase 7, then
`./scripts/e2e-all.sh` before the tag.

**Verified by breaking** (record in Implementation notes). Remove the materialisation
from the submit route, and the crafted-POST test must fail. Make the render path call
`refreshList`, and the "resolve never calls load" test must fail. Drop `optionsFrom`
from `FORM_FIELD`, and the fixture test must fail. Load only the asked questions'
lists, and the gated-pair test must fail. Remove `hasUnavailableOptions` from
`reader.page()`, and the `no-store` test must fail.

## Dependencies

- Spec 33 (forms) and spec 35 (form logic), both landed. Spec 17 (caching), for the
  tag vocabulary and the purge path. Spec 34 (multi-brand), for per-brand config.
- No new binding and no new Cloudflare resource. Hosts apply `0016` (and spec 36's
  `0017`) before deploying v1.3.0.
  A host wanting lists fresher than the last submission adds one line to its existing
  `scheduled()`.
- Spec 36 builds after this spec and ships with it in v1.3.0. Neither needs the
  other's code to pass its own gates. The boundary section above is the contract
  between them, including the registry route this spec creates for both.

## Out of scope

- **Dependent dropdowns** (a city list narrowed by the chosen country): the list would
  depend on a visitor's answer, so it could not be resolved per form into an
  edge-cached `Resolution`. It would need a per-visitor request, which form-logic.md
  decision 12 refuses for the same cache.
- **Typeahead over a source**: it needs a public, per-keystroke query endpoint, which
  is an anonymous read API over host data with its own rate limiting. Validation would
  then run against a list nobody rendered.
- **A host source whose list differs per site**: decision 15. Per-site lists are what
  the `content` source does.
- **A `label` setting for the content source, and several types per source**: decision
  4. Both are additive later.
- **Translating a sourced label in the builder**: the source answers per locale. Typed
  extras keep their `i18n` translations.
- **Showing labels instead of values for typed option questions in Responses and the
  CSV**: decision 13. That is an existing behaviour and a separate change.
- **Sourced options on a block's `select` field** (`core/fields.ts`): block options are
  schema, declared in code, and a document's value does not go through a public POST.
- **`{base}/api/v1` routes and MCP tools for sources**: forms.md checkpoint 20's
  reason. The `submitted` hook and `refreshOptionSources` are the programmatic
  surface.

## Implementation notes

Built 2026-11-03 in seven phases on `feat/form-option-sources`: core vocabulary, the
`option_lists` store and lease, the render path, submit validation, save/cron/preview,
the admin, then the demo, the end-to-end script and the prose. A review after phase 6
found no High, one Medium and four Low findings; all but the last were fixed before the
tag (below). Spec 36 builds on this branch next and ships with it as v1.3.0.

**Where the spec was wrong or ambiguous, and what was done.** Each is the conservative
reading consistent with the Architecture decisions.

Core
- `screenOptionLabel` is a core copy of the server's printable-text test (core cannot
  import server). A label that fails it falls back to its value, and a truncated label is
  exactly 200 characters including the ellipsis.
- `contentOptionSettings` is strict: a `where` or `order` entry that `asCollectionValue`
  would drop makes the whole settings object null, and its keys are sorted.
- With `onInvalid`, a duplicate question name drops the later question (decision 19);
  without it, `validateFormFields` still throws.

Store
- `purgeOptionSource` is new in `cache-purge.ts` (the `createPurger` path was not
  exported). The second purge happens only with a `waitUntil`.
- The lease claim is one upsert, `returning digest, options is not null as had`; no row
  back means the lease was lost.
- Failure categories: not an array is `malformed`; `[]` is `empty`; no valid entry is
  `malformed`; a timeout races a timer that aborts the signal, so a `load` that ignores
  its signal is abandoned.
- A host value must be 1 to 120 characters, already trimmed and printable;
  whitespace-padded values are dropped, not trimmed.
- `readListOnPrimary` takes `Pick<D1Database, 'withSession'>` because `FolioDb` cannot
  open a session; `OptionListsContext.primary` is optional and the submit route passes
  `c.env.DB`. `FolioRuntime.rawDb(env)` serves the lost-lease primary re-read.
- Refresh `'submit'` without `waitUntil` uses a stale row as read and does not refresh it;
  a never-loaded row is still awaited for 3 seconds.
- Locale: the source locale and the config default map to `''`; other locales map to
  themselves, and only for a `localised` source.
- A content list is up to 5 pages of 100 fetched in parallel; the title collation is left
  to `materialiseOptions`. An unknown or singleton content type at render gives an empty
  list, and `checkOptionSources` refuses it at save.

Render
- `GET /forms/resolved` goes through `brandOf`: unscoped on a branded deployment it is now
  `400 site_required` (it was an empty chain). A behaviour change that follows the
  registry-read invariant.
- Collation applies only to `title` ascending or unset order. The locale is
  `active?.code ?? locales.default`.
- A sourced question with no resolved entry compiles `{ source, unavailable: true }`.
- An unsourced form costs no extra round trip; a sourced form without collections adds
  one (count and page together); with collections all statements are sent together.

Submit
- `FormResponse.optionLabels` and `ResponseRow.optionLabels` are required;
  `NewResponse.optionLabels` is optional and defaults to `{}`.
- The cap for a sourced `checkboxes` is `(500 + typed extras) x 120`.
- If any refusal falls on an unavailable-list question, the whole reply is
  `503 source_unavailable`, even with other invalid fields (decision 8).
- An unscoped submit on a branded deployment gets `404` at the chain check, before
  `brandOf`, so there is no `400 site_required` test on that route.
- The submit-time session behaviour is covered by `form-submit-sources.test.ts` through a
  lagging-replica proxy; `read-session.test.ts` was not extended.

Save, cron and preview
- An unreferenced preview key calls `load` directly: no lease and no row, because a lease
  is a row. Referenced keys go through `refreshList`.
- The preview chain is the request's (`requestChain` plus the request site), like
  `/forms/resolved`, where the spec text says "the form's chain". It shows what the
  editor's own site would render.
- Preview `total` for content comes from one extra query only when the page is full at
  500; for a host source it is the list length, `truncated` when just cut or at 500.
- `refreshOptionSources`: `due` counts lists after the cursor; lists whose lease another
  request held count as `unchanged`; concurrency 4, 10 seconds per load; the cursor is the
  last key only when more remain; the prune runs on every call and removes rows with
  `attempted_at` older than 7 days that no form references.
- `PATCH` calls `brandOf` only when the fields contain a sourced question.

Admin
- `OptionSourceEditor` and `SettingControl` live in
  `src/admin/ui/screens/OptionSourceEditor.tsx` because `FormBuilder` is already 1,366
  lines. The `dialogs.test` count went from 39 to 40.
- Text filters preview on blur or Enter rather than per keystroke. The "Under" picker
  shows the raw parent id (`DocumentPicker.onPick` gives only an id). The builder
  previews every saved sourced question once on load, so rules on unopened questions have
  their list. A sourced question with no known list falls back to free text in the rule
  editor. On a non-source locale the source select and settings are hidden and only the
  preview shows.
- Responses show the label in the table and label plus muted raw value in the drawer; the
  CSV `:value` column is built server-side.
- **Not browser-verified:** real blur and Enter commits, the layout of the settings,
  preview and warning, the `DocumentPicker` from "Under", the `.raw` line, and a number
  input mid-edit.

**The build review's findings, and what was done.**
- **M1 (fixed).** `new Intl.Collator('en_AU')` throws a `RangeError` in V8, and
  `validateLocales` accepts any `[A-Za-z0-9_-]` code, so a host with `en_AU` would have
  returned 500 on every page and submit of a title-ordered sourced form. The collator is
  now built through `collatorFor`: `_` becomes `-`, and a code still refused sorts with
  the default collator. Rejecting such codes in `validateLocales` was the alternative; it
  narrows a config key and would need a major bump.
- **L1 (fixed).** The 25-second delay of the second purge started when the load finished,
  so a slow vendor on the save or stale-submit path could push it past `waitUntil`'s 30
  seconds, where the runtime drops it silently. Those two paths now pass
  `requestStartedAt`, and the delay is `max(0, 25 s - elapsed since the request began)`.
  The cron passes none and keeps the full 25 seconds.
- **L2 (fixed).** The prune's `delete` re-checks `attempted_at < ?`, so a row a
  concurrent save just loaded is kept.
- **L3 (fixed).** `effectiveSettings` drops `null` and `''`, then fills each declared
  `default`, and runs before the list key, the lease and `load`. `{}`, `{ region: null }`
  and the default spelled out are now one list, and `load` receives the defaults.
- **L4 (release order, no code).** Until spec 36 counts `source_unavailable` as a refused
  attempt, a script POSTing to a form with a never-loaded list costs a lease write and a
  primary read per request, uncounted by `ratePerHour`. Vendor calls stay capped by the
  lease, so decision 7 holds. Spec 37 does not ship without spec 36: v1.3.0 is tagged only
  after 36's counting is merged.

**Phase 7.**
- **The demo had no seeded contact form**, because forms are rows an editor creates and
  `seed.sql` holds none. The "contact form" therefore lives in `scripts/seed-demo.mjs`,
  which creates a `contact` form (a `country` question from `countries`, and a `guide`
  question from published People, asked only when `country` is `au`, so one sourced
  question gates on the other) and drops a `contactForm` block on the showcase page. The
  demo's `countries` source was already registered in phase 5.
- **The `/dev/option-source` switch** is `?fail=1|0` (the demo's `countries` `load`
  throws) and `?stale=1` (ages every `option_lists` row by seven days, past its ttl and
  its lease). Both answer 404 off localhost like `/dev/last-signin`. `stale` is an addition
  to the spec: it is how the script sees a stale list accepted without waiting an hour.
- **The end-to-end script** has 15 checks over the four things the spec lists, plus the
  `unasked` record of a gated question and the CSV's `:value` column. It uses the `person`
  record type for the content source, because a record needs no parent page.
- **The shared UPGRADING section** is "v1.3.0 is roll-forward only"; spec 36 appends its
  bullets. This spec also rewrote the "Next free" sentence to `0018`.

**Verified by breaking** (phase 7 and the fixes; earlier phases' results are in their
reports). With `collatorFor`'s catch rethrowing, the `en_AU` unit test fails. With the
prune's `attempted_at < ?` removed from the delete, the race test fails. With the default
fill removed from `effectiveSettings`, the two settings tests fail. With the purge using
the full 25-second delay again, the request-timing test fails. Each was reverted by an
edit and the diff checked.
