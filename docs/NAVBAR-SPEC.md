# Navigation bar spec (shared by all dashes)

Reference implementation: NBADash v0.15.0 (`ui/index.html`, `ui/css/app.css`, `ui/js/app.js`).
Every dash that runs in DashLauncher (NBADash, F1Dash, FADash, ...) uses this bar so they look and behave the same.

## Layout

```
┌───────────────────────────── top bar: brand · section tabs · version · theme ─────────────────────────────┐
├───────────────────────────── week/round bar (optional, per dash) ─────────────────────────────────────────┤
                ┌──────────────────────────────────────────────────────────────────────────────┐
                │ [<] [>] [⌂] [⟳] │ [ Search ...                         ] │ Live · 2m [⚙]     │
                └──────────────────────────────────────────────────────────────────────────────┘
                 back fwd home refresh   search (max 483px)                 status   settings
```

Order, left to right, is fixed:

| # | Element | id | Notes |
|---|---------|----|-------|
| 1 | Back | `btn-back` | Chevron SVG |
| 2 | Forward | `btn-fwd` | Chevron SVG |
| 3 | Home | `btn-home` (`<a href="#/" data-route="home">`) | House SVG; gets `.active` on the home route |
| 4 | Refresh | `btn-refresh` | Circular-arrow SVG; spins while refreshing |
| 5 | Separator | `.np-sep` | |
| 6 | Search | `.psearch` > `#psearch` | Dash decides what it searches (players, drivers, clubs) |
| 7 | Separator | `.np-sep` | |
| 8 | Live status | `<button id="live-status">` (`.live-status.np-live`) | Text button; also the pause switch |
| 9 | Settings | `btn-settings` | Gear SVG |

The top bar keeps only the brand, section tabs, version and theme button. Refresh, live status and Settings are **not** in the top bar.

## Look

- Bar is centred in a row (`.navpill-row`, padding `0 16px 10px`) directly under the week/round bar, or under the top bar if a dash has none. It sits flush: no gap above.
- Bar (`.navpill`): square corners (`border-radius: 0`), `1px solid var(--line)` on all four sides including the top, background `var(--surface)`, padding 4px, gap 2px.
- Buttons (`.np-btn`): 34 × 34 px, `border-radius: 4px`, transparent background, colour `var(--text)`; hover background `var(--surface2)`; `.active` colour `var(--accent)`.
- Icons: inline SVG, 22 × 22, `viewBox 0 0 24 24`, stroke `currentColor`, stroke-width 2.4, round caps and joins, no fill. `display: block`.
- Separators: 1 × 20 px, `var(--line)`, margin `0 6px 0 4px`.
- Search input: width `min(483px, 46vw)`, no border, `border-radius: 4px`, padding `8px 14px`, transparent; focus background `var(--surface2)`, no outline. Results drop-down is centred under the input.
- Live status: a `<button>` with no border or background, 34px tall, padding `0 10px`, 13px text, `var(--muted)`, no wrapping, `border-radius: 4px`; hover background `var(--surface2)`.
  - `.on` (an event is live): bold, colour `var(--live)`, with a 10px dot before the text that blinks hard: 0.9s ease-in-out loop between full opacity, scale 1.1 and an 8px `var(--live)` glow, and 15% opacity at scale 0.7. With reduced motion, the loop slows to 2.4s.
  - `.halted` (paused): bold, colour `var(--warn)`, text `Paused`, with a small pause mark (two 3px bars) before the text. No blinking.

## Behaviour

- **Back**: steps back through the dash's own `#/` route history. If there is nothing to go back to, goes Home. Also Alt+Left and mouse button 3 (back).
- **Forward**: `history.forward()`. Also Alt+Right and mouse button 4 (forward).
- **Home**: `#/`.
- **Refresh**: refreshes live data only; adds `.spin` (0.8s linear rotate) until done. F5 triggers it.
- **Live status** text, in priority order: `Paused` when data traffic is paused → `Offline` (on error, error text in the tooltip) → `Manual · updated 2m ago` / `Manual refresh` when auto-refresh is off → `Live` when any event is in progress → `Updated 2m ago`.
- **Live status click = pause switch**: one click stops all data traffic (running sync, live refresh, queued box score and player requests), exactly like DashLauncher's kill switch. The page sends `traffic.stop`; the backend runs its own `Stop-DashTraffic`. The dash's "data refresh stopped" bar with a Resume button appears. A second click (or Resume) sends `traffic.resume`. Update checks keep working while paused; saved settings don't change. Tooltip: `Click to pause all data traffic` / `All data traffic is paused. Click to resume.`; `aria-pressed` is `true` while paused.
- **Settings**: opens the dash's Settings panel.
- Keyboard focus and `aria-label`s on every button; the bar has `role="navigation" aria-label="Page navigation"`.

## Changes since first version

- v0.13.0: bar added (back, forward, home, search); square corners; flush with the week bar; top border; 22px icons.
- v0.13.1: refresh, live status and Settings moved from the top bar into the bar.
- v0.15.0: live status is a button that pauses and resumes all data traffic; stronger blink while live; `Paused` state.
