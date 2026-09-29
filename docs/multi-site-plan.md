# The multi-site plan, and how to work through it

This is the execution plan for spec 23, `docs/specs/foundation/multi-site.md`, and the
**briefing file every subagent on that work reads first**. The spec says what to build
and owns the design; this file says in what order, by whom, how each step is proven,
and how the result reaches `staging.allaboutafrica.au`. Where the two disagree on
*design*, the spec wins and the disagreement is a finding to report. Where they
disagree on *sequencing, gates or the consumer rollout*, this file wins.

Read this, then `CLAUDE.md`'s "Invariants that are easy to break by accident", then the
spec's **Ground truth**, **Architecture decisions** and **Implementation plan**. None
replaces the others.

## First message to send the new session

Paste this, unchanged, as the first message of the session that will run the build:

```
Build Folio spec 23 (multi-site) end to end, following docs/multi-site-plan.md. Read CLAUDE.md, docs/multi-site-plan.md, and the Ground truth and Architecture decisions in docs/specs/foundation/multi-site.md before the first edit. The spec's decisions are settled by me; do not reopen them. If the code contradicts the spec's Ground truth, stop and tell me rather than building on the spec. End state: staging.allaboutafrica.au running the new Folio with multi-site turned on, verified from the far side as the plan's final phase describes. Production allaboutafrica.au and takeoffgo.com stay on their current pins; 0012 is not applied anywhere in this run. Work the phases in the plan's order, parallel only where it says so; gate every phase by exit code and commit each phase on a local branch in this repo's statement-subject style; run an adversarial review after phases 1, 3, 5 and 7 and fix what it confirms before moving on. Confirm with me before each outward-facing step the plan lists, one line each on what changes and how to roll it back. The spec's forcing case is a real client: never name any client, brand, site or domain in this repo other than allaboutafrica and takeoffgo.
```

## Ground truth

Measured 2026-09-29 against `133bb7f`, before any of this was built. A later reader
re-measures rather than trusts it.

- **Nothing of spec 23 exists.** No `site_id` column, no `src/core/sites.ts`, no
  `0011`. Migrations on disk are `0001`–`0008` and `0010`; `0009` is a permanent gap
  (the spec's Ground truth says why).
- **`package.json` is `version: "0.0.0"` and no tag exists.** The 1.0 run
  (`docs/1.0-plan.md`) has phases 5 and 6 still to go. This plan cuts no tag and does
  not touch `version`; its release is a push to `origin/main`.
- **Consumer pins at plan time**, to be re-read in Phase 0, not trusted:
  - `allaboutafrica-website` `main` (production) pins
    `3acc67edec8536459abe6714c3210a9b5f586aee`. Its `origin/staging` branch is six
    commits behind `main` and an ancestor of it.
  - `takeoffgo-website` pins `133bb7fb8f9e6f764a74fdc88556f9bf6da268bb`.
- **AAA staging deploys from a laptop.** The live staging version (`cea6224c…`,
  2026-09-24) carries `workers/triggered_by: version_upload`, source `wrangler`, and
  has **no `JAMBO` service binding**. AAA's own `CLAUDE.md` says Workers Builds deploys
  a push to `staging`; this plan deploys with `npm run deploy:staging` and does not
  push AAA's `staging` branch, so it does not depend on which of the two is current.
- **AAA's working tree is dirty with somebody else's work**: an uncommitted
  `wrangler.jsonc` hunk adding a `JAMBO` service binding to `jambo-web-staging`'s
  `DocumentService`. A laptop deploy ships the working tree, so deploying from that
  checkout would ship an unreviewed binding that the live staging Worker does not
  have. **Every AAA build and deploy in this plan runs from a clean `git worktree`**,
  and the main checkout is never modified.
- **AAA's Folio surface** (what multi-site forces it to change): `workers/app.ts`
  (`folio.handle`, `cacheVerdict`, `cacheKey`, the `CachedPages` loopback, crons);
  `app/routes/page.tsx:94` `folio.reader(env, request)`; three calls of
  `folio.reader(env)` **with no request** at `app/routes/sitemap-xml.tsx:49`,
  `app/lib/page-index.server.ts:30`, `app/lib/guide-index.server.ts:51`;
  `app/folio/config.server.ts` configures no `route` and no `sites`;
  `NON_CANONICAL_HOST = /^staging\./` in `workers/app.ts` decides which hosts get
  `x-robots-tag: noindex`. `scripts/folio-pages.mjs`, `scripts/folio-contact.mjs` and
  `scripts/media-ingest.mjs` take `FOLIO_BASE` (documented as
  `https://staging.allaboutafrica.au/folio`) and write through `${FOLIO_BASE}/api/v1`
  (`scripts/lib/folio-api.mjs:17,37`, `media-ingest.mjs:97`). **`media-ingest.mjs:63`
  names its per-environment key map after `FOLIO_BASE`'s hostname**, and the staging
  map is committed as `scripts/lib/media-map.staging.allaboutafrica.au.json`: moving
  `FOLIO_BASE` to another host without renaming that file makes the next run start
  from an empty map and upload every image a second time.
- **`scripts/cache-probe.mjs` cannot probe a multi-site deployment as written.** It
  takes one base URL and writes through `${base}/folio/api/v1`. On multi-site a live
  host answers only `{base}/asset/:key` and `{base}/f/:id` (decision 12), so its write
  phase would 404. Phase 9 extends it.
- **Two spec inconsistencies, resolved here so nobody stops on them.**
  `folio.cacheProps` is `(req, env)` as in the spec's Core types; decision 15's snippet
  that omits `env` is the typo (the registry read needs the binding). And
  `folio.reader(env)` with **no** `from` on a multi-site deployment throws the same
  error the one-shot reads throw, naming `folio.reader(env, req | { site })`: silently
  answering as no site would make AAA's sitemap empty with nothing to say why.

## The decisions, and what each beat

The spec's nineteen architecture decisions and its five owner checkpoints are settled
(owner, 2026-09-29). **Do not re-litigate them.** If one proves wrong while building,
say so and stop rather than quietly building the alternative. This plan adds only
rollout decisions:

| Decision | Beat |
| --- | --- |
| The release is a push of `main` through `scripts/release.mjs`, no tag | cutting `1.0.0` with multi-site in it; holding multi-site for 1.0 |
| AAA's `sites` key is switched on by a **build-time define** set only by `build:staging` | an env-var read at request time (`createFolio` is module scope and `sites.admin` is a string); a staging-only branch of `config.server.ts` that a later fast-forward of `main` would carry into production |
| Registry rows for AAA staging are written by SQL immediately after `0011`, then re-written through the API after the deploy | writing them only through the API after the deploy, which leaves every CMS page on staging a 404 for the minutes between the deploy and the write |
| The browser matrix runs on the staging deployment, after release | a local run: the owner reaches this machine remotely and cannot open `localhost` pages in three browsers |
| `0012` is not written, applied or tested for real in this run | shipping expand and contract together, which decision 18 exists to forbid |
| **AAA staging's three hostnames** (owner, 2026-09-29): the admin origin moves to `staging-cms.allaboutafrica.au`; `staging.allaboutafrica.au` stays the `default` site's live host; the preview origin is `staging-preview.allaboutafrica.au` | keeping the admin on `staging.allaboutafrica.au` and moving the public staging URL; serving staging pages only on a preview origin, which 404s every CMS page on `staging.allaboutafrica.au` |
| **A second, cross-site browser pass** (owner, 2026-09-29), with the preview origin pointed for its duration at the staging Worker's `workers.dev` hostname by a registry edit | a same-site check alone: `staging-cms` and `staging-preview` share the registrable domain `allaboutafrica.au`, so the pane is a same-site iframe and the check passes whether or not partitioning works; a preview origin on a `takeoffgo.com` subdomain, which needs DNS on a second zone for a temporary test |
| Staging scripts address the site explicitly: `FOLIO_BASE=https://staging-cms.allaboutafrica.au/folio/~default` | minting every staging token bound to `default`, which works until somebody mints an unbound one and gets `400 site_required` |
| On the live host, a request for the admin (`/folio`, `/folio/…` other than `asset/` and `f/`) is redirected to the same path on the admin origin, behind the same define | leaving it to fall through to React Router's 404, which is what every editor's bookmark would find |
| Each phase is committed on the local branch `multi-site`; `main` is fast-forwarded to it only in Phase R | committing on `main` as the 1.0 run did, which puts half-built phases on the branch `release.mjs` publishes from |

## Why the order is what it is

Seven hard constraints. Everything else is grouped to keep two agents out of one file.

1. **Phase 1 first.** Every later phase's tests insert rows with `site_id` and read
   roles from `site_roles`. It is also the only phase whose mistakes reach four live
   databases, so it is gated hardest.
2. **Phase 2 before 3 and 6.** Both need `src/core/sites.ts` (`chain`, `sitesUnder`),
   `Resolution.site`, the scope header and `withScope`.
3. **3 and 6 run together, and only they.** Their file sets are disjoint (below).
4. **4 after 3 and 6.** Phase 3 owns `routes/api/documents.ts`, which phase 4 must
   edit to pass `opts.layer`; phase 4's purge assertions need phase 6's scoped tags.
5. **5 after 4.** Both edit `src/server/index.tsx` and `runtime.ts`, and "a preview
   never writes a layer into existence" is a phase 4 read path that phase 5's grant
   actor depends on.
6. **7 after 5, 8 after 7, 9 after 8.** Phase 7's hook payloads, v1 `pages` and MCP
   dispatch need grants and the status gate; the admin needs every route; the
   documents describe what landed.
7. **Release after 9 and a green `./scripts/e2e-all.sh`; staging after release.** A
   consumer pin must be a SHA reachable from `origin/main`, and `migrations_dir` in
   AAA's wrangler config is `node_modules/folio/migrations`, so `0011` reaches the
   staging D1 only through an installed pin.

## What the reviews of this spec found, as rules

The spec went through three adversarial reviews before this plan. Every rule here is a
defect a reviewer proved in a draft; each will come back if an agent is not told.

**Migrations.**
- A migration applies by **numeric prefix** on a fresh database (wrangler and
  `test/workers/apply-schema.ts`). A number lower than an existing migration cannot
  alter a table that migration creates. Prove every migration on a fresh database in
  filename order, not only on one that already has the later tables.
- **Re-keying a unique index breaks every `on conflict (<old columns>)` that named it**
  (`ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`). The
  statements are listed in the spec's Ground truth; they change in the same phase as
  the migration or that phase is red.
- **No triggers.** A mirroring trigger on `users` collided with the seeds' own grant
  insert on every fresh database, and on a rollback it minted `*` grants from any
  old-code patch (`updateUser` writes `role` on every patch). Decision 18 is the
  replacement; do not reintroduce one to close the migrate-to-deploy window.
- **Nothing relies on foreign-key enforcement, by design.** Every cleanup is an
  explicit `delete` in the same batch. D1 in workerd pins `PRAGMA foreign_keys` at 1
  (owner, 2026-09-29), so a test cannot turn it off and an `on delete cascade` in
  `0011` does fire there: an explicit delete is proved by recording the batch through
  a proxy, and revocation by expiring or revoking by `update`, so no cascade runs.
- **A source-text grep does not prove a column is unread.** `users.role` is read today
  as `u.role` and inside a `COLUMNS` string, neither of which the obvious pattern
  matches. The proof is `users-contract.test.ts`: run the real code against a
  database with `0012`'s statements applied.

**Phases that were not green on their own.** A draft's phase 2 claimed acceptance
criteria that needed site grants (phase 3), purges (phase 6) and the fork route
(phase 7). **A phase's tests exercise only what exists by the end of it**; a criterion
that needs a later phase is written in that later phase. If an agent finds it cannot
make a criterion pass without a later phase's file, that is a report, not a licence.

**Cross-origin preview.** The design converged only on the third pass; these are the
places it broke:
- **The gate must admit the handoff before a grant exists.** A draft site's preview
  origin serves nobody, so `site/enter`, `draft/enter`, `draft/exit`, `share` and
  `asset/:key` are admitted in every status (decision 4's table), or no one can ever
  preview a pre-launch site.
- **The grant check is a D1 read and lives in `handle()` / the reader**, after the
  synchronous candidate step, never in `sites.resolve`.
- **A grant is re-checked against the session and current roles on every read**
  (`readGrant`, one statement). Deleting grants on role change was rejected because a
  fifth role writer would forget.
- **`withActor` refuses a caller with no role on the scope before `site/start` can
  check preview eligibility.** `site/start` is the one `reach: 'preview'` route, and
  `scope-partition.test.ts` asserts that exemption list exactly.
- **A preview never writes.** Draft-mode `resolve()` on multi-site reads layers without
  `ensureSingleton`; otherwise a read-only grant creates rows and Durable Objects, and
  a draft site previewed once becomes undeletable.
- **MCP `preview_document` forwards no credentials to a preview origin**; it mints a
  token grant. Single-site keeps today's behaviour.

**Cache.**
- The Workers Cache key is path + entrypoint + `ctx.props` + version, not host. **The
  surface is in the props**, or a preview origin's `noindex` and `frame-ancestors` are
  served on the live site.
- **Layer tags are emitted for every chain scope whether or not a layer exists**, or a
  first-layer publish purges a tag no cached page carries.
- **What new tags need rides on the `Resolution`** (`site.chain`, `site.layered`,
  `path`), so `cacheTags(resolution, opts)` keeps its signature and a host calling
  `folio.cacheHeaders` directly still gets them.
- **The registry snapshot is read on `first-primary`**; a replica can hand an isolate a
  registry older than the last write. Registry edits purge twice, 25 s apart.

**Routing.**
- **The admin origin comes before any candidate**, so no registry row can take the
  admin offline.
- **Folio gates whatever `sites.resolve` answers.** A custom resolver chooses a
  candidate; it cannot make a group, `shared` or a draft site serve.
- **Internal headers are deleted from every inbound request** before `handle()` sets
  them (the `withIdentity` discipline), and MCP sets its scope header from its own
  `c.var.scope`, never from the client.

## Orchestration rules

From the September 2026 six-spec run, the August spec 24 run and the 1.0 run
(`docs/1.0-plan.md`, "Orchestration rules", all of which apply). The ones that bite
hardest here:

- **The main thread orchestrates and commits.** Subagents never commit. Commit per
  phase (phase 3 and phase 6 are two commits) on the local branch `multi-site`, cut
  from `main` in Phase 0, so a bad one is one revert. The branch is never pushed.
- **If the code contradicts the spec's Ground truth, stop and tell the owner** rather
  than building on the spec. A line number that has merely moved is not a
  contradiction; a behaviour or a constraint that is not what the spec says is.
- **Scope every agent by file, never by task.** Give it "your files, and only these",
  the concurrent agent's list when there is one, and: a failure in their files is not
  yours, report rather than fix. Every brief names this file, `CLAUDE.md` and the spec
  as required reading, and says which acceptance criteria the phase owns.
- **Never run `pnpm test` while an agent is live.** The workerd pool starves and a
  5-second test reports 346 s. While agents run, use
  `npx vitest run --project unit <file>` or `--project workers <file>`.
- **Never run two e2e scripts in one database, and never one without a reset.**
  `./scripts/e2e.sh <script>` resets; `./scripts/e2e-all.sh <script>…` runs a list with a
  fresh database each.
- **Ban file-level `cp` backups.** For a break-it check, revert in place.
- **Verify by breaking it.** Every agent disables the invariant its phase turns on and
  reports which test goes red. Each phase below names the breaks. **If an agent does
  not report them, run them yourself before committing**: it is the assertion most
  likely to be absent, and five vacuous assertions were found on the 1.0 run alone.
- **Verify the gates yourself, by exit code.** Never commit on an agent's report.
- **A stall tells you nothing.** `git status` for the file list, then the gates.
- **Correct a comment the change makes false, in the same commit.** An agent scoped by
  file reports these rather than editing; they are the orchestrator's to close.
- **An adversarial review after phases 1, 3, 5 and 7**: the `reviewer` agent, opus,
  given the phase's diff (`git diff <before>..HEAD` or the working tree before commit),
  the spec's decisions the phase implements with their rejected alternatives, and this
  file's review rules above. Tell it the gates are already green so it spends its budget
  on faithfulness and on breaking the code, and require it to **prove each finding by
  breaking or exercising the code** (a failing test, a sqlite3 session, a request),
  labelled confirmed or plausible. Fix confirmed findings before the commit, in the same
  phase; record anything deferred in the spec's Implementation notes with a reason.
- **This run does not share the tree with the 1.0 run.** 1.0's phases 5 and 6 touch
  `package.json`, `README.md`, `UPGRADING.md` and `scripts/release.mjs`. Do not start
  either while the other has an agent live.
- **`CLAUDE.md` is edited by the main thread only**, at the end of Phase 9: it is the
  file every agent reads first, so an agent editing it mid-run changes its own brief.

### Gate discipline

- `pnpm typecheck` — exit code.
- `./node_modules/.bin/biome ci .` — **the direct binary**, exit code. `pnpm exec biome`
  can be rewritten by a shell hook into something that prints `Lint: No issues found`
  and never runs biome.
- `pnpm test` — exit code, with no agent running.
- `cmd | tail; echo $?` is `tail`'s status. Never gate on a piped command.
- `pnpm build` and `pnpm build:demo` at phase boundaries 5, 8 and 9, and whenever
  `src/admin/main.tsx` or an entry import changes: a broken static import ships the
  admin unstyled and exits 0.

### Commits

Read `git log --format=%s -30` before the first one. Subjects state what is now true,
with no `feat:`/`fix:` prefix and no trailing period (*"Every row belongs to one scope;
0011 adds the site dimension and the role table"*). The body argues the decision,
names the alternative it beat, and says plainly when there is a sanctioned behaviour
change. Add whatever attribution trailer the session's instructions require. In
`allaboutafrica-website` the convention is Conventional Commits
(`chore(deps): bump folio to <sha7> for multi-site`), per its `CLAUDE.md`.

## Steps that need the owner's confirmation

Ask before each, every time, with the one line below. Approval for one is not
approval for the next.

| # | Step | What changes | Rollback |
| --- | --- | --- | --- |
| C1 | Phase R: `node scripts/release.mjs --push` | `origin/main` moves to the multi-site head, which is publishing; nothing installs it until a pin is bumped | Consumers stay on their pins; a bad head is fixed forward with a new commit, never a force push, which would orphan pins |
| C2 | Phase S, step 3: two new Workers custom domains on the `allaboutafrica.au` zone, `staging-cms.allaboutafrica.au` and `staging-preview.allaboutafrica.au`, both on `allaboutafrica-website-staging` | Two new proxied DNS records and their certificates; both names answer the current staging code until C4 | Detach both custom domains (Workers → `allaboutafrica-website-staging` → Settings → Domains & Routes), which deletes the records they created; the saved listing from step 2 shows nothing else existed at those names |
| C3 | Phase S, steps 5–7: apply `0011` to `allaboutafrica-folio-staging` and write its registry rows, after the export and bookmark are saved | Staging D1 gains the site dimension, `site_roles`, `site_grants` and the `default` site's hosts | `wrangler d1 time-travel restore allaboutafrica-folio-staging --env staging --bookmark=<saved>`, or re-import the saved export into a fresh database; either way redeploy the previous staging version |
| C4 | Phase S, steps 8–9: deploy staging from the pinned worktree | `staging.allaboutafrica.au` runs the new Folio with multi-site on; the admin moves to `staging-cms.allaboutafrica.au`, so staging editors sign in again there and re-enrol any passkey; open editor tabs are told to reload (wire version 5); the staging Worker's `workers.dev` hostname is switched on for Phase V's cross-site pass | `npx wrangler rollback <version id saved in step 2> --env staging`. Old code runs against `0011` except that it cannot create a form or an asset tag, so take C3's rollback too unless staging can go without both |

## Progress

Updated as each phase lands: the commit, and a one-line note of where the spec was
wrong. Each phase's own `## Implementation notes` entry in the spec has the detail.

| Phase | Commit | Note |
| --- | --- | --- |
| 0 | — | Baseline at `5bd256c`: five gates green, 4433 tests, 22/22 e2e. Pins unchanged. Staging D1 at `0010`. Probe: 6 pass, 1 skip (no token). Ground truth: 105 claims OK, 6 moved lines, 1 contradicted — foreign keys cannot be turned off in workerd (owner: prove by proxy batch and by `update`) |
| 1 | `cb51211` | Review: no roll-forward statement (a demotion made by old code came back), and the window rule missed tags and forms; both added to `UPGRADING.md`. Re-keyed indexes made every unbound lookup a scan; carried to 2 and 7 |
| 2 | `49f9a38` | Within one scope a redirect still beats an unpublished row (today's `pathMiss`, pinned); index seeks reordered rows the single-site pin caught |
| 6 | `df19d4a` | `checkpointed` purges nothing: a checkpoint publishes nothing |
| 3 | `13c6866` | Review: MCP `preview_document`, the form routes and the share list reached across sites; fixed, and the partition test now derives every id route from Hono |
| 4 | `49b85c4` | `default` seeds bare once `sites` is on (the chain rule); `diff` and `PUT /content` needed the `bare` option too |
| 5 | `0dda0eb` | Review: two critical — every non-grant credential passed `allows()` alone on the render paths, and `frame-ancestors` replaced an SVG asset's sandbox CSP — plus a pre-existing `safeNext` tab bypass; all fixed and re-reviewed |
| 7 | `3a8d561` | Review: no leak; deleting a fork wrote an auto-redirect that blocked fallback; fixed |
| 8 | `d176235` | `/me` carries one `sites` object; the asset and form pickers cannot badge by scope yet |
| 9 | `a013f58` | A grant alone did not give a host's `reader.page()` drafts, against decision 13 step 4; fixed to the spec. Release gate green: 5091 tests, 22/22 e2e |

## The phases

`implementer`, `reviewer` and `mechanic` are the agents in the session's agent table.
Sizes follow `PARITY.md`: **S** about a day, **M** a few days, **L** a week or two. Relative weight, not a quote.

---

### Phase 0 · Baseline

**Do it yourself.** Nothing moves until the harness is honest and the tree is clean.

1. `git status` in `/Users/brendan/work/personal/folio`. If the spec rewrite and its
   pointer edits (`docs/specs/foundation/multi-site.md`, `docs/specs/README.md`,
   `CLAUDE.md`, `UPGRADING.md`, `docs/1.0-plan.md`, this file) are uncommitted, commit
   them as one commit on `main` first. `release.mjs` refuses a dirty tree, and a phase
   diff must not carry them. Then `git checkout -b multi-site`.
2. All five gates by exit code: `pnpm typecheck`, `./node_modules/.bin/biome ci .`,
   `pnpm test`, `pnpm build`, `pnpm build:demo`. Record the test count.
3. `./scripts/e2e-all.sh`. Record which of the 22 are green. A script red before
   Phase 1 is not Phase 1's bug, and without this line that is unknowable.
4. Re-read both consumer pins (`grep '"folio"' package.json` in each) and record them
   in Ground truth above if they moved.
5. Read-only, against staging, from AAA's main checkout (a read ships nothing, so its
   dirty tree does not matter here):
   `npx wrangler d1 execute allaboutafrica-folio-staging --remote --env staging --command "select name from d1_migrations order by id"`.
   Expect `0001`–`0008` and `0010`, nothing later. Then
   `node scripts/cache-probe.mjs https://staging.allaboutafrica.au` with no token, from
   Folio: record the single-site read-only result as the before picture.

**Done when:** the tree is clean, five gates and the 22-script baseline are recorded
under Progress.

---

### Phase 1 · The migration and the role table (behaviour-identical)

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 1, items 1–9 | `migrations/0011_sites.sql` (new); `src/server/asset-tags.ts`, `src/server/forms.ts`, `src/server/redirects.ts`; `src/server/auth/users.ts`, `auth/session.ts`, `auth/sign-in.ts`, `auth/events.ts`, `routes/access.ts`; `src/core/story.ts`, `src/server/stories.ts` (`COLS`, write binds); `examples/demo/seed.sql`, `examples/starter/seed.sql`; `test/workers/migrations.test.ts`, `pagination.test.ts`, `auth-http.test.ts`, `auth-session.test.ts`, `users-contract.test.ts` (new); `docs/configuration.md`, `docs/handbook.md` (bootstrap SQL only); `UPGRADING.md` | `implementer`, **opus** | M |

Opus because the whole phase is correctness chores that fail silently: a rebuilt table
that drops a column or an index, a conflict target left on the old key, a seed that
works before `0012` and not after. **The migration text is the spec's
"D1 migration `0011_sites.sql`" section verbatim**; an agent that wants to change it
reports why instead.

**Proof, beyond the spec's list:**
- On a fresh database, `0001`–`0008`, `0010`, `0011` in filename order, then the demo
  seed: every statement succeeds and the seeded admin signs in with a `*` admin grant.
  Then with `0012`'s two statements applied too.
- On a database seeded with users at every role before `0011`: each holds exactly one
  `*` grant at their role and `role_from`.
- The index set before and after differs only by the intended re-keys: dump
  `select name, sql from sqlite_master where type = 'index'` on both and diff.

**Break-it checks:** remove the explicit `delete from site_roles` in `deleteUser` (the
proxy-batch test must go red); put `asset-tags.ts`'s conflict target back to
`(slug)` (red); reintroduce one `u.role` read in `readSession` (`users-contract` red);
drop `stories_edited`'s coalesce (red, `migrations.test.ts`).

**Gates:** the four, then `./scripts/e2e-all.sh` in full: seeds changed, so all 22 are
this phase's regression gate.

**Review:** yes. Give the reviewer the migration rules above and ask it to apply the
migration in sqlite3 on a fresh database and on one built from `0001`–`0010` with rows
in every rebuilt table.

---

### Phase 2 · Registry, scopes, resolution and fallback

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 2, items 1–10 | `src/core/sites.ts` (new), `src/core/schema.ts` (`validateTypes` charset); `src/server/sites.ts` (new); `src/server/types.ts`; `src/server/runtime.ts`; `src/server/stories.ts`, `src/server/redirects.ts`; `src/server/query.ts`; `src/server/index.tsx`; `src/server/middleware.ts` (`withScope` only); `src/server/routes/sites.ts` (new), its mount in `src/server/app.ts`; `test/unit/core/sites.test.ts`, `test/unit/core/schema.test.ts`, `test/unit/server/sites.test.ts`, `test/workers/multi-site.test.ts` (new) | `implementer`, **opus** | L |

The largest phase and the one every later phase stands on. Two things the spec leaves
implicit and this plan fixes: `folio.reader(env)` with no `from` throws on a
multi-site deployment (Ground truth above), and `folio.cacheProps` is `(req, env)`.

Its tests are the spec's phase 2 item 10 **and nothing that needs grants, purges or the
fork route**: forks are written directly in SQL, and `folio.settings` is tested over a
hand-built resolution.

**Break-it checks:** drop `site_id in (…)` from `storiesFor` (the Isolation reference
test goes red); make `pickServing` ignore redirects (the redirect-beats-inherited-page
test goes red); remove the admin-origin precedence (the preview-origin-equals-admin
criterion goes red); let `gate` accept a `kind = 'group'` candidate from a custom
`resolve` (red); read the registry on the default session instead of `first-primary`
(a `sites.test.ts` assertion goes red, or that test is missing and is owed).

**Gates:** the four; `./scripts/e2e-all.sh scripts/redirects-test.mjs scripts/collections-test.mjs scripts/search-test.mjs scripts/globals-test.mjs scripts/pagination-test.mjs scripts/api-test.mjs scripts/draft-mode-test.mjs scripts/gate-test.mjs`.
Single-site must be untouched: **before editing anything**, the agent adds a workers
test that pins, at the Phase 1 head, the Cache-Tag header and the Resolution payload of
a published demo-shaped page, and that test stays green unchanged through this phase
and every later one.

---

### Phases 3 and 6 · Permissions, and the cache (in parallel)

The only phase pair that runs at once. **Verify the two file sets are disjoint before
launching, and give each agent the other's list.**

| Phase | Work | Files | Agent | Size |
| --- | --- | --- | --- | --- |
| **3** | Spec phase 3, items 1–6 | `src/server/auth/*` (`roles.ts`, `config.ts`, `roles-from.ts`, `sign-in.ts`, `tokens.ts`), `src/server/middleware.ts`, `src/server/routes/access.ts`, `src/server/routes/editor.ts`, `src/server/routes/sites.ts`, the id loaders in `src/server/routes/*` including `routes/api/documents.ts`; `test/workers/scope-partition.test.ts` (new), `auth-login.test.ts`, `test/unit/server/roles-from.test.ts` | `implementer`, **opus** | M |
| **6** | Spec phase 6, items 1–4 | `src/core/cache-tags.ts`, `src/server/cache-purge.ts`, the one purger-construction line in `src/server/runtime.ts` (`:956` at `133bb7f`; find it by `purger`, not by number); `test/unit/core/cache-tags.test.ts`, `test/unit/server/cache-purge.test.ts` | `implementer`, **sonnet** | S–M |

**3 is opus** because every platform-tier gate is a place a bound token can climb to
the whole deployment, and one missed loader is a fence with a gap. **6 is sonnet**
because it is pure functions over a resolution with an exact tag table to match.

**Phase 6's edge:** `deleted`, `pathsChanged` and `redirectsChanged` payloads carry no
scope until Phase 7, so their owner-scoped purges are Phase 7's. An agent that reaches
for `hooks.ts` here has left its files.

**Break-it checks, 3:** let a bound token through one platform route
(`scope-partition` red); remove the `reach: 'preview'` exemption (red); mint an
`admin`-scoped token with a binding (400 test red); make `roleFromClaim` pick the
highest match across scopes rather than per scope (red); render a site editor's
socket with the `*` role instead of the effective role on a shared story (red).

**Break-it checks, 6:** add one tag to the single-site set (byte-identical test red);
emit `global:<name>@<scope>` only for layers present (first-layer test red); drop the
second `purgeSite` purge (red).

**Gates:** each agent runs only `npx vitest run --project … <its files>` while the
other is live. After both report: the four gates yourself, then
`./scripts/e2e-all.sh scripts/auth-test.mjs scripts/passkey-test.mjs scripts/api-test.mjs scripts/mcp-test.mjs scripts/bulk-test.mjs scripts/records-test.mjs`.
Commit 3 and 6 separately, 6 first if both are green (smaller, and 3's review may
send it back).

**Review:** after 3, not 6.

---

### Phase 4 · Layered globals, settings and `unset`

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 4, items 1–6 | `src/core/mutations.ts`, `src/core/protocol.ts` (`PROTOCOL_VERSION = 5`), `src/server/story-do.ts` (the `set` path only); `src/core/layers.ts` (new); `src/server/runtime.ts` (`resolve()`, `seed()`); `src/core/nested.ts`; `src/server/routes/api/documents.ts` (`opts.layer` only); `src/server/index.tsx` (`reader.global`); `src/server/audit.ts`; `test/unit/core/layers.test.ts`, `test/unit/core/mutations.test.ts`, `test/workers/globals.test.ts`, `test/workers/read-session.test.ts` | `implementer`, **sonnet** | M |

The rules that went wrong in drafts, restated so the agent cannot miss them: **only a
layer with something below it starts bare** (`layerSeed`), so `shared` and `default`
seed exactly as today; `null` in `i18n` still means untranslated, never removed;
*Override* on a `max: 1` field inserts an empty child of the inherited type; on
multi-site, draft mode reads layers **without** `ensureSingleton`.

**Break-it checks:** seed a site layer with defaults (the "every field reads
inherited" test red); call `ensureSingleton` in multi-site draft mode (the "no row and
no Durable Object created" test red); treat an `i18n` `null` as removed (red); seed the
`shared` layer bare (the "carries the type's defaults and preset" test red);
single-site `read-session.test.ts` statement counts must not move.

**Gates:** the four; `./scripts/e2e-all.sh scripts/globals-test.mjs scripts/sync-test.mjs scripts/i18n-test.mjs scripts/history-test.mjs scripts/fields-test.mjs scripts/space-test.mjs`.
Every e2e script imports `PROTOCOL_VERSION` from source, so the bump carries them; a
script that hard-codes `4` hangs rather than fails, and is this phase's to fix.

---

### Phase 5 · Preview, draft mode and shares across origins

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 5, items 1–6 | `src/server/auth/grants.ts` (new), `auth/cookie.ts`, `auth/resolve.ts`, every session-deleting path (`auth/session.ts`, `auth/sign-in.ts`, `auth/users.ts`), and `site_grants` in the `folio.sweepAuth` sweep (`index.tsx`); `src/server/routes/handoff.ts` (new) and its mount in `app.ts`; `src/server/index.tsx`; `src/server/routes/draft.ts`, `routes/preview.ts`; `src/server/mcp/shot.ts`; `src/server/cache-request.ts`; `src/admin/hooks/usePreviewBridge.ts`, `src/preview/mount.tsx`; `test/workers/multi-site.test.ts` (preview sections), `auth-session.test.ts` (grant revocation), `test/unit/server/cache-request.test.ts` | `implementer`, **opus** | M–L |

Opus, and reviewed, because this is the security boundary between an admin origin and
fifty preview origins, and every draft of it had a hole. The handoff trace in decision
13 is the specification of record; the agent implements the four steps in order and
tests each.

**The browser matrix the spec puts at the end of this phase moves to Phase V.** No test
here can observe a partitioned cookie in a real browser, and the owner cannot open a
page on this machine; the deployment is the first place it can be seen. The cost,
accepted: a browser-level defect is found after release and is fixed forward. Record
the move in the spec's Implementation notes.

**Break-it checks:** remove the `sessions` join from `readGrant` (the revocation test,
with the session expired by `update`, red); remove the current-`site_roles` condition (the "grant removed on the
Access screen while keeping a session" test red); consume the code with a select then
an update (a double-redemption test red, or it is missing and owed); drop `safeNext` on
the second hop (red); let a `GrantActor` reach one `{base}/api` admin route (red);
forward the caller's `cookie` from `shot.ts` on multi-site (red); remove the grant
cookie from `cacheVerdictFor`'s bypass list (`cache-request.test.ts` red).

**Gates:** the four, `pnpm build`, `pnpm build:demo`;
`./scripts/e2e-all.sh scripts/preview-share-test.mjs scripts/draft-mode-test.mjs scripts/mcp-test.mjs scripts/auth-test.mjs`.

**Review:** yes. Hand the reviewer decision 13 and the cross-origin rules above, and
ask it specifically to try: a code redeemed on another site's preview origin; a grant
presented on a live host; a shared-only publisher at `site/start`; a draft site's
`share` with no grant.

---

### Phase 7 · The remaining surfaces

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 7, items 1–5 | `src/server/assets.ts`, `asset-folders.ts`, `asset-tags.ts`, `asset-bulk.ts`, `routes/assets.ts`; `forms.ts`, `form-responses.ts`, `routes/forms.ts`; the redirects, schedules and shares list routes; `routes/content.ts`, `routes/stories.ts`, `routes/history.ts`; `routes/api/*` (except the phase 3 loaders, which are done); `routes/mcp.ts`; `space-events.ts`, `routes/space.ts`, the space line in `runtime.ts`; `hooks.ts`, `server/documents.ts`, `redirects.ts`, `cache-purge.ts` (the three remaining owner-scoped purges); `routes/sites.ts` (`purgeSite`, `siteChanged`); `test/workers/multi-site.test.ts`, `scope-partition.test.ts`, `api-partition.test.ts` | `implementer`, **sonnet** | L |

Sonnet because each surface follows a pattern phases 2 and 3 established; reviewed
because the pattern has to be applied to every one, and the one it skips is a leak.
**`api-partition.test.ts` pins `{base}/api` against `{base}/api/v1`**: the new v1
routes (`sites/resolve`, `sites`, `pages/{path}`) are a promise and are added there
deliberately, not by loosening the test.

**Break-it checks:** honour a client-sent internal scope header on MCP dispatch (red);
broadcast a space event to `space` instead of `space:<scope>` (red); make a hook
payload's `purge` differ from what the purger issued (red); drop the status gate from
`GET /pages/{path}` (the draft-site headless criterion red); let a fork land under a
parent the site does not own (409 test red).

**Gates:** the four; `./scripts/e2e-all.sh scripts/forms-test.mjs scripts/collections-test.mjs scripts/redirects-test.mjs scripts/scheduled-test.mjs scripts/space-test.mjs scripts/api-test.mjs scripts/mcp-test.mjs scripts/bulk-test.mjs scripts/search-test.mjs scripts/migrate-test.mjs`.

**Review:** yes. Ask the reviewer to walk `scope-partition.test.ts`'s route list against
the mounted routes and name any route it does not cover.

---

### Phase 8 · The admin

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 8, items 1–7 | the spec's list: `src/admin/me.ts`, `ui/Admin.tsx`, `ui/route.ts`, `ui/useRouter.ts`, `TopBar.tsx`, `Sidebar.tsx`; `ui/screens/Sites.tsx` + `sites-model.ts` (new) and one dialog on `useFocusTrap`; `Home.tsx`, `home-model.ts`, `EditorShell.tsx`; `Inspector.tsx`, `inspector-model.ts`, `fields/FieldRow.tsx`; `Access.tsx`, `access-model.ts`, `AccessInviteDialog.tsx`, `AccessTokenDialog.tsx`; `AssetPicker.tsx`, `fields/DocumentPicker.tsx`, `fields/FormField.tsx`; `test/unit/admin/render/**` | `implementer`, **sonnet** | L |

The 1.0 run's admin rules apply in full: impossible controls are absent, decided in
`me.ts` rather than by `role === 'admin'` in a screen; logic with a loading state goes
in a pure `*-model.ts` with a unit test, because a render test cannot see a loading
state; one focus trap; every portal re-declares `scoped()`. **A single-site deployment
must look exactly as today**: no scope switcher, no Sites screen, no layer labels.

**Break-it checks:** render Sites as a site admin and as `auth: 'open'` (the platform
gate must hold for the first and match the spec's edge case for the second); remove
`scoped()` from the new dialog's portal (`ui-scope.test.ts` red); render the Inspector
single-site and assert no layer label.

**Gates:** the four, `pnpm build`, `pnpm build:demo`.

---

### Phase 9 · Documentation, and the probe

| Work | Files | Agent | Size |
| --- | --- | --- | --- |
| Spec phase 9 | `README.md`, `AGENTS.md`, `docs/handbook.md`, `docs/configuration.md`, `UPGRADING.md`, `docs/specs/README.md`, `docs/specs/platform/caching.md`, the spec's `## Implementation notes` | `implementer`, **sonnet** | M |
| The multi-site probe | `scripts/cache-probe.mjs` | same agent | S |
| The brief | `CLAUDE.md` | **do it yourself** | S |

**The probe** is not in the spec's file list and is required by its Testing section.
It gains `--admin <origin>` (where the v1 writes go) and `--site <id>` (the `~<site>`
segment on them), and `--preview <origin>` to probe the same path on the preview
surface. With them it reports, for one path: a MISS then HIT on the live host; a MISS
on the first preview-origin request after the live host is warm (the entries are
separate because the surface is in the props); and after a publish, both entries
purged by one tag purge. Without the new flags it behaves exactly as today, so a
single-site run is unchanged.

**`UPGRADING.md`** carries, beyond the spec's list: apply `0011` then deploy within
minutes; no role changes or invitations in between; the post-deploy grant statement;
the rollback statement; turning `sites` on is the point of no return; `0012` is the
release after and must not be applied in the same step.

**`CLAUDE.md`, by the main thread:** the migrations ledger (ten migrations, `0011`
landed, `0012` the release after, next free `0013`); `PROTOCOL_VERSION` is 5; the new
invariants: every id-set read takes the chain; internal scope and site headers are
deleted from every inbound request; a preview never writes; a grant is re-checked
against current roles on every read; `folio.reader` needs a request or a site on a
multi-site deployment.

**Gates:** the four, `pnpm build`, `pnpm build:demo`, then **`./scripts/e2e-all.sh` in
full**, which is the release gate. `node scripts/cache-probe.mjs --help` answers the new
usage.

---

### Phase L · AAA against the local Folio (rehearsal, nothing outward)

| Work | Files (in `allaboutafrica-website`) | Agent | Size |
| --- | --- | --- | --- |
| Wire multi-site behind a staging-only define, and move staging's admin | `vite.config.ts`; `app/folio/config.server.ts`; `workers/app.ts`; `wrangler.jsonc` (`env.staging` only); `app/routes/sitemap-xml.tsx`, `app/lib/page-index.server.ts`, `app/lib/guide-index.server.ts` and the loaders that call them; `scripts/folio-pages.mjs`, `scripts/folio-contact.mjs`, `scripts/media-ingest.mjs` (usage comments and the `:57` map note); `scripts/lib/media-map.staging.allaboutafrica.au.json` (renamed); `docs/folio-cms.md`; `CLAUDE.md` (the Deployment table) | `implementer`, **sonnet** | S |

Runs in a git worktree of AAA's `main`
(`git -C /Users/brendan/work/takeoffgo/allaboutafrica-website worktree add <scratchpad>/aaa-multisite -b folio-multi-site main`),
never in the main checkout, whose uncommitted `wrangler.jsonc` belongs to someone else.
The dependency itself is not committed in this phase.

1. In Folio: `pnpm build`. In the worktree:
   `npm install --install-links file:/Users/brendan/work/personal/folio`. Reinstall
   after every Folio change. **Never commit this dependency.**
2. **`vite.config.ts`** defines `__FOLIO_SITES_ADMIN__`: the string
   `https://staging-cms.allaboutafrica.au` when `process.env.CLOUDFLARE_ENV === 'staging'`
   (which `build:staging` sets), `http://localhost:5173` when `FOLIO_SITES_LOCAL=1`
   (this rehearsal only), and `null` otherwise. **`config.server.ts`** passes
   `sites: { admin: __FOLIO_SITES_ADMIN__ }` only when it is non-null, so a production
   build (`npm run build`) has no `sites` key at all and a later fast-forward of `main`
   onto this commit cannot turn multi-site on in production.
3. **`route`** in `config.server.ts`: `(path, _locale, site) => …` answers an absolute
   URL on the site's first live host (`validateSites` requires it on multi-site), and
   today's relative path when `site` is absent.
4. **`workers/app.ts`**:
   - the loopback becomes
     `this.ctx.exports.CachedPages({ props: await folio.cacheProps(request, this.env) }).fetch(…)`;
   - `NON_CANONICAL_HOST` becomes `/^staging[.-]|\.workers\.dev$/`, so
     `staging.allaboutafrica.au`, `staging-cms.allaboutafrica.au`,
     `staging-preview.allaboutafrica.au` and the Worker's `workers.dev` hostname are all
     `noindex`, and `allaboutafrica.au` is not; its comment at `:105` names all four;
   - when `sites` is on and the request's host is neither the admin origin nor a
     preview origin (`folio.cacheProps(…).surface !== 'preview'`; redirecting a
     preview origin bounced the handoff's `site/enter`, found in this phase), a `GET` or
     `HEAD` for `/folio` or `/folio/…` other than `/folio/asset/…` and `/folio/f/…` is
     a `302` to the same path and query on the admin origin, before `folio.handle`.
5. **`wrangler.jsonc`, `env.staging` only**: `routes` gains
   `{ "pattern": "staging-cms.allaboutafrica.au", "custom_domain": true }` and
   `{ "pattern": "staging-preview.allaboutafrica.au", "custom_domain": true }` beside
   the existing entry, so a deploy can never detach the domains C2 attaches; and
   `"workers_dev": true`, which is what gives Phase V's cross-site pass a hostname
   without DNS. The top level is not touched.
6. The three `folio.reader(env)` calls pass the request.
7. **Scripts**: every documented staging `FOLIO_BASE` becomes
   `https://staging-cms.allaboutafrica.au/folio/~default` (the `~default` segment is
   what keeps an unbound token out of `400 site_required`; production's stays
   `https://allaboutafrica.au/folio`, which has no `sites`). `git mv
   scripts/lib/media-map.staging.allaboutafrica.au.json
   scripts/lib/media-map.staging-cms.allaboutafrica.au.json`, because
   `media-ingest.mjs:63` keys the map by `FOLIO_BASE`'s hostname and an unrenamed map
   means every staging image uploaded twice. `media-audit.mjs`'s
   `SITE=https://staging.allaboutafrica.au` is unchanged: it crawls public pages,
   which stay on the live host.
8. **Docs**: `docs/folio-cms.md` and AAA's `CLAUDE.md` Deployment table say that on
   staging the admin is `https://staging-cms.allaboutafrica.au/folio`, drafts preview on
   `staging-preview.allaboutafrica.au`, and `staging.allaboutafrica.au/folio` redirects.
9. **Local smoke**, with `FOLIO_SITES_LOCAL=1 npm run dev` after
   `npx wrangler d1 migrations apply allaboutafrica-folio-staging --env staging --local`:
   the admin on `http://localhost:5173`, the `default` site's live host
   `aaa.localhost` and preview origin `http://preview.localhost:5173`, written through
   the local registry API (plain `http:` is valid on `*.localhost`). The magic link
   lands in `.wrangler/tmp/email/miniflare-*/email-text/*.txt`, not the console.
   Check: a CMS page renders on `aaa.localhost:5173`; `aaa.localhost:5173/folio`
   redirects to the admin; the pane previews a draft through `site/start`; the sitemap
   lists the same URLs as before, absolute on the live host.

**Gates (in the worktree):** `npm run typecheck` 0 errors; `npm run build:staging` exit
0; `npm run build` exit 0 **and** the production server bundle contains neither
`staging-cms` nor `localhost:5173` (grep the build output): the break-it check for the
define is that removing the `null` branch makes that grep find the string.

**Done when:** the smoke passes and the AAA changes are committed on the local
`folio-multi-site` branch with the dependency still at its old pin. Restore with
`git checkout -- package.json package-lock.json && npm install` before committing.

---

### Phase R · Release (C1)

**Do it yourself.**

1. Fast-forward `main` to the branch: `git checkout main && git merge --ff-only multi-site`.
   Tree clean on `main`, and the Phase L rehearsal passed against this head.
2. **Ask C1.** Then `node scripts/release.mjs --tag --push`. Despite its name, `--tag`
   creates no tag: it adds `./scripts/e2e-all.sh` to the three gates, then the
   consumer-install smoke test, then pushes only if all of them passed. Never
   `--no-gate`, which skips the smoke test as well, and never `--force`.
3. Read back from the far side: `git ls-remote origin main` equals `git rev-parse HEAD`.
   Record the 40-character SHA under Progress: it is the pin.

---

### Phase S · Staging (C2, C3, C4)

**Do it yourself.** One change at a time, verified before the next, and every
pre-change state saved to the scratchpad first: those files are the rollback.

**The three hostnames** (owner, 2026-09-29):

| Role | Hostname | What it serves |
| --- | --- | --- |
| Admin origin (`sites.admin`) | `staging-cms.allaboutafrica.au` (new) | The admin, sign-in, magic links, the registry, MCP. Passkeys (`rpId`) and sessions bind to it. |
| Live host of the `default` site | `staging.allaboutafrica.au` (unchanged) | Published pages. `handle()` answers only `/folio/asset/:key` and `/folio/f/:id` here; AAA redirects the rest of `/folio` to the admin origin. |
| Preview origin of the `default` site | `staging-preview.allaboutafrica.au` (new) | Drafts behind the grant, draft mode, shares, and published pages to anyone (the site is `live`). |

**What that costs, said to the staging editors before C4:** they sign in again at
`https://staging-cms.allaboutafrica.au/folio` (a session on
`staging.allaboutafrica.au` does not move); a passkey enrolled on staging stops
working and is enrolled again from the new origin; bookmarks to
`staging.allaboutafrica.au/folio` redirect; scripts use the new `FOLIO_BASE`.

1. **Worktree at the pin.** In the `folio-multi-site` worktree, set the dependency to
   `github:brendanmckenzie/folio#<Phase R SHA>` with plain `npm install`, confirm
   `package-lock.json` resolves that SHA and keeps `node_modules/@floating-ui/dom`, and
   commit (`chore(deps): bump folio to <sha7> for multi-site`). Gates as in Phase L.
2. **Save the before state** to the scratchpad: the staging Worker's current version id
   (`npx wrangler deployments status --env staging`); its domains and routes; the
   `allaboutafrica.au` zone's DNS records for `staging-cms` and `staging-preview` (none
   expected); and
   `npx wrangler d1 execute allaboutafrica-folio-staging --remote --env staging --command "select name from d1_migrations order by id"`.
3. **C2.** Attach `staging-cms.allaboutafrica.au` and `staging-preview.allaboutafrica.au`
   to `allaboutafrica-website-staging` as Workers custom domains (the same entries Phase L
   step 5 put in `wrangler.jsonc`, so the deploy in step 8 keeps them). Verify from
   the far side: `dig +short` answers for both, `curl -sI https://<each>/` returns the
   current staging code's home page, and `staging.allaboutafrica.au` is unchanged.
4. **Export and bookmark.**
   `npx wrangler d1 export allaboutafrica-folio-staging --remote --env staging --output <scratchpad>/aaa-staging-pre-0011.sql`
   (the database may pause queries while it exports; it is staging), and
   `npx wrangler d1 time-travel info allaboutafrica-folio-staging --env staging`, saving
   the bookmark. **Rehearse on the copy**: load the export into a local sqlite3
   database, apply `node_modules/folio/migrations/0011_sites.sql` and step 7's
   statements to it, and run step 6's read-back. A failure here costs nothing.
5. **C3.** Tell the owner: no role changes or invitations on staging until step 9
   finishes. Then, from the worktree,
   `npx wrangler d1 migrations apply allaboutafrica-folio-staging --remote --env staging`.
   Always `--env staging`; the top level of AAA's config is production.
6. **Read 0011 back** with `npx wrangler d1 execute allaboutafrica-folio-staging --remote --env staging --command "…"`:
   `d1_migrations` lists `0011_sites.sql` and no `0012`; `sites` holds the `default`
   row; `select count(*) from site_roles` equals `select count(*) from users` and every
   row is `scope_id = '*'`; `sql` of `stories_path` leads with `site_id`;
   `pragma table_info(stories)` ends `site_id, forked_from`. Save the output.
7. **Registry rows by SQL, still under C3**:
   `insert into site_hosts (host, site_id) values ('staging.allaboutafrica.au', 'default')`;
   `update sites set name = 'All About Africa', preview_origin = 'https://staging-preview.allaboutafrica.au', updated_at = unixepoch() * 1000 where id = 'default'`.
   Read both back.
8. **C4.** Brief the editors (above). From the worktree: `npm run deploy:staging`.
   **Never `npm run deploy`**, which deploys production. Save the `workers.dev` URL the
   deploy prints (`https://allaboutafrica-website-staging.<account subdomain>.workers.dev`)
   to the scratchpad: Phase V's cross-site pass needs it.
9. **Right after the deploy:**
   - run the decision 18 post-deploy grant statement and read back
     `select count(*) from users where id not in (select user_id from site_roles)` = 0;
   - sign in at `https://staging-cms.allaboutafrica.au/folio`, and mint an unbound
     admin token there for steps V2 and V5; keep it out of every file and commit;
   - re-write the `default` site's live host and preview origin through the registry
     (the Sites screen, or `PUT /folio/api/sites/default/hosts` and
     `PATCH /folio/api/sites/default` on the admin origin), so write-time validation
     runs and `siteChanged` and the `site:default` purge fire;
   - read back `GET https://staging-cms.allaboutafrica.au/folio/api/v1/sites/resolve?host=staging.allaboutafrica.au`
     (`{ site: default, surface: live }`) and `…?host=staging-preview.allaboutafrica.au`
     (`surface: preview`);
   - `curl -sI https://staging.allaboutafrica.au/folio` is a `302` to the admin origin,
     and `https://staging.allaboutafrica.au/` renders the home page.
10. **Production untouched, verified from the far side:** `npx wrangler deployments status`
    (no `--env`) shows the same version as before; `https://allaboutafrica.au` serves;
    AAA's `origin/main` `package.json` and takeoffgo-website's still pin their Phase 0
    SHAs.

---

### Phase V · Verification from the far side

**Do it yourself**, except the two browser passes, which are the owner's.

1. **0011 applied**: step S6's read-back, run once more after the deploy, and saved.
2. **Cache**:
   `node scripts/cache-probe.mjs https://staging.allaboutafrica.au --admin https://staging-cms.allaboutafrica.au --site default --preview https://staging-preview.allaboutafrica.au --token <the step S9 token>`.
   PASS lines needed: live MISS then HIT; preview MISS while live is HIT (separate
   entries, because the surface is in the props); after the probe's publish, both
   purged. With one site on the deployment this shows entries separated by surface;
   separation between two sites is covered by the workers tests and cannot be observed
   here. Quote the PASS lines in the Progress row.
3. **Headers**: a `staging-preview` page carries
   `content-security-policy: frame-ancestors https://staging-cms.allaboutafrica.au` and
   `x-robots-tag: noindex, nofollow`; a `staging.allaboutafrica.au` page carries
   `Cache-Tag` including `site:default`, carries `x-robots-tag`, and does not carry
   `frame-ancestors`.
4. **`0012` applied nowhere**: `d1_migrations` on staging has no `0012`, and
   `migrations/` in the released head has no `0012` file.
5. **Browser passes, owner.** Write the checklist below to
   `~/outbox/aaa-staging-preview-browser-check.md` and give the owner
   `hcograb aaa-staging-preview-browser-check.md`. Each pass runs in current Chrome,
   current Firefox and Safari 26.2 or later (Safari → About Safari shows the version),
   each with its default privacy settings.

   **Pass 1, the end state (same-site).** Preview origin
   `https://staging-preview.allaboutafrica.au`. In each browser:
   - sign in at `https://staging-cms.allaboutafrica.au/folio`, open a page, type a
     change; the pane shows the change (the draft, not the published page);
   - *Open preview in a new tab* shows the same draft top-level on `staging-preview`;
   - sign out in another tab, reload the pane: no draft;
   - sign in again, mint a share, open it in a private window with no account: that
     page's draft renders on `staging-preview`, and another path there does not.

   This proves the handoff and revocation. It does **not** prove partitioning: the admin
   and the preview origin share the registrable domain `allaboutafrica.au`, so the pane
   is a same-site iframe and would work with an ordinary cookie.

   **Pass 2, cross-site.** Before it, the orchestrator switches the preview origin to
   the `workers.dev` URL saved in step S8, by a registry edit and no DNS change: the
   Sites screen's preview origin for `default`, or `PATCH /folio/api/sites/default` on
   the admin origin with the platform token. Read back that
   `sites/resolve?host=<the workers.dev host>` answers `surface: preview` and
   `sites/resolve?host=staging-preview.allaboutafrica.au` answers `404` (for the
   duration of the pass, `staging-preview` serves no site; tell the owner). Because
   `workers.dev` is on the public suffix list, the Worker's hostname is a different
   site from `allaboutafrica.au`, and the pane becomes a cross-site iframe. In each
   browser, sign out and in again first, then open a page and type a change:
   - **Chrome**: the pane shows the draft. DevTools → Application → Cookies, selecting
     the `workers.dev` frame, lists `__Host-folio_grant` with **Partition Key Site**
     `https://allaboutafrica.au`. Then Settings → Privacy and security → Third-party
     cookies → *Block third-party cookies*, reload the pane: it still shows the draft.
     Restore the setting afterwards.
   - **Firefox**: the pane shows the draft. DevTools → Storage → Cookies for the
     `workers.dev` origin lists `__Host-folio_grant` with a **Partition Key** naming
     `allaboutafrica.au`.
   - **Safari 26.2+**: the pane shows the draft with *Prevent cross-site tracking* on
     (the default). Safari refuses an unpartitioned third-party cookie outright, so this
     is the browser that proves `Partitioned` is set. Web Inspector → Storage → Cookies
     lists `__Host-folio_grant`.
   - **All three**: no "your browser refused the preview cookie" screen appears; if it
     does, record the browser and version, and check that *Open preview in a new tab*
     still shows the draft top-level, which is the designed fallback. Then sign out in
     another tab and reload the pane: no draft.

   **Afterwards, switch back** the same way, to
   `https://staging-preview.allaboutafrica.au`, and read back both `sites/resolve`
   answers as in step S9. The registry edit purges `site:default` twice, so nothing
   cached during the pass outlives it.
6. Record both passes' answers in the spec's Implementation notes. A failure is a fix in
   Folio, released and re-pinned through R and S again.
7. Write the spec's Implementation notes' last line: what staging runs, the pin, and
   that `0012` (spec phase 10) is the release after, once this release is deployed
   everywhere it will be.

## Definition of done, per phase

In this order, before the commit:

1. The phase's proof and acceptance criteria, as listed above and in the spec.
2. Every break-it check, run by you if the agent did not report it.
3. `pnpm typecheck` — exit code.
4. `./node_modules/.bin/biome ci .` — the direct binary, exit code.
5. `pnpm test` — exit code, with no agent running.
6. The phase's e2e scripts through `./scripts/e2e-all.sh <scripts>` — exit code.
7. The review, for phases 1, 3, 5 and 7, with confirmed findings fixed.
8. Commit; add the row under Progress.

## What is deferred, so nobody builds it

- **Spec phase 10, `0012_users_role_contract.sql`.** The release after this one, once
  it is deployed everywhere. Not written in this run; `users-contract.test.ts` applies
  its two statements to its own database and that is all.
- **Production.** `allaboutafrica.au` stays on its pin. Its switch to multi-site is a
  separate change with its own hostnames and its own confirmations.
- **takeoffgo-website.** Not bumped.
- **A second site on staging.** The end state is one site; cross-site isolation is
  proven by workers tests.
- **A tag.** 1.0's phases 5 and 6 own `version` and tags.
- Everything in the spec's **Out of scope**.
