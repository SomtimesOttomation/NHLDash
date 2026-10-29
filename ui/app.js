// NHL 2026-27 page: shows the dash contract working, with nothing fetched.
import * as bridge from './bridge.js';

const $ = (id) => document.getElementById(id);
let state = null;
let standaloneTheme = 'system';

const log = [];
function addLog(text) {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  log.unshift({ t, text });
  log.length = Math.min(log.length, 8);
  $('log').innerHTML = log.map((l) => `<li><time>${l.t}</time><span>${l.text}</span></li>`).join('');
}

function render() {
  if (!state) return;
  const inLauncher = state.mode === 'launcher';
  $('where').textContent = inLauncher ? `inside DashLauncher v${state.launcherVersion}` : 'running on its own';
  $('btn-theme').hidden = inLauncher;                      // in the launcher, the launcher owns the theme
  $('halted').hidden = !state.halted;
  $('version').textContent = state.version ? `v${state.version}` : '';
  liveStatus();
  $('ticks').textContent = state.ticks;
  $('traffic').textContent = `${state.traffic.requests} simulated requests, ${(state.traffic.bytes / 1024).toFixed(1)} KB (nothing leaves this computer)`;
  $('live').textContent = state.live;
  $('t-update').checked = state.update;
  $('t-problem').checked = state.problem;
  const s = state.sync || { running: false, pct: 0 };
  $('bar-fill').style.width = `${s.running ? s.pct : (s.pct >= 100 ? 100 : 0)}%`;
  $('btn-sync').disabled = s.running || state.halted;
  $('btn-cancel').hidden = !s.running;
}

async function set(key, value) {
  try { state = await bridge.request('nhldash.set', { key, value }); render(); } catch (e) { addLog(e.message); }
}

document.querySelectorAll('[data-live]').forEach((b) => b.addEventListener('click', () => set('live', state.live + Number(b.dataset.live))));
$('t-update').addEventListener('change', (e) => set('update', e.target.checked));
$('t-problem').addEventListener('change', (e) => set('problem', e.target.checked));
$('btn-sync').addEventListener('click', async () => {
  try { if (await bridge.request('sync.run')) { state.sync = { running: true, pct: 0 }; render(); } } catch (e) { addLog(e.message); }
});
$('btn-cancel').addEventListener('click', async () => {
  try { await bridge.request('sync.cancel'); state.sync = { running: false, pct: 0 }; render(); addLog('fake sync cancelled'); } catch (e) { addLog(e.message); }
});
// Pause switch: the live-status button and the Resume bar send the same page commands as every other dash.
async function setTraffic(stop) {
  try { state = await bridge.request(stop ? 'traffic.stop' : 'traffic.resume'); render(); addLog(stop ? 'paused from the live status' : 'resumed'); } catch (e) { addLog(e.message); }
}
$('btn-resume').addEventListener('click', () => setTraffic(false));
$('live-status').addEventListener('click', () => setTraffic(!state?.halted));

// Live status text, in the navigation bar spec's priority order. A real dash also shows Manual / Updated Xm ago.
function liveStatus() {
  const el = $('live-status');
  const halted = !!state.halted, live = state.live > 0 && !halted, err = state.problem && !halted;
  el.className = `live-status np-live${live ? ' on' : ''}${err ? ' err' : ''}${halted ? ' halted' : ''}`;
  el.textContent = halted ? 'Paused' : err ? 'Offline' : live ? 'Live' : 'Updated just now';
  el.title = halted ? 'All data traffic is paused. Click to resume.' : `${err ? 'Pretend problem from the NHL dash.\n' : ''}Click to pause all data traffic`;
  el.setAttribute('aria-pressed', halted ? 'true' : 'false');
}

// Routes: every view is a #/ route, so Back and Forward step through the page's own history.
const cards = [...document.querySelectorAll('#view-home .card')];
cards.forEach((c) => { c.id = 'card-' + c.querySelector('h2').textContent.toLowerCase().replace(/[^a-z0-9]+/g, '-'); });
function route() {
  const h = location.hash || '#/';
  $('view-home').hidden = h === '#/settings';
  $('view-settings').hidden = h !== '#/settings';
  $('btn-home').classList.toggle('active', h === '#/' || h === '');
  cards.forEach((c) => c.classList.remove('hit'));
  const m = h.match(/^#\/card\/(.+)$/);
  if (m) { const c = $(m[1]); if (c) { c.classList.add('hit'); c.scrollIntoView({ block: 'nearest' }); } }
}
window.addEventListener('hashchange', route);
let navDepth = 0;
window.addEventListener('hashchange', () => { navDepth++; });
const goBack = () => { if (navDepth > 0) { navDepth -= 2; history.back(); } else location.hash = '#/'; };
$('btn-back').addEventListener('click', goBack);
$('btn-fwd').addEventListener('click', () => history.forward());
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); history.forward(); }
  if (e.key === 'F5') { e.preventDefault(); $('btn-refresh').click(); }
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); goBack(); }
  if (e.button === 4) { e.preventDefault(); history.forward(); }
});
$('btn-settings').addEventListener('click', () => { location.hash = '#/settings'; });

// Refresh: live data only. Here it just re-reads the snapshot; a real dash refetches live scores.
$('btn-refresh').addEventListener('click', async () => {
  const b = $('btn-refresh'); b.classList.add('spin');
  try { state = await bridge.request('init'); render(); addLog('refreshed'); } catch (e) { addLog(e.message); }
  setTimeout(() => b.classList.remove('spin'), 400);
});

// Search: each dash decides what it searches (players, drivers, clubs). The starter searches its own cards.
const res = $('psearch-results');
$('psearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { res.hidden = true; return; }
  const hits = cards.filter((c) => c.textContent.toLowerCase().includes(q));
  res.innerHTML = hits.length ? hits.map((c) => `<a href="#/card/${c.id}">${c.querySelector('h2').textContent}</a>`).join('') : '<div class="empty">No matches</div>';
  res.hidden = false;
});
res.addEventListener('click', () => { res.hidden = true; $('psearch').value = ''; });
document.addEventListener('click', (e) => { if (!e.target.closest('.psearch')) res.hidden = true; });
$('btn-theme').addEventListener('click', () => {
  standaloneTheme = { system: 'light', light: 'dark', dark: 'system' }[standaloneTheme];
  try { localStorage.setItem('theme', standaloneTheme); } catch { }
  bridge.setTheme(standaloneTheme);
  $('btn-theme').textContent = `Theme: ${standaloneTheme}`;
});

bridge.on('tick', (d) => { if (state) { state.ticks = d.ticks; state.traffic = d.traffic; render(); } });
bridge.on('sync', (d) => {
  if (!state) return;
  state.sync = d; render();
  if (!d.running && d.pct >= 100) addLog('fake sync finished');
});
// The same paused state whichever way traffic was stopped: launcher kill switch, live status or Resume.
bridge.on('traffic', (d) => {
  if (!state) return;
  state.halted = !!d.stopped;
  if (d.stopped) state.sync = { running: false, pct: 0 };
  render(); addLog(`traffic: ${d.stopped ? 'stopped' : 'resumed'}`);
});
bridge.on('host.theme', (d) => { bridge.setTheme(d.theme); addLog(`host.theme: ${d.theme}`); });
bridge.on('host.visible', () => addLog('host.visible: tab shown'));
bridge.on('host.hidden', () => addLog('host.hidden: tab hidden'));

(async () => {
  try { standaloneTheme = localStorage.getItem('theme') || 'system'; } catch { }
  try {
    state = await bridge.request('init');
    if (state.mode !== 'launcher') { bridge.setTheme(standaloneTheme); $('btn-theme').textContent = `Theme: ${standaloneTheme}`; }
    else if (state.theme) bridge.setTheme(state.theme);
    render(); route();
    $('log').innerHTML = '<li class="empty">Switch tabs or change the launcher theme to see messages here.</li>';
  } catch (e) {
    $('where').textContent = e.message;
  }
})();
