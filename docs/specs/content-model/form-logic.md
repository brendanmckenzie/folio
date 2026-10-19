# Feature: Conditional questions, sections and prefill on forms

> **Group:** content model
> **Build order:** 35
> **Size:** L
> **Status:** done — built 2026-10-19 (phases 1 to 5); the end-to-end script, the unit and workers suites and the build pass locally. Not yet deployed anywhere: `0014` must be applied before the release that carries it.
> **Wire version:** none — forms cross neither the socket nor the admin↔preview frame shape; new descriptor keys ride inside the `Resolution` JSON the bridge already carries
> **Migration:** `0014_form_logic.sql`
> **Build sequence:** after 33 (forms) and the layout slice of `docs/form-layout-approach.md`; slice 1 of issue #33. Slices 2 (content-sourced options) and 3 (steps and the `folio/form` hook) are separate issues.
> **Last updated:** 2026-10-19

## Summary

A form is a flat list of always-asked questions: `formLayout` accepts an `answers`
argument and ignores it (`src/core/forms.ts:580`, the parameter is `_answers`),
`ResolvedFormSection` is a type nothing produces (`src/core/forms.ts:527`), and
`validateSubmission` judges every declared question on every submission
(`src/server/form-responses.ts:537-556`). There is no way to say "ask for details
only if they picked Other", "require a phone number only if they asked for a call",
or "show the postal address block only if it differs".

This adds, as one slice: a `showIf` and a `requireIf` on a question, sections with
their own `showIf`, a `hold` that keeps a hidden question's place in its row, and
per-question prefill from the page's query string. A pure engine in `folio/core`
decides what is asked and what is required, and the submit route calls the same
engine: a required question that was not asked never blocks a submission, an answer
to a question that was not asked is dropped rather than stored, and a response
records which questions were never asked as a third state beside "answered" and "no
answer".

## Ground truth

Read at `1ea6183` with a clean tree.

**core (`src/core/`):**

- `FieldCondition` is `eq | ne | in | isSet` leaves plus `all | any | not`
  combinators (`conditions.ts:15-22`). `matches(condition, data)` is total: an
  unrecognised node answers `false` (`conditions.ts:62`), so `{ not: <unknown> }`
  answers `true`. A missing key reads as `null` (`conditions.ts:55`). `isSet` is false
  for `null`, `undefined`, `''` and `[]` and true for `false` and `0`
  (`conditions.ts:30-34`). **`in` and `eq` compare the whole value with `deepEqual`**,
  so neither can ask "is `other` among the ticked boxes" of a `checkboxes` answer,
  which is a `string[]`.
- `FieldCondition` and `matches` are already exported from `folio/core`
  (`index.ts:15-16`) and are used by block schemas (`fields.ts:19`) and the inspector
  (`admin/ui/screens/inspector-model.ts:58`). The only phrasing of one is
  `conditionText` (`admin/ui/screens/settings-model.ts:365`). **There is no condition
  editor anywhere in the admin**: block conditions are authored in code, and the
  Settings screen only prints them. Nothing validates a `FieldCondition` at runtime,
  because nothing has ever accepted one over HTTP.
- `FormField` (`forms.ts:102-145`) has `beside`/`grow` as its only layout keys.
  `validateOneField` copies keys one by one (`forms.ts:224-301`), throws for a genuine
  failure on a recognised kind, and **narrows** the layout keys rather than throwing
  (`forms.ts:288-293`), because it also runs on the read path.
- `validateFormFields` drops an unknown `kind` (`forms.ts:333`) and is called on the
  way in (`server/forms.ts:204-210`, wrapped into `bad_request`) and on the way out
  (`readFields`, `server/forms.ts:184-191`), where **any throw becomes `[]`: every
  question gone from a live form**, logged once.
- `shapeOf` covers `name`, `kind`, `required` and option values only
  (`forms.ts:352-361`). It is never stored: `updateForm` computes it for both sides of
  every save (`server/forms.ts:829`). The server also enforces `min`, `max`,
  `pattern`, `accept` and `maxBytes` (`form-responses.ts:366-510`, `prepareUploads` at
  `form-responses.ts:885`), none of which `shapeOf` sees.
- `rowsOf` breaks a row at the start of the form, at a `statement` and at
  `MAX_ROW_CELLS`, and treats `hidden` as layout-transparent (`forms.ts:390-410`).
- `ResolvedFormField` always carries `row` and `grow` and copies `required` from the
  stored flag (`forms.ts:462-488`; `server/forms.ts:407`). `ResolvedForm` has no
  `sections` key (`forms.ts:496-517`). `LayoutCell` is `{ field, grow, shown }` with
  `shown` always `true` (`forms.ts:536-540`, `599`). `formLayout` always returns one
  `section: null` group (`forms.ts:615`).

**server (`src/server/`):**

- `forms` has no column for anything but `fields` and the settings
  (`migrations/0010_forms.sql`; `0011_sites.sql:112` adds `site_id`). `COLS` and
  `SUMMARY_COLS` are at `forms.ts:151-158`; `SUMMARY_COLS` counts questions with
  `json_array_length(fields)`.
- `updateForm` (`forms.ts:817-901`) bumps `version` on `structural`, and reports
  `descriptorChanged` for any change `compileForm` would render (`forms.ts:890-898`).
  The PATCH route fires `formChanged` on `structural` and calls `purgeFormLayout`
  otherwise (`routes/forms.ts:296-309`). **So the roadmap's claim that a logic change
  would leave `form:<id>` unpurged is stale**: since the layout slice, every
  `fields` change purges. What `shapeOf` still governs is `version` and the
  host-visible `formChanged` event.
- `compileField` is a key-by-key projection (`forms.ts:396-432`), and
  `test/unit/server/forms.test.ts:200-250` pins the exact key sets of the descriptor
  and of a question.
- `FORM_FIELD` (`validate.ts:1829-1882`) is a `v.object`, which strips unknown keys;
  the roadmap's `validate.ts:1791` is stale. `FormPatchBody` is at `validate.ts:1914`.
- The submit route (`routes/forms.ts:778`) runs `prepareUploads` over every declared
  question (`:905`), then `validateSubmission` (`:906`), merges the two refusal maps
  (`:913`), hashes (`:929`), puts to R2, inserts (`:949`) and fires `submitted`
  (`:976`). Uploads are buffered and hashed but **not written** before validation.
- `validateAnswer` (`form-responses.ts:404`) coerces per kind: `checkbox` → boolean
  (ticked when a value arrived that is not `''` or `'false'`), `checkboxes` →
  deduplicated `string[]`, `number` → `number` after a shape regex, everything else
  a trimmed string. **A blank optional text, select, number or date answer stores no
  key at all** (`textAnswer`, `form-responses.ts:368`, and the per-kind
  `{}` returns), while an unticked checkbox stores `false` and an empty
  `checkboxes` stores `[]`.
- So **spec 33 decision 16's "this did not exist yet" versus "they left it blank"
  is only true for the two tick-box kinds.** For every other kind both render `—`
  (`CSV_ABSENT`, `form-responses.ts:1931`; `ABSENT`,
  `admin/ui/screens/responses-model.ts:157`). This spec records that rather than
  changing it (decision 9).
- `form_responses.data` is screened on read (`readAnswers`,
  `form-responses.ts:1273`), and `_`-prefixed keys are dropped there. `FormResponse`
  (the `submitted` payload, `form-responses.ts:1005`) and `ResponseRow`
  (`form-responses.ts:1236`) carry `data` and `files`; `RESPONSE_COLS` is at
  `form-responses.ts:1250`.
- The CSV header is the union of keys in `data` and `files` (`submittedKeys`,
  `form-responses.ts:2080`); `csvValue` (`form-responses.ts:2011`) checks files
  first, then `data`, then answers `—`.
- `cacheKeyFor` keeps every query parameter except click identifiers and `utm_*`
  (`cache-request.ts:93-107`), so a page prefilled from `?area=safari` is its own
  cache entry, which is already true of Take Off Go's hand-rolled prefill.

**admin (`src/admin/`):**

- The builder is `admin/ui/screens/FormBuilder.tsx` (`FieldPanel` at `:431`, the
  `required` checkbox at `:559`, structural-change copy at `:151` and `:303`), with
  pure reducers in `form-model.ts` (`removeField` `:259`, `moveField` `:274`,
  `canMoveField` `:376`, `moveFieldStep` `:418`, `updateField` `:488`) tested in
  `test/unit/admin/forms-model.test.ts`. Renaming a question is a plain
  `updateField`.
- The responses table renders `cellText` / `answerText`
  (`responses-model.ts:166-180`).

**hosts (read in `~/work/takeoffgo/group-web`):**

- Take Off Go calls `formLayout(form)` with no answers and already renders
  `!cell.shown` as an empty `aria-hidden` slot
  (`app/brands/takeoffgo/components/forms/EnquiryForm.tsx:53`, `:134-144`). It
  prefills **every** question from the query string by name, hidden ones included
  (`:108-115`, `:131`), which is how `?source=topnav` and `?area=safari` work today.
- The demo renders `required={field.required}` straight onto inputs
  (`examples/demo/src/blocks/contact.tsx:101-153`) and ships no client script.

**tests:**

- `test/unit/core/forms.test.ts` (`shapeOf` `:293`, `rowsOf` `:389`, `formLayout`
  `:471`), `test/unit/core/conditions.test.ts`,
  `test/unit/server/form-validate.test.ts`, `test/unit/server/form-csv.test.ts`,
  `test/workers/forms.test.ts`, `test/workers/form-submit.test.ts`,
  `test/workers/migrations.test.ts` (`describe("forms")` at `:1260`), and
  `scripts/forms-test.mjs`.

## User stories

### Editor asks a follow-up only when it applies
**As** an editor **I want to** show "Tell us more" only when "How did you hear about
us?" is "Other" **so that** most visitors see a shorter form.

### Editor makes a question required only sometimes
**As** an editor **I want to** require a phone number only when "Best way to reach
you" is "Phone" **so that** I always get a way to call the people who asked for a
call, and nobody else is made to give one.

### Editor groups questions under a heading that can disappear
**As** an editor **I want to** group street, city, state and postcode under "Postal
address" and show the group only when "Postal address differs" is ticked **so that**
one condition hides the whole block.

### Visitor without JavaScript
**As** a visitor with scripts off **I want to** see every question and have the
server work out which ones applied **so that** I can still submit.

### Marketer links to a pre-filled form
**As** a marketer **I want to** link to `/contact?area=safari` and have the area
question already answered **so that** the enquiry arrives tagged.

### Publisher reads a response
**As** a publisher **I want to** see "not asked" against a question the visitor was
never shown **so that** I do not read an empty cell as a refusal to answer.

## Architecture decisions

### 1. One engine, `formState`, in `folio/core`, called by the submit route and by any host

`formState(form, answers)` answers which questions are asked, which are required and
which sections are shown. It is pure, React-free and DOM-free. The submit route calls
it on the posted body, `formLayout` calls it when given answers, and a host's
client-side code calls it on every change. Same function, so a browser is never the
enforcement and the page and the endpoint cannot disagree.

It takes a structural type that both the stored `FormField[]` + `FormSection[]` and
the compiled `ResolvedForm` satisfy (`{ fields, sections? }`, each field
`{ name, kind, section?, showIf?, required?, requireIf?, options? }`), so the server
evaluates the row it already read and a host evaluates the descriptor it was handed,
with no conversion in between. Decision 5 is what makes the two inputs give the same
answer.

**Rejected: evaluating on the descriptor on both sides** (the server compiling the
form first). It would make the submit route depend on `compileForm`'s locale and base
path for a question that has neither. **Rejected: a server-only rule set with a
client copy**, which is the two-implementations failure this codebase removes
wherever it finds it.

### 2. Evaluation is ordered: `showIf` may name only earlier questions; `requireIf` may name any other

Questions are walked in array order. A question is **asked** when its own `showIf`
holds and its section's `showIf` holds, each evaluated against the answers of
**earlier, asked** questions only (a question that was not asked reads as absent,
so `null` to `matches`). A section's `showIf` is evaluated where the section begins,
so it may name only questions before its first member.

`requireIf` is evaluated in a second pass, after every question's asked state is
known, against the answers of every asked question. It may name any value-bearing
question except itself. That is what makes "email or phone, at least one" expressible:
`email.requireIf = { field: 'phone', isSet: false }` and the reverse, with no cycle,
because requiredness never feeds back into what is asked.

A question is **required** when it is asked and either `required` is `true` or its
`requireIf` holds. `required` therefore means "required whenever asked", which for
every form that exists today is exactly what it already means.

**Rejected: any-order `showIf` with a fixed-point evaluation.** It admits cycles
("show A if B is set, show B if A is set") that need a refusal anyway, makes "what is
asked" depend on iteration order in the edge cases, and makes steps (slice 3) unable
to say which page a question belongs to. **Rejected: `requireIf` restricted to earlier
questions too**: it would forbid the either-or case, which is the most common
conditional requirement there is.

### 3. Logic is checked strictly on write and evaluated totally on read

Two different functions, because the read path's failure mode is a live form with no
questions (`readFields`):

- **`checkFormLogic(fields, layout)`** (core, throws a plain `Error` naming the
  question) runs on every save, through the same `bad_request` wrapper
  `fieldsFromInput` already uses, and in the builder before it enables Save. It
  refuses: a `showIf` naming a later, unknown, non-value or the same question; a
  `requireIf` naming an unknown, non-value or the same question; an operator or value
  the source's kind cannot produce (table under *Core types*); `required: true` and
  `requireIf` together; a section whose members are not contiguous, that has no
  members, or whose `showIf` names a question at or after its first member.
- **On read nothing about logic throws.** `validateOneField` screens a condition with
  `readCondition`, which rebuilds known nodes key by key, turns an unrecognised leaf
  into `{ any: [] }` (always false, which is what `matches` answers for it anyway),
  and bounds depth and size. A dangling reference simply reads as absent. A
  `showIf` that is not an object at all becomes `{ any: [] }`: the question is never
  asked, so it can neither block a submission nor store an answer. A malformed
  `requireIf` is dropped. A section membership that names no section, or a section
  that has already closed, is dropped (`readFormLayout`), the posture
  `docs/form-layout-approach.md` set for layout.

The valibot gate in `validate.ts` refuses a structurally malformed condition before
either runs, by calling core's `conditionRefusal(raw)`, so the shape rule lives once.

**Rejected: putting the reference checks in `validateFormFields`.** It runs on read,
and a rolled-back build that drops an unknown kind would then throw on every condition
that named the dropped question, turning one missing question into a form with none.

### 4. `includes` joins `FieldCondition`, rather than `in` growing an array meaning

`{ field, includes: Json }` is true when the answer is an array containing the value.
It is the only way to ask about a `checkboxes` answer, and it is added to the shared
`FieldCondition` (`core/conditions.ts`), so `matches`, `conditionText` and the block
inspector all learn it at once. Additive: an older admin bundle reading a block schema
that uses it evaluates it as unrecognised (`false`), which hides the field, the safe
wrong answer that file already chose.

**Rejected: making `in` and `eq` test membership when the answer is an array.** That
silently changes what an existing block condition over a multi-value field means.
**Rejected: numeric and date comparisons (`gt`, `lt`)** in this slice: they need typed
comparison rules across number, date and string answers, and no story above needs
them. They are additive later on the same union.

### 5. Answers are normalised by one core function, and the server evaluates on that, not on its validated values

`answerOf(field, raw: readonly string[])` turns what a browser would post into the
value a condition sees: `checkbox` → boolean (the existing ticked rule), `checkboxes`
→ deduplicated non-empty `string[]` limited to declared options, `select`/`radio` →
the value if it is a declared option, `number` → a number if it matches the shape
regex, `date` → the string if it is a real calendar day, every other kind → the
trimmed string, and `undefined` for blank or unreadable. The `NUMBER` and `DATE`
patterns move from `server/form-responses.ts` into core and the validator imports them.

The submit route builds the condition answers with `answersFrom(fields, body)` (the
same function a host calls on a `FormData`) rather than from `validateSubmission`'s
`values`. An answer that is readable but invalid (a 3,000-character name against a
`max` of 200) therefore drives conditions exactly as it does in the browser, and the
submission is refused for it anyway, so nothing inconsistent is ever stored.
`formState` also runs `answerOf` over any string or string-array value a host passes
it, so `{ guests: '3' }` from a controlled input and `{ guests: 3 }` evaluate the same.

**Rejected: evaluating conditions on validated values.** Correct on the server and
impossible to reproduce in the browser without shipping the whole validator, and the
two would disagree exactly when a visitor is mid-correction.

### 6. The descriptor's `required` becomes "always required, unconditionally", and the logic travels beside it

`ResolvedFormField.required` is `true` only when the stored question is required
**and** neither it nor its section has a `showIf` **and** it has no `requireIf`. Every
form that exists today has none of those, so every existing question compiles exactly
as before.
A host that renders `required={field.required}` with no engine (both live hosts, the
demo) can therefore never put a browser-enforced `required` on a question that might
not apply, which would make a no-JavaScript form unsubmittable for everyone it did not
apply to.

The logic itself rides on new optional keys: `showIf`, `requireIf`, `section`, `hold`,
`prefill`. A conditionally asked question with `required: true` compiles to
`required: false` plus `requireIf: { all: [] }` (true whenever evaluated), so the
engine's one rule, `asked && (required || matches(requireIf))`, gives the same answer
on the stored row and on the descriptor. `ResolvedForm` gains
`sections: readonly ResolvedFormSection[]`, always present, `[]` with none.

**Rejected: leaving `required` as the stored flag** and asking hosts to consult the
engine: correct for a host that adopts the engine, and a lost-leads bug for every one
that does not, silently, on the first conditional form an editor builds.
**Rejected: a new `requirement: 'always' | 'never' | 'whenAsked' | FieldCondition`
key**: a second spelling of the same fact that every host would have to learn,
where `{ all: [] }` is already a legal `FieldCondition` meaning "always".

### 7. `formLayout(form)` with no answers shows everything; with answers it evaluates

With `answers` omitted (a server render, or a page with no script), every question and
every section is present, every cell is `shown`, and `cell.required` is the static
`field.required` from decision 6. That is what a no-JavaScript visitor needs: they see
"Tell us more" whatever they picked, the server ignores it when it did not apply, and
nothing they cannot see is required.

With answers (a host re-rendering on change), a cell whose question is not asked is
removed unless it `hold`s, in which case it stays with `shown: false`; a row with no
shown cell is removed; a section whose `showIf` fails, or with no rows left, is
removed; `inputs` (the `hidden`-kind questions) keeps only the asked ones, so an
unasked hidden input does not post. `LayoutCell` gains `required: boolean`, the
effective requiredness. `LayoutSection.section` is the `ResolvedFormSection` for a
real section and `null` for the questions outside any.

A hydrating host renders `formLayout(form)` on the server and on its first client
render, then switches to `formLayout(form, answers)` after mount. Folio ships no
binding for that in this slice; it is what slice 3's `folio/form` hook packages.

**Rejected: evaluating against `{}` when no answers are given.** A no-JavaScript
visitor could then never see, and so never answer, any conditional question.

### 8. Sections are a `forms.layout` column, and membership is a key on the question

`docs/form-layout-approach.md` Candidate C, as decided there (its decision 3): stored
`forms.layout` is `{ sections?: FormSection[] }`, each section
`{ name, label, help?, showIf?, i18n? }`, and a question joins one with
`section?: string`. Members are contiguous, so the flat array remains the one order:
CSV columns, `folio_invalid`, `validateSubmission`, the cap and the honeypot never
learn that sections exist. A section boundary breaks a row (`rowsOf`). At most 20
sections. The same object is where slice 3's `steps` will live, so steps need no
further migration.

**Rejected: a section header stored as a pseudo-question inside `fields`.** It would
need no migration, and it would be a non-question in the one array every reader treats
as questions: `MAX_FORM_FIELDS`, `SUMMARY_COLS`' `json_array_length`, the CSV header,
`honeypotName`'s taken list and every host's `form.fields.map` would each have to skip
it, and the one that forgot would render a text box named after a legend.
**Rejected: deferring sections to slice 3.** A condition over several questions has
no home without them; copying one condition onto four address questions and keeping
them in sync by hand is the failure WPForms and HubSpot both documented
(`docs/form-layout-approach.md` §2), and GOV.UK's finding that revealing several loose
questions tests poorly argues for revealing a group.

### 9. "Never asked" is a `form_responses.unasked` column; blank answers keep storing nothing

A response stores `unasked`: a JSON array of the names of value-bearing questions
(every kind but `statement`) the engine did not ask. `data` holds no key for them.
The three states a cell can show are then:

| `data` | `unasked` | Table and drawer | CSV |
| --- | --- | --- | --- |
| has the key | — | the answer | the answer |
| no key | lists it | `not asked`, muted | `(not asked)` |
| no key | does not list it | `—` | `—` |

`—` now means "no answer recorded": the question was blank, or did not exist when this
response was made. That is what it has meant in practice since spec 33 for every kind
but the two tick-box kinds (Ground truth), and the copy says so rather than claiming
the stronger distinction. `FormResponse` (the `submitted` payload) and `ResponseRow`
gain `unasked: readonly string[]`, always present, `[]` for a form with no logic and for
every response stored before `0014`.

**Rejected: storing blanks as `''` so `—` could mean only "did not exist".** It changes
every `submitted` payload for every host: Take Off Go forwards each response to Jambo
and HubSpot, and a CRM that receives `phone: ''` may well clear the phone it already
had. That is a separate, deliberate change if it is ever wanted.
**Rejected: `null` values in `data` for a question not asked.** It widens
`ResponseValue`, which hosts read in the `submitted` hook, and the first
`String(value)` in somebody's CRM code writes the word `null` into a contact.
**Rejected: a reserved `_unasked` key inside `data`.** No migration, but it overturns
the rule that a `_` key in `data` is a row something other than `insertResponse` wrote
(spec 33 decision 13, `readAnswers`), and the responses search (`q`, a `like` over
`data`) would then match on question names nobody answered.

### 10. An answer to a question that was not asked is dropped, and so is its file

`validateSubmission` skips a question the engine did not ask: no value, no refusal,
its name in `unasked`. The route drops any prepared upload, and any upload refusal,
whose question is in `unasked` before hashing, so the file is never put to R2 and a
too-large CV on a question that did not apply does not refuse the submission.
`prepareUploads` still reads and hashes every file question's part first, as it does
today, because `validateSubmission` needs the uploaded set to answer a `file`
question's `required`. The cost of that is bounded by `capFor`, and filtering
afterwards keeps `validateSubmission` the one place that decides what was asked.

**Rejected: storing the answer and hiding it on display.** The whole point of the rule
is that a crafted POST cannot write a field the visitor was never shown.

### 11. `shapeOf` means "everything the server enforces"

`shapeOf(fields, layout?)` covers, per question: `name`, `kind`, `required`,
`requireIf`, the **effective** visibility (its own `showIf` and its section's, as a
pair), option values, `min`, `max`, `pattern`, `accept` and `maxBytes`. Not `label`,
`help`, `placeholder`, `i18n`, `value`, `text`, `beside`, `grow`, `hold`, `prefill`, or
which section a question is in except through that section's condition. So moving a
question into an unconditional section bumps nothing, and making that section
conditional bumps the version.

`shapeOf` is never stored, so widening it causes no spurious bump on an existing row;
the first save that changes a `max` now bumps `version` and fires `formChanged`, where
before it only purged. A `FORM_FIELD_KEYS` record in `core/forms.ts`, typed
`Record<keyof FormField, 'shape' | 'presentation'>`, makes adding a key to `FormField`
a type error until somebody classifies it, and a unit test asserts `shapeOf` moves for
every `'shape'` key and for no `'presentation'` key.

**Rejected: logic keys only.** It would leave `version` meaning "the server's rules
changed, unless the rule was a length or a pattern", which is the definition the
roadmap asks this slice to retire.

### 12. Prefill is a per-question opt-in for the query string, and a host's own map is an argument, not a resolve option

`FormField.prefill?: 'query'` lets the page's query parameter of the same name seed
that question. `prefillAnswers(form, { query?, values? })` (core) returns normalised
answers (decision 5): a value that is not a declared option, not a number, not a day,
is dropped. `values` is the host's own map (a signed-in member's email) and wins over
the query; it applies to any question, because the host chose it. Prefill is
presentation: the server validates what is posted, so it is outside `shapeOf`.
`file` and `statement` cannot be prefilled (narrowed on read, as layout keys are).

A host seeds its inputs' default values from the result. It does not pass prefill to
`formLayout` on a no-JavaScript render (decision 7); a hydrated host passes its live
answers, which start from the prefill.

**Rejected: prefill from the query on every question by default** (what Take Off Go
does by hand today). A link can then put any words into any text box on the site's own
form, which is a phishing primitive with the site's name on it; an editor opting a
question in is the boundary. Take Off Go's own code keeps working untouched.
**Rejected: a host map through `folio.resolve`.** The `Resolution` is cache-tagged,
shared with the preview bridge and cached at the edge, and per-visitor values in it
put personal data in a shared cache. The host already holds the values at render.

### 13. `hold` is layout

`hold?: true` keeps a not-asked question's cell as `shown: false` so its row-mates do
not widen (`docs/form-layout-approach.md` decision 4). It is presentation, outside
`shapeOf`, narrowed on read, and meaningful only on a question that can be hidden.

## Wire & schema changes

### D1 migration `0014_form_logic.sql`

```sql
-- Conditional questions, sections and prefill (docs/specs/content-model/form-logic.md).
--
-- Two additive columns. Both are read by this release, so the migration must be
-- applied BEFORE the Worker that reads them is deployed (0013's rule): a Worker
-- selecting forms.layout on a database without it fails every form read with
-- `no such column`.

-- JSON object { sections?: FormSection[] }. Validated by core/forms.ts
-- validateFormLayout on write, narrowed by readFormLayout on read. A layout
-- mistake drops layout; it can never empty a form's questions.
alter table forms add column layout text not null default '{}';

-- JSON array of field names this response was never asked (decision 9). '[]' for
-- every row written before this migration, which is honest: nothing could be
-- unasked before conditions existed.
alter table form_responses add column unasked text not null default '[]';
```

No index: nothing filters or sorts on either column.

### Core types

All additive to stored rows and to the published types, except the one meaning change
in decision 6. For a form with no logic every question compiles exactly as before; the
descriptor itself gains `sections: []`.

```ts
// core/conditions.ts — one new leaf
| { field: string; includes: Json }
export function conditionRefusal(raw: unknown): string | null   // strict shape + bounds
export function readCondition(raw: unknown): FieldCondition | undefined  // total, for the read path

// core/forms.ts — FormField gains
showIf?: FieldCondition
requireIf?: FieldCondition
section?: string
hold?: true
prefill?: 'query'

export interface FormSection {
  name: string            // NAME regex, unique among sections
  label: string
  help?: string
  showIf?: FieldCondition
  i18n?: Record<string, { label?: string; help?: string }>
}
export interface FormLayout { sections?: readonly FormSection[] }
export const MAX_FORM_SECTIONS = 20

export function validateFormLayout(input: unknown, fields: readonly FormField[]): FormLayout   // throws
export function readFormLayout(input: unknown, fields: readonly FormField[]):
  { layout: FormLayout; fields: FormField[] }                                                   // never throws
export function checkFormLogic(fields: readonly FormField[], layout: FormLayout): void           // throws
export function shapeOf(fields: readonly FormField[], layout?: FormLayout): string
export const FORM_FIELD_KEYS: Record<keyof FormField, 'shape' | 'presentation'>

// ResolvedFormField gains (optional, emitted only when set)
section?: string
showIf?: FieldCondition
requireIf?: FieldCondition
hold?: true
prefill?: 'query'
// ResolvedForm gains
sections: readonly ResolvedFormSection[]
// ResolvedFormSection gains
showIf?: FieldCondition
// LayoutCell gains
required: boolean

// core/form-logic.ts (new)
export interface FormState {
  asked: ReadonlySet<string>
  required: ReadonlySet<string>
  sections: ReadonlySet<string>          // sections shown
  answers: Record<string, Json>          // normalised answers of asked questions only
}
export function formState(form: LogicForm, answers: Record<string, unknown>): FormState
export function answerOf(field: LogicField, raw: readonly string[]): Json | undefined
export function answersFrom(form: LogicForm, source: { getAll(name: string): readonly unknown[] }): Record<string, Json>
export function prefillAnswers(form: ResolvedForm, opts: { query?: URLSearchParams | string; values?: Record<string, unknown> }): Record<string, Json>
export const NUMBER_ANSWER: RegExp
export const DATE_ANSWER: RegExp
```

`LogicForm` is `{ fields: readonly LogicField[]; sections?: readonly { name: string; showIf?: FieldCondition }[] }`
and `LogicField` is `{ name; kind; section?; showIf?; required?: boolean; requireIf?; options? }`;
both `{ fields, sections }` from a stored form and a `ResolvedForm` satisfy it.

`answersFrom` takes anything with `getAll` (`FormData`, `URLSearchParams`); the server
adapts its `SubmissionBody` map with `{ getAll: (n) => body.get(n) ?? [] }`. `File`
entries are ignored.

**Operators each source kind may be compared with** (enforced by `checkFormLogic`;
the builder offers exactly these):

| Source kind | Operators | Value |
| --- | --- | --- |
| `select`, `radio` | `eq`, `ne`, `in`, `isSet` | declared option values |
| `checkboxes` | `includes`, `isSet` | a declared option value |
| `checkbox` | `eq` | `true` or `false` |
| `number` | `eq`, `ne`, `in`, `isSet` | finite numbers |
| `text`, `textarea`, `email`, `tel`, `url`, `date`, `hidden` | `eq`, `ne`, `in`, `isSet` | strings, at most 120 characters |
| `file`, `statement` | none: cannot be a source | — |

Any kind may carry `showIf` (a conditional `statement` is conditional prose). Any kind
but `statement` may carry `requireIf`. Bounds, checked by `conditionRefusal`: depth at
most 4, at most 32 nodes, an `in` list at most 100 values.

Exports added to `folio/core`: `formState`, `answersFrom`, `prefillAnswers`,
`MAX_FORM_SECTIONS`, and the types `FormState`, `FormSection`, `FormLayout`. A minor
bump. `shapeOf`'s second parameter is optional, so existing callers compile.

### Server types

- `Form` gains `layout: FormLayout`. `COLS` selects `layout`; `toForm` reads it with
  `readFormLayout`, which also clears invalid memberships from `fields`.
- `UpdateFormInput` gains `layout?: unknown`. `FormPatchBody` gains
  `layout: v.optional(FORM_LAYOUT)`.
- `validateSubmission(fields, body, uploaded?, sections?)` returns
  `{ values, errors, unasked: string[] }`.
- `NewResponse` gains `unasked: readonly string[]`; `FormResponse` and `ResponseRow`
  gain `unasked`. `RESPONSE_COLS` selects it; it is screened on read (an array of
  `NAME`-shaped strings, anything else dropped).

### New or changed routes

- `PATCH {base}/api/forms/:id` accepts `layout`. `400 bad_request` with
  `checkFormLogic`'s or `validateFormLayout`'s message for a refused one. The answer is
  the `Form`, which now carries `layout`.
- `GET {base}/api/forms/:id` and `GET {base}/api/forms/resolved` answer the new keys.
- `POST {base}/f/:id` behaviour changes as decisions 2, 5 and 10 describe; its
  request and response shapes do not. `folio_invalid` and the 422 `fields` map never
  name a question that was not asked.
- `GET {base}/api/forms/:id/responses` rows and the CSV carry the not-asked state.

## Acceptance criteria

### A required question that does not apply never blocks

```
GIVEN a form with `heard` (radio: friend, other) and `heard_other` (text,
      required, showIf { field: 'heard', eq: 'other' })
WHEN a visitor posts heard=friend with no heard_other
THEN the submission is stored
AND data has no heard_other key and unasked is ['heard_other']
WHEN a visitor posts heard=other with no heard_other
THEN the answer is 422 (or a 303 with folio_invalid=heard_other)
```

### An answer to an excluded question is dropped

```
GIVEN the same form
WHEN a crafted POST sends heard=friend and heard_other=anything
THEN the stored data has no heard_other key
AND the submitted hook's response.data has no heard_other key
AND response.unasked is ['heard_other']
```

### A file on an excluded question is never stored

```
GIVEN a file question `cv` with showIf { field: 'applying', eq: true }
WHEN a multipart POST sends applying unticked and a valid cv
THEN nothing is put to the media bucket and files is []
WHEN the same POST sends a cv over its maxBytes
THEN the submission is still stored (no too_long refusal)
```

### Conditional requiredness

```
GIVEN email and phone, each with requireIf { field: <the other>, isSet: false }
WHEN neither is answered
THEN both are refused as required
WHEN either is answered
THEN the submission is stored
```

### A section hides as one

```
GIVEN a section `postal` with showIf { field: 'postal_differs', eq: true } holding
      four required questions
WHEN postal_differs is unticked
THEN none of the four is required, none is stored, all four are in unasked
AND formLayout(form, answers) has no section named postal
AND formLayout(form) (no answers) has the section with every cell shown and
      every cell's required false
```

### The page and the endpoint agree

```
GIVEN any form and any posted body
THEN formState(compileForm(form), answersFrom(form, body)) and the submit route
     ask and require exactly the same questions
```

### Saving logic

```
WHEN a PATCH gives a question a showIf naming a later question
THEN 400 bad_request naming both questions, and nothing is written
WHEN a PATCH adds a showIf to a question
THEN version is bumped and formChanged fires
WHEN a PATCH changes only hold, prefill or which unconditional section a question is in
THEN version is not bumped, formChanged does not fire, and form:<id> is purged
WHEN a PATCH changes a question's max
THEN version is bumped
```

### Reading never empties a form

```
GIVEN a stored row whose showIf names a question that no longer exists, or whose
      layout is not JSON
WHEN the form is read
THEN every question is present, the dangling condition reads the missing answer as
     absent, and a malformed layout reads as {}
```

### Never asked, shown

```
GIVEN a response with unasked ['heard_other']
THEN the table cell for heard_other reads "not asked"
AND the CSV cell reads "(not asked)"
AND a response stored before 0014 shows "—" as before
```

### Prefill

```
GIVEN area (select: safari, beach) with prefill 'query' and name (text) without it
WHEN prefillAnswers(form, { query: '?area=safari&name=Mallory' })
THEN the answer is { area: 'safari' }
WHEN the query is ?area=moon
THEN the answer is {}
```

## Implementation plan

Five phases, each committable with the tree green. Phase 1 has no storage and no
route. Phases 2 and 3 are sequential (3 needs 2's column). Phase 4's pure model work
can start once phase 1 lands and runs in parallel with phases 2 and 3; its
responses-screen half needs phase 3. Phase 5 is last.

### Phase 1 — the vocabulary and the engine (core only)

1. `src/core/conditions.ts`: add the `includes` leaf and its `matches` case
   (`Array.isArray(value) && value.some((v) => deepEqual(v, condition.includes))`);
   add `conditionRefusal(raw)` (known shapes only, the bounds above, values limited to
   `Json` scalars and for `in` an array of them) and `readCondition(raw)` (decision 3's
   total rebuild). Extend `conditionText` in
   `src/admin/ui/screens/settings-model.ts:365` with `includes` ("X includes Y").
2. New `src/core/form-logic.ts`: `answerOf`, `answersFrom`, `formState`,
   `prefillAnswers`, `NUMBER_ANSWER`, `DATE_ANSWER`, the `LogicForm` / `LogicField`
   types. `formState` walks fields in order (decision 2), evaluates a section's
   `showIf` once at its first member, then runs the `requireIf` pass. It normalises
   string and string-array inputs through `answerOf`, passes booleans and numbers
   through, and keeps only asked questions' answers in `FormState.answers`. Header
   comment: why this is the one engine, and that the submit route calls it.
3. `src/core/forms.ts`:
   - `FormField` gains the five keys; `FormSection`, `FormLayout`, `MAX_FORM_SECTIONS`.
   - `validateOneField`: `showIf` via `readCondition`, malformed or non-object →
     `{ any: [] }`; `requireIf` via `readCondition`, malformed → dropped, and dropped
     on `statement`; `section` kept if it matches `NAME`; `hold` kept only as `true`;
     `prefill` kept only as `'query'` and not on `file`/`statement`. None of these
     throws (they run on read).
   - `validateFormLayout` (strict) and `readFormLayout` (narrowing; clears a
     member's `section` when its section is unknown or already closed, drops an
     empty section, drops a section `showIf` that `readCondition` rejects, caps at
     `MAX_FORM_SECTIONS`, answers `{}` for anything unparseable).
   - `checkFormLogic(fields, layout)`: decision 3's write-time refusals, each message
     naming the question by label and slug, written for an editor.
   - `shapeOf(fields, layout = {})` per decision 11, and `FORM_FIELD_KEYS`.
   - `rowsOf`: a change of `section` between consecutive non-`hidden` questions
     starts a new row.
   - `ResolvedFormField`, `ResolvedForm.sections`, `ResolvedFormSection.showIf`,
     `LayoutCell.required`.
   - `formLayout(form, answers?)`: decision 7. Group rows into sections by the
     cells' `field.section`, look the section up in `form.sections`; a `section` with
     no entry in `form.sections` (a descriptor cached before sections existed)
     groups under `null`. Keep the existing narrowing of a missing `row`/`grow`.
   - Replace the "next slice's" comment on `formLayout` and the "Unused this slice"
     comments on `ResolvedFormSection`/`LayoutCell` with what is now true.
4. `src/server/form-responses.ts`: import `NUMBER_ANSWER`/`DATE_ANSWER` instead of its
   local `NUMBER`/`DATE` (no behaviour change).
5. `src/core/index.ts`: export the new values and types (decision list under *Core
   types*).
6. Unit tests (below) for phase 1. Gate: `pnpm typecheck`, `pnpm test`,
   `./node_modules/.bin/biome ci .`.

### Phase 2 — storage, the builder's PATCH and the descriptor

1. `migrations/0014_form_logic.sql` exactly as above.
   `test/workers/migrations.test.ts`: both columns exist with their defaults, and a
   row inserted without them reads `'{}'` / `'[]'`.
2. `src/server/forms.ts`: `Form.layout`; `COLS` adds `layout`; `FormRow.layout:
   string`; `toForm` runs `readFields` then `readFormLayout` (a `JSON.parse` failure
   is `{}` and one logged line, never a throw); `UpdateFormInput.layout`;
   `updateForm`: fields through `fieldsFromInput`, layout through a
   `layoutFromInput` wrapper (input layout, or the current one re-validated against
   the new fields), then `checkFormLogic` inside the same `bad_request` wrapper;
   `structural = shapeOf(fields, layout) !== shapeOf(current.fields, current.layout)`;
   `descriptorChanged` adds a layout JSON comparison; the `update` statement writes
   `layout`. `createForm` relies on the column default.
3. `compileField` / `compileForm`: emit `section`, `showIf`, `requireIf`, `hold`,
   `prefill` only when set; `required` per decision 6 (the section's `showIf` is
   looked up from `form.layout`); `sections` from `form.layout.sections` with `label`
   and `help` through the locale chain (the `translate` rule, one level up) and
   `showIf` verbatim, `i18n` never shipped. Keep the key-by-key projection.
4. `src/server/validate.ts`: `FORM_FIELD` gains `showIf` and `requireIf`
   (`v.optional(v.custom((raw) => conditionRefusal(raw) === null, 'must be a valid condition'))`),
   `section` (the field-name regex), `hold` (`v.literal(true)`), `prefill`
   (`v.literal('query')`). New `FORM_LAYOUT`
   (`v.object({ sections: v.optional(v.pipe(v.array(FORM_SECTION), v.maxLength(MAX_FORM_SECTIONS))) })`,
   `FORM_SECTION` with `name`, `label` `required(200)`, `help` `bounded(500)`,
   `showIf`, and an `i18n` record of `label`/`help`). `FormPatchBody.layout`.
5. `src/server/routes/forms.ts` PATCH: no change beyond what `updateForm` returns;
   update its comment (a `hold`/`prefill`/membership-only save purges without a bump).
6. `src/server/hooks.ts:194` and `src/server/forms.ts`'s header and `updateForm`
   comments: `shapeOf` now covers everything the server enforces.
7. Tests (below). Gate as phase 1, plus `pnpm --filter demo db:local` against a fresh
   state to confirm the migration applies.

### Phase 3 — the submit path and the response's third state

1. `validateSubmission(fields, body, uploaded = new Set(), sections = [])`:
   `const state = formState({ fields, sections }, answersFrom({ fields, sections }, adapt(body)))`;
   per field: `_` names skipped as now; not asked → push to `unasked` unless
   `statement`, then `continue`; asked → `validateAnswer({ ...field, required:
   state.required.has(field.name) }, …)`. Return `{ values, errors, unasked }`.
2. `routes/forms.ts` around `:905-913`: pass `form.layout.sections ?? []`; then
   `const kept = uploads.files.filter((f) => !unasked.includes(f.field))` and the same
   filter over `uploads.errors`; use `kept` for `refusals`, `bodyHash`,
   `isDuplicateSubmission`, `putUploads`, `storedFilesOf`, `compensate` and the
   `submitted` payload's `files`. Add a numbered line to the route's ordering comment
   (`:739-772`): "9a. The engine decides what was asked; an answer or a file for a
   question that was not is dropped here, before anything is hashed or written."
3. `insertResponse`: write `JSON.stringify(input.unasked)` to the new column;
   `FormResponse.unasked`. `RESPONSE_COLS` adds `unasked`; `toResponse` screens it.
4. CSV: `CSV_NOT_ASKED = "(not asked)"`; `csvValue` answers it for a `field` or
   `retired` column whose key is in `response.unasked`, after the files check and
   before the `data` read. Rewrite the `CSV_ABSENT` comment to "no answer recorded:
   blank, or not on the form when this response was made".
5. Tests (below).

### Phase 4 — the admin

Model first (pure, unit-tested), components after.

1. New `src/admin/ui/screens/condition-model.ts`: the builder's editable subset —
   one clause, or `all`/`any` over clauses, each `{ field, op, value }` — with
   `toEditable(condition)` answering `null` for anything outside it (deeper nesting,
   `not`), `fromEditable`, `sourcesFor(fields, index, verb)` (earlier value-bearing
   questions for `showIf`, every other value-bearing question for `requireIf`),
   `operatorsFor(kind)` (the table above, with the labels "is", "is not", "is one
   of", "has an answer", "has no answer", "includes"), and
   `formConditionText(condition, fields)` phrasing with question labels and option
   labels rather than slugs.
2. `form-model.ts`:
   - `renameField` (new; `FormBuilder` uses it instead of `updateField` for the name
     input): rewrites every `field` reference in every `showIf`/`requireIf` and
     section `showIf`.
   - `removeField`: refuses while any condition names the question;
     `removeRefusal(fields, layout, name): string | null` gives the reason, and the
     delete button is disabled with that reason as its `title`.
   - `canMoveField` / `moveFieldStep`: refuse a move that would put a question above
     a question its `showIf` names, or a source below a dependent, or a section
     member outside its section's contiguous run.
   - Option removal (`removeOption`) refused while a condition compares against that
     value.
   - Sections: `startSection(fields, layout, name)` (a new section from this
     question to the end of whatever run it was in), `endSectionAfter(fields, name)`,
     `removeSection(fields, layout, name)` (members keep their place and lose
     membership), `updateSection`. Each keeps membership contiguous by construction.
   - `logicRefusal(fields, layout)`: `checkFormLogic` caught into a string, so the
     builder shows the same message the server would send.
3. New `src/admin/ui/screens/ConditionEditor.tsx`: renders the editable subset with
   `Select`/inputs from `admin/ui`, and for a non-editable stored condition shows
   `formConditionText` read-only with a **Replace** button. Wrapped in the existing
   `scoped()` subtree like the rest of the builder; no portal.
4. `FormBuilder.tsx` `FieldPanel` (`:431`):
   - **Show this question**: "Always" / "Only when…" → `ConditionEditor`.
   - **Required** replaces the checkbox at `:559` with "No" / "Always" (reads
     "Whenever it is shown" when the question or its section is conditional) /
     "Only when…" → `ConditionEditor`.
   - **Keep its space when hidden** (`hold`), only for a conditional question in a
     row of more than one.
   - **Fill from the page address** (`prefill`), not on `file`/`statement`, with the
     example `?<name>=…` as help.
   - The question list line shows a "Shown when …" / "Required when …" line in
     `formConditionText`.
   - Section header lines in the list, a `SectionPanel` (label, help, show-when,
     translations through the existing locale switcher), and the three section
     actions on a question.
   - Save sends `layout` with `fields`; Save is disabled with `logicRefusal`'s message
     shown when it is non-null.
   - Update the structural-change copy at `:151` and `:303`: a condition, a
     requirement, a length or pattern limit, or an accepted file type is now
     structural.
   - The handbook's accessibility note in one line of builder help under "Only
     when…": "Revealing one question works well for screen reader users; to reveal
     several, put them in a section."
5. `useForm.ts`: `save` already passes the patch through; widen its type with
   `layout`.
6. Responses: `responses-model.ts` gains `NOT_ASKED = "not asked"` and `cellText`
   checks `response.unasked` first; the drawer's `AnswerLine` gains `notAsked:
   boolean`; `Responses.tsx` renders it with the `css.absent` class it already
   uses for `ABSENT` (`Responses.tsx:243`, `:596`). Rewrite the
   `ABSENT` comment as in phase 3.
7. Tests (below).

### Phase 5 — the demo, the end-to-end script and the prose

1. `examples/demo/src/blocks/contact.tsx`: render sections as `<fieldset>`/`<legend>`
   from `formLayout(form)`, render `statement` cells, seed default values from
   `prefillAnswers(form, { query })`, and keep `formLayout(form)` with no answers: the demo has no client script, which
   is decision 7's no-JavaScript path, and the comment says so. The block has no
   query string today: `SubmissionStatus` (`contact.tsx:38`) carries only the three
   `folio_*` parameters and `src/index.tsx:692` provides it only after a submission.
   Add `search: string` to `SubmissionState` and provide the context on every page
   render (with `status: ''` when there was no submission), so `Notice` keeps
   answering `null` for a page that was not submitted to.
2. `scripts/forms-test.mjs`: build a form with a conditional required question, a
   conditional section, an either-or `requireIf` and a conditional file question;
   assert the acceptance criteria over native and JSON POSTs, the stored `unasked`,
   and the CSV's `(not asked)`. Extend this script rather than adding a 23rd, so the
   e2e count in `CLAUDE.md` stays true.
3. `docs/handbook.md` `## Forms` (`:1710`): new subsections **Conditional questions**
   (the engine, ordering, the operator table, the no-JS contract, the hydrating
   pattern from decision 7, the GOV.UK finding), **Sections**, **Prefill**, and a
   correction to the version paragraph (`:1718-1725`) for decision 11.
4. `UPGRADING.md`: a `0014_form_logic.sql` row ("**Apply it before you deploy**",
   0013's wording) and a `### Conditional questions (vX.Y.Z)` entry naming the
   sanctioned behaviour changes: the descriptor's `required` on conditional
   questions, `ResolvedForm.sections`, `unasked` on the `submitted` payload,
   `version` now bumping on a length/pattern/accept edit, and the rollback hazard
   (Edge cases).
5. `ROADMAP.md` `## Next` section 4: mark slice 1 built, name the follow-up issues,
   and correct "nothing purges `form:<id>`" (stale since the layout slice).
6. `docs/specs/README.md` ledger: `0014_form_logic.sql` (35) landed; next free `0015`.
   `CLAUDE.md` "The two ledgers": add `0014` and move "Next free" to `0015`.
7. `docs/specs/content-model/forms.md` `## Implementation notes`: one paragraph
   recording that decision 16's blank/did-not-exist distinction holds only for the
   tick-box kinds, pointing here.
8. Restamp this spec `done` with `## Implementation notes`.

## Edge cases

- **`ne` against a question that was not asked is true** (`matches` reads it as
  `null`). "Show B if A is not `x`" therefore shows B when A was itself hidden.
  Consistent on both sides; the handbook says so, and the builder phrases `ne` as
  "is not" without adding an implicit `isSet`.
- **A condition naming a question an older build dropped** (an unknown kind after a
  rollback) reads it as absent. Never a throw (decision 3).
- **Rollback to a build before this one** strips the new keys on read: every
  question becomes unconditional, and a question that was "required whenever shown"
  becomes required always, which can block submissions from visitors it never applied
  to. The rollback for a form is to clear `required` on its conditional questions, or
  to roll forward. `UPGRADING.md` says this in the entry.
- **A page cached with older conditions** submits against the live ones, the posture
  of spec 33 decision 7; a logic change is structural, so `formChanged` purges it.
- **A section whose every member is `hidden`-kind** has no rows; with answers it is
  removed, without answers it renders as an empty `<fieldset>` in a host that does
  not check. `formLayout` drops a section with no rows in both modes.
- **A `hold` cell in a row whose every cell is not asked**: the row is removed,
  holds and all.
- **Two submissions differing only in an answer to an unasked question** hash
  identically (the answer is dropped first) and collapse inside the duplicate window,
  which is right: they would store identical rows.
- **JSON transport**: `fromJson` already turns booleans and numbers into strings, so
  `answersFrom` sees what a browser would have sent.
- **The honeypot** is chosen from names the form does not use; sections add no names
  to that set.
- **A host passing `answers` to `formLayout` today** (none known) now gets evaluation;
  with no conditions on the form the result is identical.
- **A `hidden`-kind question with a `showIf`** is dropped from `inputs` when not asked
  and its posted value is dropped by the server; with no answers it is in `inputs`.
- **Prefill and caching**: a prefilled page is its own cache entry per query
  (`cacheKeyFor`), already true for Take Off Go. `utm_*` parameters are stripped from
  the cache key but not from the page URL, so a question named `utm_source` with
  `prefill: 'query'` is prefilled on the page while the edge stores one copy for all
  values on a host that keys its cache with `cacheKeyFor`. A server-rendered prefill
  of a `utm_*` question is then wrong on a cache hit; the handbook tells hosts to
  read `utm_*` prefill on the client.

## Testing requirements

**Unit (`test/unit/`):**

- `core/conditions.test.ts`: `includes` true/false/non-array; `conditionRefusal` for
  each malformed shape and each bound; `readCondition` rebuilds known nodes, turns an
  unknown leaf into a false node, and never throws on arbitrary input.
- New `core/form-logic.test.ts`:
  - `answerOf` per kind, including `checkbox` `'false'`, unknown option, `'12abc'`,
    `2026-02-31`.
  - **Parity with the validator**: for every kind, for a table of valid raw inputs,
    `answerOf(field, raw)` deep-equals `validateSubmission`'s stored value. This is
    the test that keeps decision 5 true.
  - `formState`: earlier-only `showIf`; a forward reference reads absent; section
    `showIf`; question AND section; `requireIf` across the whole form (the either-or
    case); an unasked question's answer absent from `FormState.answers` and from later
    conditions; string inputs normalised.
  - `prefillAnswers`: opt-in only, `values` beats `query`, invalid values dropped,
    `file`/`statement` never prefilled.
- `core/forms.test.ts`:
  - `validateOneField` narrowing for each new key, and **`readFields` never answers
    `[]` because of a logic or layout key** (fixtures: non-object `showIf`, dangling
    reference, section naming nothing).
  - `checkFormLogic`: each refusal in decision 3 and the operator table, with the
    message naming the question.
  - `validateFormLayout` / `readFormLayout`: contiguity, empty sections, unknown
    names, the cap.
  - `shapeOf`: moves for every `FORM_FIELD_KEYS` `'shape'` key and no
    `'presentation'` key, driven from the record itself; section membership moves it
    only through a conditional section.
  - `rowsOf` breaks at a section boundary.
  - `formLayout` with and without answers: hold, row removal, section removal,
    `inputs` filtering, `cell.required`, a descriptor with no `sections` key.
- `server/form-validate.test.ts`: `validateSubmission` with conditions: required and
  unasked does not refuse; unasked answer dropped and listed; `statement` never listed;
  `requireIf` refuses.
- `server/forms.test.ts`: the exact key sets updated (`sections` on the descriptor;
  a question with every new key set shows exactly those keys); decision 6's
  `required` compilation for each of the four cases; sections' labels localised and
  `i18n` absent.
- **A `Required<FormField>` fixture** with every key set, in
  `server/forms.test.ts`, asserted to survive `parseBody(FormPatchBody, …)`
  unstripped. Typed `Required<FormField>`, so adding a key to `FormField` fails
  typecheck until the fixture, and therefore this test, covers it: the guard against
  `v.object` stripping a new key silently.
- `server/form-csv.test.ts`: `(not asked)` for a current and a retired column; a file
  wins over `unasked`; `—` unchanged otherwise.
- `admin/forms-model.test.ts`: `renameField` rewrites references (question and
  section conditions); `removeField` and `removeOption` refuse while referenced;
  `canMoveField` refuses a dependency inversion; the section reducers keep membership
  contiguous; `logicRefusal` matches `checkFormLogic`.
- New `admin/condition-model.test.ts`: round trip of the editable subset,
  `toEditable` answers `null` for `not` and deep nesting, `operatorsFor` matches the
  table, `formConditionText` uses labels.
- `admin/` render tests (`test/unit/admin/render/`): `FormBuilder` renders with a
  conditional question and a section in the fixture.

**Workers (`test/workers/`, real workerd):**

- `migrations.test.ts`: the two columns and their defaults.
- `forms.test.ts`: PATCH round-trips `layout` and every new key; PATCH refuses a
  forward `showIf` with `400` and writes nothing; a logic change bumps `version` and
  fires `formChanged`; a `hold`-only save purges without a bump; a stored row with a
  corrupt `layout` reads with every question present.
- `form-submit.test.ts`: each acceptance criterion under "A required question…",
  "An answer to an excluded question…", "A file on an excluded question…" (assert the
  bucket holds no `sub_` object), "Conditional requiredness" and "A section hides as
  one", over a native POST and a JSON POST; the `submitted` hook payload carries
  `unasked` and no dropped key; `folio_invalid` never names an unasked question.
- One parity test: for a fixture form and a table of bodies, the route's stored
  `unasked` equals `[...names] minus formState(compileForm(form), answersFrom(…)).asked`.

**End to end (`scripts/forms-test.mjs` against port 5199):**

- The phase 5 additions, run with `./scripts/e2e.sh scripts/forms-test.mjs` after a
  reset, and the full `./scripts/e2e-all.sh` once before the phase is called done.

## Dependencies

- Spec 33 (forms) and the layout slice (`docs/form-layout-approach.md`), both landed.
- No new binding, no config key, no Cloudflare resource. Both live hosts must apply
  `0014` before deploying the release that carries it.

## Out of scope

- **Content-sourced options** (a `select` whose choices are a `ContentQuery`): slice
  2, its own issue. Independent of this slice; it will need `answerOf` to accept a
  resolved option list, which this slice's `options` parameter already allows.
- **Steps and the `folio/form` hook**: slice 3, its own issue. This slice leaves
  `forms.layout` as the home for `steps` and the evaluation order that makes "which
  step is this question on" well defined.
- **Cross-field rules with editor-written messages** (`rules: { when, message }[]`):
  `requireIf` covers the either-or case; a rule with a message needs a new refusal
  token and per-locale messages, and is additive later.
- **Numeric and date comparison operators**: decision 4.
- **Repeating groups, save-and-resume, partial submissions, calculated values**:
  named in `ROADMAP.md` and not planned; repeating groups break the flat
  key-to-value response outright.
- **Storing blank answers as `''`**: decision 9.

## Implementation notes

Built 2026-10-19 in the order the plan gives: the engine and vocabulary in core,
then storage and the descriptor, then the submit path, then the admin, then the demo,
the end-to-end script and the prose. Everything in *Testing requirements* exists.
The two properties that matter most were proved by breaking the code, not by reading
it: with `validateSubmission`'s `asked` check disabled, twelve unit and workers tests
fail (a required question that was not asked blocks, an answer to one is stored, a
file for one is written to the bucket); with the engine's `required` set replaced by
the stored flag, the `requireIf` tests and the parity test fail (four tests). Both
changes were reverted.

**Where the spec was wrong or ambiguous, and what was done.** Each is the
conservative reading consistent with the Architecture decisions.

- **`answerOf` returns `false` and `[]` for an unticked checkbox and an empty
  `checkboxes`, not `undefined`.** The spec says `undefined` for blank, and also that
  `answerOf` must deep-equal the validator's stored value. The validator stores
  `false` and `[]` for those two kinds, so parity wins. A blank answer of every
  other kind is `undefined`, as specified.
- **`formState.required` includes an answered question whose `requireIf` holds.** In
  the either-or case, answering `email` leaves `phone` not required and `email`
  itself still reading as required (its own rule sees `phone` blank). It is satisfied
  by its answer, so nothing blocks. The acceptance criterion ("either answered, then
  stored") holds; the set is "required", not "failing".
- **A section's unusable `showIf` reads as never-true, not dropped.** The plan said
  `readFormLayout` drops a section `showIf` that `readCondition` rejects. Dropping
  would make a section whose rule was damaged appear unconditionally and enforce its
  required questions on visitors it was never meant to reach. Decision 3 already
  chose never-true for a question's own `showIf`, so a section's reads the same way.
- **`checkFormLogic` runs when `fields` or `layout` is in the PATCH, not on a save of
  only a label or a message.** The spec says every save. A form whose stored logic a
  rollback left dangling could otherwise not be renamed, which is the situation the
  rollback guidance asks an editor to recover from. The check is against the pair that
  will be stored: a `fields`-only patch is judged against the current layout.
- **`checkFormLogic` also refuses a question whose `section` names no section**, and
  `validateFormLayout` refuses duplicate section names. The spec lists the other
  membership refusals; these two are the same posture (refuse on write what read
  would silently narrow).
- **Contiguity is strict array contiguity.** A `hidden`-kind question between two
  members of a section, with no `section` of its own, ends the run. `rowsOf` treats
  `hidden` as layout-transparent but a section is a run in the one flat array, and a
  looser rule would need a second definition of "contiguous". The builder's
  `startSection` and `endSectionAfter` keep it true by construction.
- **`formLayout` still answers one empty `section: null` group when nothing is left.**
  The spec says a section with no rows is dropped in both modes. An existing test pins
  "an empty form answers one `section: null` group with no rows", so that fallback is
  kept for the case where every group was dropped (a form every question of which is
  unasked, for instance). A host iterating `view.sections` therefore never meets an
  empty array.
- **The builder's own row grouping learned sections too.** `fieldRows` and
  `rowBlocks` in `form-model.ts` must agree with `rowsOf` on where a row starts, and
  the spec lists only `rowsOf`. Without the change the list would draw a joined row
  across a section boundary that the descriptor breaks.
- **Reducer signatures widened, all with defaults.** `removeField(fields, name,
  layout?)`, `removeOption(field, index, ctx?)`, `canMoveField` and `moveFieldStep`
  take an optional `layout`; `renameField` answers `{ fields, layout }`;
  `startSection` answers `null` for an unknown question. A move is refused only when
  it would introduce an ordering fault the form did not already have, so a form that
  is already faulty can still be rearranged towards health.
- **`ConditionEditor.tsx` is a new file under `ui/screens/`, which
  `test/unit/admin/render/dialogs.test.tsx` counts.** The classification test was
  bumped from 38 to 39 files and `ConditionEditor` added to the route-reached set (it
  mounts inside `FormBuilder`, and the fixture form now has a conditional question and
  a section so it does). The spec did not mention that gate.
- **The demo's `submission(url)` always answers a state** (`status: ''` when nothing
  was submitted) so `search` reaches the block on every render. `Notice` compares
  `state.form` to the descriptor's name and still answers nothing for a page that was
  not submitted to.
- **`ROADMAP.md` was not edited.** Phase 5 step 5 (mark slice 1 built, name the
  follow-up issues, correct the stale "nothing purges `form:<id>`" claim) is left for
  whoever owns that file.
- **The `UPGRADING.md` entry is headed by date**
  (`Conditional questions, sections and prefill (2026-10-19)`), like its neighbours,
  because no release tag exists to name. `release.yml` selects notes by a heading that
  names the tag, so rename the heading when the release is cut.

**Verified locally:** `pnpm typecheck`, `./node_modules/.bin/biome ci .`, `pnpm test`,
`pnpm build`, `./scripts/e2e-all.sh` (23 of 23 scripts) and `./scripts/e2e.sh scripts/forms-test.mjs` (61 checks, 13 of them new,
covering native and JSON posts, the stored `unasked`, the CSV's `(not asked)` and a
conditional file question). **Not verified:** nothing in this repository can observe a
cache hit or a purge, so the prefilled-page-per-query claim rests on `cacheKeyFor`'s
unit tests; the builder was exercised through jsdom render tests, not in a browser.
