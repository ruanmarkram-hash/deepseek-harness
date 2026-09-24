import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { collectHostedGraph, copyHostedPackages, planHostedLayout } from './hosted-module-closure.mjs'

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'hosted-module-closure-'))
  try { return await run(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

function pkg(path, name, version, manifest = {}, source = 'module.exports = {}') {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: /^\d+$/.test(version) ? `${version}.0.0` : version, main: 'index.cjs', ...manifest }))
  writeFileSync(join(path, 'index.cjs'), source)
  return path
}

async function materialize(graph, out) {
  const placements = planHostedLayout(graph, out)
  await copyHostedPackages(graph, placements)
  function assertFiles(path) {
    for (const name of readdirSync(path)) {
      const full = join(path, name), stat = lstatSync(full)
      assert.equal(stat.isSymbolicLink(), false)
      if (stat.isDirectory()) assertFiles(full)
      else assert.ok(stat.isFile())
    }
  }
  assertFiles(out)
  return placements
}

test('preserves competing dependency versions for CommonJS and ESM with one shared singleton', () => fixture(async root => {
  const modules = join(root, 'source/node_modules')
  const first = pkg(join(modules, 'first'), 'first', '1', { dependencies: { versioned: '1', '@deepseek-ai/shared': '*' } }, "module.exports={version:require('versioned'),shared:require('@deepseek-ai/shared')}")
  const second = pkg(join(modules, 'second'), 'second', '1', { dependencies: { versioned: '2', '@deepseek-ai/shared': '*' } }, "module.exports={version:require('versioned'),shared:require('@deepseek-ai/shared')}")
  pkg(join(modules, 'versioned'), 'versioned', '1', {}, 'module.exports=1')
  pkg(join(second, 'node_modules/versioned'), 'versioned', '2', {}, 'module.exports=2')
  pkg(join(modules, '@deepseek-ai/shared'), '@deepseek-ai/shared', '1')
  const graph = collectHostedGraph([{ name: 'first', target: first }, { name: 'second', target: second }])
  const out = join(root, 'sealed/node_modules')
  const placements = await materialize(graph, out)
  assert.equal([...placements.keys()].filter(path => path.endsWith('/@deepseek-ai/shared')).length, 1)
  const script = join(dirname(out), 'probe.mjs')
  writeFileSync(script, "import first from 'first'; import second from 'second'; import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); if(first.version!==1||second.version!==2||first.shared!==second.shared||require('first')!==first)throw Error('wrong graph');")
  execFileSync(process.execPath, [script])
}))

test('reuses ancestor packages for cyclic dependencies', () => fixture(async root => {
  const modules = join(root, 'source/node_modules')
  const a = pkg(join(modules, 'a'), 'a', '1', { dependencies: { b: '*' } })
  pkg(join(modules, 'b'), 'b', '1', { dependencies: { a: '*' } })
  const graph = collectHostedGraph([{ name: 'a', target: a }])
  assert.equal((await materialize(graph, join(root, 'sealed/node_modules'))).size, 2)
}))

test('copies dot-relative published directories and preserves native conditional exports', () => fixture(async root => {
  const target = pkg(join(root, 'package'), 'conditional', '1', {
    type: 'module', files: ['./dist'], exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' }, './subpath': './dist/subpath.js' },
  })
  mkdirSync(join(target, 'dist'))
  writeFileSync(join(target, 'dist/index.js'), 'export const value = "esm"')
  writeFileSync(join(target, 'dist/index.cjs'), 'module.exports = "cjs"')
  writeFileSync(join(target, 'dist/subpath.js'), 'export const sub = true')
  const out = join(root, 'sealed/node_modules')
  await materialize(collectHostedGraph([{ name: 'conditional', target }]), out)
  const script = join(dirname(out), 'probe.mjs')
  writeFileSync(script, "import {value} from 'conditional'; import {sub} from 'conditional/subpath'; import {createRequire} from 'node:module'; if(value!=='esm'||!sub||createRequire(import.meta.url)('conditional')!=='cjs')throw Error('wrong exports');")
  execFileSync(process.execPath, [script])
}))

test('required and nonoptional peer dependencies fail closed; optional dependencies may be absent', () => fixture(async root => {
  for (const property of ['dependencies', 'peerDependencies']) {
    const target = pkg(join(root, property), property, '1', { [property]: { absent: '*' } })
    assert.throws(() => collectHostedGraph([{ name: property, target }]), /required hosted dependency/)
  }
  const target = pkg(join(root, 'optional'), 'optional', '1', { optionalDependencies: { absent: '*' }, peerDependencies: { peer: '*' }, peerDependenciesMeta: { peer: { optional: true } } })
  assert.equal((await materialize(collectHostedGraph([{ name: 'optional', target }]), join(root, 'sealed/node_modules'))).size, 1)
}))

test('retains runtime JavaScript under src and npm implicit main outside files', () => fixture(async root => {
  const source = pkg(join(root, 'source'), 'source', '1', { main: './src/index.js' })
  mkdirSync(join(source, 'src'))
  writeFileSync(join(source, 'src/index.js'), 'module.exports=42')
  const implicit = pkg(join(root, 'implicit'), 'implicit', '1', { files: ['lib'] }, 'module.exports=43')
  const out = join(root, 'sealed/node_modules')
  await materialize(collectHostedGraph([{ name: 'source', target: source }, { name: 'implicit', target: implicit }]), out)
  const script = join(dirname(out), 'probe.cjs')
  writeFileSync(script, "if(require('source')!==42||require('implicit')!==43)throw Error('missing published entry')")
  execFileSync(process.execPath, [script])
}))

test('rejects competing first-party singleton identities and accidental optional-provider hoisting', () => fixture(root => {
  const modules = join(root, 'source/node_modules')
  const a = pkg(join(modules, 'a'), 'a', '1', { dependencies: { '@deepseek-ai/shared': '*' } })
  const b = pkg(join(modules, 'b'), 'b', '1', { dependencies: { '@deepseek-ai/shared': '*' } })
  pkg(join(a, 'node_modules/@deepseek-ai/shared'), '@deepseek-ai/shared', '1')
  pkg(join(b, 'node_modules/@deepseek-ai/shared'), '@deepseek-ai/shared', '2')
  assert.throws(() => planHostedLayout(collectHostedGraph([{ name: 'a', target: a }, { name: 'b', target: b }]), join(root, 'sealed/node_modules')), /singleton/)
  const optional = pkg(join(root, 'optional'), 'optional', '1', { optionalDependencies: { other: '*' } })
  const other = pkg(join(root, 'other'), 'other', '1')
  assert.throws(() => planHostedLayout(collectHostedGraph([{ name: 'optional', target: optional }, { name: 'other', target: other }]), join(root, 'sealed/node_modules')), /unintended provider/)
}))

test('uses npm globs and explicit runtime assets without exposing unpublished files or running lifecycle scripts', () => fixture(async root => {
  const target = pkg(join(root, 'source'), 'publication', '1', {
    files: ['dist/*.js', 'assets', 'docs/runtime.md'],
    scripts: { prepack: 'node lifecycle.cjs', prepare: 'node lifecycle.cjs', postpack: 'node lifecycle.cjs' },
  })
  for (const dir of ['dist', 'assets/tool', 'docs']) mkdirSync(join(target, dir), { recursive: true })
  for (const file of ['dist/index.js', 'assets/tool/SKILL.md', 'docs/runtime.md', 'LICENSE']) writeFileSync(join(target, file), 'published')
  for (const file of ['.env', 'private.json', 'dist/private.json', 'docs/private.md']) writeFileSync(join(target, file), 'synthetic unpublished value')
  writeFileSync(join(target, 'lifecycle.cjs'), "require('node:fs').writeFileSync('lifecycle-ran','unexpected')")
  const out = join(root, 'sealed/node_modules')
  await materialize(collectHostedGraph([{ name: 'publication', target }]), out)
  const copied = join(out, 'publication')
  for (const file of ['dist/index.js', 'assets/tool/SKILL.md', 'docs/runtime.md', 'LICENSE', 'index.cjs']) assert.ok(existsSync(join(copied, file)), file)
  for (const file of ['.env', 'private.json', 'dist/private.json', 'docs/private.md', 'lifecycle.cjs']) assert.equal(existsSync(join(copied, file)), false, file)
  assert.equal(existsSync(join(target, 'lifecycle-ran')), false)
}))

test('uses npmignore precedence for packages without a files whitelist', () => fixture(async root => {
  const target = pkg(join(root, 'source'), 'ignored', '1')
  writeFileSync(join(target, '.gitignore'), 'kept.json\n')
  writeFileSync(join(target, '.npmignore'), '.env\nprivate.json\n')
  for (const name of ['kept.json', 'private.json', '.env']) writeFileSync(join(target, name), 'synthetic')
  const out = join(root, 'sealed/node_modules')
  await materialize(collectHostedGraph([{ name: 'ignored', target }]), out)
  assert.ok(existsSync(join(out, 'ignored/kept.json')))
  assert.equal(existsSync(join(out, 'ignored/private.json')), false)
  assert.equal(existsSync(join(out, 'ignored/.env')), false)
}))
