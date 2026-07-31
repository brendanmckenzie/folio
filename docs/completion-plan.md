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
     is still live. **No admin surface yet** — the routes are built and a screen wants
     `GET {base}/api/schedules?story=`.
   - **Bulk write endpoints.** Done, `docs/specs/platform/bulk-writes.md`. Five routes
     under `{base}/api/bulk/`, one per action, because each carries its
     single-document twin's gate and a token holding only `publish` must not lose bulk
     publish. `{ all, filter, expected, exclude }` as designed, plus one thing decision
     7a did not name: **the count is the job's ceiling as well as its guard**, so a set
     that grows under a long run cannot enlarge it. No migration and no wire change.
     **No admin surface yet** — what Content's selection bar needs is six precise
     steps, listed in the spec's implementation notes.
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
   - **Build artifacts and `.d.ts`.** In flight,
     `docs/specs/foundation/package-build.md`. `ROADMAP.md` calls it out: the library
     ships TypeScript source and the host compiles it, "fine for now, wrong for a
     release". Until it lands, Folio cannot be installed by anyone outside this
     workspace — which is the difference between a codebase and a product.

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
