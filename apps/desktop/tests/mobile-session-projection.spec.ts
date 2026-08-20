import { describe, expect, it } from 'vitest'
import { MobileSessionProjection } from '../src/mobile-session-projection.ts'

function byteSource(): (size: number) => Uint8Array {
  let value = 1
  return size => Uint8Array.from({ length: size }, () => value++)
}

function sessionHandleByteSource(): (size: number) => Uint8Array {
  let value = 1
  return (size) => {
    const bytes = Uint8Array.from({ length: size }, () => value)
    value += 1
    return bytes
  }
}

function history(...events: unknown[]): readonly unknown[] {
  return events
}

function user(text: string): unknown {
  return {
    type: 'user/message',
    data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'not-for-mobile' } },
    metadata: { cwd: '/private/desktop/path' },
  }
}

function assistant(text: string): unknown {
  return {
    type: 'assistant/message',
    data: {
      message: {
        id: 'real-dsh-message-id',
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'private-provider' },
      },
    },
  }
}

describe('MobileSessionProjection', () => {
  it('exposes only bounded user and assistant text behind stable opaque local handles', () => {
    const projection = new MobileSessionProjection({ randomBytes: byteSource() })
    const source = [{
      sessionKey: 'real-dsh-session-id',
      history: history(
        user('Hello from the desktop'),
        { type: 'tool/call', data: { name: 'read', arguments: '/private/file.txt' } },
        {
          type: 'assistant/message',
          data: {
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Safe answer' },
                { type: 'image', url: 'file:///private/image.png' },
                { type: 'tool-call', name: 'shell', arguments: 'rm -rf /' },
              ],
              reasoning: 'not for mobile',
            },
          },
        },
        assistant('Follow-up'),
      ),
    }]

    const first = projection.project(source)
    const second = projection.project(source)

    expect(first).toEqual([{
      handle: expect.stringMatching(/^dshm_[A-Za-z0-9_-]{43}$/u),
      messages: [
        { role: 'user', text: 'Hello from the desktop' },
        { role: 'assistant', text: 'Safe answer' },
        { role: 'assistant', text: 'Follow-up' },
      ],
    }])
    expect(second[0]?.handle).toBe(first[0]?.handle)
    expect(JSON.stringify(first)).not.toContain('real-dsh-session-id')
    expect(JSON.stringify(first)).not.toContain('/private')
    expect(JSON.stringify(first)).not.toContain('not for mobile')
    expect(JSON.stringify(first)).not.toContain('rm -rf')
  })

  it('drops hostile, unknown, and non-human event data rather than forwarding it', () => {
    const projection = new MobileSessionProjection({ randomBytes: byteSource() })
    const view = projection.project([{
      sessionKey: 'session-a',
      history: history(
        user('safe'),
        user('bad\u0000text'),
        { type: 'user/message', data: { content: [{ type: 'text', text: 'system' }], source: { kind: 'system' } } },
        { type: 'assistant/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'spoofed' }] } } },
        { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'image', url: 'secret' }] } } },
        { type: 'tool/result', data: { content: [{ type: 'text', text: 'tool output' }] } },
        { type: 'unknown', data: { text: 'unknown payload' } },
        null,
      ),
    }])

    expect(view).toEqual([{
      handle: expect.any(String),
      messages: [{ role: 'user', text: 'safe' }],
    }])
  })

  it('requires an explicitly selected live handle for prompts and error replies', () => {
    const projection = new MobileSessionProjection({ randomBytes: byteSource() })
    const [first, second] = projection.project([
      { sessionKey: 'session-one', history: history(user('one')) },
      { sessionKey: 'session-two', history: history(user('two')) },
    ])
    const firstHandle = first?.handle as string
    const secondHandle = second?.handle as string

    expect(() => projection.validatePrompt(firstHandle, 'hello')).toThrow('unselected mobile session handle')
    expect(projection.select(firstHandle)).toEqual({ handle: firstHandle })
    expect(projection.validatePrompt(firstHandle, 'hello from mobile')).toEqual({
      handle: firstHandle,
      text: 'hello from mobile',
    })
    expect(projection.validateSelectedHandle(firstHandle)).toEqual({ handle: firstHandle })
    expect(() => projection.validatePrompt(secondHandle, 'wrong selected session')).toThrow('unselected mobile session handle')
    expect(() => projection.validateSelectedHandle(secondHandle)).toThrow('unselected mobile session handle')
  })

  it.each([
    '/command',
    '  /command',
    'bad\u0000text',
    'bad\u001Ftext',
    '',
    '   ',
    'x'.repeat(4_097),
  ])('rejects a hostile or unsupported mobile prompt', (prompt) => {
    const projection = new MobileSessionProjection({ randomBytes: byteSource() })
    const [view] = projection.project([{ sessionKey: 'session-a', history: [] }])
    const handle = view?.handle as string
    projection.select(handle)

    expect(() => projection.validatePrompt(handle, prompt)).toThrow('rejected the mobile prompt')
  })

  it('revokes missing handles and clears the selected session on the next projection', () => {
    const projection = new MobileSessionProjection({ randomBytes: byteSource() })
    const [view] = projection.project([{ sessionKey: 'session-a', history: [] }])
    const handle = view?.handle as string
    projection.select(handle)
    projection.project([])

    expect(() => projection.validatePrompt(handle, 'still here?')).toThrow('rejected the mobile session handle')
    expect(() => projection.validateSelectedHandle(handle)).toThrow('rejected the mobile session handle')
  })

  it('never creates a visible handle for malformed or duplicate desktop session keys', () => {
    const projection = new MobileSessionProjection({ randomBytes: byteSource() })

    expect(projection.project([
      { sessionKey: '', history: [] },
      { sessionKey: 'valid', history: [] },
      { sessionKey: 'valid', history: [user('duplicate')] },
      { sessionKey: 'bad\u0000key', history: [] },
    ])).toEqual([{ handle: expect.any(String), messages: [] }])
  })

  it('bounds the mobile session list and revokes handles outside the current window', () => {
    const projection = new MobileSessionProjection({ randomBytes: sessionHandleByteSource() })
    const sources = Array.from({ length: 25 }, (_, index) => ({
      sessionKey: `session-${index}`,
      history: [],
    }))
    const first = projection.project(sources)
    const firstHandle = first[0]?.handle as string

    expect(first).toHaveLength(24)
    projection.select(firstHandle)
    const shifted = projection.project(sources.slice(1))

    expect(shifted).toHaveLength(24)
    expect(() => projection.validateSelectedHandle(firstHandle)).toThrow('rejected the mobile session handle')
  })

  it('fits every projected history into the encrypted snapshot message limits', () => {
    const projection = new MobileSessionProjection({ randomBytes: byteSource() })
    const view = projection.project([{
      sessionKey: 'session-a',
      history: history(...Array.from({ length: 25 }, () => assistant('😀'.repeat(1_500)))),
    }])[0]

    expect(view?.messages).toHaveLength(24)
    expect(view?.messages.every(message => Buffer.byteLength(message.text, 'utf8') <= 2 * 1_024)).toBe(true)
  })

  it('keeps the newest safe message tail when a local session exceeds the mobile cap', () => {
    const projection = new MobileSessionProjection({ randomBytes: byteSource() })
    const events = Array.from({ length: 30 }, (_, index) => assistant(`message-${index + 1}`))
    const initial = projection.project([{ sessionKey: 'session-a', history: history(...events) }])[0]

    expect(initial?.messages).toHaveLength(24)
    expect(initial?.messages[0]).toEqual({ role: 'assistant', text: 'message-7' })
    expect(initial?.messages.at(-1)).toEqual({ role: 'assistant', text: 'message-30' })

    const appended = projection.project([{
      sessionKey: 'session-a',
      history: history(...events, assistant('just-appended')),
    }])[0]
    expect(appended?.messages).toHaveLength(24)
    expect(appended?.messages[0]).toEqual({ role: 'assistant', text: 'message-8' })
    expect(appended?.messages.at(-1)).toEqual({ role: 'assistant', text: 'just-appended' })
  })
})
