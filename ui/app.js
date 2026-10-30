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
  if (!force && (cur.body !== undefined || cur.loading)) return;
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
      return `<div class="gteam${win ? ' win' : ''}${fav.has(t.abbrev) ? ' fav' : ''}">${logo(t.abbrev)}<span class="abbr">${esc(t.abbrev)}</span><span class="tname">${esc(nm(t.name))}</span>${fut ? '' : `<b class="sc">${t.score ?? 0}</b><span class="sog">${t.sog ?? ''}${t.sog != null ? ' SOG' : ''}</span>`}</div>`;
    };
    return `<a class="card game${live ? ' live' : ''}" href="#/game/${g.id}" id="game-${g.id}">
      <div class="gstat${live ? ' on' : ''}">${esc(gameStatus(g))}</div>${row(g.awayTeam, g.homeTeam)}${row(g.homeTeam, g.awayTeam)}
      <div class="gmeta muted small">${esc(nm(g.venue))}${g.tvBroadcasts?.length ? ' &middot; ' + esc(g.tvBroadcasts.map((b) => b.network).join(', ')) : ''}</div></a>`;
  }).join('');
  return `<div class="datebar">
      <a class="btn sq" href="#/scores/${shiftDate(date, -1)}" aria-label="Previous day">&lsaquo;</a>
      <strong>${esc(niceDate(date))}</strong>
      <a class="btn sq" href="#/scores/${shiftDate(date, 1)}" aria-label="Next day">&rsaquo;</a>
      ${date !== today() ? '<a class="btn" href="#/">Today</a>' : ''}
    </div>
    ${status(key)}
    ${sc && !games.length ? '<div class="note">No games on this day.</div>' : ''}
    <div class="grid games">${cards}</div>`;
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
      <span><b>${esc(s?.name || 'Unknown')}</b>${d.scoringPlayerTotal ? ` (${d.scoringPlayerTotal})` : ''}${strength ? ` <span class="tag">${strength}</span>` : ''}<br>
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
  const rows = sk.map((s) => `<tr><td>${s.sweaterNumber ?? ''}</td><td class="l">${esc(nm(s.name))}</td><td>${s.position}</td><td>${s.goals}</td><td>${s.assists}</td><td><b>${s.points}</b></td><td>${s.plusMinus > 0 ? '+' : ''}${s.plusMinus}</td><td>${s.sog}</td><td>${s.hits}</td><td>${s.blockedShots}</td><td>${s.pim}</td><td>${s.faceoffWinningPctg ? Math.round(s.faceoffWinningPctg * 100) + '%' : ''}</td><td>${esc(s.toi)}</td></tr>`).join('');
  const gl = (t.goalies || []).filter((g) => g.toi && g.toi !== '00:00').map((g) => `<tr><td>${g.sweaterNumber ?? ''}</td><td class="l">${esc(nm(g.name))}${g.decision ? ` <span class="tag">${esc(g.decision)}</span>` : ''}</td><td>${esc(g.saveShotsAgainst || '')}</td><td>${g.savePctg != null ? g.savePctg.toFixed(3).replace(/^0/, '') : ''}</td><td>${g.goalsAgainst ?? ''}</td><td>${esc(g.evenStrengthShotsAgainst || '')}</td><td>${esc(g.powerPlayShotsAgainst || '')}</td><td>${esc(g.shorthandedShotsAgainst || '')}</td><td>${esc(g.toi || '')}</td></tr>`).join('');
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
      <span class="muted small push">Updated ${esc(ago(store.get('standings')?.at))}</span></div>
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
      return `<li><span class="rk">${i + 1}</span>${logo(p.teamAbbrev, 'slogo')}<span class="l">${esc(nm(p.firstName))} <b>${esc(nm(p.lastName))}</b> <span class="muted small">${esc(p.teamAbbrev)} &middot; ${esc(p.position)}</span></span><b class="v">${v}</b></li>`;
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
      ${skaters.map((r) => `<tr class="${fav.has(r.team) ? 'fav' : ''}"><td class="l">${esc(r.name)}</td><td>${esc(r.team)}</td><td>${esc(r.position)}</td><td>${r.games_played}</td><td>${toi(r.icetime)}</td><td>${r.I_F_goals}</td><td><b>${f2(r.I_F_xGoals)}</b></td><td>${r.gax > 0 ? '+' : ''}${f2(r.gax)}</td><td>${r.I_F_points}</td><td>${r.I_F_shotsOnGoal}</td><td>${r.I_F_highDangerShots}</td><td>${pct(r.onIce_xGoalsPercentage)}</td><td>${f1(r.gameScore)}</td></tr>`).join('')}</tbody></table></div>` : status('mp:skaters')}</section>
    <section class="card wide"><h2>Goalies <span class="muted small">GSAx = goals saved above expected</span></h2>${goalies ? `<div class="tscroll"><table class="tbl"><thead><tr>${th('goalies', 'name', 'Goalie', 1)}${th('goalies', 'team', 'Team')}${th('goalies', 'games_played', 'GP')}${th('goalies', 'icetime', 'TOI')}${th('goalies', 'gsax', 'GSAx')}${th('goalies', 'xGoals', 'xGA')}${th('goalies', 'goals', 'GA')}${th('goalies', 'svp', 'SV%')}${th('goalies', 'highDangerShots', 'HD shots')}${th('goalies', 'highDangerGoals', 'HD GA')}</tr></thead><tbody>
      ${goalies.map((r) => `<tr class="${fav.has(r.team) ? 'fav' : ''}"><td class="l">${esc(r.name)}</td><td>${esc(r.team)}</td><td>${r.games_played}</td><td>${toi(r.icetime)}</td><td><b>${r.gsax > 0 ? '+' : ''}${f2(r.gsax)}</b></td><td>${f2(r.xGoals)}</td><td>${r.goals}</td><td>${r.svp == null ? '' : r.svp.toFixed(3).replace(/^0/, '')}</td><td>${r.highDangerShots}</td><td>${r.highDangerGoals}</td></tr>`).join('')}</tbody></table></div>` : status('mp:goalies')}</section>
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
    <section class="card"><h2>Data and sources</h2>
      <p class="small">NHL web API (api-web.nhle.com): scores, game centre, standings, leaders. Unofficial and undocumented; it can change without notice. <a href="https://www.nhl.com/info/terms-of-service" target="_blank" rel="noreferrer">NHL terms</a></p>
      <p class="small">MoneyPuck.com season files (only when turned on). <a href="https://moneypuck.com/data.htm" target="_blank" rel="noreferrer">MoneyPuck data terms</a></p>
      <p class="muted small">This session: ${t.requests} requests, ${(t.bytes / 1048576).toFixed(2)} MB, ${t.errors} errors.</p>
      <div class="actions"><button id="set-clear" class="btn" type="button">Clear saved data</button></div></section>
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
  try { await bridge.request('cache.clear'); store.clear(); alertNote('Saved data cleared. Logos are kept.'); } catch (err) { alertNote(err.message); }
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
      ${(cs.skaters || []).slice().sort((a, b) => b.points - a.points || b.goals - a.goals).map((p) => `<tr><td class="l">${esc(nm(p.firstName))} <b>${esc(nm(p.lastName))}</b></td><td>${esc(p.positionCode)}</td><td>${p.gamesPlayed}</td><td>${p.goals}</td><td>${p.assists}</td><td><b>${p.points}</b></td><td>${p.plusMinus > 0 ? '+' : ''}${p.plusMinus}</td><td>${p.penaltyMinutes}</td><td>${p.powerPlayGoals}</td><td>${p.shots}</td><td>${p.shootingPctg ? (p.shootingPctg * 100).toFixed(1) : '0.0'}</td><td>${toiAvg(p.avgTimeOnIcePerGame)}</td><td>${p.faceoffWinPctg ? Math.round(p.faceoffWinPctg * 100) + '%' : ''}</td></tr>`).join('')}</tbody></table></div>
      <div class="tscroll"><table class="tbl"><thead><tr><th class="l">Goalie</th><th>GP</th><th>GS</th><th>W</th><th>L</th><th>OTL</th><th>GAA</th><th>SV%</th><th>SA</th><th>SO</th></tr></thead><tbody>
      ${(cs.goalies || []).map((g) => `<tr><td class="l">${esc(nm(g.firstName))} <b>${esc(nm(g.lastName))}</b></td><td>${g.gamesPlayed}</td><td>${g.gamesStarted}</td><td>${g.wins}</td><td>${g.losses}</td><td>${g.overtimeLosses}</td><td>${g.goalsAgainstAverage?.toFixed(2) ?? ''}</td><td>${pct3(g.savePercentage)}</td><td>${g.shotsAgainst}</td><td>${g.shutouts}</td></tr>`).join('')}</tbody></table></div></section>` : `<section class="card wide">${status(tk)}</section>`;

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
  return head + schedule + mp + skaters;
};

// ------------------------------------------------------------------ routing and render
function parseRoute() {
  const h = location.hash || '#/';
  let m;
  if ((m = h.match(/^#\/game\/(\d{10})$/))) return { view: 'game', arg: m[1], tab: 'scores' };
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
  $('version').textContent = state.version ? `v${state.version}` : '';
  $('btn-home').classList.toggle('active', !!r.home);
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === r.tab));
  const y = window.scrollY;
  const focusId = document.activeElement?.id;
  renderBanner(r.view === 'team' ? r.arg : '');
  $('view').innerHTML = views[r.view](r.arg);
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
  for (const c of Object.values(get('leaders') || {})) for (const p of c) add(`${nm(p.firstName)} ${nm(p.lastName)}`, p.teamAbbrev, '#/leaders');
  for (const r of get('mp:skaters') || []) if (r.situation === 'all') add(r.name, r.team, '#/advanced');
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
  } catch (e) {
    $('view').innerHTML = `<div class="note err">${esc(e.message)}</div>`;
  }
})();
