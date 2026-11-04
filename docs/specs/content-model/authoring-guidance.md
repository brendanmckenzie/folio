# Feature: Authoring guidance in the schema, and content checks for agents

> **Group:** content model
> **Build order:** 40
> **Size:** L
> **Status:** built (2026-11-04, `feat/authoring-guidance`), ships in `v1.4.0`
> **Wire version:** none. Nothing here crosses the socket or the admin↔preview frame. Guidance rides inside the block schemas the manifest already serves over HTTP, and a check is an HTTP read. `PROTOCOL_VERSION` stays at 5
> **Migration:** none. Guidance is code (`defineBlock`, `createFolio`), and a check is computed on read from the document and one `stories` lookup. Nothing is stored
> **Release:** `v1.4.0`, a minor. Every change to the exports surface is additive: new optional keys on `defineBlock` and on the field builders, one new optional `createFolio` key, one new `{base}/api/v1` route, one new key on the v1 `/schema` answer, one new MCP tool. Ships beside spec 41 (agent CLI), which touches `AGENTS.md` and `bin/folio.mjs agents` too (Dependencies)
> **Last updated:** 2026-11-04

## Summary

An agent writing content into Folio today learns what a field *is* and nothing about
what belongs in it. `get_schema` answers the manifest, and a field there carries a
`label`, an optional one-line `help` and its kind's constraints (`src/core/fields.ts:10-59`).
There is nowhere to say "a hero heading is at most 60 characters", "write this in the
second person", or "this brand never says *cheap*". A block carries no description
at all (`src/core/schema.ts:29-47`), so an agent picking among AAA's 35 blocks
chooses from labels. Once it has written, it has no way to ask whether the page is
sound. `src/server/validate.ts` validates HTTP request bodies, not documents (its
header, `:1-19`). The content rules that exist are spread across three places that
an agent cannot call: `fieldShapeError` (`src/core/nested.ts:925`) runs only inside a
write, the audit's `DOCUMENT_CHECKS` (`src/server/audit.ts:429-436`) only over every
published document at `ADMIN`, and `translationGaps` (`src/core/locales.ts:303`)
only in the admin's publish dialog. Alt text, broken internal links and `required`
are checked nowhere a model can see.

This spec adds two things. **Writing guidance in the schema**: a block gains `help`
and `guidance`, a field gains `guidance`, the three prose kinds gain a `length`, and a
brand gains a `writing` guide (voice prose plus a list of terms to avoid). Block and
field guidance travel in the manifest, so `get_schema` and the admin's inspector both
read them. The brand guide travels only on the gated v1 `/schema`. **Content checks**:
one v1 route, `GET {base}/api/v1/documents/:id/check`, and one MCP tool,
`check_document`. It runs the rules that already exist plus the authoring checks
(empty required fields, missing alt text, broken or unpublished link targets,
untranslated fields, guidance violations) over one document. Each finding comes back
located by `{ uid, field, locale }`, the exact address `patch_fields` takes, with a
`fix` naming the tool that repairs it.

## Ground truth

Read at `704fbf9` (main, v1.3.1). Line numbers are for that commit.

**The premise correction.** The brief for this spec said "runs `validate.ts` rules".
`src/server/validate.ts` holds no content rules. It holds valibot schemas for request
bodies, params and headers, and says so (`:1-19`: "Schemas for every value the HTTP
routes read from outside"). `ContentPutBody` takes `content` as `v.unknown()`
(`:486-491`), and `FieldsPatchBody` takes each value as `v.unknown()` (`:505-523`),
because the field-level check belongs to `fieldShapeError`, which this file cannot
see. The rules a check should run are therefore `fieldShapeError`
(`core/nested.ts:925`), the audit's per-blok `DOCUMENT_CHECKS` (`server/audit.ts:429`),
and `translationStatus` (`core/locales.ts:274`). This spec runs those.

**core (`src/core/`):**

- `defineBlock` is the identity function over `BlockDef<F>` (`block.ts:49-51`), and
  `BlockDef` extends `BlockSchema` with `fields`, `summary` and `render`
  (`block.ts:17-47`). A new key on `BlockSchema` is therefore a new `defineBlock` key
  with no other change to the builder.
- **`toSchemaIndex` copies block keys by name** (`block.ts:104-119`): `name`, `label`,
  `summary`, `fields`, `presets`, `presetsOnly`, `previewParams`. A key added to
  `BlockSchema` and not to this list is silently absent from the manifest. **Fields are
  copied whole** (`fields: def.fields`, `:112`), so a new key on a field reaches the
  manifest with no change here.
- `toManifest` builds `{ types, blocks: Object.values(toSchemaIndex(registry)), root,
  globals, locales? }` (`block.ts:131-147`). `Manifest` (`schema.ts:136-186`) also
  carries `hooks`, `brand` and `settings`, spread in by the runtime.
- `Common` (`fields.ts:10-59`) holds `label`, `group`, `help`, `required`, `showIf`,
  `hidden`, `default`, `translatable`. `help` is an unbounded optional string
  (`:21`). Nothing caps it, so capping it now would throw at construction for a host
  whose `help` is long. This spec caps only the keys it adds.
- **Kind-specific keys are declared on an interface the kinds opt into, never on
  `Common`.** `Indexable` (`fields.ts:81-83`) and `Searchable` (`:105-107`) are the
  precedent, each with a comment saying which kinds carry it and why
  `richtext({ indexed: true })` must not compile. The prose kinds are `text` (`:127`),
  `textarea` (`:128`) and `richtext` (`:157-163`).
- **`required` is declared and not enforced on write.** `fields.ts:186-189` says so
  for `references.min` ("`required` is declared-and-ignored across the whole field
  system"). The one reader of `required` over documents is the audit's
  `requiredEmpty` (`audit.ts:1146-1158`), used only for site settings
  (`auditSettings`, `:1105`). Its blank rule is `undefined`, `null` or `''`.
- **There are three blank rules and they disagree.** `requiredEmpty` above treats
  `'  '` and an empty richtext document as filled. The admin's `isBlank`
  (`src/admin/ui/screens/inspector-model.ts:367`) and `core/locales.ts`'s private
  `isEmptySource` (`:321-327`) both treat them as blank, and `isBlank`'s comment says
  it is stated "the same way for the same reason" as `isEmptySource`.
- `AssetValue.alt` is a required string on the stored value (`values.ts:27-39`), and
  `asAsset` reads an absent one as `''` (`values.ts:163`). **An empty `alt` therefore
  cannot mean "deliberately decorative"**: it is also what every asset holds before
  anybody types one.
- **Richtext has no image node.** `RichtextNodeName` (`richtext.ts:18-27`) is
  paragraph, heading, lists, blockquote, codeBlock, horizontalRule, hardBreak. Alt text
  lives only on `asset` and `multiasset` values.
- `richtextToText` (`richtext.ts:283`) and `isRichtextEmpty` (`:300`) exist and are
  what a length measure over richtext should use.
- `fieldShapeError(field, value)` (`nested.ts:925-984`) answers a sentence fragment or
  null, is exhaustive over kinds (`never` default, `:978`), and treats `null` as valid
  for every kind (`:926`). Its `date` arm is `dateError` (`:897`).
- `NestedError` carries a dotted path into the payload (`nested.ts:101-111`). The path
  helpers `childPath` and `fieldPath` (`:256-260`) and the sorted child index
  (`childIndex`, `:160`) are private to the file.
- `translationStatus(doc, schema, locale)` (`locales.ts:274-298`) answers
  `{ total, translated, missing: TranslationGap[] }`, where a gap is
  `{ uid, type, field, label }` (`:247-254`), and skips fields whose source is empty.
  `translationGaps` (`:303-318`) runs it for every non-source locale.
- `core/refs.ts` walks link targets: `storedValues(blok, name)` (`:65-76`, source plus
  every locale's override, without saying which), `richtextLinks(value, visit)`
  (`:83-101`, Folio-native `attrs.link` marks only), `linkedIds` (`:110`),
  `referencedIdsAllLocales` (`:150`) and `outboundRefs` (`:279`). All four answer
  per document, not per blok and field. The file header names the bug a second
  richtext walker invites ("two recursive walkers over the same tree is two places to
  forget `node.content`", `:86-88`).
- `computeBlocksDigest` uses only block names and field names and kinds
  (`registry-digest.ts:5-12, 19-30`), so new guidance keys cannot trip the preview's
  wrong-bundle banner.

**server (`src/server/`):**

- `GET {base}/api/schema` is **unauthenticated** (`app.ts:154`), and the comment above
  it (`app.ts:130-150`) states the rule for what may go in the manifest: "the
  *declarations a client needs before it can authenticate*", ending "would you be
  content to see it in an unauthenticated `curl`? If the answer needs a caveat, it goes
  on `/me`." Field `help`, labels and preset data already ride there.
- `GET {base}/api/v1/schema` is gated at `READ` (`routes/api/index.ts:54-86`), answers
  `brand.manifest` through `brandOf(c)`, and on a multi-site deployment spreads a
  `scope` object beside it (`:77-85`). `brandOf` throws `site_required` when the
  request has no brand (`routes/stories.ts:113-122`).
- `BrandRuntime` (`runtime.ts:272-339`) holds every per-brand thing: `registry`,
  `schema`, `types`, `manifest` (`:283`), `gate`, `forms`, `describe`, and more.
  `prepareBrand` (`runtime.ts:786-876`) validates one brand's config at construction
  (`validatePresets` `:797`, `validateTypes` `:802`, then gate, describe, forms,
  globals, migrations) and its `catch` prefixes every refusal with the brand id
  (`:872-875`). The manifest is assembled at `runtime.ts:2092-2097`.
- `BRAND_KEYS` (`runtime.ts:678-689`) lists the keys a branded config must not carry
  at the top level, and `validateBrands` refuses them (`:731-737`). `FolioBrand`
  (`types.ts:654-670`), `FolioBrandedConfig` (`types.ts:679-720`, an `Omit` list plus
  `?: never` per moved key) and `FolioSingleConfig` (`types.ts:722`) are the three
  config shapes a per-brand key has to appear in.
- `GET /api/v1/documents/:id` (`routes/api/documents.ts:358-370`) is the read pattern
  this spec copies: `requireAccess(READ)`, `load(c, id, 'read')` (the fence,
  `:215-245`), `ensureAccess(READ_DRAFT)` for `?status=draft`, `draftOf(c, rt)(story)`
  for the draft (which goes through `initDraft`), `publishedFor` for the published
  copy, `askedLocale` for `?locale=`.
- `PATCH /api/v1/documents/:id/fields` (`documents.ts:582-631`) addresses the root by
  `fields` and any blok, **the root included**, by `bloks: [{ uid, fields }]`
  (`setsFor`, `:596-624`). It refuses a name the block does not declare and a `blocks`
  field, runs `fieldShapeError` per value, and **silently skips an unknown uid**
  (`:598`). `locale` scopes every `set` in the request.
- `layerOption(c, rt, story)` (`documents.ts:178-189`) answers `{ layer: 'bare' }` for a
  layer document with something below it. `auditDocuments` skips `missing-field` on a
  bare layer (`audit.ts:991`) because absent means inherited there.
- `DocumentCheck` is `(blok, def, ctx) => Finding[]` with `Finding = { check, type,
  field }` (`audit.ts:97-104, 306-310`). `unknown-locale` puts the **locale code** in
  `field` (`:400-407`). `date-invalid` reads source values only (`:417-426`).
- `storiesFor(db, ids, paths, chain)` (`stories.ts:316`) takes a `FolioDb` and a
  required chain, answers `StoryMeta[]`, is safe for any number of ids, and costs no
  read for an empty set. `requestChain(c, rt)` (`middleware.ts:568-575`) is
  `['default']` with no `sites`.
- `MCP_TOOLS` (`mcp/tools.ts:124-539`) is declarative. "A verb that is not a v1 route
  cannot be a tool" (`:10-11`). `narrowed` is for a tool whose `need` is stricter than
  its route's or that has no route (`:98-105`). `get_schema` is `GET /schema` at `READ`
  (`:126-134`). `patch_fields` is `:358-391`.
- MCP `INSTRUCTIONS` (`routes/mcp.ts:89-93`) is served by `server/discover`
  (`:400-406`), which **answers without a credential** (its comment, `:388-392`).
  `instructionsFor` (`:363-380`) appends a scope sentence. `described` (`:296-312`)
  appends the brand's type or block names to a tool description.
- `IMPLIES` (`auth/roles.ts:67-78`): `content:write` and `publish` both imply
  `content:read:draft`. Every token that can write a draft can read one.

**admin (`src/admin/`):**

- `FieldRow` passes `field.help` to `Field` (`ui/screens/fields/FieldRow.tsx:152`) and
  computes `fieldWarning(field, value)` (`:84`). `Field` renders `error` in place of
  `help` (`ui/Field.tsx:41-62`).
- `fieldWarning` (`ui/screens/inspector-model.ts:342-360`) is the admin's one answer
  to "is this field satisfied": references `min`, multiasset `max`, number bounds,
  `required`. Its comment says it was gathered into one function because three inputs
  each held a piece.
- The block picker derives each entry's description from the block's fields
  (`ui/screens/block-picker-model.ts:24-28, 152-183`) and argues that a derived
  description "cannot drift from the block it describes, which a hand-written one does
  the first time a field is renamed".

**tests:**

- `test/unit/mcp/tools.test.ts` pins the table at sixteen tools (`:104-118`), every
  route-backed row against a declared v1 route (`:120-128`), every v1 route as a tool
  or a named exclusion (`NOT_TOOLS`, `:86-102`), the narrowed list (`:333-352`) and the
  `need` scope of every tool (`:354-374`).
- `test/workers/scope-partition.test.ts` reads every mounted id route from Hono and
  fails on one not in its fence table (`:780-800` for the v1 document routes).
- `test/workers/api-partition.test.ts` pins the `{base}/api` and `{base}/api/v1`
  partition.

**consumers:** `examples/starter/src/blocks/page.tsx:19-23` declares the meta
description as `textarea({ help: "Shown in search results. Around 150 characters." })`,
a length limit written as prose because there is nowhere else to write it.

## User stories

### An agent writes a hero that fits
**As** an agent asked to write a landing page **I want to** read each field's purpose,
length limit, tone and examples from `get_schema` **so that** my first draft fits the
layout and the brand rather than being rewritten by a person.

### An agent checks its own work before publishing
**As** an agent that has just written a page **I want to** call one tool that tells me
what is wrong and exactly where, in terms I can patch **so that** I fix the alt text,
the over-long heading and the link to a deleted page before a person reviews it.

### A developer writes the style guide once
**As** a developer **I want to** put the brand's voice and banned terms in config
beside its blocks **so that** every agent session against every site of that brand
reads the same guide, and the other brand's guide never reaches it.

### An editor sees the limit as they type
**As** an editor **I want to** see a character count against the field's limit and the
field's examples **so that** the same guidance an agent reads helps me too.

### A host that declares no guidance sees nothing new
**As** a host upgrading to `v1.4.0` **I want** my manifest, my admin and my v1
answers unchanged until I declare guidance **so that** the upgrade is a version bump.

## Architecture decisions

### 1. A field's purpose is its existing `help`; `guidance` adds tone and examples beside it

A field gains `guidance?: Guidance` on `Common`, where
`Guidance = { tone?: string; examples?: readonly string[] }`. The field's *purpose*
stays where it already is, in `help`, which people read under the input and agents
already receive in `get_schema`.

**Beat `guidance.purpose` beside `help`.** Two sentences describing one field drift
apart, and a model handed both has to decide which is true. `help` is already the one
line written for whoever fills the field in, and an agent is somebody filling the field
in. Keeping purpose in `help` also means every field a host has already annotated is
annotated for agents on the day they upgrade.

`guidance` is on `Common`, so every kind may carry it, including `blocks` (a slot's
tone and examples: "two to four feature cards, each a benefit"). It is advisory text
and nothing reads it but people and models.

### 2. `length` is its own key on the three prose kinds, typed so it cannot compile elsewhere

`text`, `textarea` and `richtext` gain `length?: TextLength`, declared on a new
`Measured` interface those three opt into, exactly as `Indexable` and `Searchable` do:

```ts
interface TextLength {
  min?: number; // non-negative integer
  max?: number; // positive integer
  unit?: "characters" | "words"; // default "characters"
}
```

**Beat `guidance.length` on `Common`.** That compiles on `number`, `asset` and
`blocks`, where a length means nothing, and the codebase's own precedent is that a key
which can never take effect on a kind does not compile on it (`fields.ts:70-79`).
**Beat `maxLength`/`minLength`/`maxWords` as four flat keys.** One object with a unit
cannot say "at most 60 characters and at least 10 words", and nobody has asked it to.
Four keys could, and would need a rule for which one wins.

`multiasset.max`, `references.min` and `references.max` already exist and keep their
meaning. They count items, not text.

### 3. Length is advisory: it never refuses a write or a publish

A value over its `length.max` is written, saved, synced and published like any other.
It is reported by `check_document` (decision 9) and shown in the inspector
(decision 14).

**Beat enforcing it in `fieldShapeError`.** That function runs on every v1 write and
answers `bad_request`, so an over-long heading would make a whole `write_content`
payload fail, and the agent's next move would be to truncate mid-word. A German
translation runs a third longer than its English source, and a limit that refused it
would refuse the translator. A person typing in the inspector has no refusal path at
all: keystrokes go to the Durable Object. And `required` is "declared-and-ignored
across the whole field system" (`fields.ts:186-189`), so a length that refused writes
would be the one enforced soft constraint in a system that enforces none.

### 4. Length counts code points, or whitespace-separated words, over plain text, per stored value

`measureText(field, value)` in `core/guidance.ts` answers the length of one stored
value. For `text` and `textarea` that is the string. For `richtext` it is
`richtextToText(asRichtext(value))`. `characters` is the number of Unicode code points
(`[...s].length`) after trimming. `words` is the number of runs of non-whitespace
(`s.trim().split(/\s+/u)`, filtered non-empty). Each stored value is measured on its
own: the source value in `data`, and each locale's override in `i18n`. A null or
absent value is not measured, because emptiness is `required`'s business.

**Beat grapheme clusters (`Intl.Segmenter`).** They are the "characters" a person
counts, and an emoji with a skin-tone modifier is one of them and four code points.
But the limits hosts quote (a search snippet, a card that fits three lines) are
themselves approximations, and code points give the same answer in workerd and every
browser with no segmentation data and no locale argument. A count that disagrees by
one between the inspector's counter and the check is worse than a count that
over-counts an emoji.

Words split on whitespace undercount Chinese, Japanese and Thai, which do not separate
words with spaces. A host writing those languages should use `characters` (Edge
cases).

### 5. A block gains `help` and `guidance`, and `toSchemaIndex` copies both

`BlockSchema` gains `help?: string` (what the block is for and when to choose it, at
most 500 characters) and `guidance?: Guidance` (decision 1's shape: tone, and examples
of good use). `toSchemaIndex` (`block.ts:104-119`) copies both, spread only when
declared, so a manifest with no block guidance serialises byte-identically to
`v1.3.x`'s.

The same word as the field's, for the same thing: one line a person and a model both
read. **Beat `description` or `purpose`.** A second word for the one concept would
make a host ask which to use where.

The block picker shows `help` as the entry's first line **and keeps its derived
description** as the second. **Beat replacing the derived description.** The picker's
own argument (`block-picker-model.ts:24-28`) stands: a derived list of what the block
holds cannot drift. `help` says what a list of fields cannot, which is when to use the
block. The two answer different questions.

### 6. The brand's voice is `writing` on the brand's config, held on `BrandRuntime`, and never in the manifest

A new optional config key, per brand:

```ts
interface WritingGuide {
  /** Voice, audience, tone, house style. Markdown, served to agents verbatim. */
  voice: string;
  /** Terms this brand does not use, each with what to say instead. Checked (decision 7). */
  avoid?: readonly { term: string; use?: string; reason?: string }[];
}
```

It is `FolioSingleConfig.writing` and `FolioBrand.writing`, and refused at the top
level of a branded config (`BRAND_KEYS`, the `Omit` list and `writing?: never`),
exactly like `describe` and `forms`. `prepareBrand` validates it and `BrandRuntime`
holds it as `writing: WritingGuide | null`. `FolioRuntime` gets no `writing` member:
every registry read goes through the scope's brand, and so does this one.

**It is served on `GET {base}/api/v1/schema` only**, as a `writing` key beside the
manifest, present only when the brand declares one. `get_schema` is that route, so an
agent receives the guide in the call it is already told to make first.

**The admin does not show the guide in v1.4.** It reaches agents through `get_schema`
and the editors' own style guide stays where the brand keeps it. **Beat a session-gated
admin route and a guide panel**: it is a second surface for prose nobody asked to see
in the editor, and it can be added later without changing the key.

**Beat putting it on `Manifest`.** The manifest is served unauthenticated at
`{base}/api/schema` (`app.ts:154`), and the rule above that route admits only "the
declarations a client needs before it can authenticate". A style guide is not one of
those, and a brand's guide can carry things a brand would rather not publish
("never mention the Smith account", competitor names in `avoid`). Field and block
guidance stay in the manifest, because they are declarations of the same kind as the
`help` and preset data already there. The handbook says plainly that they are public
(Documentation).

**Beat the MCP `instructions`.** They are built at `server/discover`, which answers
without a credential (`routes/mcp.ts:388-392`), so the same objection applies. The
instructions gain one static sentence pointing at `get_schema`'s `writing` and at
`check_document` (decision 12). That sentence contains nothing of the guide.

**Beat a `get_writing_guide` tool and a `/writing` route.** A second read for something
an agent needs every time it writes is a round trip spent on every task, and "call
get_schema first" is already the instruction. One more key on an answer that is
already per brand and already gated costs nothing.

### 7. `avoid` is the one machine-checked part of the voice; the prose is never judged

`check_document` reports a `term-avoided` finding for each `avoid` term that appears
in a source-locale `text`, `textarea` or `richtext` value. Matching is case-insensitive,
on Unicode word boundaries (the term must not be preceded or followed by a letter or a
digit), over the term escaped as a literal. The finding carries the term and its `use`.

**Beat host-supplied regular expressions.** A regex from config runs on every check in
the Worker's CPU budget, a catastrophic one is a denial of service the host wrote
itself, and a model handed `/\bsynerg(y|ies|istic)\b/i` as a reason cannot tell what to
write instead. **Beat judging tone with a model.** Folio picks no model and holds no API
key (`media-library.md` decision 8, the same principle). The agent reading the voice
prose *is* the model, and it is the one already in the loop.

Source locale only. A term list is written in one language, and matching an English
term against French prose finds nothing or finds the wrong thing.

### 8. The checks are one v1 route and one MCP tool

`GET {base}/api/v1/documents/:id/check` answers a `ContentCheckReport`, and
`check_document` is that route as a tool row. The admin's `{base}/api` gets nothing.

**Beat an MCP-only tool.** "A verb that is not a v1 route cannot be a tool"
(`mcp/tools.ts:10-11`, `mcp-server.md` decision 2), so the check has to be a route
first, and a host's CI script can then call the same route an agent does.
**Beat a dry-run flag on `write_content`.** A check of what an agent is about to write
would give the write route a second response shape, and it cannot check a document
somebody else wrote, which is the review case. **Beat folding it into
`get_document`.** That answer is the round-trippable document shape and is a v1
promise. Findings beside it would be bytes every read pays for and every writer has to
strip.

GET, because it reads and changes nothing. Its path is under `documents/:id` because
it is a fact about one document, and the scope fence (`load`) applies unchanged.

### 9. A check reuses every rule that already exists and adds the authoring ones in one list

`src/server/checks.ts` runs, per blok, in this order:

1. **The audit's `DOCUMENT_CHECKS`** (`audit.ts:429`), imported as the array, minus
   `date-invalid`, which rule 2 subsumes (it calls the same `dateError`). Reusing the
   array means a drift check added to the audit later appears in `check_document`
   with no change here.
2. **`field-shape`**: `fieldShapeError` over every declared non-`blocks` field's
   source value and every locale override. The admin writes through the Durable Object
   and an importer writes through `folio/engine`, neither of which runs it.
3. **`AUTHORING_CHECKS`**, a new array in `checks.ts` with the same signature
   discipline as the audit's (one function per check, each returning findings, the
   array the whole extension point): `required-empty`, `alt-missing`, `length-over`,
   `length-under`, `term-avoided`, `translation-missing`.
4. **The link and reference checks**, which need the target rows and so run once per
   document after one `storiesFor` read (decision 11): `link-broken`,
   `link-unpublished`, `reference-broken`, `reference-unpublished`.

**Beat adding the authoring checks to `DOCUMENT_CHECKS`.** The audit is the drift
report: "what state the content actually is in, as against what the code now says it
should be" (`audit.ts:1-4`). Its Model screen tallies findings across every published
document and keys off their names. Four hundred heroes without alt text would bury the
orphan key it exists to find. Drift is also a per-document problem, which is why the
check imports the audit's list. Content quality is not schema drift, which is why the
audit does not import the check's list.

**Beat a fresh set of rules in `checks.ts`.** A second `fieldShapeError` or a second
translation walk is a rule that drifts from the one writes and the publish dialog use.

### 10. A finding is addressed the way `patch_fields` addresses a write

```ts
interface ContentCheck {
  check: string;                          // stable kebab-case name
  severity: "error" | "warning" | "info";
  message: string;                        // one sentence, names the field's label
  uid: string;                            // the blok; the root's uid for a root field
  type: string;                           // block type
  field: string | null;                   // null when the finding is about the blok
  locale?: string;                        // present when the finding is about one locale's value
  path: string;                           // the blok's place in the nested shape, '' for the root
  fix: "patch_fields" | "write_content" | "schema";
  detail?: Record<string, Json>;          // per check, listed in "Wire & schema changes"
}
```

`{ uid, field, locale }` maps one-to-one onto a `patch_fields` call:
`{ id, bloks: [{ uid, fields: { [field]: value } }], locale }`. That works for the root
too, because `setsFor` addresses any uid (`documents.ts:596-624`). `fix` says which
tool repairs it: `patch_fields` for a value, `write_content` for structure (an unknown
block type, an empty required slot), and `schema` for drift only a code change or a
content migration can clear (orphan keys, translations in an untranslatable field, an
undeclared locale). An agent that meets `schema` tells its person rather than trying a
write that will be refused. `path` is for people reading the report and for an agent
holding the nested document from `get_document`. It uses the grammar `NestedError`
already uses, computed by the same private helpers (Implementation plan, phase 1).

**Beat shipping ready-made `patch_fields` arguments.** The value is the agent's to
write. A pre-built call holding `null` or the current value invites an agent to send
it as-is, which blanks a field or writes nothing. **Beat a JSON Pointer into the stored
`Doc`.** No tool takes one, and the stored shape (`bloks` keyed by uid, `parent`,
`slot`, fractional `order`) is not the shape any v1 caller sees.

### 11. Link and reference targets are one `storiesFor` read over the request's chain, and nothing else

The check collects every story id the document links to or references, with the
blok, field and locale each came from (decision 13's per-field walk), and reads them
in one `storiesFor(db, ids, [], await requestChain(c, rt))` on the request's session.
A target is:

| Target | Link (`multilink`, richtext mark) | Reference (`reference`, `references`) |
| --- | --- | --- |
| absent from the answer (deleted, or outside the chain) | `link-broken` (error) | `reference-broken` (error) |
| present, not a `page` kind | `link-broken` (error): an unrouted document has no URL (`fields.ts:144-150`) | fine |
| present, type not in the field's `types` | `link-broken` (error) | `reference-broken` (error): `resolveReference` re-checks `types` and drops it |
| present, `state` is `draft` or `unpublished` | `link-unpublished` (warning) | `reference-unpublished` (warning) |
| present, `live` or `changed` | fine | fine |

**A target outside the chain reads exactly like a deleted one** (the multi-site
invariant "an id outside the chain resolves exactly like a deleted one"). On a branded
deployment the chain never crosses a brand, so another brand's story id is broken.

The check reads **no target document** and opens **no Durable Object** for a target.
`resolve()`'s draft branch must not ask a deleted story for its draft, because that
creates the object; this check never asks at all, because a row's `state` answers
everything the table needs.

**Beat calling `resolve()` and reading `broken` off the resolution.** It answers
`broken` for a link only, says nothing about why, and on the draft branch costs a
Durable Object round trip per target. The table above needs one indexed read.

### 12. `status` defaults to `draft`; access mirrors `get_document`; the tool is not narrowed

`?status=draft` (the default) checks the live draft and needs `content:read:draft`,
via the same `ensureAccess(rt, c.var.actor, READ_DRAFT)` `GET /documents/:id` makes.
`?status=published` checks the published snapshot at `content:read`. The route is
`requireAccess(READ)`. The tool's `need` is `READ`, the route's own, so the tool is not
`narrowed`. A content:read-only token is offered the tool, and a bare call is refused
by the route's own `forbidden` naming `content:read:draft`, which is the v1 pattern
(`mcp-server.md` decision 2).

**Beat defaulting to `published`, as `get_document` does.** A check exists to run
before a publish. An agent that checks the published copy of what it just wrote sees
the old page and concludes it is clean. Every token that can write can read the draft
(`roles.ts:67-78`), so the default costs no writing agent anything.

### 13. One walker per edge kind: `refs.ts` gains a per-field walk built on its own helpers

`core/refs.ts` gains `blokTargets(blok, def): BlokTarget[]`, where
`BlokTarget = { field, locale: string | null, id, kind: "link" | "reference", via: "field" | "richtext" }`.
It is built on the file's existing `richtextLinks` and on `storedValues` split by
locale (`storedValuesByLocale`, with `storedValues` reimplemented as its flattening).
`linkedIds` and `referencedIdsAllLocales` are not changed. A unit test pins that the
union of `blokTargets` over every blok equals `linkedIds ∪ referencedIdsAllLocales` on
a fixture with a link in a French richtext override, so the two cannot drift.

**Beat a second richtext walker in `checks.ts`.** `refs.ts`'s header names that exact
mistake. **Beat rewriting `linkedIds` on top of `blokTargets`.** It is on `resolve()`'s
path and `read-session.test.ts` counts its queries. Leaving it alone keeps this spec
off the render path entirely.

### 14. The admin shows field guidance live, and its logic lives in the model files

In the inspector, for a field with guidance:

- **A counter** beside the label for a field with `length`: `42 / 60` (or `12 words`
  against a word limit), reading the value the input is bound to, in the locale being
  edited. Over `max` (or under `min` with something typed) the counter takes the
  warning colour, and `fieldWarning` answers the same sentence `check_document`'s
  `length-over` / `length-under` message uses. Nothing is refused.
- **A "Writing guide" disclosure** under `help` when the field declares `guidance`,
  holding the tone and the examples. Closed by default, because the inspector is dense
  and an editor needs it once.
- **Block `help`** under the block's heading in the inspector, and as the first line of
  its block picker entry (decision 5).

`fieldWarning` (`inspector-model.ts:342`) gains the length case, reading
`measureText` from `core/guidance.ts`. The counter's text is a new pure function,
`lengthCounter(field, value)`, in `inspector-model.ts`. The picker's first line comes
from `entriesFor` (`block-picker-model.ts:152`). The components only draw what those
answer.

**Beat computing the count in `FieldRow.tsx`.** Component-file logic is where the
September 2026 UI reports came from, and a pure function is the only place a unit test
can pin "the inspector and the check agree on the number".

### 15. One blank rule, moved to core, used by the inspector, the check and the settings audit

The admin's `isBlank` moves to `core/fields.ts` as `isBlankValue(field, value)`. The
inspector imports it from there. `locales.ts`'s `isEmptySource` becomes a call to it.
`check_document`'s `required-empty` uses it. The audit's `requiredEmpty`
(`audit.ts:1146`) switches to it for non-`blocks` fields, its slot rule unchanged.

**This is a sanctioned behaviour change to `/folio/audit`.** A required site setting
holding only whitespace, or an empty richtext document, starts being reported as
`required-setting`. That is what the inspector already says about the same field, and
the audit disagreeing with the inspector is the bug. **Beat a fourth blank rule in
`checks.ts`.** The inspector's red "Required" and the agent's `required-empty` would
disagree about a whitespace heading, and the agent would be told a field is fine that a
person sees flagged.

### 16. `decorative` opts an image field out of the alt-text check

`asset` and `multiasset` gain `decorative?: boolean`. A field declaring it is skipped
by `alt-missing`. Everything else about the field is unchanged, including its alt
input.

**Beat reading an empty `alt` as "decorative".** `''` is also what every asset holds
before anybody types (`values.ts:163`), so the two cannot be told apart. A background
texture would otherwise be a permanent warning on every page that uses it, and a check
that is always noisy is a check nobody reads.

`alt-missing` fires only for a value whose `contentType` starts with `image/`. A PDF
in an asset field has no alt text to want.

### 17. Findings are complete in their counts, capped in their list, and ordered errors first

The report carries `counts: { error, warning, info }` over **every** finding, then
`findings` sorted by severity (error, warning, info), then document order (root first,
depth first in the nested shape's order), then field declaration order, then the source
locale before the others in `locales.available` order. At most 500 findings are listed,
and `truncated: true` says the cap was hit.

**Beat document order alone.** A French page with 600 untranslated fields would push
its one broken link past the cap. **Beat no cap.** A report the size of the document is
a report no agent context holds.

### 18. Nothing blocks a publish

`publish_document`, `POST /documents/:id/publish` and the admin's publish are unchanged.
The MCP instructions tell an agent to check before publishing (decision 6's sentence),
and that is the whole of the coupling.

**Beat refusing a publish on `error` findings.** `required` is not enforced anywhere
today, and a publish that started refusing on it would break the v1 publish route's
contract for every script that calls it, and would block the people editing the
same document behind a check written for agents. A check is a tool an agent uses.
It does not decide whether a page goes live.

## Wire & schema changes

### D1 migration

None. Nothing is stored. Next free stays `0018`.

### Core types (`folio/core`, additive)

```ts
// core/fields.ts
export interface Guidance {
  /** How to write it: voice, register, what to lead with. At most 500 characters. */
  tone?: string;
  /** Good values, as plain text. At most 10, each 1-500 characters. */
  examples?: readonly string[];
}

export interface TextLength {
  min?: number; // integer >= 0
  max?: number; // integer >= 1, and >= min
  unit?: "characters" | "words"; // default "characters"
}

interface Common {
  // ...existing keys unchanged...
  /** Writing guidance for people and agents. Advisory; nothing enforces it. */
  guidance?: Guidance;
}

/** On text, textarea and richtext only (decision 2). */
interface Measured {
  /** Advisory: reported by check_document and the inspector, never refused. */
  length?: TextLength;
}

// text, textarea and richtext gain `& Measured`.
// asset and multiasset gain `decorative?: boolean`.

export function isBlankValue(field: Field, value: Json | undefined): boolean; // moved from admin
```

```ts
// core/schema.ts
export interface BlockSchema {
  // ...existing keys unchanged...
  /** What this block is for and when to choose it. At most 500 characters. */
  help?: string;
  guidance?: Guidance;
}
```

```ts
// core/guidance.ts (new; not exported from folio/core except the two types above)
export function measureText(field: Field, value: Json): number | null; // null: not a measured kind, or empty
export function lengthProblem(field: Field, value: Json):
  | { kind: "over" | "under"; length: number; limit: number; unit: "characters" | "words" }
  | null;
export function validateGuidance(schema: SchemaIndex): void; // construction-time
```

`Guidance` and `TextLength` are exported as types from `folio/core`. No new runtime
export, so `release.mjs`'s `anchors` list is unchanged.

Every existing document, log and manifest is untouched: these keys live in code, and
`toSchemaIndex` spreads the two block keys only when declared.

### Server types (`folio/server`, additive)

```ts
export interface WritingGuide {
  voice: string; // 1-16,000 characters
  avoid?: readonly { term: string; use?: string; reason?: string }[]; // at most 200
}

// FolioSingleConfig.writing?: WritingGuide
// FolioBrand.writing?: WritingGuide
// FolioBrandedConfig: 'writing' in the Omit list, writing?: never, and in BRAND_KEYS

export type ContentCheckSeverity = "error" | "warning" | "info";
export interface ContentCheck { /* decision 10 */ }
export interface ContentCheckReport {
  id: string;
  source: "draft" | "published";
  /** Present when ?locale= narrowed the locale checks. */
  locale?: string;
  counts: Record<ContentCheckSeverity, number>;
  findings: ContentCheck[];
  truncated: boolean;
}
```

`WritingGuide`, `ContentCheck`, `ContentCheckSeverity` and `ContentCheckReport` are
type exports from `folio/server`, beside `ApiDocument` (`server/index.tsx:129`).

### The checks

| `check` | Severity | `field` / `locale` | `fix` | `detail` | Source |
| --- | --- | --- | --- | --- | --- |
| `unknown-type` | error | null | `write_content` | none | `DOCUMENT_CHECKS` |
| `field-shape` | error | the field, locale if an override | `patch_fields` | `{ reason }` (the `fieldShapeError` fragment) | `fieldShapeError` |
| `link-broken` | error | the field, locale if an override | `patch_fields` | `{ target, reason: "missing" \| "unrouted" \| "type" }` | decision 11 |
| `reference-broken` | error | as above | `patch_fields` | `{ target, reason: "missing" \| "type" }` | decision 11 |
| `required-empty` | warning | the field | `patch_fields`, or `write_content` for a `blocks` slot | none | `isBlankValue` |
| `alt-missing` | warning | the field, locale if a translatable override | `patch_fields` | `{ index }` for `multiasset` | decision 16 |
| `length-over` | warning | the field, locale if an override | `patch_fields` | `{ length, max, unit }` | `lengthProblem` |
| `length-under` | warning | as above | `patch_fields` | `{ length, min, unit }` | `lengthProblem` |
| `term-avoided` | warning | the field | `patch_fields` | `{ term, use? }` | decision 7 |
| `link-unpublished` | warning | the field, locale if an override | `patch_fields` | `{ target, state }` | decision 11 |
| `reference-unpublished` | warning | as above | `patch_fields` | `{ target, state }` | decision 11 |
| `orphan-key` | warning | the key | `schema` | none | `DOCUMENT_CHECKS` |
| `translated-not-translatable` | warning | the field | `schema` | none | `DOCUMENT_CHECKS` |
| `unknown-locale` | warning | null, `locale` is the code | `schema` | none | `DOCUMENT_CHECKS` (its `field` is moved to `locale`) |
| `missing-field` | info | the field | `patch_fields` | none | `DOCUMENT_CHECKS` |
| `translation-missing` | info | the field, `locale` | `patch_fields` | none | `translationStatus` |

The `check` names are a v1 contract from `v1.4.0`: a name may be added, never renamed
or removed within `v1`. The `message` text is not a contract.

On a **bare layer** (`layerOption` answers `{ layer: 'bare' }`), `missing-field` and
`required-empty` are skipped, as the audit skips `missing-field`, because absent means
inherited.

### New or changed routes

**`GET {base}/api/v1/documents/:id/check`** (new)

- Auth: `requireAccess(READ)`. `status=draft` (the default) also needs
  `content:read:draft` (`ensureAccess(READ_DRAFT)`).
- Query: `status` (`draft` | `published`, default `draft`; anything else is
  `400 bad_request`), `locale` (optional, screened by `localeQuery` and checked
  against the declared set like `GET /documents/:id`'s: unknown is `422 unsupported`).
  With `locale`, `translation-missing` and every per-locale finding are limited to that
  locale. Source-locale findings are always reported.
- Fence: `load(c, id, 'read')`. Outside the fence is `404 not_found`, never `403`.
- `status=published` with nothing published: `404 not_found`, the message
  `publishedFor` already gives.
- Response `200`: `ContentCheckReport`.
- On a branded deployment with no scope: `400 site_required`, from `brandOf`.

```json
{
  "id": "sty_8f2c",
  "source": "draft",
  "counts": { "error": 1, "warning": 2, "info": 0 },
  "findings": [
    {
      "check": "link-broken",
      "severity": "error",
      "message": "Button target links to a document that does not exist on this site.",
      "uid": "b41e9a0c",
      "type": "button",
      "field": "target",
      "path": "fields.body[0].fields.actions[0]",
      "fix": "patch_fields",
      "detail": { "target": "sty_dead", "reason": "missing" }
    },
    {
      "check": "length-over",
      "severity": "warning",
      "message": "Heading is 74 characters; the limit is 60.",
      "uid": "0c1d77aa",
      "type": "hero",
      "field": "heading",
      "path": "fields.body[0]",
      "fix": "patch_fields",
      "detail": { "length": 74, "max": 60, "unit": "characters" }
    },
    {
      "check": "alt-missing",
      "severity": "warning",
      "message": "Background image has no alt text.",
      "uid": "0c1d77aa",
      "type": "hero",
      "field": "image",
      "path": "fields.body[0]",
      "fix": "patch_fields"
    }
  ],
  "truncated": false
}
```

(The `path` grammar is whatever `NestedError` produces for the same blok; the example
shows its shape, and phase 1's test pins the real one.)

**`GET {base}/api/v1/schema`** (changed, additive): gains `writing: WritingGuide` when
the request's brand declares one. Absent otherwise, so a host with no `writing` gets
the same bytes as `v1.3.x`. `GET {base}/api/schema` (the open one) is unchanged except
for the block and field keys a host declares.

### The tool table

A seventeenth row, after `get_document`:

```ts
{
  name: "check_document",
  description:
    "Check a document for problems you can fix: values that do not fit their field, empty required fields, images with no alt text, links and references to missing or unpublished documents, untranslated fields, and the site's writing guidance (length limits, terms the brand avoids). Each finding gives the block uid, field and locale that patch_fields takes, and `fix` says which tool repairs it; `schema` means only a code change can, so tell your person. Checks the draft unless `status` is `published`. Advisory: nothing here blocks a publish.",
  inputSchema: {
    type: "object",
    properties: {
      id: ID,
      status: { type: "string", enum: ["draft", "published"], description: "Default draft." },
      locale: { type: "string", description: "Limit the per-locale checks to this locale." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  method: "GET",
  path: "/documents/:id/check",
  query: ["status", "locale"],
  need: READ,
}
```

`get_schema`'s description becomes: "The site manifest: every document type, every
block and the fields it declares, with any `help`, `guidance` and `length` the site
wrote for them, the configured locales, and the brand's `writing` guide when it has
one. Read this before writing content."

`INSTRUCTIONS` (`routes/mcp.ts:89-93`) gains a fourth static sentence, before the scope
sentence: "Blocks and fields may carry `help`, `guidance` and `length`, and get_schema's
`writing` is the brand's voice; follow them, then call check_document and fix what it
reports before publishing."

## Acceptance criteria

### Nothing changes for a host that declares nothing

```
GIVEN a v1.3.1 host config with no guidance, length, decorative or writing keys
WHEN it upgrades to v1.4.0
THEN GET {base}/api/schema answers byte-identical JSON to v1.3.1's
AND GET {base}/api/v1/schema answers byte-identical JSON to v1.3.1's
AND the inspector draws no counter and no disclosure
AND computeBlocksDigest is unchanged
```

### Guidance reaches the manifest and the agent

```
GIVEN hero declares help: "The first thing on a landing page." and
      heading: text({ help: "The promise.", length: { max: 60 }, guidance: { tone: "Second person.", examples: ["Find your next safari"] } })
WHEN get_schema is called
THEN the hero block carries help
AND its heading field carries help, length and guidance exactly as declared
```

```
GIVEN brand takeoffgo declares writing and brand allaboutafrica does not
WHEN get_schema is called on a takeoffgo site
THEN the answer carries takeoffgo's writing
WHEN it is called on an allaboutafrica site
THEN the answer has no writing key
AND GET {base}/api/schema (open) carries no writing key on either
AND server/discover's instructions contain no text from either guide
```

### Construction refuses a malformed guide

```
GIVEN a JS host declares number({ length: { max: 5 } })
WHEN createFolio runs
THEN it throws naming the block, the field and that length is for text, textarea and richtext
GIVEN length: { min: 10, max: 5 }, or max: 0, or unit: "letters", or examples of 11 entries,
      or writing.voice of 16,001 characters, or two avoid terms equal ignoring case
THEN createFolio throws naming the key
AND on a branded deployment the message is prefixed with the brand id
GIVEN a top-level writing key on a branded config
THEN createFolio throws "'writing' belongs to a brand beside 'brands'"
GIVEN a field help of 2,000 characters (existing key)
THEN createFolio does not throw
```

### A check finds what is wrong and says where

```
GIVEN a draft with an over-long hero heading, a hero image with alt "", a button linking
      to a deleted page, a French override of the heading missing, and a required title that is "  "
WHEN check_document is called with { id }
THEN it reports length-over, alt-missing, link-broken, translation-missing (locale fr) and required-empty
AND each finding's uid, field and locale, passed to patch_fields, write the field it names
AND counts total every finding
AND the errors come before the warnings and the info
```

```
GIVEN a finding at { uid, field } from check_document
WHEN the agent calls patch_fields with that uid and field and a corrected value
AND calls check_document again
THEN that finding is gone and no other finding changed
```

### The fence and the brand hold

```
GIVEN a multi-site deployment, a page on alpha linking to a live page on bravo
WHEN check_document runs on alpha's page under ~alpha
THEN the link is link-broken with reason missing
GIVEN a branded deployment
WHEN GET {base}/api/v1/documents/:id/check is called with no scope
THEN it answers 400 site_required
GIVEN an id that lives on bravo
WHEN it is checked under ~alpha
THEN it answers 404 not_found
```

### Access

```
GIVEN a token holding only content:read
WHEN it calls check_document with { id }
THEN the answer is the route's forbidden naming content:read:draft
WHEN it calls with { id, status: "published" }
THEN it gets a report on the published snapshot
GIVEN a token holding content:write
THEN check_document is in its tools/list and { id } answers a draft report
```

### Checking writes nothing

```
GIVEN a draft linking to a deleted story id
WHEN check_document runs
THEN no Durable Object is created for that id
AND the D1 statements issued are the story load, the draft read path and exactly one storiesFor prepare
AND no row in stories, content_refs or any other table changed
```

### The inspector and the check agree

```
GIVEN a text field with length { max: 60 } holding 61 code points in French
WHEN the inspector shows that field in French
THEN the counter reads 61 / 60 in the warning colour
AND fieldWarning answers the same sentence check_document's length-over message uses
```

## Implementation plan

Six phases, each committable with the tree green. Phase 1 gates everything. After it,
phases 2 and 5 can run in parallel (2 is server config, 5 is admin, and they share no
file). Phase 3 needs 1 and 2. Phase 4 needs 3. Phase 6 needs all of them.

### Phase 1: types, the measure, the blank rule and the walkers (core)

1. `src/core/fields.ts`: add `Guidance`, `TextLength`, `Measured`; `guidance` on
   `Common`; `& Measured` on the `text`, `textarea` and `richtext` arms; `decorative` on
   `asset` and `multiasset`. Doc comments in the file's existing style, each naming
   this spec and decision. Move `isBlank` from `src/admin/ui/screens/inspector-model.ts:367`
   here as `isBlankValue`. `inspector-model.ts` keeps `export { isBlankValue as isBlank }`
   so the inspector's other callers are untouched.
2. `src/core/locales.ts:321`: `isEmptySource` becomes `isBlankValue`.
3. `src/core/schema.ts:29-47`: `help` and `guidance` on `BlockSchema`.
4. `src/core/block.ts:104-119`: `toSchemaIndex` spreads `help` and `guidance` when
   defined.
5. `src/core/guidance.ts` (new): `measureText`, `lengthProblem`, `validateGuidance`
   (every cap in "Core types", plus `length` only on the three kinds and `decorative`
   only on the two, for a JS host the types cannot stop), and the length message
   builder `lengthMessage(label, problem)` that both the check and `fieldWarning` use.
6. `src/core/refs.ts`: `storedValuesByLocale`, `storedValues` reimplemented over it,
   and `blokTargets(blok, def)` (decision 13). `blokTargets` is internal: it is not
   added to `core/index.ts`'s export of its siblings (`:100`), because nothing outside
   the library needs a per-field walk and every runtime export is semver surface.
7. `src/core/nested.ts`: export `nestedPaths(doc, schema): Map<string, string>`,
   uid to path, built from the private `childIndex`, `childPath` and `fieldPath`, so a
   check's `path` and a `NestedError`'s path are produced by the same code.
8. `src/core/index.ts`: type exports `Guidance`, `TextLength`.
9. Unit tests (Testing requirements, core).

### Phase 2: the brand guide (server config)

1. `src/server/types.ts`: `WritingGuide`; `writing?` on `FolioSingleConfig` and
   `FolioBrand`; `'writing'` in `FolioBrandedConfig`'s `Omit` list and
   `writing?: never`.
2. `src/server/runtime.ts`: `'writing'` in `BRAND_KEYS` (`:678`); in `prepareBrand`,
   call `validateGuidance(schema)` after `validatePresets` (`:797`) and validate
   `writing` (a `validateWriting` beside `validateDescribe`), carrying it on
   `PreparedBrand`; `writing: WritingGuide | null` on `BrandRuntime` and in
   `buildBrand`'s answer. No member on `FolioRuntime`.
3. `src/server/routes/api/index.ts:63-86`: both answers of `GET /schema` spread
   `...(brand.writing ? { writing: brand.writing } : {})` after the manifest.
4. `src/server/index.tsx`: type export `WritingGuide`.
5. Workers tests: `test/workers/schema.test.ts` (single brand, with and without
   `writing`; the open route never carries it), `test/workers/multi-brand.test.ts`
   (two brands, one with a guide; each scope answers its own; construction refusals).

### Phase 3: the check (server)

1. `src/server/checks.ts` (new): `checkDocument(doc, brand, ctx)` where
   `ctx = { locales, locale?, bare, targets: (ids) => Promise<StoryMeta[]> }`. It walks
   `nestedPaths` order, runs decision 9's steps 1 to 3 per blok, collects
   `blokTargets`, makes the one `targets` call, runs step 4, sorts and caps
   (decision 17). `AUTHORING_CHECKS` is an exported array with a header comment in
   the audit's "Adding a check" style.
2. `src/server/audit.ts`: `requiredEmpty` uses `isBlankValue` for non-`blocks` fields
   (decision 15). `DOCUMENT_CHECKS` and the checks in it are unchanged.
3. `src/server/routes/api/documents.ts`: the route, after `GET /documents/:id/versions`.
   It reuses `load`, `askedLocale`, `publishedFor`, `draftOf`, `layerOption`,
   `requestChain`, and passes
   `targets: (ids) => storiesFor(c.var.bindings().db, ids, [], chain)`. No new read
   helper, so nothing new takes a `D1Database`.
4. `src/server/index.tsx`: type exports `ContentCheck`, `ContentCheckSeverity`,
   `ContentCheckReport`.
5. `test/workers/scope-partition.test.ts:780-800`: add
   `["GET", "/api/v1/documents/:id/check", "read", "story"]`.
6. Unit and workers tests (Testing requirements).

### Phase 4: the tool

1. `src/server/mcp/tools.ts`: the `check_document` row after `get_document`; the new
   `get_schema` description; the header comment's "Fifteen rows" and "sixteenth row"
   counts move to sixteen route-backed and seventeen total.
2. `src/server/routes/mcp.ts:89-93`: the fourth sentence.
3. `test/unit/mcp/tools.test.ts`: seventeen tools, sixteen route-backed; the `need`
   table gains `check_document: "content:read"`; the narrowed list is unchanged.
4. `test/workers/mcp.test.ts`: `tools/list` for a content:write token includes it;
   a `tools/call` round trip answers the report; the content:read case.

### Phase 5: the admin (parallel with 2 to 4, after 1)

1. `src/admin/ui/screens/inspector-model.ts`: `fieldWarning` gains the length case
   through `lengthProblem` and `lengthMessage`; new `lengthCounter(field, value)`
   answering `{ text, over }` or null; new `guidanceOf(field)` answering what the
   disclosure shows, or null.
2. `src/admin/ui/Field.tsx`: an optional `count` prop drawn beside the label, with an
   `over` state; `Field.module.css` gains its rule (warning colour from `tokens.css`).
3. `src/admin/ui/screens/fields/FieldRow.tsx`: passes the counter and renders the
   disclosure (a native `<details>`, inside the `.folio-ui` scope it already sits in,
   so no portal and no new focus handling).
4. `src/admin/ui/screens/block-picker-model.ts`: `PickerEntry` gains `help?: string`
   from the block (bare entries and preset entries both); `BlockPicker.tsx` draws it
   above `description`.
5. `src/admin/ui/screens/Inspector.tsx`: the selected block's `help` under its heading.
6. Unit tests in `test/unit/admin/` for the three model functions and the picker.

### Phase 6: demo, starter, end to end, documents

1. `examples/demo/src/blocks/hero.tsx`: `help` on the block, `length` and `guidance`
   on `heading`, and `decorative: true` on the background `image` (`:15`), which sits
   under a gradient and carries no information. `examples/demo/src/blocks/media.tsx`
   is left alone, so its required `file` (`:20`) is the demo's `alt-missing` case.
   `examples/demo/src/index.tsx`'s `createFolio` (`:158`): a short `writing` with two
   `avoid` terms.
2. `examples/starter/src/blocks/page.tsx:19-23`: `description` gains
   `length: { max: 160 }` and its `help` becomes "Shown in search results." (the
   length now says the rest). `hero.tsx`: `help` on the block and `length: { max: 80 }`
   on `heading`. No `writing` in the starter, because a voice is the host's and a
   template one would ship to every new project.
3. `scripts/mcp-test.mjs`: write a draft with an over-long heading and a link to a
   deleted page, call `check_document`, patch both by the findings' addresses, check
   again and assert they are gone.
4. Documents (Documentation this implies).

**Deploy order:** none beyond the ordinary. No migration, no wire change, and the
admin bundle and the Worker ship together.

**Rollback:** revert the release. Nothing is stored, so there is no data to undo. A
host that has adopted the new keys and pins back to `v1.3.x` gets TypeScript errors
on them (excess properties on the builders' option types) and must remove them; at
runtime `v1.3.x` would pass unknown field keys through to the manifest and ignore an
unknown top-level `writing`, so a JS host is not broken by a downgrade.

## Documentation this implies

- **`docs/handbook.md`**: a new `## Writing guidance and content checks` section
  before `## Document types` (`:333`). It covers `help` (fields and now blocks),
  `guidance`, `length` and its unit rules, `decorative`, and `writing`. It also says
  plainly that **block and field guidance are served on the unauthenticated
  `{base}/api/schema`, like `help`**, and that `writing` is not. Then the check:
  every `check` name, its severity and its `fix`, `status` and `locale`, the 500 cap,
  and that nothing blocks a publish.
- **`docs/configuration.md`**: `writing` under `### Document model` (`:116`) for a
  single brand, and in `### Many brands in one deployment` (`:350`) as a brand key.
  The new field keys in the field reference. Add the new refusals to
  `## Refused at construction` (`:1028`).
- **`docs/api.md`**: the route in `## Routes` (`:52`), a `### GET /documents/:id/check`
  under `### Reading` (`:184`) with the response shape and the check table, and
  `writing` on `/schema`.
- **`docs/mcp.md`**: "Sixteen tools" becomes seventeen; the scope table's
  `content:read` row gains `check_document`, with the note that its default needs
  `content:read:draft`; a short section "Checking before publishing" with the
  write, check, patch, check loop.
- **`AGENTS.md`**: under `## The integration shape` (`:77`), how to write `help`,
  `guidance`, `length` and `writing` so an agent can use them; under `## Rules`
  (`:383`), "declare a length rather than writing one into `help`". The paste block
  under `## Point your own agent at this file` (`:42`), which `bin/folio.mjs agents`
  copies, gains one sentence: call `check_document` after writing and before
  publishing.
- **`UPGRADING.md`**: a `### Authoring guidance and content checks (v1.4.0)` entry.
  Additive, nothing to do. It names the one sanctioned behaviour change (decision 15:
  `/folio/audit`'s `required-setting` now counts whitespace and empty richtext as
  empty).
- **`README.md`**: one line in the agent section naming guidance and `check_document`.

## Edge cases

- **A value over `max` in one locale and under it in the source** → one `length-over`
  finding, carrying that `locale`. Each stored value is measured on its own
  (decision 4), because each is what one page renders.
- **A richtext field with `length`** → measured over `richtextToText`, so marks, links
  and node boundaries add nothing. A heading node and a paragraph join with whatever
  separator `richtextToText` uses, which is what a reader sees.
- **`words` on Chinese, Japanese or Thai text** → undercounts. The handbook says to use
  `characters` for those languages. A per-locale unit is not offered (Out of scope).
- **An emoji** → counts as however many code points it is (decision 4). The inspector
  and the check agree, which is the property that matters.
- **`length: { min: 20 }` on an empty field** → no `length-under`. Emptiness is
  `required-empty`'s finding, and reporting both would say one thing twice.
- **An `avoid` term inside a URL or an email in richtext** → not matched. Link marks
  hold their target in `attrs`, which `richtextToText` does not emit.
- **An `avoid` term that is a substring of a word** ("cheap" in "cheapest") → not
  matched, because matching is on word boundaries. A host that wants "cheapest" lists
  it.
- **`multiasset` with three images, two without alt** → two `alt-missing` findings,
  each with `detail.index`, so the agent knows which entry to fix in the array it
  writes back.
- **An asset value that is an external `url` with no `contentType` starting `image/`**
  → not checked for alt. `asAsset` guesses a type from the filename
  (`values.ts:144`), so a `.jpg` URL is an image and is checked.
- **A link to the document itself** → resolved like any other target. Self-edges are
  dropped from `content_refs`, not from rendering, and a page linking to its own draft
  state reads `link-unpublished` before its first publish, which is true.
- **A link to an `anchor`, `url`, `email` or `asset`** → not checked. Only story targets
  have a row to look up. Checking external URLs would mean the Worker fetching them.
- **A reference to a record that is `draft`** → `reference-unpublished`. The published
  page resolves only published targets, so the reference renders empty until the
  record is published.
- **The root blok's own field** → `uid` is the root's uid and `path` is `''`.
  `patch_fields` accepts it in `bloks` as well as in `fields`.
- **A blok inside an unknown-type parent** → still walked and checked. `unknown-type`
  is reported on the parent. `nestedPaths` still places the child, because
  `childIndex` is built from `parent` and `slot`, not from the schema.
- **A singleton id (`sng_*`) on a deployment with no `sites`** → `load(..., 'read')`
  ensures the row, exactly as `GET /documents/:id` does. With `sites`, a layer nobody
  has written is `404`.
- **A bare layer** → `missing-field` and `required-empty` skipped (Wire & schema
  changes). A broken link in what the layer does hold is still reported.
- **A document over 500 findings** → counts complete, the list capped errors first,
  `truncated: true` (decision 17).
- **`?locale=` naming the source locale** → only source-locale findings. There is no
  translation to be missing.
- **A single-locale site** → `translation-missing`, `translated-not-translatable` and
  `unknown-locale` never fire. Every finding omits `locale`.
- **A host whose existing `help` is very long** → not refused. Only the new keys are
  capped (Ground truth, `fields.ts:21`).
- **Guidance holding something private** → it is public, like `help`. The handbook says
  so. `writing` is the gated place.

## Testing requirements

**Unit (`test/unit/`):**

- `core/guidance.test.ts` (new): `measureText` for text, textarea and richtext, characters
  and words, trimming, an emoji, a CJK string; `lengthProblem` over and under, with an
  empty value answering null; `validateGuidance` accepts every valid shape and refuses
  every cap in "Core types", naming the block and field; `length` on `number` refused
  for a JS host; an over-long existing `help` accepted.
- `core/block-registry.test.ts`: `toSchemaIndex` carries block
  `help` and `guidance`, and **a registry with neither serialises to the same JSON as
  before** (a literal snapshot of a `v1.3.1` manifest for the demo's hero).
- `core/registry-digest.test.ts`: adding guidance to every block leaves the digest
  unchanged.
- `core/refs.test.ts`: `blokTargets` over a fixture with a `multilink`, a richtext link
  in the source, a richtext link only in a French override, a `reference` and a
  `references`; **the union over every blok equals `linkedIds ∪
  referencedIdsAllLocales`**, each with the right `locale` and `via`.
- `core/nested.test.ts`: for every blok of a three-level fixture, the path
  `nestedPaths` gives, followed into `toNested`'s output, lands on the blok with that
  uid. A `fromNested` refusal of a bad field on a nested blok produces a
  `NestedError.path` that starts with `nestedPaths`' path for the same blok.
- `core/guidance.test.ts`, a second `describe`: `isBlankValue` per kind (`false`, `0`, `'  '`, empty
  richtext, `[]`); `isEmptySource` and the admin's `isBlank` are the same function.
- `server/checks.test.ts` (new, pure, with a literal `targets`): one fixture per `check`
  name asserting severity, `field`, `locale`, `fix` and `detail`; decision 17's order
  and cap with counts complete; bare-layer skips; `date-invalid` never emitted,
  `field-shape` emitted for the same bad date instead; `unknown-locale` carries the
  code in `locale` and null in `field`; **every name in `DOCUMENT_CHECKS` other than
  `date-invalid` can be produced**, so a check added to the audit reaches the report.
- `server/audit.test.ts`: `required-setting` now reports a whitespace-only required
  setting (decision 15's sanctioned change).
- `mcp/tools.test.ts`: seventeen tools, the `need` table, the round trip to a declared
  v1 route, `check_document`'s `status` enum pinned against the route's own parser.
- `admin/inspector.test.ts`: `lengthCounter` text and `over`; `fieldWarning`'s
  length sentence equals `lengthMessage`'s, which is what the check uses; a field with
  no `length` answers no counter.
- `admin/block-picker.test.ts`: an entry carries `help` for a block that declares
  it and none for one that does not; the derived description is unchanged.

**Workers (`test/workers/`, real workerd):**

- `schema.test.ts`: v1 `/schema` with and without `writing`; the open `/api/schema`
  never carries it.
- `multi-brand.test.ts`: two brands, one guide, each scope answers its own; construction
  refuses a top-level `writing` on a branded config and prefixes brand-level refusals.
- `checks.test.ts` (new): the acceptance fixtures through the real route, for draft and
  published; `?locale=`; the access cases with a content:read and a content:write
  token; `status=published` with nothing published is 404; **the statement count**:
  a proxy that follows `withSession` and `bind` (as `read-session.test.ts` does) records
  exactly one `storiesFor` prepare for a document with links, and none for a document
  without; **no Durable Object is created** for a deleted link target (asserted by
  a spy on `FolioRuntime.stub`, the one place a story's object is addressed, which
  records no call for the target id).
- `scope-partition.test.ts`: the new row in the fence table; a story on `bravo` checked
  under `~alpha` is 404; a link from `alpha` to `bravo` is `link-broken`.
- `api-partition.test.ts`: the route answers under `{base}/api/v1` and is absent under
  `{base}/api`.
- `mcp.test.ts`: `tools/list` and `tools/call` for `check_document`; `server/discover`'s
  instructions contain the new sentence and no `writing` text.

**End to end (`scripts/*-test.mjs`, port 5199):**

- `scripts/mcp-test.mjs`: the write, check, patch, check loop from Phase 6, run through
  `./scripts/e2e.sh scripts/mcp-test.mjs`, gating on its exit code.

## Dependencies

- None of the unbuilt specs. Built on spec 24 (MCP server), 34 (multi-brand), 23
  (multi-site fences), 21 (localisation) and 33/32 (references, assets).
- **Spec 41 (agent CLI) ships in the same `v1.4.0`** and edits `AGENTS.md` and
  `bin/folio.mjs agents` too. Whichever lands second rebases its paste-block sentence
  onto the other's. No ordering constraint between them otherwise.
- **Spec 39 (agent suggestions and presence, `v1.5`)** may want to attach findings to a
  suggestion. It reads `ContentCheckReport` as specified here and needs nothing else
  from this spec.
- No Cloudflare resource, binding or host config change.

## Out of scope

- **A check panel in the admin.** The per-field half already shows live through
  `fieldWarning`, which this spec extends. The cross-document half (link targets) needs
  a D1 read the inspector does not make per keystroke, and a document-level panel is
  a UI review item for the command palette work (spec 42), not something to design
  inside an agent spec.
- **Showing the brand's `writing` guide in the admin.** Editors already read their
  brand's style guide wherever the brand keeps it, and the admin has no gated route
  shaped for long prose. Decision 6 keeps it off the open manifest, so showing it
  would need a new session-gated route, which is its own change.
- **Gating a publish on findings.** Decision 18.
- **Per-locale `writing` guides and per-locale `avoid` lists.** One guide per brand is
  the shape every live host has. A localised voice is a second key on `WritingGuide`
  when somebody needs it, and additive.
- **Guidance on a document type.** Each type has its own root block (`document-types.md`),
  and the root block's `help` and `guidance` say what a type's document is for.
- **Checking external URLs, anchors and form ids.** External URLs would need the Worker
  to fetch them. An anchor's target is rendered markup. A `form` field's target
  is one more entry in step 4 when it is wanted, using the same per-field walk.
- **A site-wide check.** `/folio/audit` is the site-wide report and stays the drift
  report (decision 9). A sweep over every draft would open one Durable Object per
  document, which is the cost `GET /documents?status=draft` refuses for the same
  reason.
- **Exporting `checkDocument` from `folio/engine`.** The v1 route is the contract. A
  second contract surface for the same shape can be added later as a minor.

## Implementation notes

Built 2026-11-04 on `feat/authoring-guidance` in the plan's order, phases 1 to 5 each
committed separately and phase 6 (the demo, the starter, the end-to-end loop and the
documents) last. No migration, no wire change, `PROTOCOL_VERSION` still 5. Ships in
`v1.4.0` beside spec 41.

**Where the spec was wrong or ambiguous, and what was done.**

1. **An undeclared `?locale=` is `unsupported`, which is `501`, not `422`.** The route
   reuses `askedLocale`, so it answers exactly what `GET /documents/:id` answers for
   the same locale; the workers test pins the two together rather than a number.
2. **The `path` grammar elides `fields.` for a slot.** `NestedError`'s paths come from
   `childPath`, which writes `body[0].actions[0]`, not `fields.body[0].actions[0]`; a
   field inside a blok is `body[0].fields.heading`. `nestedPaths` uses the same helper,
   and `nested.test.ts` pins both that a path followed into `toNested`'s output lands on
   its blok and that it prefixes a refused write's `NestedError.path`. The docs' example
   uses the real grammar.
3. **`translation-missing` reads `translationStatus` once per locale, not per blok.**
   `translationStatus` walks a whole document; calling it from a per-blok check would
   walk it once per blok. `checkDocument` computes the gaps per non-source locale (only
   `?locale=`'s when one is given) and the `AUTHORING_CHECKS` entry reads them by uid, so
   the rule is still the publish dialog's.
4. **`isEmptySource` gains the asset arm.** It now *is* `isBlankValue`, whose asset case
   (an `asset` value with neither a key nor a usable url is blank) the old private copy
   lacked. A translatable `asset` whose source is unreadable no longer counts as work a
   translator owes. Nothing else about the translation walk changed.
5. **`fieldWarning` takes the field's name.** `check_document` labels a finding
   `label ?? name`; the inspector's `fieldWarning(field, value)` had no name to fall back
   on, so it gained an optional third argument and `FieldRow` passes it. The length case
   is answered before `required`'s, which cannot fire for the same value (an empty value
   is never measured).
6. **`Field` gained two props, not one.** `count` is the counter at the label's end, as
   planned; `detail` draws the "Writing guide" disclosure *under* the help line, which
   the plan's "rendered by `FieldRow`" could not do without it, since `Field` draws the
   help after the control.
7. **`validateWriting` refuses more than the caps the spec lists**: an unknown key on
   the guide or on a term, a blank `voice`, a `term` over 100 characters, and a `use` or
   `reason` over 500. Each is the same kind of refusal as the listed ones and is in
   `docs/configuration.md`'s table.
8. **`alt-missing` reads an override only on a `translatable` field.** An override on an
   untranslatable field is `translated-not-translatable`'s finding; reporting its alt text
   as well would say one problem twice.
9. **`term-avoided` is one finding per term per field**, however often the term occurs,
   because the fix is one rewrite of that value.
10. **Only reachable bloks are checked.** The walk is `nestedPaths`, so a blok no path
    from the root reaches (an orphan left by an old log) has no `path` and is skipped; it
    renders nowhere and `patch_fields` on it would change nothing anyone sees.
11. **A link target of an undeclared type is not `unrouted`.** "Not a `page` kind" is read
    off the brand's declared types; a row whose type the brand no longer declares is
    judged only on presence, state and the field's `types`.
12. **The status parser is a picklist.** `?status=` is screened by a new `CHECK_STATUS`
    in `validate.ts` (a misspelt value is `400`, never a silent draft check), and
    `tools.test.ts` pins `check_document`'s enum against it, as `search_documents`' is
    against `STORY_STATE`.
13. **Where the tests landed.** The per-brand guide test is in
    `multi-brand-entry.test.ts`, because `multi-brand.test.ts` mounts no API routes; its
    construction refusals are in `multi-brand.test.ts`. The sanctioned settings-audit
    change is pinned in `multi-site.test.ts`'s settings test, because `requiredEmpty` is
    private and `auditSettings` needs D1, so `server/audit.test.ts` could not reach it.
    The "no Durable Object for a deleted target" assertion watches the story
    namespace's `idFromName`, which `FolioRuntime.stub` is the one caller of, rather than
    spying on `stub` itself, so it runs through `createFolio` unchanged. The mcp
    tools/scopes unit tests count `check_document` among the reads.
14. **`scope-partition.test.ts`'s page block gained a `link` field**, so the cross-site
    link case has an edge to follow.
15. **The instructions say "the site's voice", not "the brand's voice".** The sentence
    the spec gives would put the word "brand" into every deployment's instructions, and
    `multi-brand.test.ts` pins that a deployment with no `brands` names no brand there.
    The sentence is "Blocks and fields may carry `help`, `guidance` and `length`, and
    get_schema's `writing`, when present, is the site's voice; follow them, then call
    check_document and fix what it reports before publishing."
16. **Phase 3's commit lists the route in `NOT_TOOLS`** so the tree stays green between
    the route and the tool; phase 4 removes it.

17. **An override under an undeclared locale is reported once, as drift, and never
    per value** (review finding 1). Every per-value step (`field-shape`, `length-*`,
    `alt-missing`) reads only the source and the *configured* locales' overrides, so no
    finding sends an agent to `patch_fields` with a locale it refuses as `unsupported`
    (a check, patch, refuse loop). The drift is `unknown-locale` (`warning`,
    `fix: "schema"`), one per blok and code. With locales configured that is the audit's
    own finding; on a single-locale site, where the audit's check is silent, the check
    emits the same finding itself. This reverses the Edge cases line "a single-locale
    site: `unknown-locale` never fires": an `i18n` map on a site with no locales is drift
    too, and saying nothing left the agent nothing true to act on.

18. **A required field with no stored key is one finding** (review finding 2):
    `required-empty`, the warning. The audit's `missing-field` for the same field is
    dropped, so `counts` do not count one absent required field as two problems.

**Verified by breaking it.** Each boundary was disabled and a test went red, then
restored: putting `writing` on the manifest (`schema.test.ts`, `multi-brand-entry.test.ts`);
dropping `writing` from `BRAND_KEYS` (`multi-brand.test.ts`); appending the voice to the
MCP instructions (`multi-brand-entry.test.ts`); passing `null` for the chain
(`scope-partition.test.ts`'s cross-site link); bypassing `load` (the fence table's walk);
reading targets once per edge (`checks.test.ts`, unit and workers); addressing a target's
object (`checks.test.ts`); reading targets off the raw binding rather than the session
(`checks.test.ts`); dropping the draft access check (`checks.test.ts`); the old blank
rule in the settings audit (`multi-site.test.ts`); `toSchemaIndex` always carrying `help`
(`block-registry.test.ts`); `blokTargets` skipping overrides (`refs.test.ts`); and a
UTF-16 `.length` count in the counter (`inspector.test.ts`).

**Not verified here.** `scripts/mcp-test.mjs` gains the write, check, patch, check loop
but was not run on this branch (the end-to-end tier shares one port and one database,
and runs on the merged branch). The inspector's counter, disclosure and block help, and
the picker's help line, are pinned by Node tests of the model functions; nobody has
looked at them in a browser yet.
