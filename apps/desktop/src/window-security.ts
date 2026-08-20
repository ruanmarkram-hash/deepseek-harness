import type { WebPreferences } from 'electron'

/** Renderer privileges for the local DSH page. */
export const desktopWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} satisfies WebPreferences
