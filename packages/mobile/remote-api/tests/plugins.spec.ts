import { expect, it } from 'vitest'
import { pluginsListRequestSchema, pluginsListValueSchema, pluginsSetEnabledRequestSchema, pluginsSetEnabledValueSchema } from '../src/api/plugins.schema.ts'

it('accepts a bounded plugin catalog and an exact toggle request', () => {
  const row = { id: 'computer-use', name: 'Computer use', source: 'bundled', enabled: true, required: false }
  expect(pluginsListRequestSchema.parse({})).toEqual({})
  expect(pluginsListValueSchema.parse({ plugins: [row] })).toEqual({ plugins: [row] })
  expect(pluginsSetEnabledRequestSchema.parse({ id: 'computer-use', enabled: false })).toEqual({ id: 'computer-use', enabled: false })
  expect(pluginsSetEnabledValueSchema.parse({ plugin: { ...row, enabled: false } })).toEqual({ plugin: { ...row, enabled: false } })
  expect(() => pluginsSetEnabledRequestSchema.parse({ id: '', enabled: false })).toThrow()
  expect(() => pluginsSetEnabledRequestSchema.parse({ id: 'computer-use', enabled: 'false' })).toThrow()
  expect(() => pluginsListValueSchema.parse({ plugins: [{ ...row, required: 'yes' }] })).toThrow()
})
