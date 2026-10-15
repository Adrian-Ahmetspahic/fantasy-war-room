# 🏈 Fantasy War Room

A local dashboard that shows **all your fantasy football teams at once** — Sleeper
and ESPN leagues side by side — with live scoring, player research, a league lab,
a full trade center with an **AI trade analyst**, and sportsbook odds. Runs entirely
on your own machine with **zero dependencies** (just `python3`, which macOS/Linux
already have).

Everything is **read-only** — the app never logs into or changes anything in your
leagues. It only reads public/undocumented endpoints to display data.

Five views, one league picker: **⚡ Live · 📺 Game Day · 👥 Rosters · ⇄ Trade · 📊 Lab**. Player
profiles open in a tabbed window from anywhere.

![leagues](https://img.shields.io/badge/leagues-Sleeper%20%2B%20ESPN-8b5cf6) ![deps](https://img.shields.io/badge/dependencies-none-16a34a) ![license](https://img.shields.io/badge/license-MIT-blue)

---

## Features

**Live dashboard**
- All your matchups on one screen, auto-detected from your Sleeper username and ESPN leagues.
- Live scoring, projected finals, and a **win-probability** model built from per-player variance that sharpens as games finish.
- **Live projections** that update with the game clock (points banked + remaining projection).
- Rich player rows: position colors, game-status dots (⚪ yet to play · 🔴 live · 🟢 final), **red-zone** highlight, score-flash on scoring, **NFL team logos**, **opponent** (vs / @), **injury status** badges (Q / D / O / IR / SUS / PUP / DTD…), and trade value + positional rank + 30-day trend.
- **Live box-score stat lines** for every player (passing / rushing / receiving / kicking / defense) while games are on. Sleeper scores are re-computed from the live stats feed with your league's own scoring, so they don't lag behind the Sleeper app.
- **Browse every matchup** in a league (pager), open one in **Game Day** (📺) for the live feed, or jump from any card straight to that league's rosters, trade center or lab.
- Benches toggle, light/dark theme toggle, auto-refresh (with interval), and a summary of how many matchups you're winning.

**Game Day** (per league)
- One matchup, full screen, with a **live play-by-play feed** of every play involving the players in it — your side in blue, your opponent's in orange: completions, runs, touchdowns, sacks, picks, fumbles, field goals, with the game clock and score at that moment. Scoring plays and turnovers are highlighted, new plays flash in, and the feed refreshes every 15 seconds. Filter to your players, the opponent's, or scoring plays only; include benches; page through every matchup in the league. Before kickoff it lists when each player's game starts.
- **🎰 Lineup by Vegas odds** — your optimal lineup using DraftKings-implied fantasy points (yardage, TD and reception lines) for games yet to start, the live projection for games in progress, and actual points for finished games — side by side with your current lineup, with the swaps it suggests.

**Cross-league tools** (leveraging all your leagues at once)
- **Rooting guide** — nets every NFL player into who to root for / against across your leagues, and flags conflicts (own in one league, facing in another).
- **Games to watch** — live strip of close matchups.
- **Optimal lineup / points left on bench** — per league, the best lineup you could've started vs. what you did.

**Rosters view**
- A full-screen, Sleeper-style grid of every team — position-colored cells, records, values, and **team-strength** ranking — with a **⇄ Trade with** button on every team that opens the Trade Center with that partner selected.

**Player profiles** (click any player, anywhere)
- **Multi-tab window** with a player search, so you can compare several players side by side; each tab remembers its own state.
- **This Week / Live** tab — the player's live box score during their game (targets, catches, yards, carries, TDs, snaps, kicking or defensive stats), the game score and clock, red-zone/possession flags, and fantasy points in PPR / half / standard; refreshes every 20 seconds while the game is on and opens first when you click a player who's mid-game. Stats come from Sleeper's live feed, game state from ESPN.
- **Season position ranks** — two separate ranks at the top of every profile: where the player ranks at his position by **total points** and by **points per game** (PPR), with games played — so an injured star still shows where he stands when he's on the field.
- **Game Log** with a season dropdown, per-game **fantasy points** (including kickers), color-graded stats (heatmap), grouped categories, and a **season-averages** table over games played. **Missed games** (team played, player didn't) appear as red **DNP** rows with zeros, built from the team's schedule. Uses ESPN, with an automatic **Sleeper stats fallback** when ESPN's log is empty.
- **News & Outlook** from ESPN and Sleeper, separated by source.
- **Depth Chart** for the player's NFL team, with the player highlighted.
- **Vegas** tab — DraftKings props: anytime-TD odds and implied over/under lines for passing / rushing / receiving yards.
- **Availability across your leagues** — who rosters the player in each league, or whether he's a free agent.

**League Lab** (per league)
- **Standings & playoff odds** — Monte-Carlo simulation from records, remaining schedule, and team strength.
- **Power rankings** with week-over-week movement.
- **Strength of schedule**, **bye-week planner**, **waivers** (best available + Sleeper trending), **buy-low / sell-high**, **Vegas edge** (implied vs. projection), and a **weekly recap**.

**Trade Center** (per league, also reachable from any team in the rosters view)
- **Deal builder** — any two teams, rosters grouped by position with value, positional rank, 30-day trend, season **points per game**, **snap share**, injuries and **bye weeks**; tap players to build the deal.
- **Lineup impact**, not just value sums — for both sides: change in starting-lineup value, change in this week's projected starters, who enters/leaves the lineup, and roster spots freed/needed.
- **Trade partners rail** — every team ranked by how well their surplus fits your needs (and vice-versa), with needs/depth tags.
- **Finder** — balanced swaps with one partner, a **whole-league scan** (1-for-1, 2-for-1, 1-for-2), or offers for your **★ trade block**; filters for fairness band, "must upgrade my starters", fill-my-needs, target positions, positions to keep out, and **🔒 untouchables**.
- **AI analyst** — evaluates the deal on the board (grades, verdict, what each side gets, risks, lineup impact, a counter-offer you can load with one click, and a ready-to-send pitch), **suggests trades** across the league, or **chats** — "Ask the analyst" is a running conversation per league (saved in your browser) so you can follow up, and every message re-reads the latest league data. Requests keep running while you browse other views; results and chats stay with their league. It's given everything the app knows: league format, standings with playoff odds, schedule and this week's matchups, power rankings, trade history, waivers and trending adds, buy-low / sell-high trends, Vegas edges, byes, every roster with values, season stats and usage, injuries with notes, Vegas props, plus news, outlooks and recent games for the key players (including any player you mention in a question). Every answer includes a **"What the analyst saw"** panel showing the exact data it was sent. Works with your **Claude or ChatGPT account** (via the Claude Code / Codex CLI — no API key) or an Anthropic / OpenAI / OpenAI-compatible API key.
- **Playground** — edit a copy of your roster freely: add any NFL player (free agents, other teams' guys) or remove your own, or apply the deal on the board, and see before → after side by side: roster value, starting-lineup value, this week's projected starters, roster spots vs the league limit, positional strengths, bye-week clusters, and the two optimal lineups with changed slots highlighted. Never touches your real team.
- **League trade history** (completed trades this season), **saved proposals**, and a one-click **copy for league chat**.
- Trade values, ranks, and value **trends** via [FantasyCalc](https://fantasycalc.com) — the trend window is adjustable in ⚙ Settings (3, 7, 14 or 30 days) and applies everywhere a ▲/▼ trend appears, including Buy-low / Sell-high and the AI analyst.

---

## Setup (about 2 minutes, one time)

Works on **macOS, Linux and Windows**. The only requirement is **Python 3.9+** — nothing to `pip install`.

| | Python | Open a terminal |
|---|---|---|
| **macOS** | Already installed (`python3`). | Terminal (⌘ Space → "Terminal") |
| **Linux** | Usually installed (`python3`); otherwise `sudo apt install python3` (Debian/Ubuntu) or `sudo dnf install python3` (Fedora). | Your terminal app |
| **Windows** | Install from [python.org](https://www.python.org/downloads/) and tick **"Add python.exe to PATH"** (or `winget install Python.Python.3.12`). Use `python` (or `py`) where the steps say `python3`. | PowerShell (Start → "PowerShell") |

**0. Get the code**

```bash
git clone https://github.com/Adrian-Ahmetspahic/fantasy-war-room.git
cd fantasy-war-room
```

(No git? Use **Code → Download ZIP** on GitHub, unzip it, and open a terminal in that folder.)

**1. Create your config**

macOS / Linux:

```bash
cp config.example.json config.json
```

Windows (PowerShell):

```powershell
Copy-Item config.example.json config.json
```

Open `config.json` in any text editor and fill it in:

- **Sleeper** — just put your Sleeper **username** under `sleeper.username`. The app
  finds your leagues automatically. (To pin specific leagues instead, leave `username`
  and list `league_ids`.)
- **ESPN** — for each ESPN league add its `league_id` plus two cookies from your
  logged-in ESPN session, `espn_s2` and `SWID`:
  1. Go to `https://fantasy.espn.com` in Chrome/Edge/Firefox, logged in.
  2. Open DevTools (`F12`, or `⌥⌘I` on a Mac) → **Application** tab (Firefox: **Storage**) → **Cookies → `https://fantasy.espn.com`**.
  3. Copy the value of **`espn_s2`** into `espn_s2`, and **`SWID`** (keep the `{ }`) into `swid`.
  4. `league_id` is the `leagueId=` number in your ESPN league URL. The same cookies work for all your ESPN leagues.

> 🔒 `config.json` is git-ignored and never leaves your machine. **Never commit it** — it contains your ESPN session cookies.

**2. Run it**

macOS / Linux:

```bash
python3 server.py
```

Windows:

```powershell
python server.py
```

Open **http://localhost:8787** in your browser. Leave the terminal running during
games; press `Ctrl+C` to stop. The server only listens on your own machine (127.0.0.1).

To use a different port: `PORT=9000 python3 server.py` (macOS/Linux) or
`$env:PORT=9000; python server.py` (PowerShell).

**3. (Optional) Turn on the AI trade analyst**

Click **⚙** in the app and pick how to connect:

- **Claude account** — uses the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
  signed in on your machine; no API key. Needs [Node.js](https://nodejs.org) 18+ (any OS), then:

  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
  and sign in once:

  ```bash
  claude auth login
  ```
- **ChatGPT account** — uses the [Codex CLI](https://github.com/openai/codex) signed in with
  ChatGPT; no API key. Also needs Node.js 18+, then:

  ```bash
  npm install -g @openai/codex
  ```
  and sign in once:

  ```bash
  codex login
  ```
  Pick a model from the dropdown in ⚙ (the list comes from Codex itself; "Auto" tries them until one your plan accepts).
- **API key** — Anthropic, OpenAI, or any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter…). No Node needed.

Neither account option needs an API key; usage counts against that subscription (the Settings
screen shows which account and plan each CLI is signed in to). Settings are saved to the `ai`
block of your local `config.json` (API keys can also come from the `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` environment variables). League data is sent to the provider you picked only
when you press an AI button; an analysis typically takes 20–60 seconds.

**Updating later**

```bash
git pull
```

then restart `server.py`. Your `config.json` is untouched by updates.

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
  players won't have props early in the week or in the offseason. The Vegas lineup
  falls back to site projections for anyone without props (kickers and defenses always).
- **Live feed** plays come from ESPN's play-by-play and are matched to your players by
  name as written in the play text (e.g. "D.Maye"); a defense is tagged on sacks, picks,
  fumble recoveries and safeties against the team it's facing.
- **AI analyst** output is a model's opinion on the data it was given (≈15k tokens per
  request — check the "What the analyst saw" panel). It can be wrong; verify before you
  trade. The account options shell out to the `claude` / `codex` command-line tools and
  count against those subscriptions; API-key options are billed by the provider.
- Season stats (points per game, usage, snap share) come from Sleeper's stats API and
  are matched to ESPN players by id or name; a few players may show no stats.
- Player metadata from Sleeper is cached in `.cache/` and refreshed daily. Trade block,
  untouchables and saved proposals are stored in your browser.

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
- **No warranty.** Projections, win probabilities, trade values, playoff odds and AI
  analysis are estimates and may be wrong. The software is provided "as is", without
  warranty of any kind, as stated in the [LICENSE](LICENSE). Use at your own risk.
- **AI providers.** The optional AI analyst sends league data (rosters, standings, player
  stats and news — never your credentials) to the AI provider you choose — Anthropic,
  OpenAI, or an endpoint you configure — only when you press an AI button, and is subject
  to that provider's terms and pricing. The project is not affiliated with those providers.
- **Your data stays with you.** You supply your own credentials in a local
  `config.json` that is git-ignored and never committed or transmitted anywhere by
  this project. Keep it private.

## License

Released under the [MIT License](LICENSE) — © 2026 Adrian Ahmetspahic.
