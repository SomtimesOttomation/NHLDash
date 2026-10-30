# NHLDash

NHL 2026-27 dashboard for [DashLauncher](https://github.com/SomtimesOttomation/DashLauncher). Runs on its own or as a tab in
DashLauncher. Windows PowerShell 5.1 + WebView2, no installer, no admin rights, no build step.

Team banner with favourites; team, player and week pages; scores (any date) with a game flow chart and shot map;
standings, leaders, power rankings, rookie watch, East-West report, compare; transactions, injuries and free agents;
an updater (version button) and a traffic page. Scores (any date), live game status, box scores, scoring summary, shot maps, standings (division, conference,
league), skater and goalie leaders. Optional advanced stats (xG, shot quality, goalie GSAx) from MoneyPuck.

## Data sources

- **NHL web API** (`api-web.nhle.com`): the NHL's own unofficial, undocumented feed. All URLs live in
  `modules/NHLDash.Host.psm1` > `Resolve-DataKey`, so a change on the NHL side is fixed in one place.
- **NHL stats API** (`api.nhle.com`): the rookie list.
- **ESPN** public NHL endpoints: injuries and transactions only, downloaded when those pages are opened.
- **MoneyPuck** (`moneypuck.com/data.htm`): off by default. When turned on (with a warning), the Advanced page downloads
  the published season files, at most every 12 hours, credited on screen. Free for personal, non-commercial use only.

Nothing is fetched until you open a page or press Refresh. Automatic refresh is opt-in in Settings (20 to 600 seconds),
runs only while the tab is visible, and stops with the live-status pause switch or DashLauncher's kill switch.

## Run it

- On its own: double-click `Start-NHLDash.bat`. The first run downloads the WebView2 files into `lib\`.
- In DashLauncher: copy this folder into `DashLauncher\modules`, press **Scan for modules**, and approve it.

## Building it out

- Follows the dash contract (version 1) in the DashLauncher repo. Check it with DashLauncher's
  `tools\Test-DashContract.ps1 -Path <this folder>` before each release.
- Keep the navigation bar as it is ([docs/NAVBAR-SPEC.md](docs/NAVBAR-SPEC.md)); change only what search looks for and
  what Refresh refetches.
- Replace the fake ticks and sync with real fetching in a worker runspace or child process. Read each data source's
  terms first and list it in `dash.json` > `dataSources`. Nothing is fetched until the person asks; automatic refresh is
  opt-in behind a warning; a hidden tab fetches nothing on a timer.
- Settings, cache and other data live in `%APPDATA%\NHLDash` and `%LOCALAPPDATA%\NHLDash`, never in this folder.
- No betting features (odds, lines, spreads, over/unders).

## Release zip

`NHLDash-vX.Y.Z.zip` + `.sha256` for DashLauncher's `updates` folder, built from the release commit:

```
git archive --format=zip -o NHLDash-vX.Y.Z.zip vX.Y.Z
```

The `.sha256` file holds the zip's SHA-256 hash (lowercase hex).

## Disclaimer

Unofficial. Not affiliated with any league, team or data provider. No data is bundled; it is fetched on your own
computer for personal use.

## Licence

MIT. See [LICENSE](LICENSE).
