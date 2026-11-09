// Browser preview (like NBADash's ui/dev/mock.js): when the page is opened in a normal browser, outside
// Start-NHLDash.bat or DashLauncher, this stands in for the host so the layout can be checked. It answers the same
// commands with small made-up data and never contacts a server. Inside WebView2 it does nothing.
(function () {
  if (window.chrome && window.chrome.webview) return;
  const listeners = [];
  const today = new Date(); const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const team = (id, abbrev, name, score, sog) => ({ id, abbrev, name: { default: name }, commonName: { default: name }, placeName: { default: name }, score, sog });
  const sample = {
    [`score:${iso(today)}`]: { games: [
      { id: 2026020001, gameType: 2, gameState: 'LIVE', startTimeUTC: new Date().toISOString(), venue: { default: 'Preview Arena' }, awayTeam: team(1, 'AAA', 'Preview A', 2, 18), homeTeam: team(2, 'BBB', 'Preview B', 1, 21), clock: { timeRemaining: '08:12', inIntermission: false }, periodDescriptor: { number: 2, periodType: 'REG' } },
      { id: 2026020002, gameType: 2, gameState: 'FUT', startTimeUTC: new Date(Date.now() + 3 * 3600e3).toISOString(), venue: { default: 'Sample Centre' }, awayTeam: team(3, 'CCC', 'Sample C'), homeTeam: team(4, 'DDD', 'Sample D') },
    ] },
  };
  const state = { mode: 'standalone', version: 'preview', theme: '', halted: false, live: 1, error: null, today: iso(today), cacheDir: '(browser preview)',
    settings: { autoRefresh: false, autoAck: false, refreshSeconds: 60, moneypuck: false, mpAck: false, favorites: [], updateCheck: false },
    traffic: { requests: 0, bytes: 0, errors: 0 } };
  const send = (m) => setTimeout(() => listeners.forEach((f) => f({ data: m })), 20);
  const handle = (msg) => {
    const ok = (data) => send({ id: msg.id, ok: true, data });
    switch (msg.cmd) {
      case 'init': return ok(state);
      case 'settings.set': state.settings[msg.args.key] = msg.args.value; return ok(state);
      case 'traffic.stop': state.halted = true; send({ event: 'traffic', data: { stopped: true } }); return ok(state);
      case 'traffic.resume': state.halted = false; send({ event: 'traffic', data: { stopped: false } }); return ok(state);
      case 'season.weeks': return ok([]);
      case 'sync.status': return ok({ running: false, savedGames: 0, done: 0, total: 0, note: '' });
      case 'sync.run': {
        ok({ started: true }); let done = 0; const total = 40;
        const t = setInterval(() => { done += 4; const fin = done >= total; send({ event: 'sync', data: fin ? { running: false, pct: 100, cancelled: false, note: '' } : { running: true, pct: Math.round(100 * done / total), done, total } }); if (fin) clearInterval(t); }, 600);
        return undefined;
      }
      case 'schedule.get': return ok({ exists: false, time: '', lastRun: '' });
      case 'traffic.get': return ok({ uptimeSec: 0, requests: 0, bytes: 0, errors: 0, byHost: {}, last: [] });
      case 'data.get': {
        const k = msg.args.key;
        if (msg.args.cacheOnly || k === 'seasonbox') return ok('missing');
        ok('queued');
        if (k.startsWith('logo:') || k.startsWith('mug:')) return undefined;
        return send({ event: 'data', data: sample[k] ? { key: k, ok: true, at: new Date().toISOString(), body: sample[k] } : { key: k, ok: false, error: 'Browser preview: no data for this page.' } });
      }
      default: return ok(true);
    }
  };
  window.chrome = window.chrome || {};
  window.chrome.webview = { addEventListener: (t, f) => listeners.push(f), postMessage: handle };
})();
