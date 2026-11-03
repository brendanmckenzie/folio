# Feature: Form actions

> **Group:** content model
> **Build order:** 36
> **Size:** L
> **Status:** done (built 2026-11-03)
> **Wire version:** none. Forms cross neither the socket nor the admin↔preview frame shape; the one new descriptor key (`ResolvedForm.refusals`) rides inside the `Resolution` JSON the bridge already carries, exactly as spec 35's keys did
> **Migration:** `0017_form_actions.sql`
> **Build sequence:** after 35 (form logic, `0014`) and after spec 37 (option sources), which builds first and takes `0016_option_sources.sql`. Both touch `FormBuilder.tsx`, `server/forms.ts`, `form-responses.ts`, the submit route and `validate.ts`, so the builds are serialised, never parallel. **Both ship together as the minor `v1.3.0`**; next free migration after both is `0018`.
> **Last updated:** 2026-11-03

## Summary

A form has exactly two places a host can act on a submission, and neither can carry
an integration. `forms.verify` runs before storing, sees the raw body and answers a
boolean (`src/server/routes/forms.ts:1066`); `hooks.submitted` runs after storing,
its return value is ignored and its throw is swallowed (`src/server/hooks.ts:392`).
Everything else is the host's own code, so the first real two-brand host routes
forms with a brand-then-slug `if` chain (`takeoffgo/group-web`
`app/folio.config.server.ts:163-177`), relies on an unwritten contract that a
question is called `email`, `first_name` and `last_name` (`enquiry.server.ts:65-119`),
redefines `ResponseValue` because Folio does not export it
(`allaboutafrica/folio/enquiry.server.ts:36`), derives labels from slugs because the
payload has none (`:16-21`, `:51`), and loses every failed Jambo or HubSpot delivery to
a log line while the visitor is told "ok" (`enquiry.server.ts:116`).

This adds **form actions**: a per-brand registry of host-defined submission actions
that an editor attaches to a form in the builder. An action declares the **inputs**
it needs (the editor maps each onto a question, and Folio refuses a save that would
leave a required one unfed), its **settings** (described with the block field
definitions the admin already renders), and the **outcome codes** it can refuse with
(the editor writes the visitor-facing text for each, per locale). It has up to two
phases: a synchronous, side-effect-free **`check`** before the response is stored,
which fails closed and can refuse with a code, and a **`deliver`** after it is stored,
which never affects the reply and is **logged, retried with backoff from the host's
existing cron, and shown with a Retry button in Responses**. A refused attempt now
counts against the form's rate limit. `hooks.submitted` stays as it is.

## Ground truth

Read at `0d769b9` (v1.2.4) with a clean tree. Every line below was opened and read.

**core (`src/core/`):**

- `FormField` (`forms.ts:104-166`) has no notion of anything downstream of a
  submission. `FormFieldKind` is fourteen kinds (`forms.ts:31-45`), including
  `statement` (stores nothing), `hidden` (a value the host's markup emits) and `file`.
  Question names match `^[a-z][a-z0-9_]{0,63}$` (`forms.ts:193`).
- `FORM_FIELD_KEYS` (`forms.ts:670`) classifies every `FormField` key as `shape` or
  `presentation`, and `shapeOf` (`forms.ts:703`) is the projection `forms.version`
  bumps from: "everything the server enforces" over the *questions* (spec 35 decision
  11). It takes `fields` and `layout` and nothing else.
- `ResolvedForm` (`forms.ts:881-907`) carries `successMessage` and `closedMessage` as
  plain strings. Neither is translatable; there is no form-level i18n today.
- `Field` (`fields.ts:114-277`) is the block field union. The six scalar kinds are
  `text` (`:127`), `textarea` (`:128`), `number` (`:129`), `boolean` (`:130`), `date`
  (`:139`) and `select` (`:140`, static `options: SelectOption[]`). `Common`
  (`fields.ts:10-57`) carries `label`, `group`, `help`, `required`, `showIf`,
  `hidden`, `default` and `translatable`; its `default` is "Written into a blok's data
  at creation … only. Never consulted at render" (`fields.ts:31-37`). `ValueOf`
  (`fields.ts:326`) maps a field to the type `render` receives. None of these contain
  a function; all are JSON.
- `Manifest` (`schema.ts:136`) is served **ungated** by `GET {base}/api/schema`
  (`server/app.ts:154`). The rule for what may go in it is written at
  `server/app.ts:130-148`: "the declarations a client needs before it can
  authenticate", and "would you be content to see it in an unauthenticated `curl`?
  If the answer needs a caveat, it goes on `/me`." `ManifestHooks` (`schema.ts:129`)
  is event names only.

**server (`src/server/`):**

- `FolioForms<Env>` (`form-responses.ts:2229-2272`) is `verify` (a method, for
  bivariance under `strictFunctionTypes`, `:2252-2257`) and `ratePerHour`.
  `FORMS_KEYS` (`:2280`) is those two, and `validateForms` (`:2297`) refuses any other
  key at construction. `ResolvedForms` (`:2274`) is `{ config, ratePerHour }`.
- `FolioBrand.forms` (`types.ts:654-671`, the key at `:667`) is the same
  `FolioForms<Env>`, and `FolioSingleConfig` carries it too (`types.ts:896`). Each
  brand's is validated in `prepareBrand` (`runtime.ts:752`) and reaches requests as
  `BrandRuntime.forms` (`runtime.ts:243`). The submit route reads it off `brandOf(c)`
  (`routes/forms.ts:877`; `brandOf` is `routes/stories.ts:113`, which throws
  `site_required` with no brand).
- The submit route is `formSubmitRoutes` (`routes/forms.ts:782`), with its ordering
  argued at `:736-776`: id, form (chain-checked on multi-site, `:803-812`), media,
  body cap, closed, honeypot (success-shaped, `:865-874`), `verify` (`:878`), rate
  limit (`:888-905`), `prepareUploads` (`:912`), `validateSubmission` (`:913`), the
  invalid reply, `bodyHash` (`:949`), the file-only duplicate pre-check (`:954-959`),
  R2 put, `insertResponse` (`:969`), compensation, and `submitted` (`:996-1010`,
  awaited through `rt.hookRunner(hookCtx(c), brandIdOf(c))`).
- **The rate limit counts stored rows only.** `recentSubmissionCount`
  (`form-responses.ts:679-690`) is `select count(*) from form_responses where ip_hash
  in (?, ?) and created_at > ?`. A refused submission stores nothing, so today one
  address may post an unlimited number of submissions as long as each is refused.
- `SubmitStatus` is `ok | invalid | closed | rate | verify | error` (`:641`).
  `locationFor` (`:675`) sets `folio_status`, `folio_form` and `folio_invalid` and
  nothing else. `replyTo` (`:695`) answers JSON `{ ok, status, id }` or
  `{ error: { code, message }, status, fields? }`. `successTarget` (`:1052`) sends only
  a success to `redirectTo`.
- `verified` (`:1066-1083`) is decision 11 of forms.md in code: `=== true` passes;
  false, a non-boolean or a throw refuses, with one logged line. It imposes no
  timeout.
- `insertResponse` (`form-responses.ts:1105`) is **one** `insert … select … where not
  exists` statement, sixteen binds, issued with `.run()`; `stored` is `changes > 0`.
  There is no batch. `isDuplicateSubmission` (`:1168`) is the read-only pre-check, run
  today only when files are attached. No statement anywhere in `src/` updates
  `form_responses.data`: answers stay keyed by the question names used at submit.
- `form_responses` has **no foreign keys** and no cascade (`0010_forms.sql:3-6`:
  "the two delete paths that matter here are explicit batches rather than
  cascades"). Responses are deleted in three places: `deleteResponse`
  (`form-responses.ts:1591`, statement at `:1609`), the bulk `deleteResponses`
  (`:1701`, statement at `:1786`, one row per statement), and `deleteForm`
  (`forms.ts:1138`, the batch at `:1160-1164`).
- `FormResponse` (`form-responses.ts:1023`) is the `submitted` payload's response;
  `ResponseValue` (`:327`), `SubmittedFile` (`:1004`), `FormMeta` (`forms.ts:111`) and
  `FolioForms` are **not exported** from `folio/server` (`index.tsx:130-224` exports
  `SubmittedHookPayload` and nothing that names its parts). That is why group-web
  redefines `ResponseValue`.
- `Form` (`forms.ts:62-86`) is the builder's row; `COLS` (`forms.ts:162`) selects
  every column by name. `updateForm` (`forms.ts:913`) recomputes `shapeOf` for both
  sides, bumps `version` on `structural`, and reports `descriptorChanged`
  (`:998-1006`) from a list of keys. Its comment on logic checks states the
  rollback-tolerant posture this spec follows: "a form whose stored logic a rollback
  left dangling can still be renamed". It names its columns in the `update`, so a
  column it does not know is left alone. The PATCH route (`routes/forms.ts:282-325`)
  fires `formChanged` on `structural`, else calls `purgeFormLayout` on
  `descriptorChanged`. It requires `EDIT` (`auth/roles.ts:344`, role `editor`).
- `FormPatchBody` (`validate.ts:1984-2002`) is a `v.object`, which strips unknown
  keys: a new `Form` key not added here is silently dropped before `updateForm` sees
  it (ROADMAP's warning, `ROADMAP.md:859-862`).
- `compileForm` (`forms.ts:555`) is a key-by-key projection; `compileField`
  (`forms.ts:442`) computes the unconditional `required` as `field.required === true &&
  !conditional` (`:454-456`). Translation is `translate` (`forms.ts:405`): the active
  locale, then each fallback, then the source; the first defined candidate wins.
  Forms are compiled during `resolve` at `runtime.ts:1587-1596` inside the brand's own
  runtime, and for the admin preview at `GET {base}/api/forms/resolved`
  (`routes/forms.ts:243`).
- `FORMS` access (`auth/roles.ts:384`) is `publisher` with token scope `forms:read`,
  and its comment is the argument this spec leans on: "An editor who may write a page
  is not thereby somebody who may read the enquiries."
- `hooks.ts:5-9`: "Deliberately not a webhook system — no secret, no retry queue, no
  delivery log." `runOne` (`hooks.ts:392`) swallows a throw. `HookBase` (`hooks.ts:65`)
  carries `env`, `waitUntil`, `actor`, `site`, `brand`, `purge`.
- `folio.runSchedules` is `index.tsx:1896-1897`, wrapping `runSchedules`
  (`scheduler.ts:212`) with `scheduleDeps` (`scheduler.ts:78`), which resolves a
  brand per due row from its scope with `rt.forScope` and memoises per brand. It
  passes `alarmHookCtx` (`runtime.ts:1960-1969`), whose `waitUntil` only attaches a
  `catch` and tracks nothing. `ScheduleRunReport` (`scheduler.ts:138`) is `due,
  published, unpublished, dropped, failed, dryRun, continueFrom, remaining`.
  `MAX_SCHEDULE_ATTEMPTS = 3` (`scheduler.ts:124`). `POST {base}/api/schedules/run` is
  the second door to the same sweep and refuses to read `now` off the body
  (`scripts/scheduled-test.mjs:11-14`).
- `sweepAuth` is deliberately **not** folded into `runSchedules` (`types.ts:1221-1223`),
  and its own comment names the cost: "A host obligation with no signal when it is
  forgotten."

**admin (`src/admin/`):**

- `FormBuilder` (`ui/screens/FormBuilder.tsx:97`) is mounted at `ui/Admin.tsx:1014`
  with `apiBase`, `id`, `me` and `locales` taken off `a.manifest`; it receives no
  other manifest data. Its save (`FormBuilder.tsx:234-248`) sends every editable key,
  `fields` and `layout` included, on every save.
- `removeRefusal` (`ui/screens/form-model.ts:268`) refuses removing a question a rule
  names, and the builder disables the button with that reason; `renameField`
  (`form-model.ts:677`) rewrites every rule that names a renamed question. Those two
  are the precedent this spec's mapping follows.
- `Control` (`ui/screens/fields/Control.tsx:80`) renders a block field by kind. Its
  `textarea`, `select`, `boolean`, `number` and `date` branches and its `text` default
  (`Control.tsx:84-156`, `:285-299`) read only `id`, `field`, `value`, `onChange` and
  `editable`; none reads `env`.
- `canReadResponses` (`admin/me.ts:333`) is the admin's half of `FORMS`.
- Responses: `Responses.tsx`, `responses-model.ts`, `useResponses.ts`. Rows are
  `ResponseRow` (`form-responses.ts:1262`) from `listResponses` (`:1505`), one
  statement plus an optional count. `schedules-model.ts:247` is the "nothing appears
  to be running the sweep" message this spec reuses.

**hosts (`~/work/takeoffgo/group-web`, read only):**

- One `createFolio` for two brands (`app/folio.config.server.ts:100`); the
  `submitted` hook branches on `brand` then on the form's slug (`:163-178`). AAA
  forwards only the `contact` form; TOG forwards every form.
- TOG's production-only rule is decided by **the host that received the submission**,
  not by an environment flag, on purpose: `app/shared/jambo/guard.ts:15-16`, "Decided
  by host, like the Stripe key picker, so there is no env flag to forget." The hook has
  no request, so `formHost` (`folio.config.server.ts:187`) re-derives a host from the
  site's host list, and has to guess which one ("a production host if the site has
  one, else its first").
- `forwardEnquiry` (`app/brands/takeoffgo/lib/enquiry.server.ts:65`) skips Jambo when
  `email`/`first_name`/`last_name` are blank (`:119`) and swallows a Jambo failure
  (`:116`). AAA's `handleEnquiry` sends an email and conditionally a MailerLite
  subscribe on `data.newsletter === true`.
- Each brand keeps its own map of `folio_status` to visitor text
  (`takeoffgo/components/forms/EnquiryForm.tsx:211-239`,
  `allaboutafrica/components/FolioForm.tsx`).
- The cron loops `folio.runSchedules` on `continueFrom` from the `CachedPages`
  entrypoint (`workers/app.ts:349-372`, dispatched at `:467-473`), with a 20-batch
  guard.

**tests:**

- `test/unit/server/forms.test.ts:215` and `:236` pin the exact key sets of the
  descriptor and of a question. `test/workers/migrations.test.ts:1269`
  `describe("forms")` is the per-table exact-equality pattern for columns and
  indexes. `test/workers/form-submit.test.ts`, `form-responses.test.ts`,
  `forms.test.ts`, `schedules.test.ts`, `scope-partition.test.ts` (which fails on any
  mounted id route that is not fence-tested), `test/unit/admin/forms-model.test.ts`,
  and `scripts/forms-test.mjs`, `scripts/scheduled-test.mjs` are where this lands.
  `scripts/e2e-all.sh:30` globs `scripts/*-test.mjs`, so a new script joins the sweep
  by being named `*-test.mjs`.

## Owner decision checkpoints

**All answered by the owner on 2026-11-03.** They are recorded here as decisions; the
architecture below is built on them, and spec 37 records 7 to 10 in the same words.

1. **The visitor-facing message is the editor's, chosen by a declared outcome code.**
   An action never returns free text. The redirect carries
   `folio_status=refused&folio_reason=<action>.<code>`, so it stays cacheable and
   free of personal data. A per-submission value travels only in the JSON reply.
2. **Deliveries are a D1 `form_deliveries` log, retried from the host's existing
   `scheduled()` path through `folio.runSchedules`,** with a status and a Retry button
   in the Responses screen. No Cloudflare Queues.
3. **Two phases.** `check` before storing (fails closed, may refuse with a code);
   `deliver` after storing (never affects the reply). This keeps forms.md checkpoint 4
   ("always store; the hook is the sink") intact for delivery.
4. **Field mapping is part of the registry**: declared inputs mapped onto questions,
   settings built from the block field definitions.
5. **`hooks.submitted` stays** as the escape hatch, and the feature is additive in its
   API: a minor release.
6. **This pass is a spec only.** The build follows approval.
7. **Builder metadata is one signed-in, brand-scoped route, `GET
   {base}/api/forms/registry` (`READ`), answering `{ sources, actions }`. Nothing goes
   on the public Manifest.** Spec 37 introduces the route; this spec adds `actions`.
8. **Roll forward only.** `UPGRADING.md` states plainly that `v1.3.0` cannot be
   rolled back to `v1.2.x`, and lists what breaks. There is no tolerance patch release.
9. **Release:** specs 36 and 37 ship together as `v1.3.0`. Build order is 37, then 36.
   Spec 37 takes `0016_option_sources.sql`, this spec takes `0017_form_actions.sql`,
   and the next free number becomes `0018`.
10. **One merged submit order**, stated identically in both specs: chain check → body
    cap → closed → honeypot → verify → rate limit (counting refused attempts) →
    uploads + option-list load for every sourced question → validateSubmission →
    duplicate check → spec 36 checks → insert (option labels + delivery rows, one
    batch) → spec 36 deliveries + hooks.submitted.

## User stories

### Developer registers an integration once
**As** a host developer **I want to** register "File in Jambo" once, with the inputs
it needs and the settings it takes, **so that** I stop maintaining a slug chain and an
unwritten naming contract for every form an editor builds.

### Editor wires a new form to the CRM
**As** a publisher **I want to** attach "File in Jambo" to a new landing-page form and
pick which question is the email, the first name and the last name **so that** the
leads arrive without a deploy.

### Editor is stopped before breaking an integration
**As** an editor **I want** the builder to refuse deleting the question Jambo reads
its email from, and to say which action needs it, **so that** a tidy-up never silently
breaks lead capture.

### Visitor is told something true
**As** a visitor whose trip code is not one the operator runs **I want to** read "We
do not recognise that trip code" in my own language **so that** I can correct it
rather than submit something nobody can act on.

### Publisher sees and fixes a failed delivery
**As** a publisher **I want to** see that three enquiries did not reach HubSpot,
see why in terms I can act on, fix the list id in the action's settings and press
Retry **so that** a vendor outage or a wrong setting costs nothing but a click.

### Staging does not file real leads
**As** a host developer **I want** my action to see which host received the
submission, including on a retry hours later from a cron, **so that** a test on
staging never files a real enquiry.

## Architecture decisions

### 1. Actions are registered per brand, under `forms.actions`

```ts
forms: {
  verify: verifyTurnstile,
  actions: [jamboEnquiry, hubspotContact],
}
```

`FolioForms<Env>` gains `actions?: readonly FormAction<Env>[]`. Because `FolioForms` is
both `FolioSingleConfig.forms` and `FolioBrand.forms`, a single-brand deployment gets
the key in the same place and a branded one gets it per brand, with no second type.
Action ids are unique **within a brand**; two brands may each register `email-ops`,
and a form only ever looks its attachments up in its own brand's registry (a form's
chain lies inside one brand, CLAUDE.md "A chain never crosses a brand").

An array rather than a record keyed by id, matching `blocks`: each definition is
self-contained (its id is inside it, so it can live in its own module and be imported),
and the array's order is the builder's picker order.

**Rejected: a top-level `actions` beside `hooks`.** `hooks` are deployment-wide
(`multi-brand.md` keeps them at the top), but forms policy was made per brand by that
same spec (`docs/configuration.md:408`). A top-level registry would offer Take Off Go's
Jambo action on All About Africa's forms and would need a brand filter added to fix
it. **Rejected: growing `hooks.submitted` with a routing table.** The slug chain *is* a
routing table; moving it into config does not let an editor change it.

### 2. Two phases, `check` and `deliver`, with opposite failure postures

| | `check` | `deliver` |
| --- | --- | --- |
| Runs | Synchronously, after validation and the duplicate check, before the response is stored | After the response row has committed |
| May refuse the visitor | Yes, with a declared code | Never |
| May have side effects | **No** (decision 24) | Yes: that is its job |
| On a throw, a timeout, or a malformed answer | **Refuses** with `<action>.error` (fails closed) | Retries with backoff, up to the cap |
| Sees | The mapped inputs, settings, the raw body, the request | The mapped inputs, settings, the stored response, its files, an idempotency key |

`check` is `verify` generalised: per form rather than per brand, fed the mapped inputs
rather than just the raw body, and able to say *why*. It keeps `verify`'s posture for
`verify`'s reason (forms.md decision 11): a gate that opens on error is decorative.
`deliver` keeps the hook's posture for the hook's reason: the row is committed, and a
Jambo outage must not become the visitor's problem.

`verify` is not removed or deprecated. It receives the raw body *before* the rate
limit, which is where a captcha belongs, and runs for every form of the brand with no
editor involvement. A check runs after validation and the rate limit, because it costs
a host call and the cheaper controls should spend first.

**Rejected: one phase that can answer the visitor.** Every third-party outage would be
a refused submission, and forms.md checkpoint 4 was decided against exactly that
("a per-form 'forward only' that would have made a hook throw into a 502").

### 3. A refusal is a declared code; the editor writes its text

An action declares its codes:

```ts
codes: {
  unknown_trip: { label: 'Unknown trip code', message: 'We do not recognise that trip code.' },
}
```

`label` is what the editor reads in the builder; `message` is the source-locale
default, shown as the placeholder. The editor may write a message per code and per
locale on the attachment. One code is **reserved and implicit on every action that has
a `check`: `error`**, the fail-closed refusal (a throw, a timeout, a malformed answer,
an undeclared code, or an incomplete attachment, decision 13). Folio's default text for
it is "We could not process that submission. Please try again later." A declared code
named `error` is refused at construction.

What travels where:

- **Native POST:** `303` to the page, with `folio_status=refused`,
  `folio_form=<slug>` and `folio_reason=<action>.<code>`. Both halves of the reason
  are identifiers from code, so the URL names nothing personal and a refused page is
  as cacheable as `?folio_status=ok` (forms.md decision 6 holds unchanged).
- **The descriptor** gains `refusals?: Readonly<Record<string, string>>`, keyed by
  `<action>.<code>`, compiled in the render's locale through `translate`'s chain
  (editor's text in the active locale, then each fallback, then the editor's source
  text, then the code's declared `message`). A host renders the text by lookup, never
  by echoing the parameter, which is attacker-controlled:

  ```ts
  const reason = params.get('folio_reason') ?? ''
  const text = form.refusals?.[reason]
    ?? form.refusals?.[`${reason.split('.')[0]}.error`]
    ?? 'We could not accept that submission.'
  ```

  The second fallback covers a page cached before a deploy that added a code: the
  stale descriptor has no key for the new code but has the action's `error` text.
  The key is absent when the form has no checking action, so every existing
  descriptor is byte-identical.
- **JSON:** the message is resolved in the submission's locale (`_folio_locale`, run
  through `rt.localeOf` exactly as the stored locale is) and returned in
  `error.message`, with `reason` beside it (decision 17).

A deploy that changes a code's declared `message` reaches cached pages when they are
next purged or expire; it purges nothing itself, because no form was saved
(decision 18). A developer who needs the new text live sooner republishes, or an
editor saves the form.

**Rejected: an action returning its own text.** It would put developer English in
front of a French visitor, put dynamic text in a URL or force the refusal out of the
native transport, and leave the editor no way to fix a clumsy sentence. Owner
decision 1.

### 4. Action metadata is on the signed-in registry route, never on the Manifest

Owner decision 7: the builder reads everything it needs about the brand's registries
from one route, `GET {base}/api/forms/registry`, at `READ` on the request's scope,
answering `{ sources, actions }` for the scope's brand. Spec 37 introduces the route
and `sources`; this spec adds `actions: FormActionInfo[]` (ids, labels, descriptions,
inputs, settings definitions with their defaults, codes, and two booleans, `check` and
`deliver`). It is never functions and never settings *values*. On a branded deployment
with no scope it answers `400 site_required`, which is `brandOf`'s answer; a brand that
registers no actions answers `actions: []`.

This follows `server/app.ts:130-148`'s rule for the ungated Manifest, and the reason
is narrower than "it names vendors". A checking action's id and codes are already
public: they are the keys of every page's `refusals` and the value of every refused
redirect's `folio_reason`. What is not public, and should not become so through an
unauthenticated `curl`, is the rest: each action's **inputs** (which answers are sent
where), its **settings definitions and defaults** (list ids, pipelines, recipients),
and the existence of **deliver-only actions**, which appear in no page at all. No client
needs any of it before signing in; only the builder, behind `EDIT`, reads it.

The `FormActionInfo` type lives in `folio/core` (`core/form-actions.ts`) so the admin
and the server share one definition, the way `Manifest` does. **Rejected: the
Manifest**, for the reason above. **Rejected: a route per registry**
(`/forms/actions`, `/forms/sources`): the builder needs both on the same screen, and
two routes is two requests and two loading states for one panel. **Rejected: `/me`.**
`/me` is about who is asking; this is about the code, per brand, and `/me` is not
brand-scoped.

### 5. An action declares inputs; the editor maps each onto a question

```ts
inputs: {
  email:     { kind: 'email', label: 'Email', required: true },
  firstName: { kind: 'text',  label: 'First name', required: true },
  lastName:  { kind: 'text',  label: 'Last name', required: true },
  area:      { kind: 'text',  label: 'Area' },
  subscribe: { kind: 'boolean', label: 'Newsletter opt-in' },
},
```

An input's `kind` is the **value type the action receives**, and it decides which
questions may feed it:

| Input `kind` | Action receives | Questions it accepts |
| --- | --- | --- |
| `text` | `string` | `text`, `textarea`, `email`, `tel`, `url`, `date`, `select`, `radio`, `hidden` |
| `email` | `string`, already validated as an email by the server | `email` |
| `number` | `number` | `number` |
| `boolean` | `boolean` | `checkbox` |
| `list` | `readonly string[]` | `checkboxes` |
| `file` | `SubmittedFile` | `file` |

`statement` feeds nothing. Input names follow the question-name charset but may be
camel case (`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`), because they are the host's TypeScript
property names, not HTML names.

**A required input must be mapped to a question that is always answered**: asked
unconditionally (no `showIf` on it or its section) and either stored `required`, or a
`checkbox`/`checkboxes` (which store `false`/`[]` when untouched, `validateAnswer`'s
existing rule). That is `compileField`'s `always` (`forms.ts:454-456`) widened by the
two tick-box kinds. With it, **a required input is never absent at submit time**: a
check never sees one missing, and the mapping snapshotted for delivery (decision 11)
always resolves against the response it was taken with. The guarantee is about submit
time only. A delivery retried later reads the inputs through that snapshot, not the
form's current mapping, and re-checks presence before calling the action (decision 11
says what happens when it cannot).

An optional input may map to any compatible question, or to none, and arrives as
`undefined` when unmapped, unanswered or not asked.

The same pure function, `attachmentProblems(attachment, info, fields, layout)` in
`core/form-actions.ts`, answers the set of problems with an attachment for the
builder and for the server, the way `checkFormLogic` is shared:

- A required input unmapped, mapped to a missing question, to an incompatible kind, or
  to a question that is not always answered; a required setting unset; a setting value
  its definition refuses.
- In the builder, **removing a mapped question is refused** with the action named
  ("File in Jambo reads its email from this question. Change the mapping first."),
  extending `removeRefusal` (`form-model.ts:268`); **renaming one rewrites the
  mapping**, extending `renameField` (`form-model.ts:677`); retyping one to an
  incompatible kind, or making a required-input question optional or conditional, is
  refused with the same message shape.

Decision 13 says which of those problems block a save.

**Rejected: the slug convention, documented.** It is group-web's status quo, and its
failure mode is a lead with blank names that nobody notices. **Rejected: letting a
required input map to any question and skipping the action at runtime when it is
blank.** That is group-web's `incomplete_not_forwarded` warning
(`enquiry.server.ts:119`) moved into Folio: the editor learns about it from nobody.

### 6. Settings are block field definitions, restricted to six scalar kinds

```ts
settings: {
  pipeline: { kind: 'select', label: 'Pipeline', options: [{ label: 'Sales', value: 'sales' }], required: true },
  listId:   { kind: 'text', label: 'List id', help: 'From MailerLite > Groups' },
},
```

`ActionSettingDef` is `Field` narrowed to `text | textarea | number | boolean | date |
select`. The builder renders each with `Control` (`fields/Control.tsx:80`), whose
branches for those kinds read nothing but the field and the value, so no new input is
written. `label`, `help`, `required`, `group` and `showIf` mean what they mean on a
block (`showIf` is evaluated against the attachment's own settings, as the inspector
evaluates it against a blok's own data). `translatable`, `indexed`, `searchable` and
`unique` are refused at construction: none of them means anything for a setting.

**`default` also means what it means on a block** (`fields.ts:31-37`): it is written
into the attachment when the action is attached, and never consulted afterwards. The
builder fills each declared default into a new attachment, and the server fills any
the PATCH left out of an attachment that this save adds. A developer who changes a
`pipeline` default from `sales` to `support` changes what the next attachment starts
with, not where an existing form's leads (or a retry of an old one) go. A setting added
to an action by a later release is absent from existing attachments: `undefined` if
optional, and an attachment problem if `required` (decision 13).

Settings values are validated on save against the definitions (a `select` value must
be one of its options, a `number` within `min`/`max`, a `date` in the field's exact
form, a `required` setting non-empty), undeclared keys are dropped on a save that
changes the attachment (decision 8 says how an unchanged one is compared), and the
action receives `SettingsOf<S>`: `ValueOf` per field, `undefined` where unset.

**Settings are not secrets and must never hold one.** They are stored in
`forms.actions` in plain JSON and are readable by anyone with `READ` on the form. A key
belongs in `env`, which every phase receives.

**Rejected: a settings vocabulary of its own.** It would need its own renderer, its
own validation and its own docs, and it would drift from the block fields that
editors already know. **Rejected: every `Field` kind.** `multilink`, `asset`,
`reference`, `collection`, `richtext` and `form` are resolved through render passes
(chain, locale, story rows) that a cron delivery does not run. **Rejected: applying the
current default at every attempt.** It would silently re-route existing forms on a
code change, and it would contradict the meaning `default` already has everywhere else
in Folio.

### 7. A form's attachments are one JSON column, one attachment per action

```ts
interface FormActionAttachment {
  action: string;                                    // a registered id
  map?: Record<string, string>;                      // input name -> question name
  settings?: Record<string, string | number | boolean>;
  messages?: Record<string, string>;                 // code -> source-locale text
  i18n?: Record<string, { messages?: Record<string, string> }>;
  /** Written by the server on every save from the registry; never trusted from the
   *  client. Whether the action delivers, so an attachment whose action is later
   *  unregistered still knows whether a submission owes a delivery (decision 13). */
  delivers?: true;
}
```

`forms.actions` is a `text not null default '[]'` column holding
`FormActionAttachment[]`, at most `MAX_FORM_ACTIONS = 8`, **in run order**: checks
run in this order and stop at the first refusal, and deliveries are created in it.
Screened on read by `readFormActions`, `readFormLayout`'s posture: a column that
cannot be parsed answers `[]` with one logged line, rather than taking out the form
list.

**An action may be attached to a form at most once.** The reason parameter is
`<action>.<code>`, owner decision 1; two attachments of one action would make it
ambiguous which attachment's text a page should show. An action that genuinely needs
two destinations takes a list-shaped setting (a `textarea` of recipients).

**Rejected: a `form_actions` table.** Forms.md decision 2 rejected a `form_fields`
table for the reasons that apply again here: no query needs a row per attachment, and
every builder save would become a diff. **Rejected: storing the action's metadata on
the attachment.** The registry is code; storing a copy would make a developer's
fixed label or added code invisible to every existing form. `delivers` is the one fact
copied, because it is the one Folio needs after the code that declared it is gone.

### 8. Configuring actions needs `FORMS`, not `EDIT`, and "changed" is compared after normalising

Attaching an action decides **where strangers' answers go**. An editor who may build a
form is, by `FORMS`'s own comment (`auth/roles.ts:375-383`), not thereby somebody who
may read the enquiries, and an editor who could attach "Email responses to" with a
`to` setting of their own address would read them by another route. So:

- A PATCH whose `actions` differ from the stored value requires `FORMS` **in
  addition to** `EDIT`, else `403 forbidden`, "Changing where responses go needs
  publisher access", and nothing is saved.
- **"Differ" is decided on normalised values, both sides.** The stored attachments and
  the incoming ones are each normalised with the current registry (undeclared setting
  keys and messages for undeclared codes dropped, `delivers` recomputed, key order
  canonical), and the two normalised arrays are compared. When they are equal, the
  **stored** value is written back unchanged, so a deploy that removed a setting does
  not turn an editor's label edit into a 403, and does not silently rewrite the
  publisher's configuration either. When they differ, the normalised incoming value
  is stored. Comparing raw values was rejected both ways: raw-incoming against
  normalised-stored misreads an unchanged save as a change, and raw against raw lets a
  genuine edit that happens to normalise away compare as unchanged.
- The guard is decided inside `updateForm`, before the `update` is issued, so it is not
  a read in front of a write: `updateForm` takes `mayConfigureActions: boolean` and
  throws `forbidden` itself.
- `GET {base}/api/forms/:id` keeps answering `actions` at `READ`: settings are not
  secrets (decision 6), and an editor needs to see why a question is locked.
- Below `FORMS` the builder renders the Actions panel read-only with "Only a publisher
  can change where responses go" (`canReadResponses`, `admin/me.ts:333`), and a
  question an action reads cannot be renamed by an editor (the mapping rewrite would
  change `actions`); the name input is disabled with the action named.
- Retry (decision 15) is `FORMS`: the person who can read the response is the person
  who can resend it to where it was already configured to go.

**Rejected: `EDIT` throughout.** It is the builder's existing level and it makes an
editor a reader of every response. **Rejected: `SCOPE_ADMIN`.** Attaching an action
reads no more than `FORMS` already reads, and putting it a rung higher would leave the
publishers who triage enquiries unable to wire a form to the CRM they triage in.

### 9. Delivery rows are written in the same transaction as the response

When the form has at least one attachment with `delivers`, `insertResponse` becomes a
`db.batch`: the existing single-statement insert (with spec 37's `option_labels`), then
one statement per delivering attachment:

```sql
insert into form_deliveries
  (response_id, action, form_id, status, attempts, next_at, host, inputs_map, failure, created_at, updated_at)
select ?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9, ?9
where exists (select 1 from form_responses where id = ?1);
```

A D1 batch is one transaction, so **a stored response and its delivery rows commit
together or not at all**, and a collapsed duplicate (the response's `not exists`
fired) creates no delivery rows because its id was never inserted. `stored` stays
`changes > 0` on the first statement. The batch's binds are fixed per statement, and
the statement count is bounded by `MAX_FORM_ACTIONS`. **A form with no delivering
attachment keeps today's single `.run()`**, so it issues exactly the statements it
issued at v1.2.4.

`status` is normally `pending` with `next_at = now` and `inputs_map` the attachment's
mapping as it stood at submit (decision 11). It is `failed`, with `next_at` null, a
`failure` category and a null `inputs_map`, when the attachment cannot be delivered
as configured (`not_registered` or `incomplete`, decision 13): the row exists so the
failure is visible in Responses and a Retry can revive it after the fix.

**Rejected: inserting the delivery rows from `waitUntil` after the response.** An
isolate that is evicted between the response insert and the delivery insert loses the
delivery with no trace, which is the failure this whole decision exists to close.
**Rejected: Cloudflare Queues** (owner decision 2): a second binding every host must
configure, for a volume measured in enquiries per hour.

### 10. Delivery is at-least-once, fenced by a claim token, with an idempotency key

After the batch commits, the route hands the new `pending` rows to one
`waitUntil(attemptDeliveries(…))`, which attempts them **concurrently** (they are
independent rows), so the first attempts normally finish within a second of the
submission and all of them fit inside `waitUntil`'s budget even at the 20-second
deadline. The visitor never waits for them. Every attempt, whether from that
`waitUntil`, the cron or a Retry, **claims** its row first with a fresh random token:

```sql
update form_deliveries
   set attempts = attempts + 1, next_at = ?now + 120000, claim = ?token, updated_at = ?now
 where response_id = ? and action = ? and status = 'pending' and next_at <= ?now;
```

`changes = 1` is the claim; `0` means another runner has it or it is not due, and the
attempt is skipped. The claim moves `next_at` forward by `DELIVERY_LEASE_MS` (two
minutes), so a runner that dies mid-attempt leaves a row the next sweep picks up once
the lease lapses. The attempt counter moves at claim time, so a killed attempt still
counts against the cap.

**Every result write is fenced by the token:** `… where response_id = ? and action = ?
and claim = ?token`. A runner whose lease lapsed and whose row has since been claimed
by someone else (the cron, or a Retry) writes nothing, so a late timeout can never
put a `delivered` row back to `pending`, and a late success can never overwrite a
newer attempt's answer. The give-up test is `attempts >= MAX_DELIVERY_ATTEMPTS`, made
on the claimed count, and the backoff is read at index `attempts - 1` of a table with
exactly `MAX_DELIVERY_ATTEMPTS - 1` entries, so it is never indexed past its end.

This is **at-least-once**: an attempt that reached the third party and died before
recording success is attempted again. So every `deliver` receives
`key: '<responseId>:<actionId>'`, stable across every attempt and every Retry, for the
action to pass to an API that accepts an idempotency key (or to use as a dedupe
external id where it does not).

**Rejected: exactly-once.** It needs the third party's cooperation, which is the
idempotency key; Folio's half of it is that the key is stable. **Rejected: using
`attempts` as the fence.** Retry resets it (decision 15), so a stale runner's count can
equal a fresh claim's; a random token cannot collide that way.

### 11. The inputs are read through the mapping snapshotted at submit; settings are re-read

A `deliver` receives a context built **at attempt time**, from:

- **the response row**, which is immutable (no statement updates
  `form_responses.data`, and editing a response is out of scope in forms.md); a deleted
  response stops its deliveries (decision 20);
- **`form_deliveries.inputs_map`**, the attachment's input-to-question mapping as it
  stood when the response was submitted. The response's answers are keyed by the
  question names of that moment, so this is the only mapping guaranteed to find them:
  a question renamed after the submit, with the mapping rewritten to follow it, would
  look up `work_email` in a response that holds `email`. The snapshot is question
  *names*, not answers, so it duplicates no personal data;
- **the form's current attachment**, for its **settings** and for whether it still
  exists, so that Retry means "I fixed the setting, send it again". A list id corrected
  after three failures is the one the fourth attempt uses. An attachment that has since
  been removed from the form ends the delivery as `cancelled`;
- the current questions' source-locale labels, for `questions`.

**Before calling the action, Folio resolves every required input through the mapping
in use and checks it is present and of the input's value type.** The snapshot makes
that hold for every row created `pending`. It can fail in one case: a row created
`failed` because its attachment was incomplete at submit has no snapshot, and a Retry
after the publisher fixes the mapping uses the current mapping, which may name a
question the old response never had. Then the attempt does not call the action: the row
is `failed` with category `predates_mapping` ("This response was submitted before the
current mapping; it has no answer for 'Email'"), and Retry is refused for it from then
on with that message. When the current mapping does resolve, it is written to
`inputs_map` with the attempt, so later retries read the same one.

**Rejected: re-reading the current mapping at every attempt.** It breaks on the first
rename after a failed delivery and turns a required `string` into `undefined` inside an
action typed to receive a string. **Rejected: snapshotting the whole payload.** It
copies a stranger's answers into a second table that every delete path must also
chase, and it makes Retry resend the broken setting it was pressed to get past.

### 12. Retries ride `folio.runSchedules`, after the schedule sweep finishes, on a time budget

`folio.runSchedules(env, opts)` (`index.tsx:1896`) runs the schedule sweep exactly as
today and then, **only on a call whose own report comes back with `continueFrom:
null`**, runs one delivery pass and attaches its report as `report.deliveries`. A
host looping on `continueFrom` (the documented loop, `types.ts:1183-1190`, and
group-web's at `workers/app.ts:349`) therefore runs deliveries once per tick, **after**
every due schedule has been published, and needs no code change at all. On a tick with
nothing scheduled, the first call is that call. A tick whose schedule backlog outlasts
the host's batch guard runs no deliveries; they run on the next tick that clears it,
because a late page is the worse failure.

The pass is bounded twice: at most `DEFAULT_DELIVERY_BATCH = 25` rows, and a wall-clock
budget of `DELIVERY_BUDGET_MS = 30_000` after which it claims nothing more. Rows are
taken oldest `next_at` first from the partial index `form_deliveries_due` and attempted
sequentially, each with its brand resolved from the response's own `site_id` through
`rt.forScope`, memoised per brand per pass: `scheduleDeps`'s pattern
(`scheduler.ts:78`), and the cron is the sanctioned exception to "a chain needs a
request scope". **An action whose attempt timed out is not attempted again in the same
pass**, so one brand's hung vendor costs at most one deadline per tick and cannot
starve another brand's deliveries behind it. A row whose scope no configured brand
serves fails with category `no_brand` rather than running under a guess (CLAUDE.md "A
null brand serves nothing").

The same pass deletes `form_refusals` rows older than two rate windows (decision 23),
one statement.

Backoff after a retryable failure, by attempt number:

| Failed attempt | Next attempt after |
| --- | --- |
| 1 (the immediate one) | 1 minute |
| 2 | 5 minutes |
| 3 | 15 minutes |
| 4 | 1 hour |
| 5 | 3 hours |
| 6 | 6 hours |
| 7 | 12 hours |
| 8 | **gives up**: `status = 'failed'`, category `gave_up` |

`MAX_DELIVERY_ATTEMPTS = 8` spans about twenty-two hours from the submission, long
enough to outlast a vendor's bad day and short enough that the Responses screen
reports a give-up while the enquiry is still worth chasing. Each step is late by at
most one cron period plus however long the schedule sweep took. `opts.now` drives the
backoff clock too, which is how a workers test walks the whole table without waiting.
`dryRun` reports how many deliveries are due and attempts none.

**`POST {base}/api/schedules/run` does not run deliveries.** It is the manual door to
publishing, scoped per brand, and refuses `now`; the manual door to a delivery is
Retry. A backlog after a long outage drains at up to 25 per tick.

**Rejected: a separate `folio.runDeliveries(env)`.** It is `sweepAuth`'s shape, and
`sweepAuth`'s comment names what is wrong with it: "a host obligation with no signal
when it is forgotten". **Rejected: running deliveries on the first call of the tick.**
Twenty-five sequential deliveries against a hung vendor would hold every scheduled
publish behind them for minutes. **Rejected: round-robin by brand.** The per-action
timeout skip removes the starvation it was for, without a second ordering to explain.

### 13. When code and stored attachments disagree, nothing locks a form

The registry is code and attachments are rows, so a deploy can make them disagree in
two ways, and they get different answers on purpose:

- **The action is no longer registered** (the developer removed it). Folio cannot run
  what the code no longer declares, and the developer removed the rule deliberately,
  so: a `check` is **not run**, with one `warn` line per submission; a submission to an
  attachment stored with `delivers: true` gets a `failed` delivery row with category
  `not_registered`, so the gap is visible in Responses and a redeploy that restores it
  can be followed by a Retry; an attachment without `delivers` gets no row at all (a
  removed check-only action owes nothing). The descriptor emits no refusal texts for
  it. The builder shows the attachment as "No longer provided by this site's code" with
  Remove, and a PATCH may carry it through only unchanged (decision 8's comparison).
- **The action is registered but the attachment no longer satisfies it** (a release
  added a required input or a required setting, or removed a select option the
  attachment uses). The rule is in the code and Folio cannot feed it, so a `check`
  **fails closed** as `<action>.error`, the same as a throw, and a delivering
  attachment gets a `failed` row with category `incomplete`.

The line between them: Folio runs every rule the code declares and refuses when it
cannot; it cannot run a rule the code no longer declares. Configuration drift is not
attacker-reachable, so this does not weaken decision 2's fail-closed posture, which is
about a check's *runtime* failure.

**A save is refused only when it makes an attachment worse.** `updateForm` computes
`attachmentProblems` for every attachment against the stored form and against the
form as it would be saved, and refuses the save (`400`, naming the attachment and the
problem) only when the saved form has a problem the stored one did not. A save that
leaves an already-incomplete attachment as it was goes through: an editor can still
fix a typo, rename the form or **close it**, which is what they most need when a
checking form has started refusing every visitor. A publisher's partial fix (one of
two missing inputs mapped) goes through too, because it removes a problem and adds
none. This is spec 35's posture for dangling logic (`updateForm`'s "can still be
renamed" comment), applied to attachments.

Because an incomplete checking attachment refuses every visitor, **it is announced
outside the builder**: the form list marks the form "Needs attention" (`FormSummary`
gains `attention: boolean`, computed in the list route against the brand's registry),
and the Responses screen for that form carries a banner naming the action and the
problem, linking to the builder.

**Rejected: refusing every save while any attachment has a problem.** The builder
sends `fields` and `layout` on every save (`FormBuilder.tsx:234-248`), so a release
that added a required input would leave every editor of the form unable to save
anything, including closing it, while the form refused its visitors, and only a
publisher could clear it.

### 14. The production-only rule is a delivery outcome the action decides from `host`

Both phases receive `host`: **the hostname of the request that submitted the form**,
read off the request URL at the submit route. On a multi-site deployment the route
only accepts a site's live host (`routes/forms.ts:803-812`), so it is always one of
that site's hosts. It is stored on the delivery row (`form_deliveries.host`), so a
retry from the cron or from the admin origin hours later sees the host that received
the submission, not the one running the retry.

An action that must not act off production says so as a result:

```ts
deliver(ctx, env: Env) {
  if (!isLiveHost(ctx.host)) return { skipped: 'Not a production host' }
  …
}
```

and the Responses screen shows "Skipped: Not a production host" against that response,
where today the only trace is a log line (`enquiry.server.ts:84-91`).

Both phases also receive `site` (the submitting site id, `default` without `sites`)
and `brand` (or null), the facts `HookBase` already carries.

**Rejected: an environment flag.** group-web's guard rejects it in so many words
(`guard.ts:15-16`), and on a deployment where staging and production share one
third-party account the flag is the thing somebody forgets. **Rejected: passing the
site's host list.** It cannot say which host received the submission, which is the
question; `formHost` (`folio.config.server.ts:187`) has to guess for exactly this
reason. An action that wants the list reads it with `folio.reader(env, { site })`.

### 15. A delivery has five outcomes; editors see categories and the action's own words, never a thrown message

`deliver` returns one of:

| Returned | Status | `failure` | `detail` | Retried |
| --- | --- | --- | --- | --- |
| nothing, or `{ reference?: string }` | `delivered` | null | null (`reference` stored) | no |
| `{ skipped: string }` | `skipped` | null | the action's text | no |
| `{ failed: string }` | `failed` (permanent: the third party refused the data) | `refused` | the action's text | no |
| a throw | `pending` with backoff, then `failed` at the cap | `threw` | null | yes |
| no answer within `DELIVER_TIMEOUT_MS` | as a throw | `timeout` | null | yes |
| an answer of any other shape | as a throw | `malformed` | null | yes |
| (the attachment was removed from the form) | `cancelled` | null | null | no |

Folio's own categories complete the set: `not_registered`, `incomplete`,
`predates_mapping`, `no_brand` (decisions 11 to 13) and `gave_up` (the cap). The
admin phrases each category in `responses-model.ts` ("The action threw an error.
Details are in the Worker's logs.").

**`detail` holds only text an action deliberately returned for display**: the string
in `{ skipped }` or `{ failed }`, bounded to 500 characters. **A thrown value is never
stored or shown.** It goes to `rt.logger.error` with the response id, the action and
the attempt number, so the host's log has it and the screen does not. A `fetch` error
can quote the URL it called, and a vendor URL often carries its key in the query
string; decision 6 already put keys in `env` and off the editor's screen, and storing
thrown text would be a route around that. This is spec 37 decision 16's rule, applied
to a second table.

**Retry** (`POST …/deliveries/:action/retry`, `FORMS`) is offered for `failed`,
`skipped`, and `pending` rows whose lease is not held. It resets the row with one
conditional statement:

```sql
update form_deliveries
   set attempts = 0, status = 'pending', next_at = ?now, failure = null, detail = null, updated_at = ?now
 where response_id = ? and action = ?
   and status in ('pending', 'failed', 'skipped') and not (status = 'pending' and next_at > ?now)
   and not (failure = 'predates_mapping');
```

`changes = 0` answers `409 conflict` with the reason read back: "An attempt is in
progress" for a held lease, "Already delivered" for `delivered` (resending a lead the
third party already holds is a duplicate, not a fix), the `predates_mapping` message,
or "The action is no longer attached" / "no longer registered". Otherwise Retry claims
the row (decision 10) and runs one attempt **inline**, within the admin request, and
answers the row as it now stands. A Retry that fails resumes the automatic schedule
from its first step.

**Rejected: a fire-and-forget Retry.** The person pressing it is looking at the row
and wants to know whether it worked; the attempt is bounded by the same timeout as
any other. **Rejected: an unconditional reset.** It would let a Retry start a second
attempt while a cron attempt still held the lease, which is two sends at once.

### 16. Every host call has a deadline

`check` is given `CHECK_TIMEOUT_MS = 10_000` and `deliver` `DELIVER_TIMEOUT_MS =
20_000`, as an `AbortSignal` on the context (`ctx.signal`, for the action to pass to
`fetch`) and as a race Folio enforces. A check past its deadline refuses as
`<action>.error`; a delivery past its deadline is a retryable failure (`timeout`). A
promise that settles after its deadline has its answer ignored, and its claim token is
stale by then if anyone has re-claimed the row (decision 10); the idempotency key
covers the attempt it might have completed.

**Rejected: `verify`'s no-timeout posture.** `verify` runs once per request with the
visitor's own request deadline bounding it. A check can be one of eight in sequence,
and a sweep attempts many deliveries in a row; one hung vendor would starve every other
row in the batch and every other check on the form.

### 17. The submit route: one merged order, one new status

Owner decision 10 fixes the order both specs implement:

1. **Chain check**: the id, then the form, chain-checked on multi-site.
2. **Body cap** (`capFor`, with spec 37's budget for sourced questions).
3. **Closed.**
4. **Honeypot**, success-shaped.
5. **`verify`.**
6. **Rate limit, counting refused attempts** (decision 23).
7. **Uploads**, and **the option-list load for every sourced question** (spec 37).
8. **`validateSubmission`.** A refusal here is recorded for the rate limit.
9. **Duplicate check.** The `isDuplicateSubmission` read is issued when files are
   attached (today's reason: it saves the megabytes) **or a check is attached** (this
   spec's reason: a check like "is this trip code already booked" would otherwise
   refuse the second click of a double-click whose first click it had just let
   through, and the browser shows the second answer); a duplicate answers `ok`, as
   today. With neither, the insert's own `not exists` is the duplicate check, as today.
10. **Spec 36 checks**, in attachment order, stopping at the first refusal. A refusal
    is recorded for the rate limit.
11. **Insert**: the R2 put, then one batch holding the response row (with spec 37's
    option labels) and this spec's delivery rows (decision 9); a single `.run()` when
    there are no delivery rows.
12. **Spec 36 deliveries and `hooks.submitted`**: the delivery `waitUntil` is
    registered first, so an awaited host hook never delays the first attempt; then the
    hook, as today.

`SubmitStatus` gains `refused`. Its replies:

```jsonc
// 422, JSON
{ "error": { "code": "refused", "message": "We do not recognise that trip code." },
  "status": "refused", "reason": "trip-code.unknown_trip" }
```

```
303 Location: /contact?folio_status=refused&folio_form=contact&folio_reason=trip-code.unknown_trip
```

`422` rather than `409` or `403`: the request was well formed and understood, and the
server declines to act on it; `status` and `reason` are the contract, as they are for
every other refusal. A success's JSON gains `actions` **only when a check passed with
reply values**:

```jsonc
{ "ok": true, "status": "ok", "id": "res_0a1b2c3d4e5f", "actions": { "trip-code": { "tripName": "Serengeti, July 2027" } } }
```

Reply values are what a check returns beside `ok: true`: at most 8 keys matching
`^[a-z][a-zA-Z0-9_]{0,31}$`, each a string of at most 200 characters or a finite
number. Anything else is dropped with one `warn` line rather than refusing a check that
passed. They are **not stored** and never reach a URL (owner decision 1); a native POST
cannot see them, which is the price of the redirect staying cacheable. A collapsed
duplicate or a caught honeypot answers `ok` with no `actions`.

### 18. An actions change is not a shape change

`shapeOf` and `version` do not see `actions`. `version` exists so a stored response
can be read against the shape that validated it (forms.md decision 7), and attaching
an action changes nothing about what a stored response's columns mean. `formChanged`
keeps its meaning, a structural save (spec 35 decision 11).

The descriptor does change when a check's messages do, so `updateForm` reports
`descriptorChanged` when **the compiled `refusals` differ** (computed for both sides
with the brand's registry, in the source locale and every configured locale), and the
PATCH route purges `form:<id>` through `purgeFormLayout` as it already does for a
label edit. A mapping-only or settings-only change purges nothing, because no page
renders either. A code deploy that changes a declared code or message purges nothing
either; decision 3's host fallback is what keeps a stale page from rendering nothing.

**Rejected: bumping `version` on any actions change.** The Responses screen would show
a version boundary where no column moved, and hosts listening for `formChanged`
would hear about saves that changed nothing they render or enforce. **Rejected:
purging every form of a brand at startup when its registry's codes change.** Folio has
no startup hook that runs once per deploy, and a purge per isolate start would be a
purge storm.

### 19. The payload types are exported, and labels travel with the answers

`folio/server` exports, as types: `FormAction`, `ActionInputDef`, `ActionInputKind`,
`ActionSettingDef`, `ActionCodeDef`, `CheckContext`, `CheckResult`, `DeliverContext`,
`DeliverResult`, `ActionQuestion`, `DeliveryStatus`, `DeliveryFailureCategory`,
`DeliveryRow`, `DeliveryRunReport`, `DeliveryFailure`, and the four that group-web had
to redefine or could not name: `ResponseValue`, `FormResponse`, `FormMeta`,
`SubmittedFile`, plus `FolioForms`. And one value: `formAction`, an identity function
whose only job is inference.

```ts
export const jamboEnquiry = formAction({
  id: 'jambo-enquiry',
  label: 'File in Jambo',
  inputs: { email: { kind: 'email', label: 'Email', required: true }, … },
  settings: { area: { kind: 'text', label: 'Area', help: 'Defaults to the form slug' } },
  async deliver(ctx, env: Env) {
    ctx.inputs.email       // string
    ctx.inputs.area        // string | undefined
    ctx.settings.area      // string | undefined
    …
  },
})
```

`Env` is inferred from the annotation on the method's `env` parameter, and `inputs`,
`settings` and `codes` from `const` type parameters, so a host writes no type
arguments and casts no `env`. `check` and `deliver` are declared as **methods**, for
`FolioForms.verify`'s stated reason (`form-responses.ts:2252-2256`): only method
parameters are bivariant under `strictFunctionTypes`, which is what lets a
`FormAction<Env, {email: …}>` sit in a `readonly FormAction<Env>[]`.

Every context carries `questions: readonly ActionQuestion[]`, the form's questions in
order with their source-locale `label`, `kind` and, for option kinds, a value-to-label
map. That ends group-web's slug-to-label derivation (`allaboutafrica/folio/
enquiry.server.ts:16-21`): an email action lists every answer under its real label
without mapping anything.

**`DeliverContext` has no `waitUntil`.** A delivery's work is its awaited promise,
which is what Folio times, fences and records. On the cron path `waitUntil` is
`alarmHookCtx`'s (`runtime.ts:1960-1969`), which tracks nothing, so work handed to it
would be cut off when the handler returned and would never appear in the delivery's
outcome; on the submit path it would work, so testing there would not show the gap.

### 20. Deleting a response deletes its deliveries, in the same batch

`form_deliveries` has no foreign key, following `0010_forms.sql:3-6`. Each of the three
delete paths gains a statement in the same batch:

- `deleteResponse` (`form-responses.ts:1609`): `delete from form_deliveries where
  response_id = ?` batched with the response delete.
- `deleteResponses` (`:1786`): the same pair, batched per row.
- `deleteForm` (`forms.ts:1160-1164`): `delete from form_deliveries where form_id = ?`
  as the first statement of the existing batch, and `delete from form_refusals where
  form_id = ?` beside it.

A delivery row therefore never outlives its response, which is what makes "a deleted
response stops its deliveries" true without the sweep having to notice. A sweep that
nevertheless finds a row whose response is gone (a delete racing an attempt) deletes
it and counts it in `dropped`. Retention stays manual (forms.md checkpoint 9): a
delivery row lives exactly as long as the response it is about.

### 21. Responses shows deliveries where the publisher already looks, inside the site fence

- **The table** gains a Delivery column: one compact status per attached delivering
  action (`Delivered`, `Retrying (3 of 8)`, `Failed`, `Skipped`, `Cancelled`), from
  a correlated subquery on the same `listResponses` statement
  (`json_group_array` over `form_deliveries` by `response_id`, served by the primary
  key's prefix), so a page of fifty rows is still one statement.
- **The drawer** lists each delivery: the action's label, status, attempts, the
  category phrased for a person, the action's own `detail`, the `reference`, when the
  next attempt is due, and Retry.
- **A filter** `?delivery=failed|pending|skipped` on the list, the CSV and the
  bulk-delete filter, through `responseFilterSql`, as an `exists` on
  `form_deliveries`.
- **Banners**: when `?count=1` finds failed deliveries ("3 deliveries failed. Show
  them"); when a `pending` row's `next_at` is more than ten minutes overdue ("Retries
  are not running. Check that your Worker declares a cron trigger and calls
  folio.runSchedules()", `schedules-model.ts:247`'s message applied to a second
  table); and when an attachment needs attention (decision 13).
- **Every delivery count and banner is inside the site fence.** `failedDeliveries`
  and the overdue check join `form_responses` on `response_id` and apply the same
  `sitesClause` as `listResponses`, so a reader whose `sitesOf` is one site of a
  shared form counts only the deliveries of responses it can already see. The join is
  by primary key, and the counts are over one form's delivery rows, so no `site_id`
  column is added to `form_deliveries`.
- The CSV does not gain delivery columns: it is the answers, and a delivery is not
  one.

### 22. `hooks.submitted` is untouched

It fires after the insert, for a stored row only, with the same payload, whether or
not the form has actions. `hooks.ts:5-9`'s "no retry queue, no delivery log" stays true
of hooks: a hook is still a function in the host's Worker with the host's own
guarantees, and actions are the route for anything that wants Folio's. A host may use
both on one form.

### 23. A refused attempt counts against the rate limit, and a check's verdict is public

A check that refuses stores nothing, and the rate limit counts stored rows only
(`form-responses.ts:679-690`). Left alone, that makes a refusing check an unthrottled
endpoint: one address could post as often as it liked, spending the vendor's API quota
on each post, and a code like `duplicate` ("we already have your enquiry") would answer
"is this email already a customer?" for any address anyone cares to type.

So **every refusal the route gives after the rate limit has passed is recorded** in a
small throttle table, `form_refusals (ip_hash, form_id, created_at)`, with the same
hour-bucketed `ip_hash` the rate check computed: an `invalid` answer, a check's
`refused`, and spec 37's `source_unavailable`. `recentSubmissionCount` becomes one
statement summing the two tables over the same two hashes and window, so the limit
(`ratePerHour`, default 10) bounds **attempts** per address per form per hour, not
successes. A request with no client IP, or a brand with `ratePerHour: 0`, records
nothing, exactly as it is unthrottled today. The rows hold no answers; the hash stops
being computable from an address when its hour passes (forms.md decision 10), and the
delivery pass deletes rows older than two windows (decision 12). Refusals before the
rate limit (`closed`, `verify`) are not recorded: by then the limit has already been
spent or not reached, and `verify` is the control for that traffic.

That bounds the oracle; it does not remove it. **A check's verdict is visible to
anyone who can post the form**, and the docs say so where `codes` are introduced. An
action whose code reveals something about a person (`duplicate`, `existing_customer`)
belongs on a brand that configures `verify`, so that each probe costs a solved
captcha rather than a POST. `validateForms` logs one `warn` at construction for a brand
that registers a check with declared codes and has no `verify`, naming the action.

**Rejected: refusing to let a check declare person-revealing codes.** Folio cannot
tell `duplicate` from `unknown_trip`, and the visitor-facing feature (telling somebody
they already enquired) is legitimate. **Rejected: answering a refusal success-shaped,
the honeypot's trick.** Then the visitor is never told, which is the feature.
**Rejected: counting refusals in `form_responses`.** It would put rows with no answers
in the table every reader, export and count assumes holds responses.

### 24. A check has no side effects

A check runs before Folio knows whether the submission will be stored: a later check
may refuse, the insert may collapse as a duplicate, or the insert may throw. A check
that created something (a booking hold, a CRM record) would leak it in each of those
cases, with nothing to release it, and a double-click that got past the duplicate
pre-check would create two. So **a check is a read**: it validates, looks up and
answers. Anything that creates or changes state outside Folio belongs in `deliver`,
which runs once per stored response with an idempotency key. The docs say so beside
`check`'s signature, and the reply values (decision 17) are for things a read can
produce: a looked-up name, a quote.

**Rejected: a compensation hook (`release(ctx)`)** called on refusal or collapse. It
adds a third phase with its own failure semantics (what if `release` throws?) for a
case this release has no host asking for. A host that needs a reservation makes it in
`deliver`.

## Wire & schema changes

### D1 migration `0017_form_actions.sql`

```sql
-- Form actions (docs/specs/content-model/form-actions.md).
--
-- One column and two tables, all additive, numbered after spec 37's
-- 0016_option_sources.sql and independent of it. No foreign keys and no CHECK
-- constraint, following 0010: the delete paths are explicit batches (decision 20),
-- and enum-shaped columns are screened on read rather than constrained, because
-- SQLite cannot widen a CHECK without rebuilding the table.

-- JSON array of FormActionAttachment, in run order, at most MAX_FORM_ACTIONS (8).
-- Validated against the brand's registered actions on every write that changes it;
-- screened on read by readFormActions, where an unreadable column answers [] with
-- one logged line.
alter table forms add column actions text not null default '[]';

create table form_deliveries (
  -- The response this delivers. One row per (response, action): an action is
  -- attached to a form at most once (decision 7).
  response_id text not null,
  action      text not null,
  -- Denormalised from the response so deleteForm clears a form's deliveries in one
  -- statement. Counts by form join form_responses for the site fence (decision 21).
  form_id     text not null,
  -- pending | delivered | skipped | failed | cancelled. Screened on read.
  status      text not null default 'pending',
  -- Moved at claim time, so an attempt that was killed mid-flight still counts.
  attempts    integer not null default 0,
  -- When the next attempt may claim this row. Null unless pending. A claim moves it
  -- forward by the lease, which is what recovers a row whose runner died.
  next_at     integer,
  -- The current claim's random token. Every result write is fenced by it, so a
  -- runner whose lease lapsed writes nothing (decision 10).
  claim       text,
  -- The hostname that received the submission (decision 14). One of the site's own
  -- hosts; not personal data.
  host        text not null default '',
  -- JSON object, input name -> question name, as the mapping stood at submit
  -- (decision 11). Question names only, never answers. Null for a row created failed.
  inputs_map  text,
  -- What the third party called it, when deliver returned one. Shown in Responses.
  reference   text,
  -- A category: threw | timeout | malformed | refused | not_registered | incomplete |
  -- predates_mapping | no_brand | gave_up. Never a thrown message (decision 15).
  failure     text,
  -- Only text the action returned for display ({ skipped } or { failed }). At most
  -- 500 characters.
  detail      text,
  created_at  integer not null,
  updated_at  integer not null,
  primary key (response_id, action)
);

-- The sweep: due pending rows, oldest first. Partial, so a site whose deliveries all
-- succeed reads an empty index on every tick (0003's schedules index, again).
create index form_deliveries_due on form_deliveries (next_at) where status = 'pending';
-- The failed-count banner and deleteForm.
create index form_deliveries_form on form_deliveries (form_id, status);

-- Refused attempts, for the rate limit only (decision 23). No answers, no id: the
-- hour-bucketed ip_hash the rate check computed, the form, and when.
create table form_refusals (
  ip_hash    text not null,
  form_id    text not null,
  created_at integer not null
);
create index form_refusals_throttle on form_refusals (ip_hash, created_at desc);
```

**Deploy order: apply before deploying the Worker that carries it.** `COLS` will
select `forms.actions` and the rate check reads `form_refusals`, so a Worker deployed
first fails every form read and every submission with `no such column` / `no such
table`, the same rule as `0013` to `0016`. Applying it first is safe: the column
defaults to "no actions" and both tables are empty until the new Worker writes them.

### Core types (`src/core/form-actions.ts`, new)

```ts
export type ActionInputKind = 'text' | 'email' | 'number' | 'boolean' | 'list' | 'file'
export const INPUT_ACCEPTS: Record<ActionInputKind, readonly FormFieldKind[]>  // decision 5's table

export interface ActionInputInfo { name: string; kind: ActionInputKind; label: string; help?: string; required: boolean }
export interface ActionCodeInfo { code: string; label: string; message: string }
export type ActionSettingDef = Extract<Field, { kind: 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'select' }>

/** One entry of `actions` on GET {base}/api/forms/registry. JSON; never functions. */
export interface FormActionInfo {
  id: string
  label: string
  description?: string
  inputs: ActionInputInfo[]                      // declaration order
  settings: Record<string, ActionSettingDef>     // declaration order
  codes: ActionCodeInfo[]                        // declared codes, then 'error' when check is true
  check: boolean
  deliver: boolean
}

export interface FormActionAttachment { /* decision 7 */ }
export const MAX_FORM_ACTIONS = 8
export const RESERVED_CODE = 'error'
export const ACTION_ID = /^[a-z][a-z0-9-]{0,47}$/
export const ACTION_CODE = /^[a-z][a-z0-9_]{0,31}$/

/** Structural validation of the column: shapes, charsets, bounds, one attachment per action. Throws. */
export function validateFormActions(input: unknown): FormActionAttachment[]
/** Normalised with the registry: undeclared settings and codes dropped, defaults filled for
 *  a new attachment, `delivers` recomputed, keys canonical. Unregistered attachments as stored. */
export function normaliseFormActions(a: readonly FormActionAttachment[], infos: ReadonlyMap<string, FormActionInfo>, added: ReadonlySet<string>): FormActionAttachment[]
/** Every problem with this attachment against this action and these questions (decision 5). */
export function attachmentProblems(a: FormActionAttachment, info: FormActionInfo, fields: readonly FormField[], layout: FormLayout): string[]
/** Settings values validated against the definitions. Throws. */
export function validateSettings(values: unknown, defs: Record<string, ActionSettingDef>): Record<string, string | number | boolean>
/** The visitor-facing text for every `<action>.<code>` of this form's checking attachments, in `locale` (decision 3). */
export function refusalsOf(attachments: readonly FormActionAttachment[], infos: ReadonlyMap<string, FormActionInfo>, locale?: LocaleContext): Record<string, string>
```

`ResolvedForm` (`core/forms.ts:881`) gains `refusals?: Readonly<Record<string, string>>`,
emitted only when non-empty. Additive; every existing descriptor is byte-identical.

### Server types (`src/server/form-actions.ts`, new; re-exported from `folio/server`)

```ts
export interface ActionInputDef { kind: ActionInputKind; label: string; help?: string; required?: boolean }
export interface ActionCodeDef { label: string; message: string }

export interface ActionQuestion { name: string; kind: FormFieldKind; label: string; options?: Readonly<Record<string, string>> }

interface ActionContextBase<I, S> {
  form: FormMeta
  inputs: InputsOf<I>              // required -> value; optional -> value | undefined
  settings: SettingsOf<S>          // ValueOf per field; undefined where unset
  questions: readonly ActionQuestion[]
  site: string                     // the submitting site; 'default' without sites
  brand: string | null
  host: string                     // decision 14
  locale: string                   // the stored locale code, '' for the source
  page: string
  signal: AbortSignal              // decision 16
}

export interface CheckContext<I, S> extends ActionContextBase<I, S> {
  req: Request
  /** The raw body, before undeclared keys are dropped: verify's reason (forms.md decision 13). */
  raw: Readonly<Record<string, string>>
}
export type CheckResult<C extends string> =
  | { ok: true; reply?: Readonly<Record<string, string | number>> }
  | { ok: false; code: C }

export interface DeliverContext<I, S> extends ActionContextBase<I, S> {
  response: FormResponse
  files: readonly SubmittedFile[]
  key: string                      // `${responseId}:${actionId}` (decision 10)
  attempt: number                  // 1-based
}
export type DeliverResult = void | { reference?: string } | { skipped: string } | { failed: string }

export interface FormAction<Env, I = Record<string, ActionInputDef>, S = Record<string, ActionSettingDef>, C extends string = string> {
  id: string
  label: string
  description?: string
  inputs?: I
  settings?: S
  codes?: Record<C, ActionCodeDef>
  /** A read: no side effects (decision 24). */
  check?(ctx: CheckContext<I, S>, env: Env): CheckResult<C> | Promise<CheckResult<C>>
  deliver?(ctx: DeliverContext<I, S>, env: Env): DeliverResult | Promise<DeliverResult>
}

export function formAction<Env, const I, const S, const C extends string>(def: FormAction<Env, I, S, C>): FormAction<Env, I, S, C>

export type DeliveryStatus = 'pending' | 'delivered' | 'skipped' | 'failed' | 'cancelled'
export type DeliveryFailureCategory = 'threw' | 'timeout' | 'malformed' | 'refused' | 'not_registered' | 'incomplete' | 'predates_mapping' | 'no_brand' | 'gave_up'
export interface DeliveryRow { action: string; status: DeliveryStatus; attempts: number; nextAt: number | null; reference: string | null; failure: DeliveryFailureCategory | null; detail: string | null; createdAt: number; updatedAt: number }
export interface DeliveryFailure { responseId: string; formId: string; action: string; attempts: number; failure: DeliveryFailureCategory; givenUp: boolean }
export interface DeliveryRunReport { due: number; delivered: number; skipped: number; failed: DeliveryFailure[]; dropped: number }

export const MAX_DELIVERY_ATTEMPTS = 8
export const DELIVERY_BACKOFF_MS: readonly number[]   // decision 12's table, MAX_DELIVERY_ATTEMPTS - 1 entries
export const DELIVERY_LEASE_MS = 120_000
export const DELIVERY_BUDGET_MS = 30_000
export const CHECK_TIMEOUT_MS = 10_000
export const DELIVER_TIMEOUT_MS = 20_000
export const DEFAULT_DELIVERY_BATCH = 25
```

Changed:

- `FolioForms<Env>` gains `actions?: readonly FormAction<Env>[]`; `FORMS_KEYS` gains
  `actions`; `ResolvedForms` gains `actions: ReadonlyMap<string, FormAction<unknown>>`
  and `infos: ReadonlyMap<string, FormActionInfo>`.
- `Form` gains `actions: FormActionAttachment[]`; `FormSummary` gains `attention:
  boolean`; `UpdateFormInput` and `FormPatchBody` gain `actions?`.
- `ResponseRow` gains `deliveries: { action: string; status: DeliveryStatus; attempts:
  number }[]` (always present, `[]` with none); `responseById`'s answer gains
  `deliveries: DeliveryRow[]`.
- `ResponseFilter` gains `delivery?: 'failed' | 'pending' | 'skipped'`; `ResponsePage`
  under `count` gains `failedDeliveries: number`.
- `recentSubmissionCount` counts `form_responses` plus `form_refusals`; a new
  `recordRefusal(db, hash, formId, now)`.
- `ScheduleRunReport` gains `deliveries?: DeliveryRunReport`, present only on
  `folio.runSchedules`'s answer for a call whose `continueFrom` is null. Additive.
- `SubmitStatus` gains `refused`; `Reply` gains `reason?` and `actions?`.

### Construction-time validation (`validateForms`)

Refused, each naming the brand on a branded deployment (`prepareBrand`'s wrapper):
`actions` not an array; an entry with an `id` not matching `ACTION_ID` or repeated in
the brand; no `label`; neither `check` nor `deliver` a function, or either present and
not a function; an input name outside its charset or an unknown input `kind`; a setting
whose kind is not one of the six, or that sets `translatable`, `indexed`, `searchable`
or `unique`; a `select` setting with no options or duplicate values; a code outside
`ACTION_CODE`, a code named `error`, or a code with no `label` or `message`; `codes`
on an action with no `check` (nothing could ever refuse with one). Warned, not
refused: a check with declared codes on a brand with no `verify` (decision 23).

### New or changed routes

| Method and path | Access | Request | Answer |
| --- | --- | --- | --- |
| `GET {base}/api/forms/registry` (introduced by spec 37) | `READ` | none | `200 { sources, actions }`; this spec adds `actions: FormActionInfo[]`, `[]` when none; `400 site_required` on a branded deployment with no scope |
| `GET {base}/api/forms` | `READ` (unchanged) | | each summary with `attention` |
| `GET {base}/api/forms/:id` | `READ` (unchanged) | | `Form`, now with `actions` |
| `PATCH {base}/api/forms/:id` | `EDIT`, plus `FORMS` when the normalised `actions` change | `actions?: FormActionAttachment[]` | `400 bad_request` naming the attachment and the problem it would add; `403 forbidden` "Changing where responses go needs publisher access" |
| `GET {base}/api/forms/:id/responses` | `FORMS` (unchanged) | `?delivery=` | rows with `deliveries`; `failedDeliveries` under `count=1`, inside the site fence |
| `GET {base}/api/forms/:id/responses/:rid` | `FORMS` (unchanged) | | the row with `deliveries: DeliveryRow[]` |
| `POST {base}/api/forms/:id/responses/:rid/deliveries/:action/retry` | `FORMS`, `fenceForm("read")`, the response read through `sitesOf` | none | `200 { delivery: DeliveryRow }` after one inline attempt; `404` unknown response or delivery; `409 conflict` with the reason (decision 15) |
| `POST {base}/f/:id` (public) | none (unchanged) | | gains `refused` (decision 17); refusals counted (decision 23) |

The retry route's `:action` is anchored to `ACTION_ID` by a new `actionIdParam`, the
way `formIdParam` anchors a form id. It is an id route, so it joins
`scope-partition.test.ts`'s fence list in the same commit.

## Acceptance criteria

### A check refuses with the editor's words

```
GIVEN a form "contact" with "trip-code" attached, whose check refuses with "unknown_trip"
  AND the editor wrote "We do not recognise that trip code", and a French translation
WHEN a visitor posts natively from /fr/contact
THEN the answer is 303 to /fr/contact?folio_status=refused&folio_form=contact&folio_reason=trip-code.unknown_trip
AND no form_responses row and no form_deliveries row exist, and one form_refusals row does
AND the page's descriptor, rendered in French, has refusals["trip-code.unknown_trip"] equal to the French text
AND the same POST with accept: application/json answers 422 with status "refused", reason "trip-code.unknown_trip" and the French message
```

### Refused attempts are rate-limited before the check runs

```
GIVEN a brand with ratePerHour 10 and a form whose check refuses every submission
WHEN one address posts 11 times within the hour
THEN posts 1 to 10 are refused by the check, and post 11 is answered "rate"
AND the check was called exactly 10 times
AND the same holds when the 10 refusals were "invalid" answers rather than check refusals
```

### A check fails closed

```
GIVEN a check that throws, or answers { ok: false, code: "undeclared" }, or answers nothing, or takes 11 seconds
WHEN a visitor submits
THEN the submission is refused with reason "<action>.error"
AND one line is logged naming the action
AND nothing is stored but the refusal row
```

### A delivery failure never reaches the visitor and is retried

```
GIVEN a form with an action whose deliver throws
WHEN a visitor submits
THEN the visitor gets folio_status=ok
AND the response is stored, and a form_deliveries row exists with attempts 1, status pending, failure "threw", detail null, next_at about one minute on
AND the thrown message is in the logger, not in the row
WHEN folio.runSchedules runs at now + 61s with nothing scheduled
THEN the row is attempted again and has attempts 2, next_at five minutes on
WHEN it runs eight attempts in total, all failing
THEN the row is failed with failure "gave_up", report.deliveries.failed names it with givenUp true, and Responses shows Failed
```

### Deliveries never delay a scheduled publish

```
GIVEN 30 due schedules and 25 due deliveries whose vendor hangs
WHEN the host runs its continueFrom loop
THEN every due schedule is published before any delivery is attempted
AND the delivery pass attempts the hung action once, skips its other rows for the pass, and stops claiming after 30 seconds
```

### A delivery and its response commit together

```
GIVEN a form with two delivering actions
WHEN two identical submissions arrive within 60 seconds on one site
THEN one response row and exactly two form_deliveries rows exist
```

### A rename after a failed delivery does not break the retry

```
GIVEN a response whose delivery to "jambo-enquiry" failed, with email mapped to question "email"
WHEN a publisher renames "email" to "work_email" (the mapping follows) and presses Retry
THEN deliver receives the email the visitor submitted, read through the mapping stored on the delivery row
```

### Retry uses the fixed settings and never runs twice at once

```
GIVEN a failed delivery whose deliver failed because setting listId was wrong
WHEN a publisher corrects listId, saves, and presses Retry
THEN deliver receives the corrected listId, with the same key as every earlier attempt
AND the route answers the row as delivered with its reference
GIVEN a pending delivery whose lease is held by a running cron attempt
WHEN a publisher presses Retry
THEN the answer is 409 "An attempt is in progress" and no second attempt starts
WHEN the cron attempt's lease has lapsed, a Retry has delivered the row, and the cron attempt then times out
THEN the cron attempt's write matches nothing and the row stays delivered
```

### Mapping protects the integration

```
GIVEN "jambo-enquiry" with a required email input mapped to question "email"
WHEN an editor tries to delete "email", make it optional, put it behind a showIf, or change it to a text question
THEN the builder refuses and names the action
AND a crafted PATCH doing the same is 400 naming the action and the input
WHEN a publisher renames "email" to "work_email"
THEN the mapping follows the rename in the same save
```

### Drift never locks a form

```
GIVEN a deploy that adds a required input to an attached checking action
THEN the form list marks the form "Needs attention" and its Responses screen says why
AND a visitor's submission is refused as "<action>.error"
WHEN an editor saves a label change, or sets the form closed
THEN the save succeeds
WHEN an editor's save would add a new problem to that attachment
THEN it is refused
```

### Only a publisher decides where responses go

```
GIVEN a signed-in editor (not publisher)
WHEN they PATCH a form with a changed actions array
THEN the answer is 403 and nothing is saved
WHEN they PATCH the same form's label with actions as stored, after a deploy removed one of the attachment's settings
THEN it saves, and the stored actions are written back unchanged
```

### Editors see categories, not thrown text

```
GIVEN a deliver that throws an Error whose message contains a URL with a key in its query string
THEN the delivery row's failure is "threw" and its detail is null
AND neither the list nor the drawer contains the message
```

### Production-only is visible

```
GIVEN an action whose deliver returns { skipped: "Not a production host" } off a live host
WHEN a submission arrives on staging.example.com and the delivery is retried later from the admin origin
THEN deliver sees host "staging.example.com" both times
AND Responses shows Skipped: Not a production host
```

### Code drift is handled, not crashed on

```
GIVEN a form whose delivering attachment names an action the next deploy no longer registers
WHEN a visitor submits
THEN a failed delivery row with failure "not_registered" exists
AND the builder shows the attachment as no longer provided, and a save that leaves it unchanged succeeds
GIVEN a form whose check-only attachment names an action the next deploy no longer registers
WHEN a visitor submits
THEN the check does not run, a warn line is logged, and no delivery row is created
```

### Deleting a response stops its delivery

```
GIVEN a pending delivery
WHEN an admin deletes the response, or bulk-deletes it, or deletes the form
THEN its form_deliveries rows are gone in the same batch, and the next sweep attempts nothing for it
```

### Counts stay inside the fence

```
GIVEN a shared form with failed deliveries on responses from sites A and B
WHEN a reader scoped to site A asks for ?count=1
THEN failedDeliveries counts only site A's
```

### Nothing changes for a form with no actions

```
GIVEN a form with actions []
THEN its descriptor's keys are exactly what they are at v1.2.4
AND a successful submission issues the same statements as at v1.2.4, with the rate check's one statement now reading two tables
```

## Implementation plan

Spec 37 is built and merged first, including the `GET {base}/api/forms/registry` route
and its admin hook. Each phase below leaves the tree green (`pnpm typecheck`,
`./node_modules/.bin/biome ci .`, `pnpm test`, `pnpm build`, by exit code). Phases 1
and 2 are sequential; phase 3 depends on 2; phases 4 and 5 both depend on 3 and touch
disjoint files, so they can run in parallel; phase 6 depends on all of them.

### Phase 1: the vocabulary (core only, no I/O)

1. `src/core/form-actions.ts`: the types, constants, `INPUT_ACCEPTS`,
   `validateFormActions`, `normaliseFormActions`, `validateSettings`,
   `attachmentProblems`, `refusalsOf` (decisions 3, 5, 6, 7, 8). `attachmentProblems`'s
   "always answered" rule reads `showIf` on the question and its section the way
   `compileField` does (`server/forms.ts:454-456`), restated in core rather than
   imported, because `server/` may import `core/` and not the reverse.
2. `src/core/forms.ts:881`: `ResolvedForm.refusals?`.
3. Unit tests in `test/unit/core/form-actions.test.ts`.

### Phase 2: the registry and the migration

1. `migrations/0017_form_actions.sql` as above.
2. `src/server/form-actions.ts`: the server types, `formAction`, `actionInfoOf(def):
   FormActionInfo`, and `validateActions` called from `validateForms`
   (`form-responses.ts:2297`), including the `verify` warning; `FORMS_KEYS` gains
   `actions`; `ResolvedForms` gains the two maps.
3. `src/server/index.tsx`: export the types and `formAction` (decision 19), next to
   the hook payload exports at `:185-207`.
4. `test/workers/migrations.test.ts`: `describe("form_deliveries")` and
   `describe("form_refusals")` in the exact column-and-index pattern, and `forms` gains
   `actions` in its column list.

### Phase 3: storage, the builder's PATCH, the descriptor

1. `src/server/forms.ts`: `Form.actions`, `COLS` gains `actions`, `readFormActions` on
   read; `updateForm` takes the brand's `infos` and `mayConfigureActions`; normalises
   both sides and compares them (decision 8); refuses only a save that adds an
   attachment problem (decision 13); computes `refusals` for both sides and adds a
   difference to `descriptorChanged` (decision 18); `compileForm`'s context gains
   `actions?: ReadonlyMap<string, FormActionInfo>` and emits `refusals`;
   `listForms` computes `attention`.
2. `src/server/validate.ts:1984`: `FormPatchBody` gains `actions: v.optional(FORM_ACTIONS)`,
   where `FORM_ACTIONS` declares every attachment key (a `v.object` strips the rest,
   `ROADMAP.md:859-862`).
3. `src/server/routes/forms.ts`: the PATCH route passes `allows(actor, FORMS)` to
   `updateForm`; the registry route (spec 37's) gains `actions`; `/forms/resolved`
   passes the brand's infos to `compileForm`.
4. `src/server/runtime.ts:1587-1596`: pass the brand's `forms?.infos` into
   `compileForm`.
5. Tests: `test/unit/server/forms.test.ts` gains a pinned key set for a descriptor with
   a checking action and keeps the existing pin unchanged; `test/workers/forms.test.ts`
   covers the PATCH problems (add refused, leave alone allowed, partial fix allowed),
   the `FORMS` guard including the normalised comparison, the purge on a message change
   and none on a settings change, and `attention`.

### Phase 4: the submit route and deliveries (server)

1. `src/server/form-responses.ts`: `insertResponse` batches only with delivery rows
   (decision 9); `recentSubmissionCount` reads both tables and `recordRefusal` is added
   (decision 23); the three delete paths gain their statements (decision 20);
   `listResponses` gains the `deliveries` subquery and the fenced `failedDeliveries`;
   `responseFilterSql` gains `delivery`; `responseById` gains the rows.
2. `src/server/deliveries.ts` (new): `claim` (token), `attemptDelivery` (resolve inputs
   through `inputs_map`, the presence check, the context per decision 11, the
   deadline, the fenced result write per decisions 10 and 15, thrown values to
   `rt.logger.error`), `attemptNew` (concurrent), `runDeliveries` (decision 12: batch,
   budget, per-action timeout skip, brand per row, the `form_refusals` cleanup),
   `retryDelivery` (the conditional reset).
3. `src/server/routes/forms.ts`: the merged order of decision 17, with
   `recordRefusal` at steps 8 and 10 and in spec 37's `source_unavailable` branch;
   `verified`'s sibling `checked`; `SubmitStatus`, `Reply`, `locationFor` (adds
   `folio_reason` only for `refused`) and `replyTo`; the delivery `waitUntil` after the
   insert; the retry route with `actionIdParam` in `validate.ts`.
4. `src/server/index.tsx:1896`: `folio.runSchedules` runs `runDeliveries` when the
   schedule report's `continueFrom` is null, and attaches the report.
5. Tests: `test/workers/form-submit.test.ts` (refused replies in both transports, the
   rate limit counting refusals before the check runs, fail closed on
   throw/timeout/undeclared code, duplicate before check, reply values, no-actions
   statement set), `test/workers/form-deliveries.test.ts` (new: the batch, the claim
   race, the token fence against a stale runner, lease recovery, the backoff walk with
   `now`, give-up at `attempts >= MAX`, each outcome and category, `detail` never
   holding a thrown message, the snapshotted mapping across a rename, `predates_mapping`,
   re-read settings, the Retry reset race, the per-action timeout skip and the budget,
   the delete paths, the fenced counts), `test/workers/scope-partition.test.ts` (the
   retry route fenced), `test/workers/schedules.test.ts` (`deliveries` present only
   when `continueFrom` is null, absent from the HTTP door, schedules published first).

### Phase 5: the admin (can run in parallel with phase 4 once phase 3 lands)

1. The builder reads `actions` from spec 37's registry hook; no Manifest change.
2. `src/admin/ui/screens/form-model.ts`: `removeRefusal` and the retype/required
   refusals consult the attachments; `renameField` rewrites `map`; new
   `attachAction` (fills declared defaults), `detachAction`, `moveAction`,
   `withMapping`, `withSetting`, `withMessage` reducers, all pure, tested in
   `test/unit/admin/forms-model.test.ts`.
3. `src/admin/ui/screens/FormBuilder.tsx`: an Actions section in the form settings
   panel (`FormSettingsPanel`, `:1258`): add from the brand's list (an action already
   attached is not offered), reorder, remove; per attachment, a mapping row per input
   (a `Select` of compatible questions, required inputs marked), settings through
   `Control` with an inert `env`, a message per code with the declared message as
   placeholder under the existing locale switcher, and each attachment's problems
   shown in place. Read-only below `canReadResponses`. The save sends `actions`.
4. `src/admin/ui/screens/Forms.tsx`: the "Needs attention" mark from `attention`.
5. `src/admin/ui/screens/Responses.tsx`, `responses-model.ts`, `useResponses.ts`: the
   Delivery column, the drawer section with Retry, the filter, the three banners
   (decision 21), and the category phrasing, in `responses-model.ts` so a Node test
   reaches it.

### Phase 6: the demo, the end-to-end script and the prose

1. `examples/demo/src/index.tsx:209`: register two actions on the demo's `forms`: a
   `demo-guard` check that refuses an email ending `@blocked.example` with code
   `blocked`, and a `demo-webhook` deliver that logs the payload and throws while its
   `fail` boolean setting is on. `examples/starter` is not changed: a new project
   should not start with demo integrations.
2. `scripts/form-actions-test.mjs`: sign in, attach both actions over the PATCH, post
   a blocked submission natively and assert the `folio_reason`; post one that passes
   and assert `folio_status=ok`; read the response and assert one pending delivery
   with failure `threw` and no detail; turn `fail` off, Retry, assert `delivered`;
   rename the mapped question, assert the mapping followed; delete the response and
   assert the delivery is gone. It joins `e2e-all.sh` by its name.
3. The documents below.

## Documentation this implies

These are the entries the build writes; their content is decided here.

**`docs/configuration.md`:**

- Under `#### \`forms: FolioForms<Env>\`` (`:594`): a third key, `actions`, with the
  `formAction` example from decision 19, then five paragraphs: the two phases and their
  postures, and that a check is a read with no side effects; inputs and the mapping
  rule; settings are not secrets and their defaults apply at attach time; a check's
  verdict is visible to anyone who can post, refusals count against `ratePerHour`, and
  a person-revealing code belongs behind `verify`; `host` and the `{ skipped }` result
  as the way to express a production-only rule.
- The brands table row for `forms` (`:408`): "`verify`, `ratePerHour` and `actions`
  for a submission on this brand's live hosts."
- "Refused at construction" (`:898`): one row, "`forms.actions`: a duplicate or
  malformed id, no `check` or `deliver`, a setting kind outside the six, a code named
  `error`, codes on an action with no `check`", reason "An integration an editor
  attaches and nothing runs".
- "Deploy-time obligations", item 2 (`:872`): one sentence under the `runSchedules`
  loop: "The call that finishes the schedule sweep also retries failed form deliveries
  (`report.deliveries`); without a cron, a delivery gets its first attempt and no
  retries."

**`UPGRADING.md`:**

- Schema ledger row: "`0017_form_actions.sql` | `forms.actions` (a form's attached
  actions), the `form_deliveries` log, and `form_refusals` (refused attempts, for the
  rate limit) | **Apply it before you deploy**: this release's form reads select
  `forms.actions` and every submission's rate check reads `form_refusals`, so a Worker
  deployed first fails both with `no such column` / `no such table`. Additive, safe
  ahead of the deploy, and independent of `0016`." The "Next free number" sentence
  becomes `0018`.
- `### Form actions (v1.3.0)`: apply `0017` first; nothing changes until code
  registers an action, except that **refused submissions now count against
  `ratePerHour`** (a visitor who gets `invalid` ten times in an hour is then answered
  `rate`); the new exports (decision 19), including the four payload types a host may
  delete its local copies of; `ResolvedForm.refusals` and `folio_status=refused`, with
  decision 3's lookup-and-fallback snippet (never render the raw parameter);
  `ScheduleRunReport.deliveries`; configuring actions needs `publisher`.
- **`### v1.3.0 cannot be rolled back`**, shared with spec 37's entry, in the
  document's own voice: "There is no supported rollback from `v1.3.0` to any `v1.2.x`.
  Roll forward. A build from before this release, deployed over a database that has
  `0017`, does the following, and none of it is undone by redeploying `v1.3.0`:"
  - **Checks stop running.** A form that relied on one accepts what it would have
    refused.
  - **Deliveries stop, and the gap is permanent.** Pending rows wait untouched and are
    attempted on the roll-forward, possibly hours late. Responses received while the
    older build is live get **no delivery rows at all**, and attachment is
    forward-only, so they are never delivered by Folio.
  - **Mappings are unprotected.** The older builder has no mapping refusals, so an
    editor can delete or retype a question an action reads. After the roll-forward,
    every checking form whose mapping was broken that way refuses every visitor until
    a publisher remaps it.
  - **Deleted responses leave their delivery rows behind.** The older delete paths do
    not know `form_deliveries`, so rows (with their stored mapping and any action
    `detail`) outlive the responses they were about, until the roll-forward's sweep
    finds and drops them one by one.
  - **Refused attempts stop counting** against the rate limit.
  - Spec 37's items, listed in its own paragraph of the same section.

**Elsewhere:**

- `docs/handbook.md`, the forms section: a "Form actions" subsection for editors and
  developers (attaching, mapping, messages, reading deliveries and their categories,
  Retry, "Needs attention").
- `AGENTS.md`: the integration guide's forms paragraph points at `forms.actions` before
  `hooks.submitted` for anything that forwards a response.
- `CLAUDE.md` (the repo's): the migrations ledger gains `0016_option_sources.sql`
  (spec 37's entry) and `0017_form_actions.sql`, and next free becomes `0018`; one
  invariant: "A delivery row is written in the response's batch and deleted in every
  response delete's batch; a fourth delete path must add it. A result write is fenced
  by the claim token."
- `docs/specs/README.md`: spec 36's index row, `0017`.
- `docs/specs/content-model/forms.md:1554`: the "Retries, a delivery log" out-of-scope
  bullet gains "Reversed for actions by spec 36 (`form-actions.md`); still true of
  `hooks.submitted`."
- `src/server/hooks.ts:5-9`: one sentence pointing at form actions as the route that
  does have a log.

## Edge cases

- **A form with both a `check` and a `deliver` on one action** → one attachment; the
  check runs at submit, the delivery is created on store. The editor maps inputs once.
- **Two checks; the first passes with reply values and the second refuses** → the
  submission is refused; the first's reply values are discarded. Nothing leaks,
  because checks are reads (decision 24).
- **A check passes and the insert collapses as a duplicate (the narrow race the
  pre-check cannot close)** → `ok`, with the check's reply values, and no deliveries:
  the first click's response already has them.
- **The honeypot** → answers `ok` before any check runs, as now, and records no
  refusal.
- **A form closed between render and submit** → `closed`, before any check, and records
  no refusal.
- **A genuine visitor who gets `invalid` repeatedly** → their refusals count; after
  `ratePerHour` attempts in an hour they are answered `rate`. Ten tries at one form is
  the accepted bound; a shared NAT shares it, which is forms.md decision 9's existing
  trade-off, now over attempts.
- **A required input mapped to a question that a later save puts in a conditional
  section** → the save is refused (it adds a problem, decision 13).
- **A mapped optional question that was not asked** (its `showIf` failed) → the input
  is `undefined`; `validateSubmission` already dropped any answer posted for it.
- **A `file` input** → the action receives `SubmittedFile` metadata; the bytes are the
  `sub_` object in `media`, which the action reads through its own
  `config.bindings(env).media`. A response deleted before the delivery is attempted
  takes the object with it and the delivery with it (decision 20).
- **An action id renamed in code** → to Folio that is one action removed and another
  added: the old attachments are unregistered (decision 13) and the new action is
  attached by nobody. The developer's upgrade note says so; nothing migrates ids.
- **A code removed from an action** → the editor's text for it stays in the stored
  attachment, ignored by normalisation, and is dropped the next time a publisher
  changes that attachment; a check that still returns the removed code refuses as
  `error` (undeclared).
- **A brand with no `forms` config at all** → the registry route answers `actions:
  []`; a form on it can have no attachments; the PATCH refuses any.
- **A deployment with no cron** → each delivery gets its immediate attempt; a failed
  one sits `pending`, and the overdue banner says why (decision 21).
- **The cron runs from an entrypoint other than the one that served the submit** →
  irrelevant: a delivery purges nothing, so CLAUDE.md's purge-scope invariant does not
  arise.
- **A `waitUntil` attempt and a cron sweep reach one row at once** → one claim wins
  (decision 10); the other does nothing.
- **The response is deleted while its delivery is mid-attempt** → the attempt
  completes (its third-party call was already made) and its fenced result write
  matches no row; nothing is resurrected.
- **A shared form on a multi-site deployment** → deliveries take the submitting site's
  `site_id` from the response and its brand from that site; a reader below the form's
  scope sees, and counts, only the deliveries of responses it can already see.
- **Two locales, an editor who wrote only the English message** → French visitors read
  the English text (the editor's source text beats the developer's default), which is
  `translate`'s chain.
- **A host on a pre-1.3 admin bundle in a stale tab** → the builder saves without
  `actions`, `FormPatchBody` treats it as absent, and the stored attachments are left
  alone.

## Testing requirements

**Unit (`test/unit/`):**

- `core/form-actions.test.ts`: every row of `INPUT_ACCEPTS`; the "always answered" rule
  across `required`, `showIf`, a section `showIf`, `requireIf`, `checkbox`,
  `checkboxes` and `hidden`; `validateFormActions` bounds (9 attachments, a repeated
  action, bad charsets); `normaliseFormActions` (dropped settings and codes, defaults
  filled only for an added attachment, unregistered passed through); `validateSettings`
  per kind; `attachmentProblems` as a set, so "adds a problem" is testable; `refusalsOf`
  fallback order across locale, fallback, source, declared default and the `error`
  default.
- `server/form-actions.test.ts`: `validateForms` refusals, one test per bullet of the
  construction list, and the `verify` warning; `actionInfoOf` emits no function and
  appends `error` only when `check` is set.
- `server/forms.test.ts`: the existing descriptor pin unchanged for a form with no
  actions; a new pin with `refusals`.
- `admin/forms-model.test.ts`: remove, rename, retype and make-optional against a
  mapping; each reducer; `attachAction` filling defaults.
- `admin/responses-model.test.ts`: the status and category phrasing and the three
  banners.

**Workers (`test/workers/`, real workerd):**

- `form-submit.test.ts`: decision 17's replies, fail-closed cases including the
  timeout (with an injected clock and a never-settling check), the duplicate
  pre-check ordering, reply-value screening, the rate limit counting `invalid` and
  `refused` and stopping the check from running, and a no-actions form issuing the
  v1.2.4 statement set (a recording proxy that follows `withSession`, `prepare`,
  `bind` and `batch`, CLAUDE.md's counting rule).
- `form-deliveries.test.ts`: phase 4 item 5's list.
- `forms.test.ts`: the PATCH problems, the `FORMS` guard on normalised values, purge on
  a message change only, `attention`.
- `migrations.test.ts`: `form_deliveries` and `form_refusals` columns and indexes
  exactly; `forms` gains `actions`.
- `scope-partition.test.ts`: the retry route is fence-tested.
- `schedules.test.ts`: `deliveries` present only when `continueFrom` comes back null,
  absent on `POST /api/schedules/run`, and every due schedule published first.

**End to end (`scripts/form-actions-test.mjs` against port 5199, via
`./scripts/e2e.sh`):** phase 6, item 2. It opens no socket and signs in with
`signInGlobally()`.

**Verified by breaking**, as earlier specs record: remove the delivery statement from
`deleteResponse` and watch the delete-path test fail; move the duplicate pre-check
after the checks and watch the double-click test fail; make `checked` fail open on a
throw and watch the fail-closed test fail; drop the claim token from the result write
and watch the stale-runner test fail; read the current mapping instead of `inputs_map`
and watch the rename-then-Retry test fail; stop recording refusals and watch the
eleventh-post test fail.

## Dependencies

- **Spec 33 (`forms.md`) and 35 (`form-logic.md`)**, done: the descriptor, the submit
  route, `validateSubmission`'s "what was asked", and the section and `showIf` rules
  the mapping reads.
- **Spec 34 (`multi-brand.md`)**, done: actions are per brand, resolved through
  `brandOf` on requests and `rt.forScope` in the cron.
- **Spec 19 (`platform/scheduled-publishing.md`)**, done: `folio.runSchedules` is the
  cron door this rides.
- **Spec 37 (`form-option-sources.md`), built first, released together.** The two meet
  in four places, each settled by an owner decision rather than by whichever builds
  second. **The submit route** follows owner decision 10's single order (decision 17
  here, word for word in 37): 37 owns the option-list load at step 7 and validation
  against sourced options at step 8, and maps an unavailable list to
  `source_unavailable`; this spec owns the duplicate pre-read's widened condition at
  step 9, the checks at step 10, the delivery rows in step 11's batch, and the
  rate-limit counting of refusals at step 6, which covers 37's `source_unavailable`
  answers too. **Builder metadata** is owner decision 7's `GET
  {base}/api/forms/registry`: 37 introduces the route, its admin hook and `sources`;
  this spec adds `actions`; neither puts anything on the Manifest. **FormBuilder:** 37
  changes the question panel, this spec adds an Actions section to the form settings
  panel; the shared touch points are `removeRefusal`/`renameField` in `form-model.ts`,
  which this spec extends for mappings, and the PATCH body, where 37 changes
  `FORM_FIELD` and this spec adds `FORM_ACTIONS` beside it. A sourced `select` maps to a
  `text` input exactly as a static one does; `ActionQuestion.options` carries static
  options only, and a sourced question's labels are 37's `option_labels` on the
  response. **Migrations and release:** owner decision 9; `0016` is 37's, `0017` this
  spec's, neither depends on the other, and the shared `UPGRADING.md` section says the
  release cannot be rolled back.
- **Cloudflare:** no new binding. A cron trigger is already a documented obligation
  (`docs/configuration.md:872`); without one, deliveries get no retries.

## Out of scope

- **Folio-shipped actions** (email, webhook, Slack). Folio has no mail binding, and a
  built-in webhook would mean Folio holding a URL and a secret; an action is a dozen
  lines in the host, which holds both. The demo's two actions are examples, not
  exports.
- **Actions on events other than a submission** (a publish, a form change). Those are
  hooks, and hooks stay hooks (decision 22).
- **A check pointing at one question** ("this trip code is not one we run" under the
  trip-code input). A refusal is about the submission; per-answer validation is the
  server validator's, and spec 37 and #55 own the client half of that conversation.
- **Compensation for check side effects** (decision 24).
- **Delivery columns in the CSV** (decision 21).
- **Per-action retry policies.** One schedule, one cap, documented. A host that needs a
  different policy for one vendor returns `{ failed }` early or uses its own Queue from
  `deliver`.
- **Storing check reply values** (decision 17). A value a publisher must see belongs
  in a `deliver`'s `reference`.
- **An `/api/v1` route or MCP tool for actions or deliveries** (forms.md checkpoint 20:
  nothing outside the admin reads responses).
- **Delivering responses stored before an action was attached, or during a period
  when it was not running.** Attachment is forward-only and there is no backfill;
  combined with owner decision 8 (no rollback), the only way to have a window with no
  deliveries is to detach the action, and a host that wants those responses delivered
  runs its own script against `form_responses`.

## Implementation notes

Built 2026-11-03 in six phases on `feat/form-actions`, after spec 37 on the same branch:
the core vocabulary, the registry and `0017`, storage and the builder's PATCH, the
submit route and deliveries, the admin, then the demo, the end-to-end script and the
prose. It ships with spec 37 as **v1.3.0**.

**Where the spec was wrong or ambiguous, and what was done.** Each is the conservative
reading consistent with the Architecture decisions.

Core (phase 1)
- A required setting hidden by its `showIf` is not required. A blank setting (`''`,
  `null`, `undefined`) is unset and omitted.
- `alwaysAnswered` follows `compileField`: a question with `requireIf` is not always
  answered.
- `normaliseFormActions` also drops map keys for inputs the action no longer declares.
- An empty editor message is unwritten in `refusalsOf`; `error` is always present, with
  `DEFAULT_ERROR_MESSAGE`.
- Bounds the spec did not state: a setting string is 2000 characters, a refusal message
  500 (`MAX_REFUSAL_MESSAGE`).
- Extra exports: `ACTION_INPUT_NAME`, `DEFAULT_ERROR_MESSAGE`, `ActionSettingValue`. The
  vocabulary is public from `folio/core` (decision 4).

Registry and migration (phase 2)
- The "check with codes and no `verify`" warning is a pure `actionWarnings(infos,
  hasVerify, brand)`, logged once from `createRuntime`, because `validateForms` and
  `prepareBrand` have no logger.
- `formAction` constrains `I` and `S` to `Record<string, ActionInputDef | ActionSettingDef>`
  with `const` inference. `DeliverResult` keeps `void`, under a `biome-ignore
  noConfusingVoidType`.
- Extra construction refusals: a non-object entry, a bad setting name, an input without a
  label or with a non-boolean `required`, a non-string description.
- A resolved action stores `check` and `deliver` bound to the definition. The info
  includes the implicit `error` code (label "Could not process"); settings are
  deep-copied through JSON.

Storage, PATCH and the descriptor (phase 3)
- The `FORMS` guard refuses by default when `mayConfigureActions` is absent.
- The purge compares `refusalsOf` for the source locale and every configured locale;
  with no locales configured, a translated message does not purge.
- The client's `delivers` is never believed. An unregistered attachment keeps its stored
  value; an echo of the stored value is a no-op; attaching a new unregistered action is a
  `400`.
- "Adds a problem" compares problem sentences per attachment, so renaming a question that
  already had a problem may read as a new one. Left.
- The request schema for an attachment avoids `bounded()` because a `textarea` setting
  needs newlines; the limits live in `validateFormActions`.
- `listForms` reads `fields` and `layout` only for forms that have attachments.
- `GET /forms` and the PATCH read `c.var.brand`; the PATCH calls `brandOf` only when the
  body carries `actions`.
- `attention` counts registered attachments with a problem (check or deliver);
  unregistered ones do not count.

Submit and deliveries (phase 4)
- Decision 15's Retry reset SQL was wrong twice. `not (failure = 'predates_mapping')` is
  `NULL` for a row with no failure, which refused every ordinary retry, so the statement
  uses `failure is not 'predates_mapping'`. `not (status = 'pending' and next_at > ?now)`
  refused a retry during a backoff wait, so the reset allows `claim is null or next_at <=
  now` and clears the claim, and a result write clears the claim as well.
- `givenUp` means the row ended `failed`, including a permanent `refused`.
- **`ResponsePage` carries `overdueDeliveries` beside `failedDeliveries`**, both at the top
  level of the page (not under `count`), both fenced by the site fence and neither narrowed
  by `q` or the date range. It counts `pending` deliveries more than ten minutes past
  `next_at` (`DELIVERY_OVERDUE_MS`) and is what the admin's "Retries are not running"
  banner reads (phase 5). The spec named only `failedDeliveries`.
- `ResponseRow.deliveries` is `DeliverySummary[]`; `responseById` answers a
  `ResponseDetail` whose `deliveries` are `DeliveryRow[]` (no `host`).
- The timeout skip inside a delivery pass is keyed by action id alone, because the brand
  is unknown before the load, so one 25-row page of one hung action can starve another
  brand's rows for a tick. Not fixed.
- `runDeliveries` takes internal `budgetMs` and `deliverMs`; the check timeout is tested
  with fake timers. `no_brand` is tested with `brandFor` returning null.
- The Retry route uses the request's brand, not the response's site's brand; the cron
  resolves it from `site_id`.
- Decision 19's exports from `folio/server`: `FolioForms`, `FormResponse`, `ResponseValue`,
  `SubmittedFile`, `FormMeta` and the `Delivery*` types.
- New test files: `form-actions-admin.test.ts`, `form-submit-actions.test.ts`,
  `form-deliveries.test.ts` and `form-actions-fixture.ts`.

Admin (phase 5)
- The builder sends `actions` on the PATCH only when they differ from the saved value.
- Retyping, requiring or making conditional a question an action reads is refused with a
  toast rather than applied. Save is disabled, with the reason shown, only when the draft
  adds a new attachment problem.
- `ActionsEditor` is in `BY_ROUTE` (the dialog count becomes 41). The fixture gains
  `registryActions`, `responses`, `deliveries` and `retried`.
- Retry is shown only when `canRetryDelivery`, and the server's `409` reason is the toast.
- While translating, mappings and settings are hidden and only the messages are shown.
  `SettingControl` gained `textarea` and `date` branches.
- **Not browser-verified**: the Actions layout, badge wrapping, the banners, the
  drawer and Retry focus, the "Working..." state, settings text inputs, disabled-button
  tooltips and the date and textarea controls.

Demo, end-to-end script and prose (phase 6)
- `demo-guard` and `demo-webhook` are defined with `formAction` above `createFolio` in
  `examples/demo/src/index.tsx` (a `const` used in the config has to be declared first).
  `examples/starter` is unchanged.
- `scripts/form-actions-test.mjs` asserts the delivery is gone through the HTTP surface
  (the response is a `404`, Retry is a `404`, and `failedDeliveries` and
  `overdueDeliveries` are zero), because a script cannot read D1; the table itself is
  proven by `form-deliveries.test.ts`. It does not assert the rate-limit counting, which
  `form-submit-actions.test.ts` owns.
- `docs/configuration.md` anchors were corrected from the spec's line numbers, which had
  moved. The `ROADMAP.md` entry is a note on the existing "no vendor integration" bullet,
  since the roadmap had no spec-36 item to mark.

Build review (adversarial review of the six phases; all six findings fixed)
- **M2, the attempt cap held only at settle.** An attempt that died before settling (an
  isolate killed inside `deliver`) lapsed its lease and was re-claimed for ever, past
  `MAX_DELIVERY_ATTEMPTS`, never showing as failed. The claim now requires `attempts <
  MAX`, and each pass first closes pending rows at or over the cap whose lease has lapsed
  as `failed`/`gave_up`, reporting them in `failed`.
- **M1, a hung action starved the rest.** The pass chose its batch before learning which
  action was hung, so the hung action's backlog filled it for the length of the outage.
  The pass now reads in pages: when an action times out, or throws after more than half
  the deadline, the next page is read with `action not in (...)`, so decision 12 holds.
- **M3, `auth: 'open'` could not attach actions.** `mayConfigureActions` called `allows`
  on a null actor. It now mirrors `stories.ts`: `rt.auth.mode !== "session" || allows(...)`.
- **L1, a throwing delivery pass rejected `runSchedules`** after the schedules were
  published. It is caught and logged, and the report carries `deliveriesFailed: true`.
- **L2, `form_refusals` was pruned only by the cron and the prune scanned the table.**
  `0017` (unlanded) gains `form_refusals_age (created_at)`, and `recordRefusal` also
  deletes rows older than two windows, so a deployment with no cron stays bounded.
- **L3, a fields-only PATCH with no brand skipped the "adds a problem" refusal.** When a
  form has attachments and the request has no brand, the route now calls `brandOf`
  (`site_required`) instead of checking against no registry. This is not reachable over
  HTTP today, because `scopedActor` refuses an unscoped request to a scoped route first,
  so its test is a characterisation and does not go red without the fix.
