import { describe, expect, it } from 'vitest'
import {
  desktopRuntimeDeployArgs,
  desktopRuntimeEntryPath,
  desktopApplicationStagingPath,
  desktopRuntimeStagingPath,
  isSafeDesktopRuntimeStagingPath,
} from './build-desktop-runtime.ts'

describe('desktop runtime staging', () => {
  it('uses an ignored child directory rather than a deploy source', () => {
    expect(desktopRuntimeStagingPath('/repo')).toBe('/repo/.dsh-build/desktop-runtime')
    expect(desktopApplicationStagingPath('/repo')).toBe('/repo/.dsh-build/desktop-app')
    expect(isSafeDesktopRuntimeStagingPath('/repo', '/repo/.dsh-build/desktop-runtime')).toBe(true)
    expect(isSafeDesktopRuntimeStagingPath('/repo', '/repo')).toBe(false)
    expect(isSafeDesktopRuntimeStagingPath('/repo', '/')).toBe(false)
  })

  it('deploys the private closure with the established symlink-safe flags', () => {
    expect(desktopRuntimeDeployArgs('/repo/.dsh-build/desktop-runtime')).toEqual([
      '--filter',
      '@deepseek-ai/dsh-desktop-runtime',
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      '/repo/.dsh-build/desktop-runtime',
    ])
  })

  it('requires the built CLI entry in the deployed resources', () => {
    expect(desktopRuntimeEntryPath('/resources/dsh-runtime')).toBe(
      '/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    )
  })
})
