# The run to a deliverable product

> **Status:** in progress
> **Started:** 2026-07-31, after port phase 3 landed (`4a27656`).
> **Why this file exists:** the owner's instruction is to get Folio to the point
> where a site can be built and delivered with it as readily as with Storyblok,
> Strapi or Contentful — not to stop at the end of `ui-architecture.md`'s port plan.
> That is more work than fits in one head at once, so the sequence lives here rather
> than in a conversation.

## The rule this whole run follows

**The admin UI is the product.** Every server capability in this repo is already
strong — sync, publishing, versions, migrations, i18n, the content API, caching,
auth, pagination. What a person cannot do is *use* it: six of the eleven screens in
`ui-architecture.md` are stubs, and the editor is still the old three-pane one. So
the port plan comes first and the feature gaps come after it, because a capability
with no surface is not deliverable and a surface with no capability is at least
honest about what it is missing.

## Sequence

Each numbered item is committable on its own, leaves the tree green, and is checked
in a browser before it is called done.

1. **Port phase 4 — Assets.** Built and wired; the grid is one implementation with
   two mounts (the screen, and the field picker in a `Dialog`). Asset usage landed as
   a third `kind` on `content_refs` holding the R2 **key**, because a stored
   `AssetValue` carries no asset id at all.
2. **Port phase 5 — Access, Model, Redirects, Settings.** All four built and wired.
   Three real defects fell out: a self-demotion lockout on `PATCH /users/:id`, a
   `from === to` redirect the route accepted, and `GET /audit` reading the whole
   `stories` table — the last of the five unbounded reads `pagination.md` opened with.
3. **Port phase 6 — Home.** Done. Its two site-wide recency readers and a `/counts`
   route are tested in `test/workers/recency.test.ts`, which is what removed
   `ui-architecture.md` dependency 5.
4. **Port phase 7 — the editor.** Done (`c6776f5`). Split by *what does not share
   state*, per `docs/editor-port-plan.md`. `{base}/edit/:id` serves the shell now, and
   `useRefStories` closed the last thing `pagination.md` left owed: the editor no
   longer holds every story on the site to resolve its preview's links.
5. **Port phase 8 — deletion.** In flight. `admin/admin.css` gone, `admin/ui/` the
   only styling, Biome's a11y rules global rather than scoped to `admin/ui/**`.
   Blocked first on moving eight pure functions the new editor still imports out of the
   old one — they were imported rather than copied on purpose, because a copy of a pure
   function is a copy that drifts.
6. **The gaps that stop a real delivery.** In priority order, each judged against
   what the reference products actually ship:
   - **Scheduled publish and unpublish.** Done (`6bc1c55`),
     `docs/specs/platform/scheduled-publishing.md`. A cron trigger, not a Durable
     Object alarm — `StoryDO` has exactly one alarm and already spends it on the
     debounced watermark, so a publish alarm set for Tuesday would have silently
     stopped the tree reporting unpublished changes for that page. `scheduled` is
     deliberately **not** a fifth `StoryState`: a live page with a scheduled unpublish
     is still live. **The site-wide screen landed 2026-08-05** and needed no new route:
     `?story=` was already there. It reports an *outcome* rather than the `status`
     column, and it diagnoses a missing cron — a pending row past due with no attempts
     means nothing ran the sweep, which the server cannot report because to D1 that row
     is simply pending. Still owed: the editor's own top bar, which is what `?story=`
     was built for.
   - **Bulk write endpoints.** Done, `docs/specs/platform/bulk-writes.md`. Five routes
     under `{base}/api/bulk/`, one per action, because each carries its
     single-document twin's gate and a token holding only `publish` must not lose bulk
     publish. `{ all, filter, expected, exclude }` as designed, plus one thing decision
     7a did not name: **the count is the job's ceiling as well as its guard**, so a set
     that grows under a long run cannot enlarge it. No migration and no wire change.
     **This said "No admin surface yet" and was stale**, found 2026-08-05: Content has
     the selection bar, `content-model.ts` posts `{apiBase}/bulk/{action}` for all five,
     and `ConfirmBulkDialog.tsx` asks the question. The six steps its spec listed were
     followed and this line was not updated.
   - **Outbound webhooks.** Not built. `publish-hooks.md` exists server-side for a
     host's own code; a *configured* webhook with a delivery log is what a client asks
     for on day one. The seam is there — the hooks fire on publish, unpublish,
     `pathsChanged`, `updated` and `deleted` — so this is a table, a sender with
     retries, and a delivery log. **The one genuine gap left in this list.**
   - **Draft preview sharing.** Done (`edf742b`),
     `docs/specs/platform/draft-sharing.md`. A share is never an `Actor`, enforced by
     the cookie name, the type and the schema independently. What it cannot reach is a
     33-row data table in both the workers test and the e2e script, so a route family
     added later without a gate fails there rather than being missed. **No admin
     surface yet** — the spec lists what a "Share a preview" control needs.
   - **Build artifacts and `.d.ts`.** Done,
     `docs/specs/foundation/package-build.md`. The library ships built JavaScript
     and emitted declarations, and all three of `folio/core`, `folio/engine` and
     `folio/server` resolve `types` to `dist/types` together. The last blocker was
     TS4094 on the two Durable Object factories, and the spec's suggested cheap fix
     (`#private` members) turned out not to work at all — `ctx` and `env` are
     protected on `DurableObject` itself, so the return types had to be declared.
     What remains is not engineering: `private: true`, a version, a licence and a
     package-level README.
7. **What `ROADMAP.md` and `README.md` still had outstanding**, audited 2026-08-04 once
   spec 24 landed. The audit's own finding is that the two files disagreed with the tree
   in four places, so the first batch is the documents rather than the code. Six
   batches, each landable on its own:

   - **A — the documents tell the truth again.** Done. Three stale passages in
     `README.md`'s *Not built yet* (the package build's `.d.ts` half, which landed;
     a per-type admin list view, which is the Documents screen; and draft-status
     queries, which `GET {base}/api/v1/search` half-answered), plus `ROADMAP.md`'s
     drifted line numbers, its miscount of the whole-table reads, and the spec-24
     phase 6 item that was recorded nowhere.
   - **B — `cssCodeSplit: false` breaks a production build.** The only item on either
     list that is currently broken for a host that exists (Harbour sets the
     flag; the demo does not, so `pnpm build` proves nothing). `adminCss` is
     `['/folio-admin.css']` and with code splitting off Vite emits one
     `assets/style-<hash>.css` instead, so the admin renders unstyled behind a 200.
     **`ROADMAP.md` said this needed `generateBundle`, and it does not:**
     `__FOLIO_ASSETS__` is computed in `config()`, which is handed `userConfig`, and
     `build.cssCodeSplit` is set by the host in exactly that object. So it is a branch,
     not an indirection. Decided: when the flag is off, pin the single emitted
     stylesheet to a fixed name and point both `adminCss` and `previewCss` at it,
     accepting that the admin page then also loads the host's CSS because one
     stylesheet is all there is. Rejected forcing `cssCodeSplit: true` for the client
     environment (it overrides a choice a host made deliberately, and a host that sets
     it back is broken again silently) and the full `generateBundle` + manifest
     indirection (correct however the flag is set, including by another plugin, but far
     more machinery than the case needs). The missing tripwire matters as much as the
     fix: a unit test over the plugin's own `config()` hook with
     `{ build: { cssCodeSplit: false } }`, asserting the asset paths. It fails today.
   - **C — the MCP server moves to protocol revision `2026-07-28`.** Folio answers
     `2025-06-18`, which is two revisions behind (`2025-11-25` sits between them and is
     also handshake-based). Decided: **implement the current revision only**, per the
     greenfield rule. Two things make that cheaper and safer than it looks. The new
     revision's headline is a *stateless core* — per-request negotiation through
     `_meta` and an `MCP-Protocol-Version` header, no handshake, no session — which is
     exactly the architecture `platform/mcp-server.md` already chose, so there is
     nothing to unpick. And rejection is a typed `UnsupportedProtocolVersionError`
     that lists the versions the server does support, so a client that cannot speak it
     fails loudly and informatively rather than mysteriously.

     The residual risk is real and is handled by sequencing rather than by argument.
     Anthropic's client probes `server/discover` and falls back to `initialize` for
     older servers, so it is dual-era and a Modern-only Folio works with it — but
     support is being rolled out across Claude's surfaces and `docs/mcp.md` documents
     four of them. **So dropping the handshake is the last commit in this batch, on its
     own**: the current revision lands and is verified against a real client first, and
     if a surface turns out to be stranded, restoring Legacy is one revert instead of a
     rewrite. `server/discover` is a MUST in the new revision and returns supported
     versions, capabilities and identity in one request, which is close to what
     `tools/list` already answers per request.

     Folio's credential stance survives unchanged, and it is worth writing down because
     it looks like it should not: authorization is **OPTIONAL** in MCP, and the OAuth
     2.1 apparatus — including the RFC 9728 Protected Resource Metadata **MUST** —
     binds a server that conforms to the authorization specification. Folio does not
     conform and uses its own `api_tokens` table, which is a deviation from a SHOULD
     with a stated reason (Folio is an OIDC *client*, not a provider), exactly where it
     already stood.
   - **D — the whole-table reads on the write paths.** Three real sites plus one
     trivial one, inventoried in `ROADMAP.md`. No product decision in it, and the
     method is the whole content: fractional ordering, slug dedupe and path rebuilding
     are the three things that go subtly wrong when a query is narrowed by guess, so
     the ordering, slug and path tests get written **first**, against current
     behaviour, and the narrowing has to leave them passing.
   - **E — small correctness and cosmetics.** The sibling-reorder broadcast, which
     should be an advisory `treeChanged` carrying no paths and no URLs — that sidesteps
     the "a client cannot derive the URL of a page whose path just moved" problem that
     blocks patching the tree in place, and the space channel is already advisory and
     unordered. Plus the table-heading alignment pass at 12px, cancelling `.header`'s
     8px locally the way Settings already does.
   - **F — specs written, none built.** Done, and one of the three turned out not to
     exist as work.

     **Spec 25 (`platform/draft-mode.md`) merges two `ROADMAP.md` entries that are the
     same feature seen from different ends**: "a draft has no render inside the host's
     own layout" and *Uncovered*'s "cookie-based draft mode". Browsing the real site in
     draft, across navigations, in the host's own layout is one feature. Written around
     a finding that made it much smaller than planned: **`folio.draft(env, id)` and
     `folio.render(doc, { mode: 'mark' })` already exist**, and so does the share
     cookie — so nothing has to be built to *get* a draft or to render one without
     chrome. What is missing is a contract, `folio.draftAt(env, req, path)`, and an
     answer to what a share link does on an unwired host, which is a `draftMode` config
     key: with it, a share link lands on the page's real URL; without it, on
     `?_folio=draft` exactly as today. Rejected a `handle()` that returns a value the
     host must act on, which inverts a contract that today returns either a `Response`
     or `null`.

     **Spec 26, the icon system, was not written, because it is built.**
     `admin/ui/icons.tsx` answers every question ROADMAP's entry 1b posed — drawn by
     hand on a 24-unit grid, one `svg()` wrapper owning the stroke so no icon can state
     its own weight, `IconName` a closed union. Writing the spec would have specified
     finished work. The same sweep found the **dialog primitive** entry stale too:
     `admin/ui/Dialog.tsx` exists and fifteen files use it. Both entries are corrected
     in place. The lesson generalises and is worth more than either fix: ROADMAP's
     *Known smaller issues* accumulated during the UI rebuild and the rebuild closed
     some of them without editing the list, so an item there is a lead and not a fact.
     Four of the remaining ones were checked against the tree in the same pass and are
     real: no pointer drag in the tree, `references()` still reordering with ↑ ↓,
     the 4px table-heading gutter, and the unbroadcast sibling reorder.

     **Spec 23 (multi-site) needed no axis decision** — decision 1 already fixes it as
     a `site_id` column on `stories`. Its three genuinely open questions are resolved
     in place, each to the leaning it already carried: one `basePath`, `types` as a
     per-site map, and an explicit `site` on `ContentQuery` for in-process callers
     only. Still `draft` and unstarted.

   **Defaulted rather than asked, and recorded so the defaults are visible:**
   `required`/`min` enforcement becomes a *publish-time* check naming what is
   incomplete, not a write-time refusal, because a draft in progress is legitimately
   incomplete and refusing writes would break importers and the API on content that is
   fine. Versions retention and mutation-log compaction stay parked — both are "wants a
   policy" with no pressure behind them, and a retention number chosen without a real
   site's history is a guess. Tree drag for pointer users stays parked: keyboard
   reordering works and the row menus cover pointer users, so drag is a feature with
   a11y obligations of its own rather than a gap.

## What is deliberately NOT in this run

- **Workflow, approvals and assignment.** `ui-architecture.md` rejects them with a
  reason (there is no workflow model, and inventing one to fill a dashboard panel is
  furniture). Named here so the absence is a decision.
- **Archive, tags, releases, CSV export.** `docs/feedback.md` parks the first two
  with reasons and Folio has none of the underlying concepts.
- **FTS5 search.** `pagination.md` decision 8 rejects it; substring plus
  `content_index` is enough for a picker over a site's own content.
- **Schema editing in the UI.** `ui-architecture.md` decision 6: schema-as-code is
  the property that keeps four representations of a block in step, and a settings
  form would be a second source of truth for the one thing that must have exactly
  one. Settings is a read-only mirror and that is the whole point.

## How this run is executed

Subagents, briefed one deliverable at a time against a contract stated up front,
with file ownership partitioned so two agents never edit the same file. The
integration, the UI review and every gate run are done here rather than delegated —
a screen that passes its tests and looks wrong is not done, and only a browser can
say which.
