# 🏈 Fantasy War Room

A local dashboard that shows **all your fantasy football teams at once** — Sleeper
and ESPN leagues side by side — with live scoring, player research, trade values,
a trade machine, and sportsbook odds. Runs entirely on your own machine with
**zero dependencies** (just `python3`, which macOS/Linux already have).

Everything is **read-only** — the app never logs into or changes anything in your
leagues. It only reads public/undocumented endpoints to display data.

![leagues](https://img.shields.io/badge/leagues-Sleeper%20%2B%20ESPN-8b5cf6) ![deps](https://img.shields.io/badge/dependencies-none-16a34a) ![license](https://img.shields.io/badge/license-MIT-blue)

---

## Features

**Live dashboard**
- All your matchups on one screen, auto-detected from your Sleeper username and ESPN leagues.
- Your score vs. opponent, projected finals, and a **win-probability** model that sharpens as games finish.
- Player rows with live points, projections, position colors (Sleeper-style), game status dots (⚪ yet to play · 🔴 live · 🟢 final), red-zone highlight, and a score-flash when someone scores.
- Toggle to show **benches**; a header summary of how many matchups you're winning.

**All-rosters league view**
- A full-screen, Sleeper-style grid of every team in a league — one column per team, position-colored cells, records, and **team strength** ranking (summed trade value).

**Player profiles** (click any player)
- **Game Log** with a season dropdown back to a player's rookie year, per-game **fantasy points**, color-graded stats (heatmap), grouped stat categories, and a **season-averages** table.
- **News & Outlook** from ESPN and Sleeper, clearly separated by source, plus the Sleeper season outlook.
- **Depth Chart** for the player's NFL team (QB/RB/WR/TE/K), with the player highlighted.
- **Vegas** tab — DraftKings player props: anytime-TD odds and implied over/under lines for passing / rushing / receiving yards, with the full milestone ladder.

**Trade tools**
- **Trade machine** — pick any two teams, select players from each side, and get a live fair/uneven verdict weighted by trade value.
- **Trade finder** — suggests balanced 1-for-1 and 2-for-1 swaps, with a **fairness slider**, a **"fill my needs"** filter (auto-detected weak positions, optionally starters-only), and **target-position** toggles ("I want WRs").
- Trade values, positional ranks, and **30-day trend arrows** are shown on roster cells and profiles (via [FantasyCalc](https://fantasycalc.com)).

---

## Setup (about 2 minutes, one time)

You need `python3` (already installed on macOS/Linux; on Windows install from python.org).

**1. Create your config**

```bash
cp config.example.json config.json
```

Open `config.json` and fill it in:

- **Sleeper** — just put your Sleeper **username** under `sleeper.username`. The app
  finds your leagues automatically. (To pin specific leagues instead, leave `username`
  and list `league_ids`.)
- **ESPN** — for each ESPN league add its `league_id` plus two cookies from your
  logged-in ESPN session, `espn_s2` and `SWID`:
  1. Go to `https://fantasy.espn.com` in Chrome, logged in.
  2. Open DevTools (`⌥⌘I` / `F12`) → **Application** tab → **Storage → Cookies → `https://fantasy.espn.com`**.
  3. Copy the value of **`espn_s2`** into `espn_s2`, and **`SWID`** (keep the `{ }`) into `swid`.
  4. `league_id` is the `leagueId=` number in your ESPN league URL. The same cookies work for all your ESPN leagues.

> 🔒 `config.json` is git-ignored and never leaves your machine. **Never commit it** — it contains your ESPN session cookies.

**2. Run it**

```bash
python3 server.py
```

Open **http://localhost:8787** in your browser. Leave the terminal running during
games; press `Ctrl+C` to stop. Use a different port with `PORT=9000 python3 server.py`.

---

## Notes & caveats

- **Data sources are unofficial.** Sleeper's public API, ESPN's fantasy + gamelog
  APIs, ESPN's NFL scoreboard, DraftKings' props API, and FantasyCalc are used as-is.
  They can change or rate-limit; the app retries transient failures and degrades
  gracefully, but a source may occasionally be unavailable.
- **Projections & win %** are estimates. Player projections come from Sleeper/ESPN;
  the win-probability model is a per-player-variance estimate, not a calibrated forecast.
- **Trade values** are FantasyCalc's redraft / PPR / 1QB consensus, sized to your
  league — a strong neutral baseline, not your league's exact scoring.
- **Vegas odds** are DraftKings-only (one book) and post during game week; some
  players won't have props early in the week or in the offseason.
- Player metadata from Sleeper is cached in `.cache/` and refreshed daily.

---

## Disclaimer

This is an **unofficial, personal, non-commercial** project provided for
**informational and educational purposes only**, and it is **not affiliated with,
endorsed by, or sponsored by** Sleeper, ESPN, DraftKings, FantasyCalc, the NFL, or
any of their affiliates. All product names, logos, team marks, and trademarks are
the property of their respective owners and are used here only to identify the data
being displayed; no ownership or endorsement is implied.

- **Unofficial data sources.** The app reads from public and undocumented endpoints
  (Sleeper, ESPN, DraftKings, FantasyCalc). These are not official, supported, or
  guaranteed interfaces; they can change, rate-limit, or stop working at any time,
  and using them may be subject to each provider's Terms of Service. **You are
  responsible for reviewing and complying with those terms** and for how you use
  this software.
- **No betting advice.** Sportsbook odds are shown for informational purposes only
  and are **not** betting or financial advice. They come from a single book, may be
  delayed or inaccurate, and should not be relied on for wagering. Gambling laws vary
  by jurisdiction — know and follow yours.
- **No warranty.** Projections, win probabilities, trade values, and playoff odds are
  estimates and may be wrong. The software is provided "as is", without warranty of
  any kind, as stated in the [LICENSE](LICENSE). Use at your own risk.
- **Your data stays with you.** You supply your own credentials in a local
  `config.json` that is git-ignored and never committed or transmitted anywhere by
  this project. Keep it private.

## License

Released under the [MIT License](LICENSE) — © 2026 Adrian Ahmetspahic.
