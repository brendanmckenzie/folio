import { createExecutionContext, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  asset,
  blocks,
  boolean,
  defineBlock,
  defineRecord,
  number,
  richtext,
  select,
  text,
} from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import type { NestedBlok, NestedDoc } from '../../src/core/nested'
import { PROTOCOL_VERSION } from '../../src/core/protocol'
import type { DocumentType } from '../../src/core/schema'
import type { AuthConfig, FolioBindings, WriteResult } from '../../src/server'
import { createFolio, magicLink } from '../../src/server'
import { SECURE_COOKIE } from '../../src/server/auth/cookie'
import { createSession } from '../../src/server/auth/session'
import { createToken } from '../../src/server/auth/tokens'
import { createUser } from '../../src/server/auth/users'
import type { Role, Scope } from '../../src/server/auth/roles'
import type { VersionMeta } from '../../src/server/versions'

/**
 * The Content API over real workerd, real D1 and real Durable Objects
 * (`../../../docs/specs/platform/content-api.md`).
 *
 * Its own `createFolio` with providers configured, for the reason auth-http's
 * header comment gives: every scope gate here is only observable under
 * `auth: 'session'`, because every gate short-circuits under `auth: 'open'`.
 *
 * Ids are prefixed `api_`, because D1 state is isolated per *file* rather than per
 * test and the seed fixture's rows share the table.
 */

const ORIGIN = 'https://folio.test'
const API = `${ORIGIN}/folio/api/v1`

const button = defineBlock({
  name: 'apiButton',
  label: 'Button',
  fields: { label: text({ translatable: true }) },
  render: () => null,
})

const hero = defineBlock({
  name: 'apiHero',
  label: 'Hero',
  summary: 'heading',
  fields: {
    heading: text({ translatable: true }),
    align: select({
      options: [
        { label: 'Left', value: 'left' },
        { label: 'Centre', value: 'center' },
      ],
    }),
    actions: blocks({ allow: ['apiButton'], max: 2 }),
  },
  render: () => null,
})

const prose = defineBlock({
  name: 'apiProse',
  label: 'Prose',
  fields: { body: richtext({ translatable: true }) },
  render: () => null,
})

const pageRoot = defineBlock({
  name: 'apiPage',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ indexed: true, translatable: true }),
    noindex: boolean(),
    social: asset(),
    body: blocks({ allow: ['apiHero', 'apiProse'] }),
  },
  render: () => null,
})

const priceRecord = defineRecord({
  name: 'apiProduct',
  label: 'Product',
  summary: 'sku',
  fields: { sku: text({ indexed: true }), price: number({ indexed: true }) },
})

const settingsRoot = defineBlock({
  name: 'apiSettings',
  label: 'Settings',
  fields: { tagline: text({ translatable: true }) },
  render: () => null,
})

const types: DocumentType[] = [
  { name: 'apiPageType', label: 'Page', kind: 'page', root: 'apiPage', default: true },
  { name: 'apiProductType', label: 'Product', kind: 'record', root: 'apiProduct' },
  { name: 'apiSettingsType', label: 'Settings', kind: 'singleton', root: 'apiSettings' },
]

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

const auth: AuthConfig<Cloudflare.Env> = {
  providers: [magicLink<Cloudflare.Env>({ send: () => {} })],
}

function build(mode: AuthConfig<Cloudflare.Env> | 'open' = auth) {
  return createFolio<Cloudflare.Env>({
    blocks: [pageRoot, hero, prose, button, priceRecord, settingsRoot],
    types,
    bindings,
    basePath: '/folio',
    auth: mode,
    route: (p, locale) => {
      const prefix = locale && locale !== 'en' ? `/${locale}` : ''
      return p ? `${prefix}/${p}` : prefix || '/'
    },
    locales: {
      default: 'en',
      available: [
        { code: 'en', label: 'English' },
        { code: 'fr', label: 'Français' },
      ],
    },
    globals: ['apiSettingsType'],
  })
}

const folio = build()
const open = build('open')

function call(path: string, init?: RequestInit, on = folio): Promise<Response> {
  return on.handle(new Request(path, init), env, createExecutionContext()) as Promise<Response>
}

/** A token with these scopes, and the header to send it with. */
async function tokenFor(...scopes: Scope[]) {
  const { token } = await createToken(env.DB, { name: 'importer', scopes })
  return { authorization: `Bearer ${token}` }
}

let people = 0

async function cookieFor(role: Role) {
  const user = await createUser(env.DB, {
    // Unique per call: `users.email` is unique, and a test that needs two cookies
    // at the same role would otherwise fail on the constraint rather than on
    // whatever it was checking.
    email: `${role}${people++}@example.com`,
    name: role,
    role,
  })
  const session = await createSession(env.DB, user.id)
  return { cookie: `${SECURE_COOKIE}=${session.token}` }
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T
type Envelope = { error: { code: string; message: string } }

/* -------------------------------------------------------------- fixtures --- */

let counter = 0
const nextId = () => `api_${(counter++).toString().padStart(4, '0')}`

function pageDoc(over: Record<string, Json> = {}): Doc {
  return {
    root: 'r0',
    bloks: {
      r0: {
        uid: 'r0',
        type: 'apiPage',
        parent: null,
        slot: null,
        order: 'a0',
        data: { title: 'About us', noindex: false, social: null, ...over },
      },
      h0: {
        uid: 'h0',
        type: 'apiHero',
        parent: 'r0',
        slot: 'body',
        order: 'a0',
        data: { heading: 'Hello', align: 'left' },
        i18n: { fr: { heading: 'Bonjour' } },
      },
      b0: {
        uid: 'b0',
        type: 'apiButton',
        parent: 'h0',
        slot: 'actions',
        order: 'a0',
        data: { label: 'One' },
      },
      b1: {
        uid: 'b1',
        type: 'apiButton',
        parent: 'h0',
        slot: 'actions',
        order: 'a1',
        data: { label: 'Two' },
      },
      p0: {
        uid: 'p0',
        type: 'apiProse',
        parent: 'r0',
        slot: 'body',
        order: 'a1',
        data: { body: null },
      },
    },
  }
}

/** A story row, optionally already published, plus its Durable Object's draft. */
async function seed(opts: {
  id?: string
  type?: string
  path?: string | null
  title?: string
  doc?: Doc
  published?: boolean
}): Promise<string> {
  const id = opts.id ?? nextId()
  const path = opts.path === undefined ? id : opts.path
  const doc = opts.doc ?? pageDoc()
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                          published_doc, published_at)
     values (?, ?, null, ?, ?, 'a0', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.type ?? 'apiPageType',
      id,
      path,
      opts.title ?? 'About us',
      Date.now(),
      Date.now(),
      opts.published === false ? null : JSON.stringify(doc),
      opts.published === false ? null : Date.now(),
    )
    .run()
  // Seeds the object with *this* document, so `r0`/`h0` are the uids the tests
  // name. `folio.draft` would seed a blank one with freshly minted uids.
  await stubFor(id).getOrInit(doc)
  return id
}

/**
 * The Durable Object behind a story. Cast the way `runtime.ts`'s `stub` is, for
 * the reason `StoryStub`'s own comment gives: naming the class instantiates an RPC
 * type mapper that cannot chew through `Doc`.
 */
const stubFor = (id: string) =>
  env.STORY.get(env.STORY.idFromName(id)) as unknown as {
    getOrInit: (d: Doc) => Promise<Doc>
  }

/** The draft as the object holds it. */
const draftOf = (id: string) => open.draft(env, id)

const slot = (node: NestedBlok, name: string): NestedBlok[] => node.fields[name] as NestedBlok[]

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('delete from sessions'),
    env.DB.prepare('delete from api_tokens'),
    env.DB.prepare('delete from users'),
    env.DB.prepare('delete from versions'),
    env.DB.prepare('delete from content_index'),
    env.DB.prepare('delete from content_refs'),
    env.DB.prepare("delete from stories where id like 'api_%' or id like 'sng_api%'"),
  ])
})

/* ------------------------------------------------------------------ reads --- */

describe('reading published content', () => {
  it('answers the nested shape, with uids and children nested in their slots', async () => {
    await seed({ path: 'apiabout' })
    const res = await call(`${API}/documents/by-path/apiabout`, {
      headers: await tokenFor('content:read'),
    })
    expect(res.status).toBe(200)

    const body = await json<{ content: NestedDoc; source: string; url: string | null }>(res)
    expect(body.source).toBe('published')
    expect(body.url).toBe('/apiabout')
    expect(body.content.uid).toBe('r0')
    expect(body.content.fields.title).toBe('About us')

    const hero = slot(body.content, 'body')[0]!
    expect(hero.type).toBe('apiHero')
    expect(hero.uid).toBe('h0')
    expect(slot(hero, 'actions').map((b) => b.fields.label)).toEqual(['One', 'Two'])
    expect(slot(hero, 'actions').map((b) => b.uid)).toEqual(['b0', 'b1'])
    // The document's id, not the story's — round-tripping depends on both.
    expect(body.content.i18n).toBeUndefined()
    expect(hero.i18n).toEqual({ fr: { heading: 'Bonjour' } })
  })

  it('answers 401 with no token and 403 with a token that lacks the scope', async () => {
    const id = await seed({})
    expect((await call(`${API}/documents/${id}`)).status).toBe(401)

    const res = await call(`${API}/documents/${id}`, { headers: await tokenFor('assets:write') })
    expect(res.status).toBe(403)
    expect((await json<Envelope>(res)).error.message).toMatch(/'content:read' scope/)
  })

  it('resolves a locale into fields and drops i18n', async () => {
    const id = await seed({})
    const res = await call(`${API}/documents/${id}?locale=fr`, {
      headers: await tokenFor('content:read'),
    })
    const body = await json<{ locale: string; content: NestedDoc }>(res)
    expect(body.locale).toBe('fr')
    const hero = slot(body.content, 'body')[0]!
    expect(hero.fields.heading).toBe('Bonjour')
    expect(hero.i18n).toBeUndefined()
  })

  it('refuses a locale this site never declared', async () => {
    const id = await seed({})
    const res = await call(`${API}/documents/${id}?locale=xx`, {
      headers: await tokenFor('content:read'),
    })
    expect(res.status).toBe(501)
  })

  it('404s a path with nothing behind it, and an unrouted document', async () => {
    await seed({ id: 'api_rec1', type: 'apiProductType', path: null })
    expect(
      (await call(`${API}/documents/by-path/nope`, { headers: await tokenFor('content:read') }))
        .status,
    ).toBe(404)
    expect(
      (await call(`${API}/documents/by-path/api_rec1`, { headers: await tokenFor('content:read') }))
        .status,
    ).toBe(404)
  })

  it('says so, usefully, when a document has nothing published', async () => {
    const id = await seed({ published: false })
    const res = await call(`${API}/documents/${id}`, { headers: await tokenFor('content:read') })
    expect(res.status).toBe(404)
    expect((await json<Envelope>(res)).error.message).toMatch(/\?status=draft/)
  })

  it('finds the root story at a bare by-path', async () => {
    await seed({ id: 'api_root', path: '', title: 'Home' })
    const res = await call(`${API}/documents/by-path/`, {
      headers: await tokenFor('content:read'),
    })
    expect(res.status).toBe(200)
    expect((await json<{ id: string }>(res)).id).toBe('api_root')
  })
})

describe('reading a draft', () => {
  it('needs content:read:draft, and content:read alone is refused', async () => {
    const id = await seed({})
    // Drift the draft away from what is published.
    await open.write(env, id, [{ t: 'set', uid: 'r0', field: 'title', value: 'Draft title' }], {
      actor: 'test',
    })

    const refused = await call(`${API}/documents/${id}?status=draft`, {
      headers: await tokenFor('content:read'),
    })
    expect(refused.status).toBe(403)

    const res = await call(`${API}/documents/${id}?status=draft`, {
      headers: await tokenFor('content:read:draft'),
    })
    const body = await json<{ source: string; content: NestedDoc }>(res)
    expect(body.source).toBe('draft')
    expect(body.content.fields.title).toBe('Draft title')
  })

  it('is refused on the by-path route too', async () => {
    await seed({ id: 'api_bp', path: 'apibp' })
    expect(
      (
        await call(`${API}/documents/by-path/apibp?status=draft`, {
          headers: await tokenFor('content:read'),
        })
      ).status,
    ).toBe(403)
  })
})

describe('querying', () => {
  it('pages published documents and reports the totals', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await seed({ path: `apiq${i}`, title: `Q${i}` })
      await call(`${API}/documents/${id}/publish`, {
        method: 'POST',
        headers: await tokenFor('publish'),
      })
    }
    const res = await call(`${API}/documents?type=apiPageType&perPage=2&page=2`, {
      headers: await tokenFor('content:read'),
    })
    const page = await json<{ items: unknown[]; total: number; pages: number }>(res)
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(5)
    expect(page.pages).toBe(3)
  })

  it('refuses ?status=draft as unsupported rather than ignoring it', async () => {
    const res = await call(`${API}/documents?status=draft`, {
      headers: await tokenFor('content:read'),
    })
    expect(res.status).toBe(501)
    expect((await json<Envelope>(res)).error.message).toMatch(/one document at a time/)
  })
})

/* ----------------------------------------------------------------- writes --- */

const put = async (
  id: string,
  content: unknown,
  opts: { mode?: 'merge' | 'replace'; key?: string; scopes?: Scope[] } = {},
) =>
  call(`${API}/documents/${id}/content`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(opts.key ? { 'idempotency-key': opts.key } : {}),
      ...(await tokenFor(...(opts.scopes ?? ['content:write']))),
    },
    body: JSON.stringify({ content, ...(opts.mode ? { mode: opts.mode } : {}) }),
  })

const read = async (id: string): Promise<NestedDoc> => {
  const res = await call(`${API}/documents/${id}?status=draft`, {
    headers: await tokenFor('content:read:draft'),
  })
  return (await json<{ content: NestedDoc }>(res)).content
}

describe('PUT /content', () => {
  it('diffs and commits, and reports what it changed', async () => {
    const id = await seed({})
    const content = await read(id)
    slot(content, 'body')[0]!.fields.heading = 'Changed'

    const res = await put(id, content)
    expect(res.status).toBe(200)
    const body = await json<WriteResult>(res)
    expect(body).toMatchObject({ changed: 1, transactions: 1 })
    expect(body.syncId).toBeGreaterThan(0)

    expect((await draftOf(id)).bloks.h0!.data.heading).toBe('Changed')
  })

  it('writes nothing at all for an unchanged payload', async () => {
    const id = await seed({})
    const res = await put(id, await read(id))
    // syncId 0 is what `getOrInit` wrote: nothing has been logged since.
    expect(await json<WriteResult>(res)).toEqual({ changed: 0, transactions: 0, syncId: 0 })
    // No transaction, which is what "no delta was broadcast" reduces to.
    expect((await activityOf(id)).rows).toEqual([])
  })

  it('preserves every uid across a round trip', async () => {
    const id = await seed({})
    const content = await read(id)
    slot(content, 'body')[0]!.fields.heading = 'Round tripped'
    await put(id, content)
    const after = await draftOf(id)
    expect(Object.keys(after.bloks).sort()).toEqual(['b0', 'b1', 'h0', 'p0', 'r0'])
  })

  it('adds a block with no uid and swaps two, without replacing them', async () => {
    const id = await seed({})
    const content = await read(id)
    const body = slot(content, 'body')
    content.fields.body = [
      body[1]!,
      body[0]!,
      { type: 'apiProse', fields: { body: null } } as unknown as NestedBlok,
    ]

    const res = await put(id, content)
    // Exactly two mutations: one insert for the new block, one move for the
    // sibling whose key could not be kept. Not two inserts and two removes.
    expect(await json<WriteResult>(res)).toMatchObject({ changed: 2, transactions: 1 })

    const after = await draftOf(id)
    // The originals kept their identity; exactly one blok is new.
    expect(Object.keys(after.bloks)).toHaveLength(6)
    expect(after.bloks.h0).toBeDefined()
    expect(after.bloks.p0).toBeDefined()
    const order = Object.values(after.bloks)
      .filter((b) => b.slot === 'body')
      .sort((a, b) => (a.order < b.order ? -1 : 1))
      .map((b) => b.uid)
    expect(order.slice(0, 2)).toEqual(['p0', 'h0'])
  })

  it('merges by default, leaving absent fields and slots alone', async () => {
    const id = await seed({})
    const res = await put(id, { uid: 'r0', fields: { title: 'Merged' } })
    expect((await json<WriteResult>(res)).changed).toBe(1)

    const after = await draftOf(id)
    expect(after.bloks.r0!.data.title).toBe('Merged')
    expect(after.bloks.r0!.data.noindex).toBe(false)
    expect(after.bloks.h0).toBeDefined()
    expect(after.bloks.h0!.i18n).toEqual({ fr: { heading: 'Bonjour' } })
  })

  it('empties an unmentioned slot in replace mode', async () => {
    const id = await seed({})
    // The hero holds translations, so a replace has to be told about them.
    const content = await read(id)
    content.fields.body = []
    const res = await put(id, content, { mode: 'replace' })
    expect(res.status).toBe(200)
    expect(Object.keys(await draftOf(id).then((d) => d.bloks))).toEqual(['r0'])
  })

  it('refuses a replace that would silently discard translations', async () => {
    const id = await seed({})
    const content = await read(id)
    // Strip the hero's i18n, as a naive client that only reads `fields` would.
    delete slot(content, 'body')[0]!.i18n
    const res = await put(id, content, { mode: 'replace' })
    expect(res.status).toBe(400)
    expect((await json<Envelope>(res)).error.message).toMatch(/discard the translations/)
    // Nothing was written.
    expect((await draftOf(id)).bloks.h0!.i18n).toEqual({ fr: { heading: 'Bonjour' } })
  })

  it('does not refuse the same payload in merge mode', async () => {
    const id = await seed({})
    const content = await read(id)
    delete slot(content, 'body')[0]!.i18n
    expect((await put(id, content)).status).toBe(200)
    expect((await draftOf(id)).bloks.h0!.i18n).toEqual({ fr: { heading: 'Bonjour' } })
  })

  it('names the first failing path and writes nothing', async () => {
    const id = await seed({})
    const res = await put(id, {
      uid: 'r0',
      fields: { body: [{ type: 'apiHero', fields: { headng: 'oops' } }] },
    })
    expect(res.status).toBe(400)
    const envelope = await json<Envelope>(res)
    expect(envelope.error.code).toBe('bad_request')
    expect(envelope.error.message).toMatch(/body\[0\]\.fields\.headng/)
    // The original hero survives, so nothing partial landed.
    expect((await draftOf(id)).bloks.h0!.data.heading).toBe('Hello')
  })

  it('refuses an unknown block type by name', async () => {
    const id = await seed({})
    const res = await put(id, { uid: 'r0', fields: { body: [{ type: 'nope', fields: {} }] } })
    expect(res.status).toBe(400)
    expect((await json<Envelope>(res)).error.message).toMatch(/'nope'/)
  })

  it('needs content:write, not content:read', async () => {
    const id = await seed({})
    const res = await put(id, { uid: 'r0', fields: { title: 'x' } }, { scopes: ['content:read'] })
    expect(res.status).toBe(403)
  })

  it('404s a document that does not exist', async () => {
    const res = await put('api_ghost', { fields: {} })
    expect(res.status).toBe(404)
  })

  it('lands a payload of 450 mutations as three transactions, and says so', async () => {
    const id = await seed({})
    const content = await read(id)
    // 450 fresh blocks, replacing the two that were there: 450 inserts plus a
    // remove for each of the two top-level subtrees = 452 mutations.
    content.fields.body = Array.from({ length: 450 }, () => ({
      type: 'apiProse',
      fields: { body: null },
    })) as unknown as NestedBlok[]

    const res = await put(id, content, { mode: 'replace' })
    expect(res.status).toBe(200)
    expect(await json<WriteResult>(res)).toMatchObject({ changed: 452, transactions: 3 })
    // Every chunk landed, so the document really holds all 450.
    const after = await draftOf(id)
    expect(Object.keys(after.bloks)).toHaveLength(451)
  })
})

describe('PATCH /fields', () => {
  const patch = async (id: string, body: unknown, opts: { key?: string; scopes?: Scope[] } = {}) =>
    call(`${API}/documents/${id}/fields`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(opts.key ? { 'idempotency-key': opts.key } : {}),
        ...(await tokenFor(...(opts.scopes ?? ['content:write']))),
      },
      body: JSON.stringify(body),
    })

  it('writes the root by field name and another blok by uid', async () => {
    const id = await seed({})
    const res = await patch(id, {
      fields: { title: 'Patched' },
      bloks: [{ uid: 'h0', fields: { heading: 'Patched hero' } }],
    })
    expect(res.status).toBe(200)
    expect(await json<WriteResult>(res)).toMatchObject({ changed: 2, transactions: 1 })

    const after = await draftOf(id)
    expect(after.bloks.r0!.data.title).toBe('Patched')
    expect(after.bloks.h0!.data.heading).toBe('Patched hero')
    // Structure is untouched: this is the point of the narrower route.
    expect(Object.keys(after.bloks)).toHaveLength(5)
  })

  it('writes a locale-scoped set', async () => {
    const id = await seed({})
    const res = await patch(id, {
      bloks: [{ uid: 'h0', fields: { heading: 'Salut' } }],
      locale: 'fr',
    })
    expect((await json<WriteResult>(res)).changed).toBe(1)
    const after = await draftOf(id)
    expect(after.bloks.h0!.i18n).toEqual({ fr: { heading: 'Salut' } })
    expect(after.bloks.h0!.data.heading).toBe('Hello')
  })

  it('reports changed: 0 for a uid this document does not have', async () => {
    const id = await seed({})
    const res = await patch(id, { bloks: [{ uid: 'notmine', fields: { heading: 'x' } }] })
    expect(res.status).toBe(200)
    expect((await json<WriteResult>(res)).changed).toBe(0)
  })

  it('reports changed: 0 for a value that already equals what is stored', async () => {
    const id = await seed({})
    expect(
      (await json<WriteResult>(await patch(id, { fields: { title: 'About us' } }))).changed,
    ).toBe(0)
  })

  it('refuses an unknown field name and a blocks field', async () => {
    const id = await seed({})
    expect((await patch(id, { fields: { nope: 'x' } })).status).toBe(400)
    const slots = await patch(id, { fields: { body: [] } })
    expect(slots.status).toBe(400)
    expect((await json<Envelope>(slots)).error.message).toMatch(/PUT \/content/)
  })

  it('refuses a value of the wrong shape, naming the field', async () => {
    const id = await seed({})
    const res = await patch(id, { fields: { noindex: 'yes' } })
    expect(res.status).toBe(400)
    expect((await json<Envelope>(res)).error.message).toMatch(
      /fields\.noindex must be true or false/,
    )
  })

  it('refuses an undeclared locale', async () => {
    const id = await seed({})
    expect((await patch(id, { fields: { title: 'x' }, locale: 'xx' })).status).toBe(501)
  })
})

/* ----------------------------------------------------------- idempotency --- */

describe('Idempotency-Key', () => {
  const patchWithKey = async (id: string, value: string, key: string) =>
    call(`${API}/documents/${id}/fields`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        ...(await tokenFor('content:write')),
      },
      body: JSON.stringify({ fields: { title: value } }),
    })

  it('answers a retry with replayed: true and the original syncId', async () => {
    const id = await seed({})
    const first = await json<WriteResult>(await patchWithKey(id, 'Import 42', 'import-42'))
    expect(first.replayed).toBeUndefined()
    expect(first.changed).toBe(1)

    const retry = await json<WriteResult>(await patchWithKey(id, 'Import 42', 'import-42'))
    expect(retry.replayed).toBe(true)
    expect(retry.syncId).toBe(first.syncId)
    expect(retry.changed).toBe(1)
  })

  it('logs exactly one transaction for a retried write', async () => {
    const id = await seed({})
    await patchWithKey(id, 'Once', 'import-once')
    await patchWithKey(id, 'Once', 'import-once')

    const { rows: entries } = await open.draft(env, id).then(() => activityOf(id))
    expect(entries.filter((e) => e.mutations.length > 0)).toHaveLength(1)
  })

  it('ignores a second body under the same key, as documented', async () => {
    const id = await seed({})
    await patchWithKey(id, 'First', 'same-key')
    // A different body, same key: the log answers with the first transaction.
    const second = await json<WriteResult>(await patchWithKey(id, 'Second', 'same-key'))
    expect(second.replayed).toBe(true)
    expect((await draftOf(id)).bloks.r0!.data.title).toBe('First')
  })

  it('scopes a key per document, so the same key writes both', async () => {
    const a = await seed({})
    const b = await seed({})
    expect((await json<WriteResult>(await patchWithKey(a, 'A', 'shared'))).changed).toBe(1)
    expect((await json<WriteResult>(await patchWithKey(b, 'B', 'shared'))).changed).toBe(1)
    expect((await draftOf(a)).bloks.r0!.data.title).toBe('A')
    expect((await draftOf(b)).bloks.r0!.data.title).toBe('B')
  })
})

async function activityOf(id: string) {
  const res = await call(`${ORIGIN}/folio/api/story/${id}/activity`, {
    headers: await cookieFor('admin'),
  })
  return json<{ rows: { mutations: unknown[] }[]; cursor: string | null }>(res)
}

/* -------------------------------------------------------- broadcast to an editor --- */

describe('a write reaches an open editor', () => {
  it('broadcasts the delta to a connected socket, attributed to the token', async () => {
    const id = await seed({})
    const { cookie } = await cookieFor('editor')
    const upgrade = await call(`${ORIGIN}/folio/api/story/${id}/socket`, {
      headers: { upgrade: 'websocket', cookie },
    })
    const ws = upgrade.webSocket!
    ws.accept()

    const frames: Record<string, unknown>[] = []
    ws.addEventListener('message', (e) => {
      frames.push(JSON.parse(String(e.data)) as Record<string, unknown>)
    })
    ws.send(JSON.stringify({ type: 'hello', lastSyncId: 0, v: PROTOCOL_VERSION }))
    await until(() => frames.some((f) => f.type === 'bootstrap'))

    await call(`${API}/documents/${id}/fields`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(await tokenFor('content:write')),
      },
      body: JSON.stringify({ fields: { title: 'From a script' } }),
    })

    await until(() => frames.some((f) => f.type === 'delta'))
    const delta = frames.find((f) => f.type === 'delta') as {
      actor: string
      mutations: { field: string; value: string }[]
    }
    expect(delta.actor).toBe('token:importer')
    expect(delta.mutations[0]!.value).toBe('From a script')
    ws.close()
  })
})

/** Polls a predicate across microtask + timer turns, with a bounded budget. */
async function until(ok: () => boolean, ticks = 300): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (ok()) return
    await new Promise((r) => setTimeout(r, 1))
  }
  throw new Error('condition never held')
}

/* ------------------------------------------------------ create and delete --- */

describe('POST /documents', () => {
  const create = async (body: unknown, scopes: Scope[] = ['content:write']) =>
    call(`${API}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await tokenFor(...scopes)) },
      body: JSON.stringify(body),
    })

  it('creates the row, seeds the document, and answers the nested shape', async () => {
    const res = await create({
      type: 'apiPageType',
      title: 'Created',
      slug: 'apicreated',
      content: { fields: { body: [{ type: 'apiHero', fields: { heading: 'Fresh' } }] } },
    })
    expect(res.status).toBe(201)
    const body = await json<{ id: string; path: string; content: NestedDoc }>(res)
    expect(body.path).toBe('apicreated')
    expect(slot(body.content, 'body')[0]!.fields.heading).toBe('Fresh')

    const stored = await draftOf(body.id)
    expect(Object.values(stored.bloks).some((b) => b.data.heading === 'Fresh')).toBe(true)
    // The title went into the root's own title field, via the type's titleField.
    expect(stored.bloks[stored.root]!.data.title).toBe('Created')
  })

  it('creates a record with no path at all', async () => {
    const res = await create({
      type: 'apiProductType',
      title: 'SKU-1',
      content: { fields: { sku: 'SKU-1', price: 9.5 } },
    })
    const body = await json<{ id: string; path: string | null; url: string | null }>(res)
    expect(body.path).toBeNull()
    expect(body.url).toBeNull()
    const stored = await draftOf(body.id)
    expect(stored.bloks[stored.root]!.data.price).toBe(9.5)
  })

  it('writes nothing when the content is refused', async () => {
    const before = await countStories()
    const res = await create({
      type: 'apiPageType',
      title: 'Bad',
      content: { fields: { body: [{ type: 'apiButton', fields: {} }] } },
    })
    expect(res.status).toBe(400)
    expect((await json<Envelope>(res)).error.message).toMatch(/does not allow/)
    expect(await countStories()).toBe(before)
  })

  it('refuses a singleton, pointing at its derived id', async () => {
    const res = await create({ type: 'apiSettingsType', title: 'Settings' })
    expect(res.status).toBe(409)
    expect((await json<Envelope>(res)).error.message).toMatch(/sng_apiSettingsType/)
  })

  it('refuses an undeclared type as unsupported', async () => {
    expect((await create({ type: 'nope', title: 'x' })).status).toBe(501)
  })
})

const countStories = async () =>
  (
    await env.DB.prepare("select count(*) as n from stories where id like 'api_%'").first<{
      n: number
    }>()
  )?.n ?? 0

describe('PATCH and DELETE /documents/:id', () => {
  it('renames a document and reports the new path', async () => {
    const id = await seed({ path: 'apibefore' })
    const res = await call(`${API}/documents/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await tokenFor('content:write')) },
      body: JSON.stringify({ slug: 'apiafter' }),
    })
    expect(res.status).toBe(200)
    expect((await json<{ path: string; url: string }>(res)).path).toBe('apiafter')
  })

  it('deletes the row, its versions and its index rows, and purges the object', async () => {
    const id = await seed({ path: 'apidoomed' })
    await call(`${API}/documents/${id}/publish`, {
      method: 'POST',
      headers: await tokenFor('publish'),
    })
    expect(await indexRows(id)).toBeGreaterThan(0)

    const res = await call(`${API}/documents/${id}`, {
      method: 'DELETE',
      headers: await tokenFor('content:write'),
    })
    expect(await json<{ deleted: string[] }>(res)).toEqual({ deleted: [id] })
    expect(await indexRows(id)).toBe(0)
  })

  it('refuses to delete a singleton', async () => {
    await call(`${API}/documents/sng_apiSettingsType`, { headers: await tokenFor('content:read') })
    const res = await call(`${API}/documents/sng_apiSettingsType`, {
      method: 'DELETE',
      headers: await tokenFor('content:write'),
    })
    expect(res.status).toBe(409)
  })
})

const indexRows = async (id: string) =>
  (
    await env.DB.prepare('select count(*) as n from content_index where story_id = ?')
      .bind(id)
      .first<{ n: number }>()
  )?.n ?? 0

/* ------------------------------------------------------------- singletons --- */

describe('sng_* ids are addressable', () => {
  it('reads a singleton nothing has ever opened, creating its row', async () => {
    const res = await call(`${API}/documents/sng_apiSettingsType?status=draft`, {
      headers: await tokenFor('content:read:draft'),
    })
    expect(res.status).toBe(200)
    const body = await json<{ id: string; type: string; path: string | null }>(res)
    expect(body.id).toBe('sng_apiSettingsType')
    expect(body.type).toBe('apiSettingsType')
    expect(body.path).toBeNull()
  })

  it('writes one through the ordinary content route', async () => {
    await call(`${API}/documents/sng_apiSettingsType?status=draft`, {
      headers: await tokenFor('content:read:draft'),
    })
    const res = await call(`${API}/documents/sng_apiSettingsType/fields`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await tokenFor('content:write')) },
      body: JSON.stringify({ fields: { tagline: 'Set from a script' } }),
    })
    expect((await json<WriteResult>(res)).changed).toBe(1)
    const stored = await draftOf('sng_apiSettingsType')
    expect(stored.bloks[stored.root]!.data.tagline).toBe('Set from a script')
  })

  it('does not create a row for an sng_ id that names no declared singleton', async () => {
    const res = await call(`${API}/documents/sng_invented`, {
      headers: await tokenFor('content:read'),
    })
    expect(res.status).toBe(404)
  })
})

/* ------------------------------------------------ publish and checkpoints --- */

describe('publish and versions', () => {
  it('publishes, writes a version and rebuilds the index', async () => {
    const id = await seed({ path: 'apipub', published: false })
    await put(id, { uid: 'r0', fields: { title: 'Live now' } })

    const res = await call(`${API}/documents/${id}/publish`, {
      method: 'POST',
      headers: await tokenFor('publish'),
    })
    expect(res.status).toBe(200)
    const body = await json<{ publishedAt: number; version: VersionMeta }>(res)
    expect(body.version.kind).toBe('publish')
    expect(body.version.title).toBe('Live now')
    expect(await indexRows(id)).toBeGreaterThan(0)

    // Now readable as published, with no ?status=draft.
    const published = await call(`${API}/documents/${id}`, {
      headers: await tokenFor('content:read'),
    })
    expect((await json<{ content: NestedDoc }>(published)).content.fields.title).toBe('Live now')
  })

  it('refuses to publish without the publish scope', async () => {
    const id = await seed({})
    const res = await call(`${API}/documents/${id}/publish`, {
      method: 'POST',
      headers: await tokenFor('content:write'),
    })
    expect(res.status).toBe(403)
  })

  it('checkpoints and lists versions', async () => {
    const id = await seed({})
    const made = await call(`${API}/documents/${id}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await tokenFor('publish')) },
      body: JSON.stringify({ label: 'before the import' }),
    })
    expect(made.status).toBe(201)
    expect((await json<VersionMeta>(made)).label).toBe('before the import')

    const list = await call(`${API}/documents/${id}/versions`, {
      headers: await tokenFor('content:read'),
    })
    expect((await json<{ versions: VersionMeta[] }>(list)).versions).toHaveLength(1)
  })

  it('attributes a checkpoint to the token, never to a name a client sent', async () => {
    const id = await seed({})
    const made = await call(`${API}/documents/${id}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await tokenFor('publish')) },
      body: JSON.stringify({ label: 'x', actor: 'somebody else' }),
    })
    expect((await json<VersionMeta>(made)).actor).toBe('token:importer')
  })
})

/* -------------------------------------------------------- schema and assets --- */

describe('the rest of the surface', () => {
  it('answers the manifest at content:read, and refuses without it', async () => {
    const res = await call(`${API}/schema`, { headers: await tokenFor('content:read') })
    const manifest = await json<{ types: DocumentType[]; blocks: unknown[] }>(res)
    expect(manifest.types.map((t) => t.name)).toEqual([
      'apiPageType',
      'apiProductType',
      'apiSettingsType',
    ])
    expect((await call(`${API}/schema`)).status).toBe(401)
  })

  it('lists the media library at content:read and uploads at assets:write', async () => {
    expect((await call(`${API}/assets`, { headers: await tokenFor('content:read') })).status).toBe(
      200,
    )

    const upload = await call(`${API}/assets?filename=one.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', ...(await tokenFor('assets:write')) },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(upload.status).toBe(201)

    const refused = await call(`${API}/assets?filename=two.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', ...(await tokenFor('content:write')) },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(refused.status).toBe(403)
  })

  it('lets a session cookie use the API too, at the same role bar', async () => {
    const id = await seed({})
    const res = await call(`${API}/documents/${id}`, { headers: await cookieFor('viewer') })
    expect(res.status).toBe(200)

    const write = await call(`${API}/documents/${id}/fields`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await cookieFor('viewer')) },
      body: JSON.stringify({ fields: { title: 'x' } }),
    })
    expect(write.status).toBe(403)
  })

  it('passes everything under auth: open, like every other gate', async () => {
    const id = await seed({})
    const res = await open.handle(
      new Request(`${API}/documents/${id}`),
      env,
      createExecutionContext(),
    )
    expect(res!.status).toBe(200)
  })
})

/* -------------------------------------------------------------- folio.write --- */

describe('folio.write', () => {
  it('commits mutations in process, with no HTTP involved', async () => {
    const id = await seed({})
    const result = await open.write(
      env,
      id,
      [{ t: 'set', uid: 'r0', field: 'title', value: 'From the host' }],
      { actor: 'sync-job', name: 'Sync job' },
    )
    expect(result).toMatchObject({ changed: 1, transactions: 1 })
    expect((await draftOf(id)).bloks.r0!.data.title).toBe('From the host')
  })

  it('chunks a write past the per-transaction cap', async () => {
    const id = await seed({})
    const mutations = Array.from({ length: 205 }, (_, i) => ({
      t: 'set' as const,
      uid: 'r0',
      field: 'title',
      value: `n${i}`,
    }))
    const result = await open.write(env, id, mutations, { actor: 'sync-job' })
    expect(result.transactions).toBe(2)
    expect(result.changed).toBe(205)
  })

  it('refuses an id nothing is behind rather than creating an object for it', async () => {
    await expect(
      open.write(env, 'api_nothing', [{ t: 'set', uid: 'r0', field: 'title', value: 'x' }], {
        actor: 'sync-job',
      }),
    ).rejects.toThrow(/Unknown document/)
  })

  it('dedupes on a supplied txId', async () => {
    const id = await seed({})
    const first = await open.write(
      env,
      id,
      [{ t: 'set', uid: 'r0', field: 'title', value: 'Keyed' }],
      { actor: 'sync-job', txId: 'nightly-2026-07-30' },
    )
    const again = await open.write(
      env,
      id,
      [{ t: 'set', uid: 'r0', field: 'title', value: 'Something else' }],
      { actor: 'sync-job', txId: 'nightly-2026-07-30' },
    )
    expect(again.replayed).toBe(true)
    expect(again.syncId).toBe(first.syncId)
    expect((await draftOf(id)).bloks.r0!.data.title).toBe('Keyed')
  })
})
