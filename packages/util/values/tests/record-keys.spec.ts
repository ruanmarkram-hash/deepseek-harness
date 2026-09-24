import { describe, expect, it } from 'vitest'
import { hasExactKeys, isRecord } from '../src/index.ts'

describe('isRecord', () => {
  it('accepts non-array objects without requiring a plain prototype', () => {
    class Instance { value = 1 }
    for (const value of [{}, Object.create(null), new Instance(), new Date(0), new Map()]) {
      expect(isRecord(value)).toBe(true)
    }
  })

  it('rejects null, arrays, functions, and primitives', () => {
    for (const value of [null, undefined, [], [1], () => 1, true, 0, 'text', 1n, Symbol('key')]) {
      expect(isRecord(value)).toBe(false)
    }
  })
})

describe('hasExactKeys', () => {
  it('matches keys regardless of order without mutating the record or expected list', () => {
    const value = Object.freeze({ z: 1, a: 2 })
    const keys = Object.freeze(['z', 'a'])
    expect(hasExactKeys(value, keys)).toBe(true)
    expect(Object.keys(value)).toEqual(['z', 'a'])
    expect(keys).toEqual(['z', 'a'])
    expect(hasExactKeys({}, [])).toBe(true)
  })

  it('rejects missing, extra, mismatched, and duplicate expected keys', () => {
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false)
    expect(hasExactKeys({ a: 1, b: 2 }, ['a'])).toBe(false)
    expect(hasExactKeys({ a: 1 }, ['b'])).toBe(false)
    expect(hasExactKeys({ a: 1, b: 2 }, ['a', 'a'])).toBe(false)
  })

  it('ignores inherited, symbol, and non-enumerable keys without reading values', () => {
    const value = { visible: 0 }
    Object.setPrototypeOf(value, { inherited: 1 })
    Object.defineProperties(value, {
      visible: { enumerable: true, get() { throw new Error('property value was read') } },
      hidden: { enumerable: false, value: 2 },
      [Symbol('symbol')]: { enumerable: true, value: 3 },
    })
    expect(hasExactKeys(value, ['visible'])).toBe(true)
    expect(hasExactKeys(value, ['visible', 'hidden'])).toBe(false)
    expect(hasExactKeys(value, ['visible', 'inherited'])).toBe(false)
  })
})
