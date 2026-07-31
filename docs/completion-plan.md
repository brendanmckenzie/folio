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
3. **Port phase 6 — Home.** In flight. Its two site-wide recency readers and a
   `/counts` route are done and tested (`test/workers/recency.test.ts`), which is what
   removed `ui-architecture.md` dependency 5.
4. **Port phase 7 — the editor.** The largest, and the one an editor spends the day
   in. Split by *what does not share state* — see `docs/editor-port-plan.md`, which
   argues why splitting it four ways and merging would produce four views of one store
   that disagree at the seams. 7a (shell, rail, preview) and 7c (history slide-over,
   block picker) are in flight; 7b (inspector, focus mode) follows, because it needs
   7a's seam to exist. The server mount at `{base}/edit/:id` still serves the **old**
   admin and gets flipped only when all three are in.
5. **Port phase 8 — deletion.** `admin/admin.css` gone, `admin/ui/` the only
   styling, Biome's a11y rules global rather than scoped to `admin/ui/**`.
6. **The gaps that stop a real delivery.** In priority order, each judged against
   what the reference products actually ship:
   - **Scheduled publish and unpublish.** Every comparable product has it; Folio has
     the `publish` workflow already factored to take a story rather than a request,
     and `routes/stories.ts` already says a scheduled publish has to check existence
     itself. Wants a `scheduled_at` column, a cron trigger and a UI.
   - **Bulk write endpoints** (`ui-architecture.md` dependency 7 / decision 7a).
     The shape is fully designed — `{ all, filter, expected, exclude }`, count
     validated once, batched with `continueFrom` — and unbuilt, which is why
     select-all-matching is deliberately absent from Content.
   - **Outbound webhooks.** `publish-hooks.md` exists server-side for a host's own
     code; a *configured* webhook with a delivery log is what a client asks for on
     day one.
   - **Draft preview sharing.** A tokenised link that shows an unpublished document
     to somebody with no account. Contentful and Storyblok both ship it; it is how
     a client reviews work.
   - **Build artifacts and `.d.ts`.** `ROADMAP.md` calls this out: the library ships
     TypeScript source and the host compiles it, which is "fine for now, wrong for a
     release". A product somebody installs needs a build.

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
