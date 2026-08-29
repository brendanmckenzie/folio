import { describe, expect, it } from 'vitest'
import type { Mutation } from '../../../src/core/mutations'
import { MAX_TX_MUTATIONS } from '../../../src/core/protocol'
import { FolioError } from '../../../src/server/errors'
import type { StoryStub } from '../../../src/server/types'
import { commitAll, txIdFromKey } from '../../../src/server/write'

/**
 * The write path's arithmetic and its refusal mapping, against a fake stub.
 *
 * The workers suite drives the real Durable Object and is where "a delta reaches
 * an open editor" is proved. What is easier to prove here is the shape of the
 * chunking (a 450-mutation write is three transactions, and each carries its own
 * derived txId) and the mapping from `commit`'s refusal *strings* to status codes
 * — including the document-cap refusal, which over a real object would mean
 * building a 20,000-blok payload to observe one branch of a three-line function.
 */

const actor = { id: 'token:importer', name: 'importer' }

const set = (i: number): Mutation => ({ t: 'set', uid: 'r0', field: `f${i}`, value: i })

interface Call {
  mutations: Mutation[]
  txId: string | undefined
}

/** A stub that accepts everything and records what it was asked to commit. */
function accepting(opts: { logged?: Set<string> } = {}) {
  const calls: Call[] = []
  let syncId = 0
  const stub = {
    head: async () => ({ syncId }),
    hasTx: async (txId: string) => (opts.logged?.has(txId) ? { syncId: 41, mutations: 7 } : null),
    commit: async (mutations: Mutation[], _a: unknown, txId?: string) => {
      calls.push({ mutations, txId })
      if (txId !== undefined && opts.logged?.has(txId)) return { syncId: 41, txId, replay: true }
      syncId++
      return { syncId, txId: txId ?? 'tx_generated' }
    },
  } as unknown as StoryStub
  return { stub, calls }
}

/** A stub that refuses with a fixed reason, to exercise the mapping. */
function refusing(reason: string) {
  return {
    head: async () => ({ syncId: 0 }),
    hasTx: async () => null,
    commit: async () => ({ rejected: reason }),
  } as unknown as StoryStub
}

const codeOf = async (reason: string) => {
  try {
    await commitAll(refusing(reason), [set(0)], actor)
  } catch (e) {
    if (e instanceof FolioError) return e
    throw e
  }
  throw new Error('expected a FolioError')
}

describe('txIdFromKey', () => {
  it('is a valid txId shape, indistinguishable from a minted one', async () => {
    expect(await txIdFromKey('import-42', 0)).toMatch(/^tx_[0-9a-f]{20}$/)
  })

  it('is deterministic, so a retry derives the same id', async () => {
    expect(await txIdFromKey('import-42', 0)).toBe(await txIdFromKey('import-42', 0))
  })

  it('differs per chunk, so chunk 2 is not answered with chunk 1 delta', async () => {
    expect(await txIdFromKey('import-42', 0)).not.toBe(await txIdFromKey('import-42', 1))
  })

  it('differs per key', async () => {
    expect(await txIdFromKey('a', 0)).not.toBe(await txIdFromKey('b', 0))
  })
})

describe('commitAll chunking', () => {
  it('sends one transaction under the cap', async () => {
    const { stub, calls } = accepting()
    const result = await commitAll(stub, [set(0), set(1)], actor)
    expect(result).toEqual({ changed: 2, transactions: 1, syncId: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.txId).toBeUndefined()
  })

  it('splits 450 mutations into three, each within the cap', async () => {
    const { stub, calls } = accepting()
    const mutations = Array.from({ length: 450 }, (_, i) => set(i))
    const result = await commitAll(stub, mutations, actor)

    expect(result).toMatchObject({ changed: 450, transactions: 3 })
    expect(calls.map((c) => c.mutations.length)).toEqual([MAX_TX_MUTATIONS, MAX_TX_MUTATIONS, 50])
    // Nothing lost and nothing duplicated across the split.
    expect(calls.flatMap((c) => c.mutations)).toEqual(mutations)
  })

  it('derives a distinct txId per chunk when a key was given', async () => {
    const { stub, calls } = accepting()
    await commitAll(
      stub,
      Array.from({ length: 250 }, (_, i) => set(i)),
      actor,
      'import-42',
    )
    expect(calls.map((c) => c.txId)).toEqual([
      await txIdFromKey('import-42', 0),
      await txIdFromKey('import-42', 1),
    ])
  })

  it('writes nothing for an empty mutation list, and reports the current position', async () => {
    const { stub, calls } = accepting()
    expect(await commitAll(stub, [], actor)).toEqual({ changed: 0, transactions: 0, syncId: 0 })
    expect(calls).toEqual([])
  })

  it('asks the log rather than probing it when an empty write carries a key', async () => {
    const key = 'import-42'
    const logged = new Set([await txIdFromKey(key, 0)])
    const { stub, calls } = accepting({ logged })
    expect(await commitAll(stub, [], actor, key)).toEqual({
      changed: 7,
      transactions: 1,
      syncId: 41,
      replayed: true,
    })
    // The load-bearing part: no transaction was logged to find that out, so an
    // unchanged story does not start reporting unpublished changes.
    expect(calls).toEqual([])
  })

  it('reports an unused key as an ordinary no-op', async () => {
    const { stub } = accepting()
    expect(await commitAll(stub, [], actor, 'never-used')).toEqual({
      changed: 0,
      transactions: 0,
      syncId: 0,
    })
  })

  it('marks a replayed chunk without inventing a fresh syncId', async () => {
    const key = 'import-42'
    const logged = new Set([await txIdFromKey(key, 0)])
    const { stub } = accepting({ logged })
    const result = await commitAll(stub, [set(0)], actor, key)
    expect(result).toEqual({ changed: 1, transactions: 1, syncId: 41, replayed: true })
  })
})

describe('commitAll refusals', () => {
  it('maps a purged object to 404 rather than resurrecting it', async () => {
    const e = await codeOf('no document: this story has never been opened')
    expect(e.code).toBe('not_found')
    expect(e.status).toBe(404)
  })

  it('maps both document caps to 413, keeping their own numbers', async () => {
    const bloks = await codeOf('document too large: 20001 bloks exceeds the 20000 cap')
    expect(bloks.code).toBe('too_large')
    expect(bloks.message).toMatch(/20001 bloks/)

    const bytes = await codeOf('document too large: 9000000 bytes exceeds the 8388608 byte cap')
    expect(bytes.code).toBe('too_large')
  })

  it('maps the per-transaction cap to 413', async () => {
    expect((await codeOf('too many mutations: 500 exceeds the 200 cap')).code).toBe('too_large')
  })

  it('maps a structural violation to 409', async () => {
    const e = await codeOf('cycle: x is a descendant of y')
    expect(e.code).toBe('conflict')
    expect(e.status).toBe(409)
  })

  it('says which transaction of how many refused, when there was more than one', async () => {
    await expect(
      commitAll(
        refusing('cycle: x is a descendant of y'),
        Array.from({ length: 250 }, (_, i) => set(i)),
        actor,
      ),
    ).rejects.toThrow(/transaction 1 of 2/)
  })
})
