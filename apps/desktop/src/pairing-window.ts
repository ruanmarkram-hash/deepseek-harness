import { fileURLToPath } from 'node:url'
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'

/** A deliberately tiny, sandboxed native pairing page. */
export function pairingWindowOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return {
    parent,
    modal: true,
    width: 440,
    height: 640,
    resizable: false,
    show: false,
    title: 'Pair DSH Mobile',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: fileURLToPath(new URL('./pairing-preload.js', import.meta.url)),
    },
  }
}

/** Allow the isolated pairing renderer to remain only on its exact data URL. */
export function trustedPairingNavigation(target: string, pairingUrl: string): boolean {
  return target === pairingUrl
}

/** Render only pairing controls, session aliases, a QR bootstrap, and status. */
export function pairingWindowDocument(markDataUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Pair DSH Mobile</title><style>body{margin:0;background:#181817;color:#f4f3ef;font:14px -apple-system,BlinkMacSystemFont,sans-serif}main{padding:28px}h1{margin:0 0 8px;font-size:22px}p{color:#bab8b0;line-height:1.45}.mark{width:32px;height:32px;vertical-align:middle;margin-right:9px}.sessions{display:grid;gap:8px;margin:20px 0}button{border:0;border-radius:9px;background:#4d6bfe;color:white;padding:10px 12px;font:inherit;cursor:pointer}button[disabled]{opacity:.45;cursor:default}.session{background:#2a2927;text-align:left}.session[data-selected="true"]{outline:2px solid #4d6bfe}.code{display:none;margin-top:20px;padding:12px;border-radius:9px;background:#242321;color:#d7d6d0;word-break:break-all;font:11px ui-monospace,SFMono-Regular,monospace}.state{min-height:20px;color:#bab8b0}.close{margin-top:22px;background:transparent;border:1px solid #4b4944;color:#d7d6d0}</style></head><body><main><h1><img class="mark" src="${markDataUrl}" alt="DeepSeek">Pair DSH Mobile</h1><p>Select one existing desktop session. Your phone can read that text-only session and request queued plain-text prompts. Every prompt still needs approval here.</p><div id="sessions" class="sessions"></div><button id="start" disabled>Create pairing code</button><div id="code" class="code"></div><p id="state" class="state">Loading local sessions…</p><button id="close" class="close">Close pairing</button></main><script>const bridge=window.dshDesktopPairing;let selected;const sessions=document.getElementById('sessions'),start=document.getElementById('start'),code=document.getElementById('code'),state=document.getElementById('state');function showState(v){state.textContent=v.status==='awaiting-phone'?'Waiting for phone…':v.status==='awaiting-desktop-approval'?'Approve the phone on this Mac…':v.status==='paired'?'Phone paired. This session is foreground-only.':v.status==='closed'?'Pairing closed.':' '}bridge.sessions().then(list=>{if(!Array.isArray(list)||list.length===0){state.textContent='No existing local sessions are available.';return}state.textContent='Choose the session to pair.';for(const item of list){if(!item||typeof item.id!=='string'||typeof item.label!=='string')continue;const b=document.createElement('button');b.className='session';b.textContent=item.label;b.onclick=()=>{selected=item.id;for(const e of sessions.children)e.dataset.selected=String(e===b);start.disabled=false};sessions.append(b)}}).catch(()=>{state.textContent='Could not read local sessions.'});start.onclick=()=>{if(!selected)return;start.disabled=true;bridge.start(selected).then(value=>{if(!value||typeof value.qrValue!=='string')throw new Error();code.textContent=value.qrValue;code.style.display='block';state.textContent='Scan or paste this pairing code in DSH Mobile.'}).catch(()=>{state.textContent='Could not create pairing.';start.disabled=false})};bridge.onState(showState);document.getElementById('close').onclick=()=>bridge.close();</script></body></html>`
}
