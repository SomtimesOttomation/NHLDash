// NHL 2026-27 page. Data arrives as {event:'data', data:{key, ok, at, body}} after a 'data.get' request.
// The page only names keys; the backend decides the URLs.
import * as bridge from './bridge.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nm = (o) => (o && typeof o === 'object' ? o.default : o) || '';

let state = null;                 // snapshot from the backend
let standaloneTheme = 'system';
const store = new Map();          // key -> { body, at, error, loading }
let routeKeys = [];               // keys the current view needs (Refresh refetches these)

// ------------------------------------------------------------------ data
async function want(key, force = false) {
  const cur = store.get(key) || {};
  if (!force && (cur.body !== undefined || cur.loading || cur.error)) return;   // a failed key waits for Refresh
  store.set(key, { ...cur, loading: true, error: null });
  try { await bridge.request('data.get', { key, force }); }
  catch (e) { store.set(key, { ...store.get(key), loading: false, error: e.message }); render(); }
}
const get = (key) => store.get(key)?.body;

bridge.on('data', (d) => {
  const cur = store.get(d.key) || {};
  if (d.ok) {
    let body = d.body;
    if (typeof body === 'string' && d.key.startsWith('mp:')) body = parseCsv(body);
    if (d.key.startsWith('logo:')) { logoReady(d.key); return; }
    store.set(d.key, { body, at: new Date(d.at), loading: false, error: null });
    if (d.key === `score:${today()}`) state.live = liveCount(body);
  } else {
    store.set(d.key, { ...cur, loading: false, error: d.error });
    if (d.key.startsWith('logo:')) return;
  }
  render();
});

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().split(',');
  return lines.map((l) => {
    const f = l.split(','); const o = {};
    head.forEach((h, i) => { const v = f[i]; o[h] = v !== '' && !isNaN(v) ? Number(v) : v; });
    return o;
  });
}

// ------------------------------------------------------------------ logos (cached on disk by the backend)
const logoAsked = new Set();
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function logo(abbrev, cls = 'tlogo') {
  if (!/^[A-Z]{3}$/.test(abbrev || '')) return `<span class="${cls}"></span>`;
  const v = isDark() ? 'dark' : 'light';
  return `<img class="${cls}" alt="" data-logo="${abbrev}" src="https://nhldash.cache/logos/${abbrev}_${v}.svg">`;
}
// A logo that is not cached yet fails to load; ask for it once, then reload the images when it arrives.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.logo) return;
  img.style.visibility = 'hidden';
  const key = `logo:${img.dataset.logo}${isDark() ? ':dark' : ''}`;
  if (!logoAsked.has(key) && state && !state.halted) { logoAsked.add(key); bridge.request('data.get', { key }).catch(() => {}); }
}, true);
function logoReady(key) {
  const abbrev = key.split(':')[1];
  document.querySelectorAll(`img[data-logo="${abbrev}"]`).forEach((img) => { img.style.visibility = ''; img.src = img.src.split('?')[0] + '?t=' + Date.now(); });
}

// ------------------------------------------------------------------ helpers
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function shiftDate(iso, days) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function niceDate(iso) { return new Date(iso + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); }
function ago(at) {
  if (!at) return '';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
const favs = () => new Set(state?.settings?.favorites || []);
const plink = (id, html) => (id ? `<a class="plink" href="#/player/${id}">${html}</a>` : html);
const isLive = (g) => g.gameState === 'LIVE' || g.gameState === 'CRIT';
const isFinal = (g) => g.gameState === 'FINAL' || g.gameState === 'OFF';
function liveCount(score) { return (score?.games || []).filter(isLive).length; }
function ordinal(n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`; }
function periodLabel(pd) {
  if (!pd) return '';
  if (pd.periodType === 'SO') return 'SO';
  if (pd.periodType === 'OT') return pd.number > 4 ? `${pd.number - 3}OT` : 'OT';
  return ordinal(pd.number);
}
function gameStatus(g) {
  if (isLive(g)) {
    const c = g.clock || {};
    if (c.inIntermission) return `${periodLabel(g.periodDescriptor)} INT`;
    return `${periodLabel(g.periodDescriptor)} ${c.timeRemaining || ''}`.trim();
  }
  if (isFinal(g)) {
    const t = g.gameOutcome?.lastPeriodType || g.periodDescriptor?.periodType;
    return t === 'OT' ? 'Final/OT' : t === 'SO' ? 'Final/SO' : 'Final';
  }
  if (g.gameScheduleState && g.gameScheduleState !== 'OK') return g.gameScheduleState === 'PPD' ? 'Postponed' : g.gameScheduleState;
  return new Date(g.startTimeUTC).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function status(key) {
  const s = store.get(key);
  if (!s) return '';
  if (s.error && s.body === undefined) return `<div class="note err">Could not load: ${esc(s.error)}</div>`;
  if (s.body === undefined) return '<div class="note">Loading...</div>';
  return '';
}
function teamName(t) { return nm(t.commonName) || nm(t.name) || t.abbrev; }

// ------------------------------------------------------------------ views
const views = {};

views.scores = (date) => {
  date = date || today();
  const key = `score:${date}`;
  routeKeys = [key];
  want(key);
  const sc = get(key);
  const fav = favs();
  let games = (sc?.games || []).slice();
  games.sort((a, b) => (isLive(b) - isLive(a)) || ((fav.has(b.awayTeam.abbrev) || fav.has(b.homeTeam.abbrev)) - (fav.has(a.awayTeam.abbrev) || fav.has(a.homeTeam.abbrev))) || a.startTimeUTC.localeCompare(b.startTimeUTC));
  const cards = games.map((g) => {
    const live = isLive(g), fut = !live && !isFinal(g);
    const row = (t, other) => {
      const win = isFinal(g) && t.score > other.score;
      const lose = isFinal(g) && t.score < other.score;
      const st = (get('standings')?.standings || []).find((x) => nm(x.teamAbbrev) === t.abbrev);
      const sub = st ? `${st.wins}-${st.losses}-${st.otLosses}` : nm(t.name);
      return `<div class="gteam${win ? ' win' : ''}${lose ? ' lose' : ''}${fav.has(t.abbrev) ? ' fav' : ''}"><span class="gside">${logo(t.abbrev, 'glogo')}<span class="gnames"><b>${esc(t.abbrev)}</b><small class="muted">${esc(sub)}</small></span></span>${fut ? '' : `<span class="gsc"><b class="sc">${t.score ?? 0}</b><small class="muted">${t.sog != null ? t.sog + ' SOG' : ''}</small></span>`}</div>`;
    };
    return `<a class="card game${live ? ' live' : ''}${fav.has(g.awayTeam.abbrev) || fav.has(g.homeTeam.abbrev) ? ' fav' : ''}" href="#/game/${g.id}" id="game-${g.id}">
      <div class="gstat${live ? ' on' : ''}">${esc(gameStatus(g))}</div>${row(g.awayTeam, g.homeTeam)}${row(g.homeTeam, g.awayTeam)}
      <div class="gmeta">${esc(nm(g.venue))}${g.tvBroadcasts?.length ? ' &middot; ' + esc(g.tvBroadcasts.map((b) => b.network).join(', ')) : ''}</div></a>`;
  }).join('');
  const d0 = new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const title = date === today() ? 'Today' : date === shiftDate(today(), -1) ? 'Yesterday' : date === shiftDate(today(), 1) ? 'Tomorrow' : 'Games';
  return `<div class="games-wrap"><div class="section-head"><h2>${title}<small>${esc(d0)}${sc ? ` &middot; ${games.length} game${games.length === 1 ? '' : 's'}` : ''}</small></h2>
      <span class="dnav"><a class="btn sq" href="#/scores/${shiftDate(date, -1)}" aria-label="Previous day">&lsaquo;</a>${date !== today() ? '<a class="btn" href="#/">Today</a>' : ''}<a class="btn sq" href="#/scores/${shiftDate(date, 1)}" aria-label="Next day">&rsaquo;</a></span></div>
    ${status(key)}
    ${sc && !games.length ? '<div class="note">No games on this day.</div>' : ''}
    <div class="grid games">${cards}</div></div>`;
};

views.game = (id) => {
  const box = `box:${id}`, pbp = `pbp:${id}`;
  routeKeys = [box, pbp];
  want(box); want(pbp);
  const b = get(box), p = get(pbp);
  if (!b) return status(box) || '<div class="note">Loading...</div>';
  const a = b.awayTeam, h = b.homeTeam;
  const fut = b.gameState === 'FUT' || b.gameState === 'PRE';
  const head = `<section class="card ghead">
      <div class="gside">${logo(a.abbrev, 'blogo')}<div><div class="muted small">${esc(nm(a.placeName))}</div><div class="big2">${esc(teamName(a))}</div></div><b class="bigsc">${fut ? '' : a.score}</b></div>
      <div class="gmid"><div class="gstat${isLive(b) ? ' on' : ''}">${esc(gameStatus(b))}</div><div class="muted small">${esc(nm(b.venue))}</div>${fut ? '' : `<div class="muted small">SOG ${a.sog ?? 0} - ${h.sog ?? 0}</div>`}</div>
      <div class="gside r"><b class="bigsc">${fut ? '' : h.score}</b><div><div class="muted small">${esc(nm(h.placeName))}</div><div class="big2">${esc(teamName(h))}</div></div>${logo(h.abbrev, 'blogo')}</div>
    </section>`;
  if (fut) return head + '<div class="note">The game has not started yet. Box score and shot map appear once it does.</div>';
  return head + `<div class="grid two">
      <section class="card"><h2>Scoring</h2>${p ? scoring(p) : status(pbp)}</section>
      <section class="card"><h2>Shot map</h2>${p ? shotMap(p) : status(pbp)}</section>
    </div>
    <section class="card wide"><h2>Game flow</h2>${p ? gameFlow(p) : status(pbp)}</section>
    <section class="card wide"><h2>${esc(teamName(a))}</h2>${boxTable(b.playerByGameStats?.awayTeam)}</section>
    <section class="card wide"><h2>${esc(teamName(h))}</h2>${boxTable(b.playerByGameStats?.homeTeam)}</section>`;
};

function playersOf(p) {
  const m = new Map();
  for (const r of p.rosterSpots || []) m.set(r.playerId, { name: `${nm(r.firstName)} ${nm(r.lastName)}`, last: nm(r.lastName), team: r.teamId, num: r.sweaterNumber });
  return m;
}

function scoring(p) {
  const who = playersOf(p);
  const abbr = { [p.awayTeam.id]: p.awayTeam.abbrev, [p.homeTeam.id]: p.homeTeam.abbrev };
  const goals = (p.plays || []).filter((e) => e.typeDescKey === 'goal');
  if (!goals.length) return '<p class="muted">No goals yet.</p>';
  let per = '';
  return '<ol class="goals">' + goals.map((e) => {
    const d = e.details || {};
    const pl = periodLabel(e.periodDescriptor);
    const head = pl !== per ? `<li class="per">${esc(pl === 'SO' ? 'Shootout' : pl === 'OT' ? 'Overtime' : pl + ' period')}</li>` : '';
    per = pl;
    const s = who.get(d.scoringPlayerId);
    const as = [d.assist1PlayerId, d.assist2PlayerId].filter(Boolean).map((x) => who.get(x)?.last).filter(Boolean);
    const strength = e.periodDescriptor?.periodType === 'SO' ? '' : strengthOf(e, d.eventOwnerTeamId === p.homeTeam.id);
    return head + `<li>${logo(abbr[d.eventOwnerTeamId], 'slogo')}<span class="gtime">${esc(e.timeInPeriod)}</span>
      <span><b>${s ? plink(d.scoringPlayerId, esc(s.name)) : 'Unknown'}</b>${d.scoringPlayerTotal ? ` (${d.scoringPlayerTotal})` : ''}${strength ? ` <span class="tag">${strength}</span>` : ''}<br>
      <span class="muted small">${as.length ? 'Assists: ' + esc(as.join(', ')) : 'Unassisted'}</span></span>
      <span class="gsc">${d.awayScore ?? ''}-${d.homeScore ?? ''}</span></li>`;
  }).join('') + '</ol>';
}

// situationCode: away goalie, away skaters, home skaters, home goalie (e.g. 1551 = 5 on 5).
function strengthOf(e, ownerIsHome) {
  const c = String(e.situationCode || '');
  if (c.length !== 4) return '';
  const awayG = +c[0], awayS = +c[1], homeS = +c[2], homeG = +c[3];
  const oppGoalie = ownerIsHome ? awayG : homeG;
  if (oppGoalie === 0) return 'EN';
  const mine = ownerIsHome ? homeS : awayS, theirs = ownerIsHome ? awayS : homeS;
  return mine > theirs ? 'PP' : mine < theirs ? 'SH' : '';
}

// ------------------------------------------------------------------ shot map
let shotFilter = { team: 'both', period: 'all' };
function shotMap(p) {
  const who = playersOf(p);
  const homeId = p.homeTeam.id;
  const kinds = { 'shot-on-goal': 'sog', 'missed-shot': 'miss', goal: 'goal' };
  const shots = [];
  // Which way each team shoots, per period, from its offensive-zone shots (used if homeTeamDefendingSide is missing).
  const sideVote = {};
  for (const e of p.plays || []) {
    const d = e.details || {};
    if (!kinds[e.typeDescKey] || d.xCoord == null) continue;
    if (d.zoneCode === 'O') { const k = `${d.eventOwnerTeamId}-${e.periodDescriptor?.number}`; sideVote[k] = (sideVote[k] || 0) + Math.sign(d.xCoord); }
  }
  for (const e of p.plays || []) {
    const d = e.details || {};
    const kind = kinds[e.typeDescKey];
    if (!kind || d.xCoord == null || d.yCoord == null) continue;
    if (e.periodDescriptor?.periodType === 'SO') continue;
    const isHome = d.eventOwnerTeamId === homeId;
    let attacksRight;
    if (e.homeTeamDefendingSide === 'left' || e.homeTeamDefendingSide === 'right') {
      const homeAttacksRight = e.homeTeamDefendingSide === 'left';
      attacksRight = isHome ? homeAttacksRight : !homeAttacksRight;
    } else {
      attacksRight = (sideVote[`${d.eventOwnerTeamId}-${e.periodDescriptor?.number}`] || 1) > 0;
    }
    let x = d.xCoord, y = d.yCoord;
    if (!attacksRight) { x = -x; y = -y; }       // now every shot heads to the right-hand net
    if (!isHome) { x = -x; y = -y; }             // away team drawn shooting at the left net
    shots.push({ x, y, kind, isHome, per: e.periodDescriptor?.number, shooter: who.get(d.shootingPlayerId || d.scoringPlayerId)?.name || '', t: e.timeInPeriod, type: d.shotType || '' });
  }
  const pers = [...new Set(shots.map((s) => s.per))].sort((a, b) => a - b);
  const vis = shots.filter((s) => (shotFilter.team === 'both' || (shotFilter.team === 'home') === s.isHome) && (shotFilter.period === 'all' || String(s.per) === shotFilter.period));
  const dot = (s) => {
    const cx = s.x + 100, cy = 42.5 - s.y;
    const title = `${s.shooter} ${s.t} P${s.per} ${s.type} ${s.kind === 'goal' ? 'GOAL' : s.kind === 'sog' ? 'shot on goal' : 'missed'}`;
    const cls = `${s.isHome ? 'h' : 'a'} ${s.kind}`;
    return s.kind === 'goal'
      ? `<g class="${cls}"><title>${esc(title)}</title><circle cx="${cx}" cy="${cy}" r="3.2"/><circle class="ring" cx="${cx}" cy="${cy}" r="5"/></g>`
      : `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${s.kind === 'sog' ? 2.2 : 1.8}"><title>${esc(title)}</title></circle>`;
  };
  const count = (home, k) => shots.filter((s) => s.isHome === home && (shotFilter.period === 'all' || String(s.per) === shotFilter.period) && (!k || s.kind === k)).length;
  const btn = (grp, val, label) => `<button type="button" class="seg${shotFilter[grp] === val ? ' on' : ''}" data-shot="${grp}:${val}">${esc(label)}</button>`;
  return `<div class="segs">${btn('team', 'both', 'Both')}${btn('team', 'away', p.awayTeam.abbrev)}${btn('team', 'home', p.homeTeam.abbrev)}
      <span class="segsep"></span>${btn('period', 'all', 'All')}${pers.map((n) => btn('period', String(n), n > 3 ? (n === 4 ? 'OT' : `${n - 3}OT`) : `P${n}`)).join('')}</div>
    <svg class="rink" viewBox="-2 -2 204 89" role="img" aria-label="Shot map">
      <rect x="0" y="0" width="200" height="85" rx="28" class="ice"/>
      <line x1="100" y1="0" x2="100" y2="85" class="red"/><line x1="75" y1="0" x2="75" y2="85" class="blue"/><line x1="125" y1="0" x2="125" y2="85" class="blue"/>
      <line x1="11" y1="3" x2="11" y2="82" class="goal"/><line x1="189" y1="3" x2="189" y2="82" class="goal"/>
      <circle cx="100" cy="42.5" r="15" class="fo"/>
      ${[[31, 20.5], [31, 64.5], [169, 20.5], [169, 64.5]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="15" class="fo"/>`).join('')}
      <path d="M11 38.5 h4.5 a4 4 0 0 1 0 8 h-4.5z" class="crease"/><path d="M189 38.5 h-4.5 a4 4 0 0 0 0 8 h4.5z" class="crease"/>
      <text x="50" y="7" class="rlabel">${esc(p.awayTeam.abbrev)} shooting</text><text x="150" y="7" class="rlabel">${esc(p.homeTeam.abbrev)} shooting</text>
      ${vis.map(dot).join('')}
    </svg>
    <div class="legend small"><span><i class="a sog"></i>${esc(p.awayTeam.abbrev)} ${count(false, 'goal')} G / ${count(false, 'sog') + count(false, 'goal')} SOG / ${count(false, 'miss')} missed</span>
      <span><i class="h sog"></i>${esc(p.homeTeam.abbrev)} ${count(true, 'goal')} G / ${count(true, 'sog') + count(true, 'goal')} SOG / ${count(true, 'miss')} missed</span>
      <span class="muted">Ring = goal. Blocked shots not shown.</span></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-shot]');
  if (!b) return;
  const [grp, val] = b.dataset.shot.split(':');
  shotFilter[grp] = val; render();
});

function boxTable(t) {
  if (!t) return '<p class="muted">No box score yet.</p>';
  const sk = [...(t.forwards || []), ...(t.defense || [])];
  const rows = sk.map((s) => `<tr><td>${s.sweaterNumber ?? ''}</td><td class="l">${plink(s.playerId, esc(nm(s.name)))}</td><td>${s.position}</td><td>${s.goals}</td><td>${s.assists}</td><td><b>${s.points}</b></td><td>${s.plusMinus > 0 ? '+' : ''}${s.plusMinus}</td><td>${s.sog}</td><td>${s.hits}</td><td>${s.blockedShots}</td><td>${s.pim}</td><td>${s.faceoffWinningPctg ? Math.round(s.faceoffWinningPctg * 100) + '%' : ''}</td><td>${esc(s.toi)}</td></tr>`).join('');
  const gl = (t.goalies || []).filter((g) => g.toi && g.toi !== '00:00').map((g) => `<tr><td>${g.sweaterNumber ?? ''}</td><td class="l">${plink(g.playerId, esc(nm(g.name)))}${g.decision ? ` <span class="tag">${esc(g.decision)}</span>` : ''}</td><td>${esc(g.saveShotsAgainst || '')}</td><td>${g.savePctg != null ? g.savePctg.toFixed(3).replace(/^0/, '') : ''}</td><td>${g.goalsAgainst ?? ''}</td><td>${esc(g.evenStrengthShotsAgainst || '')}</td><td>${esc(g.powerPlayShotsAgainst || '')}</td><td>${esc(g.shorthandedShotsAgainst || '')}</td><td>${esc(g.toi || '')}</td></tr>`).join('');
  return `<div class="tscroll"><table class="tbl"><thead><tr><th>#</th><th class="l">Skater</th><th>Pos</th><th>G</th><th>A</th><th>P</th><th>+/-</th><th>SOG</th><th>HIT</th><th>BLK</th><th>PIM</th><th>FO%</th><th>TOI</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="tscroll"><table class="tbl"><thead><tr><th>#</th><th class="l">Goalie</th><th>SV/SA</th><th>SV%</th><th>GA</th><th>EV</th><th>PP</th><th>SH</th><th>TOI</th></tr></thead><tbody>${gl}</tbody></table></div>`;
}

let standMode = (() => { try { return localStorage.getItem('standMode') || 'division'; } catch { return 'division'; } })();
views.standings = (hl) => {
  routeKeys = ['standings'];
  want('standings');
  const st = get('standings');
  if (!st) return status('standings');
  const teams = st.standings || [];
  const fav = favs();
  const groups = {};
  const by = standMode === 'league' ? () => 'League' : standMode === 'conference' ? (t) => `${t.conferenceName} Conference` : (t) => `${t.divisionName} Division`;
  for (const t of teams) (groups[by(t)] ||= []).push(t);
  const seq = standMode === 'league' ? 'leagueSequence' : standMode === 'conference' ? 'conferenceSequence' : 'divisionSequence';
  const order = Object.keys(groups).sort();
  const seg = (v, l) => `<button type="button" class="seg${standMode === v ? ' on' : ''}" data-stand="${v}">${l}</button>`;
  return `<div class="segs bar1">${seg('division', 'Division')}${seg('conference', 'Conference')}${seg('league', 'League')}
      <span class="muted small push">Updated ${esc(ago(store.get('standings')?.at))}</span><a class="btn small-btn" href="#/eastwest">East-West report</a></div>
    <div class="grid two stand">${order.map((gname) => `<section class="card"><h2>${esc(gname)}</h2><div class="tscroll"><table class="tbl">
      <thead><tr><th></th><th class="l">Team</th><th>GP</th><th>W</th><th>L</th><th>OTL</th><th>PTS</th><th>P%</th><th>RW</th><th>GF</th><th>GA</th><th>DIFF</th><th>L10</th><th>STRK</th></tr></thead><tbody>
      ${groups[gname].sort((a, b) => a[seq] - b[seq]).map((t) => {
        const ab = nm(t.teamAbbrev);
        return `<tr class="${ab === hl ? 'hl' : ''}${fav.has(ab) ? ' fav' : ''}" id="st-${ab}"><td>${t[seq]}</td><td class="l"><a class="tlink" href="#/team/${ab}">${logo(ab, 'slogo')} ${esc(nm(t.teamCommonName) || ab)}</a>${t.clinchIndicator ? ` <span class="tag">${esc(t.clinchIndicator)}</span>` : ''}</td><td>${t.gamesPlayed}</td><td>${t.wins}</td><td>${t.losses}</td><td>${t.otLosses}</td><td><b>${t.points}</b></td><td>${t.pointPctg.toFixed(3).replace(/^0/, '')}</td><td>${t.regulationWins}</td><td>${t.goalFor}</td><td>${t.goalAgainst}</td><td>${t.goalDifferential > 0 ? '+' : ''}${t.goalDifferential}</td><td>${t.l10Wins}-${t.l10Losses}-${t.l10OtLosses}</td><td>${esc(t.streakCode || '')}${t.streakCount || ''}</td></tr>`;
      }).join('')}</tbody></table></div></section>`).join('')}</div>`;
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-stand]');
  if (!b) return;
  standMode = b.dataset.stand; try { localStorage.setItem('standMode', standMode); } catch { }
  render();
});

const leaderNames = { points: 'Points', goals: 'Goals', assists: 'Assists', plusMinus: 'Plus/minus', wins: 'Wins', savePctg: 'Save %', goalsAgainstAverage: 'Goals against avg.', shutouts: 'Shutouts' };
views.leaders = () => {
  routeKeys = ['leaders', 'goalies'];
  want('leaders'); want('goalies');
  const block = (key) => {
    const d = get(key);
    if (!d) return `<section class="card">${status(key)}</section>`;
    return Object.keys(leaderNames).filter((c) => d[c]).map((c) => `<section class="card"><h2>${leaderNames[c]}</h2><ol class="lead">${d[c].map((p, i) => {
      const v = c === 'savePctg' ? p.value.toFixed(3).replace(/^0/, '') : c === 'goalsAgainstAverage' ? p.value.toFixed(2) : (c === 'plusMinus' && p.value > 0 ? '+' : '') + p.value;
      return `<li><span class="rk">${i + 1}</span>${logo(p.teamAbbrev, 'slogo')}<span class="l">${plink(p.id, `${esc(nm(p.firstName))} <b>${esc(nm(p.lastName))}</b>`)} <span class="muted small">${esc(p.teamAbbrev)} &middot; ${esc(p.position)}</span></span><b class="v">${v}</b></li>`;
    }).join('')}</ol></section>`).join('');
  };
  return `<div class="grid three">${block('leaders')}${block('goalies')}</div>`;
};

// ------------------------------------------------------------------ advanced (MoneyPuck, opt-in)
let adv = { sit: 'all', sort: { teams: 'xGoalsPercentage', skaters: 'I_F_xGoals', goalies: 'gsax' }, dir: { teams: -1, skaters: -1, goalies: -1 } };
views.advanced = () => {
  if (!state.settings.moneypuck) {
    routeKeys = [];
    return `<section class="card narrow"><h2>Advanced stats from MoneyPuck</h2>
      <p>Expected goals (xG), shot quality and goals saved above expected, from MoneyPuck's published season files.</p>
      <p class="muted">Off by default. When on, the dash downloads three files from moneypuck.com when you open this page, at most every 12 hours. MoneyPuck allows this for personal, non-commercial use and asks to be credited.</p>
      <p><a class="btn primary" href="#/settings">Turn it on in Settings</a></p></section>`;
  }
  routeKeys = ['mp:teams', 'mp:skaters', 'mp:goalies'];
  routeKeys.forEach((k) => want(k));
  const pct = (v) => (v == null || v === '' ? '' : (v * 100).toFixed(1) + '%');
  const f1 = (v) => (v == null || v === '' ? '' : Number(v).toFixed(1));
  const f2 = (v) => (v == null || v === '' ? '' : Number(v).toFixed(2));
  const toi = (sec) => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  const fav = favs();
  const sortRows = (tbl, rows) => { const k = adv.sort[tbl], d = adv.dir[tbl]; return rows.sort((a, b) => ((a[k] ?? -1e9) > (b[k] ?? -1e9) ? 1 : -1) * d); };
  const th = (tbl, k, label, l) => `<th class="sortable${l ? ' l' : ''}${adv.sort[tbl] === k ? ' sorted' : ''}" data-adv="${tbl}:${k}">${label}${adv.sort[tbl] === k ? (adv.dir[tbl] < 0 ? ' &darr;' : ' &uarr;') : ''}</th>`;

  const tm = get('mp:teams'), sk = get('mp:skaters'), gk = get('mp:goalies');
  const teams = tm ? sortRows('teams', tm.filter((r) => r.situation === adv.sit).map((r) => ({ ...r, xgd: r.xGoalsFor - r.xGoalsAgainst, gd: r.goalsFor - r.goalsAgainst }))) : null;
  const skaters = sk ? sortRows('skaters', sk.filter((r) => r.situation === adv.sit && r.games_played > 0).map((r) => ({ ...r, gax: r.I_F_goals - r.I_F_xGoals }))).slice(0, 60) : null;
  const goalies = gk ? sortRows('goalies', gk.filter((r) => r.situation === adv.sit && r.games_played > 0).map((r) => ({ ...r, gsax: r.xGoals - r.goals, svp: r.ongoal ? 1 - r.goals / r.ongoal : null }))).slice(0, 40) : null;
  const seg = (v, l) => `<button type="button" class="seg${adv.sit === v ? ' on' : ''}" data-sit="${v}">${l}</button>`;
  return `<div class="segs bar1">${seg('all', 'All situations')}${seg('5on5', '5 on 5')}
      <span class="muted small push">Data: <b>MoneyPuck.com</b> &middot; updated ${esc(ago(store.get('mp:teams')?.at))}</span></div>
    <section class="card wide"><h2>Teams</h2>${teams ? `<div class="tscroll"><table class="tbl"><thead><tr>${th('teams', 'team', 'Team', 1)}${th('teams', 'games_played', 'GP')}${th('teams', 'xGoalsPercentage', 'xGF%')}${th('teams', 'corsiPercentage', 'CF%')}${th('teams', 'fenwickPercentage', 'FF%')}${th('teams', 'xGoalsFor', 'xGF')}${th('teams', 'xGoalsAgainst', 'xGA')}${th('teams', 'xgd', 'xGD')}${th('teams', 'goalsFor', 'GF')}${th('teams', 'goalsAgainst', 'GA')}${th('teams', 'gd', 'GD')}${th('teams', 'highDangerShotsFor', 'HDSF')}${th('teams', 'highDangerShotsAgainst', 'HDSA')}</tr></thead><tbody>
      ${teams.map((r) => `<tr class="${fav.has(r.team) ? 'fav' : ''}"><td class="l">${logo(r.team, 'slogo')} ${esc(r.team)}</td><td>${r.games_played}</td><td><b>${pct(r.xGoalsPercentage)}</b></td><td>${pct(r.corsiPercentage)}</td><td>${pct(r.fenwickPercentage)}</td><td>${f1(r.xGoalsFor)}</td><td>${f1(r.xGoalsAgainst)}</td><td>${r.xgd > 0 ? '+' : ''}${f1(r.xgd)}</td><td>${r.goalsFor}</td><td>${r.goalsAgainst}</td><td>${r.gd > 0 ? '+' : ''}${r.gd}</td><td>${r.highDangerShotsFor}</td><td>${r.highDangerShotsAgainst}</td></tr>`).join('')}</tbody></table></div>` : status('mp:teams')}</section>
    <section class="card wide"><h2>Skaters <span class="muted small">top 60 by the sorted column</span></h2>${skaters ? `<div class="tscroll"><table class="tbl"><thead><tr>${th('skaters', 'name', 'Player', 1)}${th('skaters', 'team', 'Team')}${th('skaters', 'position', 'Pos')}${th('skaters', 'games_played', 'GP')}${th('skaters', 'icetime', 'TOI')}${th('skaters', 'I_F_goals', 'G')}${th('skaters', 'I_F_xGoals', 'xG')}${th('skaters', 'gax', 'G-xG')}${th('skaters', 'I_F_points', 'P')}${th('skaters', 'I_F_shotsOnGoal', 'SOG')}${th('skaters', 'I_F_highDangerShots', 'HDS')}${th('skaters', 'onIce_xGoalsPercentage', 'On-ice xGF%')}${th('skaters', 'gameScore', 'Game score')}</tr></thead><tbody>
      ${skaters.map((r) => `<tr class="${fav.has(r.team) ? 'fav' : ''}"><td class="l">${plink(r.playerId, esc(r.name))}</td><td>${esc(r.team)}</td><td>${esc(r.position)}</td><td>${r.games_played}</td><td>${toi(r.icetime)}</td><td>${r.I_F_goals}</td><td><b>${f2(r.I_F_xGoals)}</b></td><td>${r.gax > 0 ? '+' : ''}${f2(r.gax)}</td><td>${r.I_F_points}</td><td>${r.I_F_shotsOnGoal}</td><td>${r.I_F_highDangerShots}</td><td>${pct(r.onIce_xGoalsPercentage)}</td><td>${f1(r.gameScore)}</td></tr>`).join('')}</tbody></table></div>` : status('mp:skaters')}</section>
    <section class="card wide"><h2>Goalies <span class="muted small">GSAx = goals saved above expected</span></h2>${goalies ? `<div class="tscroll"><table class="tbl"><thead><tr>${th('goalies', 'name', 'Goalie', 1)}${th('goalies', 'team', 'Team')}${th('goalies', 'games_played', 'GP')}${th('goalies', 'icetime', 'TOI')}${th('goalies', 'gsax', 'GSAx')}${th('goalies', 'xGoals', 'xGA')}${th('goalies', 'goals', 'GA')}${th('goalies', 'svp', 'SV%')}${th('goalies', 'highDangerShots', 'HD shots')}${th('goalies', 'highDangerGoals', 'HD GA')}</tr></thead><tbody>
      ${goalies.map((r) => `<tr class="${fav.has(r.team) ? 'fav' : ''}"><td class="l">${plink(r.playerId, esc(r.name))}</td><td>${esc(r.team)}</td><td>${r.games_played}</td><td>${toi(r.icetime)}</td><td><b>${r.gsax > 0 ? '+' : ''}${f2(r.gsax)}</b></td><td>${f2(r.xGoals)}</td><td>${r.goals}</td><td>${r.svp == null ? '' : r.svp.toFixed(3).replace(/^0/, '')}</td><td>${r.highDangerShots}</td><td>${r.highDangerGoals}</td></tr>`).join('')}</tbody></table></div>` : status('mp:goalies')}</section>
    <p class="muted small credit">Advanced stats courtesy of MoneyPuck.com, used for personal, non-commercial purposes under their published data terms.</p>`;
};
document.addEventListener('click', (e) => {
  const s = e.target.closest('[data-sit]');
  if (s) { adv.sit = s.dataset.sit; render(); return; }
  const h = e.target.closest('[data-adv]');
  if (!h) return;
  const [tbl, k] = h.dataset.adv.split(':');
  if (adv.sort[tbl] === k) adv.dir[tbl] *= -1; else { adv.sort[tbl] = k; adv.dir[tbl] = ['name', 'team', 'position'].includes(k) ? 1 : -1; }
  render();
});

// ------------------------------------------------------------------ settings
// Primary team colours (used for the banner tiles and team page accents).
const COLORS = { ANA: 'f47a38', BOS: 'ffb81c', BUF: '003087', CAR: 'cc0000', CBJ: '002654', CGY: 'c8102e', CHI: 'cf0a2c', COL: '6f263d', DAL: '006847', DET: 'ce1126', EDM: 'ff4c00', FLA: 'c8102e', LAK: '111111', MIN: '154734', MTL: 'af1e2d', NJD: 'ce1126', NSH: 'ffb81c', NYI: '00539b', NYR: '0038a8', OTT: 'c52032', PHI: 'f74902', PIT: 'fcb514', SEA: '001628', SJS: '006d75', STL: '002f87', TBL: '002868', TOR: '00205b', UTA: '6cace4', VAN: '00205b', VGK: 'b4975a', WPG: '041e42', WSH: 'c8102e' };
const teamColor = (k) => `#${COLORS[k] || '6b7280'}`;
const TEAMS = { ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CAR: 'Carolina Hurricanes', CBJ: 'Columbus Blue Jackets', CGY: 'Calgary Flames', CHI: 'Chicago Blackhawks', COL: 'Colorado Avalanche', DAL: 'Dallas Stars', DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers', LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens', NJD: 'New Jersey Devils', NSH: 'Nashville Predators', NYI: 'New York Islanders', NYR: 'New York Rangers', OTT: 'Ottawa Senators', PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins', SEA: 'Seattle Kraken', SJS: 'San Jose Sharks', STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth', VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights', WPG: 'Winnipeg Jets', WSH: 'Washington Capitals' };
views.settings = () => {
  routeKeys = [];
  const s = state.settings, t = state.traffic;
  return `<div class="grid two">
    <section class="card"><h2>Favourite teams</h2><p class="muted">Click the star on a team in the banner (or on its team page). Favourites sit at the front of the banner, their games show first and their rows are highlighted.</p><p>${(s.favorites || []).length ? s.favorites.map((k) => `<a class="favchip" href="#/team/${k}">${logo(k, 'slogo')} ${esc(TEAMS[k] || k)}</a>`).join(' ') : '<span class="muted">None yet.</span>'}</p></section>
    <section class="card"><h2>Automatic refresh</h2>
      <p class="muted">Off: the dash only fetches when you open a page or press Refresh (F5). On: while this tab is visible, the scores and the game you have open are refetched on a timer.</p>
      <label class="row"><span>Refresh automatically</span><input id="set-auto" type="checkbox"${s.autoRefresh ? ' checked' : ''}></label>
      <label class="row"><span>Every</span><span><input id="set-secs" type="number" min="20" max="600" step="10" value="${s.refreshSeconds}"> seconds</span></label></section>
    <section class="card"><h2>MoneyPuck advanced stats</h2>
      <p class="muted">Expected goals, shot quality and goalie GSAx on the Advanced page. Downloads MoneyPuck's published season files when you open that page, at most every 12 hours.</p>
      <label class="row"><span>Use MoneyPuck</span><input id="set-mp" type="checkbox"${s.moneypuck ? ' checked' : ''}></label></section>
    <section class="card"><h2>Updates</h2><p class="muted">Checks GitHub for a newer NHLDash release a few seconds after start. Click the version number to check any time. Not affected by the pause switch.</p>
      <label class="row"><span>Check for updates on start</span><input id="set-upd" type="checkbox"${s.updateCheck !== false ? ' checked' : ''}></label></section>
    <section class="card"><h2>Data and sources</h2>
      <p class="small">NHL web API (api-web.nhle.com): scores, game centre, standings, leaders. Unofficial and undocumented; it can change without notice. <a href="https://www.nhl.com/info/terms-of-service" target="_blank" rel="noreferrer">NHL terms</a></p>
      <p class="small">MoneyPuck.com season files (only when turned on). <a href="https://moneypuck.com/data.htm" target="_blank" rel="noreferrer">MoneyPuck data terms</a></p>
      <p class="muted small">This session: ${t.requests} requests, ${(t.bytes / 1048576).toFixed(2)} MB, ${t.errors} errors.</p>
      <div class="actions"><button id="set-clear" class="btn" type="button">Clear saved data</button><a class="btn" href="#/traffic">Traffic details</a></div></section>
  </div>`;
};
function confirmDialog(title, html) {
  return new Promise((resolve) => {
    $('dialog-title').textContent = title; $('dialog-body').innerHTML = html; $('dialog').hidden = false; $('dialog-ok').focus();
    const done = (v) => { $('dialog').hidden = true; $('dialog-ok').onclick = $('dialog-cancel').onclick = null; resolve(v); };
    $('dialog-ok').onclick = () => done(true); $('dialog-cancel').onclick = () => done(false);
  });
}
async function setSetting(key, value, ack = false) {
  try { state = await bridge.request('settings.set', { key, value, ack }); } catch (e) { alertNote(e.message); }
  render();
}
function alertNote(msg) { const n = document.createElement('div'); n.className = 'toast'; n.textContent = msg; document.body.append(n); setTimeout(() => n.remove(), 4000); }
document.addEventListener('change', async (e) => {
  const id = e.target.id;
  if (id === 'set-upd') setSetting('updateCheck', e.target.checked);
  if (id === 'set-secs') setSetting('refreshSeconds', Number(e.target.value));
  if (id === 'set-auto') {
    const on = e.target.checked;
    if (on && !state.settings.autoAck) {
      const ok = await confirmDialog('Turn on automatic refresh?', `<p>While this tab is visible, the dash will contact the NHL's servers on its own every ${state.settings.refreshSeconds} seconds for the scores and the game you have open.</p><p class="muted">The NHL API is unofficial. Keep the interval reasonable; it stops whenever you switch tabs or press the live status to pause.</p>`);
      if (!ok) { e.target.checked = false; return; }
      return setSetting('autoRefresh', true, true);
    }
    setSetting('autoRefresh', on);
  }
  if (id === 'set-mp') {
    const on = e.target.checked;
    if (on && !state.settings.mpAck) {
      const ok = await confirmDialog('Use MoneyPuck data?', '<p>The Advanced page will download MoneyPuck\'s published season files (teams, skaters, goalies) from moneypuck.com when you open it, at most every 12 hours.</p><p class="muted">MoneyPuck allows this for personal, non-commercial use, credited to MoneyPuck.com. Don\'t share or sell the data.</p>');
      if (!ok) { e.target.checked = false; return; }
      return setSetting('moneypuck', true, true);
    }
    setSetting('moneypuck', on);
  }
});
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'set-clear') return;
  try { await bridge.request('cache.clear'); store.clear(); loadSeason(); alertNote('Saved data cleared. Logos are kept.'); } catch (err) { alertNote(err.message); }
});


// ------------------------------------------------------------------ team banner (same look and behaviour as NBADash)
let bannerSig = '';
function renderBanner(active) {
  const el = $('banner');
  const fav = favs();
  const sig = `${[...fav].join(',')}|${active}|${isDark()}`;
  if (sig === bannerSig && el.firstChild) return;
  bannerSig = sig;
  const prev = el.querySelector('.banner-strip')?.scrollLeft || 0;
  const byName = (a, b) => TEAMS[a].localeCompare(TEAMS[b]);
  const all = Object.keys(TEAMS);
  const f = all.filter((k) => fav.has(k)).sort(byName), rest = all.filter((k) => !fav.has(k)).sort(byName);
  const tile = (k) => `<a class="tile${fav.has(k) ? ' fav' : ''}${k === active ? ' active' : ''}" href="#/team/${k}" role="listitem" title="${esc(TEAMS[k])}" style="--tc:${teamColor(k)}">
      <button class="star tile-star${fav.has(k) ? ' on' : ''}" type="button" data-star="${k}" title="${fav.has(k) ? 'Remove from favourites' : 'Add to favourites'}" aria-pressed="${fav.has(k)}">${fav.has(k) ? '★' : '☆'}</button>
      ${logo(k, 'tile-logo')}<span class="tile-code">${k}</span></a>`;
  el.innerHTML = `<button class="banner-btn left" type="button" aria-label="Scroll teams left">‹</button>
    <div class="banner-strip" role="list">${f.map(tile).join('')}${f.length ? '<span class="banner-divider" aria-hidden="true"></span>' : ''}${rest.map(tile).join('')}</div>
    <button class="banner-btn right" type="button" aria-label="Scroll teams right">›</button>`;
  const strip = el.querySelector('.banner-strip'), left = el.querySelector('.banner-btn.left'), right = el.querySelector('.banner-btn.right');
  const scroll = (dir) => strip.scrollBy({ left: dir * Math.max(300, strip.clientWidth * 0.8), behavior: 'smooth' });
  left.onclick = () => scroll(-1); right.onclick = () => scroll(1);
  strip.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  const update = () => {
    left.classList.toggle('hide', strip.scrollLeft < 8);
    right.classList.toggle('hide', strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 8);
  };
  strip.addEventListener('scroll', update, { passive: true });
  strip.style.scrollBehavior = 'auto'; strip.scrollLeft = prev; strip.style.scrollBehavior = '';
  requestAnimationFrame(() => {
    const a = strip.querySelector('.tile.active');
    if (a && (a.offsetLeft < strip.scrollLeft || a.offsetLeft + a.offsetWidth > strip.scrollLeft + strip.clientWidth)) a.scrollIntoView({ inline: 'center', block: 'nearest' });
    update();
  });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-star]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const k = b.dataset.star, list = [...(state.settings.favorites || [])];
  const i = list.indexOf(k);
  if (i >= 0) list.splice(i, 1); else list.push(k);
  state.settings.favorites = list;          // show it right away; the backend saves it
  setSetting('favorites', list);
}, true);

// ------------------------------------------------------------------ team page
views.team = (k) => {
  const sk = `sched:${k}`, tk = `team:${k}`;
  routeKeys = ['standings', sk, tk];
  routeKeys.forEach((x) => want(x));
  if (state.settings.moneypuck) { routeKeys.push('mp:teams', 'mp:skaters'); want('mp:teams'); want('mp:skaters'); }
  const fav = favs().has(k);
  const st = (get('standings')?.standings || []).find((t) => nm(t.teamAbbrev) === k);
  const rec = st ? `<div class="trec"><b>${st.wins}-${st.losses}-${st.otLosses}</b> &middot; ${st.points} pts &middot; ${ordinal(st.divisionSequence)} in the ${esc(st.divisionName)} &middot; L10 ${st.l10Wins}-${st.l10Losses}-${st.l10OtLosses} &middot; ${esc(st.streakCode || '')}${st.streakCount || ''} streak &middot; GF ${st.goalFor} / GA ${st.goalAgainst}</div>` : '';
  const head = `<section class="card thead" style="--tc:${teamColor(k)}">${logo(k, 'blogo')}
      <div><div class="big2">${esc(TEAMS[k])}</div>${rec || '<div class="muted small">Record loads with the standings.</div>'}</div>
      <button class="btn cmpbtn" type="button" data-cmp="team:${k}" title="Compare with another team">Compare</button>
      <button class="star big${fav ? ' on' : ''}" type="button" data-star="${k}" title="${fav ? 'Remove from favourites' : 'Add to favourites'}" aria-pressed="${fav}">${fav ? '★' : '☆'}</button></section>`;

  // Schedule: regular season and playoffs (preseason only if that is all there is yet).
  const sch = get(sk);
  let games = (sch?.games || []).filter((g) => g.gameType >= 2);
  if (sch && !games.length) games = sch.games || [];
  const done = games.filter(isFinal), next = games.filter((g) => !isFinal(g));
  const line = (g) => {
    const home = g.homeTeam.abbrev === k, me = home ? g.homeTeam : g.awayTeam, op = home ? g.awayTeam : g.homeTeam;
    const date = new Date(g.startTimeUTC).toLocaleDateString([], { month: 'short', day: 'numeric' });
    let res;
    if (isFinal(g)) {
      const w = me.score > op.score, ot = g.gameOutcome?.lastPeriodType;
      res = `<span class="res ${w ? 'w' : 'l'}">${w ? 'W' : ot === 'OT' || ot === 'SO' ? 'OTL' : 'L'}</span> ${me.score}-${op.score}${ot === 'OT' ? ' OT' : ot === 'SO' ? ' SO' : ''}`;
    } else if (isLive(g)) res = '<span class="res live">LIVE</span>';
    else res = `<span class="muted">${esc(gameStatus(g))}</span>`;
    return `<a class="sline" href="#/game/${g.id}"><span class="sdate">${esc(date)}</span><span class="svs">${home ? 'vs' : '@'}</span>${logo(op.abbrev, 'slogo')}<span class="sop">${esc(nm(op.commonName) || op.abbrev)}</span><span class="sres">${res}</span></a>`;
  };
  const schedule = sch ? `<div class="grid two">
      <section class="card"><h2>Last games</h2>${done.length ? done.slice(-8).reverse().map(line).join('') : '<p class="muted">No games played yet.</p>'}</section>
      <section class="card"><h2>Next games</h2>${next.length ? next.slice(0, 8).map(line).join('') : '<p class="muted">No games left on the schedule.</p>'}</section></div>` : `<section class="card">${status(sk)}</section>`;

  // Season stats for the team's players.
  const cs = get(tk);
  const pct3 = (v) => (v == null ? '' : v.toFixed(3).replace(/^0/, ''));
  const toiAvg = (sec) => (sec ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '');
  const skaters = cs ? `<section class="card wide"><h2>Skaters <span class="muted small">season stats</span></h2><div class="tscroll"><table class="tbl"><thead><tr><th class="l">Skater</th><th>Pos</th><th>GP</th><th>G</th><th>A</th><th>P</th><th>+/-</th><th>PIM</th><th>PPG</th><th>SOG</th><th>S%</th><th>TOI/GP</th><th>FO%</th></tr></thead><tbody>
      ${(cs.skaters || []).slice().sort((a, b) => b.points - a.points || b.goals - a.goals).map((p) => `<tr><td class="l">${plink(p.playerId, `${esc(nm(p.firstName))} <b>${esc(nm(p.lastName))}</b>`)}</td><td>${esc(p.positionCode)}</td><td>${p.gamesPlayed}</td><td>${p.goals}</td><td>${p.assists}</td><td><b>${p.points}</b></td><td>${p.plusMinus > 0 ? '+' : ''}${p.plusMinus}</td><td>${p.penaltyMinutes}</td><td>${p.powerPlayGoals}</td><td>${p.shots}</td><td>${p.shootingPctg ? (p.shootingPctg * 100).toFixed(1) : '0.0'}</td><td>${toiAvg(p.avgTimeOnIcePerGame)}</td><td>${p.faceoffWinPctg ? Math.round(p.faceoffWinPctg * 100) + '%' : ''}</td></tr>`).join('')}</tbody></table></div>
      <div class="tscroll"><table class="tbl"><thead><tr><th class="l">Goalie</th><th>GP</th><th>GS</th><th>W</th><th>L</th><th>OTL</th><th>GAA</th><th>SV%</th><th>SA</th><th>SO</th></tr></thead><tbody>
      ${(cs.goalies || []).map((g) => `<tr><td class="l">${plink(g.playerId, `${esc(nm(g.firstName))} <b>${esc(nm(g.lastName))}</b>`)}</td><td>${g.gamesPlayed}</td><td>${g.gamesStarted}</td><td>${g.wins}</td><td>${g.losses}</td><td>${g.overtimeLosses}</td><td>${g.goalsAgainstAverage?.toFixed(2) ?? ''}</td><td>${pct3(g.savePercentage)}</td><td>${g.shotsAgainst}</td><td>${g.shutouts}</td></tr>`).join('')}</tbody></table></div></section>` : `<section class="card wide">${status(tk)}</section>`;

  // MoneyPuck (only when turned on).
  let mp = '';
  if (state.settings.moneypuck) {
    const row = (get('mp:teams') || []).find((r) => r.team === k && r.situation === 'all');
    const r5 = (get('mp:teams') || []).find((r) => r.team === k && r.situation === '5on5');
    const top = (get('mp:skaters') || []).filter((r) => r.team === k && r.situation === 'all').sort((a, b) => b.I_F_xGoals - a.I_F_xGoals).slice(0, 5);
    const p = (v) => (v == null ? '' : (v * 100).toFixed(1) + '%');
    mp = row ? `<section class="card"><h2>Advanced <span class="muted small">MoneyPuck.com</span></h2>
      <div class="kpis"><div><b>${p(row.xGoalsPercentage)}</b><small>xGF% all</small></div><div><b>${p(r5?.xGoalsPercentage)}</b><small>xGF% 5v5</small></div><div><b>${p(row.corsiPercentage)}</b><small>CF%</small></div><div><b>${row.xGoalsFor.toFixed(1)}-${row.xGoalsAgainst.toFixed(1)}</b><small>xGF-xGA</small></div></div>
      ${top.length ? `<p class="muted small">Top xG: ${top.map((t) => `${esc(t.name)} ${t.I_F_xGoals.toFixed(1)}`).join(' &middot; ')}</p>` : ''}</section>` : `<section class="card">${status('mp:teams') || '<p class="muted">No MoneyPuck row for this team yet.</p>'}</section>`;
  }
  if (get('espn:injuries') === undefined && !store.get('espn:injuries')?.asked) { store.set('espn:injuries', { asked: true }); bridge.request('data.get', { key: 'espn:injuries', cacheOnly: true }).catch(() => {}); }
  const inj = injuryList().filter((i) => i.k === k);
  const injCard = inj.length ? `<section class="card wide"><h2>Injuries <span class="muted small">ESPN, saved ${esc(ago(store.get('espn:injuries')?.at))}</span></h2>${injTable(inj, false)}</section>` : '';
  return head + schedule + mp + injCard + skaters;
};


// ------------------------------------------------------------------ player page
views.player = (id) => {
  const lk = `player:${id}`, gk = `plog:${id}`;
  routeKeys = [lk, gk];
  want(lk); want(gk);
  const L = get(lk), G = get(gk);
  if (!L) return status(lk) || '<div class="note">Loading...</div>';
  const isG = L.position === 'G';
  if (state.settings.moneypuck) { const mk = isG ? 'mp:goalies' : 'mp:skaters'; routeKeys.push(mk); want(mk); }
  const team = L.currentTeamAbbrev;
  const age = L.birthDate ? Math.floor((Date.now() - new Date(L.birthDate + 'T12:00:00')) / 31557600000) : '';
  const ht = L.heightInInches ? `${Math.floor(L.heightInInches / 12)}'${L.heightInInches % 12}" (${L.heightInCentimeters} cm)` : '';
  const dr = L.draftDetails ? `${L.draftDetails.year} round ${L.draftDetails.round}, #${L.draftDetails.overallPick} overall by ${L.draftDetails.teamAbbrev}` : 'Undrafted';
  const born = [nm(L.birthCity), nm(L.birthStateProvince), L.birthCountry].filter(Boolean).join(', ');
  const bio = [[isG ? 'Catches' : 'Shoots', L.shootsCatches], ['Age', age], ['Height', ht], ['Weight', L.weightInPounds ? `${L.weightInPounds} lb (${L.weightInKilograms} kg)` : ''], ['Born', `${L.birthDate || ''}${born ? ' · ' + born : ''}`], ['Draft', dr]]
    .filter(([, v]) => v).map(([k, v]) => `<div><small>${k}</small><span>${esc(v)}</span></div>`).join('');
  const head = `<section class="card thead" style="--tc:${teamColor(team)}">${team ? `<a href="#/team/${team}">${logo(team, 'blogo')}</a>` : ''}
      <div><div class="big2">${esc(nm(L.firstName))} ${esc(nm(L.lastName))} <span class="muted">#${L.sweaterNumber ?? ''}</span></div>
      <div class="muted">${esc({ C: 'Centre', L: 'Left wing', R: 'Right wing', D: 'Defence', G: 'Goalie' }[L.position] || L.position)}${team ? ` &middot; <a class="tlink" href="#/team/${team}">${esc(nm(L.fullTeamName) || team)}</a>` : L.isActive ? '' : ' &middot; Not active'}</div>
      <div class="bio">${bio}</div></div><button class="btn cmpbtn" type="button" data-cmp="player:${id}" title="Compare with another player">Compare</button></section>`;

  const fs = L.featuredStats?.regularSeason;
  const ss = fs?.subSeason, cr = fs?.career;
  const p3 = (v) => (v == null ? '' : v.toFixed(3).replace(/^0/, ''));
  const kp = (pairs) => `<div class="kpis">${pairs.map(([l, v]) => `<div><b>${v ?? '-'}</b><small>${l}</small></div>`).join('')}</div>`;
  const season = ss ? (isG
    ? kp([['GP', ss.gamesPlayed], ['W-L-OT', `${ss.wins}-${ss.losses}-${ss.otLosses}`], ['GAA', ss.goalsAgainstAvg?.toFixed(2)], ['SV%', p3(ss.savePctg)], ['SO', ss.shutouts]])
    : kp([['GP', ss.gamesPlayed], ['G', ss.goals], ['A', ss.assists], ['P', ss.points], ['+/-', (ss.plusMinus > 0 ? '+' : '') + ss.plusMinus], ['PPP', ss.powerPlayPoints], ['SOG', ss.shots], ['S%', ss.shootingPctg != null ? (ss.shootingPctg * 100).toFixed(1) : null]]))
    : '<p class="muted">No games this season yet.</p>';

  let mp = '';
  if (state.settings.moneypuck) {
    const rows = get(isG ? 'mp:goalies' : 'mp:skaters') || [];
    const a = rows.find((r) => String(r.playerId) === String(id) && r.situation === 'all');
    if (a) mp = isG
      ? `<h3 class="sub">Advanced <span class="muted small">MoneyPuck.com</span></h3>${kp([['GSAx', ((a.xGoals - a.goals) > 0 ? '+' : '') + (a.xGoals - a.goals).toFixed(2)], ['xGA', a.xGoals.toFixed(2)], ['GA', a.goals], ['HD shots', a.highDangerShots], ['HD goals', a.highDangerGoals]])}`
      : `<h3 class="sub">Advanced <span class="muted small">MoneyPuck.com</span></h3>${kp([['xG', a.I_F_xGoals.toFixed(2)], ['G-xG', ((a.I_F_goals - a.I_F_xGoals) > 0 ? '+' : '') + (a.I_F_goals - a.I_F_xGoals).toFixed(2)], ['On-ice xGF%', (a.onIce_xGoalsPercentage * 100).toFixed(1) + '%'], ['HD shots', a.I_F_highDangerShots], ['Game score', a.gameScore?.toFixed(1)]])}`;
  }

  const log = G?.gameLog || [];
  const logTbl = !G ? status(gk) : !log.length ? '<p class="muted">No games this season yet.</p>' : `<div class="tscroll"><table class="tbl"><thead><tr><th class="l">Date</th><th class="l">Opponent</th>${isG
      ? '<th>Dec</th><th>SA</th><th>GA</th><th>SV%</th><th>TOI</th>'
      : '<th>G</th><th>A</th><th>P</th><th>+/-</th><th>PPP</th><th>SOG</th><th>PIM</th><th>Shifts</th><th>TOI</th>'}</tr></thead><tbody>
    ${log.map((g) => `<tr><td class="l"><a class="tlink" href="#/game/${g.gameId}">${esc(new Date(g.gameDate + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }))}</a></td><td class="l">${g.homeRoadFlag === 'H' ? 'vs' : '@'} ${logo(g.opponentAbbrev, 'slogo')} ${esc(g.opponentAbbrev)}</td>${isG
      ? `<td>${esc(g.decision === 'O' ? 'OTL' : g.decision || '')}</td><td>${g.shotsAgainst}</td><td>${g.goalsAgainst}</td><td>${p3(g.savePctg)}</td><td>${esc(g.toi)}</td>`
      : `<td>${g.goals}</td><td>${g.assists}</td><td><b>${g.points}</b></td><td>${g.plusMinus > 0 ? '+' : ''}${g.plusMinus}</td><td>${g.powerPlayPoints}</td><td>${g.shots}</td><td>${g.pim}</td><td>${g.shifts}</td><td>${esc(g.toi)}</td>`}</tr>`).join('')}</tbody></table></div>`;

  const nhl = (L.seasonTotals || []).filter((t) => t.leagueAbbrev === 'NHL' && t.gameTypeId === 2);
  const yr = (s) => `${String(s).slice(0, 4)}-${String(s).slice(6)}`;
  const car = L.careerTotals?.regularSeason;
  const career = !nhl.length ? '<p class="muted">No NHL seasons yet.</p>' : `<div class="tscroll"><table class="tbl"><thead><tr><th class="l">Season</th><th class="l">Team</th>${isG
      ? '<th>GP</th><th>W</th><th>L</th><th>OTL</th><th>GAA</th><th>SV%</th><th>SO</th>'
      : '<th>GP</th><th>G</th><th>A</th><th>P</th><th>+/-</th><th>PPG</th><th>SOG</th><th>S%</th><th>TOI</th>'}</tr></thead><tbody>
    ${nhl.slice().reverse().map((t) => `<tr><td class="l">${yr(t.season)}</td><td class="l">${esc(nm(t.teamCommonName) || nm(t.teamName))}</td>${isG
      ? `<td>${t.gamesPlayed}</td><td>${t.wins ?? ''}</td><td>${t.losses ?? ''}</td><td>${t.otLosses ?? ''}</td><td>${t.goalsAgainstAvg?.toFixed(2) ?? ''}</td><td>${p3(t.savePctg)}</td><td>${t.shutouts ?? ''}</td>`
      : `<td>${t.gamesPlayed}</td><td>${t.goals}</td><td>${t.assists}</td><td><b>${t.points}</b></td><td>${t.plusMinus > 0 ? '+' : ''}${t.plusMinus ?? ''}</td><td>${t.powerPlayGoals ?? ''}</td><td>${t.shots ?? ''}</td><td>${t.shootingPctg != null ? (t.shootingPctg * 100).toFixed(1) : ''}</td><td>${esc(t.avgToi || '')}</td>`}</tr>`).join('')}
    ${car ? `<tr class="tot"><td class="l">Career</td><td></td>${isG
      ? `<td>${car.gamesPlayed}</td><td>${car.wins}</td><td>${car.losses}</td><td>${car.otLosses}</td><td>${car.goalsAgainstAvg?.toFixed(2)}</td><td>${p3(car.savePctg)}</td><td>${car.shutouts}</td>`
      : `<td>${car.gamesPlayed}</td><td>${car.goals}</td><td>${car.assists}</td><td><b>${car.points}</b></td><td>${car.plusMinus > 0 ? '+' : ''}${car.plusMinus}</td><td>${car.powerPlayGoals}</td><td>${car.shots}</td><td>${car.shootingPctg != null ? (car.shootingPctg * 100).toFixed(1) : ''}</td><td>${esc(car.avgToi || '')}</td>`}</tr>` : ''}</tbody></table></div>`;

  return head + `<section class="card wide"><h2>This season</h2>${season}${mp}</section>
    <section class="card wide"><h2>Game log</h2>${logTbl}</section>
    <section class="card wide"><h2>NHL career <span class="muted small">regular season</span></h2>${career}</section>`;
};


// ------------------------------------------------------------------ season: saved weeks, week bar, sync
const season = { weeks: [], loaded: false, sync: null };   // weeks: [{ monday, cached }]
async function loadSeason() {
  try { season.weeks = await bridge.request('season.weeks'); } catch { season.weeks = []; }
  season.loaded = true;
  for (const w of season.weeks) if (w.cached && get(`week:${w.monday}`) === undefined) bridge.request('data.get', { key: `week:${w.monday}`, cacheOnly: true }).catch(() => {});
  render();
}
// All saved games of the season (regular season and playoffs), newest last.
function seasonGames() {
  const out = [];
  for (const w of season.weeks) for (const d of get(`week:${w.monday}`)?.gameWeek || []) for (const g of d.games || []) if (g.gameType >= 2) out.push({ ...g, date: d.date });
  return out;
}
// Week numbers count from the first week that has a regular-season game.
function weekList() {
  const list = []; let n = 0;
  for (const w of season.weeks) {
    const b = get(`week:${w.monday}`);
    if (!b) continue;
    const games = (b.gameWeek || []).flatMap((d) => d.games || []).filter((g) => g.gameType >= 2);
    if (!games.length && !n) continue;
    n++; list.push({ n, monday: w.monday, games: games.length });
  }
  return list;
}
function renderWeekBar(activeN) {
  const el = $('weekbar');
  const weeks = weekList();
  const s = season.sync;
  el.innerHTML = `<span class="weekbar-label">Season</span>
    <button class="btn small-btn" type="button" id="btn-sync"${s?.running || state.halted ? ' disabled' : ''}>${s?.running ? `Syncing ${s.pct}%` : weeks.length ? 'Sync season' : 'Sync the season'}</button>
    ${weeks.map((w) => `<a class="weeklink${w.n === activeN ? ' active' : ''}" href="#/week/${w.n}" title="${esc(weekRange(w.monday))}">Week ${w.n}</a>`).join('')}
    ${!weeks.length && season.loaded ? '<span class="muted small">Sync once to unlock week pages, power rankings, rookies and the East-West report.</span>' : ''}`;
}
function weekRange(monday) {
  const a = new Date(monday + 'T12:00:00'), b = new Date(a); b.setDate(b.getDate() + 6);
  const f = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${f(a)} - ${f(b)}`;
}
async function runSync() {
  const total = season.weeks.length;
  const cached = season.weeks.filter((w) => w.cached).length;
  if (!syncAck()) {
    const ok = await confirmDialog('Sync the season?', `<p>NHLDash will download the NHL schedule and results one week at a time, about ${Math.max(2, total - cached + 3)} requests now. Weeks already saved are not downloaded again, so later syncs are only a few requests.</p><p class="muted">It runs in the background, keeps going if you switch tabs, and the pause button stops it.</p>`);
    if (!ok) return;
    try { localStorage.setItem('syncAck', '1'); } catch { }
  }
  try { const r = await bridge.request('sync.run'); if (r && r.started) { season.sync = { running: true, pct: 0 }; render(); } }
  catch (e) { alertNote(e.message); }
}
const syncAck = () => { try { return localStorage.getItem('syncAck') === '1'; } catch { return false; } };
document.addEventListener('click', (e) => { if (e.target.id === 'btn-sync') runSync(); });
bridge.on('sync', async (d) => {
  season.sync = d;
  if (!d.running) {
    season.sync = null;
    if (!d.cancelled) { alertNote('Season sync finished.'); await loadSeason(); return; }
  }
  render();
});

views.week = (n) => {
  n = Number(n);
  const w = weekList().find((x) => x.n === n);
  routeKeys = w ? [`week:${w.monday}`] : [];
  if (!w) return '<div class="note">That week is not saved yet. Press <b>Sync season</b> in the bar above.</div>';
  const b = get(`week:${w.monday}`);
  const days = (b.gameWeek || []).filter((d) => (d.games || []).some((g) => g.gameType >= 2));
  // Team records for the week.
  const rec = {};
  for (const d of days) for (const g of d.games) {
    if (g.gameType < 2 || !isFinal(g)) continue;
    const ot = ['OT', 'SO'].includes(g.gameOutcome?.lastPeriodType);
    for (const [me, op] of [[g.awayTeam, g.homeTeam], [g.homeTeam, g.awayTeam]]) {
      const r = (rec[me.abbrev] ||= { w: 0, l: 0, o: 0, gf: 0, ga: 0 });
      r.gf += me.score; r.ga += op.score;
      if (me.score > op.score) r.w++; else if (ot) r.o++; else r.l++;
    }
  }
  const table = Object.entries(rec).sort((a, b) => (b[1].w * 2 + b[1].o) - (a[1].w * 2 + a[1].o) || (b[1].gf - b[1].ga) - (a[1].gf - a[1].ga));
  const gameRow = (g) => {
    const fin = isFinal(g), aw = fin && g.awayTeam.score > g.homeTeam.score;
    return `<a class="sline" href="#/game/${g.id}">${logo(g.awayTeam.abbrev, 'slogo')}<span class="${fin && aw ? 'b' : ''}">${esc(g.awayTeam.abbrev)} ${fin ? g.awayTeam.score : ''}</span><span class="muted">@</span>${logo(g.homeTeam.abbrev, 'slogo')}<span class="${fin && !aw ? 'b' : ''}">${esc(g.homeTeam.abbrev)} ${fin ? g.homeTeam.score : ''}</span><span class="sres muted">${esc(gameStatus(g))}</span></a>`;
  };
  return `<div class="datebar"><a class="btn sq" href="#/week/${n - 1}" aria-label="Previous week"${n <= 1 ? ' hidden' : ''}>&lsaquo;</a><strong>Week ${n} &middot; ${esc(weekRange(w.monday))}</strong><a class="btn sq" href="#/week/${n + 1}" aria-label="Next week"${weekList().some((x) => x.n === n + 1) ? '' : ' hidden'}>&rsaquo;</a></div>
    <div class="grid two"><section class="card"><h2>Games</h2>${days.map((d) => `<h3 class="sub">${esc(niceDate(d.date))}</h3>${d.games.filter((g) => g.gameType >= 2).map(gameRow).join('')}`).join('') || '<p class="muted">No games.</p>'}</section>
      <section class="card"><h2>Team records this week</h2>${table.length ? `<table class="tbl"><thead><tr><th class="l">Team</th><th>W</th><th>L</th><th>OTL</th><th>GF</th><th>GA</th></tr></thead><tbody>${table.map(([k, r]) => `<tr class="${favs().has(k) ? 'fav' : ''}"><td class="l"><a class="tlink" href="#/team/${k}">${logo(k, 'slogo')} ${esc(TEAMS[k] || k)}</a></td><td>${r.w}</td><td>${r.l}</td><td>${r.o}</td><td>${r.gf}</td><td>${r.ga}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No finished games yet.</p>'}</section></div>`;
};

// ------------------------------------------------------------------ traffic details (NBADash's hidden counter page)
let trafficData = null;
views.traffic = () => {
  routeKeys = [];
  bridge.request('traffic.get').then((t) => { const first = !trafficData; trafficData = t; if (first && parseRoute().view === 'traffic') render(); }).catch(() => {});
  const t = trafficData;
  if (!t) return '<div class="note">Loading...</div>';
  const mb = (b) => (b / 1048576).toFixed(2) + ' MB';
  const up = `${Math.floor(t.uptimeSec / 3600)}h ${Math.floor((t.uptimeSec % 3600) / 60)}m`;
  const hosts = Object.entries(t.byHost || {});
  return `<section class="card wide"><h2>Data traffic this session</h2><div class="kpis"><div><b>${t.requests}</b><small>requests</small></div><div><b>${mb(t.bytes)}</b><small>downloaded</small></div><div><b>${t.errors}</b><small>errors</small></div><div><b>${up}</b><small>open for</small></div></div>
      <p class="muted small">Counted by NHLDash itself, the same numbers DashLauncher shows. Update checks to GitHub are not counted.</p></section>
    <section class="card wide"><h2>By server</h2>${hosts.length ? `<table class="tbl"><thead><tr><th class="l">Server</th><th>Requests</th><th>Downloaded</th><th>Errors</th></tr></thead><tbody>${hosts.map(([h, v]) => `<tr><td class="l">${esc(h)}</td><td>${v.requests}</td><td>${mb(v.bytes)}</td><td>${v.errors}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing downloaded yet this session.</p>'}</section>
    <section class="card wide"><h2>Last requests</h2>${(t.last || []).length ? `<div class="tscroll"><table class="tbl"><thead><tr><th class="l">Time</th><th class="l">What</th><th class="l">Server</th><th>Size</th><th>Time taken</th><th>Result</th></tr></thead><tbody>${t.last.map((r) => `<tr><td class="l">${esc(new Date(r.at).toLocaleTimeString())}</td><td class="l">${esc(r.key)}</td><td class="l">${esc(r.host)}</td><td>${(r.bytes / 1024).toFixed(1)} KB</td><td>${r.ms} ms</td><td>${r.ok ? 'OK' : '<span class="upd-err">failed</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">None yet.</p>'}</section>`;
};


// ------------------------------------------------------------------ league pages built from the saved season
// Records from saved games. upTo (YYYY-MM-DD, exclusive) lets rankings compare with a week ago.
function teamRecords(upTo) {
  const rec = {};
  const games = seasonGames().filter((g) => g.gameType === 2 && isFinal(g) && (!upTo || g.date < upTo)).sort((a, b) => a.date.localeCompare(b.date));
  for (const g of games) {
    const ot = ['OT', 'SO'].includes(g.gameOutcome?.lastPeriodType);
    for (const [me, op] of [[g.awayTeam, g.homeTeam], [g.homeTeam, g.awayTeam]]) {
      const r = (rec[me.abbrev] ||= { gp: 0, w: 0, l: 0, o: 0, gf: 0, ga: 0, res: [], opps: [] });
      r.gp++; r.gf += me.score; r.ga += op.score; r.opps.push(op.abbrev);
      const p = me.score > op.score ? 2 : ot ? 1 : 0;
      if (p === 2) r.w++; else if (p === 1) r.o++; else r.l++;
      r.res.push(p);
    }
  }
  for (const r of Object.values(rec)) {
    r.pct = r.gp ? (2 * r.w + r.o) / (2 * r.gp) : 0;
    const l10 = r.res.slice(-10); r.l10 = l10.length ? l10.reduce((a, b) => a + b, 0) / (2 * l10.length) : 0;
    r.gdpg = r.gp ? (r.gf - r.ga) / r.gp : 0;
  }
  for (const r of Object.values(rec)) r.sos = r.opps.length ? r.opps.reduce((a, k) => a + (rec[k]?.pct || 0), 0) / r.opps.length : 0;
  return rec;
}
const FORMULA = 'Score = 45% points % + 25% goal difference per game (scaled from -2 to +2) + 15% points % in the last 10 games + 15% strength of schedule (average opponent points %), or + 15% expected-goals share (xGF%) when MoneyPuck is on.';
function powerScores(rec, xg) {
  const out = [];
  for (const [k, r] of Object.entries(rec)) {
    const gd = Math.max(0, Math.min(1, (r.gdpg + 2) / 4));
    const last = xg && xg[k] != null ? xg[k] : r.sos;
    out.push({ k, r, score: 100 * (0.45 * r.pct + 0.25 * gd + 0.15 * r.l10 + 0.15 * last) });
  }
  return out.sort((a, b) => b.score - a.score);
}
function lastMonday() { const d = new Date(); d.setHours(12); while (d.getDay() !== 1) d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }
const needSync = (what) => `<section class="card narrow"><h2>${what}</h2><p>This page is built from the saved season, so it needs one season sync first.</p><p><button class="btn primary" type="button" id="btn-sync">Sync the season</button></p></section>`;

views.rankings = () => {
  routeKeys = [];
  if (!weekList().length) return needSync('Power rankings');
  let xg = null;
  if (state.settings.moneypuck) { routeKeys = ['mp:teams']; want('mp:teams'); xg = {}; for (const r of get('mp:teams') || []) if (r.situation === 'all') xg[r.team] = r.xGoalsPercentage; if (!Object.keys(xg).length) xg = null; }
  const now = powerScores(teamRecords(), xg);
  const before = powerScores(teamRecords(lastMonday()), null);
  const prevRank = Object.fromEntries(before.map((x, i) => [x.k, i + 1]));
  const fav = favs();
  return `<div class="segs bar1"><span class="muted small">Built from ${seasonGames().filter((g) => g.gameType === 2 && isFinal(g)).length} saved games. <span class="hint" title="${esc(FORMULA)}">How the score works</span></span><a class="btn push" href="#/eastwest">East-West report</a></div>
    <section class="card wide"><h2>Power rankings</h2><div class="tscroll"><table class="tbl"><thead><tr><th>#</th><th>Move</th><th class="l">Team</th><th>Score</th><th>Record</th><th>P%</th><th>GD/GP</th><th>Last 10</th><th>${xg ? 'xGF%' : 'SOS'}</th></tr></thead><tbody>
    ${now.map((x, i) => {
      const was = prevRank[x.k], mv = was ? was - (i + 1) : 0;
      const r = x.r;
      return `<tr class="${fav.has(x.k) ? 'fav' : ''}"><td><b>${i + 1}</b></td><td class="${mv > 0 ? 'up' : mv < 0 ? 'down' : 'muted'}">${mv > 0 ? '&#9650;' + mv : mv < 0 ? '&#9660;' + -mv : '-'}</td><td class="l"><a class="tlink" href="#/team/${x.k}">${logo(x.k, 'slogo')} ${esc(TEAMS[x.k] || x.k)}</a></td><td><b>${x.score.toFixed(1)}</b></td><td>${r.w}-${r.l}-${r.o}</td><td>${r.pct.toFixed(3).replace(/^0/, '')}</td><td>${r.gdpg > 0 ? '+' : ''}${r.gdpg.toFixed(2)}</td><td>${(r.l10 * 100).toFixed(0)}%</td><td>${xg ? ((xg[x.k] ?? 0) * 100).toFixed(1) + '%' : r.sos.toFixed(3).replace(/^0/, '')}</td></tr>`;
    }).join('')}</tbody></table></div><p class="muted small">Move compares with the rankings before this Monday. ${esc(FORMULA)}</p></section>`;
};

const ROOKIE_SCORE = 'Rookie score = 10 x (goals + 0.7 x assists + 0.1 x shots on goal + 0.1 x plus/minus) per game, so a point-a-game rookie lands near 10.';
let rookieSort = 'score';
views.rookies = () => {
  routeKeys = ['rookies'];
  want('rookies');
  const d = get('rookies');
  if (!d) return status('rookies') || '<div class="note">Loading...</div>';
  const rows = (d.data || []).map((r) => ({ ...r, score: r.gamesPlayed ? 10 * (r.goals + 0.7 * r.assists + 0.1 * r.shots + 0.1 * r.plusMinus) / r.gamesPlayed : 0 }));
  const minGp = 3;
  rows.sort((a, b) => (b[rookieSort] ?? 0) - (a[rookieSort] ?? 0));
  const shown = rows.filter((r) => r.gamesPlayed >= minGp);
  const th = (k, l) => `<th class="sortable${rookieSort === k ? ' sorted' : ''}" data-rk="${k}">${l}${rookieSort === k ? ' &darr;' : ''}</th>`;
  const toiAvg = (sec) => (sec ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '');
  return `<section class="card wide"><h2>Rookie watch <span class="muted small">skaters with ${minGp}+ games &middot; <span class="hint" title="${esc(ROOKIE_SCORE)}">rookie score</span></span></h2><div class="tscroll"><table class="tbl"><thead><tr><th>#</th><th class="l">Rookie</th><th>Team</th><th>Pos</th>${th('gamesPlayed', 'GP')}${th('goals', 'G')}${th('assists', 'A')}${th('points', 'P')}${th('plusMinus', '+/-')}${th('ppPoints', 'PPP')}${th('shots', 'SOG')}${th('timeOnIcePerGame', 'TOI/GP')}${th('score', 'Rookie score')}</tr></thead><tbody>
    ${shown.map((r, i) => `<tr class="${favs().has(r.teamAbbrevs) ? 'fav' : ''}"><td>${i + 1}</td><td class="l">${plink(r.playerId, esc(r.skaterFullName))}</td><td>${esc(r.teamAbbrevs)}</td><td>${esc(r.positionCode)}</td><td>${r.gamesPlayed}</td><td>${r.goals}</td><td>${r.assists}</td><td><b>${r.points}</b></td><td>${r.plusMinus > 0 ? '+' : ''}${r.plusMinus}</td><td>${r.ppPoints}</td><td>${r.shots}</td><td>${toiAvg(r.timeOnIcePerGame)}</td><td><b>${r.score.toFixed(1)}</b></td></tr>`).join('') || '<tr><td colspan="13" class="muted l">No rookies with enough games yet.</td></tr>'}</tbody></table></div><p class="muted small">${esc(ROOKIE_SCORE)} Rookie list from the NHL stats API.</p></section>`;
};
document.addEventListener('click', (e) => { const h = e.target.closest('[data-rk]'); if (h) { rookieSort = h.dataset.rk; render(); } });

views.eastwest = () => {
  routeKeys = ['standings'];
  want('standings');
  if (!weekList().length) return needSync('East-West report');
  const st = get('standings');
  if (!st) return status('standings') || '<div class="note">Loading...</div>';
  const conf = {}, div = {};
  for (const t of st.standings || []) { const k = nm(t.teamAbbrev); conf[k] = t.conferenceName; div[k] = t.divisionName; }
  const games = seasonGames().filter((g) => g.gameType === 2 && isFinal(g) && conf[g.awayTeam.abbrev] && conf[g.homeTeam.abbrev] && conf[g.awayTeam.abbrev] !== conf[g.homeTeam.abbrev]);
  const side = { Eastern: { w: 0, l: 0, o: 0, gf: 0 }, Western: { w: 0, l: 0, o: 0, gf: 0 } };
  const team = {}, dv = {};
  for (const g of games) {
    const ot = ['OT', 'SO'].includes(g.gameOutcome?.lastPeriodType);
    for (const [me, op] of [[g.awayTeam, g.homeTeam], [g.homeTeam, g.awayTeam]]) {
      const c = conf[me.abbrev], won = me.score > op.score;
      const add = (r) => { r.gf += me.score; if (won) r.w++; else if (ot) r.o++; else r.l++; };
      add(side[c]);
      add(team[me.abbrev] ||= { w: 0, l: 0, o: 0, gf: 0 });
      add((dv[div[me.abbrev]] ||= {})[div[op.abbrev]] ||= { w: 0, l: 0, o: 0, gf: 0 });
    }
  }
  const pct = (r) => { const gp = r.w + r.l + r.o; return gp ? ((2 * r.w + r.o) / (2 * gp)).toFixed(3).replace(/^0/, '') : '-'; };
  const rec = (r) => (r ? `${r.w}-${r.l}-${r.o}` : '-');
  const E = side.Eastern, W = side.Western;
  const lead = E.w === W.w ? 'Level so far' : E.w > W.w ? 'The East leads' : 'The West leads';
  const eastDiv = ['Atlantic', 'Metropolitan'], westDiv = ['Central', 'Pacific'];
  const teams = Object.entries(team).sort((a, b) => pct(b[1]) - pct(a[1]) || b[1].w - a[1].w);
  return `<section class="card wide"><h2>East-West report <span class="muted small">${games.length} games between the conferences</span></h2>
      <div class="kpis"><div><b>${rec(E)}</b><small>East vs West</small></div><div><b>${rec(W)}</b><small>West vs East</small></div><div><b>${E.gf}-${W.gf}</b><small>goals East-West</small></div><div><b>${esc(lead)}</b><small>by wins</small></div></div></section>
    <div class="grid two"><section class="card"><h2>Division vs division</h2><table class="tbl"><thead><tr><th class="l">East division</th>${westDiv.map((d) => `<th>vs ${d}</th>`).join('')}</tr></thead><tbody>
      ${eastDiv.map((d) => `<tr><td class="l">${d}</td>${westDiv.map((w) => `<td>${rec(dv[d]?.[w])}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <p class="muted small">Records are the East division's, as W-L-OTL.</p></section>
      <section class="card"><h2>Teams against the other conference</h2><table class="tbl"><thead><tr><th class="l">Team</th><th>Conf</th><th>Record</th><th>P%</th></tr></thead><tbody>
      ${teams.map(([k, r]) => `<tr class="${favs().has(k) ? 'fav' : ''}"><td class="l"><a class="tlink" href="#/team/${k}">${logo(k, 'slogo')} ${esc(TEAMS[k] || k)}</a></td><td>${conf[k] === 'Eastern' ? 'E' : 'W'}</td><td>${rec(r)}</td><td>${pct(r)}</td></tr>`).join('')}</tbody></table></section></div>`;
};

// ------------------------------------------------------------------ compare (two teams or two players)
let cmp = (() => { try { return JSON.parse(localStorage.getItem('cmp')) || { type: '', ids: [] }; } catch { return { type: '', ids: [] }; } })();
function saveCmp() { try { localStorage.setItem('cmp', JSON.stringify(cmp)); } catch { } renderCmpBar(); }
function addCmp(type, id) {
  if (cmp.type !== type) cmp = { type, ids: [] };
  if (!cmp.ids.includes(id)) cmp.ids = [...cmp.ids, id].slice(-2);
  saveCmp();
  if (cmp.ids.length === 2) location.hash = `#/compare/${type}/${cmp.ids[0]}/${cmp.ids[1]}`;
}
function cmpName(type, id) {
  if (type === 'team') return TEAMS[id] || id;
  const L = get(`player:${id}`);
  return L ? `${nm(L.firstName)} ${nm(L.lastName)}` : `Player ${id}`;
}
function renderCmpBar() {
  const el = $('cmpbar');
  el.hidden = !cmp.ids.length || parseRoute().view === 'compare';
  if (el.hidden) return;
  el.innerHTML = `<span class="muted small">Compare:</span>${cmp.ids.map((id) => `<span class="favchip">${esc(cmpName(cmp.type, id))} <button type="button" class="xbtn" data-cmpx="${id}" aria-label="Remove">&times;</button></span>`).join('')}
    <span class="muted small">${cmp.ids.length < 2 ? `pick one more ${cmp.type}` : ''}</span><button type="button" class="xbtn" data-cmpx="*" title="Clear">Clear</button>`;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-cmp]');
  if (a) { const [t, id] = a.dataset.cmp.split(':'); addCmp(t, id); return; }
  const x = e.target.closest('[data-cmpx]');
  if (x) { cmp.ids = x.dataset.cmpx === '*' ? [] : cmp.ids.filter((i) => i !== x.dataset.cmpx); saveCmp(); }
});
views.compare = (arg) => {
  const [type, a, b] = arg.split('/');
  const bar = (l, va, vb, fmt = (v) => v, lowBetter = false) => {
    const na = Number(va) || 0, nb = Number(vb) || 0, tot = Math.abs(na) + Math.abs(nb) || 1;
    const aw = lowBetter ? na < nb : na > nb, bw = lowBetter ? nb < na : nb > na;
    return `<div class="cmprow"><span class="${aw ? 'b' : ''}">${va == null ? '-' : fmt(va)}</span><div class="cmpmid"><small>${l}</small><div class="cmpbars"><i style="width:${(Math.abs(na) / tot) * 100}%" class="${aw ? 'win' : ''}"></i><i style="width:${(Math.abs(nb) / tot) * 100}%" class="${bw ? 'win' : ''}"></i></div></div><span class="${bw ? 'b' : ''}">${vb == null ? '-' : fmt(vb)}</span></div>`;
  };
  const p3 = (v) => Number(v).toFixed(3).replace(/^0/, '');
  if (type === 'team') {
    routeKeys = ['standings']; want('standings');
    const st = get('standings');
    if (!st) return status('standings') || '<div class="note">Loading...</div>';
    const T = (k) => (st.standings || []).find((t) => nm(t.teamAbbrev) === k) || {};
    const A = T(a), B = T(b);
    const mp = {}; if (state.settings.moneypuck) { routeKeys.push('mp:teams'); want('mp:teams'); for (const r of get('mp:teams') || []) if (r.situation === 'all') mp[r.team] = r; }
    const h2h = seasonGames().filter((g) => isFinal(g) && g.gameType >= 2 && [g.awayTeam.abbrev, g.homeTeam.abbrev].sort().join() === [a, b].sort().join());
    const rows = [bar('Points', A.points, B.points), bar('Points %', A.pointPctg, B.pointPctg, p3), bar('Wins', A.wins, B.wins), bar('Regulation wins', A.regulationWins, B.regulationWins), bar('Goals for', A.goalFor, B.goalFor), bar('Goals against', A.goalAgainst, B.goalAgainst, (v) => v, true), bar('Goal difference', A.goalDifferential, B.goalDifferential), bar('Last 10 wins', A.l10Wins, B.l10Wins)];
    if (mp[a] && mp[b]) rows.push(bar('xGF% (MoneyPuck)', mp[a].xGoalsPercentage, mp[b].xGoalsPercentage, (v) => (v * 100).toFixed(1) + '%'), bar('CF% (MoneyPuck)', mp[a].corsiPercentage, mp[b].corsiPercentage, (v) => (v * 100).toFixed(1) + '%'));
    return `<section class="card cmp"><div class="cmphead"><a href="#/team/${a}">${logo(a, 'blogo')}<b>${esc(TEAMS[a] || a)}</b></a><span class="muted">vs</span><a href="#/team/${b}">${logo(b, 'blogo')}<b>${esc(TEAMS[b] || b)}</b></a></div>${rows.join('')}
      <h3 class="sub">Head to head this season</h3>${h2h.length ? h2h.map((g) => `<a class="sline" href="#/game/${g.id}"><span class="sdate">${esc(new Date(g.date + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span><span>${esc(g.awayTeam.abbrev)} ${g.awayTeam.score} @ ${esc(g.homeTeam.abbrev)} ${g.homeTeam.score}</span><span class="sres muted">${esc(gameStatus(g))}</span></a>`).join('') : `<p class="muted">${weekList().length ? 'No meetings yet.' : 'Sync the season to see their meetings.'}</p>`}</section>`;
  }
  routeKeys = [`player:${a}`, `player:${b}`]; routeKeys.forEach((k) => want(k));
  const A = get(`player:${a}`), B = get(`player:${b}`);
  if (!A || !B) return status(`player:${a}`) || status(`player:${b}`) || '<div class="note">Loading...</div>';
  const sa = A.featuredStats?.regularSeason?.subSeason || {}, sb = B.featuredStats?.regularSeason?.subSeason || {};
  const ca = A.careerTotals?.regularSeason || {}, cb = B.careerTotals?.regularSeason || {};
  const goalie = A.position === 'G' && B.position === 'G';
  const head = `<div class="cmphead">${[[a, A], [b, B]].map(([id, P]) => `<a href="#/player/${id}">${logo(P.currentTeamAbbrev, 'blogo')}<b>${esc(nm(P.firstName))} ${esc(nm(P.lastName))}</b><small class="muted">${esc(P.position)} &middot; ${esc(P.currentTeamAbbrev || '')}</small></a>`).join('<span class="muted">vs</span>')}</div>`;
  const rows = goalie
    ? [bar('Games', sa.gamesPlayed, sb.gamesPlayed), bar('Wins', sa.wins, sb.wins), bar('Save %', sa.savePctg, sb.savePctg, p3), bar('Goals against avg.', sa.goalsAgainstAvg, sb.goalsAgainstAvg, (v) => Number(v).toFixed(2), true), bar('Shutouts', sa.shutouts, sb.shutouts), bar('Career wins', ca.wins, cb.wins), bar('Career save %', ca.savePctg, cb.savePctg, p3)]
    : [bar('Games', sa.gamesPlayed, sb.gamesPlayed), bar('Goals', sa.goals, sb.goals), bar('Assists', sa.assists, sb.assists), bar('Points', sa.points, sb.points), bar('Points per game', sa.gamesPlayed ? sa.points / sa.gamesPlayed : 0, sb.gamesPlayed ? sb.points / sb.gamesPlayed : 0, (v) => Number(v).toFixed(2)), bar('Plus/minus', sa.plusMinus, sb.plusMinus), bar('Power-play points', sa.powerPlayPoints, sb.powerPlayPoints), bar('Shots', sa.shots, sb.shots), bar('Career points', ca.points, cb.points), bar('Career goals', ca.goals, cb.goals)];
  return `<section class="card cmp">${head}<h3 class="sub">This season${goalie ? '' : ' and career'}</h3>${rows.join('')}</section>`;
};


// ------------------------------------------------------------------ moves: transactions, injuries, free agents (ESPN, fetched when opened)
const ESPN_ABBR = { LA: 'LAK', SJ: 'SJS', NJ: 'NJD', TB: 'TBL', UTAH: 'UTA', WAS: 'WSH' };
const espnTeam = (t) => ESPN_ABBR[t?.abbreviation] || t?.abbreviation || Object.keys(TEAMS).find((k) => TEAMS[k] === t?.displayName) || '';
const byName = (n) => Object.keys(TEAMS).find((k) => TEAMS[k].normalize('NFD').replace(/[̀-ͯ]/g, '') === String(n).normalize('NFD').replace(/[̀-ͯ]/g, '')) || '';
const movesTabs = (on) => `<div class="segs bar1">${[['transactions', 'Transactions'], ['injuries', 'Injuries'], ['freeagents', 'Free agents']].map(([k, l]) => `<a class="seg${on === k ? ' on' : ''}" href="#/${k}">${l}</a>`).join('')}<span class="muted small push">From ESPN's public NHL feed, downloaded when you open these pages.</span></div>`;
let txFilter = { team: '', q: '' };
let txShow = 60;
document.addEventListener('click', (e) => { if (e.target.id === 'tx-more') { txShow += 120; render(); } });
function moveKind(d) {
  if (/traded|acquired/i.test(d)) return 'Trade';
  if (/waiver/i.test(d)) return 'Waivers';
  if (/injured reserve|long-term injured/i.test(d)) return 'Injury';
  if (/^(signed|agreed)/i.test(d)) return 'Signing';
  if (/released|terminat/i.test(d)) return 'Release';
  if (/recalled|assigned|sent|loaned|reassigned/i.test(d)) return 'Call-up / send-down';
  return 'Other';
}
views.transactions = () => {
  routeKeys = ['espn:transactions']; want('espn:transactions');
  const d = get('espn:transactions');
  if (!d) return movesTabs('transactions') + (status('espn:transactions') || '<div class="note">Loading...</div>');
  const q = txFilter.q.toLowerCase();
  const rows = (d.transactions || []).map((t) => ({ ...t, k: espnTeam(t.team), kind: moveKind(t.description) }))
    .filter((t) => (!txFilter.team || t.k === txFilter.team) && (!q || t.description.toLowerCase().includes(q)));
  return movesTabs('transactions') + `<section class="card wide"><div class="filters"><select id="tx-team"><option value="">All teams</option>${Object.entries(TEAMS).map(([k, v]) => `<option value="${k}"${txFilter.team === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <input id="tx-q" type="search" placeholder="Filter (a name, 'waivers', 'trade')" value="${esc(txFilter.q)}"><span class="muted small">${rows.length} moves</span></div>
    ${rows.slice(0, txShow).map((t) => `<div class="txrow${favs().has(t.k) ? ' fav' : ''}"><span class="sdate">${esc(new Date(t.date).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span>${t.k ? `<a href="#/team/${t.k}">${logo(t.k, 'slogo')}</a>` : ''}<span class="tag">${esc(t.kind)}</span><span class="txd">${esc(t.description)}</span></div>`).join('') || '<p class="muted">No moves match.</p>'}${rows.length > txShow ? `<div class="actions"><button class="btn" type="button" id="tx-more">Show more (${rows.length - txShow} left)</button></div>` : ''}</section>`;
};
document.addEventListener('change', (e) => { if (e.target.id === 'tx-team') { txFilter.team = e.target.value; render(); } });
document.addEventListener('input', (e) => { if (e.target.id === 'tx-q') { txFilter.q = e.target.value; clearTimeout(views._t); views._t = setTimeout(render, 250); } });

function injuryList() {
  const d = get('espn:injuries');
  const out = [];
  for (const t of d?.injuries || []) { const k = byName(t.displayName); for (const i of t.injuries || []) out.push({ k, name: i.athlete?.displayName, pos: i.athlete?.position, status: i.status, date: i.date, comment: (i.shortComment || '').length > 8 ? i.shortComment : '', part: i.details?.type, back: i.details?.returnDate }); }
  return out;
}
const injTable = (list, showTeam) => `<div class="tscroll"><table class="tbl"><thead><tr>${showTeam ? '<th class="l">Team</th>' : ''}<th class="l">Player</th><th>Pos</th><th class="l">Status</th><th class="l">Injury</th><th>Expected back</th><th class="l">Note</th></tr></thead><tbody>
  ${list.map((i) => `<tr class="${favs().has(i.k) ? 'fav' : ''}">${showTeam ? `<td class="l">${i.k ? `<a class="tlink" href="#/team/${i.k}">${logo(i.k, 'slogo')} ${esc(i.k)}</a>` : ''}</td>` : ''}<td class="l"><b>${esc(i.name)}</b></td><td>${esc(i.pos || '')}</td><td class="l"><span class="tag">${esc(i.status || '')}</span></td><td class="l">${esc(i.part || '')}</td><td>${i.back ? esc(new Date(i.back + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })) : ''}</td><td class="l wrap small">${esc(i.comment || '')}</td></tr>`).join('')}</tbody></table></div>`;
views.injuries = () => {
  routeKeys = ['espn:injuries']; want('espn:injuries');
  if (!get('espn:injuries')) return movesTabs('injuries') + (status('espn:injuries') || '<div class="note">Loading...</div>');
  const list = injuryList().sort((a, b) => (favs().has(b.k) - favs().has(a.k)) || a.k.localeCompare(b.k));
  return movesTabs('injuries') + `<section class="card wide"><h2>Injuries <span class="muted small">${list.length} players</span></h2>${injTable(list, true)}</section>`;
};

// Free agents: players the transactions show as released, waived to terminate, or out of a tryout,
// with nothing later (signed, claimed, acquired) under the same name. Approximate, like NBADash's list.
let faWatch = (() => { try { return JSON.parse(localStorage.getItem('faWatch')) || []; } catch { return []; } })();
function freeAgents() {
  const tx = (get('espn:transactions')?.transactions || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const fa = new Map();
  for (const t of tx) {
    const d = t.description;
    for (const part of d.split(/(?<=\.)\s+/)) {
      const release = /^Released\b/.test(part) && !/\bto\b/.test(part);
      const uncond = /unconditional waivers|terminat/i.test(part);
      if (release || uncond) {
        const body = part.replace(/^(Released|Placed|Waived)\s+/, '').replace(/\s+(on unconditional waivers|from (their|his) (professional )?tryout.*|for the purpose.*)\.?$/i, '').replace(/\.$/, '');
        const names = body.replace(/\b(Fs|Ds|Gs|F|D|G|C|LW|RW)\s+/g, '').split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter((x) => /^[A-Z][\w'.-]+(\s+[A-Z][\w'.-]+)+$/.test(x));
        const why = /tryout/i.test(part) ? 'Released from tryout' : uncond ? 'Contract terminated' : 'Released';
        for (const n of names) fa.set(n, { name: n, k: espnTeam(t.team), date: t.date, why });
      }
    }
    for (const n of [...fa.keys()]) if (t.date > fa.get(n).date && d.includes(n) && /(Signed|Claimed|Acquired|Agreed)/.test(d)) fa.delete(n);
  }
  return [...fa.values()].sort((a, b) => b.date.localeCompare(a.date));
}
views.freeagents = () => {
  routeKeys = ['espn:transactions']; want('espn:transactions');
  if (!get('espn:transactions')) return movesTabs('freeagents') + (status('espn:transactions') || '<div class="note">Loading...</div>');
  const list = freeAgents();
  const watched = list.filter((p) => faWatch.includes(p.name));
  const row = (p) => `<tr><td class="l"><button class="star${faWatch.includes(p.name) ? ' on' : ''}" type="button" data-fa="${esc(p.name)}" title="Watch list">${faWatch.includes(p.name) ? '★' : '☆'}</button> <b>${esc(p.name)}</b></td><td class="l">${p.k ? `${logo(p.k, 'slogo')} ${esc(p.k)}` : ''}</td><td class="l">${esc(p.why)}</td><td>${esc(new Date(p.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}</td></tr>`;
  const head = '<thead><tr><th class="l">Player</th><th class="l">Last team</th><th class="l">How</th><th>Date</th></tr></thead>';
  return movesTabs('freeagents') + (watched.length ? `<section class="card wide"><h2>Watch list</h2><table class="tbl">${head}<tbody>${watched.map(row).join('')}</tbody></table></section>` : '') +
    `<section class="card wide"><h2>Free agents <span class="muted small">${list.length} players</span></h2><p class="muted small">Players the transaction log shows as released, waived to end their contract, or let go from a tryout, with no later signing or claim. Built from the log, so it can miss moves the log does not mention.</p><table class="tbl">${head}<tbody>${list.map(row).join('')}</tbody></table></section>`;
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fa]'); if (!b) return;
  const n = b.dataset.fa; faWatch = faWatch.includes(n) ? faWatch.filter((x) => x !== n) : [...faWatch, n];
  try { localStorage.setItem('faWatch', JSON.stringify(faWatch)); } catch { }
  render();
});


// ------------------------------------------------------------------ game flow (from the play-by-play already loaded for the shot map)
function gameFlow(p) {
  const homeId = p.homeTeam.id, A = p.awayTeam.abbrev, H = p.homeTeam.abbrev;
  const secs = (e) => { const n = e.periodDescriptor?.number || 1; const [m, s2] = String(e.timeInPeriod || '0:0').split(':').map(Number); return (n - 1) * 1200 + m * 60 + s2; };
  const plays = (p.plays || []).filter((e) => e.periodDescriptor?.periodType !== 'SO').slice().sort((a, b) => secs(a) - secs(b));
  const attempts = { a: [[0, 0]], h: [[0, 0]] };
  let ca = 0, ch = 0, ga = 0, gh = 0, end = 3600;
  const goals = [];
  let lead = 0, maxLead = { a: 0, h: 0 }, changes = 0, ties = 0, runTeam = '', run = 0, bestRun = { n: 0, t: '' };
  let leadSince = 0, leadTime = { a: 0, h: 0 }, trailBy = { a: 0, h: 0 };
  for (const e of plays) {
    const t = secs(e); end = Math.max(end, t);
    const d = e.details || {};
    const home = d.eventOwnerTeamId === homeId;
    if (['shot-on-goal', 'missed-shot', 'blocked-shot', 'goal'].includes(e.typeDescKey)) {
      // a blocked shot's owner is the blocking team; the attempt belongs to the other side
      const shooterHome = e.typeDescKey === 'blocked-shot' ? !home : home;
      if (shooterHome) attempts.h.push([t, ++ch]); else attempts.a.push([t, ++ca]);
    }
    if (e.typeDescKey !== 'goal') continue;
    const before = lead;
    if (lead > 0) leadTime.h += t - leadSince; else if (lead < 0) leadTime.a += t - leadSince;
    leadSince = t;
    if (home) gh++; else ga++;
    lead = gh - ga;
    if (Math.sign(before) !== 0 && Math.sign(lead) !== 0 && Math.sign(before) !== Math.sign(lead)) changes++;
    if (before !== 0 && lead === 0) ties++;
    if (Math.sign(before) === 0 && lead !== 0 && goals.length && Math.sign(lead) !== Math.sign(goals.at(-1).leadBefore || 0) && goals.at(-1).leadBefore) changes++;
    maxLead.h = Math.max(maxLead.h, lead); maxLead.a = Math.max(maxLead.a, -lead);
    trailBy.h = Math.max(trailBy.h, -lead); trailBy.a = Math.max(trailBy.a, lead);
    const tm = home ? 'h' : 'a';
    run = tm === runTeam ? run + 1 : 1; runTeam = tm;
    if (run > bestRun.n) bestRun = { n: run, t: tm };
    goals.push({ t, home, leadBefore: before, score: `${ga}-${gh}` });
  }
  if (lead > 0) leadTime.h += end - leadSince; else if (lead < 0) leadTime.a += end - leadSince;
  const fin = isFinal(p);
  const comeback = fin && ((gh > ga && trailBy.h >= 2) ? `${H} came back from ${trailBy.h} down` : (ga > gh && trailBy.a >= 2) ? `${A} came back from ${trailBy.a} down` : '');
  const late = goals.filter((g) => g.t >= 3300 && g.t < 3600 && Math.abs(g.leadBefore) <= 1).length;
  // chart
  const W = 1100, Ht = 190, max = Math.max(ca, ch, 10);
  const x = (t) => (t / end) * W, y = (v) => Ht - (v / max) * (Ht - 10);
  const line = (pts) => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ') + ` L${W},${y(pts.at(-1)[1]).toFixed(1)}`;
  const pers = Math.ceil(end / 1200);
  const fmtT = (s2) => `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, '0')}`;
  const svg = `<svg class="flow" viewBox="-4 -4 ${W + 8} ${Ht + 22}" role="img" aria-label="Shot attempts over the game">
      ${Array.from({ length: pers - 1 }, (_, i) => `<line x1="${x((i + 1) * 1200)}" y1="0" x2="${x((i + 1) * 1200)}" y2="${Ht}" class="pline"/>`).join('')}
      ${Array.from({ length: pers }, (_, i) => `<text x="${x(i * 1200 + 600)}" y="${Ht + 14}" class="plabel">${i < 3 ? 'P' + (i + 1) : 'OT'}</text>`).join('')}
      <path d="${line(attempts.a)}" class="fa"/><path d="${line(attempts.h)}" class="fh"/>
      ${goals.map((g) => { const pts = g.home ? attempts.h : attempts.a; const v = (pts.filter(([t]) => t <= g.t).at(-1) || [0, 0])[1]; return `<circle cx="${x(g.t)}" cy="${y(v)}" r="5" class="${g.home ? 'gh' : 'ga'}"><title>${esc(g.home ? H : A)} goal ${fmtT(g.t % 1200 || 0)} P${Math.min(4, Math.floor(g.t / 1200) + 1)} (${g.score})</title></circle>`; }).join('')}
    </svg>`;
  const kp = (l, v) => `<div><b>${v}</b><small>${l}</small></div>`;
  const mins = (s2) => `${Math.round(s2 / 60)} min`;
  return `${svg}<div class="legend small"><span><i class="a sog"></i>${esc(A)} shot attempts (${ca})</span><span><i class="h sog"></i>${esc(H)} shot attempts (${ch})</span><span class="muted">Dots are goals. Attempts include blocked and missed shots.</span></div>
    <div class="kpis">${kp('lead changes', changes)}${kp('times tied after a lead', ties)}${kp('biggest lead', maxLead.a || maxLead.h ? `${maxLead.a >= maxLead.h ? A : H} +${Math.max(maxLead.a, maxLead.h)}` : '-')}${kp('longest scoring run', bestRun.n ? `${bestRun.t === 'h' ? H : A} ${bestRun.n}` : '-')}${kp(`time leading ${A} / ${H}`, `${mins(leadTime.a)} / ${mins(leadTime.h)}`)}${kp('close-game goals in the last 5 min', late)}</div>
    ${comeback ? `<p><span class="tag">Comeback</span> ${esc(comeback)}.</p>` : ''}`;
}

// ------------------------------------------------------------------ hover cards for stat terms
const GLOSS = {
  'xGF%': 'Expected-goals share: expected goals for / (for + against) while the team (or player) is on the ice. Expected goals weigh every unblocked shot by how often shots like it (distance, angle, type, rebound, rush) go in. Over 50% means a team is creating better chances than it allows. Source: MoneyPuck.',
  'On-ice xGF%': 'Expected-goals share while this player is on the ice (see xGF%). Source: MoneyPuck.',
  'CF%': 'Corsi share: all shot attempts for / (for + against), including blocked and missed shots. A rough measure of puck possession. Source: MoneyPuck.',
  'FF%': 'Fenwick share: like CF% but leaves out blocked shots. Source: MoneyPuck.',
  xGF: 'Expected goals for: the sum of each unblocked shot\'s chance of going in. Source: MoneyPuck.',
  xGA: 'Expected goals against (see xGF). For goalies, the goals an average goalie would allow on the shots faced. Source: MoneyPuck.',
  xGD: 'Expected goal difference: xGF minus xGA.',
  xG: 'Expected goals: how many goals the player\'s shots would produce for an average shooter. Source: MoneyPuck.',
  'G-xG': 'Goals minus expected goals. Positive means finishing better than the shot quality suggests (skill or luck).',
  GSAx: 'Goals saved above expected: expected goals against minus goals actually allowed. Positive means the goalie stopped more than an average goalie would. Source: MoneyPuck.',
  HDSF: 'High-danger shots for: unblocked shots MoneyPuck rates at 20%+ to score, mostly from the slot and rebounds.',
  HDSA: 'High-danger shots against (see HDSF).',
  HDS: 'High-danger shots taken by the player (20%+ chance to score). Source: MoneyPuck.',
  'HD shots': 'High-danger shots faced (20%+ chance to score). Source: MoneyPuck.',
  'HD GA': 'Goals allowed on high-danger shots. Source: MoneyPuck.',
  'Game score': 'Dom Luszczyszyn\'s single-number game rating, averaged by MoneyPuck: goals, assists, shots, blocks, penalties, faceoffs and on-ice shot and goal differences, weighted.',
  'P%': 'Points percentage: points earned / points possible (2 per game).',
  RW: 'Regulation wins: the first tiebreaker in the standings.',
  'GD/GP': 'Goal difference per game played.',
  SOS: 'Strength of schedule: the average points % of the opponents played so far.',
  PPP: 'Power-play points: goals and assists scored with a man advantage.',
  PPG: 'Power-play goals.',
  'S%': 'Shooting percentage: goals / shots on goal.',
  'TOI/GP': 'Average time on ice per game (minutes:seconds).',
  'FO%': 'Faceoff win percentage.',
  'SV%': 'Save percentage: saves / shots on goal faced.',
  GAA: 'Goals-against average: goals allowed per 60 minutes played.',
  '+/-': 'Plus/minus: even-strength and short-handed goals for minus against while on the ice.',
  'Rookie score': ROOKIE_SCORE,
  Score: FORMULA,
  SOG: 'Shots on goal: shots that reached the goalie or went in.',
  OTL: 'Overtime and shootout losses (worth 1 point).',
  L10: 'Record in the last 10 games (W-L-OTL).',
};
function addGloss(root) {
  root.querySelectorAll('th, .kpis small, .cmpmid small').forEach((el) => {
    const key = el.textContent.replace(/[↑↓]/g, '').trim();
    if (GLOSS[key]) { el.dataset.gloss = key; el.classList.add('hint'); }
  });
}
const tip = document.createElement('div'); tip.className = 'tipcard'; tip.hidden = true; document.body.append(tip);
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-gloss]');
  if (!el) { tip.hidden = true; return; }
  tip.innerHTML = `<b>${esc(el.dataset.gloss)}</b><div>${esc(GLOSS[el.dataset.gloss])}</div>`;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - 328, r.left + r.width / 2 - 160))}px`;
  tip.style.top = `${r.bottom + 8 + window.scrollY}px`;
});

// ------------------------------------------------------------------ updates (same window and steps as NBADash)
const upd = { phase: 'idle', info: null, pct: 0, text: '', error: '' };
const fmtDay = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
const mbs = (n) => (n ? `${(n / 1048576).toFixed(1)} MB` : '');
function versionChip() {
  const b = $('btn-version');
  b.textContent = state.version ? `v${state.version}` : '';
  b.hidden = !state.version;
  b.classList.toggle('has-update', upd.phase === 'available' || upd.phase === 'staged');
  b.title = upd.phase === 'available' ? `Version ${upd.info?.latest} is available` : upd.phase === 'staged' ? 'Update downloaded: click to install' : 'Check for updates';
}
function notesHtml(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '<div class="muted">No release notes were published.</div>';
  return lines.map((t) => {
    const clean = esc(t.replace(/\*\*/g, ''));
    if (/^#{1,6}\s/.test(t) || /^\*\*.+\*\*$/.test(t)) return `<div class="upd-h">${clean.replace(/^#{1,6}\s+/, '')}</div>`;
    if (/^[-*]\s/.test(t)) return `<div class="upd-li">${clean.replace(/^[-*]\s+/, '')}</div>`;
    return `<div>${clean}</div>`;
  }).join('');
}
function paintUpdate() {
  versionChip();
  if ($('upd').hidden) return;
  const i = upd.info || {};
  const btn = (label, act, primary) => `<button class="btn${primary ? ' primary' : ''}" type="button" data-upd="${act}">${label}</button>`;
  const bar = `<div class="pbar"><i style="width:${upd.pct || 3}%"></i></div><small class="muted">${esc(upd.text)}</small>`;
  let body;
  switch (upd.phase) {
    case 'checking': body = bar + `<div class="actions end">${btn('Close', 'close')}</div>`; break;
    case 'current': body = `<p><b>You're up to date (v${esc(i.latest)}).</b></p><div class="actions end">${btn('Check again', 'check')}${btn('Done', 'close', 1)}</div>`; break;
    case 'ahead': body = `<p>This copy (v${esc(i.current)}) is newer than the latest published release (v${esc(i.latest)}).</p><div class="actions end">${btn('Done', 'close', 1)}</div>`; break;
    case 'none': body = `<p>No release has been published yet.</p><p class="muted small">While the repository is private, GitHub does not show its releases here. Updates then come as drop-in zips through DashLauncher.</p><div class="actions end">${btn('Done', 'close', 1)}</div>`; break;
    case 'available': body = `<p><b>Version ${esc(i.latest)} is available</b> <small class="muted">${[fmtDay(i.published), mbs(i.size)].filter(Boolean).join(' · ')}</small></p><div class="upd-notes">${notesHtml(i.notes)}</div>
        ${i.installable === false ? '<p class="muted">This release has no update package attached yet, so it cannot be installed from here. Try again later.</p>' : ''}
        <div class="actions end">${btn('Later', 'close')}${i.installable === false ? '' : btn('Download and install', 'stage', 1)}</div>`; break;
    case 'downloading': body = `<p><b>Downloading version ${esc(i.latest || '')}</b></p>${bar}<div class="actions end">${btn('Cancel', 'cancel')}</div>`; break;
    case 'staged': body = `<p><b>Version ${esc(i.latest)} is downloaded and verified.</b></p><p class="muted">The dashboard will close, swap in the new files and reopen. Your favourites, settings and saved data stay as they are. If the new version fails to start, the previous one is restored.</p><div class="actions end">${btn('Not now', 'close')}${btn('Restart now', 'apply', 1)}</div>`; break;
    case 'error': body = `<p class="upd-err">${esc(upd.error)}</p><div class="actions end">${btn('Close', 'close')}${btn('Try again', 'check', 1)}</div>`; break;
    default: body = `<div class="actions end">${btn('Check for updates', 'check', 1)}</div>`;
  }
  $('upd-box').innerHTML = `<h2>Updates</h2><p class="muted">You have v${esc(state.version || '?')}</p>${body}`;
}
async function checkUpdate(quiet = false) {
  if (upd.phase === 'checking' || upd.phase === 'downloading') return;
  upd.quiet = quiet; upd.phase = 'checking'; upd.error = ''; upd.pct = 0; upd.text = 'Asking GitHub for the latest release...'; paintUpdate();
  try { if ((await bridge.request('update.check')) === false) { upd.phase = upd.info?.status === 'available' ? 'available' : 'idle'; paintUpdate(); } }
  catch (e) { upd.phase = 'error'; upd.error = e.message; paintUpdate(); }
}
bridge.on('update', (d) => {
  if (d.running) { upd.pct = d.pct || 0; upd.text = d.text || ''; if (d.action === 'Stage') upd.phase = 'downloading'; }
  else {
    const r = d.result || {};
    upd.pct = 0; upd.text = '';
    if (r.status === 'error') { upd.phase = upd.quiet ? 'idle' : 'error'; upd.error = r.error || 'The update did not finish.'; }
    else { upd.phase = r.status || 'idle'; upd.info = r; }
    if (upd.quiet && upd.phase === 'available') alertNote(`NHLDash ${r.latest} is available. Click the version number to update.`);
  }
  paintUpdate();
});
$('btn-version').addEventListener('click', () => {
  upd.quiet = false;
  $('upd').hidden = false;
  if (!['checking', 'downloading', 'available', 'staged'].includes(upd.phase)) checkUpdate(); else paintUpdate();
});
$('upd').addEventListener('click', async (e) => {
  if (e.target.id === 'upd') { $('upd').hidden = true; return; }
  const a = e.target.closest('[data-upd]')?.dataset.upd;
  if (!a) return;
  if (a === 'close') $('upd').hidden = true;
  if (a === 'check') checkUpdate();
  if (a === 'stage') { upd.quiet = false; upd.phase = 'downloading'; upd.pct = 0; upd.text = 'Starting...'; paintUpdate(); try { await bridge.request('update.stage'); } catch (err) { upd.phase = 'error'; upd.error = err.message; paintUpdate(); } }
  if (a === 'cancel') { try { await bridge.request('update.cancel'); } catch { } upd.phase = upd.info?.status === 'available' ? 'available' : 'idle'; paintUpdate(); }
  if (a === 'apply') { try { await bridge.request('update.apply'); } catch (err) { upd.phase = 'error'; upd.error = err.message; paintUpdate(); } }
});

// ------------------------------------------------------------------ routing and render
function parseRoute() {
  const h = location.hash || '#/';
  let m;
  if ((m = h.match(/^#\/game\/(\d{10})$/))) return { view: 'game', arg: m[1], tab: 'scores' };
  if ((m = h.match(/^#\/week\/(\d{1,2})$/))) return { view: 'week', arg: m[1], tab: '' };
  if (h === '#/rankings') return { view: 'rankings', tab: 'rankings' };
  if (h === '#/rookies') return { view: 'rookies', tab: 'rookies' };
  if (h === '#/eastwest') return { view: 'eastwest', tab: 'rankings' };
  if ((m = h.match(/^#\/compare\/((?:team\/[A-Z]{3}\/[A-Z]{3})|(?:player\/\d{7,8}\/\d{7,8}))$/))) return { view: 'compare', arg: m[1], tab: '' };
  if (h === '#/transactions') return { view: 'transactions', tab: 'moves' };
  if (h === '#/injuries') return { view: 'injuries', tab: 'moves' };
  if (h === '#/freeagents') return { view: 'freeagents', tab: 'moves' };
  if (h === '#/traffic') return { view: 'traffic', tab: '' };
  if ((m = h.match(/^#\/player\/(\d{7,8})$/))) return { view: 'player', arg: m[1], tab: '' };
  if ((m = h.match(/^#\/team\/([A-Z]{3})$/))) return { view: 'team', arg: m[1], tab: '' };
  if ((m = h.match(/^#\/scores\/(\d{4}-\d{2}-\d{2})$/))) return { view: 'scores', arg: m[1], tab: 'scores' };
  if ((m = h.match(/^#\/standings(?:\/([A-Z]{3}))?$/))) return { view: 'standings', arg: m[1], tab: 'standings' };
  if (h === '#/leaders') return { view: 'leaders', tab: 'leaders' };
  if (h === '#/advanced') return { view: 'advanced', tab: 'advanced' };
  if (h === '#/settings') return { view: 'settings', tab: '' };
  return { view: 'scores', tab: 'scores', home: true };
}
let lastWatch = '';
function render() {
  if (!state) return;
  const r = parseRoute();
  const inLauncher = state.mode === 'launcher';
  $('btn-theme').hidden = inLauncher;
  $('halted').hidden = !state.halted;
  versionChip();
  $('btn-home').classList.toggle('active', !!r.home);
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === r.tab));
  const y = window.scrollY;
  const focusId = document.activeElement?.id;
  renderBanner(r.view === 'team' ? r.arg : '');
  renderWeekBar(r.view === 'week' ? Number(r.arg) : 0);
  renderCmpBar();
  $('view').innerHTML = views[r.view](r.arg);
  addGloss($('view'));
  tip.hidden = true;
  if (focusId && $(focusId) && focusId.startsWith('set-')) $(focusId).focus();
  window.scrollTo(0, y);
  if (r.view === 'standings' && r.arg && !render.scrolled) { $(`st-${r.arg}`)?.scrollIntoView({ block: 'center' }); render.scrolled = true; }
  liveStatus();
  updateWatch(r);
}
function updateWatch(r) {
  // Keys the opt-in timer may refetch: today's scores, and the open game while it is live.
  const keys = [];
  const t = `score:${today()}`;
  if (r.view === 'scores' && (r.arg || today()) === today()) keys.push(t);
  if (r.view === 'game') { const b = get(`box:${r.arg}`); if (!b || isLive(b) || b.gameState === 'PRE') keys.push(`box:${r.arg}`, `pbp:${r.arg}`); }
  const sig = keys.join('|');
  if (sig !== lastWatch) { lastWatch = sig; bridge.request('watch.set', { keys }).catch(() => {}); }
}
window.addEventListener('hashchange', () => { render.scrolled = false; window.scrollTo(0, 0); render(); });

// Live status text, in the navigation bar spec's priority order.
function liveStatus() {
  const el = $('live-status');
  const halted = !!state.halted;
  const errKey = routeKeys.find((k) => store.get(k)?.error);
  const err = !halted && (errKey || state.error);
  const live = !halted && !err && state.live > 0;
  const at = routeKeys.map((k) => store.get(k)?.at).filter(Boolean).sort((a, b) => a - b)[0];
  let text;
  if (halted) text = 'Paused';
  else if (err) text = 'Offline';
  else if (!state.settings.autoRefresh) text = at ? `Manual · updated ${ago(at)}` : 'Manual refresh';
  else if (live) text = 'Live';
  else text = at ? `Updated ${ago(at)}` : 'Updated just now';
  el.className = `live-status np-live${live && state.settings.autoRefresh ? ' on' : ''}${err ? ' err' : ''}${halted ? ' halted' : ''}`;
  el.textContent = text;
  const why = err ? `${errKey ? store.get(errKey).error : state.error}\n` : '';
  el.title = halted ? 'All data traffic is paused. Click to resume.' : `${why}${state.live ? state.live + ' game(s) live. ' : ''}Click to pause all data traffic`;
  el.setAttribute('aria-pressed', halted ? 'true' : 'false');
}
setInterval(() => { if (state) liveStatus(); }, 15000);

// Navigation bar behaviour (docs/NAVBAR-SPEC.md).
let navDepth = 0;
window.addEventListener('hashchange', () => { navDepth++; });
const goBack = () => { if (navDepth > 0) { navDepth -= 2; history.back(); } else location.hash = '#/'; };
$('btn-back').addEventListener('click', goBack);
$('btn-fwd').addEventListener('click', () => history.forward());
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); history.forward(); }
  if (e.key === 'F5') { e.preventDefault(); $('btn-refresh').click(); }
  if (e.key === 'Escape' && !$('dialog').hidden) $('dialog-cancel').click();
  if (e.key === 'Escape' && !$('upd').hidden) $('upd').hidden = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); goBack(); }
  if (e.button === 4) { e.preventDefault(); history.forward(); }
});
$('btn-settings').addEventListener('click', () => { location.hash = '#/settings'; });

async function setTraffic(stop) {
  try { state = await bridge.request(stop ? 'traffic.stop' : 'traffic.resume'); render(); } catch (e) { alertNote(e.message); }
}
$('btn-resume').addEventListener('click', () => setTraffic(false));
$('live-status').addEventListener('click', () => setTraffic(!state?.halted));

// Refresh: refetches what the current page shows.
$('btn-refresh').addEventListener('click', async () => {
  const b = $('btn-refresh');
  if (state?.halted) { alertNote('Data traffic is paused. Resume first.'); return; }
  b.classList.add('spin');
  await Promise.all(routeKeys.map((k) => want(k, true)));
  const stop = () => b.classList.remove('spin');
  const t0 = Date.now();
  const iv = setInterval(() => { if (!routeKeys.some((k) => store.get(k)?.loading) || Date.now() - t0 > 20000) { clearInterval(iv); stop(); } }, 200);
});

// Search: teams (go to standings) and players from whatever is loaded (MoneyPuck list, leaders, open box scores).
const res = $('psearch-results');
function searchIndex() {
  const out = Object.entries(TEAMS).map(([k, v]) => ({ label: `${v} (${k})`, href: `#/team/${k}`, text: `${v} ${k}`.toLowerCase() }));
  const sc = get(`score:${today()}`);
  for (const g of sc?.games || []) {
    const lbl = `${g.awayTeam.abbrev} @ ${g.homeTeam.abbrev}, today ${gameStatus(g)}`;
    out.push({ label: lbl, href: `#/game/${g.id}`, text: `${g.awayTeam.abbrev} ${g.homeTeam.abbrev} ${nm(g.awayTeam.name)} ${nm(g.homeTeam.name)} today game`.toLowerCase() });
  }
  const seen = new Set();
  const add = (name, team, href) => { if (!name || seen.has(name)) return; seen.add(name); out.push({ label: `${name} · ${team}`, href, text: name.toLowerCase() }); };
  for (const c of Object.values(get('leaders') || {})) for (const p of c) add(`${nm(p.firstName)} ${nm(p.lastName)}`, p.teamAbbrev, `#/player/${p.id}`);
  for (const [k, v] of store) if (k.startsWith('team:') && v.body) for (const p of [...(v.body.skaters || []), ...(v.body.goalies || [])]) add(`${nm(p.firstName)} ${nm(p.lastName)}`, k.slice(5), `#/player/${p.playerId}`);
  for (const r of get('mp:skaters') || []) if (r.situation === 'all') add(r.name, r.team, `#/player/${r.playerId}`);
  return out;
}
$('psearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { res.hidden = true; return; }
  const hits = searchIndex().filter((x) => x.text.includes(q)).slice(0, 12);
  res.innerHTML = hits.length ? hits.map((x) => `<a href="${x.href}">${esc(x.label)}</a>`).join('') : '<div class="empty">No matches</div>';
  res.hidden = false;
});
res.addEventListener('click', () => { res.hidden = true; $('psearch').value = ''; });
document.addEventListener('click', (e) => { if (!e.target.closest('.psearch')) res.hidden = true; });

$('btn-theme').addEventListener('click', () => {
  standaloneTheme = { system: 'light', light: 'dark', dark: 'system' }[standaloneTheme];
  try { localStorage.setItem('theme', standaloneTheme); } catch { }
  bridge.setTheme(standaloneTheme);
  $('btn-theme').textContent = `Theme: ${standaloneTheme}`;
  render();
});

bridge.on('traffic', (d) => { if (!state) return; state.halted = !!d.stopped; if (d.stopped) store.forEach((v) => { v.loading = false; }); render(); });
bridge.on('host.theme', (d) => { bridge.setTheme(d.theme); render(); });
bridge.on('host.visible', () => {
  // Refetch only if automatic refresh is on; otherwise the live status shows how old the data is.
  if (state?.settings.autoRefresh && !state.halted) routeKeys.forEach((k) => want(k, true));
  else if (state) liveStatus();
});

(async () => {
  try { standaloneTheme = localStorage.getItem('theme') || 'system'; } catch { }
  try {
    state = await bridge.request('init');
    if (state.mode !== 'launcher') { bridge.setTheme(standaloneTheme); $('btn-theme').textContent = `Theme: ${standaloneTheme}`; }
    else if (state.theme) bridge.setTheme(state.theme);
    render();
    loadSeason();
    const note = state.updateNote;
    if (note) alertNote(note.ok ? `Updated to NHLDash ${note.to}.` : `The update to ${note.to} did not start, so ${note.from} was restored. ${note.reason || ''}`);
    if (state.settings.updateCheck !== false && !note) setTimeout(() => checkUpdate(true), 4000);
  } catch (e) {
    $('view').innerHTML = `<div class="note err">${esc(e.message)}</div>`;
  }
})();
