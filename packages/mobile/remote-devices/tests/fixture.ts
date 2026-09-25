import { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteDeviceDirectory } from '../src/index.ts'

/** A complete in-memory table for directory and route fixtures. */
export function memoryTable<K extends string, V>(): KvTable<K, V> {
  const rows = new Map<K, V>()
  return {
    get: key => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    get size() { return rows.size },
    put: async (key, value) => { rows.set(key, value) },
    delete: async key => rows.delete(key),
    update: async (key, transform) => {
      const current = rows.get(key)
      if (current === undefined) throw new Error('missing fixture row')
      const next = transform(current)
      rows.set(key, next)
      return next
    },
  }
}

/** Construct the real directory, preserving the concrete types of test overrides. */
export function directoryFixture<T extends Partial<Pick<RemoteDeviceDirectory, keyof RemoteDeviceDirectory>>>(overrides: T) {
  return Object.assign(new RemoteDeviceDirectory(new Context(), memoryTable()), overrides)
}
