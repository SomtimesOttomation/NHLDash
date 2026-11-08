# NHLDash architecture

Windows PowerShell 5.1 + WebView2, no build step. Follows DashLauncher's dash contract (version 1).

## Pieces

| Piece | File | Job |
| --- | --- | --- |
| Standalone host | `Start-NHLDash.bat`, `Start-NHLDash.ps1` | Creates the window and WebView2, maps `https://nhldash.ui/` and `https://nhldash.cache/`, builds the context object, calls the backend. DashLauncher does the same when NHLDash is a tab. |
| Backend | `modules/NHLDash.Host.psm1` | Contract functions, page commands, settings, the data keys (`Resolve-DataKey`: the only place URLs are built), the cache rules, season sync, updater control. Never touches a window. |
| Worker | runspace inside the backend (`$WorkerScript`) | Downloads one item at a time, saves it in the cache, hands the page the raw text. Counts traffic per server. Honours the pause switch (generation counter) and sync cancel. |
| Nightly sync | `Sync-NHLCache.ps1`, `Register-NHLSyncTask.ps1` | Opt-in Windows scheduled task. Runs the same worker with no window (`Invoke-NhlHeadlessSync`) and exits; skips itself when NHLDash is open (host lock). |
| Updater | `Update-NHLDash.ps1` (check, download, verify, stage) and `Apply-Update.ps1` (swap after close, relaunch, roll back) | Child processes started by the backend. Ported from NBADash. The page confirms a new version on load. |
| Page | `ui/index.html`, `ui/app.js`, `ui/app.css`, `ui/bridge.js` | One page, hash routes. Asks for data by key (`data.get`), never by URL. |
| Browser preview | `ui/dev/mock.js` | Stands in for the host when the page is opened in a normal browser; does nothing inside WebView2. |
| Release | `.github/workflows/release.yml` | On publish: tag must match `VERSION`, scripts must be ASCII-only, builds and attaches `NHLDash-vX.Y.Z.zip` + `.sha256`. |

## Data keys and sources

All URLs live in `Resolve-DataKey`. Keys the page may ask for:

- NHL web API (`api-web.nhle.com`): `score:<date>`, `standings`, `leaders`, `goalies`, `box:<id>`, `pbp:<id>`, `sched:<team>`, `team:<team>` (season player stats), `player:<id>`, `plog:<id>`, `week:<monday>`.
- NHL stats API (`api.nhle.com`): `rookies`. NHL search (`search.d3.nhle.com`): `psearch:<text>` (only when the local index finds fewer than 3).
- NHL assets: `logo:<team>[:dark]`, `mug:<team>:<id>` (pictures, cached 30 days).
- ESPN public endpoints: `espn:injuries`, `espn:transactions` (only when those pages are opened).
- MoneyPuck (opt-in): `mp:teams`, `mp:skaters`, `mp:goalies` (at most every 12 hours, trimmed before the page sees them).
- Local only: `seasonbox` (all saved finished games in compact form, written by the season sync).

## Cache (`%LOCALAPPDATA%\NHLDash\cache`)

One file per key. Finished games' box scores and play-by-play are never downloaded again. The season sync also
writes `boxc/<id>.json` (a compact box score per finished game) and joins them into `season-box.json`, which the
season pages (Leaders/Losers, Form, players of the week, report card) read. Settings: `%APPDATA%\NHLDash\settings.json`.
Update work files: `%LOCALAPPDATA%\NHLDash\update`. Logs: `cache\logs`.

## Fetching rules

Nothing is fetched until the person opens a page or presses Refresh. Automatic refresh, MoneyPuck and the nightly
sync are opt-in behind warnings. A hidden tab makes no timed requests. The pause switch (`traffic.stop`) and the
launcher's kill switch stop all data traffic; update checks to GitHub are not affected. A failed request waits for
Refresh. Bulk downloads (season box scores, draft info) go one request every 0.6 to 1 second.

## Season pages

`ui/app.js` > `seasonStats()` builds per-player and per-goalie totals from `seasonbox`: Game Score (box-score
version), Form (Kalman filter), leaders and losers with qualifying minimums. `teamRecords()` builds team records,
strength of schedule and the SRS-style rating from the saved weeks. Every calculated number has a hover card
(`GLOSS`, `GLOSS_F`).
