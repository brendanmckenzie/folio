import { describe, expect, it } from 'vitest'
import {
  docCapError,
  fallbackColour,
  isClientMsg,
  isPreviewMsg,
  MAX_ACTOR_LEN,
  MAX_DOC_BLOKS,
  MAX_DOC_BYTES,
  MAX_FRAME_BYTES,
  MAX_NAME_LEN,
  MAX_SELECTION_LEN,
  MAX_TX_MUTATIONS,
  parseClientFrame,
  PROTOCOL_VERSION,
  txCapError,
} from '../../../src/core/protocol'

/**
 * The wire caps: every guard branch that decides whether a frame is admitted,
 * narrowed, normalized or refused. `parseClientFrame` is the door every one of
 * these goes through, so most assertions read its output rather than poking
 * `isClientMsg` directly.
 */

const setMutation = (uid = 'root0000', value: unknown = 'x') => ({
  t: 'set',
  uid,
  field: 'title',
  value,
})

const send = (body: Record<string, unknown>) => JSON.stringify({ ...body, v: PROTOCOL_VERSION })

/**
 * The version is a fact both ends and every `scripts/*.mjs` stamp from this one
 * constant, so a bump that was meant and a bump that happened are the same
 * thing. Pinned as a literal on purpose: an accidental change to a number every
 * frame carries would otherwise be invisible until a deployed tab stopped
 * talking to a deployed worker.
 */
describe('PROTOCOL_VERSION', () => {
  it('is 4 — `presence` carries a field and a locale, and a space channel appears (live-collaboration.md)', () => {
    expect(PROTOCOL_VERSION).toBe(4)
  })
})

/** The identity a client may still assert, as one optional nested object. */
const hello = (identity?: Record<string, unknown>, lastSyncId: unknown = 0) =>
  send({ type: 'hello', lastSyncId, ...(identity ? { identity } : {}) })

const ada = (over: Record<string, unknown> = {}) => ({
  actor: 'usr_ada',
  name: 'Ada',
  colour: '#ff00ff',
  ...over,
})

const identityOf = (frame: unknown) =>
  (frame as { identity?: { actor: string; name: string; colour: string } }).identity

describe('parseClientFrame: hello', () => {
  it('parses a well-formed hello unchanged', () => {
    expect(parseClientFrame(hello(ada(), 3))).toEqual({
      type: 'hello',
      lastSyncId: 3,
      identity: { actor: 'usr_ada', name: 'Ada', colour: '#ff00ff' },
      v: PROTOCOL_VERSION,
    })
  })

  /**
   * The v3 shedding, from the wire's side: identity is not something a `hello`
   * has to carry any more, because on a deployment with accounts the Worker
   * already attached one at upgrade time. The key is *omitted* rather than
   * present-and-undefined, so nothing downstream has to distinguish the two.
   */
  it('parses a hello that asserts no identity at all', () => {
    const frame = parseClientFrame(hello(undefined, 7))
    expect(frame).toEqual({ type: 'hello', lastSyncId: 7, v: PROTOCOL_VERSION })
    expect(frame).not.toHaveProperty('identity')
  })

  it('trims and caps a name at MAX_NAME_LEN', () => {
    const frame = parseClientFrame(hello(ada({ name: `  ${'a'.repeat(MAX_NAME_LEN + 20)}  ` })))
    expect(frame?.type).toBe('hello')
    expect(identityOf(frame)?.name).toBe('a'.repeat(MAX_NAME_LEN))
  })

  it('defaults an empty or whitespace-only name to Anonymous', () => {
    for (const name of ['', '   ', '\t\n']) {
      expect(identityOf(parseClientFrame(hello(ada({ name }))))?.name).toBe('Anonymous')
    }
  })

  it('strips control characters from actor and caps it at MAX_ACTOR_LEN', () => {
    const actor = `usr\x00_${'b'.repeat(MAX_ACTOR_LEN + 10)}`
    const cleaned = identityOf(parseClientFrame(hello(ada({ actor }))))?.actor ?? ''
    expect(cleaned).not.toContain('\x00')
    expect(cleaned.length).toBe(MAX_ACTOR_LEN)
  })

  // The field the comment above stripControlChars is actually about: a display
  // name rides on every presence broadcast and the log's activity trail for the
  // life of the socket, same as `actor` - it must not carry controls either.
  it('strips control characters from name', () => {
    const name = identityOf(parseClientFrame(hello(ada({ name: 'Ada\x00\x7f Lovelace' }))))?.name
    expect(name).not.toContain('\x00')
    expect(name).not.toContain('\x7f')
    expect(name).toBe('Ada Lovelace')
  })

  // Bidi overrides/isolates can reorder a rendered name away from what was
  // stored, exactly the ranges validate.ts's PRINTABLE refuses on the HTTP side.
  it('strips bidi override and isolate characters from name and actor', () => {
    const evil = 'Ada‮evil‬'
    const identity = identityOf(parseClientFrame(hello(ada({ actor: evil, name: evil }))))
    expect(identity?.name).toBe('Adaevil')
    expect(identity?.actor).toBe('Adaevil')
  })

  it('keeps a colour that matches the 6-digit hex form', () => {
    expect(identityOf(parseClientFrame(hello(ada({ colour: '#A1B2C3' }))))?.colour).toBe('#A1B2C3')
  })

  // A client cannot choose its way past the guard: shorthand hex, a bare word, and
  // a missing '#' are all colours the client asserted that this door does not trust.
  it.each(['#fff', 'red', 'ff00ff', '#gggggg', '#ff00ff0'])(
    'falls back to a colour derived from actor when colour is %s',
    (colour) => {
      expect(identityOf(parseClientFrame(hello(ada({ colour }))))?.colour).toBe(
        fallbackColour('usr_ada'),
      )
    },
  )

  it('rejects a hello whose identity is missing a field', () => {
    expect(parseClientFrame(hello({ actor: 'usr_ada', colour: '#ff00ff' }))).toBeNull()
  })

  it('rejects a hello whose identity is not an object', () => {
    expect(parseClientFrame(send({ type: 'hello', lastSyncId: 0, identity: 'Ada' }))).toBeNull()
  })

  it('rejects a hello whose lastSyncId is the wrong type', () => {
    expect(parseClientFrame(hello(ada(), '3'))).toBeNull()
  })

  it('rejects a hello with no lastSyncId at all', () => {
    expect(parseClientFrame(send({ type: 'hello' }))).toBeNull()
  })
})

describe('fallbackColour', () => {
  it('is deterministic for the same actor', () => {
    expect(fallbackColour('usr_ada')).toBe(fallbackColour('usr_ada'))
  })

  it('always produces a 6-digit hex colour', () => {
    for (const actor of ['', 'a', 'usr_ada', 'usr_bo', '🙂'.repeat(3)]) {
      expect(fallbackColour(actor)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('differs across distinct actors (not a constant fallback)', () => {
    expect(fallbackColour('usr_ada')).not.toBe(fallbackColour('usr_bo'))
  })
})

describe('parseClientFrame: tx', () => {
  it('parses a well-formed tx unchanged', () => {
    const frame = parseClientFrame(send({ type: 'tx', txId: 'tx-1', mutations: [setMutation()] }))
    expect(frame).toEqual({
      type: 'tx',
      txId: 'tx-1',
      mutations: [setMutation()],
      v: PROTOCOL_VERSION,
    })
  })

  it('rejects a tx whose mutations are not an array', () => {
    expect(parseClientFrame(send({ type: 'tx', txId: 'tx-1', mutations: 'nope' }))).toBeNull()
  })

  it('rejects a tx containing one structurally invalid mutation', () => {
    expect(
      parseClientFrame(
        send({ type: 'tx', txId: 'tx-1', mutations: [setMutation(), { t: 'insert' }] }),
      ),
    ).toBeNull()
  })

  /**
   * `retype` is the v2 addition (`schema-migrations.md`). The guard has to know
   * it or every migration transaction would arrive as an unreadable frame — and
   * a `retype` missing its `type` must not sail through and reach `apply` as an
   * undefined type name.
   */
  it('parses a tx carrying a retype', () => {
    const frame = parseClientFrame(
      send({
        type: 'tx',
        txId: 'tx-r',
        mutations: [{ t: 'retype', uid: 'blk00001', type: 'quote' }],
      }),
    )
    expect(frame).toEqual({
      type: 'tx',
      txId: 'tx-r',
      mutations: [{ t: 'retype', uid: 'blk00001', type: 'quote' }],
      v: PROTOCOL_VERSION,
    })
  })

  it.each([
    { t: 'retype', uid: 'blk00001' },
    { t: 'retype', type: 'quote' },
    { t: 'retype', uid: 'blk00001', type: 7 },
    { t: 'retype', uid: null, type: 'quote' },
  ])('rejects a malformed retype (%o)', (mutation) => {
    expect(parseClientFrame(send({ type: 'tx', txId: 'tx-r', mutations: [mutation] }))).toBeNull()
  })

  /**
   * The v3 addition (`localisation.md`). Three properties, and the first is the
   * one that has to hold forever: a `set` with no locale is still a `set`, so
   * every entry in every log written before this deploy replays as a
   * source-locale write.
   */
  it('parses a set with no locale, exactly as it did before v3', () => {
    const frame = parseClientFrame(send({ type: 'tx', txId: 'tx-1', mutations: [setMutation()] }))
    expect(frame).toEqual({
      type: 'tx',
      txId: 'tx-1',
      mutations: [setMutation()],
      v: PROTOCOL_VERSION,
    })
    expect((frame as { mutations: unknown[] }).mutations[0]).not.toHaveProperty('locale')
  })

  it('parses a locale-scoped set through unchanged', () => {
    const mutation = { ...setMutation(), value: 'Bonjour', locale: 'fr' }
    const frame = parseClientFrame(send({ type: 'tx', txId: 'tx-fr', mutations: [mutation] }))
    expect(frame).toEqual({
      type: 'tx',
      txId: 'tx-fr',
      mutations: [mutation],
      v: PROTOCOL_VERSION,
    })
  })

  // An unknown locale code is not a wire concern, for the same reason `retype`
  // does not check the schema: the object is deliberately ignorant of config.
  it('accepts a locale the site has never declared', () => {
    const mutation = { ...setMutation(), locale: 'kl-GL' }
    expect(
      parseClientFrame(send({ type: 'tx', txId: 'tx-x', mutations: [mutation] })),
    ).not.toBeNull()
  })

  it.each([{ locale: 7 }, { locale: null }, { locale: { code: 'fr' } }])(
    'rejects a set whose locale is not a string (%o)',
    (over) => {
      const mutation = { ...setMutation(), ...over }
      expect(parseClientFrame(send({ type: 'tx', txId: 'tx-b', mutations: [mutation] }))).toBeNull()
    },
  )

  it('still parses a tx whose mutation count exceeds the cap: the door names it via reject, not an unreadable frame', () => {
    const mutations = Array.from({ length: MAX_TX_MUTATIONS + 1 }, (_, i) => setMutation(`u${i}`))
    const frame = parseClientFrame(send({ type: 'tx', txId: 'tx-big', mutations }))
    expect(frame?.type).toBe('tx')
    expect((frame as { txId: string }).txId).toBe('tx-big')
  })
})

describe('txCapError', () => {
  it('is null at and under the cap', () => {
    const atCap = Array.from({ length: MAX_TX_MUTATIONS }, (_, i) => setMutation(`u${i}`))
    expect(txCapError(atCap as never)).toBeNull()
    expect(txCapError([] as never)).toBeNull()
  })

  it('names the count and the cap one mutation over', () => {
    const overCap = Array.from({ length: MAX_TX_MUTATIONS + 1 }, (_, i) => setMutation(`u${i}`))
    const reason = txCapError(overCap as never)
    expect(reason).toContain(String(MAX_TX_MUTATIONS + 1))
    expect(reason).toContain(String(MAX_TX_MUTATIONS))
  })
})

describe('docCapError', () => {
  const doc = (bloks: number) => ({
    root: 'root0000',
    bloks: Object.fromEntries(
      Array.from({ length: bloks }, (_, i) => [
        `u${i}`,
        { uid: `u${i}`, type: 'box', parent: null, slot: null, order: 'a0', data: {} },
      ]),
    ),
  })

  it('is null for a document within both ceilings', () => {
    expect(docCapError(doc(3) as never)).toBeNull()
  })

  it('names the blok count once it exceeds MAX_DOC_BLOKS', () => {
    const reason = docCapError(doc(MAX_DOC_BLOKS + 1) as never)
    expect(reason).toContain(String(MAX_DOC_BLOKS + 1))
    expect(reason).toContain(String(MAX_DOC_BLOKS))
  })

  it('names the byte size once the serialised document exceeds MAX_DOC_BYTES', () => {
    // Few bloks, but one holds a value alone past the byte ceiling: the blok
    // count is nowhere near MAX_DOC_BLOKS, so only the byte check can catch it.
    const big = {
      root: 'root0000',
      bloks: {
        root0000: {
          uid: 'root0000',
          type: 'page',
          parent: null,
          slot: null,
          order: 'a0',
          data: { body: 'x'.repeat(MAX_DOC_BYTES + 1024) },
        },
      },
    }
    const reason = docCapError(big as never)
    expect(reason).toContain('bytes')
    expect(reason).toContain(String(MAX_DOC_BYTES))
  })

  it('accepts a precomputed json string instead of re-serialising', () => {
    const small = doc(3)
    expect(docCapError(small as never, JSON.stringify(small))).toBeNull()
  })
})

describe('parseClientFrame: presence', () => {
  it('parses a selection through unchanged when within the cap', () => {
    const frame = parseClientFrame(
      send({ type: 'presence', selection: { uid: 'blk00001', field: 'heading' } }),
    )
    expect(frame).toEqual({
      type: 'presence',
      selection: { uid: 'blk00001', field: 'heading' },
      locale: null,
      v: PROTOCOL_VERSION,
    })
  })

  /** `field: null` is the pre-v4 meaning: this blok, no particular field. */
  it('accepts a blok-only selection', () => {
    const frame = parseClientFrame(
      send({ type: 'presence', selection: { uid: 'blk00001', field: null } }),
    )
    expect(frame).toEqual({
      type: 'presence',
      selection: { uid: 'blk00001', field: null },
      locale: null,
      v: PROTOCOL_VERSION,
    })
  })

  it('passes null through unchanged', () => {
    const frame = parseClientFrame(send({ type: 'presence', selection: null }))
    expect(frame).toEqual({
      type: 'presence',
      selection: null,
      locale: null,
      v: PROTOCOL_VERSION,
    })
  })

  it('caps both parts of an oversized selection at MAX_SELECTION_LEN', () => {
    const long = 'x'.repeat(MAX_SELECTION_LEN + 40)
    const frame = parseClientFrame(
      send({ type: 'presence', selection: { uid: long, field: long } }),
    )
    expect((frame as { selection: { uid: string; field: string } }).selection).toEqual({
      uid: 'x'.repeat(MAX_SELECTION_LEN),
      field: 'x'.repeat(MAX_SELECTION_LEN),
    })
  })

  it('carries a locale, capped and control-stripped', () => {
    const frame = parseClientFrame(send({ type: 'presence', selection: null, locale: ` fr-CA ` }))
    expect((frame as { locale: string | null }).locale).toBe('fr-CA')
  })

  /** An absent locale and an explicit null both mean the source locale, so a
   * reader has one case rather than three. */
  it('normalises an absent, null or empty locale to null', () => {
    for (const body of [
      { type: 'presence', selection: null },
      { type: 'presence', selection: null, locale: null },
      { type: 'presence', selection: null, locale: '   ' },
    ]) {
      expect((parseClientFrame(send(body)) as { locale: string | null }).locale).toBeNull()
    }
  })

  it('drops unknown extra keys instead of rejecting the frame', () => {
    const frame = parseClientFrame(
      send({
        type: 'presence',
        selection: { uid: 'blk00001', field: null, evil: true },
        actor: 'spoofed',
        evil: true,
      }),
    )
    expect(frame).toEqual({
      type: 'presence',
      selection: { uid: 'blk00001', field: null },
      locale: null,
      v: PROTOCOL_VERSION,
    })
    expect(frame).not.toHaveProperty('evil')
    expect(frame).not.toHaveProperty('actor')
    // Junk inside the selection is dropped too: it would otherwise ride a
    // broadcast to every other editor.
    expect(
      (frame as unknown as { selection: Record<string, unknown> }).selection,
    ).not.toHaveProperty('evil')
  })

  it('rejects a presence frame whose selection is the wrong shape', () => {
    // The pre-v4 bare string is refused rather than upgraded: a v3 client is
    // already refused at the handshake, so this can only be something hand-made.
    expect(parseClientFrame(send({ type: 'presence', selection: 'blk00001' }))).toBeNull()
    expect(parseClientFrame(send({ type: 'presence', selection: 42 }))).toBeNull()
    expect(parseClientFrame(send({ type: 'presence', selection: { field: 'heading' } }))).toBeNull()
    expect(
      parseClientFrame(send({ type: 'presence', selection: { uid: 'blk00001', field: 7 } })),
    ).toBeNull()
    expect(parseClientFrame(send({ type: 'presence', selection: null, locale: 7 }))).toBeNull()
  })
})

describe('parseClientFrame: junk and framing', () => {
  it('rejects non-JSON text', () => {
    expect(parseClientFrame('not json at all {{{')).toBeNull()
  })

  it('rejects a binary frame outright', () => {
    expect(parseClientFrame(new ArrayBuffer(4))).toBeNull()
  })

  it('rejects a JSON value that is not an object', () => {
    expect(parseClientFrame('42')).toBeNull()
    expect(parseClientFrame('null')).toBeNull()
    expect(parseClientFrame('[1,2,3]')).toBeNull()
  })

  it('rejects an unknown message type', () => {
    expect(parseClientFrame(send({ type: 'nonsense' }))).toBeNull()
  })

  it('rejects a v that is present but not a number', () => {
    expect(isClientMsg({ type: 'presence', selection: null, v: 'one' })).toBe(false)
  })
})

/**
 * The admin <-> preview postMessage protocol. `isPreviewMsg` is total over
 * `unknown` the same way `isClientMsg` is: `event.data` on a `message`
 * listener is never something either side threw first, and this guard has to
 * say so without throwing either.
 */
describe('isPreviewMsg', () => {
  const doc = { root: 'root0000', bloks: {} }
  const resolution = { stories: {}, assetBase: '/folio/asset' }

  it('accepts an apply carrying only well-formed mutations', () => {
    expect(isPreviewMsg({ type: 'apply', mutations: [setMutation()], v: PROTOCOL_VERSION })).toBe(
      true,
    )
    expect(isPreviewMsg({ type: 'apply', mutations: [] })).toBe(true)
  })

  it('rejects an apply carrying even one malformed mutation', () => {
    expect(isPreviewMsg({ type: 'apply', mutations: [setMutation(), { t: 'bogus' }] })).toBe(false)
  })

  it('rejects an apply whose mutations is not an array', () => {
    expect(isPreviewMsg({ type: 'apply', mutations: 'nope' })).toBe(false)
  })

  it('accepts a replace carrying any object as the document', () => {
    expect(isPreviewMsg({ type: 'replace', doc })).toBe(true)
  })

  it('rejects a replace whose doc is not an object', () => {
    expect(isPreviewMsg({ type: 'replace', doc: null })).toBe(false)
    expect(isPreviewMsg({ type: 'replace' })).toBe(false)
  })

  it('accepts a resolve carrying any object as the resolution', () => {
    expect(isPreviewMsg({ type: 'resolve', resolution })).toBe(true)
  })

  it('rejects a resolve whose resolution is not an object', () => {
    expect(isPreviewMsg({ type: 'resolve', resolution: 'nope' })).toBe(false)
  })

  it('accepts a select with a uid or with null, either direction', () => {
    expect(isPreviewMsg({ type: 'select', uid: 'blk_1' })).toBe(true)
    expect(isPreviewMsg({ type: 'select', uid: null })).toBe(true)
  })

  it('rejects a select whose uid is missing or the wrong type', () => {
    expect(isPreviewMsg({ type: 'select' })).toBe(false)
    expect(isPreviewMsg({ type: 'select', uid: 42 })).toBe(false)
  })

  it('accepts a bare ready with no other fields', () => {
    expect(isPreviewMsg({ type: 'ready' })).toBe(true)
  })

  it('accepts an add naming both a parent and a slot', () => {
    expect(isPreviewMsg({ type: 'add', parent: 'blk_1', slot: 'body' })).toBe(true)
  })

  it('rejects an add missing either half of the slot reference', () => {
    expect(isPreviewMsg({ type: 'add', parent: 'blk_1' })).toBe(false)
    expect(isPreviewMsg({ type: 'add', slot: 'body' })).toBe(false)
  })

  it('rejects an unknown type', () => {
    expect(isPreviewMsg({ type: 'nonsense' })).toBe(false)
  })

  it('rejects non-record input without throwing', () => {
    expect(isPreviewMsg(null)).toBe(false)
    expect(isPreviewMsg(undefined)).toBe(false)
    expect(isPreviewMsg('ready')).toBe(false)
    expect(isPreviewMsg([1, 2, 3])).toBe(false)
  })

  it('rejects a v that is present but not a number', () => {
    expect(isPreviewMsg({ type: 'ready', v: 'one' })).toBe(false)
  })

  it('accepts a v that is absent or a number', () => {
    expect(isPreviewMsg({ type: 'ready', v: PROTOCOL_VERSION })).toBe(true)
    expect(isPreviewMsg({ type: 'ready' })).toBe(true)
  })
})

describe('size caps', () => {
  it('are the values the rest of the suite assumes', () => {
    expect(MAX_NAME_LEN).toBe(64)
    expect(MAX_ACTOR_LEN).toBe(64)
    expect(MAX_SELECTION_LEN).toBe(64)
    expect(MAX_TX_MUTATIONS).toBe(200)
    expect(MAX_FRAME_BYTES).toBe(256 * 1024)
    expect(MAX_DOC_BLOKS).toBe(20_000)
    expect(MAX_DOC_BYTES).toBe(8 * 1024 * 1024)
  })
})
