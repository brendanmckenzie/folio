# folio-starter

A small, complete Cloudflare project running [Folio](https://github.com/brendanmckenzie/folio):
a Worker that mounts the CMS and renders published pages, three blocks, and every
binding wired up.

This is what `npx github:brendanmckenzie/folio init` scaffolds. It is also a real
package in the Folio workspace, so it is typechecked on every commit — which is
the only reason to trust that it works.

## Running it

```bash
npm install
npm run db:local     # apply the schema to a local D1
npm run db:seed      # a root story and an admin user
npm run dev
```

Then:

1. Open <http://localhost:5173/folio/login> and enter the address in `seed.sql`.
2. There is no mail binding, so the sign-in link is **logged to your terminal**.
   (`curl -s localhost:5173/dev/last-signin` gets it too.) Open it.
3. You land in the editor. Add a Hero, type into it, hit **Publish**.
4. `/` is now live.

Open the editor in a second window to see multiplayer.

## What is where

| | |
| --- | --- |
| `src/blocks/` | Your content types. Schema and renderer in one file. |
| `src/blocks/index.ts` | The one array handed to Folio. Add a block here. |
| `src/index.tsx` | The Worker: `createFolio` config, the fetch handler, the page render. |
| `public/site.css` | Your styles. Named twice — on the page, and as `previewCss`. |
| `wrangler.jsonc` | Bindings, the cron, the caching flag, the D1 migrations path. |
| `seed.sql` | A root story and the first admin. Run once, locally. |

## Adding a block

Three steps, none of which touch the admin:

1. Write it in `src/blocks/`, using `defineBlock` from `folio/core`.
2. Export it from `src/blocks/index.ts`.
3. Name it in some other block's `blocks({ allow: [...] })` slot — usually
   `page`'s `body` — so an editor can insert it.

The admin is schema-driven and ships prebuilt, so it learns about your block
over HTTP. There is nothing to rebuild.

## Before you deploy

```bash
wrangler d1 create folio                  # put the id in wrangler.jsonc
wrangler r2 bucket create folio-media
npm run db:remote                         # apply migrations to the real database
```

Then three things this scaffold left as local-dev stand-ins:

- **Send real mail.** `auth.providers[0].send` in `src/index.tsx` logs the
  sign-in link. Swap in Cloudflare Email Sending, or anything else.
- **Delete `/dev/last-signin`.** It refuses non-localhost already, but it has no
  business in a deployment.
- **Seed the first admin against the remote database.** The command is in the
  comment at the bottom of `seed.sql`.

Then `npm run deploy`.

## Where to look next

Folio's own docs are in `node_modules/folio`:

| | |
| --- | --- |
| `README.md` | What Folio is, and what it does. |
| `docs/configuration.md` | Every `createFolio()` key, with its default and its failure mode. |
| `AGENTS.md` | The integration shape, and the traps that read as library bugs. |
| `docs/handbook.md` | Every feature in depth. |
| `UPGRADING.md` | Bumping the pinned SHA. |
