import { describe, expect, it } from 'vitest'
import { type KeyedAsset, keyAssets } from '../../../src/admin/AssetInput'
import type { AssetValue } from '../../../src/core/values'

/**
 * `MultiAssetInput` used to key its cards by array index, so moving a card up
 * remounted it and every card below it: focus left whatever input the editor was
 * in, and a half-typed alt string landed on the wrong card.
 *
 * The fix cannot be a stored id. A `multiasset` value is an array of
 * `AssetValue` on the wire and in the mutation log, and that log outlives every
 * deploy — so identity is minted client-side and reconstructed each render by
 * `keyAssets`. These tests pin the reconstruction, which is the only part that
 * can be wrong.
 */

let seq = 0
const mint = () => {
  seq += 1
  return `k${seq}`
}

function asset(over: Partial<AssetValue> & { key: string }): AssetValue {
  return {
    filename: `${over.key}.jpg`,
    contentType: 'image/jpeg',
    size: 100,
    alt: '',
    ...over,
  }
}

/** What the component does on the render after `previous`. */
function next(previous: KeyedAsset[], assets: AssetValue[]): KeyedAsset[] {
  return keyAssets(previous, assets, mint)
}

const ids = (keyed: readonly KeyedAsset[]) => keyed.map((k) => k.id)

describe('keyAssets', () => {
  it('mints one id per asset on the first render', () => {
    const keyed = next([], [asset({ key: 'a' }), asset({ key: 'b' })])
    expect(new Set(ids(keyed)).size).toBe(2)
    expect(keyed.map((k) => k.asset.key)).toEqual(['a', 'b'])
  })

  it('hands the same ids back when nothing changed', () => {
    const assets = [asset({ key: 'a' }), asset({ key: 'b' })]
    const first = next([], assets)
    // `asAssets` rebuilds every object each render, so the second pass gets
    // equal-but-not-identical values. Matching on identity would mint here.
    const second = next(first, [asset({ key: 'a' }), asset({ key: 'b' })])
    expect(ids(second)).toEqual(ids(first))
  })

  it('moves ids with the cards on a reorder rather than reassigning them', () => {
    const first = next([], [asset({ key: 'a' }), asset({ key: 'b' }), asset({ key: 'c' })])
    const [a, b, c] = ids(first)

    // Swap the first two, exactly as the Up button does.
    const second = next(first, [asset({ key: 'b' }), asset({ key: 'a' }), asset({ key: 'c' })])

    expect(ids(second)).toEqual([b, a, c])
  })

  it('keeps a card its id while its alt text is being typed', () => {
    const first = next([], [asset({ key: 'a' }), asset({ key: 'b' })])
    const second = next(first, [asset({ key: 'a' }), asset({ key: 'b', alt: 'A c' })])
    // Remounting per keystroke would lose the caret after one character.
    expect(ids(second)).toEqual(ids(first))
  })

  it('keeps a card its id when its focal point moves', () => {
    const first = next([], [asset({ key: 'a' })])
    const second = next(first, [asset({ key: 'a', focal: { x: 0.25, y: 0.5 } })])
    expect(ids(second)).toEqual(ids(first))
    expect(second[0]!.asset.focal).toEqual({ x: 0.25, y: 0.5 })
  })

  it('gives two copies of one file two ids, and keeps them apart', () => {
    const first = next([], [asset({ key: 'a' }), asset({ key: 'a' })])
    const [one, two] = ids(first)
    expect(one).not.toBe(two)

    // Editing the second copy must not make it look like the first.
    const second = next(first, [asset({ key: 'a' }), asset({ key: 'a', alt: 'second' })])
    expect(ids(second)).toEqual([one, two])
  })

  it('keeps the untouched cards stable when one is removed', () => {
    const first = next([], [asset({ key: 'a' }), asset({ key: 'b' }), asset({ key: 'c' })])
    const [a, , c] = ids(first)
    const second = next(first, [asset({ key: 'a' }), asset({ key: 'c' })])
    expect(ids(second)).toEqual([a, c])
  })

  it('mints only for the newcomer when assets are appended', () => {
    const first = next([], [asset({ key: 'a' })])
    const second = next(first, [asset({ key: 'a' }), asset({ key: 'b' })])
    expect(second[0]!.id).toBe(first[0]!.id)
    expect(second[1]!.id).not.toBe(first[0]!.id)
  })

  it('distinguishes an external asset by its url, since it has no key', () => {
    const external: AssetValue = {
      url: 'https://cdn.example.com/x.png',
      filename: 'x.png',
      contentType: 'image/png',
      size: 0,
      alt: '',
    }
    const first = next([], [external, asset({ key: 'a' })])
    const second = next(first, [asset({ key: 'a' }), { ...external }])
    expect(ids(second)).toEqual([first[1]!.id, first[0]!.id])
  })

  it('is idempotent, so a StrictMode double render produces the same ids', () => {
    const assets = [asset({ key: 'a' }), asset({ key: 'a' }), asset({ key: 'b' })]
    const first = next([], assets)
    expect(ids(next(first, assets))).toEqual(ids(first))
  })
})
