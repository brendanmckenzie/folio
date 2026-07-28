import { describe, expect, it } from 'vitest'
import {
  docCapError,
  fallbackColour,
  isClientMsg,
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

describe('parseClientFrame: hello', () => {
  it('parses a well-formed hello unchanged', () => {
    const frame = parseClientFrame(
      send({ type: 'hello', actor: 'usr_ada', name: 'Ada', colour: '#ff00ff', lastSyncId: 3 }),
    )
    expect(frame).toEqual({
      type: 'hello',
      actor: 'usr_ada',
      name: 'Ada',
      colour: '#ff00ff',
      lastSyncId: 3,
      v: PROTOCOL_VERSION,
    })
  })

  it('trims and caps a name at MAX_NAME_LEN', () => {
    const longName = `  ${'a'.repeat(MAX_NAME_LEN + 20)}  `
    const frame = parseClientFrame(
      send({ type: 'hello', actor: 'usr_ada', name: longName, colour: '#ff00ff', lastSyncId: 0 }),
    )
    expect(frame?.type).toBe('hello')
    expect((frame as { name: string }).name).toBe('a'.repeat(MAX_NAME_LEN))
  })

  it('defaults an empty or whitespace-only name to Anonymous', () => {
    for (const name of ['', '   ', '\t\n']) {
      const frame = parseClientFrame(
        send({ type: 'hello', actor: 'usr_ada', name, colour: '#ff00ff', lastSyncId: 0 }),
      )
      expect((frame as { name: string }).name).toBe('Anonymous')
    }
  })

  it('strips control characters from actor and caps it at MAX_ACTOR_LEN', () => {
    const actor = `usr\x00_${'b'.repeat(MAX_ACTOR_LEN + 10)}`
    const frame = parseClientFrame(
      send({ type: 'hello', actor, name: 'Ada', colour: '#ff00ff', lastSyncId: 0 }),
    )
    const cleaned = (frame as { actor: string }).actor
    expect(cleaned).not.toContain('\x00')
    expect(cleaned.length).toBe(MAX_ACTOR_LEN)
  })

  // The field the comment above stripControlChars is actually about: a display
  // name rides on every presence broadcast and the log's activity trail for the
  // life of the socket, same as `actor` - it must not carry controls either.
  it('strips control characters from name', () => {
    const frame = parseClientFrame(
      send({
        type: 'hello',
        actor: 'usr_ada',
        name: 'Ada\x00\x7f Lovelace',
        colour: '#ff00ff',
        lastSyncId: 0,
      }),
    )
    const name = (frame as { name: string }).name
    expect(name).not.toContain('\x00')
    expect(name).not.toContain('\x7f')
    expect(name).toBe('Ada Lovelace')
  })

  // Bidi overrides/isolates can reorder a rendered name away from what was
  // stored, exactly the ranges validate.ts's PRINTABLE refuses on the HTTP side.
  it('strips bidi override and isolate characters from name and actor', () => {
    const evil = 'Ada‮evil‬'
    const frame = parseClientFrame(
      send({ type: 'hello', actor: evil, name: evil, colour: '#ff00ff', lastSyncId: 0 }),
    )
    const { name, actor } = frame as { name: string; actor: string }
    expect(name).toBe('Adaevil')
    expect(actor).toBe('Adaevil')
  })

  it('keeps a colour that matches the 6-digit hex form', () => {
    const frame = parseClientFrame(
      send({ type: 'hello', actor: 'usr_ada', name: 'Ada', colour: '#A1B2C3', lastSyncId: 0 }),
    )
    expect((frame as { colour: string }).colour).toBe('#A1B2C3')
  })

  // A client cannot choose its way past the guard: shorthand hex, a bare word, and
  // a missing '#' are all colours the client asserted that this door does not trust.
  it.each(['#fff', 'red', 'ff00ff', '#gggggg', '#ff00ff0'])(
    'falls back to a colour derived from actor when colour is %s',
    (colour) => {
      const frame = parseClientFrame(
        send({ type: 'hello', actor: 'usr_ada', name: 'Ada', colour, lastSyncId: 0 }),
      )
      expect((frame as { colour: string }).colour).toBe(fallbackColour('usr_ada'))
    },
  )

  it('rejects a hello missing a required field', () => {
    expect(
      parseClientFrame(send({ type: 'hello', actor: 'usr_ada', colour: '#ff00ff', lastSyncId: 0 })),
    ).toBeNull()
  })

  it('rejects a hello whose fields are the wrong type', () => {
    expect(
      parseClientFrame(
        send({ type: 'hello', actor: 'usr_ada', name: 'Ada', colour: '#ff00ff', lastSyncId: '3' }),
      ),
    ).toBeNull()
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
    const frame = parseClientFrame(send({ type: 'presence', selection: 'blk00001' }))
    expect(frame).toEqual({ type: 'presence', selection: 'blk00001', v: PROTOCOL_VERSION })
  })

  it('passes null through unchanged', () => {
    const frame = parseClientFrame(send({ type: 'presence', selection: null }))
    expect(frame).toEqual({ type: 'presence', selection: null, v: PROTOCOL_VERSION })
  })

  it('caps an oversized selection at MAX_SELECTION_LEN', () => {
    const selection = 'x'.repeat(MAX_SELECTION_LEN + 40)
    const frame = parseClientFrame(send({ type: 'presence', selection }))
    expect((frame as { selection: string }).selection).toBe('x'.repeat(MAX_SELECTION_LEN))
  })

  it('drops unknown extra keys instead of rejecting the frame', () => {
    const frame = parseClientFrame(
      send({ type: 'presence', selection: 'blk00001', actor: 'spoofed', evil: true }),
    )
    expect(frame).toEqual({ type: 'presence', selection: 'blk00001', v: PROTOCOL_VERSION })
    expect(frame).not.toHaveProperty('evil')
    expect(frame).not.toHaveProperty('actor')
  })

  it('rejects a presence frame whose selection is the wrong type', () => {
    expect(parseClientFrame(send({ type: 'presence', selection: 42 }))).toBeNull()
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
