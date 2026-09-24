/** External SDK fixture; no desktop observations or input reach the host. */
export const native = {
  creates: 0,
  calls: [] as Array<{ name: string; signal?: AbortSignal }>,
  shutdowns: 0,
  destroys: 0,
  listError: undefined as Error | undefined,
  list: undefined as ((signal?: AbortSignal) => Promise<string>) | undefined,
  call: undefined as ((signal?: AbortSignal) => Promise<void>) | undefined,
}

/** Test-only native SDK entry with the upstream public method names. */
export class CuaDriver {
  static create(): CuaDriver { native.creates += 1; return new CuaDriver() }
  async listToolsJson(options?: { signal: AbortSignal }): Promise<string> {
    if (native.listError !== undefined) throw native.listError
    if (native.list !== undefined) return native.list(options?.signal)
    return JSON.stringify({ tools: [{ name: 'fixture_only_action', description: 'Act on the test fixture.', inputSchema: { type: 'object', properties: {} } }] })
  }
  async callTool(name: string, _args: string, options?: { signal: AbortSignal }): Promise<{ rawJson: string }> {
    native.calls.push({ name, ...options !== undefined ? { signal: options.signal } : {} })
    await native.call?.(options?.signal)
    return { rawJson: JSON.stringify({ content: [{ type: 'text', text: 'Fixture window clicked.' }] }) }
  }
  async shutdown(): Promise<void> { native.shutdowns += 1 }
  uniffiDestroy(): void { native.destroys += 1 }
}
