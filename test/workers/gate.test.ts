import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { blocks, defineBlock, reference, richtext, select, text } from '../../src/core'
import type { Doc, Json } from '../../src/core/doc'
import type { DocumentType } from '../../src/core/schema'
import { createFolio } from '../../src/server'
import type { FolioBindings, FolioGate, FolioGateContext } from '../../src/server'
import { SECURE_SHARE_COOKIE } from '../../src/server/auth/cookie'
import { createShare } from '../../src/server/auth/shares'

/**
 * Visitor access through `reader.page()`
 * (`../../docs/specs/platform/visitor-access.md` phase 3): the host owns who a
 * visitor is, Folio owns what that visitor is handed and what the response may
 * be cached as.
 *
 * Two families of assertion carry the weight here, and neither is visible from
 * a passing render:
 *
 *  - **The header.** `cacheVerdictFor` answers `null` for a host's own path, so
 *    Folio has no request-side opinion about a page route and the response
 *    header is the entire control. `access !== 'public'` ⇒ `no-store` is
 *    therefore the whole security property of this feature: get it backwards and
 *    members-only content sits in a shared cache under its real URL, answered to
 *    whoever asks next.
 *  - **The calls that must not happen.** A public page has to cost *zero* host
 *    calls, or a mostly-public site pays for a membership check on every render
 *    of every page. "Answered public" and "answered public without asking" are
 *    the same observation from outside, so the counter is the only way to see
 *    the second one.
 *
 * Ids and paths are prefixed `gt` throughout: D1 and Durable Object state in this
 * project is isolated per *file* but shared between the tests inside one.
 */

const ORIGIN = 'https://example.com'

const OPTIONS = [
  { label: 'Everyone', value: 'public' },
  { label: 'Members', value: 'members' },
]

const section = defineBlock({
  name: 'gateSection',
  label: 'Section',
  summary: 'heading',
  fields: { heading: text(), prose: richtext() },
  render: () => null,
})

/** The gated root: an `indexed`, untranslatable `select` beside the page's own
 * metadata, plus the prose `redactDoc` withholds. */
const gateRoot = defineBlock({
  name: 'gateRoot',
  label: 'Page',
  summary: 'title',
  fields: {
    title: text({ indexed: true }),
    access: select({ options: OPTIONS, indexed: true }),
    standfirst: text(),
    related: reference({ types: ['gatePage'] }),
    body: richtext({ translatable: true }),
    sections: blocks({ allow: ['gateSection'] }),
  },
  render: () => null,
})

/** A second `page` root that never heard of the gate field. Checkpoint 3: pages
 * of this type are public and `visitor` is not called for them. */
const openRoot = defineBlock({
  name: 'gateOpenRoot',
  label: 'Open page',
  summary: 'title',
  fields: { title: text({ indexed: true }) },
  render: () => null,
})

const settingsRoot = defineBlock({
  name: 'gateSettingsRoot',
  label: 'Settings',
  fields: { siteName: text() },
  render: () => null,
})

const types: DocumentType[] = [
  { name: 'gatePage', label: 'Page', kind: 'page', root: 'gateRoot', default: true },
  { name: 'gateOpen', label: 'Open page', kind: 'page', root: 'gateOpenRoot' },
  { name: 'gateGlobal', label: 'Settings', kind: 'singleton', root: 'gateSettingsRoot' },
]

const bindings = (e: Cloudflare.Env): FolioBindings => ({
  db: e.DB,
  story: e.STORY,
  media: e.MEDIA,
  images: e.IMAGES,
})

function makeFolio(gate?: FolioGate<Cloudflare.Env>) {
  return createFolio<Cloudflare.Env>({
    blocks: [gateRoot, openRoot, section, settingsRoot],
    types,
    globals: ['gateGlobal'],
    bindings,
    basePath: '/folio',
    assets: { admin: '/folio-admin.js', preview: '/folio-preview.js' },
    // The draft cookie is the whole authority under `auth: 'open'`, which is what
    // `read-session.test.ts` uses to reach draft mode without a session.
    auth: 'open',
    route: (p) => (p ? `/${p}` : '/'),
    locales: {
      default: 'en',
      available: [
        { code: 'en', label: 'English' },
        { code: 'fr', label: 'Français' },
      ],
    },
    ...(gate ? { gate } : {}),
  })
}

/* ------------------------------------------------------------- recorders --- */

interface Recorder {
  /** How many times the host was asked who is asking. */
  visitors: number
  /** Every `allows` call, in order, with what it was told. */
  allows: { who: unknown; value: Json | undefined; ctx: FolioGateContext }[]
}

/**
 * A gate that records what it was asked, so a test can assert on the calls that
 * did *not* happen as easily as on the answer.
 */
function recording(
  visitor: (req: Request) => unknown,
  verdict: (who: unknown, value: Json | undefined) => boolean,
): { gate: FolioGate<Cloudflare.Env>; seen: Recorder } {
  const seen: Recorder = { visitors: 0, allows: [] }
  const gate: FolioGate<Cloudflare.Env> = {
    field: 'access',
    public: 'public',
    visitor(req) {
      seen.visitors++
      return visitor(req)
    },
    allows(who, value, ctx) {
      seen.allows.push({ who, value, ctx })
      return verdict(who, value)
    },
  }
  return { gate, seen }
}

/** The member every "granted" test signs in as, and the cookie that means them. */
const MEMBER = { id: 'mem_1' }
const memberOf = (req: Request) => (req.headers.get('cookie')?.includes('member=1') ? MEMBER : null)

/* -------------------------------------------------------------- fixtures --- */

const PROSE = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SECRET BODY' }] }],
} as const

function gatedDoc(opts: {
  access?: Json
  title?: string
  i18n?: Record<string, Record<string, Json>>
}): Doc {
  const data: Record<string, Json> = {
    title: opts.title ?? 'Members only',
    standfirst: 'The teaser everybody sees',
    related: 'sty_gt_ref',
    body: PROSE as unknown as Json,
  }
  if (opts.access !== undefined) data.access = opts.access
  return {
    root: 'g0',
    bloks: {
      g0: {
        uid: 'g0',
        type: 'gateRoot',
        parent: null,
        slot: null,
        order: 'a0',
        data,
        ...(opts.i18n ? { i18n: opts.i18n } : {}),
      },
      g1: {
        uid: 'g1',
        type: 'gateSection',
        parent: 'g0',
        slot: 'sections',
        order: 'a0',
        data: { heading: 'SECRET HEADING', prose: PROSE as unknown as Json },
      },
    },
  }
}

function openDoc(title: string): Doc {
  return {
    root: 'o0',
    bloks: {
      o0: {
        uid: 'o0',
        type: 'gateOpenRoot',
        parent: null,
        slot: null,
        order: 'a0',
        data: { title },
      },
    },
  }
}

async function publishRow(
  id: string,
  opts: { type?: string; path: string | null; title: string; doc: Doc; parentId?: string | null },
) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                          published_doc, published_at)
     values (?, ?, ?, ?, ?, 'a0', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.type ?? 'gatePage',
      opts.parentId ?? null,
      opts.path === null ? id : (opts.path.split('/').pop() ?? ''),
      opts.path,
      opts.title,
      Date.now(),
      Date.now(),
      JSON.stringify(opts.doc),
      Date.now(),
    )
    .run()
}

const req = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}/${path}`, cookie ? { headers: { cookie } } : undefined)

/**
 * Drifts a story's *draft* away from what is published, through the mutation log
 * — `folio.write` seeds the object and commits, which is the only sanctioned way
 * to change a draft from outside the editor.
 */
async function setDraftAccess(
  folio: ReturnType<typeof makeFolio>,
  id: string,
  value: string,
): Promise<void> {
  const draft = await folio.draft(env, id)
  await folio.write(env, id, [{ t: 'set', uid: draft.root, field: 'access', value }], {
    actor: 'gate-test',
  })
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare('delete from content_index'),
    env.DB.prepare('delete from shares'),
    env.DB.prepare('delete from stories'),
  ])

  // A global, so a denied page can be shown to still carry the host's shell.
  await publishRow('sng_gateGlobal', {
    type: 'gateGlobal',
    path: null,
    title: 'Settings',
    doc: {
      root: 's0',
      bloks: {
        s0: {
          uid: 's0',
          type: 'gateSettingsRoot',
          parent: null,
          slot: null,
          order: 'a0',
          data: { siteName: 'Gated Times' },
        },
      },
    },
  })

  await publishRow('sty_gt_ref', {
    path: 'gt-ref',
    title: 'Referenced',
    doc: gatedDoc({ access: 'public', title: 'Referenced' }),
  })
  await publishRow('sty_gt_pub', {
    path: 'gt-public',
    title: 'Public',
    doc: gatedDoc({ access: 'public', title: 'Public' }),
  })
  await publishRow('sty_gt_mem', {
    path: 'gt-members',
    title: 'Members only',
    doc: gatedDoc({
      access: 'members',
      i18n: { fr: { title: 'Réservé aux membres', body: PROSE as unknown as Json } },
    }),
  })
  await publishRow('sty_gt_mem2', {
    path: 'gt-members-2',
    title: 'Members only, again',
    doc: gatedDoc({ access: 'members', title: 'Members only, again' }),
  })
  await publishRow('sty_gt_absent', {
    path: 'gt-absent',
    title: 'Field never set',
    doc: gatedDoc({ title: 'Field never set' }),
  })
  await publishRow('sty_gt_open', {
    type: 'gateOpen',
    path: 'gt-open',
    title: 'No gate field at all',
    doc: openDoc('No gate field at all'),
  })
  await publishRow('sty_gt_i18n', {
    path: 'gt-i18n',
    title: 'Gated in English only',
    doc: gatedDoc({
      access: 'members',
      title: 'Gated in English only',
      // An importer wrote the gate field into a locale. The renderer's rule would
      // let this win; the gate's rule must not.
      i18n: { fr: { access: 'public' } },
    }),
  })
  await publishRow('sty_gt_draft', {
    path: 'gt-draft',
    title: 'Draft mode',
    doc: gatedDoc({ access: 'members', title: 'Draft mode' }),
  })
  await publishRow('sty_gt_share1', {
    path: 'gt-share-1',
    title: 'Shared',
    doc: gatedDoc({ access: 'members', title: 'Shared' }),
  })
  await publishRow('sty_gt_share2', {
    path: 'gt-share-2',
    title: 'Not shared',
    doc: gatedDoc({ access: 'members', title: 'Not shared' }),
  })
})

/* ------------------------------------------------------- the untouched case --- */

describe('a host with no gate', () => {
  it('answers access public and both cache headers, exactly as before', async () => {
    const page = await makeFolio().reader(env, req('gt-members')).page('gt-members')

    expect(page?.access).toBe('public')
    expect(page?.draft).toBe(false)
    expect(page?.headers['cache-control']).toContain('s-maxage=')
    expect(page?.headers['cache-tag']).toContain('story:sty_gt_mem')
    // The document is untouched: no `gate` means no redaction, whatever the field
    // happens to hold.
    expect(Object.keys(page?.doc.bloks ?? {}).sort()).toEqual(['g0', 'g1'])
  })
})

/* ------------------------------------------------------ what costs nothing --- */

describe('an ungated page', () => {
  it('keeps both cache headers and never calls visitor', async () => {
    const { gate, seen } = recording(memberOf, () => true)
    const page = await makeFolio(gate).reader(env, req('gt-public')).page('gt-public')

    expect(page?.access).toBe('public')
    expect(seen.visitors).toBe(0)
    expect(seen.allows).toHaveLength(0)
    expect(page?.headers['cache-control']).toContain('s-maxage=')
    expect(page?.headers['cache-tag']).toContain('story:sty_gt_pub')
  })

  /**
   * Checkpoint 3, the one place this design fails *open* and was confirmed twice:
   * a `page` root that does not declare the field is public. A root without the
   * input cannot mislead an editor into thinking the page is gated.
   */
  it('is public and never calls visitor when its root lacks the field', async () => {
    const { gate, seen } = recording(memberOf, () => false)
    const page = await makeFolio(gate).reader(env, req('gt-open')).page('gt-open')

    expect(page?.access).toBe('public')
    expect(seen.visitors).toBe(0)
    expect(seen.allows).toHaveLength(0)
    expect(page?.headers['cache-tag']).toContain('story:sty_gt_open')
  })
})

/* ---------------------------------------------------------------- granted --- */

describe('a member', () => {
  it('is granted the full doc, with private no-store and no cache-tag', async () => {
    const { gate, seen } = recording(memberOf, (who) => who !== null)
    const page = await makeFolio(gate).reader(env, req('gt-members', 'member=1')).page('gt-members')

    expect(seen.visitors).toBe(1)
    expect(seen.allows).toHaveLength(1)
    expect(seen.allows[0]?.who).toEqual(MEMBER)
    expect(seen.allows[0]?.value).toBe('members')
    expect(seen.allows[0]?.ctx.story.id).toBe('sty_gt_mem')

    expect(page?.access).toBe('granted')
    expect(Object.keys(page?.doc.bloks ?? {}).sort()).toEqual(['g0', 'g1'])
    expect(JSON.stringify(page?.doc)).toContain('SECRET BODY')
    // Exactly the one header, and emphatically not a cache tag: the same URL
    // answered differently to a stranger a moment ago.
    expect(page?.headers).toEqual({ 'cache-control': 'private, no-store' })
  })
})

/* ----------------------------------------------------------------- denied --- */

describe('a stranger', () => {
  it('is denied the redacted doc, keeps the globals, and gets private no-store', async () => {
    const { gate, seen } = recording(memberOf, (who) => who !== null)
    const page = await makeFolio(gate).reader(env, req('gt-members')).page('gt-members')

    expect(page?.access).toBe('denied')
    expect(seen.allows[0]?.who).toBeNull()

    // Only the root survives, so every `blocks` slot is empty by construction.
    expect(Object.keys(page?.doc.bloks ?? {})).toEqual(['g0'])
    const root = page?.doc.bloks.g0
    expect(root?.data.body).toBeNull()
    expect(root?.i18n?.fr?.body).toBeNull()
    // The teaser: scalars, the gate field itself, and the reference are intact.
    expect(root?.data.title).toBe('Members only')
    expect(root?.data.standfirst).toBe('The teaser everybody sees')
    expect(root?.data.access).toBe('members')
    expect(root?.data.related).toBe('sty_gt_ref')
    expect(root?.i18n?.fr?.title).toBe('Réservé aux membres')
    // Nothing the body said, in any locale, in any child.
    expect(JSON.stringify(page?.doc)).not.toContain('SECRET BODY')
    expect(JSON.stringify(page?.doc)).not.toContain('SECRET HEADING')

    // The host still renders its own shell around the paywall.
    expect(page?.resolution.globals?.gateGlobal).toBeTruthy()
    // …and the resolution was built from the redacted document, so the reference
    // the root itself holds is loaded and nothing the body pointed at is.
    expect(page?.resolution.stories['sty_gt_ref']).toBeTruthy()

    expect(page?.headers).toEqual({ 'cache-control': 'private, no-store' })
  })

  /**
   * Checkpoint 2: only `gate.public` is ungated, so a document written before the
   * field existed fails closed. The cost is stated in the spec — `visitor` runs
   * and the page is `no-store` until a `field.default` migration backfills it.
   */
  it('is asked about a missing value rather than waved through', async () => {
    const { gate, seen } = recording(memberOf, () => false)
    const page = await makeFolio(gate).reader(env, req('gt-absent')).page('gt-absent')

    expect(seen.visitors).toBe(1)
    expect(seen.allows).toHaveLength(1)
    expect(seen.allows[0]?.value).toBeUndefined()
    expect(page?.access).toBe('denied')
  })
})

/* ------------------------------------------------------------ failing shut --- */

describe('a gate that cannot decide', () => {
  it('denies and logs when visitor throws, and page() still resolves', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { gate, seen } = recording(
        () => {
          throw new Error('idp is down')
        },
        () => true,
      )
      const page = await makeFolio(gate).reader(env, req('gt-members')).page('gt-members')

      expect(page?.access).toBe('denied')
      // `allows` is never reached: there is nobody to ask about.
      expect(seen.allows).toHaveLength(0)
      expect(Object.keys(page?.doc.bloks ?? {})).toEqual(['g0'])
      expect(page?.headers).toEqual({ 'cache-control': 'private, no-store' })
      expect(spy).toHaveBeenCalled()
      expect(String(spy.mock.calls[0]?.[0])).toContain('gate.visitor threw')
    } finally {
      spy.mockRestore()
    }
  })

  it('denies when allows throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { gate } = recording(memberOf, () => {
        throw new Error('membership api is down')
      })
      const page = await makeFolio(gate)
        .reader(env, req('gt-members', 'member=1'))
        .page('gt-members')

      expect(page?.access).toBe('denied')
      expect(page?.headers).toEqual({ 'cache-control': 'private, no-store' })
      expect(String(spy.mock.calls[0]?.[0])).toContain('gate.allows threw')
    } finally {
      spy.mockRestore()
    }
  })
})

/* ------------------------------------------------------------- no request --- */

describe('a reader built without a Request', () => {
  /** A sitemap build or a warm-up: there is nobody to be, so `allows` is asked
   * about `null` rather than the host being handed a request it does not have. */
  it('never calls visitor and hands allows null', async () => {
    const { gate, seen } = recording(memberOf, () => false)
    const page = await makeFolio(gate).reader(env).page('gt-members')

    expect(seen.visitors).toBe(0)
    expect(seen.allows).toHaveLength(1)
    expect(seen.allows[0]?.who).toBeNull()
    expect(page?.access).toBe('denied')
  })
})

/* ------------------------------------------------------- a Folio credential --- */

describe('an editor in draft mode', () => {
  it('is never gated', async () => {
    const { gate, seen } = recording(memberOf, () => false)
    const folio = makeFolio(gate)
    await setDraftAccess(folio, 'sty_gt_draft', 'members')

    const page = await folio.reader(env, req('gt-draft', 'folio_draft=1')).page('gt-draft')

    expect(page?.draft).toBe(true)
    expect(page?.access).toBe('granted')
    expect(seen.visitors).toBe(0)
    expect(seen.allows).toHaveLength(0)
    expect(page?.headers).toEqual({ 'cache-control': 'private, no-store' })
  })
})

describe('a reviewer holding a share cookie', () => {
  it('skips the gate for this story, and is an anonymous visitor on any other', async () => {
    const { gate, seen } = recording(memberOf, () => false)
    const folio = makeFolio(gate)
    await setDraftAccess(folio, 'sty_gt_share1', 'members')

    const minted = await createShare(env.DB, {
      storyId: 'sty_gt_share1',
      expiresAt: Date.now() + 60_000,
    })
    const cookie = `${SECURE_SHARE_COOKIE}=${minted.token}`

    const granted = await folio.reader(env, req('gt-share-1', cookie)).page('gt-share-1')
    expect(granted?.draft).toBe(true)
    expect(granted?.access).toBe('granted')
    expect(seen.visitors).toBe(0)

    // The grant names one story, and this spec must not be the thing that widens
    // it: on any other page the same cookie is just a stranger's.
    const denied = await folio.reader(env, req('gt-share-2', cookie)).page('gt-share-2')
    expect(denied?.draft).toBe(false)
    expect(denied?.access).toBe('denied')
    expect(seen.visitors).toBe(1)
    expect(seen.allows).toHaveLength(1)
  })
})

/* ------------------------------------------------------------ memoisation --- */

describe('visitor', () => {
  it('resolves once per reader across two page() calls', async () => {
    const { gate, seen } = recording(memberOf, (who) => who !== null)
    const reader = makeFolio(gate).reader(env, req('gt-members', 'member=1'))

    const first = await reader.page('gt-members')
    const second = await reader.page('gt-members-2')

    expect(first?.access).toBe('granted')
    expect(second?.access).toBe('granted')
    expect(seen.visitors).toBe(1)
    expect(seen.allows).toHaveLength(2)
  })
})

/* ----------------------------------------------------------------- locales --- */

describe('the gate', () => {
  /**
   * Decision 2, and the one deliberate exception to this repo's "read fields
   * through `fieldValue`" rule. The renderer lets an `i18n` value win over
   * `data`; applied to a gate that would mean a French translation reading
   * "public" opens the English page to anyone who asks in French.
   */
  it('reads data, never i18n', async () => {
    const { gate, seen } = recording(memberOf, () => false)
    const page = await makeFolio(gate).reader(env, req('gt-i18n')).page('gt-i18n', { locale: 'fr' })

    expect(seen.allows).toHaveLength(1)
    expect(seen.allows[0]?.value).toBe('members')
    expect(seen.allows[0]?.ctx.locale).toBe('fr')
    expect(page?.access).toBe('denied')
    expect(page?.headers).toEqual({ 'cache-control': 'private, no-store' })
  })
})

/* -------------------------------------------------------------- the lists --- */

describe('folio.query', () => {
  /**
   * Checkpoint 6: lists are untouched, so the host's filter is the whole remedy —
   * which is the second reason `validateGate` insists the field is `indexed`.
   * Spec 30 decision 11 compiles the same predicate for search.
   */
  it('excludes gated rows when the caller filters on the field', async () => {
    await publishRow('sty_gt_qparent', {
      path: 'gt-list',
      title: 'Archive',
      doc: gatedDoc({ access: 'public', title: 'Archive' }),
    })
    await publishRow('sty_gt_qpub', {
      path: 'gt-list/one',
      parentId: 'sty_gt_qparent',
      title: 'Listed',
      doc: gatedDoc({ access: 'public', title: 'Listed' }),
    })
    await publishRow('sty_gt_qmem', {
      path: 'gt-list/two',
      parentId: 'sty_gt_qparent',
      title: 'Unlisted',
      doc: gatedDoc({ access: 'members', title: 'Unlisted' }),
    })

    // Rows are written by publish, and these were inserted directly.
    const folio = makeFolio(recording(memberOf, () => false).gate)
    await folio.reindex(env, { batch: 200 })

    const all = await folio.query(env, { type: 'gatePage', parent: 'sty_gt_qparent' })
    expect(all.items.map((i) => i.id).sort()).toEqual(['sty_gt_qmem', 'sty_gt_qpub'])

    const public_ = await folio.query(env, {
      type: 'gatePage',
      parent: 'sty_gt_qparent',
      where: [{ field: 'access', op: 'in', value: ['public'] }],
    })
    expect(public_.items.map((i) => i.id)).toEqual(['sty_gt_qpub'])
  })
})
