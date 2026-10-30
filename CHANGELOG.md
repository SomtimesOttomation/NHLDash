# Changelog

Changes are grouped by label: Feature, Bug/Fix, Redesign, Housekeeping. Every merged change lands under Unreleased first and moves to a version heading when that release is published.

Release rhythm: changes are merged as they are done without changing VERSION, and released in batches on Mondays and Thursdays. Real user-facing bugs can be released right away.

## Unreleased

## 0.4.3 (2026-10-30)

**Bug/Fix**
- Scores games and day arrows are centred on days with fewer than four games.

## 0.4.2 (2026-10-30)

**Redesign**
- Scores page and team logos laid out and sized like NBADash.

**Housekeeping**
- Publishing a release now builds and attaches the update zip and checksum automatically.

## 0.4.1 (2026-10-29)

**Redesign**
- Logos, game cards and the week bar now match NBADash's sizes and layout.

## 0.4.0 (2026-10-29)

**Feature**
- Updater: the version button opens the update window (check, download, verify, install, roll back), like NBADash.
- Player pages: bio, this season, game log, NHL career; player names link to them everywhere.
- Season sync with the week bar and week pages; traffic details page.
- Power rankings, rookie watch, East-West report, and compare for two teams or two players.
- Moves tab: transactions, injuries and free agents (ESPN), with team injuries on team pages.
- Game flow chart and momentum numbers; hover cards that explain stat terms.

**Bug/Fix**
- A failed download is no longer retried on every redraw.

**Housekeeping**
- Data sources list now includes the NHL stats API, ESPN and GitHub releases.

## 0.3.0 (2026-10-29)

**Feature**
- Team banner (same as NBADash) with starred favourites first; favourites can now be more than one team.
- Team pages: record, last and next games, season player stats, MoneyPuck summary when turned on.

**Bug/Fix**
- Team codes are checked case-sensitively.

## 0.2.0 (2026-10-29)

**Feature**
- NHL data from the NHL web API: scores by date, live game status, scoring summary, shot map, box scores, standings and leaders.
- Optional MoneyPuck advanced stats (xG, shot quality, goalie GSAx), off by default, behind a warning.
- Opt-in automatic refresh (20-600 s, visible tab only), favourite team, team and player search.

**Housekeeping**
- Started from DashLauncher's Sample dash (contract 1, shared navigation bar, pause switch).

## Released
