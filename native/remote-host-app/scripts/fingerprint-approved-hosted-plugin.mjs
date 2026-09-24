import { fingerprintHostedPlugin } from './approved-hosted-plugins.mjs'

const target = process.argv[2]
if (!target || process.argv.length !== 3) {
  console.error('usage: fingerprint-approved-hosted-plugin.mjs /absolute/installed/package')
  process.exit(64)
}
console.log(JSON.stringify(await fingerprintHostedPlugin(target)))
