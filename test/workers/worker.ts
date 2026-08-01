/**
 * Test-only Worker entry for the `workers` vitest project.
 *
 * The pool needs a `main` module for two reasons:
 *   - Durable Object bindings without an explicit `scriptName` are resolved
 *     against it, so `StoryDO` has to be re-exported from here, exactly as a
 *     host application does it (see examples/demo/src/index.tsx).
 *   - it runs in the same isolate as the tests, so a test importing
 *     '../../src/server' gets the same module instance the DO does.
 *
 * The re-export deliberately goes through 'folio/server' (src/server/index.tsx)
 * rather than src/server/story-do.ts directly: that is the import path real
 * users have, so it also pins that the barrel stays loadable inside workerd.
 */
import { createElement } from 'react'
import { renderToReadableStream } from 'react-dom/server.edge'
import { blocks, defineBlock, multilink, text } from '../../src/core'
import { createFolio, Shell } from '../../src/server'

export { SpaceDO, StoryDO } from '../../src/server'

/**
 * Smallest registry that exercises test/workers/http.test.ts's load-bearing
 * scenarios: a `page` root (its `title` is the field the story tree caches,
 * and `body` is a slot to hold children) and a `link` block whose `href` is a
 * `multilink`, so renaming the story it points at has something observable to
 * update.
 *
 * This file stays `.ts`, not `.tsx`: its path is baked into both
 * vitest.config.ts and test/workers/wrangler.jsonc, which are outside this
 * test tree's remit to change. `render` builds elements with `createElement`
 * instead of JSX for that reason.
 */
const page = defineBlock({
  name: 'page',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ label: 'Title', required: true }),
    body: blocks({ label: 'Body', allow: ['link'] }),
  },
  render: ({ title, body }) =>
    createElement(
      'div',
      { className: 'page' },
      createElement('h1', null, title),
      createElement('div', { className: 'page__body' }, body),
    ),
})

const link = defineBlock({
  name: 'link',
  label: 'Link',
  summary: 'label',
  fields: {
    label: text({ label: 'Label', required: true }),
    href: multilink({ label: 'Target' }),
  },
  render: ({ label, href }) =>
    createElement(
      'a',
      { href: href?.href ?? '#', 'data-broken': href?.broken ? 'true' : undefined },
      label,
    ),
})

const folio = createFolio<Cloudflare.Env>({
  blocks: [page, link],
  root: 'page',
  bindings: (env) => ({
    db: env.DB,
    story: env.STORY,
    space: env.SPACE,
    media: env.MEDIA,
    images: env.IMAGES,
  }),
  basePath: '/folio',
  // Required, for the same reason `auth` is: absent, the admin page serves a
  // mount point and no script tag, which is a blank screen behind a 200 rather
  // than an error. A real host passes the `__FOLIO_ASSETS__` global its Vite
  // plugin defines; there is no Vite here, so the fixture states the shape.
  //
  // The URLs are what the plugin emits for a production build, and no test
  // fetches them — what the suites assert about is that the admin page *links*
  // something, which is precisely the thing that used to be silently absent.
  assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
  // identity-and-access.md checkpoint 2: `auth` is required, so a test host
  // declares it too. 'open' keeps this fixture's own scenarios about routing
  // and content rather than about credentials; the auth suites build their own
  // `createFolio` with providers configured.
  auth: 'open',
  // '' is the root story, which serves '/', matching examples/demo.
  route: (path) => (path ? `/${path}` : '/'),
})

/**
 * A real host `fetch`, close enough to examples/demo/src/index.tsx that
 * test/workers/http.test.ts pins genuine host-integration behaviour rather
 * than a stub: Folio's own routes and previews first, then whatever it does
 * not own is served as a published page — or a host-owned 404, distinct from
 * any of Folio's own JSON 404s, when nothing matches either. That distinction
 * is what a test can use to tell "the host's own routing took over" apart
 * from "Folio itself said no".
 */
export default {
  async fetch(req, env, ctx) {
    const handled = await folio.handle(req, env, ctx)
    if (handled) return handled

    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/+|\/+$/g, '')
    const doc = await folio.published(env, path)
    if (!doc) {
      // redirects.md's architecture decision 2: only reached once folio.published
      // has already said null, so a live story always wins over a redirect —
      // and creating one at a redirected path deletes the row anyway.
      const hit = await folio.redirect(env, path)
      if (hit) {
        const location = new URL(hit.to, url.origin)
        location.search = url.search
        return Response.redirect(location.toString(), hit.status)
      }
      return new Response('host: not found', { status: 404 })
    }

    const resolution = await folio.resolve(env, doc)
    const shell = Shell({
      title: 'Published',
      children: createElement('div', { id: 'folio-root' }, folio.render(doc, { resolution })),
    })
    return new Response(await renderToReadableStream(shell), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  },
} satisfies ExportedHandler<Cloudflare.Env>
