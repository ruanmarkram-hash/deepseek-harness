/** EAS starts without workspace runtime bundles; TypeScript output alone is not a package entry. */
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import mobile from '../package.json'

const root = resolve(import.meta.dirname, '../../..')

describe('mobile bundle preparation', () => {
  it('materializes the shared value dependency at its declared runtime entry from clean compiler output', async () => {
    const scripts: Record<string, string> = mobile.scripts
    const command = scripts['bundle:values']
    expect(command, 'EAS must bundle the transitive value dependency').toBeDefined()
    if (!command) throw new Error('missing value bundle command')
    expect(scripts['eas-build-post-install']).toContain('pnpm run bundle:values')
    expect(scripts.preexport).toBe('pnpm run eas-build-post-install')
    const args = command.split(' ')
    expect(args.slice(0, 5)).toEqual(['pnpm', '--filter', '@deepseek-ai/dsh-util-values', 'exec', 'tsdown'])
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-values-'))
    try {
      await mkdir(join(directory, 'lib/types'), { recursive: true })
      await writeFile(join(directory, 'package.json'), await readFile(join(root, 'packages/util/values/package.json')))
      const source = await readFile(join(root, 'packages/util/values/src/index.ts'), 'utf8')
      const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
      await writeFile(join(directory, 'lib/types/index.js'), emitted.outputText)
      await expect(access(join(directory, 'lib/index.js'))).rejects.toThrow()
      execFileSync(process.execPath, [join(root, 'node_modules/tsdown/dist/run.mjs'), ...args.slice(5)], { cwd: directory, stdio: 'pipe' })
      await access(join(directory, 'lib/index.js'))
      await access(join(directory, 'lib/types/index.js'))
      const entry = JSON.stringify(pathToFileURL(join(directory, 'lib/index.js')).href)
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { hasExactKeys, isRecord } from ${entry};
        assert.equal(isRecord({ value: 1 }), true);
        assert.equal(isRecord(null), false);
        assert.equal(hasExactKeys({ value: 1 }, ['value']), true);
        assert.equal(hasExactKeys({ value: 1, extra: 2 }, ['value']), false);
      `], { cwd: directory, stdio: 'pipe' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
