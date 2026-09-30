# The multi-brand plan, and how to work through it

This is the execution plan for spec 34, `docs/specs/foundation/multi-brand.md`, and the
**briefing file every subagent on that work reads first**. The spec says what to build
and owns the design; this file says in what order, by whom, how each step is proven,
and how the result reaches a test deployment that serves allaboutafrica and takeoffgo
from one Worker. Where the two disagree on *design*, the spec wins and the
disagreement is a finding to report. Where they disagree on *sequencing, gates or the
consumer rollout*, this file wins.

Read this, then `CLAUDE.md`'s "Invariants that are easy to break by accident", then the
spec's **Ground truth**, **Architecture decisions** and **Implementation plan**. None
replaces the others.

**The end state is a test deployment, not a cutover.** A new brand-neutral host
repository's Worker, with its own fresh D1, R2 bucket and Durable Object namespace,
serves both brands on new test hostnames, loaded by a scripted import. Nothing is
rebound, transferred or migrated from either existing site. Production and the
existing staging deployments of both sites stay exactly as they are, on their current
pins, throughout. Moving either real site onto the new Worker is a separate procedure,
written after this one is verified and run only on the owner's go-ahead.

## First message to send the new session

Paste this, unchanged, as the first message of the session that will run the build:

```
Build Folio spec 34 (multi-brand) end to end, following docs/multi-brand-plan.md. Read CLAUDE.md, docs/multi-brand-plan.md, and the Ground truth and Architecture decisions in docs/specs/foundation/multi-brand.md before the first edit. The spec's decisions are settled by me; do not reopen them. If the code contradicts the spec's Ground truth, stop and tell me rather than building on the spec. End state: a test deployment of the new host repository serving allaboutafrica and takeoffgo from one Worker on the test hostnames the plan names, verified from the far side as its Phase V describes. Production and the existing staging deployments of both sites are not touched, and neither consumer repository is edited. Work the phases in the plan's order, parallel only where it says so; gate every phase by exit code and commit each phase on a local branch in this repo's statement-subject style; run an adversarial review where the plan says so and fix what it confirms before moving on. Confirm with me before each outward-facing step the plan lists, one line each on what changes and how to roll it back. Never name any client, brand, site or domain in this repo other than allaboutafrica and takeoffgo, and never write the admin origin's domain into this repo.
```

## Ground truth

Measured 2026-09-30 against `6b4fc19`. A later reader re-measures rather than trusts it.

- **Nothing of spec 34 exists.** No `brands` key, no `sites.brand`, no `0013`.
  Migrations on disk are `0001`–`0008`, `0010` and `0011`; `0009` is a permanent gap;
  `0012_users_role_contract.sql` is claimed by spec 23 and unwritten; `0013` is free.
- **`package.json` is `version: "0.0.0"` and no tag exists.** `docs/1.0-plan.md` has
  phases 0 to 4 complete and phase 5 (#12) next; phase 6 (#20) cuts `v1.0.0`. **This
  plan's phase 1 must be on `main` before that tag**, because it narrows accepted
  config (spec decision 7). Nothing else here is tied to the tag.
- **Consumer pins, read-only for this plan:** allaboutafrica-website `main` pins
  `3acc67edec8536459abe6714c3210a9b5f586aee` (production); its `folio-multi-site`
  branch (`adbdde5`, worktree `/Users/brendan/work/takeoffgo/allaboutafrica-website-multisite`)
  pins `11cfc71c9fa1097a9b5154030b7cc8a6f4fbd6f4` and runs staging with `sites` on;
  takeoffgo-website `main` (`455707e`) pins `133bb7fb8f9e6f764a74fdc88556f9bf6da268bb`.
- **Both consumer main checkouts are dirty with somebody else's work** (an uncommitted
  `JAMBO` service-binding hunk in `wrangler.jsonc` and `wrangler.toml`). The host repo
  copies code **from committed heads with `git archive`**, never from a working tree,
  so that hunk cannot come across.
- **takeoffgo-website's `codegen.yml` holds a literal Jambo token, committed.** The host
  repo's codegen config reads its token from the environment and is written fresh;
  that file is never copied. The token's rotation is the owner's, outside this plan.
- **The two existing staging deployments are the import's sources**, read over v1:
  allaboutafrica's at `https://staging-cms.allaboutafrica.au/folio/~default/api/v1`
  (multi-site, admin origin `staging-cms`), asset bytes at
  `https://staging.allaboutafrica.au/folio/asset/<key>`; takeoffgo's at
  `https://staging.takeoffgo.com/folio/api/v1` (single-site), asset bytes at
  `https://staging.takeoffgo.com/folio/asset/<key>`. `GET {base}/api/forms` and
  `/api/forms/:id` answer at `READ` (`src/server/routes/forms.ts:178`, `:255`), so a
  `content:read` token reads both documents and form definitions.
- **Both brands embed Folio forms by id** (`formSection`, `enquiryForm`), so the import
  carries form definitions; responses are not carried.
- **`scripts/cache-probe.mjs` already takes `--admin`, `--site` and `--preview`**
  (`scripts/cache-probe.mjs:69-83`) and passed 13/0 against allaboutafrica staging
  (`multi-site.md` "Staging (2026-09-30)"). It needs no change to probe each brand's
  site on the test deployment.
- **The admin origin is a host on the brand-neutral company domain**, in the same
  Cloudflare account as both brands' zones. Its name lives only in the host repo
  (`FOLIO_ADMIN_ORIGIN` in `wrangler.jsonc`'s `env.test.vars` and the Vite define).
  Below, **`$ADMIN_ORIGIN`** is that value, exported in the shell from the host repo:
  `export ADMIN_ORIGIN=$(node -p "require('./wrangler.test-vars.json').FOLIO_ADMIN_ORIGIN")`
  run in the host repo (Phase H writes that one-line JSON beside `wrangler.jsonc`).

### Names this plan uses

Chosen for the test; none exists yet.

| What | Name |
| --- | --- |
| Host repository | `takeoffgo/sites` (private), cloned at `/Users/brendan/work/takeoffgo/sites` |
| Test Worker | `sites-test` (`env.test` in the host's `wrangler.jsonc`) |
| D1 | `sites-folio-test` |
| R2 bucket | `sites-folio-test` |
| allaboutafrica site | `default` (the row `0011` inserts), brand `allaboutafrica` |
| takeoffgo site | `takeoffgo`, brand `takeoffgo` |
| allaboutafrica live host / preview origin | `multibrand.allaboutafrica.au` / `https://multibrand-preview.allaboutafrica.au` |
| takeoffgo live host / preview origin | `multibrand.takeoffgo.com` / `https://multibrand-preview.takeoffgo.com` |
| Admin origin | `$ADMIN_ORIGIN`, a host on the brand-neutral domain |

## The decisions, and what each beat

The spec's twenty-three decisions and five owner checkpoints are settled (owner,
2026-09-30). **Do not re-litigate them.** This plan adds only rollout decisions:

| Decision | Beat |
| --- | --- |
| **A fresh test deployment** in a new host repo: new Worker, new D1, new R2, new Durable Object namespace (owner, 2026-09-30) | rebinding allaboutafrica's staging D1 and R2 and moving its Durable Objects with `transferred_classes`, which ties the test to a one-way transfer and to data nobody asked to keep |
| **Both brands' content by one scripted import** over v1, from the existing staging deployments, with fresh ids, published content, assets and form definitions only | reading production (a token on a production deployment for a test); seeding from each repo's `folio-seed.sql` (no real content, so the test proves nothing about real pages); a first-class `folio export`/`import` (spec decision 22) |
| allaboutafrica is the `default` site `0011` inserts, its brand set by SQL right after `0013` | creating a new `allaboutafrica` site and leaving `default` empty: `default`'s root can never be deleted (`multi-site.md` decision 5), so an empty `default` would sit in every switcher |
| Test hostnames on the two brands' own zones, `multibrand.` and `multibrand-preview.`, and the admin origin on the neutral domain | reusing the existing staging hostnames, which belong to the existing staging Workers; `workers.dev`, of which a Worker has one and this test needs five hosts |
| The host's top-level `wrangler.jsonc` is a placeholder that cannot deploy (a zero D1 id), and `env.test` is the only deployable environment in this plan | a top level that is live, which is allaboutafrica's documented trap: `wrangler deploy` with no `--env` would create a Worker nobody meant |
| Deploys from the laptop, `npx wrangler deploy --env test`, from a clean tree | connecting Workers Builds now, which turns a push into a deploy before the test has passed |
| **The test deployment's side effects are contained**: Jambo calls go to Jambo's staging, payment keys are test keys on every non-production host, the CRM forward is skipped when its token is unset and the test sets none, and the enquiry mail goes to an address the owner controls | the brands' production integrations, which would put test enquiries into real inboxes and CRMs |
| Phase 1 is committed on `main` directly; every later phase on the local branch `multi-brand`, cut from `main` after phase 1 | holding phase 1 on the branch, which risks the `v1.0.0` tag landing before it and turning a free fix into a `2.0.0` item |
| The host repo copies code from committed heads (`git archive`), with no history import | a subtree merge of both histories (owner correction, 2026-09-30) |

## Why the order is what it is

Six hard constraints. Everything else is grouped to keep two agents out of one file.

1. **Phase 1 first, and on `main`.** It is the only item whose cost changes at the
   `v1.0.0` tag.
2. **Phase 2 before 3.** Phase 2 touches `routes/api/pages.ts`, `pages.tsx` and
   `index.tsx`'s export lines, which phase 3 and 4 also edit; it is small and
   brand-independent, so it goes first rather than in parallel.
3. **Phase 3 before 4 and 6.** Both need `BrandRuntime`, `rt.forScope`,
   `c.var.brand` and `assets.brands`.
4. **4a, 4b and 6 run together, and only they.** Their file sets are disjoint (below).
5. **5 after 4.** Deleting the old members is what proves 4 missed nothing.
6. **7 after 5, 8 after 7, release after 8, the host after release.** The admin and
   MCP need every reader converted; the documents describe what landed; the host pins
   a SHA reachable from `origin/main`, and `migrations_dir` is
   `node_modules/folio/migrations`, so `0013` reaches the test D1 only through an
   installed pin.

## What the design review found, as rules

Each rule is a way the design breaks if an agent is not told.

- **Never let a registry read fall back to a brand.** A read that is not routed
  through `c.var.brand` or `rt.forScope` must fail — a throwing getter in phases 3 and
  4, a type error from phase 5 — never answer the first brand's schema. A default
  brand compiles, passes every single-brand test, and is wrong for every takeoffgo
  request.
- **A chain never crosses a brand.** On a branded deployment `chain()` omits
  `shared`, and a group and its sites have one brand. Every "why is this row the
  right brand" argument rests on that; an agent that finds itself looking up a
  story's own site to pick a brand has found a chain that crosses, which is a bug in
  phase 3.
- **A null brand serves nothing.** A row with no configured brand leaves the
  registry snapshot. It must not be treated as the first brand, or as "every brand".
- **The string form of the Vite plugin is byte-identical.** A single-brand host's
  `__FOLIO_ASSETS__`, entry names and stylesheet names do not move.
- **`cssCodeSplit: false` with a record fails the build.** It would carry both brands'
  CSS into both previews, which is the leak per-brand bundles exist to prevent.
- **Single-brand behaviour is pinned.** `test/workers/single-site-pin.test.ts` stays
  green unchanged through every phase, and a new multi-site single-brand pin is added
  in phase 3 before anything else is edited.
- **The entrypoint invariant is unchanged.** One Worker has one cached entrypoint; the
  host routes writes, the cron and form submits through `CachedPages`.
- **Migration ids carry their brand.** `takeoffgo/0001-fifty-fifty-to-feature`, refused
  at construction otherwise, because `schema_migrations` is keyed by id alone.

## Orchestration rules

From the multi-site run (`docs/multi-site-plan.md`, "Orchestration rules", all of which
apply). The ones that bite hardest here:

- **The main thread orchestrates and commits.** Subagents never commit. Commit per
  phase (4a, 4b and 6 are three commits) on `multi-brand`, which is never pushed.
- **If the code contradicts the spec's Ground truth, stop and tell the owner.** A line
  that has merely moved is not a contradiction.
- **Scope every agent by file, never by task.** Give it "your files, and only these",
  the concurrent agents' lists when there are any, and: a failure in their files is not
  yours, report rather than fix. Every brief names this file, `CLAUDE.md` and the spec.
- **Never run `pnpm test` while an agent is live.** Use
  `npx vitest run --project unit <file>` or `--project workers <file>`.
- **Never run two e2e scripts in one database, and never one without a reset.**
  `./scripts/e2e-all.sh <script>…` resets per script.
- **Ban file-level `cp` backups.** For a break-it check, revert in place.
- **Verify by breaking it.** Every agent disables the invariant its phase turns on and
  reports which test goes red. If an agent does not report them, run them yourself.
- **Verify the gates yourself, by exit code.** Never commit on an agent's report.
- **Correct a comment the change makes false, in the same commit.**
- **Adversarial reviews after phases 3, 4 (4a, 4b and 6 together) and 7**: the
  `reviewer` agent, opus, given the phase's diff, the spec decisions it implements with
  their rejected alternatives, and the rules above. Tell it the gates are green; require
  each finding proved by breaking or exercising the code, labelled confirmed or
  plausible. Fix confirmed findings in the same phase.
- **This run does not share the tree with the 1.0 run.** 1.0's phases 5 and 6 touch
  `package.json`, `README.md`, `UPGRADING.md` and `scripts/release.mjs`. Do not start
  either while the other has an agent live.
- **`CLAUDE.md` is edited by the main thread only**, at the end of Phase 8.

### Gate discipline

- `pnpm typecheck` — exit code.
- `./node_modules/.bin/biome ci .` — **the direct binary**, exit code.
- `pnpm test` — exit code, with no agent running.
- `cmd | tail; echo $?` is `tail`'s status. Never gate on a piped command.
- `pnpm build` and `pnpm build:demo` at the boundaries of phases 4, 6, 7 and 8, and
  whenever `src/admin/main.tsx` or an entry import changes.

### Commits

Read `git log --format=%s -30` before the first one. Subjects state what is now true,
with no `feat:`/`fix:` prefix and no trailing period (*"A repeated block name is a
construction error, not the last one winning"*). The body argues the decision, names
the alternative it beat, and says plainly when there is a sanctioned behaviour change.
Add whatever attribution trailer the session's instructions require. In the host repo
the convention is Conventional Commits (`chore(deps): pin folio to <sha7>`), as in both
consumer repos.

## Steps that need the owner's confirmation

Ask before each, every time, with the one line below. Approval for one is not approval
for the next.

| # | Step | What changes | Rollback |
| --- | --- | --- | --- |
| C1 | Phase 1: push the one phase-1 commit on `main` through `node scripts/release.mjs --push` | `origin/main` gains the duplicate-name throw; nothing installs it until a pin moves | Consumers stay on their pins; a bad head is fixed forward, never force-pushed |
| C2 | Phase R: `node scripts/release.mjs --tag --push` | `origin/main` moves to the multi-brand head | As C1 |
| C3 | Phase T, step 1: create the private GitHub repo `takeoffgo/sites` and push the host's `main` | A new repository in the organisation | Archive or delete the repository |
| C4 | Phase T, step 2: mint one `content:read` token on each existing staging deployment (allaboutafrica's on `staging-cms.allaboutafrica.au`, takeoffgo's on `staging.takeoffgo.com`) | One `api_tokens` row on each staging D1 | Revoke both tokens (the Access screen on each) |
| C5 | Phase T, steps 3–4: create D1 `sites-folio-test` and R2 bucket `sites-folio-test`, and apply `0001`–`0013` to the D1 | Two new billable resources, empty but for the schema | `npx wrangler d1 delete sites-folio-test`, `npx wrangler r2 bucket delete sites-folio-test` |
| C6 | Phase T, step 6: five Workers custom domains on `sites-test` — the admin origin, `multibrand.allaboutafrica.au`, `multibrand-preview.allaboutafrica.au`, `multibrand.takeoffgo.com`, `multibrand-preview.takeoffgo.com` — and the sign-in sender on the admin origin's domain | Five new proxied DNS records on three production zones and their certificates; one sender address | Detach the five domains (Workers → `sites-test` → Domains & Routes), which deletes the records they created; remove the sender |
| C7 | Phase T, step 7: the first `npx wrangler deploy --env test` | `sites-test` exists and answers on the five hosts | `npx wrangler delete --env test` |

## Progress

Each phase adds its row here as it lands: the phase, the commit, and a one-line note of
where the spec was wrong. Each phase's own entry under the spec's
`## Implementation notes` has the detail.

| Phase | Commit | Note |
| --- | --- | --- |

## The phases

`implementer`, `reviewer` and `mechanic` are the agents in the session's agent table.
Sizes: **S** about a day, **M** a few days, **L** a week or two.

---

### Phase 0 · Baseline

**Do it yourself.**

1. `git status` in `/Users/brendan/work/personal/folio` is clean on `main`. If this
   plan, the spec and `docs/specs/README.md` are uncommitted, commit them as one commit
   first.
2. All five gates by exit code: `pnpm typecheck`, `./node_modules/.bin/biome ci .`,
   `pnpm test`, `pnpm build`, `pnpm build:demo`. Record the test count.
3. `./scripts/e2e-all.sh`. Record which of the 22 are green.
4. Re-read the three consumer pins and heads (`git -C <repo> rev-parse HEAD`,
   `grep '"folio"' package.json`) and record them if they moved.
5. Read the spec's Ground truth against the tree: every `path:line` resolves to the
   fact it states. Record the count checked and anything that moved.

**Done when:** the tree is clean and the baseline is under Progress.

---

### Phase 1 · A repeated block name throws (on `main`, before `v1.0.0`)

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 1 | `src/core/block.ts` (`toRegistry` only); `test/unit/core/block-registry.test.ts` (new) | `implementer`, **sonnet** | S |

The two messages are the spec's, verbatim: `folio: duplicate block '<name>'` and
`folio: registry key '<key>' names block '<def.name>'`. Before committing, grep both
consumer registries (read-only) and the demo and starter for a repeated name; the
spec's Ground truth says there is none, and the phase proves it by running
`pnpm typecheck` and `pnpm build:demo`, which construct both examples.

**Break-it checks:** remove the array check (the duplicate test red); remove the key
check (the mismatch test red).

**Gates:** the four, `pnpm build:demo`. Commit on `main`. **Ask C1**, then
`node scripts/release.mjs --push`, and read back `git ls-remote origin main`. Then
`git checkout -b multi-brand`.

---

### Phase 2 · The additive surface

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 2 | `src/core/index.ts`, `src/server/index.tsx` (export lines only); `src/server/errors.ts`; `src/server/types.ts` (`FolioMiss`, `MagicLinkMail`); `src/server/auth/config.ts`, `src/server/routes/auth.ts` (the `send` call only); `src/server/routes/api/pages.ts`, `src/server/routes/api/documents.ts` (the by-path miss only); the reader's `miss()` in `src/server/index.tsx`; `src/core/registry-digest.ts` (new); `src/server/pages.tsx` (the bootstrap field only); `src/preview/mount.tsx`; `test/unit/core/registry-digest.test.ts` (new), `test/workers/multi-site-headless.test.ts`, `test/unit/preview/*` for the notice, `test/workers/auth-login.test.ts` (the mail's `scope`) | `implementer`, **sonnet** | M |

Everything here is additive and brand-independent: `MagicLinkMail.scope` lands as
`{ id, name }` with `brand: null`, and phase 7 fills the brand. `FolioMiss.headers`
follows the spec's tag rule exactly: `path:<site>:<path>` and `site:<site>` on
multi-site, `site` and `type:*` single-site. `api-partition.test.ts` must not change:
no new v1 segment exists.

**Break-it checks:** answer the old bare `not_found` from `pages/{path}` (the headless
miss test red); drop `site:<site>` from `miss().headers` (red); make `mountPreview`
skip the digest compare (the notice test red); compute the digest from block names
without field names (the "changes with a field" test red).

**Gates:** the four; `./scripts/e2e-all.sh scripts/redirects-test.mjs scripts/api-test.mjs scripts/auth-test.mjs scripts/preview-share-test.mjs`.

---

### Phase 3 · The brand core

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 3 | `migrations/0013_site_brands.sql` (new); `src/core/sites.ts`; `src/server/sites.ts`; `src/server/routes/sites.ts`; `src/server/types.ts` (`FolioBrand`, the config union, `SitesConfig`, `FolioVars.brand`, `assets.brands`); `src/server/runtime.ts` (`BrandRuntime`, `rt.brands`, `rt.forScope`, per-brand validation, the throwing getters); `src/server/middleware.ts` (`withScope` only); `src/core/schema.ts` (`Manifest.brand`, `Manifest.settings`); `test/workers/migrations.test.ts`, `test/unit/core/sites.test.ts`, `test/unit/server/sites.test.ts`, `test/unit/server/brands-config.test.ts` (new), `test/workers/multi-brand.test.ts` (new: registry, chain, fence and construction sections only), `test/workers/multi-site-pin.test.ts` (new, first) | `implementer`, **opus** | L |

Opus, and reviewed, because this is where a brand could leak: a chain that keeps
`shared`, a snapshot that keeps a null-brand row, a getter that answers instead of
throwing. **The migration text is the spec's `0013` block verbatim.**

**Before editing anything**, the agent adds `test/workers/multi-site-pin.test.ts`,
which pins at the phase 2 head the manifest, the Cache-Tag header and the Resolution
payload of a published page on a two-site, single-brand deployment; it stays green
unchanged through every later phase, beside `single-site-pin.test.ts`.

**Proof, beyond the spec's list:**
- On a fresh local database: `0001`–`0008`, `0010`, `0011`, `0013` in filename order
  succeed; then a stand-in `0012` file (two harmless statements, never committed) is
  added and `npx wrangler d1 migrations apply <db> --local` applies it afterwards. That
  settles that `0013` landing before `0012` is written costs nothing. Delete the
  stand-in.
- Construction refuses each case in the spec's decision 3 list, one test per case.
- On a branded runtime, reading any old `rt.*` member throws, and on a single-brand
  runtime it answers as today.

**Break-it checks:** keep `shared` in a branded chain (the `~shared` 404 test and the
`layerSeed` test red); keep a null-brand row in the snapshot (the fence test red);
make a getter answer the first brand (the throwing-getter test red); allow a site to
join a group of another brand (400 test red); allow `brand` to change on a scope with
a story (409 test red).

**Gates:** the four; `./scripts/e2e-all.sh scripts/api-test.mjs scripts/globals-test.mjs scripts/redirects-test.mjs`.

**Review:** yes. Hand the reviewer decisions 4, 5 and 6 and the rules above, and ask it
to try: a group of one brand holding a site of another; a registry write that sets a
brand nobody configured; `~shared` on a branded deployment; a global layer on a site
with no group (it must seed `'full'`).

---

### Phases 4a, 4b and 6 · Every reader through its brand, and the per-brand bundle (in parallel)

The only phase set that runs at once. **Verify the three file sets are disjoint before
launching, and give each agent the other two lists.**

| Phase | Work | Files | Agent | Size |
| --- | --- | --- | --- | --- |
| **4a** | Spec phase 4 item 1: every route reads `c.var.brand` | `src/server/app.ts` (`/api/schema` reads the brand; the neutral manifest waits for 7); `src/server/routes/stories.ts`, `content.ts`, `editor.ts`, `history.ts`, `migrations.ts`, `bulk.ts`, `forms.ts`, `assets.ts`; `src/server/routes/api/index.ts`, `routes/api/documents.ts`; `src/server/routes/mcp.ts` (descriptions only), `src/server/mcp/shot.ts`; `test/workers/multi-brand.test.ts` (the routes section) | `implementer`, **sonnet** | M |
| **4b** | Spec phase 4 item 2: every entry point off a request | `src/server/index.tsx` (the reader, `previewBranch`, `render`, `renderGlobal`, `registry`, `registryFor`, `migrate`, `reindex`, `audit`, `runSchedules`); `src/server/pages.tsx`, `src/server/Document.tsx` (`data-folio-brand`); `src/server/documents.ts`, `src/server/migrate.ts`, `src/server/reindex.ts`, `src/server/scheduler.ts`, `src/server/audit.ts`; `test/workers/multi-brand.test.ts` is **not** theirs — they add `test/workers/multi-brand-entry.test.ts` (new) | `implementer`, **opus** | M |
| **6** | Spec phase 6 | `src/vite/index.ts`; `test/unit/vite/plugin.test.ts` | `implementer`, **sonnet** | S |

**4b is opus** because the reader and the preview branch carry the invariants that
fail silently: a preview never writes, draft-mode layers read without
`ensureSingleton`, and `resolve()`'s published branch runs its passes concurrently.
Each now runs per brand, and each must still hold. **4a and 6 are sonnet**: 4a is one
substitution applied to every route, and 6 is a build-shape change with an exact
target.

**Phase 6's edge:** it does not touch `runtime.ts`; `assets.brands` and
`page('preview')` per brand were phase 3's. An agent that reaches for it has left its
files.

**Break-it checks, 4a:** read `rt.schema` in `routes/stories.ts` again (the throwing
getter turns the two-brand create test red); let MCP describe `rt.types` (the
descriptions test red).
**Break-it checks, 4b:** render a takeoffgo preview with the first brand's registry
(the preview test red); run `migrate` over every scope rather than the brand's (the
`feature` migration test red); call `ensureSingleton` in branded draft mode (the
"no row created" test red).
**Break-it checks, 6:** drop the `cssCodeSplit` refusal (red); change one character of
the string form's define (the byte-identity test red).

**Gates:** each agent runs only `npx vitest run --project … <its files>` while the
others are live. After all three report: the four gates yourself, `pnpm build`,
`pnpm build:demo`, then
`./scripts/e2e-all.sh scripts/api-test.mjs scripts/mcp-test.mjs scripts/migrate-test.mjs scripts/forms-test.mjs scripts/preview-share-test.mjs scripts/draft-mode-test.mjs scripts/scheduled-test.mjs scripts/collections-test.mjs scripts/search-test.mjs`.
Commit 6, then 4a, then 4b.

**Review:** yes, of the three together. Ask the reviewer to list every read of a
registry-derived member left on `rt` and to try: a takeoffgo form submit verified by
allaboutafrica's `verify`; a takeoffgo migration touching an allaboutafrica document
that shares a block name; a takeoffgo preview linking allaboutafrica's stylesheet.

---

### Phase 5 · The old members go

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 5 | `src/server/runtime.ts` (delete the throwing getters and the members from `FolioRuntime`); whatever `pnpm typecheck` then names, which must be nothing | `mechanic` | S |

The proof is the typecheck: exit 0 with the members gone means no reader remains. If
it names a file, that is a reader phase 4 missed: stop, report it, and give it to the
phase that owned the file rather than letting the mechanic convert it.

**Gates:** the four.

---

### Phase 7 · Admin and agent surfaces

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 7 | `src/admin/me.ts`, `src/admin/ui/Admin.tsx` (the scoped manifest fetch), `ui/route.ts` (`documentTitle`), `ui/nav.ts` (`scopeOptionGroups`), `ui/Sidebar.tsx`; `ui/screens/Sites.tsx`, `SiteDialog.tsx`, `sites-model.ts` (the brand field); `src/server/auth/me-sites.ts`; `src/server/app.ts` (the neutral manifest); `src/server/routes/api/index.ts` (v1 `schema.scope`, the unscoped `400`); `src/server/routes/mcp.ts` (the instruction sentence); `src/server/hooks.ts` (`HookBase.brand`); `src/server/routes/auth.ts` (`scope.brand`); `test/unit/admin/multi-site-admin.test.ts`, `test/unit/server/me-sites.test.ts`, `test/workers/multi-brand.test.ts` (admin and agent sections), `test/workers/mcp.test.ts` | `implementer`, **sonnet** | M |

The 1.0 run's admin rules apply: impossible controls are absent, decided in a model
file; logic with a loading state goes in a pure `*-model.ts` with a unit test; one
focus trap; every portal re-declares `scoped()`. **A single-brand deployment must look
exactly as today**: no brand in the switcher, no brand field on the Sites screen, the
same manifest fetch path when no scope is chosen.

**Break-it checks:** fetch the manifest at the bare base with a scope chosen (the
"New menu lists takeoffgo's types only" test red); drop the brand sentence from MCP
instructions (red); answer the neutral manifest on v1 unscoped (the `400` test red);
render the Sites screen single-brand and assert no brand field.

**Gates:** the four, `pnpm build`, `pnpm build:demo`.

**Review:** yes. Ask the reviewer to act as an agent holding an unbound token on a
branded deployment and find any route that answers one brand's types or blocks without
saying which, and any admin surface that lists the other brand's types.

---

### Phase 8 · Documentation

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 8 | `README.md`, `AGENTS.md` ("A multi-brand host": the merged route tree's six rules and the agent's four signals), `docs/handbook.md`, `docs/configuration.md`, `UPGRADING.md`, `docs/specs/README.md`, `bin/folio.mjs` (the `agents` note sentence), the spec's `## Implementation notes` | `implementer`, **sonnet** | M |
| The brief | `CLAUDE.md` | **do it yourself** | S |

`UPGRADING.md` carries: `0013` is additive and safe to apply ahead of the deploy;
turning `brands` on needs `default`'s brand set by SQL right after `0013` and before
the deploy (`update sites set brand = '<brand>' where id = 'default'`), or every
`default` page serves nothing; brand migration ids; `cssCodeSplit: false` refused with
a record; the ledger line ("`0013` has landed; `0012` still claimed; next free
`0014`").

**`CLAUDE.md`, by the main thread:** the migrations ledger (`0013` landed, next free
`0014`); the new invariants — every registry read goes through the scope's brand; a
chain never crosses a brand; a null brand serves nothing; brand migration ids carry
their brand.

**Gates:** the four, `pnpm build`, `pnpm build:demo`, then **`./scripts/e2e-all.sh` in
full**, which is the release gate.

---

### Phase R · Release (C2)

**Do it yourself.**

1. `git checkout main && git merge --ff-only multi-brand`.
2. **Ask C2.** Then `node scripts/release.mjs --tag --push` (`--tag` runs the full e2e
   sweep and the consumer-install smoke; it creates no tag).
3. Read back: `git ls-remote origin main` equals `git rev-parse HEAD`. Record the
   40-character SHA under Progress: it is the host's pin.

---

### Phase H · The host repository, built locally (nothing outward)

| Work | Files (in `/Users/brendan/work/takeoffgo/sites`) | Agent | Size |
| --- | --- | --- | --- |
| The merged host | the whole new repo | `implementer`, **opus** | L |
| The import script | `scripts/import/` | same agent, after the host builds | M |

Opus because the merged route tree is where a brand's code reaches the other brand's
pages, and the rules that stop it are structural and easy to half-apply.

1. `git init` the repo. Copy code from committed heads only:
   `git -C /Users/brendan/work/takeoffgo/allaboutafrica-website-multisite archive adbdde5 app workers scripts public docs | tar -x -C <scratchpad>/aaa-src`
   and `git -C /Users/brendan/work/takeoffgo/takeoffgo-website archive 455707e app workers scripts public docs | tar -x -C <scratchpad>/tgo-src`,
   then move what each brand owns into place. Never copy `codegen.yml` from
   takeoffgo-website.
2. **Layout** (spec decision 18):
   ```
   app/
     brand.server.ts          brandOf(request, env) = (await folio.reader(env, request).site())?.brand ?? null
     root.tsx                 <html data-folio-brand>, the brand's layout
     routes.ts                one tree; colliding paths are dispatch modules
     routes/                  dispatch modules and brand guards only
     brands/allaboutafrica/   folio/ (blocks, FolioBrand), routes/, components/, styles/, graphql/, CLAUDE.md
     brands/takeoffgo/        the same
     shared/                  Jambo client, payment-key picker, nothing styled
   folio.config.server.ts     createFolio({ brands, sites, auth, hooks, route, … })
   workers/app.ts             gateway, CachedPages, StoryDO, SpaceDO, crons
   scripts/check-brand-css.mjs, scripts/import/
   CLAUDE.md                  the brand map
   ```
3. **`folio.config.server.ts`**: the spec's decision 3 example. takeoffgo's migration id
   becomes `takeoffgo/0001-fifty-fifty-to-feature`. `hooks.submitted` branches on
   `payload.brand`. `magicLink.send` words the mail from `mail.scope?.brand?.label` and
   sends from the admin origin's domain. `passkeys({ rpName })` names the company, not
   a brand. `route(path, locale, site)` answers an absolute URL on the site's first
   live host.
4. **`vite.config.ts`**: `folio({ blocks: { allaboutafrica: …, takeoffgo: … } })`;
   `cssCodeSplit` left on. The define `__FOLIO_SITES_ADMIN__` is `$ADMIN_ORIGIN` when
   `CLOUDFLARE_ENV === 'test'`, `http://localhost:5173` under `FOLIO_SITES_LOCAL=1`, and
   there is no production value.
5. **CSS scoping**: every brand stylesheet under `[data-folio-brand="<brand>"]`,
   takeoffgo's reset included. `scripts/check-brand-css.mjs` reads the built client CSS
   and fails on any rule from `app/brands/<b>/` outside `[data-folio-brand="<b>"]`
   except `@font-face` and `@keyframes`; `npm run build` runs it.
6. **Import fence**: a lint rule (`noRestrictedImports` or the equivalent) refusing an
   import from `app/brands/<a>/` in `app/brands/<b>/`, run by `npm run lint`.
7. **`public/`**: only brand-neutral files. `robots.txt`, favicons, `agents.txt` and
   `humans.txt` are dispatch routes; the two `_headers` files merge into one.
8. **Jambo**: one `codegen.yml` reading the token from the environment, one generated
   client from Jambo's current schema, each brand's query documents under its
   `graphql/`, and the two payment call shapes reconciled at their call sites.
9. **Side effects contained** (the rollout decision above): `JAMBO_URL` names Jambo's
   staging in `env.test`; the payment-key picker answers test keys for every host that
   is not a brand's production live host; the CRM forward returns early when its token
   is unset; the enquiry recipient is an env var.
10. **`wrangler.jsonc`**: a placeholder top level (zero D1 id, no routes) and one
    `env.test` with name `sites-test`, `enable_ctx_exports`, `exports.CachedPages.cache.enabled`,
    D1 `sites-folio-test`, R2 `sites-folio-test`, `FOLIO_STORY`/`FOLIO_SPACE` with a
    `v1` migration creating `StoryDO` (sqlite) and `SpaceDO`, `IMAGES`, the `EMAIL`
    binding with the admin origin's sender, the two crons, `routes` naming the five
    custom domains, and `vars.FOLIO_ADMIN_ORIGIN`. `wrangler.test-vars.json` holds the
    same one value for the shell.
11. **Agent documents**: the root `CLAUDE.md` holds the brand map (brand, site id,
    live host, preview origin, MCP URL `$ADMIN_ORIGIN/folio/~<site>/mcp`, "mint tokens
    bound to the site"); each `app/brands/<brand>/CLAUDE.md` names its brand and the
    import fence.
12. **The import script**, `scripts/import/run.mjs`, per source site: read every asset
    the published documents use, download the bytes from the source's live host,
    upload to the target (`POST ~<site>/api/v1/assets`) and map `key`; read every form
    definition (`GET {base}/api/forms`, `/api/forms/:id`) and create it on the target
    (`POST ~<site>/api/forms`), mapping its id; walk the published tree parent first,
    creating each document (`POST ~<site>/api/v1/documents`, `root: true` for the home
    page, `parentId` from the map) with every story, form and asset reference in its
    content rewritten by the maps; publish each; then print counts per kind and a list
    of anything skipped with its reason. Idempotent by refusal: it stops if the target
    site already has a document. It writes no D1 row directly.
13. **Local smoke**, with `FOLIO_SITES_LOCAL=1 npm run dev` after
    `npx wrangler d1 migrations apply sites-folio-test --env test --local` and the Phase T
    step 5 SQL run with `--local`: sites `default` and `takeoffgo` with live hosts
    `aaa.localhost` and `tgo.localhost` and preview origins
    `http://preview-aaa.localhost:5173` and `http://preview-tgo.localhost:5173`. Pin
    Folio with `npm install --install-links file:/Users/brendan/work/personal/folio`
    (never committed). Check: each brand's home renders on its host in its own fonts; a
    colliding path (`/invoice`) answers each brand's page; `aaa.localhost:5173/travel/destinations/x`
    is a 404; the admin's New menu on each scope lists that brand's types only; each
    brand's preview links only its own `folio-preview-<brand>` files.

**Gates (in the host repo):** `npm run typecheck` 0 errors; `npm run lint` exit 0;
`npm run build` exit 0, which includes `check-brand-css.mjs`. **Break-it checks:** move
takeoffgo's `* { margin: 0 }` outside its scope (the CSS check fails); import a
takeoffgo component from an allaboutafrica route (lint fails).

**Done when:** the smoke passes and the host is committed on its local `main` with the
Folio dependency set to `github:brendanmckenzie/folio#<Phase R SHA>` by plain
`npm install`, and `package-lock.json` keeps `node_modules/@floating-ui/dom`.

---

### Phase T · The test deployment (C3–C7)

**Do it yourself.** One change at a time, verified before the next.

1. **C3.** Create `takeoffgo/sites` (private) and push the host's `main`.
2. **C4.** Mint the two `content:read` tokens on the existing staging deployments. Keep
   them in the shell environment only, never in a file.
3. **C5.** `npx wrangler d1 create sites-folio-test` and
   `npx wrangler r2 bucket create sites-folio-test`; put the D1's id in `env.test`.
4. `npx wrangler d1 migrations apply sites-folio-test --env test --remote`. Read back
   `select name from d1_migrations order by id`: `0001`–`0008`, `0010`, `0011`, `0013`,
   nothing else.
5. **Registry and first admin by SQL**, before any deploy:
   `update sites set brand = 'allaboutafrica', name = 'All About Africa', preview_origin = 'https://multibrand-preview.allaboutafrica.au', updated_at = unixepoch() * 1000 where id = 'default'`;
   `insert into sites (id, kind, name, group_id, status, preview_origin, brand, created_at, updated_at) values ('takeoffgo', 'site', 'Take Off Go', null, 'live', 'https://multibrand-preview.takeoffgo.com', 'takeoffgo', unixepoch() * 1000, unixepoch() * 1000)`;
   the two `site_hosts` rows; the owner's `users` row and its `site_roles` `('*', 'admin')`
   row, as `docs/configuration.md`'s bootstrap SQL gives them. Read all four tables back.
6. **C6.** Attach the five custom domains to `sites-test` (they are also in
   `env.test.routes`, so the deploy keeps them) and set up the sender. Verify from the
   far side: `dig +short` answers for all five.
7. **C7.** `npm run build` with `CLOUDFLARE_ENV=test`, then `npx wrangler deploy --env test`.
   Set the test secrets with `npx wrangler secret put <NAME> --env test` (the names each
   brand's `env-secrets.d.ts` lists, with Jambo-staging and test-key values).
8. Sign in at `$ADMIN_ORIGIN/folio` from the emailed link; mint one token per site
   bound to it (`content:read`, `content:write`, `assets:write`, `publish`), shell only.
9. **Re-write both sites' hosts and preview origins through the registry** (`PUT
   /folio/api/sites/<id>/hosts`, `PATCH /folio/api/sites/<id>`), so write-time
   validation runs and `siteChanged` purges fire.
10. **Import**: `node scripts/import/run.mjs` for allaboutafrica (`~default`) and then
    takeoffgo (`~takeoffgo`). Save both count reports to the scratchpad.

---

### Phase V · Verification from the far side

**Do it yourself**, except the browser pass, which is the owner's.

1. **Registry**: `GET $ADMIN_ORIGIN/folio/api/v1/sites/resolve?host=<each of the four brand hosts>`
   answers the right site and surface.
2. **Import counts**: for each site, the v1 document count on the target equals the
   source's published count, less anything the report lists as skipped with a reason.
   Spot-read three documents per site and compare published content field by field.
3. **Cache, per brand**:
   `node scripts/cache-probe.mjs https://multibrand.allaboutafrica.au --admin "$ADMIN_ORIGIN" --site default --preview https://multibrand-preview.allaboutafrica.au --token "$AAA_TEST_TOKEN"` (the step T8 token, from the shell),
   and the same for `multibrand.takeoffgo.com`, `--site takeoffgo`,
   `https://multibrand-preview.takeoffgo.com`. PASS lines needed for each: live MISS then
   HIT; preview a separate entry; both purged by the probe's publish. Then publish a
   takeoffgo page and confirm an allaboutafrica page that was HIT is still HIT.
4. **Brand separation, by reading responses**: a takeoffgo preview page links only
   `folio-preview-takeoffgo.*` and its `<html>` carries `data-folio-brand="takeoffgo"`;
   the same for allaboutafrica; `GET $ADMIN_ORIGIN/folio/~takeoffgo/api/schema` lists
   takeoffgo's blocks only, and `~default` allaboutafrica's; v1 `/schema` with no scope is
   `400 site_required`; `~shared` is 404.
5. **MCP, per brand**: `initialize` on `$ADMIN_ORIGIN/folio/~takeoffgo/mcp` with the
   takeoffgo token returns instructions naming the site and brand; `tools/list`
   descriptions list takeoffgo's types and blocks only. The same for `~default`.
6. **Forms, per brand**: submit allaboutafrica's contact form on
   `multibrand.allaboutafrica.au` and takeoffgo's enquiry form on
   `multibrand.takeoffgo.com`, each with its own captcha's test keys; each is accepted and
   appears in its own site's responses; the enquiry mail reaches the owner's address and
   the takeoffgo forward reaches Jambo's staging only.
7. **Sign-in**: a link requested from `$ADMIN_ORIGIN/folio/~takeoffgo/edit` arrives from
   the admin origin's sender and names Take Off Go.
8. **Browser pass, owner.** Write the checklist to
   `~/outbox/multibrand-test-browser-check.md` and give the owner
   `hcograb multibrand-test-browser-check.md`. In current Chrome, Firefox and Safari
   26.2 or later: sign in at the admin origin; open a page on each brand; type a change
   and see it in the pane in that brand's look (takeoffgo's fonts and reset on
   takeoffgo, none of them on allaboutafrica: DevTools shows allaboutafrica's `body`
   without `font-size: 14px`); the New menu and sidebar list only the brand's types; the
   switcher shows the brand label; the tab title names the site; *Open preview in a new
   tab* shows the draft; a share opens in a private window. The admin origin and both
   preview origins are on different registrable domains, so the pane is a cross-site
   iframe in every browser and this pass exercises the partitioned grant cookie.
9. **The existing sites are untouched**: `npx wrangler deployments status` for
   allaboutafrica's production and staging Workers and takeoffgo's production and
   staging Workers show the version ids recorded in Phase 0; both repos' `package.json`
   on `origin/main` still pin their Phase 0 SHAs.
10. Revoke the two C4 tokens and read back that each source's Access screen no longer
    lists it. Record every result above in the spec's Implementation notes.

## Rollback

- **The test deployment**: `npx wrangler delete --env test`; detach the five custom
  domains; `npx wrangler d1 delete sites-folio-test`; `npx wrangler r2 bucket delete sites-folio-test`
  (empty it first); remove the sender; archive `takeoffgo/sites` if the owner wants it
  gone. No existing site depends on any of it.
- **The C4 tokens**: revoke on each staging deployment's Access screen.
- **Folio**: a bad release is fixed forward with a new commit, never force-pushed. No
  consumer pins it until the owner says so.

## Definition of done, per phase

In this order, before the commit:

1. The phase's proof and acceptance criteria, as listed above and in the spec.
2. Every break-it check, run by you if the agent did not report it.
3. `pnpm typecheck` — exit code.
4. `./node_modules/.bin/biome ci .` — the direct binary, exit code.
5. `pnpm test` — exit code, with no agent running.
6. The phase's e2e scripts through `./scripts/e2e-all.sh <scripts>` — exit code.
7. The review, after phases 3, 4a/4b/6 and 7, with confirmed findings fixed.
8. Commit; add the row under Progress.

## What is deferred, so nobody builds it

- **Moving either real site onto the new Worker.** A separate procedure, written after
  Phase V passes and run only on the owner's go-ahead. It is where drafts, version
  history and ids would matter, and none of this plan decides them.
- **Retiring allaboutafrica-website and takeoffgo-website.** After that cutover.
- **Workers Builds for the host repo, and a production environment in its config.**
- **`0012_users_role_contract.sql`.** Spec 23's, released on its own schedule.
- **A first-class `folio export` / `folio import`** (spec decision 22).
- **A per-type site allowlist** and everything else in the spec's **Out of scope**.
- **A tag.** `docs/1.0-plan.md` owns `version` and tags.
