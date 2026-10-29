// Bridge between the NHL dash page and whoever hosts it (Start-NHLDash.ps1 or DashLauncher).
//   page -> host : { id, cmd, args }
//   host -> page : { id, ok, data, error }  (response)   or   { event, data }  (push)

export const isHost = !!(window.chrome && window.chrome.webview);

const pending = new Map();
const handlers = new Map();
let nextId = 1;

export function on(evt, fn) {
  if (!handlers.has(evt)) handlers.set(evt, new Set());
  handlers.get(evt).add(fn);
  return () => handlers.get(evt).delete(fn);
}

function emit(evt, data) {
  const set = handlers.get(evt);
  if (set) for (const fn of set) { try { fn(data); } catch (e) { console.error('handler failed', evt, e); } }
}

if (isHost) {
  window.chrome.webview.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok === false) p.reject(new Error(m.error || 'host error'));
      else p.resolve(m.data);
    } else if (m.event) {
      emit(m.event, m.data);
    }
  });
}

export async function request(cmd, args = {}, timeoutMs = 30000) {
  if (!isHost) throw new Error('Open the NHL dash with Start-NHLDash.bat or from DashLauncher.');
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`host timeout: ${cmd}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    window.chrome.webview.postMessage({ id, cmd, args });
  });
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme || 'system';
}
