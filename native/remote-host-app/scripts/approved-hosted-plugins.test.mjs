import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { approvedHostedPlugins, fingerprintHostedPlugin, verifyApprovedCopied } from './approved-hosted-plugins.mjs'
import { collectHostedGraph, copyHostedPackages, planHostedLayout } from './hosted-module-closure.mjs'

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'approved-hosted-plugins-'))
  try { return await run(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

function packageAt(root, name = '@example/approved') {
  const target = join(root, 'plugin')
  mkdirSync(target)
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.js', files: ['index.js'] }))
  writeFileSync(join(target, 'index.js'), 'export const value = 1\n')
  return target
}

test('accepts an exact pinned package and resolves its signed import root', () => fixture(async root => {
  const target = packageAt(root)
  const fingerprint = await fingerprintHostedPlugin(target)
  const file = join(root, 'approval.json')
  writeFileSync(file, JSON.stringify({ formatVersion: 1, plugins: [{ id: 'approved-test', ...fingerprint, target }] }))
  assert.deepEqual(await approvedHostedPlugins(file), [{ id: 'approved-test', ...fingerprint, target }])
}))

test('rejects changed published bytes before packaging', () => fixture(async root => {
  const target = packageAt(root)
  const fingerprint = await fingerprintHostedPlugin(target)
  const file = join(root, 'approval.json')
  writeFileSync(file, JSON.stringify({ formatVersion: 1, plugins: [{ id: 'approved-test', ...fingerprint, target }] }))
  writeFileSync(join(target, 'index.js'), 'export const value = 2\n')
  await assert.rejects(approvedHostedPlugins(file), /content SHA-256 mismatch/)
}))

test('rejects missing packages and symbolic-link package roots', () => fixture(async root => {
  const target = packageAt(root)
  const fingerprint = await fingerprintHostedPlugin(target)
  const file = join(root, 'approval.json')
  writeFileSync(file, JSON.stringify({ formatVersion: 1, plugins: [{ id: 'approved-test', ...fingerprint, target: join(root, 'missing') }] }))
  await assert.rejects(approvedHostedPlugins(file), /regular package directory/)
  const link = join(root, 'plugin-link')
  symlinkSync(target, link)
  writeFileSync(file, JSON.stringify({ formatVersion: 1, plugins: [{ id: 'approved-test', ...fingerprint, target: link }] }))
  await assert.rejects(approvedHostedPlugins(file), /symbolic link/)
}))

test('rejects symbolic links in published files', () => fixture(async root => {
  const target = packageAt(root)
  rmSync(join(target, 'index.js'))
  writeFileSync(join(root, 'outside.js'), 'export const value = 1\n')
  symlinkSync(join(root, 'outside.js'), join(target, 'index.js'))
  await assert.rejects(fingerprintHostedPlugin(target), /symlink/)
}))

test('verifies the copied package tree matches the approved fingerprint', () => fixture(async root => {
  const target = packageAt(root)
  const fingerprint = await fingerprintHostedPlugin(target)
  const approved = [{ id: 'approved-test', ...fingerprint, target }]
  const out = join(root, 'HostedChild/node_modules')
  const graph = collectHostedGraph([{ name: fingerprint.name, target }])
  await copyHostedPackages(graph, planHostedLayout(graph, out))
  await verifyApprovedCopied(approved, out)
  const probe = join(root, 'HostedChild/probe.mjs')
  writeFileSync(probe, "import { value } from '@example/approved'; if (value !== 1) throw Error('missing approved plugin')\n")
  execFileSync(process.execPath, [probe])
  writeFileSync(join(out, '@example/approved/index.js'), 'export const value = 3\n')
  await assert.rejects(verifyApprovedCopied(approved, out), /copied content SHA-256 mismatch/)
}))
