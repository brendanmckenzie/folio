> **Status:** input to the next design round, not a plan. Written 2026-09-30 at the end
> of the spec 23 build, as a read-only feasibility pass over Folio, allaboutafrica-website
> and takeoffgo-website. **The owner's direction since (2026-09-30):** treat every hard
> part below as a design problem to solve so that a multi-brand deployment is convenient
> for developers, AI coding agents and content authors — including brands that look
> nothing alike — rather than as a reason not to merge. The recommendation in §4 predates
> that direction and is kept as the baseline it replaces. File:line references are as of
> `11cfc71` and each repository's `main`; re-measure before building on one.

# Merging allaboutafrica and takeoffgo into one Folio deployment: feasibility

Read-only assessment, 2026-09-30. Nothing in any repository was changed.

Repos read:
- Folio: `/Users/brendan/work/personal/folio` at `11cfc71`.
- allaboutafrica (A): `/Users/brendan/work/takeoffgo/allaboutafrica-website`, `main`, plus branch `folio-multi-site` (worktree `.../scratchpad/aaa-multisite`, head `ddc30b8`).
- takeoffgo (B): `/Users/brendan/work/takeoffgo/takeoffgo-website`, `main`.

Both working trees have uncommitted wrangler changes. This assessment reads `git show main:wrangler.*` and ignores them.

## 0. The premise, corrected

The owner named the custom pages (`/quote`, `/invoice`, `/payment`) as the hard part. **They are the easy part.** A host's own routes win at any path, and `folio.handle()` returns `null` for anything it does not own. Neither brand's payment flow has an inbound callback: Stripe tokenises in the browser, and the charge is a GraphQL mutation to the travel-ops backend (Jambo, `api.takeoffgo.com`). So the custom pages can stay exactly where they are, in each brand's own Worker, under any option that keeps one Worker per brand.

The hard parts are these two:

1. **Decision 7: one block registry and one set of document types for the whole deployment.** It forces the two brands' block code into one build, whichever option is taken. The admin's preview pane renders drafts through Folio's own preview bundle, and that bundle is one per deployment. The brands collide on names too (`page`, `pageRoot`, `prose`).
2. **Moving content between deployments.** The spec lists this as out of scope (`docs/specs/foundation/multi-site.md:1788`), and no tool for it exists. Drafts and their history live in Durable Objects that belong to the old Worker's namespace, so they cannot be moved at all.

## 1. How each site is built and deployed today

| | allaboutafrica (A) | takeoffgo (B) |
|---|---|---|
| Framework | React Router 7 SSR, React 19, SCSS modules (`CLAUDE.md` "Architecture") | React Router 7 SSR, React 19, SCSS modules (`CLAUDE.md` "Stack") |
| Worker entry | `workers/app.ts`: gateway default export (`:280`) plus cached `CachedPages` entrypoint (`:181`), `pipeline` = `folio.handle` then RR (`:56`) | `workers/app.ts`: same shape, gateway `:222`, `CachedPages` `:113`, `pipeline` `:43` |
| Config file | `wrangler.jsonc`, top level = production, `env.staging` (`:150`) | `wrangler.toml`, top level (local), `[env.staging]` `:148`, `[env.production]` `:199` |
| Deploy | Workers Builds on push: `main` goes to prod, `staging` to staging (`CLAUDE.md` "Deployment") | Workers Builds on push, branch mapping set in the dashboard (`CLAUDE.md` "Deployment") |
| Account | pinned `account_id` (`wrangler.jsonc:9`) | not pinned in config |
| Folio pin | `3acc67e` on `main` (`package.json`), `45062ac` on `folio-multi-site` | `133bb7f` (`package.json`) |
| D1 | `FOLIO_DB`: `allaboutafrica-folio-production` / `-staging` (`:75`, `:209`) | `FOLIO_DB`: `takeoffgo-folio-production` / `-staging` (`:222`, `:171`) |
| Durable Objects | `FOLIO_STORY` (StoryDO, sqlite), `FOLIO_SPACE` (`:83`) | same names and classes (`:112`) |
| R2 | `FOLIO_MEDIA`: `allaboutafrica-folio-production` / `-staging` (`:99`, `:217`) | `FOLIO_MEDIA`: `takeoffgo-folio-production` / `-media-staging` (`:239`, `:188`) |
| Images | `IMAGES` (`:109`) | `IMAGES` (`:134`) |
| Email | `EMAIL`, sender `noreply@w.allaboutafrica.au` (`:118`). Used for sign-in, the enquiry email and the traveller-form ops email (`app/routes/traveller-form.tsx:282`) | `EMAIL`, sender `noreply@w.takeoffgo.com` (`:144`). Sign-in only |
| Crons | `*/5` runSchedules, `17 3` sweepAuth (`:69`) | identical (`:88`, `:155`, `:206`) |
| Caching | `exports.CachedPages.cache.enabled` (`:42`). `NEVER_CACHED` covers itinerary, quote, invoice, payment, legal, newsletter (`workers/app.ts:80`) | `[exports.CachedPages]` (`:61`). `hostVerdict` = one lowercase segment (`workers/app.ts:76`). `/invoice` and `/payment` are saved only by the `no-store` stamp |
| Secrets (names only) | `ANTHROPIC_API_KEY`, `JAMBO_URL`, `JAMBO_TOKEN`, `MAPBOX_TOKEN`, `MAILERLITE_API_KEY`, `MAILERLITE_GROUP_ID`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` (`env-secrets.d.ts`) | `JAMBO_TOKEN`, `JAMBO_URL`, `HUBSPOT_TOKEN`, `HCAPTCHA_SECRET_KEY`, `ANTHROPIC_API_KEY` (`env-secrets.d.ts`) |
| Captcha | Turnstile (`forms.verify`, `app/folio/config.server.ts:189`) | hCaptcha (`forms.verify`, `app/folio/config.server.ts:140`) |
| Stripe | publishable key in client code (`app/lib/stripe.ts`), `stripe.createToken` (`PaymentForm.tsx:98`), charge through Jambo `executePayment` (`app/routes/payment.tsx`) | publishable key picked by hostname (`app/lib/stripe.ts:4`), `createToken` (`PaymentForm.tsx:86`), charge through Jambo `executePayment` with an `input` object, which is a different generated shape from A's |
| Static assets | `public/`: `_headers`, `robots.txt`, `favicon.*`, `agents.txt`, `humans.txt` | `public/`: `_headers`, logos, fonts. `robots.txt` is a route |
| Folio config | types `page`(`pageRoot`), `guide`(`guideRoot`, under page) (`:108`). magicLink only. `describe`. `previewCss` from A's font CDN. `hooks.submitted` only for form `contact`. No `draftMode`, no `globals` | types `page`(`pageRoot`), `travelCard` record (`:47`). magicLink plus **passkeys** (`:286`). `draftMode: true` (`:193`). One content migration (`:180`). Hooks `pathsChanged`/`redirectsChanged` purge cached misses (`:89`, `:97`). `submitted` forwards every form to Jambo and HubSpot (`:116`). No `globals` |

**What they share:** the same Worker shape, the same Folio binding names, the same crons, the same backend (Jambo). The hashed Stripe publishable keys differ, so the brands use different Stripe keys and probably different accounts. **What conflicts:** everything that is a single value per Worker. That means the static asset directory, the root layout and global CSS, the generated Jambo client (two schema generations), the `JAMBO_*` secret names, the captcha provider, the Folio pin, and the Folio block and type names.

A's `folio-multi-site` branch already runs multi-site on **staging only**. The admin is `staging-cms.allaboutafrica.au`, the preview origin is `staging-preview.allaboutafrica.au`, and the live host is `staging.allaboutafrica.au`. It has one site, `default`, and no `settings` type. The switch is a build define, so a production build has no `sites` key (`vite.config.ts` in the branch diff). The branch also adds `adminRedirect` and `cacheProps` to `workers/app.ts`.

## 2. What a merged deployment looks like under Folio's model

**Fixed by the model, whatever option is taken:**
- One D1, one R2, one StoryDO/SpaceDO namespace, owned by whichever Worker calls `createFolio`.
- `sites.admin`: one origin for the admin, sign-in, passkeys, the registry and MCP (decision 12, spec `:676`). Editors of both brands sign in there.
- Two registry rows. A's content is already in `default`. On multi-site `default` is an ordinary site row, and its id is immutable. So A stays `default` (with the display name set to the brand), and B becomes a new site, `takeoffgo`. The `shared` scope stays empty, and there are no groups.
- Hostnames: each brand keeps its live hosts, and each gets a preview origin. No hostname may be two things (decision 1).
- **Globals and settings:** neither site declares `globals`, and neither needs `sites.settings`. With separate front ends, brand variation lives in each front end, not in a settings document. The layering machinery (decision 8) is not exercised.

**Decision 7 (spec `:523`) in practice:**
- `blocks` and `types` are one value each. Block names that collide: **`pageRoot`** and **`prose`**, with different fields on each side. Type name that collides: **`page`**. A's side has 44 blocks, B's has 10. This is not a merge of like with like.
- Resolution: keep A's names, because A's content stays in place, and rename B's (`tgPage`, `tgPageRoot`, `tgProse`) inside the import transform (section 4). Nothing needs a content migration, because B's content is written fresh into the merged D1.
- **Every block does not have to render on both sites.** With no `shared` content, a B page is only ever rendered by B's front end, and each front end's `FolioDoc` registry can hold only its own blocks. What the rule really costs is the **CMS build**. The admin's manifest, validation and, above all, the **preview bundle** are one per deployment: `assets.preview`, `previewCss` and `previewWrap` are single values (`src/server/types.ts:648`, `:670`, `:672`). `PreviewWrap` receives only `children` (`src/core/render-wrap.ts:14`), so it cannot tell which brand it is wrapping. B's blocks module imports B's global stylesheet (`app/folio/blocks/index.ts`, `import "../../styles/global.scss"`). In a combined preview bundle that stylesheet's resets and `--font-body` would apply to A's previews too.
- **Type menus leak across brands.** No per-site type list exists. A's editors will see B's page types and the `travelCard` record type in the sidebar and the "New" menu, and B's editors will see A's. `under` can keep B's pages under B's pages (`canNest`, `src/core/schema.ts:206`). But a type with `under` can never be a root (`src/server/stories.ts:1867`), so B needs a separate home type with no `under`: `tgHome` plus `tgPage` with `under: ['tgHome','tgPage']`. Cross-*site* trees are already impossible, because a parent must be in the same scope (`stories.ts:1863`).

## 3. The custom pages

Inventory, from `app/routes.ts` in each repo:

| Path | A | B | Needs |
|---|---|---|---|
| `/quote/:key` | `quote.tsx` (`:17`) | `quote.$key.tsx` (`:16`) | Jambo (`JAMBO_URL`, `JAMBO_TOKEN`), Mapbox |
| `/quote/:key/accept` | not present | `quote.$key.accept.tsx` (`:17`) | Jambo |
| `/itinerary/:key` | `itinerary.tsx` (`:14`) | `itinerary.$key.tsx` (`:18`) | Jambo, Mapbox |
| `/itinerary/:key/accept` | `itinerary-accept.tsx` (`:15`) | not present | Jambo |
| `/itinerary/:key/travellers` | `traveller-form.tsx` (`:16`) | not present | Jambo, Turnstile, `EMAIL` (ops copy carries passport data) |
| `/invoice` | `invoice.tsx` (`:18`) | `invoice.tsx` (`:12`) | Jambo |
| `/payment` | `payment.tsx` (`:19`) | `payment.tsx` (`:11`) | Jambo `executePayment`, per-brand Stripe publishable key |
| `/legal/doc/:id` or `/legal/:id` | `legal-doc.tsx` (`:20`) | `legal.$id.tsx` (`:19`) | Jambo |
| `/travel/destinations/:key`, `/travel/properties/:key` | not present | `:13`, `:14` | Jambo, Mapbox |
| `/newsletter` | `newsletter.tsx` (`:10`) | not present | MailerLite |
| `/privacy`, `/terms` | redirects (`:29`, `:30`) | not present | none |
| `/guides/__unlisted` | `:13` | not present | Folio reader |
| `/sitemap.xml` | `:9` | `:9` | Folio reader. Both call `folio.reader(env)` with no request, which **throws** on multi-site (`UPGRADING.md` "Every reader is built from a request"). A's branch fixed its own; B's `sitemap.server.ts:21` and `page-loader.server.ts:183` still do it |
| `/robots.txt` | static file in `public/` | route (`:10`) | none |

**Third-party callbacks with fixed URLs: none were found in either repo.** A grep for "webhook" matches nothing. Stripe is tokenised client-side and charged by Jambo. The URLs customers are sent to (quotes, invoices, payment links) are minted outside these repos, most likely by Jambo, and embed each brand's hostname. That is a constraint on every option: **live hostnames must not change.**

**Could they stay host routes in one merged Worker?** Yes in principle, because Folio never intercepts them. In practice, one React Router app would then hold both brands. Six paths collide outright (`/quote/:key`, `/itinerary/:key`, `/invoice`, `/payment`, `/sitemap.xml`, `/robots.txt`), and every one would need a hostname branch in the loader, the component, the `meta` and the CSS. The collisions go beyond the route table:
- **Static assets are not host-aware.** Workers Assets answers `/favicon.ico` or `/robots.txt` before the Worker runs, so both brands would get one file.
- **One root layout.** `root.tsx`, the fonts and the global SCSS are app-wide, and React Router has one route config and one `basename`.
- **Two generated Jambo clients.** The schema generations differ (the `executePayment` variable shapes differ), and a shared `JAMBO_TOKEN` name holds what may be per-brand values.

**Under options (b) and (b′) below they do not move at all.** Each brand's Worker keeps serving its own hosts, so there is no collision.

## 4. The options

### (a) One Worker serving both brands

One Worker, one React Router app, one `createFolio`, all hostnames routed to it.

- **Cost:** merge two React Router apps into one. That covers the route table with host branches, two root layouts, two global stylesheets scoped by host, static assets moved into host-aware routes, both Jambo codegens (or one regenerated against the current schema, which re-tests every quote and payment view of one brand), and every secret renamed per brand. The admin redirect, `NON_CANONICAL_HOST` and cache verdicts all become host-aware. This is a rewrite of the smaller front end into the larger one, weeks rather than days, and it produces a codebase worse than either input.
- **Content migration:** as (b′) below for B. A stays in place.
- **Risk:** the highest. One deploy ships both brands' payment pages, and any regression hits both.
- **Stress value:** the in-process multi-site path (`reader.page()`, `cacheProps` with **two sites at one path**, `/` and `/contact` exist on both). A's staging already exercises this path with one site.

### (b) A new, neutral CMS Worker; both front ends headless

A third Worker owns D1, R2, the Durable Objects, the admin and the preview bundle. Both brand Workers call it over service bindings: v1 `sites/resolve`, `~<site>/api/v1/pages/{path}`, and the forwarded `{base}/asset/*`, `{base}/f/*`, `{base}/share`, `{base}/site/enter`, `{base}/draft/*` and `?_folio=`. Hooks forward each payload's `purge` to the right front end's cached entrypoint.

- **Cost:** everything in (b′), plus moving **A's** content out of A's Worker as well. That is two imports instead of one, and A's editors lose their drafts and version history too.
- Strictly more work than (b′), for the benefit of symmetry.

### (b′) A's Worker becomes the CMS for both brands; B goes headless (recommended shape)

A's Worker already holds the Folio deployment and already runs multi-site on staging. Add a second site, `takeoffgo`. B's Worker stops calling `createFolio`. It keeps every custom route unchanged and gets its CMS pages from A's Worker over a service binding.

What changes, by repo:

- **B's blocks become a package.** The CMS build (A's) needs B's real block components for the preview pane. B's blocks import about a dozen B components (`Hero`, `Header`, `EnquiryForm`, `CtaLink`, `TravelCardContainer`, the `Home*` sections, `react-markdown`) and B's global stylesheet, so this is an extraction, not a re-export.
  - Rename `page`/`pageRoot`/`prose` to B-prefixed names. Add `tgHome` plus `tgPage` with `under`.
  - Both A's Worker and B's front end pin the package by SHA, the same way both pin Folio.
- **A's `createFolio`:**
  - `blocks: [...aBlocks, ...bBlocks]` and the union of types.
  - `passkeys()`, because B's editors used them.
  - A brand-neutral `magicLink` sender. The `EMAIL` binding's `allowed_sender_addresses` has to allow whichever address is chosen.
  - `forms.verify` branching on `new URL(req.url).hostname`: Turnstile for A, hCaptcha for B. `verify` receives `req` (`src/server/form-responses.ts:2198`). `HCAPTCHA_SECRET_KEY` is added to A's secrets.
  - `hooks.submitted` branching on the payload's `site`. B's branch hands the payload to B's Worker over RPC, so HubSpot and B's Jambo credentials stay in B's env.
  - Every purge-bearing hook forwards `purge` to B's `CachedPages` when `site === 'takeoffgo'`.
  - `previewCss` carries both brands' font sheets, and B's global stylesheet is scoped under a wrapper class inside B's root block render rather than imported globally.
  - The admin redirect covers B's hosts too.
- **B's front end:**
  - `page-loader.server.ts`, `$.tsx`, `home.tsx` and `sitemap.server.ts` move from `folio.reader(...)` to fetches over the service binding, rendered with `folio/render`'s `FolioDoc`, which B already uses (`app/routes/$.tsx:3`).
  - The gateway forwards Folio's paths on B's hosts to A's Worker, keeps its own cache verdict (assets cached, the rest of `/folio` bypassed, any Folio cookie bypassed), and sets `Cache-Tag` from `folio-cache-tags`.
  - `CachedPages` gains an RPC `purge(tags)`.
  - `MISS_HEADERS` must tag misses `site:takeoffgo` and `type:*@takeoffgo`. Today it uses the unscoped `site` and `type:*` (`page-loader.server.ts:161`). On multi-site no publish purges those, so cached 404s would outlive a publish by up to a week.
  - The `pathsChanged`/`redirectsChanged` miss-purge hooks move into A's Worker and are forwarded like the tag purges.
- **Content migration, B into A's D1** (B's deployment is the smaller one; code comments suggest a home page, five pages, travel-card records, two forms and a media library, all unverified against D1):
  - **Documents:** through the v1 API or the engine, never raw SQL. A StoryDO with no state seeds from a blank document, not from `published_doc` (`src/server/runtime.ts:833`). A row copied by SQL would open empty in the editor, and the first publish would wipe the page. v1 create mints fresh ids (`DocumentCreateBody` has no id, `src/server/validate.ts:535`), so the import needs an id map. It applies that map to every `reference`/`references` value and every richtext link mark's `attrs.link`, and renames B's block and type names on the way through.
  - **Id collision is guaranteed:** both seeds create the root as `str_home` (`folio-seed.sql` in each repo).
  - **Lost:** drafts ahead of publish (they live in B's StoryDO namespace) and version history. **Publish or discard every B draft before the import.**
  - **Assets:** copy the R2 objects under their existing keys, and insert the `assets`, folder, tag and join rows by SQL with `site_id = 'takeoffgo'`. Asset keys are random, so document asset values need no rewrite. Run `reindex` afterwards.
  - **Forms and responses:** SQL copy with `site_id` set. Responses have no API (`CLAUDE.md` in B, "Forms"), so SQL is the only path. Rewrite each `enquiryForm` block's `form` id only if the form ids change.
  - **Redirects:** SQL copy with `site_id`. Schedules are re-created by hand. Shares, sessions, tokens and auth events are dropped, and tokens are re-minted bound to `takeoffgo`.
  - **Users:** merge by email; the owner exists in both. Before B's site exists, **rewrite every A user's `*` grant to a `default` grant.** Otherwise every A editor becomes an editor of B the moment a second site exists (`UPGRADING.md:283` and the handbook). B's users get `takeoffgo` grants. B's passkeys are invalid, because `rpId` becomes the admin host, and are re-enrolled.
- **Cost estimate:** about 1 to 2 days for the block package, about 2 days for the headless front end, about 2 days for the import tool and a staging rehearsal, and about 1 day for A's config and hooks. Call it 1.5 weeks for staging, before any Folio fixes in section 5.
- **Risk:**
  - B's public site then depends on A's Worker, D1 and deploy pipeline. A bad A deploy or a D1 incident takes out both brands' marketing pages. B's custom pages keep working, because they only call Jambo.
  - Every Folio pin bump and every B block change ships through A's Worker. Today the two pins differ (`3acc67e` and `133bb7f`), and after the merge they move in lockstep.
  - In production, turning `sites` on is the point of no return (`UPGRADING.md:283`).
- **Rollback:**
  - On staging: redeploy B's previous staging Worker, whose D1 and R2 are untouched. Remove the `takeoffgo` site's content and then the site from A's staging registry (`deleteSite` refuses while content exists), or restore A's staging D1 with Time Travel to a point before the import.
  - In production there is no rollback past `sites` being on. Only roll-forward.

### (c) Don't merge

Both deployments stay as they are. A keeps multi-site on staging with one site. Nothing is spent, and nothing about two real sites is learnt.

### What the merge stress-tests that one site cannot

These parts of Folio have run on one site only, or not at all:
- The registry with two sites, and host-to-site mapping across two registrable domains.
- **Isolation** between two editor populations (fences, the id loaders, the socket role, the scope switcher).
- **Two preview origins** doing the handoff, with CHIPS partitioned cookies in two partitions. Phase V's browser matrix has not yet run against a real deployment.
- Forms submitted on a **forwarded** live host (`POST /f/:id` needs "a live host of a site with the form in its chain").
- Assets served through a front end.
- **The headless v1 surface, which has no consumer today.** That covers `sites/resolve`, `pages/{path}`, the `folio-cache-tags` header, and `purge` on hook payloads forwarded to another Worker's entrypoint.
- `scripts/cache-probe.mjs --admin --site`, which has never run against a deployment (spec phase 9 note).
- The operational side: one sign-in origin for two brands, passkeys re-enrolled, and grants set per site.

### What it does not exercise

The `shared` scope, groups, layered globals, `sites.settings`, fork and fallback. Neither brand has content that another scope could meaningfully own.

### Recommendation

**Run (b′) on staging as a time-boxed stress test, and do not merge production (option (c) for production).**

The staging run is where almost all the value is. It is the first two-site, two-domain, headless use of spec 23, and it is reversible.

A production merge buys one admin login for two brands. For that it:
- couples B's marketing site to A's Worker and D1;
- puts both brands' Folio pins and block code in lockstep;
- throws away B's drafts, version history and passkeys;
- crosses the point of no return.

Revisit production only if the business needs one editorial team across both brands, and only after the Folio gaps below are closed.

Two staging hygiene points:
- Deploy B's headless front end as a **separate** Worker, not over `takeoffgo-website-staging`, so B's normal staging pipeline stays representative of B's production during the test.
- Import B's **staging** content, not production.

## 5. Blockers and gaps in Folio's current code

Nothing in `validateSites` refuses this configuration. Two sites on unrelated registrable domains, an empty `shared` and no settings type are all valid. The things below are gaps the merge would hit. They are ordered by how much each costs the test.

1. **No v1 miss lookup (a blocker for a headless front end that has redirects).**
   - v1 `pages/{path}` answers `404` for anything that is not a page (`src/server/routes/api/pages.ts`). Nothing in v1 exposes `reader.miss()`'s redirect or `gone` answer, and the redirect routes are the unversioned admin API.
   - B's catch-all relies on `miss()` (`page-loader.server.ts:183`), so a headless B loses its redirects and 410s.
   - Fix: a v1 read (a `miss` field on the 404 body, or `GET ~<site>/api/v1/redirects/{path}`). This is a v1 addition, so it is additive, not a major bump.
2. **The preview shell is one per deployment.**
   - `assets.preview`, `previewCss` and `previewWrap` are single values, and `PreviewWrap` gets no site (`src/server/types.ts:648`, `:670`, `:672`; `src/core/render-wrap.ts:14`).
   - Two brands' global CSS and fonts load into every preview. A brand that needs a different provider tree cannot get one.
   - Fix: pass the rendering `SiteRef` to `previewWrap`, and allow `previewCss` to be a function of it. Not a blocker for the test if B's global stylesheet is scoped under B's root block.
3. **No per-site type visibility.**
   - Decision 7 leaves out per-site registries (spec `:1782`), and its reason, that a shared page must render on every site, does not apply to a type used only by one site. Every editor sees every brand's types and records.
   - Fix: an optional `sites` allowlist on `DocumentType` that filters menus and refuses creation elsewhere. That filters the menus without splitting the registry. The test runs without it, and it is the gap most likely to annoy editors.
4. **The scoped cache-tag builders are not exported** from `folio/core` (spec `:2596`). B has to hand-spell `type:*@takeoffgo` for its cached misses. Fix: export `siteTag`, `scopedAnyTypeTag` and `pathTag`. The test can spell the strings until then.
5. **No tool for moving a site between deployments** (spec `:1788`). The import in section 4 is one-off host code.
   - The spec is right to leave it out for the portfolio case, but this merge is exactly that operation.
   - The seed-from-blank behaviour of StoryDO (`runtime.ts:833`) is why it has to go through the API.
   - If the owner wants this repeatable, it belongs in `folio/engine`: an export and import that maps ids and rewrites references.
6. **Purge through RPC into another Worker's entrypoint has never been observed.** The design assumes a purge issued inside B's `CachedPages`, when that entrypoint is invoked over a service binding from A's Worker, reaches the namespace that entrypoint's cache uses. Miniflare cannot show it, so it has to be verified with `cache-probe.mjs` on the staging deployment before anything depends on it.
7. **Deployment-wide settings that were per-brand.**
   - These need host code, and none of them is a blocker: `forms.ratePerHour` (10 against 20, now one value), the `magicLink` sender and branding (one for both), `describe` (one key, fine), and `migrations` (one list; B's `0001-fifty-fifty-to-feature` has already run on B and need not come across).
   - `forms.verify` and `hooks.submitted` can branch per site today, on `req`'s host and on the payload's `site`.
8. **Small items from the Implementation notes that this merge would touch:**
   - The asset and form pickers carry no scope badge (phase 8). That is irrelevant without shared content.
   - `sweepAuth` does not count `site_grants` (phase 7).
   - `SitesConfig`, `SiteRef` and `PurgeIssued` are not exported (phase 9), so B's purge-forwarding code types the payload by hand.
