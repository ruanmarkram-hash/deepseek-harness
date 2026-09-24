/** Separate Host-attached artifact; never package upstream's runtime-owning shell. */
const { join } = require('node:path')
const desktop = join(__dirname, '../../../apps/desktop')
module.exports = {
  appId: 'ai.dsh.desktop',
  productName: 'DSH Desktop',
  electronVersion: require(join(desktop, 'node_modules/electron/package.json')).version,
  directories: { app: __dirname, output: join(__dirname, 'release') },
  files: ['main.mjs', 'runtime-discovery.mjs', 'package.json'],
  asar: true,
  npmRebuild: false,
  mac: {
    target: [{ target: 'dir', arch: ['arm64'] }],
    icon: join(desktop, 'assets/DeepSeek.icns'),
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    entitlements: join(desktop, 'scripts/jit-entitlements.plist'),
    entitlementsInherit: join(desktop, 'scripts/jit-entitlements.plist'),
    identity: null,
  },
}
