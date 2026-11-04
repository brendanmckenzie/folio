# Folio

**The CMS you and your agent both love.**

Folio is a sleek, live visual block editor for the people who write your site, and the best surface for the agent you already use to build and run it: an MCP server, a typed schema, an integration guide written for coding agents, and writes that go through the same mutation log as a human edit, so they sync, undo and show up in the activity trail. It is a library, not an application, and it runs on nothing but Cloudflare: Workers, D1, Durable Objects and R2.

<!-- hero-demo: recorded GIF/video, hosted as a GitHub release asset -->

---

## A block, end to end

A content type is one file. The admin form, the prop types and the HTML all come from it, so they cannot drift apart:

```tsx
// src/blocks/hero.tsx
import { blocks, defineBlock, select, text } from 'folio/core'

export const hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  summary: 'heading',        // what the block shows in the editor's outline
  fields: {
    heading: text({ required: true, translatable: true }),
    align: select({
      options: [
        { label: 'Left', value: 'left' },
        { label: 'Centre', value: 'center' },
      ],
      default: 'center',
    }),
    actions: blocks({ allow: ['button'], max: 2 }),
  },
  // `align` is typed 'left' | 'center'. `actions` arrives already rendered.
  render: ({ heading, align, actions }) => (
    <section className={`hero hero--${align}`}>
      <h1>{heading}</h1>
      <div>{actions}</div>
    </section>
  ),
})
```

An editor sees a Hero with a heading box, a two-option dropdown and a slot that takes up to two buttons. They click the heading on the page and type into it, and another editor in another window watches it change. An agent reads the same definition through `get_schema`.

---

## Quick start

```bash
npx github:brendanmckenzie/folio#v1.3.1 init my-site
cd my-site && npm install
npm run db:local && npm run db:seed
npm run dev
```

Open <http://localhost:5173/folio/login> and enter the address the scaffolder seeded. A fresh project has no mail binding, so the sign-in link is logged to your terminal. Follow it, add a Hero, type into it and hit **Publish**: it is live at `/`.

`init` writes [`examples/starter`](examples/starter), a complete Cloudflare project that is typechecked on every commit, along with an `AGENTS.md` for your coding agent. Adding Folio to an existing project is the same checklist: see [`AGENTS.md`](AGENTS.md). Requires Node 20.19+ or 22.12+, a Cloudflare account, React 19 and Vite 7 or 8. More on the first run in the [handbook](docs/handbook.md#getting-started-in-detail).

---

## For editors

- **Edit the real page.** Your site renders in an iframe; click any block to select it and change it in place. Edits apply optimistically and stream to the preview without a reload.
- **Work together.** Cursors, selections and presence across the site, with per-user undo.
- **Draft and published are separate.** Browse the real site from its drafts, send a reviewer a share link that needs no account, and schedule a publish or unpublish.
- **Nothing is lost.** Every document has a history with versions, restore, minimal diffs and an activity trail.

## For agents

Point the agent you already use at `{base}/mcp` with a scoped token and it can read and write content the way an editor does. Folio builds no chat panel and picks no model; the agent is yours.

- **An MCP server** with seventeen tools: `get_schema`, search and query, `get_document`, `check_document`, `create_document`, `write_content`, `patch_fields`, `move_document`, `duplicate_document`, `list_versions`, `restore_version`, `publish_document`, `unpublish_document`, `delete_document`, `upload_asset` and `preview_document`, which returns a screenshot so the agent can see the page. The tool list is filtered by the token's scopes.
- **A typed schema** the agent can read (`get_schema`) and that refuses a payload that does not fit, with the path and the reason.
- **Writing guidance and content checks.** `help`, `guidance` and advisory `length` on blocks and fields, a per-brand `writing` guide, and `check_document`, which tells an agent what to fix and where before anything is published.
- **Writes are ordinary edits.** They go through the mutation log, appear live in an open editor, are attributed as `token:<name>` in the activity trail, and undo with Cmd+Z.
- **[`AGENTS.md`](AGENTS.md)** is the integration guide, written for a coding agent. `folio init` drops it into your project and `folio agents` refreshes the block.
- **A versioned Content API** at `{base}/api/v1` for scripts and headless front ends.

Setup is a token and one command: [`docs/mcp.md`](docs/mcp.md).

---

## What it does

- **Nested blocks** with per-slot `allow` lists, drag to reorder, duplicate, and copy and paste between documents and sites. Richtext on TipTap, constrainable per field.
- **Three kinds of document:** pages that own a URL, records for unrouted data, and singletons such as site settings. Globals load into every page.
- **References, collections, full-text search and localisation**, with one document holding every language.
- **Forms** built in the admin, with conditional questions, steps, option sources and actions, stored and exportable.
- **A media library** on R2 with on-the-fly resizing, focal points and optional machine-written alt text (you supply the model call).
- **Caching that invalidates:** cache tags come from what a render loaded, and a publish purges by tag. D1 read replication runs through a per-request session.
- **Auth with no default:** magic links, OIDC, Cloudflare Access, passkeys, or `auth: 'open'` said out loud. Members-only pages against your own membership system.
- **Content migrations**, redirects, publish hooks and a drift audit.
- **Many sites, and many brands, in one deployment.** Opt-in; the handbook has the design.

The host owns its Worker, routing and public pages. Folio owns the editor, the sync engine and the block render, and returns `null` for every path it does not own.

---

## Documentation

| | |
| --- | --- |
| [`docs/handbook.md`](docs/handbook.md) | Every feature, what it is for and why it is shaped that way. Includes the integration in three pieces, multi-site, multi-brand and versioning. |
| [`docs/configuration.md`](docs/configuration.md) | Every `createFolio()` key, binding and Vite option. |
| [`AGENTS.md`](AGENTS.md) | Adding Folio to a project, written for a coding agent. |
| [`docs/mcp.md`](docs/mcp.md) | Pointing an assistant at a running site. |
| [`docs/api.md`](docs/api.md) | The `{base}/api/v1` contract. |
| [`UPGRADING.md`](UPGRADING.md) | Bumping the tag, applying migrations, and what each needs. |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each release. |
| [`examples/starter`](examples/starter) | The project `folio init` scaffolds. |

Working on Folio itself? [`CLAUDE.md`](https://github.com/brendanmckenzie/folio/blob/main/CLAUDE.md) is the contributor's guide.

## Install and versioning

Folio installs from git, not npm. Pin an exact release tag:

```
npm install github:brendanmckenzie/folio#v1.3.1
```

It follows [semver](https://semver.org/) from 1.0.0: a major version removes or narrows the `exports` surface or a `createFolio()` key, a minor adds to them (D1 migrations arrive in minors), a patch fixes. Never pin a range or a branch. [`UPGRADING.md`](UPGRADING.md) is the procedure, and the [handbook](docs/handbook.md#versioning-and-installing) has the reasoning.

Two sites run on Folio in production. MIT licensed.
