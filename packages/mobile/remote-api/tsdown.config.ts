import { defineConfig } from 'tsdown'
export default defineConfig({ entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'node22', fixedExtension: false, dts: false, clean: false })
