/** A signed Host plugin visible to trusted clients. */
export interface PluginView {
  /** Stable ID of the sealed composition row. */
  readonly id: string
  /** Installed module name from the signed bundle. */
  readonly name: string
  /** Signed Host controls never enumerate user-installed executable packages. */
  readonly source: 'bundled' | 'downloaded'
  /** Whether the row currently runs in the Host. */
  readonly enabled: boolean
  /** Required rows cannot be changed through this service. */
  readonly required: boolean
  /** Explanation for a locked row. */
  readonly reason?: string
}

/** Complete point-in-time plugin catalog. */
export interface PluginList { readonly plugins: PluginView[] }

/** One exact-ID enablement request. */
export interface PluginEnablementRequest { readonly id: string; readonly enabled: boolean }

/** Plugin row after a completed change. */
export interface PluginEnablementResult { readonly plugin: PluginView }
