import { describe, expect, it } from 'vitest'
import { describeAgainstDraft } from '../../../src/admin/ViewingBar'
import { summariseDiff } from '../../../src/core/diff'
import type { Mutation } from '../../../src/core/mutations'

const blok = (uid: string) => ({
  uid,
  type: 'text',
  parent: 'root',
  slot: 'body',
  order: 'a0',
  data: {},
})

describe('describeAgainstDraft', () => {
  it('says nothing has happened when the version matches the draft', () => {
    expect(describeAgainstDraft(summariseDiff([]))).toBe('identical to the current draft')
    expect(describeAgainstDraft(null)).toBe('identical to the current draft')
  })

  /**
   * The wording is inverted on purpose: the summary describes `diff(live,
   * version)`, so a mutation that would *insert* a block into the draft is a
   * block the draft has since deleted.
   */
  it('phrases the diff as what the draft did since', () => {
    const mutations: Mutation[] = [
      { t: 'set', uid: 'a', field: 'title', value: 'x' },
      { t: 'insert', blok: blok('b') },
      { t: 'remove', uid: 'c' },
      { t: 'move', uid: 'd', parent: 'root', slot: 'body', order: 'a1' },
    ]
    expect(describeAgainstDraft(summariseDiff(mutations))).toBe(
      '1 block changed since, 1 block later deleted, 1 block added since, 1 moved',
    )
  })

  it('pluralises each count on its own', () => {
    const mutations: Mutation[] = [
      { t: 'insert', blok: blok('b') },
      { t: 'insert', blok: blok('c') },
    ]
    expect(describeAgainstDraft(summariseDiff(mutations))).toBe('2 blocks later deleted')
  })
})
