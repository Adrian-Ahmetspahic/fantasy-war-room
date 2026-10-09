"""
AI trade analyst (stdlib only).

Builds a compact dossier for a league -- settings, standings, playoff odds,
both rosters with trade values / season stats / injuries / byes, Vegas lines,
news and outlooks for the players in the deal -- and asks an LLM for a
structured verdict, a counter-offer, suggested trades, or an answer to a
free-form question.

Providers: Anthropic (Claude), OpenAI, or any OpenAI-compatible endpoint.
The API key lives in config.json under "ai" (git-ignored) or in the
ANTHROPIC_API_KEY / OPENAI_API_KEY environment variables. It is sent only to
the provider you picked and is never logged.
"""

import json
import os
import re
import shutil
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import fantasy

# "cli" providers shell out to a locally installed, already signed-in CLI
# (Claude Code / Codex), so no API key is needed -- it uses your account login.
PROVIDERS = {
    "claude_cli": {"label": "Claude account (via Claude Code CLI)", "model": "",
                   "cli": "claude", "url": ""},
    "codex_cli": {"label": "ChatGPT account (via Codex CLI)", "model": "gpt-5.5",
                  "cli": "codex", "url": ""},
    "anthropic": {"label": "Anthropic API key", "model": "claude-sonnet-5-5",
                  "url": "https://api.anthropic.com/v1/messages"},
    "openai": {"label": "OpenAI API key", "model": "gpt-5",
               "url": "https://api.openai.com/v1/chat/completions"},
    "custom": {"label": "OpenAI-compatible endpoint + key", "model": "",
               "url": ""},
}
CLI_PROVIDERS = ("claude_cli", "codex_cli")


def cli_path(provider):
    return shutil.which(PROVIDERS[provider]["cli"]) if provider in CLI_PROVIDERS else None

NEED_POS = ("QB", "RB", "WR", "TE")


# --------------------------------------------------------------------------
# settings
# --------------------------------------------------------------------------
def settings_from(cfg):
    ai = (cfg or {}).get("ai") or {}
    provider = ai.get("provider")
    if provider not in PROVIDERS:
        # sensible default: a signed-in CLI if present, else whichever key env has
        provider = ("claude_cli" if cli_path("claude_cli")
                    else "codex_cli" if cli_path("codex_cli")
                    else "anthropic" if os.environ.get("ANTHROPIC_API_KEY")
                    else "openai" if os.environ.get("OPENAI_API_KEY") else "anthropic")
    key = ai.get("api_key") or ""
    if not key and provider not in CLI_PROVIDERS:
        key = (os.environ.get("ANTHROPIC_API_KEY") if provider == "anthropic"
               else os.environ.get("OPENAI_API_KEY") if provider in ("openai", "custom")
               else "") or ""
    return {
        "provider": provider,
        "api_key": key,
        "model": ai.get("model") or PROVIDERS[provider]["model"],
        "base_url": (ai.get("base_url") or "").rstrip("/"),
        "from_env": bool(key and not ai.get("api_key")),
    }


def public_status(s):
    k = s.get("api_key") or ""
    p = s["provider"]
    configured = bool(cli_path(p)) if p in CLI_PROVIDERS else bool(k)
    return {
        "configured": configured,
        "provider": p,
        "model": s["model"],
        "base_url": s["base_url"],
        "from_env": s.get("from_env", False),
        "key_hint": ("…" + k[-4:]) if len(k) >= 8 else ("set" if k else ""),
        "cli": {name: bool(cli_path(name)) for name in CLI_PROVIDERS},
        "providers": {name: {"label": v["label"], "model": v["model"], "cli": name in CLI_PROVIDERS}
                      for name, v in PROVIDERS.items()},
    }


# --------------------------------------------------------------------------
# dossier
# --------------------------------------------------------------------------
def _all(t):
    return [p for p in (t.get("players") or []) + (t.get("bench") or [])
            if p.get("name") and p["name"] != "(empty)"]


def _pline(p):
    bits = [f"{p['name']} ({p.get('pos') or '?'}, {p.get('team') or 'FA'})"]
    if p.get("starter") and p.get("slot"):
        bits.append(f"starts at {p['slot']}")
    if p.get("value") is not None:
        v = f"value {p['value']}"
        if p.get("pos_rank"):
            v += f" ({p.get('pos')}{p['pos_rank']})"
        bits.append(v)
    if p.get("trend"):
        bits.append(f"30d {'+' if p['trend'] > 0 else ''}{p['trend']}")
    if p.get("ppg") is not None:
        bits.append(f"{p['ppg']} ppg over {p.get('gp')} gms")
    if p.get("snap_pct") is not None:
        bits.append(f"{p['snap_pct']}% snaps")
    if p.get("projected") is not None:
        bits.append(f"this wk proj {p['projected']}")
    if p.get("injury"):
        bits.append(f"INJURY {p['injury']}")
    if p.get("bye"):
        bits.append(f"bye wk {p['bye']}")
    return " | ".join(bits)


def _pos_profile(teams, t):
    """Positional value vs league average -> (needs, surplus) text."""
    n = max(len(teams), 1)
    avg = {p: 0.0 for p in NEED_POS}
    for x in teams:
        for pl in _all(x):
            if pl.get("pos") in avg and pl.get("value"):
                avg[pl["pos"]] += pl["value"]
    mine = {p: 0.0 for p in NEED_POS}
    for pl in _all(t):
        if pl.get("pos") in mine and pl.get("value"):
            mine[pl["pos"]] += pl["value"]
    parts, needs, surplus = [], [], []
    for p in NEED_POS:
        a = avg[p] / n
        parts.append(f"{p} {mine[p]:.0f} (lg avg {a:.0f})")
        if a and mine[p] < a * 0.8:
            needs.append(p)
        elif a and mine[p] > a * 1.2:
            surplus.append(p)
    return ", ".join(parts), needs, surplus


def _team_block(label, t, teams, lab_row=None, full=True):
    rec = t.get("record") or ""
    extra = []
    if t.get("pf") is not None:
        extra.append(f"PF {t['pf']}, PA {t.get('pa')}")
    if t.get("strength_rank"):
        extra.append(f"roster strength #{t['strength_rank']}/{len(teams)}")
    if lab_row:
        if lab_row.get("playoff_pct") is not None:
            extra.append(f"playoff odds {lab_row['playoff_pct']}%")
        if lab_row.get("movement"):
            extra.append(f"power-rank move {'+' if lab_row['movement'] > 0 else ''}{lab_row['movement']}")
    prof, needs, surplus = _pos_profile(teams, t)
    lines = [f"## {label}: {t['name']}{' (YOU)' if t.get('is_me') else ''} — {rec}"
             + (" — " + ", ".join(extra) if extra else ""),
             f"Positional value: {prof}",
             f"Needs: {', '.join(needs) or 'none obvious'} · Surplus: {', '.join(surplus) or 'none'}"]
    if full:
        lines.append("Starters:")
        lines += ["  - " + _pline(p) for p in (t.get("players") or []) if p.get("name") and p["name"] != "(empty)"]
        lines.append("Bench:")
        lines += ["  - " + _pline(p) for p in (t.get("bench") or [])]
    else:
        tops = sorted(_all(t), key=lambda p: -(p.get("value") or 0))
        lines.append("Roster (by value): " + "; ".join(
            f"{p['name']} {p.get('pos')} {p.get('value') or 0}"
            + (f" {p['injury']}" if p.get("injury") else "") for p in tops))
    return "\n".join(lines)


def _recent_form(gl, n=4):
    rows = (gl or {}).get("rows") or []
    cols = (gl or {}).get("columns") or []
    fi = next((i for i, c in enumerate(cols) if c.get("name") == "fpts"), None)
    if fi is None:
        return None
    out = []
    for r in rows[-n:]:
        try:
            out.append(f"wk{r.get('week')}: {float(r['values'][fi]):.1f}")
        except (TypeError, ValueError, IndexError):
            continue
    return ", ".join(out) if out else None


def _player_dossier(p, season):
    """News, outlook, Vegas, recent games for one player (network, parallel)."""
    name, team, pos = p.get("name"), p.get("team"), p.get("pos")
    sid = fantasy._sid_for(p)
    eid = p.get("espn_id")
    if not eid and team and name and pos not in ("DEF", "D/ST"):
        try:
            eid = fantasy.espn_athlete_id_by_name(name, team)
        except Exception:
            eid = None
    jobs = {}
    with ThreadPoolExecutor(max_workers=5) as ex:
        if eid:
            jobs["enews"] = ex.submit(fantasy.espn_news, eid, 3)
        if sid:
            jobs["snews"] = ex.submit(fantasy.sleeper_news, sid, 3)
            jobs["outlook"] = ex.submit(fantasy.sleeper_outlook, sid, season)
        if eid or sid:
            jobs["gl"] = ex.submit(fantasy.player_gamelog, eid, sid, None)
        jobs["odds"] = ex.submit(fantasy.player_odds, name, team, pos)
        vals = {}
        for k, f in jobs.items():
            try:
                vals[k] = f.result()
            except Exception as e:
                vals[k] = None
    lines = [f"### {name} ({pos}, {team})", "  " + _pline(p)]
    form = _recent_form(vals.get("gl"))
    if form:
        lines.append(f"  Recent fantasy points: {form}")
    for src, key in (("ESPN", "enews"), ("Sleeper", "snews")):
        for it in (vals.get(key) or [])[:3]:
            h = (it.get("headline") or "").strip()
            b = (it.get("body") or "").strip()
            if b and b != h:
                b = b[:260].rstrip() + ("…" if len(b) > 260 else "")
                lines.append(f"  News ({src}): {h} — {b}")
            elif h:
                lines.append(f"  News ({src}): {h}")
    o = vals.get("outlook")
    if o and (o.get("body") or o.get("headline")):
        txt = (o.get("body") or o.get("headline")).strip()
        lines.append("  Season outlook (Sleeper): " + txt[:500].rstrip() + ("…" if len(txt) > 500 else ""))
    od = vals.get("odds")
    if od and od.get("found"):
        v = []
        if od.get("td"):
            v.append(f"anytime TD {od['td']}")
        for m in od.get("markets") or []:
            if m.get("line") is not None:
                v.append(f"{m['stat']} O/U {m['line']}")
        if v:
            lines.append("  Vegas this week (DraftKings): " + ", ".join(v))
    return "\n".join(lines)


def _find_players(team, wanted):
    """Match requested players (dicts with ids/name) to the team's roster."""
    pool = _all(team)
    out = []
    for w in wanted or []:
        hit = None
        for p in pool:
            if w.get("sleeper_id") and p.get("sleeper_id") and str(w["sleeper_id"]) == str(p["sleeper_id"]):
                hit = p
            elif w.get("espn_id") and p.get("espn_id") and str(w["espn_id"]) == str(p["espn_id"]):
                hit = p
            elif w.get("name") and p.get("name") and w["name"].strip().lower() == p["name"].strip().lower():
                hit = p
            if hit:
                break
        if hit:
            out.append(hit)
    return out


def build_dossier(rosters, lab, a_id, b_id, give, get, mode, prefs):
    teams = rosters.get("teams") or []
    by_id = {str(t.get("id")): t for t in teams}
    A = by_id.get(str(a_id)) or next((t for t in teams if t.get("is_me")), teams[0])
    B = by_id.get(str(b_id)) if b_id is not None else None
    lab_rows = {r["name"]: r for r in ((lab or {}).get("teams") or [])}
    sc = rosters.get("scoring") or {}
    season = rosters.get("season")
    week = rosters.get("week")

    head = [f"# League: {rosters.get('league_name')} ({rosters.get('provider')}) — {season} week {week}",
            f"Format: {sc.get('teams')} teams, {'superflex' if sc.get('num_qbs', 1) > 1 else '1QB'}, "
            f"{'full PPR' if sc.get('ppr', 1) >= 1 else 'half PPR' if sc.get('ppr') else 'standard'}, "
            f"{'dynasty' if sc.get('dynasty') else 'redraft'}; "
            f"{sc.get('playoff_teams')} playoff teams, playoffs start week {sc.get('playoff_start')}.",
            f"Lineup slots: {', '.join(rosters.get('slots') or [])}",
            "Trade values are FantasyCalc market values (higher = better; roughly linear). "
            "ppg = season fantasy points per game in this league's scoring format."]

    stand = []
    for r in ((lab or {}).get("teams") or []):
        stand.append(f"  {r.get('name')}{' (YOU)' if r.get('is_me') else ''}: {r.get('wins')}-{r.get('losses')}"
                     f"{'-' + str(r['ties']) if r.get('ties') else ''}, PF {r.get('pf')}, "
                     f"strength #{r.get('strength_rank')}, playoff {r.get('playoff_pct')}%")
    if not stand:
        for t in sorted(teams, key=lambda x: (-(x.get('wins') or 0), -(x.get('pf') or 0))):
            stand.append(f"  {t['name']}{' (YOU)' if t.get('is_me') else ''}: {t.get('record')}, "
                         f"PF {t.get('pf')}, strength #{t.get('strength_rank')}")
    sos = {s["name"]: s for s in ((lab or {}).get("sos") or [])}

    parts = ["\n".join(head), "## Standings\n" + "\n".join(stand)]
    if sos:
        parts.append("## Remaining schedule difficulty (avg opponent roster value, lower = easier)\n"
                     + "\n".join(f"  {n}: {s.get('opp_value')} over {s.get('games')} games" for n, s in sos.items()))

    parts.append(_team_block("Team A", A, teams, lab_rows.get(A["name"]), full=True))
    if B is not None:
        parts.append(_team_block("Team B", B, teams, lab_rows.get(B["name"]), full=True))

    involved = []
    if mode == "evaluate":
        give_p, get_p = _find_players(A, give), _find_players(B, get) if B else []
        parts.append("## Proposed trade\n"
                     f"Team A ({A['name']}) sends: " + (", ".join(p['name'] for p in give_p) or "nothing") + "\n"
                     f"Team B ({B['name'] if B else '?'}) sends: " + (", ".join(p['name'] for p in get_p) or "nothing"))
        involved = give_p + get_p
    else:
        others = [t for t in teams if t is not A and (B is None or t is B)]
        if others:
            parts.append("## Other teams" + (" (potential partners)" if B is None else ""))
            for t in others:
                parts.append(_team_block("Team", t, teams, lab_rows.get(t["name"]), full=(t is B)))
        # deep-dive on A's most valuable + any explicitly selected players
        sel = _find_players(A, give)
        tops = sorted(_all(A), key=lambda p: -(p.get("value") or 0))[:4]
        seen = set()
        for p in sel + tops:
            if id(p) not in seen:
                seen.add(id(p))
                involved.append(p)
        involved = involved[:6]

    if involved:
        with ThreadPoolExecutor(max_workers=4) as ex:
            dossiers = list(ex.map(lambda p: _safe_dossier(p, season), involved))
        parts.append("## Player intel (news, outlook, Vegas, recent form)\n" + "\n".join(d for d in dossiers if d))

    pref_lines = []
    if prefs.get("want"):
        pref_lines.append("Positions Team A wants to acquire: " + ", ".join(prefs["want"]))
    if prefs.get("exclude"):
        pref_lines.append("Positions Team A will NOT trade or take: " + ", ".join(prefs["exclude"]))
    if prefs.get("block"):
        pref_lines.append("Team A's trade block (players they are shopping): " + ", ".join(prefs["block"]))
    if prefs.get("untouchable"):
        pref_lines.append("Team A's untouchables: " + ", ".join(prefs["untouchable"]))
    if prefs.get("notes"):
        pref_lines.append("Manager notes: " + str(prefs["notes"])[:600])
    if pref_lines:
        parts.append("## Manager preferences\n" + "\n".join(pref_lines))
    return "\n\n".join(parts), A, B


def _safe_dossier(p, season):
    try:
        return _player_dossier(p, season)
    except Exception as e:
        return f"### {p.get('name')} — intel unavailable ({e})"


# --------------------------------------------------------------------------
# prompts
# --------------------------------------------------------------------------
SYSTEM = (
    "You are a sharp, honest fantasy football trade analyst advising Team A's manager. "
    "You reason like an experienced league-winner: starting-lineup impact beats raw value sums, "
    "2-for-1s that consolidate value usually favor the side getting the best player, "
    "roster construction and bye weeks matter, injuries and news change value fast, "
    "contenders should trade future value for current production and rebuilders the reverse. "
    "Use ONLY the data provided; do not invent stats. Be specific and concise. "
    "Always answer with a single JSON object and nothing else -- no prose outside the JSON."
)

SCHEMAS = {
    "evaluate": """{
  "verdict": "accept" | "reject" | "counter",
  "winner": "A" | "B" | "even",
  "grade_a": "letter grade for Team A's side, e.g. B+",
  "grade_b": "letter grade for Team B's side",
  "confidence": 0-100,
  "headline": "one punchy sentence",
  "summary": "3-5 sentences of reasoning for Team A's manager",
  "for_a": ["what Team A gains, up to 4 bullets"],
  "for_b": ["what Team B gains, up to 4 bullets"],
  "risks": ["key risks / things that could make this age badly, up to 4"],
  "lineup_impact": "how each starting lineup changes this week and rest of season",
  "counter": {"give": ["exact player names Team A sends"], "get": ["exact names Team A receives"], "why": "one or two sentences"} or null,
  "pitch": "a short, friendly, persuasive message Team A could send Team B's manager to sell this deal (2-4 sentences)"
}""",
    "suggest": """{
  "strategy": "2-3 sentences on what Team A should be doing given standings, needs and schedule",
  "needs": ["Team A's biggest needs, short phrases"],
  "proposals": [
    {
      "team": "exact partner team name",
      "give": ["exact player names Team A sends"],
      "get": ["exact player names Team A receives"],
      "why": "2-3 sentences: why it helps Team A and why the partner would say yes",
      "fairness": "even" | "slightly favors A" | "slightly favors partner" | "favors A" | "favors partner",
      "likelihood": 0-100
    }
  ]
}
Give 3-5 proposals, best first, across different partners where sensible. Only use players that appear in the rosters above, with their exact names.""",
    "ask": """{
  "answer": "your answer in plain text (short paragraphs; you may use '-' bullets)",
  "proposal": {"team": "exact partner team name", "give": ["exact names A sends"], "get": ["exact names A receives"]} or null
}""",
}


def _user_prompt(mode, dossier, question):
    if mode == "evaluate":
        task = ("Evaluate the proposed trade for Team A. Weigh starting-lineup impact (this week and rest of season), "
                "depth, positional need, playoff position, injuries/news, Vegas usage signals and market value. "
                "If it is close or bad for A, propose a realistic counter using exact roster names.")
    elif mode == "suggest":
        task = ("Find the best realistic trades Team A can make in this league right now, respecting the manager "
                "preferences. Target partners whose needs match A's surplus. Prefer deals that upgrade A's starting lineup.")
    else:
        task = "Answer the manager's question using the league data. Question: " + (question or "").strip()[:1200]
    return (f"{task}\n\nRespond with JSON exactly in this shape:\n{SCHEMAS[mode]}\n\n"
            f"=== LEAGUE DATA ===\n{dossier}")


# --------------------------------------------------------------------------
# provider calls
# --------------------------------------------------------------------------
def _http_post(url, headers, body, timeout=150):
    data = json.dumps(body).encode("utf-8")
    h = {"Content-Type": "application/json", "Accept": "application/json",
         "User-Agent": fantasy.UA}
    h.update(headers)
    req = urllib.request.Request(url, headers=h, data=data, method="POST")
    ctx = fantasy._SSL_CTX
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")
            try:
                j = json.loads(detail)
                detail = (j.get("error") or {}).get("message") or j.get("message") or detail
            except Exception:
                pass
        except Exception:
            detail = ""
        raise RuntimeError(f"{e.code} from provider: {str(detail)[:300]}")
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
            with urllib.request.urlopen(req, timeout=timeout,
                                        context=fantasy._SSL_UNVERIFIED) as resp:
                return json.loads(resp.read().decode("utf-8"))
        raise RuntimeError(f"could not reach provider: {e.reason}")


def _cli_env():
    env = dict(os.environ)
    for k in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"):   # allow running from inside a Claude Code session
        env.pop(k, None)
    return env


def _run_cli(cmd, stdin_text, timeout=240):
    try:
        r = subprocess.run(cmd, input=stdin_text, capture_output=True, text=True,
                           timeout=timeout, env=_cli_env(), cwd=tempfile.gettempdir())
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{cmd[0]} timed out after {timeout}s")
    return r


def _call_claude_cli(s, system, user):
    exe = cli_path("claude_cli")
    if not exe:
        raise RuntimeError("Claude Code CLI not found. Install it (npm i -g @anthropic-ai/claude-code) "
                           "and run `claude` once to sign in with your Claude account.")
    cmd = [exe, "-p", "--output-format", "json", "--system-prompt", system, "--tools", ""]
    if s.get("model"):
        cmd += ["--model", s["model"]]
    r = _run_cli(cmd, user)
    out = (r.stdout or "").strip()
    try:
        j = json.loads(out[out.index("{"):]) if "{" in out else {}
    except ValueError:
        j = {}
    text = j.get("result") if isinstance(j, dict) else None
    if r.returncode != 0 or not text or (isinstance(j, dict) and j.get("is_error")):
        msg = text or (r.stderr or out or "no output").strip()
        if "authenticate" in msg.lower() or "login" in msg.lower() or "oauth" in msg.lower():
            msg += "  → Open a terminal, run `claude`, and sign in with your Claude account, then retry."
        raise RuntimeError(f"Claude CLI: {msg[:400]}")
    u = j.get("usage") or {}
    return text, {"in": u.get("input_tokens"), "out": u.get("output_tokens"),
                  "cost_usd": j.get("total_cost_usd")}


def _call_codex_cli(s, system, user):
    exe = cli_path("codex_cli")
    if not exe:
        raise RuntimeError("Codex CLI not found. Install it (npm i -g @openai/codex) and run "
                           "`codex login` to sign in with your ChatGPT account.")
    fd, outp = tempfile.mkstemp(prefix="codex_", suffix=".txt")
    os.close(fd)
    cmd = [exe, "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
           "--color", "never", "-o", outp]
    if s.get("model"):
        cmd += ["-m", s["model"]]
    cmd.append("-")
    try:
        r = _run_cli(cmd, system + "\n\n" + user)
        try:
            with open(outp) as f:
                text = f.read().strip()
        except OSError:
            text = ""
    finally:
        try:
            os.unlink(outp)
        except OSError:
            pass
    if not text:
        log = (r.stderr or "") + (r.stdout or "")
        m = re.search(r'"message":"([^"]+)"', log)
        msg = m.group(1) if m else (log.strip().splitlines() or ["no output"])[-1]
        if "not supported" in msg or "requires a newer version" in msg:
            msg += "  → Set a model your Codex plan supports in ⚙ Settings (e.g. gpt-5.1-codex), or update Codex."
        if "login" in msg.lower() or "auth" in msg.lower():
            msg += "  → Run `codex login` in a terminal to sign in with ChatGPT, then retry."
        raise RuntimeError(f"Codex CLI: {msg[:400]}")
    return text, {}


def _call_llm(s, system, user):
    provider, key, model = s["provider"], s["api_key"], s["model"]
    if provider == "claude_cli":
        return _call_claude_cli(s, system, user)
    if provider == "codex_cli":
        return _call_codex_cli(s, system, user)
    if not key:
        raise RuntimeError("No API key configured. Add one under ⚙ Settings → AI analyst, "
                           "or switch to your Claude / ChatGPT account login.")
    if provider == "anthropic":
        j = _http_post(PROVIDERS["anthropic"]["url"],
                       {"x-api-key": key, "anthropic-version": "2023-06-01"},
                       {"model": model, "max_tokens": 3000, "system": system,
                        "messages": [{"role": "user", "content": user}]})
        text = "".join(c.get("text", "") for c in j.get("content", []) if c.get("type") == "text")
        usage = j.get("usage") or {}
        return text, {"in": usage.get("input_tokens"), "out": usage.get("output_tokens")}
    url = (s["base_url"] + "/chat/completions") if provider == "custom" and s["base_url"] \
        else PROVIDERS["openai"]["url"]
    body = {"model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if provider == "openai":
        body["response_format"] = {"type": "json_object"}
    j = _http_post(url, {"Authorization": f"Bearer {key}"}, body)
    text = (((j.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""
    usage = j.get("usage") or {}
    return text, {"in": usage.get("prompt_tokens"), "out": usage.get("completion_tokens")}


def _parse_json(text):
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except Exception:
        pass
    i, j = t.find("{"), t.rfind("}")
    if i >= 0 and j > i:
        return json.loads(t[i:j + 1])
    raise ValueError("model did not return JSON")


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------
def analyze(cfg, rosters, lab, req):
    s = settings_from(cfg)
    mode = req.get("mode") or "evaluate"
    if mode not in SCHEMAS:
        mode = "evaluate"
    t0 = time.time()
    dossier, A, B = build_dossier(rosters, lab, req.get("a_id"), req.get("b_id"),
                                  req.get("give") or [], req.get("get") or [], mode,
                                  req.get("prefs") or {})
    text, usage = _call_llm(s, SYSTEM, _user_prompt(mode, dossier, req.get("question")))
    try:
        result = _parse_json(text)
    except Exception:
        result = {"answer": text} if mode == "ask" else {"error": "The model's reply was not valid JSON.",
                                                         "raw": text[:2000]}
    return {"ok": "error" not in result, "mode": mode, "result": result,
            "provider": s["provider"], "model": s["model"], "usage": usage,
            "a": A.get("name"), "b": B.get("name") if B else None,
            "secs": round(time.time() - t0, 1),
            "dossier_chars": len(dossier)}
