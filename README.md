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
- Live scoring, projected finals, and a **win-probability** model built from per-player variance that sharpens as games finish.
- **Live projections** that update with the game clock (points banked + remaining projection).
- Rich player rows: position colors, game-status dots (⚪ yet to play · 🔴 live · 🟢 final), **red-zone** highlight, score-flash on scoring, **NFL team logos**, **opponent** (vs / @), **injury status** badges (Q / D / O / IR / SUS / PUP / DTD…), and trade value + positional rank + 30-day trend.
- **Browse every matchup** in a league (pager), or **expand** one into a full-screen focus view.
- Benches toggle, light/dark theme toggle, auto-refresh (with interval), and a header summary of how many matchups you're winning.

**Cross-league tools** (leveraging all your leagues at once)
- **Rooting guide** — nets every NFL player into who to root for / against across your leagues, and flags conflicts (own in one league, facing in another).
- **Games to watch** — live strip of close matchups.
- **Optimal lineup / points left on bench** — per league, the best lineup you could've started vs. what you did.

**All-rosters league view**
- A full-screen, Sleeper-style grid of every team — position-colored cells, records, values, and **team-strength** ranking.

**Player profiles** (click any player)
- **Game Log** with a season dropdown, per-game **fantasy points**, color-graded stats (heatmap), grouped categories, and a **season-averages** table. Uses ESPN, with an automatic **Sleeper stats fallback** when ESPN's log is empty.
- **News & Outlook** from ESPN and Sleeper, separated by source.
- **Depth Chart** for the player's NFL team, with the player highlighted.
- **Vegas** tab — DraftKings props: anytime-TD odds and implied over/under lines for passing / rushing / receiving yards.

**League Lab** (per league)
- **Standings & playoff odds** — Monte-Carlo simulation from records, remaining schedule, and team strength.
- **Power rankings** with week-over-week movement.
- **Strength of schedule**, **bye-week planner**, **waivers** (best available + Sleeper trending), **buy-low / sell-high**, **Vegas edge** (implied vs. projection), and a **weekly recap**.

**Trade Center** (per league, also reachable from any team in the rosters view)
- **Deal builder** — any two teams, rosters grouped by position with value, positional rank, 30-day trend, season **points per game**, **snap share**, injuries and **bye weeks**; tap players to build the deal.
- **Lineup impact**, not just value sums — for both sides: change in starting-lineup value, change in this week's projected starters, who enters/leaves the lineup, and roster spots freed/needed.
- **Trade partners rail** — every team ranked by how well their surplus fits your needs (and vice-versa), with needs/depth tags.
- **Finder** — balanced swaps with one partner, a **whole-league scan** (1-for-1, 2-for-1, 1-for-2), or offers for your **★ trade block**; filters for fairness band, "must upgrade my starters", fill-my-needs, target positions, positions to keep out, and **🔒 untouchables**.
- **AI analyst** — evaluates the deal on the board (grades, verdict, what each side gets, risks, lineup impact, a counter-offer and a ready-to-send pitch), **suggests trades** across the league, or answers free-form questions. It's fed the league's settings, standings and playoff odds, both rosters with values and season stats, plus news, outlooks, Vegas lines and recent games for the players involved. Works with your **Claude or ChatGPT account** (via the Claude Code / Codex CLI — no API key) or an Anthropic / OpenAI / OpenAI-compatible API key.
- **League trade history**, **saved proposals**, and a one-click **copy for league chat**.
- Trade values, ranks, and 30-day trends via [FantasyCalc](https://fantasycalc.com).

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

**3. (Optional) Turn on the AI trade analyst**

Click **⚙** in the app and pick how to connect:

- **Claude account** — uses the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
  already signed in on your machine (`npm i -g @anthropic-ai/claude-code`, then run `claude` once to log in). No API key.
- **ChatGPT account** — uses the [Codex CLI](https://github.com/openai/codex) signed in with
  ChatGPT (`npm i -g @openai/codex`, then `codex login`). No API key.
- **API key** — Anthropic, OpenAI, or any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter…).

Settings are saved to your local `config.json` (or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
League data is sent to the provider only when you press an AI button.

---

## Notes & caveats

- **Data sources are unofficial.** Sleeper's public API, ESPN's fantasy + gamelog
  APIs, ESPN's NFL scoreboard, DraftKings' props API, and FantasyCalc are used as-is.
  They can change or rate-limit; the app retries transient failures and degrades
  gracefully, but a source may occasionally be unavailable.
- **Projections & win %** are estimates. Player projections come from Sleeper/ESPN;
  the win-probability model is a per-player-variance estimate, not a calibrated forecast.
- **Trade values** come from FantasyCalc, **auto-matched to each league's format** —
  team size, PPR, superflex, and (Sleeper) dynasty are detected from league settings.
  ESPN dynasty can't be auto-detected, so set it (or override any of the above) per
  league via `league_overrides` in `config.json` (see `config.example.json`). Values
  are a neutral market baseline, not your league's exact scoring.
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
