import { contextBridge, ipcRenderer } from 'electron'

/** The isolated pairing page receives only native-picker choices and status. */
contextBridge.exposeInMainWorld('dshDesktopPairing', {
  close: async (): Promise<void> => { await ipcRenderer.invoke('dsh-pairing:close') },
  sessions: (): Promise<unknown> => ipcRenderer.invoke('dsh-pairing:sessions'),
  start: (selection: unknown): Promise<unknown> => ipcRenderer.invoke('dsh-pairing:start', selection),
  onState: (listener: (state: unknown) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown): void => { listener(state) }
    ipcRenderer.on('dsh-pairing:state', wrapped)
    return () => ipcRenderer.removeListener('dsh-pairing:state', wrapped)
  },
})
