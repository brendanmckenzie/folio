# Feature: Form steps, and the `folio/form` hook

> **Group:** content model
> **Build order:** 38
> **Size:** L
> **Status:** done (built 2026-11-04)
> **Wire version:** none. Forms cross neither the socket nor the admin↔preview frame shape; the new descriptor keys (`ResolvedForm.steps`, `ResolvedFormField.step`) ride inside the `Resolution` JSON the bridge already carries, as spec 35's did
> **Migration:** none. Steps live in `forms.layout`, the JSON column `0014_form_logic.sql` added for exactly this (Ground truth)
> **Build sequence:** after spec 37 (form option sources, `0016`) and spec 36 (form actions, `0017`). **Ships in the same `v1.3.0` as 36 and 37** (owner, 2026-11-04; this header said `v1.4.0` as an additive minor of its own, and every `v1.4.0` below is `v1.3.0`). Issue #55, slice 3 of #33. It edits the same files 36 and 37 edit, so it started only once both had merged. Decision 15 (stable row keys) shipped with it rather than earlier.
> **Last updated:** 2026-11-04

## Summary

Spec 35 gave a form a pure engine in `folio/core`. `formState(form, answers)`
(`src/core/form-logic.ts:143`) decides what is asked and what is required, and
`formLayout(form, answers)` (`src/core/forms.ts:968`) groups the questions into
sections and rows. Two things are still missing. A long form cannot be split into
pages: `FormLayout` holds only `sections` (`src/core/forms.ts:178-181`, whose own
comment calls it "the home for slice 3's `steps` too"). And every host writes the
same state management around the engine by hand. Both live hosts parse the
`folio_status` round trip themselves, keep their own map of status messages, and
work out which questions to mark invalid. Take Off Go does this in
`group-web/app/brands/takeoffgo/components/forms/EnquiryForm.tsx:190-240`, and All
About Africa does it differently in
`group-web/app/brands/allaboutafrica/components/FolioForm.tsx:32-48`, `:256-295`
and `:405-413`. Both call `formLayout(form)` with no answers, so neither evaluates a
condition in the browser.

This spec adds **steps**: a list in `forms.layout`, with membership set by a `step`
key on each question, and an optional `showIf` on a step. The engine reports
membership, reachability and completeness. The admin builder gets a way to split a
form into steps. Without JavaScript a stepped form renders as **one page**. The
spec also adds **`folio/form`**, a new export subpath holding one headless React
hook, `useFolioForm`. The hook owns the answers, recomputes the engine on change,
switches to the evaluated layout after hydration, seeds from prefill, tracks the
current step, reads the submit round trip, and gives a host prop-getters to spread
onto its own components. With the hook absent or failing, the form still posts
natively and the server still decides.

## Ground truth

Read at `41b4936` (main, v1.2.4 plus the 36/37 spec documents). Every `src/` file
cited is identical to `0d769b9`. **Specs 36 and 37 will land before this one and
will move many of these line numbers** in `core/forms.ts`, `server/forms.ts`,
`form-responses.ts`, `routes/forms.ts` and `validate.ts`. The facts are structural.
Check positions before building on them. Behaviour from 36 and 37 is cited from
their specs (`docs/specs/content-model/form-actions.md`,
`docs/specs/content-model/form-option-sources.md`), never by file and line, because
that code does not exist yet.

**Storage. No migration is needed (verified):**

- `0014_form_logic.sql` added `forms.layout text not null default '{}'`, a JSON
  object (form-logic.md "D1 migration"). Nothing indexes or filters it, and nothing
  limits its size or keys beyond the validators.
- `FormLayout` is `{ sections?: readonly FormSection[] }` (`core/forms.ts:178-181`).
  `validateFormLayout` (`:422`) reads only `sections` and **ignores any other key
  without throwing**. `readFormLayout` (`:469`) does the same. A layout that also
  holds `steps` therefore reads cleanly under v1.3.x, with the steps dropped (Edge
  cases, rollback).
- `FORM_LAYOUT` (`server/validate.ts:1953`) is a `v.object` with `sections` only. It
  strips unknown keys, so `steps` has to be added to it, or a PATCH would silently
  drop them. The same applies to `FORM_FIELD` (`:1861`) and a question's `step`.
- `updateForm` (`server/forms.ts:913`) re-validates the stored layout through
  `layoutFromInput` (`:247`) whenever `fields` or `layout` is in the patch
  (`:925-932`). It writes `layout` on every save (`:968`, `:976`), and it purges on
  any layout JSON change (`:942`). It writes both `fields` and `layout` on **every**
  save (`:960-976`). With neither in the patch, it writes `current.fields` and
  `current.layout`, which `toForm` read through `readFields` and `readFormLayout`.
  **Consequence for rollback:** under v1.3.x, whose narrowers drop `step` and
  `steps`, *any* save of a form wipes its steps. That includes a rename, an open or
  close toggle, or a success-message edit.
- `validateOneField` (`core/forms.ts:262`) copies keys one by one (`section` at
  `:344`) and drops everything else on read and on write, so `step` has to be added
  there as well as to `FORM_FIELD`.

**core (`src/core/`):**

- `formState` (`form-logic.ts:143-180`) walks the questions in array order. It
  evaluates a section's `showIf` once, at the section's first member, against the
  answers of earlier asked questions. A question is asked when its section is shown
  and its own `showIf` holds. `requireIf` is a second pass. `LogicField` (`:34`) and
  `LogicForm` (`:44`) are the structural inputs. `FormState` (`:49`) has `asked`,
  `required`, `sections` and `answers`.
- `answersFrom(form, { getAll })` (`:187`) reads a `FormData`, which is the same
  function the server runs on the posted body. `prefillAnswers` (`:208`) takes
  `{ query, values }` and never prefills a name `cacheKeyFor` strips (`:223-225`).
- **The answer validator is server-only.** `validateAnswer` (`server/form-responses.ts:405-534`)
  and `textAnswer` (`:367`) are pure. Their only dependencies are `EMAIL` (`:349`),
  `NUMBER_ANSWER`/`DATE_ANSWER` (already in core, `form-logic.ts:26-29`),
  `isPrintableAnswer` and `MAX_ANSWER_CHARS` (`server/validate.ts:2171`, `:2150`),
  and the `PRINTABLE` regex (`validate.ts:117`). `validateSubmission` (`:546-578`) is
  pure as well: `formState` over `answersFrom`, then `validateAnswer` for each asked
  question. `AnswerRefusal` (`:335`) is `required | invalid | too_long | out_of_range`
  and is not exported from any public subpath. `src/server/routes/forms.ts:30` is its
  only importer outside that file.
- `checkFormLogic` (`forms.ts:594-668`) refuses on write: a `showIf` naming a later
  question, a section with no members or non-contiguous members, and a section
  `showIf` naming a question at or after its first member. Membership is **strict
  array contiguity** (form-logic.md Implementation notes).
- `FORM_FIELD_KEYS` (`:670`) classifies every `FormField` key as `shape` or
  `presentation`, and `section` is `presentation`. `shapeOf` (`:703`) folds the
  section's `showIf` into each question as `sectionShowIf`.
- `rowsOf` (`:751`) starts a new row when the `section` changes. `hidden`-kind
  questions are layout-transparent.
- `ResolvedForm` (`:881-905`) always carries `sections` (spec 35 chose
  always-present). `formLayout` (`:968-1020`) answers `{ sections, inputs }`. With
  no answers everything is present. With answers, unasked cells are removed (a
  `hold` cell is kept with `shown: false`), and empty rows and failing sections are
  dropped. It never answers an empty `sections` array (`:1020`).
- React is already a **non-optional peer dependency** of the package
  (`package.json` `peerDependencies`: `react ^19.3.1`, `react-dom ^19.3.1`), and
  `src/core/render-wrap.ts:1` already imports `createElement` from `react`. A
  React-peered subpath adds no new requirement to any host.
- Exports: `folio/core`, `folio/engine`, `folio/server` and `folio/vite` are built
  by one esbuild call (`package.json` `build:js`: entries
  `core=… engine=… server=… vite=…`, `--splitting --packages=external`). Their
  declarations come from `tsconfig.build.json`, whose `include` is `src/core`,
  `src/server` and `src/vite`. The release smoke test walks every `exports` leaf
  and checks named anchors per built file (`scripts/release.mjs:261-330`).

**server (`src/server/`):**

- `compileField` (`forms.ts:442`) marks a question `conditional` when it or its
  section has a `showIf`, or when it has a `requireIf` (`:454`). A conditional
  required question compiles to `required: false` plus `requireIf: { all: [] }`
  (spec 35 decision 6, `:489`). `compileSection` (`:498`) localises `label`/`help`
  through the locale chain and never ships `i18n`. `compileForm` (`:555-598`)
  assembles the descriptor key by key.
- The submit route (`routes/forms.ts:785`) negotiates two transports with
  `wantsJson`, which tests `accept` first (`validate.ts:2185`). A `FormData` POST
  with `accept: application/json` is read as a form (`readSubmission`,
  `form-responses.ts:285-314`) and answered with JSON. `SubmitStatus` (`:641`) is a
  private type. The status texts are inline string literals at `:883`, `:899` and
  `:942`. `locationFor` (`:675`) sets `folio_status`, `folio_form` and
  `folio_invalid`. The JSON refusal is
  `{ error: { code, message }, status, fields? }` (`replyTo`, `:695-715`). A JSON
  success is `{ ok, status, id }` and carries no redirect target.
- `verify` runs **before** validation (`:878-887`), so a Turnstile token is spent by
  a submission that is then refused as `invalid`.
- From spec 36 (form-actions.md decisions 3 and 17): `SubmitStatus` gains `refused`.
  A native refusal redirects with `folio_status=refused&folio_reason=<action>.<code>`.
  The JSON reply is `422 { error: { code: 'refused', message }, status: 'refused', reason }`,
  with the message in the submission's locale. `ResolvedForm.refusals?` holds the
  editor's text keyed by `<action>.<code>`, with the lookup chain
  `refusals[reason]`, then `refusals['<action>.error']`, then a host default. A JSON
  success may carry `actions` reply values.
- From spec 37 (form-option-sources.md decisions 2, 6, 8 and 18): sourced options are
  materialised onto the question before compiling and validating, so the engine
  sees an ordinary option question. A question whose list could not be read compiles
  with its typed extras and `optionsFrom.unavailable: true`. A submission refused on
  such a question is answered `status: 'error'`, JSON `code: 'source_unavailable'`,
  HTTP 503, and natively that is plain `folio_status=error`. A content-sourced
  question with an empty list and no extras compiles with `showIf: { any: [] }`, so
  it is never asked.

**admin (`src/admin/ui/screens/`):**

- `FormBuilder.tsx` (1366 lines) draws a section header row in the question list
  (`:360-381`). It also has `SectionPanel` (`:1122`, in the same file) and the
  section actions on a question (`:468-506`). The structural-change note is at
  `:343-349`. The pure reducers live in `form-model.ts`: `removeRefusal` `:268`,
  `canMoveField` `:420`, `orderFaulty` `:490`, `renameField` `:677`,
  `startSection` `:729`, `endSectionAfter` `:751`, `removeSection` `:760`,
  `updateSection` `:771` and `logicRefusal` `:777`.
- `test/unit/admin/render/dialogs.test.tsx:320` counts the files under
  `ui/screens/` (39). A new component file there changes that count.

**preview and demo:**

- The preview bundle **hydrates** host blocks (`src/preview/mount.tsx:275`,
  `hydrateRoot`), so a host block calling a hook runs its effects inside the admin
  preview.
- The demo's contact block (`examples/demo/src/blocks/contact.tsx:252-267`) calls
  `formLayout(descriptor)` and `prefillAnswers`. The demo page ships no client
  script. `examples/starter` has no form block, so this spec leaves it unchanged.

**tests:**

- The vitest projects (`vitest.config.ts` at `41b4936`) are `unit` (Node,
  `test/unit/**` minus `test/unit/admin/render/**`), `render` (happy-dom, that
  directory only) and `workers`. `@testing-library/react` and `happy-dom` are
  devDependencies.

**hosts (`takeoffgo/group-web`, read-only, pinned to `v1.2.2`):**

- Both hosts post natively with a plain `<form>` and read the outcome from the
  router's location, so that the server render and the hydration agree
  (`EnquiryForm.tsx:206-208`, `FolioForm.tsx:250-256`). Both decide which form
  answered by comparing `folio_form` with `form.name`, but they handle an absent
  `folio_form` differently. TOG treats it as this form's (`EnquiryForm.tsx:215`).
  AAA treats it as nobody's (`FolioForm.tsx:263`).
- AAA's own comment records the cost of a native refusal: "a redirect cannot carry
  what somebody typed, so a server-side rejection of a six-line brief loses the
  brief" (`FolioForm.tsx:96-99`). That is why it relies on browser validation and
  sets no `noValidate`.
- TOG holds the submit button until Turnstile passes (`EnquiryForm.tsx:155-166`) and
  prefills every question, hidden ones included, from the query string by hand
  (`:112-118`, `:135`).

## User stories

### Editor splits a long application into pages
**As** an editor **I want to** split a 30-question application into "About you",
"Your trip" and "Anything else" **so that** a visitor sees one short page at a time.

### Editor skips a page that does not apply
**As** an editor **I want to** show the "Group details" step only when "Travelling
as" is "A group" **so that** solo travellers never see it.

### Visitor without JavaScript
**As** a visitor with scripts off **I want to** see the whole form on one page and
submit it **so that** steps never stop me from sending an enquiry.

### Visitor corrects a mistake without losing the form
**As** a visitor **I want to** be taken back to the question the server refused,
with everything I typed still there, **so that** I fix one answer instead of
re-entering five pages.

### Developer drops the hand-written status code
**As** a host developer **I want to** read the status, the invalid questions and the
editor's refusal text from one hook **so that** I stop keeping my own message map
and query-string parser.

## Architecture decisions

### 1. Steps are a `steps` list in `forms.layout`, and membership is a `step` key on each question

Stored `forms.layout` becomes `{ sections?: FormSection[]; steps?: FormStep[] }`.
Each step is `{ name, label, help?, showIf?, i18n? }`, which is a section's shape. A
question joins a step with `step?: string`. Steps follow the same rules as sections,
with three additions that come from a step being a page rather than a heading:

- **When a form has steps, every question is on one.** The write path refuses a
  stepped form with a question that has no `step`. On read, `readFormLayout` puts a
  question with no step (or with an unknown step) on the step of the nearest earlier
  question that has one. A question before any question with a step goes on the step
  of the nearest *later* question that has one. The closed-membership pass then runs
  over the result, so contiguity holds whatever order the stored keys were in. A
  stored row can never show a question that belongs to no page. `hidden`-kind
  questions carry a step like any other, under strict array contiguity (spec 35's
  implementation note). The hook keeps every step mounted (decision 9), so a hidden
  input posts whichever step it is on.
- **Step order is member order.** On write, the `steps` array must list the steps in
  the order their members appear. On read, it is reordered to member order. There is
  one order, and it is the flat question array, exactly as for sections.
- **A section lies inside one step.** On write, a section whose members span a step
  boundary is refused. On read, the boundary closes the section, using
  `readFormLayout`'s existing closed-section rule, so the members after it lose the
  membership.

On write, a step must contain at least one question that is not `hidden`. A
step holding only a `statement` is allowed. It is an interstitial page ("Before you
start"), the pattern GOV.UK uses. A form may have one step. The engine and the hook
treat it like any other stepped form, and the builder's "Remove steps" clears it.
`MAX_FORM_STEPS = 20`, the section cap. Step names and section names are separate
namespaces.

**No migration**, as the issue expected and Ground truth verifies: `forms.layout` is
a JSON text column that already holds an object, and `0014`'s own comment named it
the home for steps.

**Rejected: steps as a list of section names.** That would force every question into
a section before a form could be paged, and it would make "a section with no step"
and "a step with no section" two more states to define. **Rejected: boundary
markers** (`{ name, startsAt: '<question>' }`). No per-question key is needed, but a
rename or a move would have to rewrite the marker. It would also be a second spelling
of membership beside sections' per-question key, which every reader (`rowsOf`, the
builder, `formLayout`) would then have to understand. **Rejected: a stored step
number on each question.** Numbers renumber on every insert, and a name is what the
builder, the hook and a host's analytics all want to refer to.

### 2. The engine gates a question on its step the way it gates one on its section

`LogicField` gains `step?`, and `LogicForm` gains
`steps?: readonly { name: string; showIf?: FieldCondition }[]`. In `formState`'s
one ordered walk, a step's `showIf` is evaluated once, at its first member, against
the answers of earlier asked questions, just as a section's is. A question is asked
when **its step is reachable**, its section is shown and its own `showIf` holds.
`FormState` gains `steps: ReadonlySet<string>`, the steps that are reachable. The
step gate is checked first. A section whose members are all on an unreachable step
is recorded as decided and not shown, so the closing "judged against the whole form"
pass (`form-logic.ts:166-169`) never adds it to `FormState.sections`.

Spec 35's ordering rule settles both "which step is this question on" and "can this
step be reached yet". A step's `showIf` may name only questions before its first
member, which means questions on earlier steps. So reachability depends only on
answers the visitor has already given. The first step can never be conditional,
because nothing comes before it, and the write rule refuses a `showIf` on it.

**`requireIf` on a stepped form may name only a question on the same step or an
earlier step** (refused on write). Spec 35 let `requireIf` name any question, and
that is what makes the either-or rule possible. Across steps, though, it makes an
earlier step's completeness depend on a later answer. A visitor finishes step 1,
picks something on step 3, and step 1 quietly becomes incomplete. Their submission
is then refused for a question two pages back. Within one step the either-or rule
still works. On the read path a stored cross-step `requireIf` is still evaluated,
because read never throws. The hook copes with the resulting late refusal
(decision 11).

Because the step gate is inside `formState`, **the submit route enforces steps
without any change of its own**. A question on an unreachable step is unasked, so
its answer is dropped, its `required` never blocks, and its name goes into
`unasked`. That is spec 35 decision 10, unchanged.

**Rejected: steps as presentation only, with no engine gate.** A step's `showIf`
would then be a client-side suggestion, and a no-JavaScript visitor on the
one-page fallback would be refused for required questions on a step that did not
apply to them. That is the lost-leads bug spec 35 decision 6 exists to prevent.

### 3. Completeness is judged by the server's own validator, moved into core

"A step is complete" means every asked question on it has an answer that is valid,
and is answered if required. Validity includes `max`, `min`, `pattern`, the email
and URL shapes, the printable screen and the option sets. Only `validateAnswer`
knows those rules, and today it is server-only.

So `validateAnswer` and `validateSubmission`'s body move into
`src/core/form-answers.ts` as `checkAnswer` (internal) and
`checkSubmission(form, source, uploaded?)` (exported). `EMAIL`,
`isPrintableAnswer`, `MAX_ANSWER_CHARS` and the `PRINTABLE` regexes move with them.
`server/validate.ts` imports `PRINTABLE`, `isPrintableAnswer` and `MAX_ANSWER_CHARS`
back from core, so each regex is defined once. `server/form-responses.ts`'s
`validateSubmission` becomes a thin wrapper that adapts `SubmissionBody` to
`{ getAll }` and calls `checkSubmission`. The server's behaviour does not change, and
the spec 35 parity test between `answerOf` and the validator becomes a test of one
implementation.

`stepStatus(form, check)` (core) then answers, in step order,
`{ name, reachable, complete, questions }`. A step is `complete` when it is
reachable and none of its questions appears in `check.errors`.

**Rejected: completeness as "every required question answered"** (`answerOf` is not
`undefined`). A visitor could leave step 1 with a phone number that fails its
pattern, and the refusal would come back from the server three pages later. That is
the case this spec most needs to avoid. **Rejected: the browser's own constraint
validation of the step's controls.** It depends on the host. A host that leaves
`pattern` off its input gets a step that passes in the browser and fails on the
server. It also disagrees with the server in known places: a browser accepts
`a@b` as an email, and Folio's `EMAIL` does not. Spec 35 decision 5 rejected shipping
the validator to the browser because conditions did not need it. Completeness does.
The validator is pure, has no dependencies and is about 200 lines, and having one
validator everywhere is the rule this codebase applies wherever it finds two.

### 4. Without JavaScript a stepped form is one page; there is no POST per step

With no script, the server render is `formLayout(form)` with no answers. That shows
every step, every section and every question. Each step is a group with its own
heading (the host draws step headings as it draws section legends), and there is one
submit button at the end. The server applies the same rules to the whole body.

**Rejected: a POST per step, carrying earlier answers forward in hidden inputs.**
Folio does not render the page that would have to come back. The submit route
answers only with a 303 to the host's page (forms.md decision 5), and the redirect
may carry nothing personal (forms.md decision 6). So step 2's page could never
receive step 1's answers to put into hidden inputs, unless Folio either rendered
host markup (forms.md decision 4 refuses that) or stored the partial answers on the
server. Stored partial answers are "partial submissions", which the issue rules out
of scope. File questions make it worse: a `File` cannot be carried in a hidden
input. The one-page fallback needs nothing new, works on every host today, and is
what `formLayout` without answers already returns.

### 5. `folio/form` is a new export subpath holding one React hook; the logic it uses is exported from `folio/core`

`folio/form` exports `useFolioForm` and its types, and nothing else. It is an
`exports` entry with a `development` condition pointing at source and `types`/`default`
pointing at `dist/form.js`, built by the existing esbuild call as a fifth entry
(`form=src/form/index.ts`). It imports `react` (external, so it resolves to the
host's copy) and individual core modules (`../core/form-logic`, `../core/forms`,
`../core/form-answers`, `../core/form-status`) rather than the `folio/core` barrel,
so a host's client bundle does not pull in the block or resolve machinery.

Everything framework-free that the hook relies on is exported from `folio/core`, so
a host can use the pieces without the hook, and a server render can call the same
functions: `checkSubmission`, `stepStatus`, `readSubmitStatus` (decision 10),
`SUBMIT_STATUSES`, `DEFAULT_STATUS_MESSAGES` and the types. **No framework-free
store is published.**

This is a new surface that semver then covers. It is the reason for a minor bump
(`v1.3.0`), and removing or narrowing it later is `2.0.0`. `scripts/release.mjs`
gains the anchor `"dist/form.js": ["useFolioForm"]`.

**Rejected: a framework-free store with a thin React binding.** That would mean two
public surfaces under semver (the store's subscribe/get API and the hook) for no
host that exists or can exist. Every Folio host renders blocks with React (`BlockDef`'s
`render` returns a `ReactNode`, `core/block.ts:1`), and React is already a required
peer. The pure functions in `folio/core` are what a non-React consumer would really
want, and they are exported. Internally the hook is still split into pure functions
plus thin state, the pattern the admin follows (`form-model.ts` beside
`FormBuilder.tsx`), so it can be unit-tested in Node. **Rejected: putting the hook in
`folio/core`.** `folio/core` is imported by Workers and by server renders, and a hook
module there blurs which half of the barrel is safe off the client. Spec 35
decision 7 already said this binding would be "what slice 3's `folio/form` hook
packages". **Rejected: shipping a `<FolioForm>` component.** forms.md decision 4
refused markup, and that still holds.

### 6. The hook reads answers from the DOM form, with uncontrolled inputs

The hook attaches to the host's `<form>` through `formProps()`, which supplies a
`ref` and a delegated `onInput`/`onChange`. On every input event, and again before
any step change or submit, it reads `answersFrom(form, new FormData(formEl))` and
recomputes `formState`. Inputs are **uncontrolled**. `controlProps(field)` supplies
`defaultValue` or `defaultChecked` from prefill, never `value`.

The answers the hook holds are therefore exactly what a native POST would send,
because they come from the same `FormData` read by the same `answersFrom` the server
runs. Uncontrolled inputs hydrate with nothing to reconcile, and they keep what a
visitor typed when a step is hidden and shown again.

**Rejected: controlled inputs, with the hook holding `value` state per question.** A
native fallback needs every question to be a named native control in the `<form>`
anyway. Controlled state would be a second copy of what the DOM already holds,
needing per-kind adapters for checkboxes, radio groups and files (a `File` cannot be
set as a controlled value), and a custom widget that forgot to sync would post one
answer while the engine judged another.

### 7. The hydration rule: identical to the server render until mount, then evaluated

This is spec 35 decision 7, packaged. On the server and on the first client render,
`mounted` is `false`, `layout` is `formLayout(form)` with no answers, and every step
is visible. `formProps()` sets no `noValidate`, so the browser's own validation runs
on the no-JS path, as AAA wants. Navigation buttons (`nextProps`/`backProps`) are
meant to be rendered only when `stepped` is true, and it is `false` here. After
mount (one `useEffect`), the hook reads the DOM form and switches `layout` to
`formLayout(form, answers)`. Non-current steps get the `hidden` attribute, and
`formProps()` sets `noValidate` (decision 9).

The hook **never reads `window.location`**. The host passes the page's query string
as `search` from its own router, which is how both live hosts already read the round
trip (Ground truth). That way the server render and the first client render see the
same status and the same prefill.

**`current` is always a step that the evaluated layout still renders.** Before
mount, `current` is `null`: nothing is hidden, so no step is current. At mount,
`initialStep` runs against the evaluated layout (`formLayout(form, answers)`), and it
runs again after every recompute of the layout:

1. At mount only, when the round trip says `invalid` for this form, `current` is the
   first step in `layout.steps` that holds a named question. Later recomputes never
   pull the visitor back to it.
2. Otherwise, or when no rendered step holds one, `current` stays where it was if that
   step is still rendered.
3. If it is not, `current` moves to the nearest earlier rendered step, and failing
   that to the first rendered step.

A named question can be on a step the layout dropped. That happens after a native
round trip, because the redirect carries no answers, so a conditional step is
unreachable after mount. It also happens with a fetch `422` naming a question that a
stale descriptor does not render, or when an emptied content-sourced question
(spec 37 decision 18) empties a step. In each case the question still appears in
`problems` (decision 11) without a step, and the visitor lands on a step they can
see. When the evaluated layout drops every step, which happens only when every
question is unasked, `layout.steps` is the single group
`{ step: null, sections: [{ section: null, rows: [] }] }`, the same never-empty
fallback `sections` already has. `current` is then `null` and nothing is hidden.

**The one visible cost:** a visitor with JavaScript sees the whole form until
hydration, and then sees it collapse to one step. Folio accepts that flash.
`stepProps()` emits `data-folio-step="<name>"` on every step from the first render,
for styling and analytics. It emits `data-folio-current` only while `stepped` is
true, so a stylesheet cannot hide later steps before the hook has proved it is
running. **Rejected: recommending a pre-hydration CSS rule that hides non-current
steps under a class a head script sets.** If the bundle fails to load or the hook
degrades (decision 13), that rule leaves the visitor on step 1 with no Next button
and later steps invisible. A native POST is then refused for questions they could
never see, which is the "form with no way past step 1" this decision rejects below.
The rule could only be made safe with a fallback timer in a script Folio does not
ship.

**Rejected: rendering only the current step on the server.** With no script, that is
the whole form for a no-JS visitor, which means a form with no way past step 1.
**Rejected: `<noscript>` around the later steps.** React does not hydrate
`<noscript>` children, and inputs that exist only in a `<noscript>` are a second
rendering of the same questions.

### 8. With JavaScript, the hook submits with `fetch` by default, and the native POST is the fallback

When the hook is healthy and mounted, `formProps().onSubmit` calls `preventDefault`
and posts the form itself to `form.action` with `accept: application/json`. The body
is a `FormData` when `form.enctype` is `multipart/form-data`, and a `URLSearchParams`
built from it otherwise, so the server reads exactly the encoding it would have
received natively.

- A `422` with `fields` keeps every answer in place, moves to the earliest step with
  a refused question, and shows the server's tokens (decision 11).
- A `200 { ok }` sets `status` to `ok`. When the descriptor has a `redirectTo`, the
  hook navigates to `statusLocation(form.redirectTo, location.href, { kind: 'ok', form: form.name })`
  with `window.location.assign`. That is the URL the native 303 would have produced,
  `folio_status=ok&folio_form=<slug>` included, because the route's `locationFor`
  calls the same function (decision 10). A thank-you page that gates a conversion
  goal on those two parameters behaves the same under either transport.
- Any other JSON refusal sets `status` from the body's `status`, `reason`, `code` and
  `message`. A non-JSON or network failure sets `status` to `error`, with the default
  message. **The hook does not resubmit natively after a network failure.** The
  request may have arrived, and the visitor pressing Submit again is covered by the
  60-second duplicate collapse (forms.md decision 14).

`transport: 'native'` is an option. In that mode the hook still validates each step
and the final submit on the client, but it lets the browser post the form, and the
outcome arrives as a 303 like today.

**Why fetch is the default:** a refused native submission of a five-page form loses
all five pages, because a redirect cannot carry answers. AAA records that hazard for
a one-page form today (Ground truth). Since the hook validates every step with the
server's own validator before sending, a refusal is rare: a file the server sniffs
as the wrong type, a list that became unavailable, an action check. When it does
happen, nothing typed is lost. **Rejected: native POST as the default.** It is right
for a host that cannot change how its captcha widget behaves (Edge cases, Turnstile),
which is why it remains available as an option.

### 9. Every step stays mounted; non-current steps are `hidden`, and the hook is the only client validator once stepped

`stepProps(step)` gives a non-current step the `hidden` attribute and
`style: { display: 'none' }`. The inline style is there because the user-agent rule
`[hidden] { display: none }` loses to any author `display` on the container, and a
host that styles its step wrapper as a grid would otherwise show every step while the
hook believes it is paging. A host that passes its own `style` merges it with the
prop-getter's, and the handbook says so. The hook never asks a host to unmount a
step. This has three consequences:

- A native fallback (`transport: 'native'`, or a hook that degrades mid-session)
  posts every step's inputs, because they are all still in the `<form>`.
- A `file` chosen on step 1 is still attached at the final submit. A `File` cannot be
  put back into an input once it has been removed.
- `new FormData(formEl)` is the complete answer set at any moment.

Once `stepped` is true, `formProps()` sets `noValidate`. The browser's constraint
validation would otherwise check `required` and `pattern` on inputs inside a `hidden`
step. When one of those failed, the browser would block the submit with "An invalid
form control is not focusable" and show the visitor nothing, which is a silent
failure. In stepped mode the hook's `checkSubmission` is the only client check, and
it matches the server exactly (decision 3).

Questions that conditions remove are unmounted, as spec 35 already does within a
page: `formLayout(form, answers)` drops them. They are unasked, so the server would
drop their answers anyway. This cannot loop. `formState` reads only asked answers, so
unmounting an unasked input never changes what is asked.

**Rejected: rendering only the current step and carrying the others in hidden
inputs.** Files cannot be carried that way, and it is the controlled-state copy that
decision 6 rejects.

### 10. The round trip is read by one core function, and the status vocabulary moves to core

`src/core/form-status.ts` (new):

- `SUBMIT_STATUSES`, the tuple `['ok', 'invalid', 'closed', 'rate', 'verify', 'error', 'refused']`,
  and `type SubmitStatus`. The route's private type (`routes/forms.ts:641`, extended
  with `refused` by spec 36) is replaced by an import.
- `DEFAULT_STATUS_MESSAGES: Record<Exclude<SubmitStatus, 'ok'>, string>`, the English
  sentences the route already sends in a JSON `error.message`:
  `invalid` "Some answers need another look.", `rate` "Too many submissions from this
  address. Try again later.", `verify` "We could not verify that submission.",
  `error` "We could not process that submission. Please try again later." (spec 36's
  default for its `error` code), `closed` "This form is closed." (the route's fallback
  when `closedMessage` is empty), and `refused` "We could not accept that submission."
  (spec 36 decision 3's host default, which does not tell a visitor to retry
  something that will be refused again). The
  route imports these in place of its inline literals, so the JSON reply and the
  hook's defaults cannot drift. Spec 37's `source_unavailable` sentence stays the
  route's own, because it is JSON-only. Natively it is `folio_status=error`.
- `readSubmitStatus(form, search)` answers `null` or
  `{ kind: SubmitStatus, invalid: string[], reason: string | null }`. It reads
  `folio_status` (unknown values become `error`), `folio_form`, `folio_invalid`
  (only names that are questions on this form, and only for `invalid`), and
  `folio_reason` (only for `refused`, and only if it matches
  `^[a-z][a-z0-9-]{0,47}\.[a-z][a-z0-9_]{0,31}$`, spec 36's `ACTION_ID` and
  `ACTION_CODE`).
- `statusLocation(target, base, { kind, form?, invalid?, reason? })` answers the
  absolute URL a native submission redirects to: `target` resolved against `base`,
  with `folio_status`, then `folio_form`, then `folio_invalid` and `folio_reason`
  when present. The route's `locationFor` (`routes/forms.ts:675`) becomes a call to
  it, and the hook uses it for a fetch success with `redirectTo` (decision 8). One
  function builds the URL, so the two transports cannot land on different ones.

**Which form a status belongs to:** a status whose `folio_form` names another form
belongs to that form. A status with no `folio_form` belongs to every form on the
page. The route omits `folio_form` only when it could not identify the form at all
(`routes/forms.ts:813-822`, `not_found`), and a form that has been deleted should
say something rather than nothing. That is TOG's rule. AAA's opposite rule hides an
error page from every form.

The hook's `status.message` is chosen in this order. `ok` is `form.successMessage`.
`closed` is `form.closedMessage`, then `messages.closed`, then the default. `refused` follows spec 36's lookup chain over
`form.refusals`, then `messages.refused`. Every other status uses the JSON reply's
`message` when the hook made the request, then `messages[kind]`, then
`DEFAULT_STATUS_MESSAGES[kind]`. **The host's per-status copy is one `messages`
option**, written once per site, and it replaces both hosts' maps.

**Rejected: editor-written messages for `rate`, `verify`, `invalid` and `error`,
stored on the form.** These sentences are about the site, not the form: AAA's name a
support email address, and TOG's say "give us a call". A per-form setting would have
an editor write the same four sentences on every form, and it would need new stored
keys for no new capability. Spec 36 gave editors the refusal text because only the
editor knows what an action's code means to a visitor. That reason does not apply
here. **Rejected: a hook with no default copy at all.** Every host would rewrite the
same map, which is the duplication this replaces. The defaults already exist
server-side.

### 11. A refusal is surfaced on the step that holds it, with a whole-form summary; an action refusal is form-level

Per-question refusals come from three places: the hook's own check when the visitor
tries to leave a step, a fetch `422`'s `fields` map, and a native round trip's
`folio_invalid`. They all land in one `problems` list, in form order:
`{ name, label, step, token, message }`, where `token` is an `AnswerRefusal` and the
native round trip, which carries names only, gives `invalid`.

- Leaving a step (`next()`, or Enter, decision 16) runs `checkSubmission` and
  refuses to advance while any question on the current step has a refusal. It puts
  those questions in `problems` and moves focus to the error summary (decision 16).
- **A refusal on a step the visitor has already left** comes from the server, or from
  a stored cross-step `requireIf` (decision 2). The hook moves to the earliest
  rendered step holding a refused question (decision 7's rule), keeps `problems`
  complete across every step, and moves focus to the error summary. A problem whose
  question is on no rendered step keeps `step: null` and still appears in the
  summary. Its link focuses nothing and leaves the visitor where they are.
- `errorFor(name)` answers `{ token, message }` for a question that is in `problems`,
  or that has lost focus (`formProps().onBlur`, delegated) with a refusal, and `null`
  otherwise. `message` comes from `messages.fields[token]`, with defaults "Answer
  this question.", "Check this answer.", "This answer is too long." and "This answer
  is out of range." `controlProps(field)` sets `aria-invalid` and points
  `aria-describedby` at `errorProps(field).id`. The inline error carries **no live
  role**: `aria-describedby` already reads it with the control, and five refusals
  should not create five alert regions at once. The summary is the one place that
  announces.
- **An action refusal (spec 36) is form-level.** `status.kind` is `refused`, its
  message comes from the editor's text, and the visitor stays on the step they
  submitted from with every answer intact.

**Rejected: mapping an action refusal onto a question through the action's input
mapping.** The descriptor does not carry that mapping, and spec 36 decision 4 keeps
action metadata off every public surface. A code is also not necessarily about one
input. The editor's message can name the question ("We do not recognise that trip
code"), and the visitor can go back to it.

### 12. Prefill and the host map flow through `controlProps`, computed identically on both renders

The hook calls `prefillAnswers(form, { query: search, values })` once per
`(form, search, values)` and turns the result into `defaultValue` or `defaultChecked`
in `controlProps`. That includes `hidden`-kind questions: their default is the
prefill, then `field.value`, then `''`. This replaces TOG's
`params.get(field.name) ?? field.value` (`EnquiryForm.tsx:117`) for questions the
editor opts in. Both renders compute the same values from the same `search`, so
prefill never causes a hydration mismatch. Spec 35 decision 12's opt-in boundary is
unchanged: the hook prefills from the query only the questions marked
`prefill: 'query'`.

### 13. If the hook fails, the form degrades to the server render

Every engine call inside the hook runs in one `try`. On any throw the hook logs one
`console.error("folio/form: …", err)` and sets `degraded: true` for the life of the
component. When degraded, it behaves exactly as before mount: no answers, every step
visible, no `data-folio-current`, no `noValidate`, no `onSubmit` interception, and
`stepped` is `false`. A throw inside `onSubmit`, after `preventDefault`, would
otherwise swallow that submission, so there the hook degrades and then calls
`formEl.requestSubmit()`, which the now-inert handler lets through as a native POST.
The form then posts natively and the server decides, which is the issue's requirement
made concrete. A throw outside the hook is the host's own error boundary to handle,
and the handbook says so.

**Rejected: rethrowing.** An unhandled throw in a hydrating component unmounts the
root, which turns a bug in the hook into a page with no form at all.

### 14. The builder edits steps the way it edits sections

The changes to `FormBuilder.tsx` are all inside the existing file. `StepPanel` sits
beside `SectionPanel`, so the screens-file count in `dialogs.test.tsx` does not move.

- **Question list.** A step header row is drawn before each step's first member
  ("Step 2", the label, and a `Conditional` badge when it has a `showIf`), with the
  section header nested under it. Selecting it opens `StepPanel`.
- **`StepPanel`** has the label, help, "Show this step: Always / Only when…"
  (`ConditionEditor`, with sources limited to questions before the step's first
  member, and no "Only when…" on the first step), translations through the existing
  locale switcher, **Merge with previous step** (not on the first step), and
  **Remove steps** (clears every membership and the list, and confirms first).
- **Question actions.** **Split into steps here** appears when the form has no steps
  and the question is not first. It makes step 1 from everything above and step 2
  from here down. **Start a new step here** appears when the form has steps and the
  question is not first in its step. Both are refused, with the reason as the
  button's `title`, when the split would cut a section in two, leave a step with no
  visible question, or put a question's required rule on an earlier step than a
  question it names (decision 2's write rule). A builder action never produces a form
  that `logicRefusal` would then refuse to save.
- **Reducers** (`form-model.ts`): `splitStepsAt`, `startStepAt`,
  `mergeStepIntoPrevious`, `removeSteps` and `updateStep`. Each keeps membership
  contiguous by construction and names steps `step_1`, `step_2` and so on through
  `uniqueFieldName`'s pattern. `addField` puts a new question on the last step.
  `canMoveField`/`moveFieldStep`: moving a step's first member up moves it onto the
  previous step, and moving its last member down moves it onto the next. The move is
  refused when it would empty a step of visible questions, carry a section member
  across a boundary, introduce an ordering fault (`orderFaulty`), or put a
  `requireIf` source on a later step than the question that names it.
  `removeRefusal` refuses removing a step's last visible question.
  `startSection`'s run is limited to the question's step.
- `sourcesFor(fields, index, 'require')` (`condition-model.ts:102`, verbs `'show' | 'require'`)
  gains an optional `layout` argument, and on a stepped form it offers only questions on
  the same step or an earlier one (decision 2). `logicRefusal` picks up the new
  `checkFormLogic` rules automatically.
- The structural-change note (`:343-349`) adds "or a step given a condition", and the
  presentation clause adds "step".

**Rejected: a separate Steps tab.** Membership is a property of position in one flat
list. A second view of the same order is the place the two would drift apart.

### 15. A layout row's key is the name of the first question the row was built from, asked or not

`LayoutRow.key` is the name of the first non-`hidden` question in the row's declared
run of `fields`, whether or not that question is asked. A cell that conditions
remove does not change the key of the row it was in. Each question belongs to
exactly one row, so the key is still unique across the form. In `formLayout`
(`core/forms.ts:968-1020`), each pending row records the name of the field that
opened it, at the point where the row is pushed. The `LayoutRow` takes that name
rather than `row.cells[0]!.field.name` (`:1005`).

The key exists so that a host can pass it to React as `key`. Both live hosts do
(`EnquiryForm.tsx:123`). A key taken from the first *shown* cell moves whenever a
condition hides that cell: `company` (shown when `travelling` is `group`) followed
by `phone` (`beside: true`) is keyed `company` for a group and `phone` for a solo
traveller. React then remounts `phone`'s row, and an uncontrolled input loses what
the visitor typed while the question is still asked. That bug has existed in
`formLayout` since spec 35. It has not bitten because no host evaluates layouts in
the browser yet. The hook is the first consumer that does (decisions 6 and 7).

This decision is independent of steps. It changes no type and no output for a form
without conditions, so it can ship on its own as a patch release ahead of this spec.
Whether it does or not, the rule above is what `formLayout` implements.

**Rejected: the row number as the key.** `row` is a positional index from `rowsOf`,
so inserting a question in the builder renumbers every row after it, and a host
holding a cached descriptor beside a fresh one would see two keyings of the same
form. A question name is what every other identity in the layout already uses.
**Rejected: telling hosts to key rows themselves.** Every host would have to
rediscover the bug the first time it hydrated a conditional form.

### 16. Keyboard, focus and announcements follow GOV.UK's patterns

The hook carries the behaviour that a no-JS page gets for free from a page load.
The host spreads the prop-getters that make each of these work.

**Enter.** `formProps()` includes a delegated `onKeyDown`. On Enter in an `input`
that is not a button, checkbox, radio, file or submit input, and never in a
`textarea`, it calls `preventDefault()` and then `next()`, while `stepped` and not on
the last step. It does not depend on implicit submission, which does nothing when
the default button is disabled (a captcha gate) or hidden. On the last step it does
nothing, and the browser's implicit submission runs as usual. As a backstop,
`onSubmit` before the last step also calls `next()`.

**A step change.** After a successful `next()`, `back()` or `goTo()`, the hook moves
focus to the new step's heading. That is the element the host spreads
`stepLabelProps(step)` on (`{ id, tabIndex: -1, ref }`). If the host spread no
heading, focus goes to the step container (`stepProps`, `tabIndex: -1`). The
heading's text is the step label, so a screen reader hears which page it is on. This
is the GOV.UK one-question-per-page behaviour of landing at the top of a new page.
Focus never falls to `<body>` with the Next button that just became `hidden`.

**The error summary.** GOV.UK's error summary pattern, adapted:

- `summaryProps()` answers `{ ref, tabIndex: -1, role: 'alert', 'aria-labelledby' }`.
  `summaryTitleProps()` answers the matching `{ id }` for the heading. Folio
  supplies no heading text: GOV.UK's is "There is a problem", and the host writes it.
  The host renders the summary at the top of the current step whenever `problems` is
  non-empty, and keeps it there while problems remain.
- **The summary takes focus whenever a refusal is shown.** That covers a refused
  `next()`, a refused final check, a fetch `422`, and a native round trip with
  `folio_status=invalid` for this form, which gets focus once at mount, as GOV.UK
  focuses the summary on page load. It applies to one problem or many. It does not
  move to the first field. A host that renders no summary (`summaryProps` never
  attached) gets focus on the first refused control instead.
- Each entry is drawn with `problemLinkProps(problem)`:
  `{ href: '#<control id>', onClick }`. The `onClick` prevents the default, switches
  to the problem's step if needed, and focuses the control. For a radio or checkbox
  group that is the first option. The control is scrolled so that its label is in
  view (`scrollIntoView` on the label, then `focus({ preventScroll: true })`, the
  GOV.UK error-summary script's approach). The `href` still works without the
  handler.
- Inline errors are not live regions (decision 11). The link text is the problem's
  `message`, and the host may prefix the label.

**The outcome of a fetch submission.** A native submission announces itself with a
page load. A fetch submission does not, so:

- `statusProps()` answers `{ ref, tabIndex: -1, role }`. `role` is `'status'` for
  `ok` and `'alert'` for every other kind. The host renders that container whenever
  `status` is non-null, holding `status.message`.
- When a fetch request completes with any outcome other than `invalid` (which goes to
  the summary), the hook focuses the status container after it renders. On success
  the form often unmounts and the container replaces it, so focus there is also what
  stops focus from falling to `<body>`.
- On a round trip read at mount (`ok`, `closed`, `rate`, `verify`, `error` or
  `refused` in the URL), the hook does not move focus. The page load has already
  announced the page, and GOV.UK does not focus a confirmation panel.
- While a request is in flight, `submitProps()` sets `aria-busy` and `disabled`.

**Rejected: an always-mounted live region that the hook writes text into.** The
admin's toast needs that because it announces without moving focus. Here focus has to
move anyway, because the control the visitor used is about to disappear on success.
Focusing a container that holds the message announces it and also gives focus a
place to land.

## Wire & schema changes

### D1 migration

None. Steps are stored in `forms.layout` (`0014`). The ledger does not move: next
free stays `0018`.

### Core types

All additive. A form with no steps compiles byte-for-byte as before, because
`ResolvedForm.steps` and `ResolvedFormField.step` are emitted only when the form has
steps.

```ts
// core/forms.ts
export interface FormField { …; step?: string }        // FORM_FIELD_KEYS: step: 'presentation'
export interface FormStep {
  name: string                                          // NAME regex, unique among steps
  label: string
  help?: string
  showIf?: FieldCondition
  i18n?: Record<string, { label?: string; help?: string }>
}
export interface FormLayout { sections?: readonly FormSection[]; steps?: readonly FormStep[] }
export const MAX_FORM_STEPS = 20

export interface ResolvedFormField { …; step?: string }           // every question, on a stepped form
export interface ResolvedFormStep { name: string; label: string; help?: string; showIf?: FieldCondition }
export interface ResolvedForm { …; steps?: readonly ResolvedFormStep[] }  // emitted only when non-empty

export interface LayoutStep { step: ResolvedFormStep | null; sections: readonly LayoutSection[] }
export interface FormLayoutView { sections: …; inputs: …; steps: readonly LayoutStep[] }
// `steps` is always present: one `{ step: null, sections }` for an unstepped form, so
// a host can always iterate steps. `sections` stays the flat list across all steps.

// core/form-logic.ts
export interface LogicField { …; step?: string }
export interface LogicForm { …; steps?: readonly { name: string; showIf?: FieldCondition }[] }
export interface FormState { …; steps: ReadonlySet<string> }      // reachable steps

// core/form-answers.ts (new; moved from server/form-responses.ts and server/validate.ts)
export type AnswerRefusal = 'required' | 'invalid' | 'too_long' | 'out_of_range'
export type ResponseValue = string | number | boolean | readonly string[]
export interface CheckField extends LogicField { max?: number; min?: number; pattern?: string }
export interface SubmissionCheck {
  state: FormState
  values: Record<string, ResponseValue>
  errors: Record<string, AnswerRefusal>
  unasked: string[]
}
export function checkSubmission(
  form: { fields: readonly CheckField[]; sections?: LogicForm['sections']; steps?: LogicForm['steps'] },
  source: { getAll(name: string): readonly unknown[] },
  uploaded?: ReadonlySet<string>,
): SubmissionCheck
export interface StepStatus { name: string; reachable: boolean; complete: boolean; questions: readonly string[] }
export function stepStatus(form: LogicForm, check: SubmissionCheck): StepStatus[]
export const MAX_ANSWER_CHARS = 10_000
export function isPrintableAnswer(raw: string, multiline: boolean): boolean
export const PRINTABLE: RegExp

// core/form-status.ts (new)
export const SUBMIT_STATUSES: readonly ['ok', 'invalid', 'closed', 'rate', 'verify', 'error', 'refused']
export type SubmitStatus = (typeof SUBMIT_STATUSES)[number]
export const DEFAULT_STATUS_MESSAGES: Readonly<Record<Exclude<SubmitStatus, 'ok'>, string>>
export interface SubmitStatusRead { kind: SubmitStatus; invalid: readonly string[]; reason: string | null }
export function readSubmitStatus(form: ResolvedForm, search: string | URLSearchParams): SubmitStatusRead | null
```

`ResponseValue` moves its definition to core. `server/form-responses.ts` re-exports
it, so every server import keeps working.

New `folio/core` exports: `checkSubmission`, `stepStatus`, `readSubmitStatus`,
`SUBMIT_STATUSES`, `DEFAULT_STATUS_MESSAGES` and `MAX_FORM_STEPS`, plus the types
`AnswerRefusal`, `ResponseValue`, `SubmissionCheck`, `StepStatus`, `SubmitStatus`,
`SubmitStatusRead`, `FormStep`, `ResolvedFormStep` and `LayoutStep`. All additive,
which makes this a minor bump. `MAX_ANSWER_CHARS`, `isPrintableAnswer` and `PRINTABLE`
stay internal: they are imported by relative path, not through the barrel.

### `folio/form` (new subpath)

```ts
export function useFolioForm(form: ResolvedForm, options?: FolioFormOptions): FolioForm

export interface FolioFormOptions {
  /** The page's query string, from the host's router. Drives status and prefill. */
  search?: string | URLSearchParams
  /** The host's own prefill map (`prefillAnswers`' `values`). */
  values?: Record<string, unknown>
  messages?: {
    invalid?: string; closed?: string; rate?: string; verify?: string; error?: string; refused?: string
    fields?: Partial<Record<AnswerRefusal, string>>
  }
  transport?: 'fetch' | 'native'                 // default 'fetch'
  /** Prefix for every id the hook mints. Default `folio-<form.name>-<useId()>`, with
   *  `useId`'s output reduced to `[A-Za-z0-9_-]`. */
  idPrefix?: string
  onSubmitted?(result: { ok: true; id: string; actions?: Record<string, Record<string, string | number>> }): void
}

export interface FolioForm {
  mounted: boolean
  degraded: boolean
  /** mounted && !degraded && the form has steps. */
  stepped: boolean
  layout: FormLayoutView                         // decision 7
  answers: Record<string, Json>
  status: null | {
    kind: SubmitStatus; message: string; invalid: readonly string[]
    reason: string | null; code: string | null; fields: Readonly<Record<string, AnswerRefusal>> | null
  }
  problems: readonly { name: string; label: string; step: string | null; token: AnswerRefusal; message: string }[]
  pending: boolean
  /** Increments each time a request is sent: a host keys its captcha widget on it. */
  attempt: number
  steps: readonly {
    name: string; label: string; index: number; total: number
    reachable: boolean; complete: boolean; available: boolean; current: boolean
  }[]
  current: string | null
  isFirst: boolean
  isLast: boolean
  next(): boolean
  back(): void
  goTo(step: string): boolean
  focus(name: string): void

  formProps(): { ref; method; action; encType; noValidate?: true; onSubmit; onInput; onChange; onBlur; onKeyDown }
  honeypotProps(): { type: 'text'; name: string; tabIndex: -1; autoComplete: 'off'; 'aria-hidden': true }
  /** `form.hidden` (`_folio_page`, `_folio_locale`), for the host to emit verbatim. */
  hidden: readonly { name: string; value: string }[]
  stepProps(step: LayoutStep): { ref; hidden?: true; style?: { display: 'none' }; tabIndex: -1; role: 'group'; 'aria-labelledby': string; 'data-folio-step': string; 'data-folio-current'?: '' }
  stepLabelProps(step: LayoutStep): { id: string; tabIndex: -1; ref }
  labelProps(field: ResolvedFormField, option?: FormFieldOption): { htmlFor: string; id: string }
  /** `radio` and `checkboxes`: the container of the options, labelled by the legend. */
  groupProps(field: ResolvedFormField): { role: 'group' | 'radiogroup'; 'aria-labelledby': string; 'aria-required'?: true; 'aria-invalid'?: true; 'aria-describedby'?: string }
  controlProps(field: ResolvedFormField, option?: FormFieldOption): Record<string, unknown>
  errorFor(name: string): { token: AnswerRefusal; message: string } | null
  errorProps(field: ResolvedFormField): { id: string } | null
  summaryProps(): { ref; tabIndex: -1; role: 'alert'; 'aria-labelledby': string }
  summaryTitleProps(): { id: string }
  problemLinkProps(problem: FolioForm['problems'][number]): { href: string; onClick }
  statusProps(): { ref; tabIndex: -1; role: 'status' | 'alert' }
  nextProps(): { type: 'button'; onClick; disabled?: true }
  backProps(): { type: 'button'; onClick; hidden?: true }
  submitProps(): { type: 'submit'; disabled?: true; hidden?: true; 'aria-busy'?: true }
}
```

`controlProps` answers per kind:

- Every kind: `id` (`<idPrefix>-<field.name>`, with `-<option.value>` appended for an
  option) and `name`.
- `required`, on every kind except `checkboxes`. It is the cell's effective
  requiredness after mount, and `field.required` before it.
- Text kinds: `type` and `maxLength` (`min`/`max` for `number`).
- `pattern`.
- `file`: `accept` joined with commas.
- `aria-invalid` and `aria-describedby` when the question has an error.
- `defaultValue` or `defaultChecked` from prefill.
- `checkbox`: `value: 'yes'`.
- `radio` with an `option`: `value: option.value`, and `required` on the first radio
  only. HTML makes the whole group required from one member.
- `checkboxes` with an `option`: `value: option.value` and **never `required`**. On
  a checkbox, HTML `required` means "this box must be ticked", while the server's
  rule for `checkboxes` is "at least one" (`form-responses.ts:452-460`). On the no-JS
  path, where browser validation runs, a `required` on each option would demand every
  box. The group's requiredness travels as `aria-required` on `groupProps(field)`,
  and the hook's own check enforces "at least one" once mounted. Without JavaScript
  the server enforces it, which is how both live hosts behave today.
- `aria-invalid` and `aria-describedby` for `radio`/`checkboxes` go on the group
  (`groupProps`), not on each option.

`useId` is stable between the server render and hydration, so the default prefix is
too, and two copies of the same form on one page (a newsletter form in the header
and the footer) get distinct ids. Both live hosts use `id={field.name}` today, which
collides as soon as two forms share a question name.

### Server types

- `validateSubmission(fields, body, uploaded?, layout?)`: the fourth parameter
  widens from `sections: readonly FormSection[]` to `layout: FormLayout = {}`, so
  steps reach the engine. `routes/forms.ts` passes `form.layout`. The function body
  becomes a call to `checkSubmission`. Fold this into spec 37's materialised-fields
  version as built.
- `compileForm`: `steps` from `form.layout.steps` through `compileStep` (the same
  locale pick as `compileSection`, factored into a shared `pickLayoutText`). `step`
  on every question of a stepped form. `compileField`'s `conditional` also becomes
  true when the question's step has a `showIf`.
- `FORM_FIELD` gains `step: v.optional(FIELD_NAME)`. `FORM_STEP` mirrors
  `FORM_SECTION`. `FORM_LAYOUT` gains `steps` (array, `maxLength(MAX_FORM_STEPS)`).

### New or changed routes

- `PATCH {base}/api/forms/:id` accepts `layout.steps` and `fields[].step`. It answers
  `400 bad_request` with `checkFormLogic`'s or `validateFormLayout`'s message for a
  refused one. A change to a step's `showIf` is structural (bumps `version`, fires
  `formChanged`). A change to a step's label, help, translations or membership in an
  unconditional step only purges.
- `GET {base}/api/forms/:id` and `GET {base}/api/forms/resolved` answer the new keys.
- `POST {base}/f/:id`: no shape change. The engine gate (decision 2) makes a
  question on an unreachable step unasked. The status texts are imported from
  `DEFAULT_STATUS_MESSAGES` with no change in wording.

## Acceptance criteria

### Steps store and read back without a migration

```
GIVEN a database at 0017 (no newer migration)
WHEN an editor PATCHes layout { steps: [about, trip] } with every question on one
THEN GET answers the same steps and memberships
AND the descriptor has steps [about, trip] and every question carries step
AND a form with no steps has no steps key and no step keys, byte-identical to v1.3.0
```

### Membership is refused on write and narrowed on read

```
WHEN a PATCH leaves a question without a step on a stepped form
  OR lists steps out of member order
  OR splits a section across two steps
  OR gives a step only hidden questions
  OR gives the first step a showIf
  OR gives a step a showIf naming a question at or after its first member
  OR gives a question a requireIf naming a question on a later step
THEN 400 bad_request naming the step or question, and nothing is written
GIVEN a stored row with a question whose step is unknown, and a step listed out of order
WHEN it is read
THEN the question is on the previous question's step, steps are in member order,
     and every question is present
```

### A step that does not apply is not asked, natively

```
GIVEN steps about, group (showIf { field: 'travelling', eq: 'group' }), trip
  AND group holds group_size (number, required)
WHEN a no-JS visitor posts travelling=solo with no group_size
THEN the submission is stored and unasked includes group_size
WHEN they post travelling=group with no group_size
THEN 303 with folio_status=invalid&folio_invalid=group_size
```

### No JavaScript is one page

```
GIVEN that form rendered by a host using useFolioForm, server-side
THEN every step's questions are in the HTML, no step has the hidden attribute,
     the form has no novalidate, and there is one submit button
AND no step carries data-folio-current
AND no checkbox in a required checkboxes question carries required
```

### Hydration matches, then steps

```
GIVEN the server HTML above
WHEN it is hydrated with the same search
THEN React reports no hydration mismatch: onRecoverableError is not called and
     console.error is not called during hydrateRoot (React's development build,
     which reports attribute mismatches only through console.error)
AND after mount only the current step lacks hidden, the form has novalidate,
    and stepped is true
```

### A step cannot be left incomplete

```
GIVEN step about with email (required) and phone (pattern ^\+?[0-9 ]{8,}$)
WHEN the visitor enters phone "abc" and presses Next
THEN current stays about, errorFor('phone').token is 'invalid', errorFor('email').token
     is 'required', focus is on the error summary, and no request was made
WHEN they activate the summary's email link
THEN focus is on the email input
WHEN they fix both and press Enter in a text input
THEN current is the next reachable step and focus is on its heading
WHEN the submit button is disabled (a captcha gate) and they press Enter on step 1
THEN current still advances
```

### The client and the server agree

```
GIVEN any form and any body
THEN checkSubmission(compileForm(form), body) and the submit route's validateSubmission
     produce the same errors, values and unasked
```

### A server refusal goes back to its step, with answers kept

```
GIVEN a three-step form submitted with fetch, and a server that refuses a file on step 1
     as invalid (wrong sniffed type)
WHEN the 422 arrives
THEN current is step 1, focus is on the error summary, problems lists the file
     question, and every typed answer on steps 2 and 3 is still in its input
```

### The native round trip lands on the right step

```
GIVEN /apply?folio_status=invalid&folio_form=apply&folio_invalid=trip_date
  AND trip_date is on step trip
THEN the server render marks trip_date invalid
AND after mount current is trip and focus is on the error summary
GIVEN /apply?folio_status=invalid&folio_form=apply&folio_invalid=group_size
  AND group_size is on the conditional step group, unreachable with no answers
THEN after mount current is the first rendered step, never group, and problems
     still lists group_size with step null

### The current step is always rendered

```
GIVEN step 1's only visible question is a content-sourced question with an empty list
THEN after mount current is step 2 and step 2 is not hidden
GIVEN the descriptor is replaced (admin preview) by one without the current step
THEN current moves to the nearest earlier rendered step
```

### A fetch outcome is announced

```
WHEN a fetch submission answers 200 ok
THEN status.kind is ok and focus is on the statusProps container (role status)
WHEN it answers 429 rate
THEN focus is on the statusProps container (role alert) holding the rate message
WHEN the form has redirectTo /thanks
THEN location.assign receives /thanks?folio_status=ok&folio_form=<slug>
```

### Row keys survive conditions

```
GIVEN travelling (radio), company (showIf travelling = group), phone (beside)
THEN formLayout(form, { travelling: 'group' }) and formLayout(form, { travelling: 'solo' })
     key the row holding phone "company" both times
```

### Action refusal and statuses

```
GIVEN ?folio_status=refused&folio_form=apply&folio_reason=trip-code.unknown_trip
THEN status.kind is refused and status.message is form.refusals['trip-code.unknown_trip']
GIVEN folio_reason names a code missing from a stale descriptor
THEN status.message is form.refusals['trip-code.error'], else messages.refused, else the default
GIVEN ?folio_status=rate&folio_form=other
THEN status is null for the form named apply
GIVEN ?folio_status=error (no folio_form)
THEN every form on the page reports kind error
GIVEN a fetch reply 503 { status: 'error', error: { code: 'source_unavailable', message } }
THEN status.kind is error, status.code is source_unavailable, status.message is the server's
```

### Degradation

```
GIVEN a descriptor whose showIf makes formState throw (a test stub)
WHEN the hook mounts
THEN degraded is true, one error is logged, every step is visible, no step carries
     data-folio-current, the form has no novalidate, and submitting performs a native POST
GIVEN the engine throws inside onSubmit, after preventDefault
THEN the hook degrades and the submission still goes out natively (requestSubmit)
```

### The release surface

```
WHEN node scripts/release.mjs --smoke-only runs
THEN the folio/form export resolves and dist/form.js exports useFolioForm
```

## Implementation plan

Seven phases, each committable with the tree green. Phase 0 depends on nothing and
may ship ahead as a patch release. Phases 1 and 2 are core only, and 2 depends on 1.
Phase 3 (server) needs 1 and 2. Phase 4 (the hook) needs 0, 1 and 2, and can run in
parallel with phase 3. Phase 5 (the builder) needs 2, because it builds on
`FormStep`, `FormField.step` and the new `checkFormLogic` rules. It can run in
parallel with phases 3 and 4. Phase 6 is last. Run the gates after each phase:
`pnpm typecheck`, `./node_modules/.bin/biome ci .`, `pnpm test` (gate on exit codes,
per CLAUDE.md).

### Phase 0: stable row keys (decision 15)

1. `core/forms.ts` `formLayout`: each pending row records the name of the first
   non-`hidden` field that opened it, whether or not that field is asked, and
   `LayoutRow.key` is that name. Update the `LayoutRow` doc comment to say so.
2. `test/unit/core/forms.test.ts`: the key of a row is unchanged when its first cell
   becomes unasked, and is unchanged between `formLayout(form)` and
   `formLayout(form, answers)`. Break-check: restoring `row.cells[0]!.field.name`
   must fail it.
3. When shipped alone, add a `CHANGELOG.md` "Fixed" line ("A form row keeps its key
   when a condition hides its first question, so a host's inputs in that row are not
   remounted") and no `UPGRADING.md` entry: nothing for a consumer to do.

### Phase 1: move the validator into core (no behaviour change)

1. New `src/core/form-answers.ts`. Move `EMAIL`, `MULTILINE`, `textAnswer`,
   `optionValues`, `validateAnswer` (renamed `checkAnswer`, internal), the body of
   `validateSubmission` (as `checkSubmission`, taking `{ fields, sections?, steps? }`
   and a `{ getAll }` source), `AnswerRefusal`, `ResponseValue`, `MAX_ANSWER_CHARS`,
   `isPrintableAnswer`, `PRINTABLE` and `PRINTABLE_MULTILINE` from
   `server/form-responses.ts` and `server/validate.ts`. Keep the exhaustive `never`
   switch and its comment. In this phase `checkSubmission` takes
   `{ fields, sections? }`. Phase 2 adds `steps?`.
2. `server/validate.ts`: import `PRINTABLE`, `isPrintableAnswer` and
   `MAX_ANSWER_CHARS` from `../core/form-answers` and delete the local definitions.
3. `server/form-responses.ts`: `validateSubmission(fields, body, uploaded, layout = {})`
   calls `checkSubmission` with an adapter. Re-export `AnswerRefusal` and
   `ResponseValue`. `answerBudget` keeps importing `MAX_ANSWER_CHARS`. In the same
   commit, `routes/forms.ts` passes `form.layout` in place of
   `form.layout.sections ?? []`. An array against the all-optional `FormLayout` is a
   weak-type error, so the two changes cannot be split.
4. Run the existing `validateSubmission` unit tests' assertions against
   `checkSubmission` as well (one parametrised suite over both). **Keep the
   `answerOf`/validator parity test** (`test/unit/core/form-logic.test.ts:74-111`),
   retargeted at `checkSubmission`. `answerOf`, which conditions read, and
   `checkAnswer`, which judges answers, are still two functions, and that test is what
   holds spec 35 decision 5 true.
5. Gate. Then prove the move changed nothing: `pnpm test` with the workers
   `form-submit.test.ts` suite green, unedited.

### Phase 2: steps in core, and the status vocabulary

1. `core/forms.ts`: `FormField.step`, `FormStep`, `FormLayout.steps`,
   `MAX_FORM_STEPS`, and `FORM_FIELD_KEYS.step = 'presentation'`.
   `validateFormLayout` validates `steps` like `sections` (name, label, help, showIf
   through `conditionRefusal`, i18n through `validateSectionI18n`).
   `readFormLayout` reads steps (malformed dropped, unusable `showIf` never-true, cap)
   and then, over the fields, does four things:
   1. Clears unknown step memberships.
   2. Gives a question with no step the nearest earlier question's step, or, before
      any, the nearest later one's (decision 1).
   3. Runs the closed-membership pass over the result (a step that has closed does
      not reopen), and closes a section at a step boundary.
   4. Drops empty steps and reorders `steps` into member order.

   `validateOneField` keeps `step` when it matches `NAME`, as it keeps `section`
   (`:344`).

   With no steps it changes nothing.
2. `checkFormLogic`: the write-time refusals listed in the acceptance criteria, each
   naming the step by label or the question by label and slug.
3. `shapeOf`: add `stepShowIf` beside `sectionShowIf`.
4. `rowsOf`: a change of `step` starts a row.
5. Descriptor types: `ResolvedFormField.step`, `ResolvedFormStep`, `ResolvedForm.steps?`,
   `LayoutStep`, `FormLayoutView.steps`. `formLayout` groups sections into steps (a
   new group starts when a row's step changes). Without answers every step is
   present. With answers, a step not in `state.steps`, or with no rows, is removed.
   When every step is removed, `steps` is the single never-empty group (decision 7).
   An unstepped form answers one `{ step: null, sections }`. The existing never-empty
   fallback for `sections` holds.
6. `core/form-logic.ts`: `LogicField.step`, `LogicForm.steps`, `FormState.steps`.
   The step gate goes into the walk, decided at the first member exactly like the
   section block (`:150-160`), and checked before it. A section on an unreachable
   step is marked decided and not shown (decision 2). A step none of whose members
   came up is judged against the whole form, the section rule at `:166-169`.
7. `core/form-answers.ts`: `stepStatus`.
8. New `core/form-status.ts`: `SUBMIT_STATUSES`, `SubmitStatus`,
   `DEFAULT_STATUS_MESSAGES`, `readSubmitStatus` and `statusLocation` (decision 10).
9. `core/index.ts`: the exports listed under Core types.
10. Unit tests (Testing requirements). Gate.

### Phase 3: server

1. `server/validate.ts`: `FORM_FIELD.step`, `FORM_STEP`, `FORM_LAYOUT.steps`.
2. `server/forms.ts`: `compileForm`/`compileField`/`compileStep` per Server types.
   Keep the key-by-key projection, and emit `steps` and `step` only for a stepped
   form. `updateForm` needs no change: it already passes the whole layout through
   `layoutFromInput`, compares `shapeOf`, and compares the layout JSON.
3. `routes/forms.ts`: replace the private `SubmitStatus` with the core import, the
   inline status texts with `DEFAULT_STATUS_MESSAGES`, and the `form.layout.sections`
   argument with `form.layout`. Add one line to the order comment: "9a also gates a
   question on its step (spec 38): a question on an unreachable step is unasked."
4. Tests (Testing requirements). Gate.

### Phase 4: `folio/form`

1. New `src/form/index.ts` (the public surface, re-exporting `useFolioForm` and its
   types) and the internals beside it. `src/form/model.ts` holds pure functions with
   no React: `initialStep` (decision 7's three rules, run at mount and after every
   layout recompute), `navigation`, `enterAction` (decision 16's key rule),
   `problemsOf`, `statusView`, `controlPropsOf`, `groupPropsOf`, `sanitiseId`,
   `fileRefusal` (client approximations for size over `maxBytes`, which gives
   `too_long`, and a declared MIME type outside `accept`, which gives `invalid`; the
   server's sniff stays authoritative), and `transportBody`. `src/form/use-folio-form.ts`
   holds the hook (`useState`/`useReducer`, `useEffect` for mount, `useRef` for the
   form and step elements, and one `try` around the engine calls, per decision 13).
2. The hook's file check: the `uploaded` set passed to `checkSubmission` is the
   names of file inputs whose `FormData` entry is a `File` with `size > 0`.
3. Spec 37's unavailable list: a question with `optionsFrom?.unavailable` never
   blocks `next()` or submit on the client. Its refusal is dropped from the client
   check and left to the server, which may have loaded the list by then.
4. `package.json`: the `exports["./form"]` entry (`development`, `types`, `default`),
   `form=src/form/index.ts` in `build:js`. `tsconfig.build.json` `include` gains
   `src/form`. `scripts/release.mjs` anchors gain `"dist/form.js": ["useFolioForm"]`.
5. `vitest.config.ts`: the `render` project includes `test/unit/form/render/**`, and
   `unit` excludes it.
6. Tests (Testing requirements). Gate, plus `pnpm build`, and confirm
   `dist/form.js` and `dist/types/form/index.d.ts` exist and that `dist/form.js`
   imports `react` as a bare specifier (external).

### Phase 5: the builder

1. `form-model.ts`: the reducers in decision 14, plus the step-aware changes to
   `addField`, `canMoveField`, `moveFieldStep`, `removeRefusal` and `startSection`.
   Pure, unit-tested first.
2. `condition-model.ts` `sourcesFor`: the stepped `requireIf` restriction, and step
   `showIf` sources (questions before the first member).
3. `FormBuilder.tsx`: step header rows, `StepPanel` in the same file, the question
   actions, and the structural-note wording. `useForm.ts` needs no change: `layout`
   already travels whole.
4. Tests. Gate.

### Phase 6: the demo, the end-to-end script and the prose

1. `examples/demo/src/blocks/contact.tsx`: render through `useFolioForm(descriptor,
   { search: state?.search ?? '' })`, using its prop-getters, `stepProps` and
   `problems`. The public demo page ships no script, so it is the no-JS one-page path.
   The admin preview hydrates the block (`preview/mount.tsx:275`), so it shows the
   stepped path. Rewrite the comment at `:255-265` to say both. `examples/demo/seed.sql`
   seeds no forms (verified), and this does not add one: the end-to-end script builds
   its own stepped form.
2. `scripts/forms-test.mjs`: build a stepped form with a conditional step and assert,
   over native and JSON POSTs, that an unreachable step's required question does not
   block, that its answer is dropped and listed in `unasked`, and that a reachable
   one refuses. Extend this script rather than adding one, so the e2e count in
   `CLAUDE.md` stays true.
3. Docs (next section). Restamp this spec `done` with `## Implementation notes` once
   built.

## Documentation this implies

- **`docs/handbook.md` `## Forms` (`:1988`)**: add a **Steps** subsection after
  **Sections** (`:2183`). It covers the storage, the membership and ordering rules,
  the step gate, the no-JS one-page rule and why there is no POST per step, and
  GOV.UK's guidance on one thing per page. Add a **The `folio/form` hook**
  subsection after **Prefill** (`:2201`), with these parts:
  - a complete minimal stepped form using the prop-getters;
  - the hydration rule, the flash it costs, and why no CSS should hide steps before
    `stepped` is true (decision 7);
  - merging a host's own `style` with `stepProps`' (decision 9);
  - the error summary, the status container and the step heading, with the GOV.UK
    error-summary pattern they follow (decision 16);
  - why the transport defaults to fetch, and when to choose `native`;
  - the Turnstile reset, keyed on `attempt`: remount the widget with
    `key={f.attempt}`, and reset any "captcha passed" gate the host holds on the
    same change;
  - the `messages` option, replacing a host's own map;
  - degradation;
  - a section on migrating from a hand-written form. Its before and after are drawn
    from the patterns in Ground truth, and it names no consumer.

  Update **Submitting** (`:2258`) to name `readSubmitStatus` and `SubmitStatus` from
  `folio/core`. In the subpath table (`:4391-4401`), the heading's "seven" becomes
  "eight", with a `folio/form` row: "`useFolioForm`, the optional headless hook that
  binds a form descriptor to a host's own inputs. React, client-side." Add a
  `### folio/form` section after `### folio/core` (`:4410`).
- **`AGENTS.md`**: one bullet beside the `folio/core`/`folio/engine` bullet
  (`:376-379`). It should say that a host renders a Folio form with its own markup,
  that `useFolioForm` from `folio/form` is the optional binding, and that the form
  must still be a plain `<form>` posting to `form.action`.
- **`docs/configuration.md`**: no change. There is no new `createFolio` key.
- **`UPGRADING.md`**: a `### Form steps and the folio/form hook (v1.3.0)` entry.
  - Nothing to run: no migration, and no config.
  - A form with no steps compiles byte-for-byte as before.
  - New: the `folio/form` subpath, and new `folio/core` names (list them).
  - `FormLayoutView` gains `steps` (additive).
  - `ResolvedForm.steps` and `ResolvedFormField.step` appear only on stepped forms.
  - A host that ignores them renders a stepped form as one page, which works.
  - `LayoutRow.key` is now stable under conditions (decision 15). This entry belongs
    to whichever release carries phase 0.
  - **Rolling back to v1.3.x** is possible, with no schema step, but:
    - Steps are ignored, so the form becomes one page.
    - A step's `showIf` is ignored, so a required question on a conditional step is
      required for everyone and blocks visitors it never applied to.
    - **Any save of a form under v1.3.x** drops its `steps` and every `step` key
      permanently. That includes renaming it, opening or closing it, and editing its
      success message, as well as editing questions, because `updateForm` writes the
      layout and the questions back on every save, and v1.3.x reads both without
      steps.
    - Before rolling back, an editor removes the conditions from steps, or the site
      rolls forward.
    - A host importing `folio/form` must remove that import to build against v1.3.x.
- **`CHANGELOG.md`**: a `## 1.3.0` section. Added: steps, `folio/form`, and the core
  exports. Changed, with no wording change: the submit route's status texts now come
  from `DEFAULT_STATUS_MESSAGES`.
- **`ROADMAP.md`** §4: mark slice 3 built and remove it from the plan.
- **`docs/specs/README.md`**: add a ledger row for 38 (migration "none").
  **`CLAUDE.md`**: the specs paragraph names 38. The migration ledger is unchanged.

## Edge cases

- **A reachable step whose every question is unasked** (all conditionally hidden,
  or spec 37's empty content-sourced question) has no rows, so `formLayout` drops it,
  navigation skips it, and `current` never starts on it (decision 7). `stepStatus` reports it reachable and complete.
- **A visitor changes an earlier answer that makes a later step unreachable** after
  filling it in. That step's inputs unmount and their answers are gone if the step
  comes back. The server would have dropped them anyway. This matches spec 35's
  in-page behaviour.
- **A stored cross-step `requireIf`** (written before this release or through a
  rolled-back build) is still evaluated. The final client check, or the server,
  refuses it, and the hook moves back to that step (decision 11).
- **Turnstile tokens are single-use, and `verify` runs before validation.** With the
  fetch transport, a refused attempt spends the token, and a retry with the same
  widget fails `verify`. `attempt` increments per request, so a host remounts its
  widget with `key={f.attempt}`. A host that cannot do that uses
  `transport: 'native'`. The client check makes a refused attempt rare.
- **A captcha widget inside a `hidden` step** may not render. The handbook says to
  place it on the last step or after the steps, next to submit. Enter still advances
  through earlier steps while a captcha gate holds submit disabled (decision 16).
- **Browser autofill** writes into inputs on hidden steps. The hook re-reads
  `FormData` before every step change and submit, so autofilled values are judged
  even when no input event fired.
- **Two forms on one page** get distinct ids (`folio-<form.name>-…`), and each reads
  only its own status, except a status with no `folio_form` (decision 10).
- **A descriptor cached before steps existed** (a host's own KV or `caches.default`)
  has no `steps`. The hook treats it as unstepped. A descriptor with `step` keys but
  no `steps` (impossible from `compileForm`, possible from a hand-built one) leaves
  the questions ungated by steps and groups them under `step: null`.
- **The admin preview** hydrates host blocks, so the hook runs there. Submitting from
  the preview posts to the form's action on the preview origin, which on a multi-site
  deployment answers `error` (`not_found`). That is today's behaviour for a native
  preview submit, and the hook surfaces it as a status.
- **`redirectTo` with fetch**: `window.location.assign`. A cross-origin `redirectTo`
  is whatever the form already allows. The hook adds no check, because the native 303
  would go to the same place.
- **A JSON success with spec 36 `actions` reply values** reaches `onSubmitted`. It is
  never put in a URL, matching spec 36 decision 17.
- **A file input on step 1** stays mounted (decision 9). With `enctype` urlencoded a
  form has no file questions by construction (`compileForm`), so `transportBody`
  never drops a `File`.
- **Rollback**: see the `UPGRADING.md` entry above.

## Testing requirements

**Unit (`test/unit/`, Node):**

- `core/form-answers.test.ts`: every existing `validateSubmission` case run against
  `checkSubmission`. `stepStatus` covers: complete only when there are no errors on
  its questions, unreachable steps, and a step with only a statement.
- `core/form-logic.test.ts`: the step gate covers:
  - a question on an unreachable step is unasked, and its answer is absent from
    later conditions;
  - a step's `showIf` decided at its first member;
  - step AND section AND own `showIf`;
  - `FormState.steps`.
- `core/forms.test.ts`:
  - `validateFormLayout` with steps;
  - each new `checkFormLogic` refusal, with the message naming the step or question;
  - `readFormLayout`'s four narrowings, and that it never empties a form;
  - `shapeOf` moving for a step `showIf` and not for a step label or membership in an
    unconditional step, driven by `FORM_FIELD_KEYS`;
  - `rowsOf` breaking at a step change;
  - `formLayout` with and without answers on a stepped form, `steps` on an
    unstepped form, and the all-steps-dropped fallback;
  - row keys stable under conditions (phase 0).
- `core/form-status.test.ts`: `readSubmitStatus` for every status, an unknown status,
  another form's status, no `folio_form`, `folio_invalid` filtered to this form's
  questions, and a malformed `folio_reason` dropped. `statusLocation` gives the
  route's exact `Location` for each status (the route's existing redirect tests
  stay green unedited after `locationFor` delegates to it).
- `server/forms.test.ts`:
  - the descriptor's exact key sets: unchanged for an unstepped form, and with
    `steps`/`step` for a stepped one;
  - `compileField`'s `required` when only the step is conditional;
  - localised step labels with no `i18n` shipped;
  - the `Required<FormField>` fixture gains `step` and survives `FormPatchBody`
    unstripped.
- `form/model.test.ts` (pure):
  - `initialStep`: the first step; the earliest invalid question's step; a stale
    name; a round-trip question on an unreachable step, which lands on the first
    rendered step; an emptied first step; and the current step removed from a
    replaced descriptor, which moves to the nearest earlier step.
  - `navigation`: skips empty and unreachable steps; `available`.
  - `enterAction`: text input before the last step gives next; the last step, a
    `textarea`, a checkbox and a button give none.
  - `problemsOf` ordering, with `step: null` for a question on no rendered step.
  - `statusView`'s message chain, including spec 36's fallback and the `closed`
    fallback for an empty `closedMessage`.
  - `controlPropsOf` for each kind: ids from the prefix, `required` on the first
    radio only, **no `required` on any `checkboxes` option**, and `defaultChecked`.
    `groupPropsOf` gives `aria-required` for a required `checkboxes`.
  - `fileRefusal`, and `transportBody` choosing `URLSearchParams` for urlencoded.
- `admin/forms-model.test.ts`: each step reducer keeps membership contiguous, and
  moves across boundaries adopt the neighbour step and are refused when a section
  would split or a step would be emptied. A split or a move that would put a
  `requireIf` source on a later step than its dependent is refused with a reason,
  and no reducer output fails `logicRefusal`. `logicRefusal` matches
  `checkFormLogic`.
- `admin/condition-model.test.ts`: stepped `requireIf` sources, and step `showIf`
  sources.

**Render (`test/unit/form/render/`, happy-dom, React Testing Library):**

- Hydration: `renderToString` a stepped form, then `hydrateRoot` in happy-dom with
  `onRecoverableError` spied **and `console.error` spied to fail the test**, under
  React's development build (vitest's `NODE_ENV=test` selects it; assert
  `process.env.NODE_ENV !== 'production'` in the test). Then assert the post-mount
  attributes (Acceptance criteria "Hydration matches").
- Next refuses, with focus on the summary. A summary link focuses its control on its
  step. Enter is driven by dispatching `keydown`, not by implicit submission, which
  happy-dom does not model. Enter advances with the submit button disabled, and a
  step change focuses the new step's heading. Back, and `goTo` refused for an
  unavailable step.
- A row's input keeps its typed value when a condition hides the row's first cell.
- Fetch transport with `fetch` stubbed. A 422 moves back with inputs intact and
  focuses the summary. A 200 sets `ok` and focuses the status container, and with
  `redirectTo` it calls a stubbed `location.assign` with
  `folio_status=ok&folio_form=<slug>`. A 429 focuses the status container with role
  `alert`. A 422 refused shows the server message. A network failure gives `error`
  and no second request. `attempt` increments.
- Native transport: no `preventDefault` when the check passes, `preventDefault` and
  errors when it fails.
- Degradation (Acceptance criteria).
- `admin/render/`: `FormBuilder` renders with a stepped fixture form. The
  `dialogs.test.tsx` count is unchanged.

**Workers (`test/workers/`, real workerd):**

- `forms.test.ts`: PATCH round-trips steps and memberships. PATCH refuses each write
  rule with `400` and writes nothing. A step `showIf` change bumps `version` and
  fires `formChanged`. A step-label change purges without a bump. A stored row with a
  corrupt `steps` reads with every question present.
- `form-submit.test.ts`: "A step that does not apply is not asked" over native and
  JSON. The parity test is extended with a stepped fixture
  (`checkSubmission(compileForm(form), body)` against the route's stored result).
  Status texts unchanged (the existing JSON-message assertions stay green, unedited).

**End to end:** `./scripts/e2e.sh scripts/forms-test.mjs` after a reset, and
`./scripts/e2e-all.sh` once before phase 6 is called done.

**Release:** `node scripts/release.mjs --smoke-only` passes with the new anchor.

**Verify by breaking** (the practice from spec 35's notes):

- Remove the step gate from `formState`. The native "not asked" workers tests and the
  stepped parity test must fail.
- Make `stepProps` unmount instead of hide. The fetch render test's "inputs intact on
  step 2" must fail.
- Drop `noValidate` in stepped mode. Nothing in happy-dom will catch it, so the
  handbook's reason must be read rather than tested. Record this as unverified in
  Implementation notes.

**Not verifiable here:** behaviour in real browsers (autofill events, Turnstile in a
`hidden` container, the browser's "not focusable" block). The demo's admin preview is
the place to exercise the stepped path by hand, and that is the only browser check
this spec can name.

## Dependencies

- Spec 35 (landed): the engine, sections, prefill and `forms.layout`.
- Specs 37 and 36 (`v1.3.0`, built first): `optionsFrom.unavailable` and
  `source_unavailable` (37), and `refused`, `folio_reason`, `ResolvedForm.refusals`
  and the JSON reply shape (36). This spec reads all of them. The hook's
  `readSubmitStatus` and `statusView` are written against both specs' documented
  wire, so they must be built after both land.
- No binding, no config key, no Cloudflare resource, no migration.

## Out of scope

- **Repeating groups, save-and-resume, partial submissions and calculated values**:
  named in `ROADMAP.md` and not planned. Partial submissions are also what a no-JS
  multi-page flow would need (decision 4).
- **Editor-written status copy for `rate`, `verify`, `invalid` and `error`**:
  decision 10. That copy belongs to the site, through the hook's `messages`.
- **A progress indicator component, button labels per step, and "check your answers"
  summary pages**: these are markup and copy, which the host owns. The hook supplies
  `steps` with `index` and `total` and `problems`, which is the data each one needs.
- **Updating the browser URL after a fetch submission**: a router owns the
  location, and a `history.replaceState` behind its back puts the two out of sync.
  A reload after a fetch success shows the form again, which is harmless.
- **Adopting the hook in `takeoffgo/group-web`**: a consumer change made in that
  repository after this ships, guided by the handbook's migration section.

## Implementation notes

Built 2026-11-04 in the plan's order on `feat/form-steps`, phases 1 to 5 committed
separately and phase 6 (this one) last. The draft was reviewed adversarially before
the build (4 high, 7 medium and 11 low findings, folded into the spec as it stands);
the findings that mattered most were that `current` can name a step the evaluated layout
dropped (answered by `initialStep` clamping on every recompute, decision 7) and that
the spec must agree with the submit route's `asked` set. **Ships in `v1.3.0` with 36 and
37**, not `v1.4.0`: the owner's sequencing changed on 2026-11-04. Its `UPGRADING.md` entry
sits beside theirs, and the shared "roll-forward only" section gains one item for the
`steps` that an older builder would drop on save.

**Where the spec was wrong or ambiguous, and what was done.**

- **`FORM_FIELD.step` landed in phase 2**, and `validateSubmission` passes
  `layout.steps` from then on, because storing a step and compiling a step condition
  cannot be separated.
- **`statusLocation` is exported from `folio/core`** (decision 10 uses it to build the
  native redirect), and the duplicate scalar-answer limit in the submit route was folded
  into core (`SCALAR_ANSWER_CHARS`).
- **`stepStatus().questions` is every question on the step**; an unreachable step is
  `reachable: false, complete: false`.
- **`source_unavailable` stays status `error`**, with its own JSON text; a native
  redirect carries `folio_status=error`.
- **`compileField` treats a step's `showIf` as conditional**: `required: false` and a
  `requireIf` of `{ all: [] }`, matching sections.
- **Builder (phase 5).** Refusals run `checkFormLogic` over the candidate form and refuse
  only when the original passed and the result would not. The layout reducers
  (`pruneSections`, `removeSection`, `updateSection`) used to drop `steps` and now keep
  them. Splitting names new steps `step_N` with the default labels "Step 1" and "Step 2",
  and "New step" when one is started.
- **`folio/form` (phase 4).** `steps[].index` counts available steps from 0 and is `-1`
  for an unavailable one; `total` is the available count; `FolioForm.steps` is `[]` unless
  the form is stepped. `goTo` forward is refused (and the summary focused) unless every
  earlier available step is complete; backward is always allowed. `controlProps` also
  emits `placeholder`. `stepProps` for the unstepped group returns `{ ref, tabIndex: -1 }`;
  `role`, `aria-labelledby` and `data-folio-step` are optional in its type. `summaryProps`
  and `statusProps` return callback refs. `checkDom` in `model.ts` wraps `checkSubmission`
  with client file approximations, drops unavailable-list questions and checks asked
  questions only. A refused message resolves in this order: the fetch reply's message,
  `refusals[reason]`, `refusals['<action>.error']`, `messages.refused`, the default. A
  changed search string re-reads the round trip and clears the fetch outcome.
- **`dist/form.js` imports only `react` and Folio's core chunks** (checked in the built
  file), and `release.mjs` anchors `dist/form.js` on `useFolioForm`.
- **A core fix found by the builder, made in phase 6.** Spec 36's `alwaysAnswered`
  (`src/core/form-actions.ts`) ignored a step's `showIf`, so `attachmentProblems` did not
  flag a required action input mapped onto a question on a conditional step, and at run
  time that delivery would lack the input. It now requires that the question's step has
  no `showIf`, as `compileField` does. The builder's own `stepRuleRefusal` guard was
  covering the gap in the admin; the core check covers every caller. Pinned by a unit
  test that fails without the fix.

**Verified by breaking**: the builder, the engine, the submit path and the hook each had
their load-bearing check disabled in place and a test went red before it was restored
(recorded per phase); phase 6 removed the step condition from `alwaysAnswered` and the
new `refuses a showIf on its step` test failed.

**Not verified in a browser** (only jsdom and the unit model): the builder's split,
start, merge and remove flows, the step header nesting, the up and down titles, the
remove confirmation and step translation; and for the hook, the browser's constraint
validation on hidden steps, autofill on hidden steps, a Turnstile widget inside a hidden
step with `key={attempt}`, real focus, scroll and screen-reader announcements, a
`requestSubmit` native POST, a real multipart fetch, and the hydration flash.

**Build review.** An adversarial review of the built branch found seven things, all fixed.
(1) The `[form]` effect committed on every run, so a host passing a new descriptor object
each render looped until the tab ran out of memory; it now commits only when the read
answers, errors or clamped step moved. (2) `number` controls now carry `step="any"`, as the
server has no integer rule. (3) The client file check keeps only `maxBytes`: the server
sniffs bytes and never reads the declared type, so any client type check could refuse a
file the server takes. (4) Lookups keyed by question name (`problemsOf`, `refusalFor`,
`stepStatus` and, predating the branch, `matches`) use `Object.hasOwn`, so a question named
`constructor` no longer reads `Object.prototype`. (5) "Merge with previous step" is refused
(and its button disabled with the reason) when it would put an action's required input on a
conditional step, by the same `stepRuleRefusal` guard as a move. (6) The field panel words
"Required" as "Whenever it is shown" when the step has a condition. (7) The hook no longer
sets `maxLength`: browsers count UTF-16 units and the server counts code points, so it
stopped astral characters the server accepts; `checkSubmission`'s `too_long` applies the
limit.
