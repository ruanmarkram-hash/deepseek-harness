import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { collectHostedGraph, planHostedLayout, publishedFiles } from './hosted-module-closure.mjs'

function regularPackage(target) {
  if (!isAbsolute(target)) throw new Error('approved hosted plugin target must be absolute')
  let stat
  try { stat = lstatSync(target) } catch { throw new Error(`approved hosted plugin target is not a regular package directory: ${target}`) }
  if (stat.isSymbolicLink()) throw new Error(`approved hosted plugin target is a symbolic link: ${target}`)
  if (!stat.isDirectory()) throw new Error(`approved hosted plugin target is not a regular package directory: ${target}`)
}

function rejectPackageLinks(target) {
  function visit(directory) {
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules' || name === '.git') continue
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`approved hosted plugin contains a symlink: ${path}`)
      if (stat.isDirectory()) visit(path)
    }
  }
  visit(target)
}

/** Hash the exact npm-published package and dependency files copied into the signed Host. */
export async function fingerprintHostedPlugin(target) {
  regularPackage(target)
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || manifest.name.length === 0 || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('approved hosted plugin needs package name and version')
  }
  const graph = collectHostedGraph([{ name: manifest.name, target }])
  const virtualModules = '/approved-hosted-plugin/node_modules'
  const placements = planHostedLayout(graph, virtualModules)
  const hash = createHash('sha256')
  hash.update('dsh-approved-hosted-closure-v1\n')
  for (const [placement, source] of [...placements].sort(([a], [b]) => a.localeCompare(b))) {
    rejectPackageLinks(source)
    const node = graph.nodes.get(source)
    const location = relative(virtualModules, placement).split(sep).join('/')
    hash.update(JSON.stringify([location, node.manifest.name, node.manifest.version]) + '\n')
    for (const file of (await publishedFiles(source)).sort()) {
      const fileHash = createHash('sha256').update(readFileSync(join(source, file))).digest('hex')
      hash.update(JSON.stringify([file, fileHash]) + '\n')
    }
  }
  return { name: manifest.name, version: manifest.version, sha256: hash.digest('hex') }
}

/** Validate an external Mac approval file without importing its mutable code. */
export async function approvedHostedPlugins(file) {
  if (!isAbsolute(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
    throw new Error('approved hosted plugin file must be an absolute regular JSON file')
  }
  const input = JSON.parse(readFileSync(file, 'utf8'))
  if (input?.formatVersion !== 1 || !Array.isArray(input.plugins)) throw new Error('invalid approved hosted plugin file')
  const roots = []
  const names = new Set()
  for (const entry of input.plugins) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.id) || typeof entry.name !== 'string' || typeof entry.version !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) || typeof entry.target !== 'string') {
      throw new Error('invalid approved hosted plugin entry')
    }
    if (names.has(entry.name) || names.has(entry.id)) throw new Error(`duplicate approved hosted plugin: ${entry.name}`)
    names.add(entry.name)
    names.add(entry.id)
    const actual = await fingerprintHostedPlugin(entry.target)
    if (actual.name !== entry.name || actual.version !== entry.version) throw new Error(`approved hosted plugin identity mismatch: ${entry.name}`)
    if (actual.sha256 !== entry.sha256) throw new Error(`approved hosted plugin content SHA-256 mismatch: ${entry.name}`)
    roots.push({ id: entry.id, ...actual, target: entry.target })
  }
  return roots
}

/** Refuse a copied closure whose bytes differ from the Mac-approved source. */
export async function verifyApprovedCopied(plugins, nodeModules) {
  for (const plugin of plugins) {
    const copied = await fingerprintHostedPlugin(join(nodeModules, plugin.name))
    if (copied.name !== plugin.name || copied.version !== plugin.version || copied.sha256 !== plugin.sha256) {
      throw new Error(`approved hosted plugin copied content SHA-256 mismatch: ${plugin.name}`)
    }
  }
}
