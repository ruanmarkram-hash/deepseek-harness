import { describe, expect, it } from 'vitest'
import { rpcMessageSchema, rpcIdSchema } from '../src/api/rpc.schema.ts'
import { sessionEventSchema, contentBlockSchema, sessionPromptRequestSchema } from '../src/api/sessions.schema.ts'
import { goalCreateRequestSchema } from '../src/api/goals.schema.ts'

describe('released mobile validation boundaries', () => {
  it('keeps extensible event data opaque while rejecting malformed envelopes', () => {
    const event = { type: 'future/event', seq: 2, time: 123, data: { future: true }, surfaceOp: { future: true } }
    expect(sessionEventSchema.parse(event)).toEqual(event)
    for (const patch of [{ type: 1 }, { seq: -1 }, { seq: 0.5 }, { time: 'now' }, { ignorable: false }]) {
      expect(sessionEventSchema.safeParse({ ...event, ...patch }).success).toBe(false)
    }
  })

  it('retains extensible content fields but requires a type envelope', () => {
    const block = { type: 'future/block', nested: { content: [1, 2, 3] } }
    expect(contentBlockSchema.parse(block)).toEqual(block)
    expect(contentBlockSchema.safeParse({ type: 1 }).success).toBe(false)
    expect(contentBlockSchema.safeParse({ text: 'missing type' }).success).toBe(false)
  })

  it('brands without changing released opaque string values or request acceptance', () => {
    expect(rpcIdSchema.parse('')).toBe('')
    expect(goalCreateRequestSchema.parse({ sessionId: '', objective: 'goal' })).toEqual({ sessionId: '', objective: 'goal' })
    expect(sessionPromptRequestSchema.safeParse({ sessionId: '', mode: 'queue', content: [] }).success).toBe(false)
    expect(sessionPromptRequestSchema.safeParse({ sessionId: 'session', mode: 'invalid', content: [] }).success).toBe(false)
  })

  it('preserves all four RPC discriminants and rejects malformed correlated frames', () => {
    for (const type of ['client-request', 'server-request']) {
      const frame = { type, rpcId: 'rpc', method: 'future.method', payload: { opaque: true } }
      expect(rpcMessageSchema.parse(frame)).toEqual(frame)
    }
    for (const type of ['client-response', 'server-response']) {
      const frame = { type, rpcId: 'rpc', result: { ok: true } }
      expect(rpcMessageSchema.parse(frame)).toEqual(frame)
    }
    expect(rpcMessageSchema.safeParse({ type: 'unknown', rpcId: 'rpc' }).success).toBe(false)
    expect(rpcMessageSchema.safeParse({ type: 'client-request', rpcId: 7, method: 'session.list', payload: {} }).success).toBe(false)
  })
})
