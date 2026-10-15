"""
Data layer for the multi-league fantasy football dashboard.

Talks to three sources, all read-only:
  * Sleeper   -- public API, no auth            (your Sleeper leagues)
  * ESPN      -- private API, needs cookies     (your ESPN leagues)
  * ESPN NFL scoreboard -- public API, no auth  (real NFL game status + red zone)

Nothing here is written back anywhere. It only reads.
"""

import json
import os
import ssl
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, ".cache")
os.makedirs(CACHE_DIR, exist_ok=True)

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) fantasy-dashboard/1.0"


def _make_ssl_context():
    """The python.org macOS build ships without a usable trust store, so the
    default context can't verify certs. Try a real CA bundle in priority order;
    only as a last resort fall back to an unverified context (these are public,
    read-only endpoints hit from your own machine)."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    for p in ("/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem",
              "/opt/homebrew/etc/openssl@3/cert.pem",
              "/usr/local/etc/openssl@3/cert.pem"):
        if os.path.exists(p):
            try:
                return ssl.create_default_context(cafile=p)
            except Exception:
                continue
    try:
        return ssl.create_default_context()
    except Exception:
        return None


_SSL_CTX = _make_ssl_context()
_SSL_UNVERIFIED = ssl._create_unverified_context()


# --------------------------------------------------------------------------
# tiny HTTP helper
# --------------------------------------------------------------------------
def _get_json(url, cookies=None, timeout=15, retries=2, headers=None):
    """GET + parse JSON, retrying transient failures. Sleeper/ESPN
    intermittently return 404/5xx or time out under load (e.g. kickoff day);
    a couple of quick retries stops those blips from crashing a whole card."""
    hdrs = {"User-Agent": UA, "Accept": "application/json"}
    if cookies:
        hdrs["Cookie"] = cookies
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    last = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            if isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
                try:
                    with urllib.request.urlopen(req, timeout=timeout,
                                                context=_SSL_UNVERIFIED) as resp:
                        return json.loads(resp.read().decode("utf-8"))
                except Exception as e2:
                    last = e2
            else:
                last = e
        except Exception as e:
            last = e
        if attempt < retries:
            time.sleep(0.4 * (attempt + 1))
    raise last


def _post_json(url, payload, headers=None, timeout=15):
    body = json.dumps(payload).encode("utf-8")
    h = {"User-Agent": UA, "Accept": "application/json",
         "Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h, data=body)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
            with urllib.request.urlopen(req, timeout=timeout,
                                        context=_SSL_UNVERIFIED) as resp:
                return json.loads(resp.read().decode("utf-8"))
        raise


# --------------------------------------------------------------------------
# NFL real-game state (ESPN public scoreboard)  -> drives player game status
# --------------------------------------------------------------------------
# Normalize the various team-abbreviation spellings to one canonical form so
# Sleeper / ESPN-fantasy / ESPN-scoreboard all line up.
TEAM_ALIAS = {
    "WSH": "WAS", "WFT": "WAS",
    "JAC": "JAX",
    "LA": "LAR",
    "SD": "LAC", "OAK": "LV", "STL": "LAR",
    "ARZ": "ARI", "BLT": "BAL", "CLV": "CLE", "HST": "HOU",
}


def canon_team(abbr):
    if not abbr:
        return ""
    a = abbr.upper()
    return TEAM_ALIAS.get(a, a)


# Injury / availability status -> short code shown on player rows.
_INJURY = {
    "QUESTIONABLE": "Q", "DOUBTFUL": "D", "OUT": "O",
    "IR": "IR", "INJURY_RESERVE": "IR",
    "SUS": "SUS", "SUSPENSION": "SUS", "PUP": "PUP",
    "DAY_TO_DAY": "DTD", "DTD": "DTD", "COV": "COV", "COVID": "COV",
    "NA": "NA", "DNR": "DNR", "PROBABLE": "P",
}


def _injury_code(s):
    if not s:
        return None
    key = str(s).upper().replace(" ", "_")
    if key in ("ACTIVE", "NORMAL", ""):
        return None
    return _INJURY.get(key, str(s)[:3].upper())


_nfl_cache = {"ts": 0, "data": {}}


def nfl_game_status(force=False):
    """Return {TEAM: {status, detail, redzone}} for every team playing this week.

    status is one of: 'pre' (yet to play), 'in' (live), 'post' (final).
    """
    now = time.time()
    if not force and _nfl_cache["ts"] and now - _nfl_cache["ts"] < 15:
        return _nfl_cache["data"]

    out = {}
    try:
        sb = _get_json(
            "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
        )
        for event in sb.get("events", []):
            comp = (event.get("competitions") or [{}])[0]
            state = (comp.get("status") or {}).get("type", {}).get("state", "pre")
            detail = (comp.get("status") or {}).get("type", {}).get("shortDetail", "")
            situation = comp.get("situation") or {}
            rz = bool(situation.get("isRedZone"))
            # team that currently has possession (for red-zone attribution)
            poss_id = situation.get("possession")
            comps = []
            for c in comp.get("competitors", []):
                team = c.get("team", {})
                abbr = canon_team(team.get("abbreviation"))
                if abbr:
                    comps.append((abbr, c.get("homeAway"), team))
            scores = {}
            for c in comp.get("competitors", []):
                a = canon_team((c.get("team") or {}).get("abbreviation"))
                try:
                    scores[a] = int(c.get("score") or 0)
                except (TypeError, ValueError):
                    scores[a] = 0
            for i, (abbr, ha, team) in enumerate(comps):
                other = comps[1 - i][0] if len(comps) == 2 else None
                out[abbr] = {
                    "status": state,
                    "detail": detail,
                    "redzone": rz and str(team.get("id")) == str(poss_id),
                    "opp": other,
                    "ha": "@" if ha == "away" else "vs",
                    "event": event.get("id"),
                    "pts": scores.get(abbr, 0),
                    "opp_pts": scores.get(other, 0) if other else None,
                    "possession": str(team.get("id")) == str(poss_id),
                }
    except Exception as e:  # scoreboard is best-effort; never fatal
        print(f"[nfl] scoreboard fetch failed: {e}")

    _nfl_cache["ts"] = now
    _nfl_cache["data"] = out
    return out


# --------------------------------------------------------------------------
# Sleeper
# --------------------------------------------------------------------------
SLEEPER = "https://api.sleeper.app/v1"


def sleeper_state():
    return _get_json(f"{SLEEPER}/state/nfl")


def sleeper_players():
    """Player metadata is ~5MB; cache to disk and refresh once a day."""
    path = os.path.join(CACHE_DIR, "sleeper_players.json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 86400:
        with open(path) as f:
            return json.load(f)
    data = _get_json(f"{SLEEPER}/players/nfl", timeout=40)
    with open(path, "w") as f:
        json.dump(data, f)
    return data


def sleeper_user_id(username):
    u = _get_json(f"{SLEEPER}/user/{username}")
    return u["user_id"]


def sleeper_discover_leagues(user_id, season):
    return _get_json(f"{SLEEPER}/user/{user_id}/leagues/nfl/{season}")


_sleeper_proj_cache = {}


def _sleeper_projections(season, week, scoring):
    """Best-effort projections from Sleeper's (undocumented) projections API."""
    key = (season, week, scoring)
    if key in _sleeper_proj_cache:
        return _sleeper_proj_cache[key]
    field = {1: "pts_ppr", 0.5: "pts_half_ppr", 0: "pts_std"}.get(scoring, "pts_ppr")
    out = {}
    try:
        url = (
            f"https://api.sleeper.com/projections/nfl/{season}/{week}"
            f"?season_type=regular"
        )
        data = _get_json(url, timeout=20)
        for row in data:
            pid = row.get("player_id")
            stats = row.get("stats") or {}
            if pid is not None and field in stats:
                out[str(pid)] = round(stats[field], 2)
    except Exception as e:
        print(f"[sleeper] projections unavailable: {e}")
    _sleeper_proj_cache[key] = out
    return out


POS_SLEEPER = {"QB", "RB", "WR", "TE", "K", "DEF"}


# ---- live current-week box-score stat lines -------------------------------
_WSTATS = {"ts": 0, "data": {}}
_E2S = {"ts": 0, "map": {}}


def _cur_week_stats():
    """Bulk current-week box stats for every player, keyed by Sleeper id.
    Cached ~20s; updates live during games."""
    now = time.time()
    if _WSTATS["ts"] and now - _WSTATS["ts"] < 20:   # cache even an empty week
        return _WSTATS["data"]
    data = _WSTATS.get("data") or {}
    try:
        st = sleeper_state()
        season = st.get("season")
        wk = st.get("display_week") or st.get("week") or 1
        rows = _get_json(f"https://api.sleeper.com/stats/nfl/{season}/{wk}"
                         f"?season_type=regular", timeout=20)
        data = {str(r.get("player_id")): (r.get("stats") or {})
                for r in rows if r.get("player_id")}
        _WSTATS["wk"] = int(wk)
    except Exception as e:
        print(f"[stats] week stats failed: {e}")
    _WSTATS["ts"], _WSTATS["data"] = now, data
    return data


def _sl_apply_live_points(matchups, rosters, scoring_settings, week):
    """Sleeper's /matchups points lag the live stats feed by a minute or more.
    Re-score every player from the live box stats with the league's own
    scoring settings (this reproduces Sleeper's totals exactly), keeping the
    matchup value for anyone the stats feed doesn't list."""
    ws = _cur_week_stats()
    if not ws or not scoring_settings or _WSTATS.get("wk") != int(week):
        return
    roster_players = {r["roster_id"]: (r.get("players") or []) for r in rosters}
    for m in matchups:
        pp = dict(m.get("players_points") or {})
        starters = [str(s) for s in (m.get("starters") or [])]
        ids = set(starters) | {str(p) for p in (m.get("players") or [])} \
            | {str(p) for p in roster_players.get(m.get("roster_id"), [])}
        for pid in ids:
            s = ws.get(pid)
            if s:
                pp[pid] = round(sum(v * scoring_settings[k] for k, v in s.items()
                                    if k in scoring_settings
                                    and isinstance(v, (int, float))), 2)
        m["players_points"] = pp
        m["points"] = round(sum(pp.get(s) or 0 for s in starters if s != "0"), 2)


def _espn_to_sleeper_map():
    now = time.time()
    if now - _E2S["ts"] < 3600 and _E2S["map"]:
        return _E2S["map"]
    m = {}
    try:
        for pid, meta in sleeper_players().items():
            eid = meta.get("espn_id")
            if eid:
                m[str(eid)] = str(pid)
    except Exception as e:
        print(f"[stats] espn->sleeper map failed: {e}")
    _E2S["ts"], _E2S["map"] = now, m
    return m


def _num(v):
    if v is None:
        return 0
    try:
        f = float(v)
        return int(f) if f == int(f) else round(f, 1)
    except (TypeError, ValueError):
        return v


def _statline(pos, s):
    """Compact current-game box line for a player, or None."""
    if not s:
        return None
    pos = (pos or "").upper()
    P = []

    def i(k):
        return _num(s.get(k) or 0)

    if pos == "QB":
        if s.get("pass_att"):
            P.append(f"{i('pass_cmp')}/{i('pass_att')} {i('pass_yd')} yd")
        if s.get("pass_td"):
            P.append(f"{i('pass_td')} TD")
        if s.get("pass_int"):
            P.append(f"{i('pass_int')} INT")
        if s.get("rush_yd") or s.get("rush_td"):
            P.append(f"{i('rush_att')}-{i('rush_yd')} rush"
                     + (f", {i('rush_td')} TD" if s.get("rush_td") else ""))
    elif pos == "RB":
        if s.get("rush_att") or s.get("rush_yd"):
            P.append(f"{i('rush_att')} car {i('rush_yd')} yd"
                     + (f", {i('rush_td')} TD" if s.get("rush_td") else ""))
        if s.get("rec") or s.get("rec_tgt"):
            P.append(f"{i('rec')}/{i('rec_tgt')} {i('rec_yd')} yd"
                     + (f", {i('rec_td')} TD" if s.get("rec_td") else ""))
    elif pos in ("WR", "TE"):
        P.append(f"{i('rec')}/{i('rec_tgt')} {i('rec_yd')} yd"
                 + (f", {i('rec_td')} TD" if s.get("rec_td") else ""))
        if s.get("rush_yd") or s.get("rush_td"):
            P.append(f"{i('rush_att')}-{i('rush_yd')} rush"
                     + (f", {i('rush_td')} TD" if s.get("rush_td") else ""))
    elif pos == "K":
        if s.get("fga") is not None or s.get("xpa") is not None:
            P.append(f"{i('fgm')}/{i('fga')} FG, {i('xpm')}/{i('xpa')} XP")
    elif pos in ("DEF", "D/ST"):
        if s.get("sack"):
            P.append(f"{i('sack')} sk")
        if s.get("int"):
            P.append(f"{i('int')} INT")
        fr = s.get("def_st_fum_rec") or s.get("fum_rec")
        if fr:
            P.append(f"{_num(fr)} FR")
        if s.get("def_td") or s.get("def_st_td"):
            P.append(f"{i('def_td')} TD")
        if s.get("pts_allow") is not None:
            P.append(f"{i('pts_allow')} PA")
    return " · ".join(P) or None


_SNAME = {"ts": 0, "nt": {}, "nm": {}}


def _sleeper_name_index():
    """name+team (and unambiguous name-only) -> Sleeper id, for resolving ESPN
    players that Sleeper has no espn_id for."""
    now = time.time()
    if now - _SNAME["ts"] < 3600 and _SNAME["nt"]:
        return _SNAME
    nt, nm, dup = {}, {}, set()
    try:
        for pid, meta in sleeper_players().items():
            if meta.get("position") == "DEF":
                continue
            n = _norm_name(meta.get("full_name") or "")
            if not n:
                continue
            nt[n + "|" + canon_team(meta.get("team"))] = pid
            if n in nm and nm[n] != pid:
                dup.add(n)
            else:
                nm[n] = pid
        for n in dup:
            nm.pop(n, None)
    except Exception as e:
        print(f"[stats] name index failed: {e}")
    _SNAME.update(ts=now, nt=nt, nm=nm)
    return _SNAME


def _sl_statline(pid, pos):
    if not pid or str(pid) in ("0", ""):
        return None
    return _statline(pos, _cur_week_stats().get(str(pid)))


def _espn_statline(espn_id, name, team, pos):
    pos_n = "DEF" if pos == "D/ST" else pos
    if pos_n == "DEF":                     # Sleeper keys team defenses by abbrev
        sid = canon_team(team)
    else:
        sid = _espn_to_sleeper_map().get(str(espn_id)) if espn_id else None
        if not sid and name:               # espn_id missing in Sleeper -> match by name
            idx = _sleeper_name_index()
            sid = (idx["nt"].get(_norm_name(name) + "|" + canon_team(team))
                   or idx["nm"].get(_norm_name(name)))
    return _statline(pos_n, _cur_week_stats().get(sid)) if sid else None


def _record_str(w, l, t):
    w, l, t = int(w or 0), int(l or 0), int(t or 0)
    return f"{w}-{l}-{t}" if t else f"{w}-{l}"


def _sl_player(pid, players, pts, projections, nfl, starter):
    """Build one Sleeper player dict. pid may be '0'/None for an empty slot."""
    meta = players.get(str(pid), {}) if pid else {}
    if str(pid) in ("0", "") or pid is None:
        nm, pos, team = "(empty)", "", ""
    elif pos_is_def(meta):
        pos, team = "DEF", canon_team(meta.get("team") or pid)
        nm = f"{team} D/ST"
    else:
        nm = (meta.get("full_name")
              or f"{meta.get('first_name','')} {meta.get('last_name','')}".strip()
              or str(pid))
        pos = meta.get("position", "")
        team = canon_team(meta.get("team"))
    g = nfl.get(team, {})
    espn_id = meta.get("espn_id")
    pts_val = round(pts.get(str(pid), 0) or 0, 2)
    proj_val = projections.get(str(pid))
    return {
        "name": nm,
        "pos": pos,
        "team": team,
        "points": pts_val,
        "projected": proj_val,
        "proj_live": _live_proj(g.get("status", "pre"), g.get("detail", ""), pts_val, proj_val),
        "game_status": g.get("status", "pre"),
        "game_detail": g.get("detail", ""),
        "redzone": g.get("redzone", False),
        "opp": g.get("opp"),
        "opp_ha": g.get("ha"),
        "injury": _injury_code(meta.get("injury_status")),
        "statline": _sl_statline(pid, pos),
        "starter": starter,
        "sleeper_id": str(pid) if str(pid) not in ("0", "") and pid is not None else None,
        "espn_id": str(espn_id) if espn_id else None,
    }


SLEEPER_SLOT_LABEL = {
    "QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "K": "K", "DEF": "DEF",
    "FLEX": "FLEX", "WRRB_FLEX": "FLEX", "REC_FLEX": "FLEX",
    "SUPER_FLEX": "SFLEX", "DL": "DL", "LB": "LB", "DB": "DB", "IDP_FLEX": "IDP",
}


def _sl_starting_slots(league):
    """Ordered lineup slot labels (bench/IR/taxi removed) for a league."""
    return [SLEEPER_SLOT_LABEL.get(p, p)
            for p in (league.get("roster_positions") or [])
            if p not in ("BN", "IR", "TAXI")]


def _global_starters(matchups):
    """All players locked into a starting lineup this week, across the league."""
    return {str(s) for mm in matchups for s in (mm.get("starters") or [])}


def _sl_build_team(m, roster, user_name, players, projections, nfl, slots=None,
                   locked_elsewhere=None):
    """Build a full team (starters + bench + record) from a matchup entry."""
    if m is None:
        return None
    owner = roster.get("owner_id") if roster else None
    settings = (roster or {}).get("settings", {})
    starters = m.get("starters") or []
    starter_set = {str(s) for s in starters}
    # Roster membership comes from /rosters (reflects trades immediately);
    # the /matchups list is a locked week snapshot and lags after a trade.
    all_players = (roster or {}).get("players") or m.get("players") or []
    pts = m.get("players_points") or {}
    # Exclude players who are locked as a starter elsewhere this week (a
    # mid-week trade keeps them scoring for their old team's lineup), so a
    # traded player shows once -- on the team currently starting them.
    bench_excl = starter_set | (locked_elsewhere or set())

    starter_out = [_sl_player(pid, players, pts, projections, nfl, True)
                   for pid in starters]
    slots = slots or []
    for i, row in enumerate(starter_out):
        row["slot"] = slots[i] if i < len(slots) else row["pos"]
    bench_out = [_sl_player(pid, players, pts, projections, nfl, False)
                 for pid in all_players if str(pid) not in bench_excl]
    bench_out.sort(key=lambda p: (_POS_ORDER.get(p["pos"], 9), -(p["points"] or 0)))

    score = round(float(m.get("points") or 0), 2)
    return {
        "name": user_name.get(owner, "Team"),
        "record": _record_str(settings.get("wins"), settings.get("losses"),
                              settings.get("ties")),
        "score": score,
        "projected": _team_projection(starter_out, score),
        "players": starter_out,
        "bench": bench_out,
    }


def _sl_common(league_id, week):
    """Fetch the shared Sleeper objects for a league + current week."""
    league = _get_json(f"{SLEEPER}/league/{league_id}")
    rosters = _get_json(f"{SLEEPER}/league/{league_id}/rosters")
    users = _get_json(f"{SLEEPER}/league/{league_id}/users")
    matchups = _get_json(f"{SLEEPER}/league/{league_id}/matchups/{week}")
    try:
        _sl_apply_live_points(matchups, rosters, league.get("scoring_settings"), week)
    except Exception as e:
        print(f"[sleeper] live re-score failed, using matchup points: {e}")
    rec = (league.get("scoring_settings") or {}).get("rec", 0)
    scoring = 1 if rec >= 1 else (0.5 if rec >= 0.4 else 0)
    projections = _sleeper_projections(league.get("season"), week, scoring)
    user_name = {}
    for u in users:
        nm = (u.get("metadata") or {}).get("team_name") or u.get("display_name")
        user_name[u["user_id"]] = nm
    roster_by_id = {r["roster_id"]: r for r in rosters}
    slots = _sl_starting_slots(league)
    return league, rosters, roster_by_id, user_name, matchups, projections, slots


def sleeper_league_payload(league_id, my_user_id, week, players, nfl, override=None):
    league, rosters, roster_by_id, user_name, matchups, projections, slots = _sl_common(
        league_id, week)

    my_roster_id = None
    for r in rosters:
        if r.get("owner_id") == my_user_id:
            my_roster_id = r["roster_id"]
            break

    base = {
        "provider": "sleeper",
        "league_id": str(league_id),
        "id": f"sleeper:{league_id}",
        "league_name": league.get("name", "Sleeper league"),
        "week": week,
    }

    # build every team, enrich, and pair into matchups
    fc = _fc_for(len(rosters), _sleeper_val_params(league, override))
    gstart = _global_starters(matchups)
    by_mid, meta_by_roster = {}, {}
    for m in matchups:
        r = roster_by_id.get(m["roster_id"])
        t = _sl_build_team(m, r, user_name, players, projections, nfl, slots, gstart)
        if not t:
            continue
        _fc_enrich_team(t, fc)
        meta = {"team": t, "is_me": bool(r) and r.get("owner_id") == my_user_id}
        meta_by_roster[m["roster_id"]] = meta
        by_mid.setdefault(m.get("matchup_id"), []).append(meta)

    base["matchups"] = _pair_matchups(by_mid)
    mine = meta_by_roster.get(my_roster_id)
    if not mine:
        if not base["matchups"]:
            base["error"] = "Could not find matchups in this league for the current week."
        return base
    # keep my_team/opp_team for the rest of the app
    for mu in base["matchups"]:
        if mu["a_is_me"] or mu["b_is_me"]:
            base["my_team"] = mu["a"] if mu["a_is_me"] else mu["b"]
            base["opp_team"] = mu["b"] if mu["a_is_me"] else mu["a"]
            break
    return base


def _pair_matchups(by_mid):
    """Turn {matchup_id: [meta, meta]} into a list of matchups, mine first."""
    out = []
    for _, pair in by_mid.items():
        if len(pair) != 2:
            continue
        a, b = pair
        if b["is_me"]:
            a, b = b, a
        out.append({"a": a["team"], "b": b["team"],
                    "a_is_me": a["is_me"], "b_is_me": b["is_me"],
                    "win_prob": win_probability(a["team"], b["team"])})
    out.sort(key=lambda x: 0 if (x["a_is_me"] or x["b_is_me"]) else 1)
    return out


def sleeper_all_rosters(league_id, week, players, nfl, my_user_id=None, override=None):
    """Every team's full roster in a league, for the "all rosters" view."""
    league, rosters, roster_by_id, user_name, matchups, projections, slots = _sl_common(
        league_id, week)
    by_roster = {m["roster_id"]: m for m in matchups}
    params = _sleeper_val_params(league, override)
    fc = _fc_for(len(rosters), params)
    gstart = _global_starters(matchups)
    season = str(league.get("season") or sleeper_state().get("season"))
    sstats, byes, ranks = season_stats(season), nfl_byes(season), season_pos_ranks(season)
    teams = []
    for r in rosters:
        m = by_roster.get(r["roster_id"])
        if m is None:
            continue
        t = _sl_build_team(m, r, user_name, players, projections, nfl, slots, gstart)
        st = r.get("settings") or {}
        t["id"] = r["roster_id"]
        t["is_me"] = my_user_id is not None and r.get("owner_id") == my_user_id
        t["wins"], t["losses"], t["ties"] = st.get("wins", 0), st.get("losses", 0), st.get("ties", 0)
        t["pf"] = round(st.get("fpts", 0) + st.get("fpts_decimal", 0) / 100, 2)
        t["pa"] = round(st.get("fpts_against", 0) + st.get("fpts_against_decimal", 0) / 100, 2)
        _fc_enrich_team(t, fc)
        _season_enrich_team(t, sstats, byes, params["ppr"], ranks)
        teams.append(t)
    _rank_strength(teams)
    teams.sort(key=lambda t: -(t["score"] or 0))
    settings = league.get("settings") or {}
    return {
        "provider": "sleeper",
        "league_id": str(league_id),
        "league_name": league.get("name", "Sleeper league"),
        "week": week,
        "season": season,
        "slots": slots,
        "roster_size": len([p for p in (league.get("roster_positions") or []) if p != "IR"]),
        "scoring": {"ppr": params["ppr"], "num_qbs": params["num_qbs"],
                    "dynasty": params["dynasty"], "teams": len(rosters),
                    "playoff_teams": settings.get("playoff_teams") or 6,
                    "playoff_start": settings.get("playoff_week_start") or 15},
        "teams": teams,
    }


# --------------------------------------------------------------------------
# Season-to-date stats (one bulk call, cached) -> ppg / games / snap share,
# used by the trade center and the AI dossier.
# --------------------------------------------------------------------------
_SEASON_STATS = {"ts": 0, "season": None, "data": {}}


def season_stats(season):
    now = time.time()
    if _SEASON_STATS["season"] == str(season) and now - _SEASON_STATS["ts"] < 600:
        return _SEASON_STATS["data"]
    url = (f"https://api.sleeper.com/stats/nfl/{season}?season_type=regular"
           "&position[]=QB&position[]=RB&position[]=WR&position[]=TE"
           "&position[]=K&position[]=DEF&order_by=pts_ppr")
    out = {}
    try:
        for e in _get_json(url, timeout=25) or []:
            pid, s = str(e.get("player_id") or ""), e.get("stats") or {}
            if pid and s:
                out[pid] = s
    except Exception as ex:
        print(f"[stats] season stats failed: {ex}")
        if _SEASON_STATS["data"]:
            return _SEASON_STATS["data"]
    _SEASON_STATS.update(ts=now, season=str(season), data=out)
    return out


def _sid_for(p):
    """Best-effort Sleeper id for any player dict (Sleeper or ESPN built)."""
    if p.get("sleeper_id"):
        return str(p["sleeper_id"])
    pos = (p.get("pos") or "").upper()
    if pos in ("DEF", "D/ST"):
        return canon_team(p.get("team"))
    if p.get("espn_id"):
        sid = _espn_to_sleeper_map().get(str(p["espn_id"]))
        if sid:
            return sid
    if p.get("name"):
        idx = _sleeper_name_index()
        return (idx["nt"].get(_norm_name(p["name"]) + "|" + canon_team(p.get("team")))
                or idx["nm"].get(_norm_name(p["name"])))
    return None


def _season_line(pos, s, gp):
    """Compact season usage line, e.g. '7.2 tgt/g, 5.1 rec, 61 yd, 4 TD'."""
    if not s or not gp:
        return None
    pg = lambda k: (s.get(k) or 0) / gp
    n = lambda v: f"{v:.1f}" if v < 10 else f"{v:.0f}"
    pos = (pos or "").upper()
    P = []
    if pos == "QB":
        P.append(f"{n(pg('pass_yd'))} pass yd/g, {s.get('pass_td') or 0:.0f} TD, {s.get('pass_int') or 0:.0f} INT")
        if s.get("rush_yd"):
            P.append(f"{n(pg('rush_yd'))} rush yd/g, {s.get('rush_td') or 0:.0f} rush TD")
    elif pos == "RB":
        P.append(f"{n(pg('rush_att'))} car/g, {n(pg('rush_yd'))} yd/g, {s.get('rush_td') or 0:.0f} rush TD")
        P.append(f"{n(pg('rec_tgt'))} tgt/g, {n(pg('rec'))} rec/g, {s.get('rec_td') or 0:.0f} rec TD")
    elif pos in ("WR", "TE"):
        P.append(f"{n(pg('rec_tgt'))} tgt/g, {n(pg('rec'))} rec/g, {n(pg('rec_yd'))} yd/g, {s.get('rec_td') or 0:.0f} TD")
    elif pos == "K":
        P.append(f"{s.get('fgm') or 0:.0f}/{s.get('fga') or 0:.0f} FG, {s.get('xpm') or 0:.0f} XP")
    elif pos == "DEF":
        P.append(f"{s.get('sack') or 0:.0f} sacks, {s.get('int') or 0:.0f} INT, {s.get('def_td') or 0:.0f} TD")
    return "; ".join(P) or None


def _season_enrich_team(t, sstats, byes, ppr=1, ranks=None):
    key = "pts_ppr" if ppr >= 1 else ("pts_half_ppr" if ppr >= 0.4 else "pts_std")
    ranks = ranks or {}
    try:
        pdb = sleeper_players()
    except Exception:
        pdb = {}
    for p in (t.get("players") or []) + (t.get("bench") or []):
        if not p.get("name") or p["name"] == "(empty)":
            continue
        p["bye"] = byes.get(p.get("team")) if byes else None
        sid = _sid_for(p) or ""
        meta = pdb.get(sid) or {}
        if meta:
            p["age"] = meta.get("age")
            p["exp"] = meta.get("years_exp")
            if meta.get("injury_status"):
                note = " · ".join(x for x in (meta.get("injury_body_part"), meta.get("injury_notes")) if x)
                p["injury_note"] = note or None
        rk = ranks.get(sid) or {}
        p["rank_total"] = rk.get("total_rank")
        p["rank_ppg"] = rk.get("ppg_rank")
        s = sstats.get(sid)
        if not s:
            p["ppg"] = p["gp"] = p["snap_pct"] = p["season_line"] = None
            continue
        gp = s.get("gp") or 0
        pts = s.get(key) or 0
        p["gp"] = int(gp)
        p["ppg"] = round(pts / gp, 1) if gp else None
        off, tm = s.get("off_snp"), s.get("tm_off_snp")
        p["snap_pct"] = round(100 * off / tm) if off and tm else None
        p["season_line"] = _season_line(p.get("pos"), s, gp)


def _espn_lineup_slots(league):
    """Ordered lineup slot labels for an ESPN league from its roster settings."""
    counts = (((league.get("settings") or {}).get("rosterSettings") or {})
              .get("lineupSlotCounts") or {})
    label = {0: "QB", 1: "QB", 2: "RB", 3: "WRRB", 4: "WR", 5: "WRT", 6: "TE",
             23: "FLEX", 7: "SFLEX", 16: "DEF", 17: "K"}
    out = []
    for sid, n in counts.items():
        sid = int(sid)
        if sid in label and n:
            out.extend([(ESPN_SLOT_ORDER.get(sid, 90), label[sid])] * int(n))
    out.sort(key=lambda x: x[0])
    return [l for _, l in out]


# --------------------------------------------------------------------------
# Recent trades in a league (Sleeper transactions / ESPN mTransactions2)
# --------------------------------------------------------------------------
def league_trades_sleeper(league_id, week, players, limit=10):
    league, rosters, roster_by_id, user_name, _m, _p, _s = _sl_common(league_id, week)
    team_of = {r["roster_id"]: user_name.get(r.get("owner_id"), f"Team {r['roster_id']}")
               for r in rosters}

    def pname(pid):
        m = players.get(str(pid)) or {}
        if pos_is_def(m):
            return f"{canon_team(m.get('team') or pid)} D/ST"
        return m.get("full_name") or str(pid)

    out = []
    for wk in range(int(week), 0, -1):
        try:
            txs = _get_json(f"{SLEEPER}/league/{league_id}/transactions/{wk}")
        except Exception:
            continue
        for tx in txs:
            if tx.get("type") != "trade" or tx.get("status") != "complete":
                continue
            sides = {}
            for pid, rid in (tx.get("adds") or {}).items():
                sides.setdefault(rid, {"team": team_of.get(rid, "?"), "gets": [], "picks": []})
                sides[rid]["gets"].append({"name": pname(pid),
                                           "pos": (players.get(str(pid)) or {}).get("position"),
                                           "sleeper_id": str(pid)})
            for pk in tx.get("draft_picks") or []:
                rid = pk.get("owner_id")
                sides.setdefault(rid, {"team": team_of.get(rid, "?"), "gets": [], "picks": []})
                sides[rid]["picks"].append(f"{pk.get('season')} R{pk.get('round')}")
            out.append({"week": wk, "when": tx.get("status_updated"),
                        "sides": list(sides.values())})
            if len(out) >= limit:
                return out
    return out


def league_trades_espn(league_id, espn_s2, swid, season, limit=10):
    """Completed trades from ESPN's league activity feed. (The transactions
    view only lists the roster drops attached to a trade; the feed's
    message type 224 carries every player moved, with from/to team.)"""
    cookie = f"espn_s2={espn_s2}; SWID={swid}"
    base = (f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}"
            f"/segments/0/leagues/{league_id}")
    teams = _get_json(base + "?view=mTeam", cookies=cookie, timeout=20)
    team_of = {t.get("id"): t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}".strip()
               for t in teams.get("teams") or []}
    feed = _get_json(base + "/communication/?view=kona_league_communication", cookies=cookie, timeout=20)
    trades = []
    for tp in feed.get("topics") or []:
        msgs = [m for m in (tp.get("messages") or []) if m.get("messageTypeId") == 224]
        if not msgs:
            continue
        trades.append((tp.get("date") or 0, msgs))
    trades.sort(key=lambda x: -x[0])
    trades = trades[:limit]
    ids = sorted({m.get("targetId") for _, ms in trades for m in ms if m.get("targetId") is not None})
    names = {}
    e2s = _espn_to_sleeper_map()
    pdb = sleeper_players()
    for pid in ids:
        if pid < 0:                       # ESPN D/ST ids are -16000 - proTeamId
            ab = canon_team(ESPN_PRO_TEAM.get(-16000 - pid, ""))
            names[pid] = (f"{ab} D/ST", "DEF")
            continue
        sid = e2s.get(str(pid))
        meta = pdb.get(sid) if sid else None
        if meta:
            names[pid] = (meta.get("full_name") or str(pid), meta.get("position"))
    missing = [pid for pid in ids if pid not in names]
    if missing:
        try:
            flt = json.dumps({"players": {"filterIds": {"value": missing}}})
            d = _get_json(base + "?view=kona_player_info", cookies=cookie, timeout=20,
                          headers={"x-fantasy-filter": flt})
            for p in d.get("players") or []:
                pl = p.get("player") or {}
                if pl.get("id") in missing:
                    pos = ESPN_POS.get(pl.get("defaultPositionId"))
                    names[pl["id"]] = (pl.get("fullName"), "DEF" if pos == "D/ST" else pos)
        except Exception as e:
            print(f"[trades] espn player lookup failed: {e}")
    out = []
    for when, msgs in trades:
        sides = {}
        for m in msgs:
            to, pid = m.get("to"), m.get("targetId")
            if to is None or pid is None:
                continue
            nm, pos = names.get(pid, (f"Player {pid}", None))
            sides.setdefault(to, {"team": team_of.get(to, f"Team {to}"), "gets": [], "picks": []})
            sides[to]["gets"].append({"name": nm, "pos": pos, "espn_id": str(pid) if pid > 0 else ""})
        if sides:
            out.append({"week": None, "when": when, "sides": list(sides.values())})
    return out


def _rank_strength(teams):
    for rank, t in enumerate(sorted(teams, key=lambda x: -(x.get("value_total") or 0)), 1):
        t["strength_rank"] = rank


def pos_is_def(meta):
    return meta.get("position") == "DEF" or meta.get("fantasy_positions") == ["DEF"]


_POS_ORDER = {"QB": 0, "RB": 1, "WR": 2, "TE": 3, "FLEX": 4,
              "K": 5, "DEF": 6, "D/ST": 6}


# --------------------------------------------------------------------------
# ESPN (private league -> needs espn_s2 + SWID cookies)
# --------------------------------------------------------------------------
ESPN_PRO_TEAM = {
    0: "", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
    8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR",
    15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI",
    22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS",
    29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
}
ESPN_POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST", 9: "DT",
            10: "DE", 11: "LB", 12: "CB", 13: "S"}
ESPN_BENCH_SLOTS = {20, 21}  # 20 = bench, 21 = IR

# ESPN lineupSlotId -> display order rank, matching how ESPN lays out a lineup:
# QB, RB, WR, TE, FLEX, superflex/OP, D/ST, K, then IDP. (Not the raw slot-id
# order -- FLEX is slot 23 but shows right after TE.)
ESPN_SLOT_ORDER = {
    0: 0,   # QB
    1: 1,   # TQB
    2: 2,   # RB
    3: 3,   # RB/WR
    4: 4,   # WR
    5: 5,   # WR/TE
    6: 6,   # TE
    23: 7,  # FLEX (RB/WR/TE)
    7: 8,   # OP / superflex
    16: 9,  # D/ST
    17: 10, # K
    18: 11, # P
    8: 12, 9: 13, 10: 14, 11: 15, 12: 16, 13: 17, 14: 18, 15: 19,  # IDP
    19: 20, # HC
}


def _espn_my_team_id(league, swid):
    swid_norm = (swid or "").strip().strip("{}").upper()
    for m in league.get("members", []):
        mid = (m.get("id") or "").strip().strip("{}").upper()
        if mid == swid_norm:
            member_id = m.get("id")
            for t in league.get("teams", []):
                owners = t.get("owners") or []
                if member_id in owners or m.get("id") in owners:
                    return t.get("id")
    # fallback: single-member can't be resolved
    return None


def _espn_fetch(league_id, espn_s2, swid, season, week):
    cookie = f"espn_s2={espn_s2}; SWID={swid}"
    url = (
        f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}"
        f"/segments/0/leagues/{league_id}"
        f"?view=mMatchupScore&view=mRoster&view=mTeam&view=mSettings"
        f"&scoringPeriodId={week}"
    )
    return _get_json(url, cookies=cookie, timeout=20)


def _espn_build_team(t, week, nfl):
    if not t:
        return None
    name = t.get("name") or (
        f"{t.get('location','')} {t.get('nickname','')}".strip()) or "Team"
    ov = (t.get("record") or {}).get("overall", {})
    roster = (t.get("roster") or {}).get("entries", [])
    starters, bench = [], []
    actual_total = 0.0
    for e in roster:
        slot = e.get("lineupSlotId")
        is_bench = slot in ESPN_BENCH_SLOTS
        p = (e.get("playerPoolEntry") or {}).get("player", {})
        pos = ESPN_POS.get(p.get("defaultPositionId"), "")
        team = canon_team(ESPN_PRO_TEAM.get(p.get("proTeamId"), ""))
        actual = proj = None
        for s in p.get("stats", []):
            if s.get("scoringPeriodId") != week:
                continue
            if s.get("statSourceId") == 0:
                actual = s.get("appliedTotal")
            elif s.get("statSourceId") == 1:
                proj = s.get("appliedTotal")
        actual = round(actual or 0, 2)
        g = nfl.get(team, {})
        row = {
            "name": p.get("fullName", "?"),
            "pos": "DEF" if pos == "D/ST" else pos,
            "slot": "FLEX" if slot == 23 else ("DEF" if slot == 16 else
                    ("DEF" if pos == "D/ST" else pos)),
            "team": team,
            "points": actual,
            "projected": round(proj, 2) if proj is not None else None,
            "proj_live": _live_proj(g.get("status", "pre"), g.get("detail", ""),
                                    actual, round(proj, 2) if proj is not None else None),
            "game_status": g.get("status", "pre"),
            "game_detail": g.get("detail", ""),
            "redzone": g.get("redzone", False),
            "opp": g.get("opp"),
            "opp_ha": g.get("ha"),
            "injury": _injury_code(p.get("injuryStatus")),
            "statline": _espn_statline(p.get("id"), p.get("fullName"), team, pos),
            "starter": not is_bench,
            "espn_id": str(p.get("id")) if p.get("id") else None,
            "sleeper_id": None,
            "_order": ESPN_SLOT_ORDER.get(slot, 90),
        }
        if is_bench:
            bench.append(row)
        else:
            starters.append(row)
            actual_total += actual
    starters.sort(key=lambda r: r["_order"])
    for r in starters:
        r.pop("_order", None)
    for r in bench:
        r.pop("_order", None)
    bench.sort(key=lambda p: (_POS_ORDER.get(p["pos"], 9), -(p["points"] or 0)))
    return {
        "name": name,
        "record": _record_str(ov.get("wins"), ov.get("losses"), ov.get("ties")),
        "score": round(actual_total, 2),
        "projected": _team_projection(starters, actual_total),
        "players": starters,
        "bench": bench,
    }


def espn_league_payload(league_id, espn_s2, swid, season, week, nfl, override=None):
    league = _espn_fetch(league_id, espn_s2, swid, season, week)
    league_name = (league.get("settings") or {}).get("name", "ESPN league")
    teams = {t["id"]: t for t in league.get("teams", [])}
    base = {
        "provider": "espn",
        "league_id": str(league_id),
        "id": f"espn:{league_id}",
        "league_name": league_name,
        "week": week,
    }

    my_team_id = _espn_my_team_id(league, swid)
    fc = _fc_for(len(teams), _espn_val_params(league, override))
    built = {}

    def team_meta(tid):
        if tid not in built:
            t = _espn_build_team(teams.get(tid), week, nfl)
            if t:
                _fc_enrich_team(t, fc)
            built[tid] = {"team": t, "is_me": tid == my_team_id} if t else None
        return built[tid]

    by_mid = {}
    for g in league.get("schedule", []):
        if g.get("matchupPeriodId") != week:
            continue
        home = (g.get("home") or {}).get("teamId")
        away = (g.get("away") or {}).get("teamId")
        if home is None or away is None:
            continue
        ma, mb = team_meta(home), team_meta(away)
        if ma and mb:
            by_mid[g.get("id") or (home, away)] = [ma, mb]

    base["matchups"] = _pair_matchups(by_mid)
    if my_team_id is None:
        base["error"] = "Could not match your SWID to a team. Check the SWID cookie."
        return base
    for mu in base["matchups"]:
        if mu["a_is_me"] or mu["b_is_me"]:
            base["my_team"] = mu["a"] if mu["a_is_me"] else mu["b"]
            base["opp_team"] = mu["b"] if mu["a_is_me"] else mu["a"]
            break
    return base


def espn_all_rosters(league_id, espn_s2, swid, season, week, nfl, override=None):
    league = _espn_fetch(league_id, espn_s2, swid, season, week)
    league_name = (league.get("settings") or {}).get("name", "ESPN league")
    raw_teams = league.get("teams", [])
    my_id = _espn_my_team_id(league, swid)
    params = _espn_val_params(league, override)
    fc = _fc_for(len(raw_teams), params)
    sstats, byes, ranks = season_stats(season), nfl_byes(str(season)), season_pos_ranks(season)
    teams = []
    for raw in raw_teams:
        t = _espn_build_team(raw, week, nfl)
        if not t:
            continue
        ov = (raw.get("record") or {}).get("overall", {})
        t["id"] = raw.get("id")
        t["is_me"] = raw.get("id") == my_id
        t["wins"], t["losses"], t["ties"] = ov.get("wins", 0), ov.get("losses", 0), ov.get("ties", 0)
        t["pf"] = round(ov.get("pointsFor", 0), 2)
        t["pa"] = round(ov.get("pointsAgainst", 0), 2)
        _fc_enrich_team(t, fc)
        _season_enrich_team(t, sstats, byes, params["ppr"], ranks)
        teams.append(t)
    _rank_strength(teams)
    teams.sort(key=lambda t: -(t["score"] or 0))
    ss = ((league.get("settings") or {}).get("scheduleSettings") or {})
    return {
        "provider": "espn",
        "league_id": str(league_id),
        "league_name": league_name,
        "week": week,
        "season": str(season),
        "slots": _espn_lineup_slots(league),
        "roster_size": sum(int(n or 0) for sid, n in ((((league.get("settings") or {}).get("rosterSettings") or {})
                                                     .get("lineupSlotCounts") or {}).items()) if int(sid) != 21),
        "scoring": {"ppr": params["ppr"], "num_qbs": params["num_qbs"],
                    "dynasty": params["dynasty"], "teams": len(raw_teams),
                    "playoff_teams": ss.get("playoffTeamCount") or 6,
                    "playoff_start": (ss.get("matchupPeriodCount") or 14) + 1},
        "teams": teams,
    }


# --------------------------------------------------------------------------
# projection + win-probability helpers (shared)
# --------------------------------------------------------------------------
def _team_projection(players, actual_total):
    """Projected final = sum of each player's live projection (banked points +
    projection scaled by game time left). Falls back to actual points for
    players with no projection."""
    total = 0.0
    have_any = False
    for p in players:
        lv = p.get("proj_live")
        if lv is not None:
            total += lv
            have_any = True
        else:
            total += p.get("points") or 0
    if not have_any and actual_total:
        return None  # no projection data -> let frontend hide it
    return round(total, 2)


# Per-position coefficient of variation for a weekly fantasy score -- how
# volatile that position is (QB steadiest, K/DEF wildest). These are the knobs;
# they're set to typical published weekly CVs, not fit to your league's history.
_POS_CV = {"QB": 0.35, "RB": 0.55, "WR": 0.60, "TE": 0.65,
           "K": 0.70, "DEF": 0.80, "D/ST": 0.80}


def _player_sigma(pos, proj):
    cv = _POS_CV.get((pos or "").upper(), 0.60)
    base = proj if (proj and proj > 0) else 6.0
    return cv * base + 2.0            # small floor so nobody is a lock


def _game_frac_remaining(status, detail):
    """Fraction of a player's NFL game still to be played, 0..1."""
    if status == "post":
        return 0.0
    if status != "in":
        return 1.0                    # 'pre' -> whole game ahead
    d = (detail or "").lower()
    if "final" in d:
        return 0.0
    if "half" in d:                          # halftime
        return 0.5
    if "ot" in d or "overtime" in d:
        return 0.08
    # quarter can read "q2 4:12" or "4:12 - 2nd"
    m = _re.search(r"q\s*([1-4])", d) or _re.search(r"\b([1-4])(?:st|nd|rd|th)\b", d)
    if m:
        q = int(m.group(1))
        cm = _re.search(r"(\d{1,2}):(\d{2})", d)
        secs = int(cm.group(1)) * 60 + int(cm.group(2)) if cm else 450
        if "end" in d:                       # end of quarter -> no time left in it
            secs = 0
        quarters_left = (4 - q) + secs / 900.0   # 900s per quarter
        return max(0.0, min(1.0, quarters_left / 4.0))
    return 0.5                        # live but detail unparsable


def _live_proj(status, detail, points, proj):
    """A live projected final: points banked so far + the pre-game projection
    scaled by how much of the player's game is left. Pre-game it equals the
    projection; final it equals the actual points."""
    if proj is None:
        return None
    if status == "post":
        return round(points or 0, 1)
    if status != "in":
        return round(proj, 1)
    frac = _game_frac_remaining(status, detail)
    return round((points or 0) + proj * frac, 1)


def _team_remaining_var(team):
    """Variance of a team's still-to-come points (finished players add none)."""
    var = 0.0
    for p in (team.get("players") or []):
        if p.get("game_status") == "post":
            continue
        frac = _game_frac_remaining(p.get("game_status"), p.get("game_detail"))
        base = p.get("projected") if p.get("projected") is not None else (p.get("points") or 0)
        sig = _player_sigma(p.get("pos"), base)
        var += sig * sig * frac
    return var


def win_probability(my_team, opp_team):
    """Win probability from the projected margin and the variance that's still
    live. As players finish, their variance drops out, so this converges to
    0% / 100%. An estimate, not betting advice."""
    import math
    if not my_team or not opp_team:
        return None
    mp = my_team.get("projected")
    mp = mp if mp is not None else my_team.get("score")
    op = opp_team.get("projected")
    op = op if op is not None else opp_team.get("score")
    if mp is None or op is None:
        return None
    mean = mp - op
    sigma = math.sqrt(_team_remaining_var(my_team) + _team_remaining_var(opp_team))
    if sigma < 1e-6:                  # everyone's done -> settled
        return 100 if mean > 0 else (0 if mean < 0 else 50)
    z = mean / sigma
    return round(0.5 * (1 + math.erf(z / math.sqrt(2))) * 100)


# --------------------------------------------------------------------------
# FantasyCalc trade values (public API) -> player value, rank, 30-day trend
# --------------------------------------------------------------------------
_FC_CACHE = {}
_FC_SIZES = [8, 10, 12, 14, 16]
_FC_TREND_CACHE = {}
_SETTINGS = {"trend_days": 30}       # value-trend window; set from config / Settings UI
TREND_CHOICES = (3, 7, 14, 30)


def trend_days():
    return _SETTINGS["trend_days"]


def set_trend_days(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return trend_days()
    if n not in TREND_CHOICES:
        n = min(TREND_CHOICES, key=lambda x: abs(x - n))
    if n != _SETTINGS["trend_days"]:
        _SETTINGS["trend_days"] = n
        _FC_CACHE.clear()                 # values carry the trend -> rebuild
    return n


def fantasycalc_trends(num_qbs=1, dynasty=False, days=14):
    """{sleeper_id|espn_id: value change over the last `days` days} from
    FantasyCalc's trend endpoint (same scale as the 30-day trend)."""
    key = (dynasty, num_qbs, int(days))
    hit = _FC_TREND_CACHE.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    out = {}
    try:
        url = (f"https://api.fantasycalc.com/players/values/trend?"
               f"isDynasty={'true' if dynasty else 'false'}&numQbs={num_qbs}&lastXDays={int(days)}")
        for it in _get_json(url, timeout=20):
            pl = it.get("player") or {}
            v = it.get("value")
            if pl.get("sleeperId"):
                out["s:" + str(pl["sleeperId"])] = v
            if pl.get("espnId"):
                out["e:" + str(pl["espnId"])] = v
    except Exception as e:
        print(f"[fantasycalc] trend fetch failed: {e}")
        if hit:
            return hit[1]
    _FC_TREND_CACHE[key] = (time.time(), out)
    return out


def fantasycalc_values(num_teams=12, num_qbs=1, ppr=1, dynasty=False):
    """Cached FantasyCalc value set, indexed by Sleeper and ESPN player id."""
    nt = min(_FC_SIZES, key=lambda x: abs(x - (num_teams or 12)))
    days = trend_days()
    key = (dynasty, num_qbs, ppr, nt, days)
    hit = _FC_CACHE.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    idx = {"by_sleeper": {}, "by_espn": {}, "list": [], "trend_days": days}
    tr = fantasycalc_trends(num_qbs, dynasty, days) if days != 30 else None
    url = (f"https://api.fantasycalc.com/values/current?"
           f"isDynasty={'true' if dynasty else 'false'}"
           f"&numQbs={num_qbs}&numTeams={nt}&ppr={ppr}")
    try:
        for it in _get_json(url, timeout=20):
            pl = it.get("player") or {}
            sid = str(pl["sleeperId"]) if pl.get("sleeperId") else None
            eid = str(pl["espnId"]) if pl.get("espnId") else None
            trend = it.get("trend30Day")
            if tr is not None:            # custom window: value change over `days`
                trend = tr.get("s:" + sid) if sid else None
                if trend is None and eid:
                    trend = tr.get("e:" + eid)
                trend = trend or 0
            entry = {"value": it.get("value"), "ovr": it.get("overallRank"),
                     "pos": it.get("positionRank"), "trend": trend}
            if sid:
                idx["by_sleeper"][sid] = entry
            if eid:
                idx["by_espn"][eid] = entry
            idx["list"].append({**entry, "name": pl.get("name"),
                                "position": pl.get("position"),
                                "team": pl.get("maybeTeam"),
                                "sleeper_id": sid, "espn_id": eid})
    except Exception as e:
        print(f"[fantasycalc] fetch failed: {e}")
    _FC_CACHE[key] = (time.time(), idx)
    return idx


def _apply_override(dynasty, num_qbs, ppr, override):
    """Let config.json override the auto-detected value settings for a league."""
    o = override or {}
    if "dynasty" in o:
        dynasty = bool(o["dynasty"])
    if "num_qbs" in o:
        num_qbs = int(o["num_qbs"])
    elif "superflex" in o:
        num_qbs = 2 if o["superflex"] else 1
    if "ppr" in o:
        ppr = o["ppr"]
    return {"num_teams": None, "dynasty": dynasty, "num_qbs": num_qbs, "ppr": ppr}


def _sleeper_val_params(league, override=None):
    settings = league.get("settings") or {}
    rec = (league.get("scoring_settings") or {}).get("rec", 0)
    ppr = 1 if rec >= 1 else (0.5 if rec >= 0.4 else 0)
    rp = league.get("roster_positions") or []
    num_qbs = 2 if ("SUPER_FLEX" in rp or rp.count("QB") >= 2) else 1
    dynasty = settings.get("type") == 2          # Sleeper: 0 redraft, 1 keeper, 2 dynasty
    return _apply_override(dynasty, num_qbs, ppr, override)


def _espn_val_params(league, override=None):
    s = league.get("settings") or {}
    rec_pts = 0
    for it in ((s.get("scoringSettings") or {}).get("scoringItems") or []):
        if it.get("statId") == 53:               # 53 = receptions
            rec_pts = it.get("points", 0) or 0
            break
    ppr = 1 if rec_pts >= 1 else (0.5 if rec_pts >= 0.4 else 0)
    counts = (s.get("rosterSettings") or {}).get("lineupSlotCounts") or {}
    qb = counts.get("0", 0) or 0                  # slot 0 = QB
    op = counts.get("7", 0) or 0                  # slot 7 = OP / superflex
    num_qbs = 2 if (qb >= 2 or op >= 1) else 1
    return _apply_override(False, num_qbs, ppr, override)  # ESPN has no clean dynasty flag


def _fc_for(num_teams, params):
    return fantasycalc_values(num_teams=num_teams, num_qbs=params["num_qbs"],
                              ppr=params["ppr"], dynasty=params["dynasty"])


def _fc_lookup(fc, sleeper_id, espn_id):
    if sleeper_id and str(sleeper_id) in fc["by_sleeper"]:
        return fc["by_sleeper"][str(sleeper_id)]
    if espn_id and str(espn_id) in fc["by_espn"]:
        return fc["by_espn"][str(espn_id)]
    return None


def _fc_enrich(player, fc):
    e = _fc_lookup(fc, player.get("sleeper_id"), player.get("espn_id"))
    player["value"] = e["value"] if e else None
    player["ovr_rank"] = e["ovr"] if e else None
    player["pos_rank"] = e["pos"] if e else None
    player["trend"] = e["trend"] if e else None
    player["trend_days"] = fc.get("trend_days", 30)
    return player


def _fc_enrich_team(team, fc):
    """Enrich every player on a team and return the summed trade value."""
    total = 0
    for p in (team.get("players") or []) + (team.get("bench") or []):
        _fc_enrich(p, fc)
        if p.get("value"):
            total += p["value"]
    team["value_total"] = total
    return total


# --------------------------------------------------------------------------
# Player profile: game log, news + outlook, depth chart
# --------------------------------------------------------------------------
import re as _re
from concurrent.futures import ThreadPoolExecutor as _Pool

ESPN_TEAM_ID = {v: k for k, v in ESPN_PRO_TEAM.items() if v}


def _strip_html(s):
    if not s:
        return ""
    return _re.sub(r"<[^>]+>", "", s).replace("&nbsp;", " ").strip()


def _norm_name(s):
    s = (s or "").lower()
    s = _re.sub(r"[.''`\-]", "", s)
    s = _re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", s)
    return _re.sub(r"\s+", " ", s).strip()


def _espn_team_roster(team_abbr):
    tid = ESPN_TEAM_ID.get(canon_team(team_abbr))
    if not tid:
        return None
    return _get_json(
        f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/"
        f"{tid}/roster", timeout=20)


def espn_athlete_id_by_name(name, team):
    """Sleeper often lacks espn_id for newer players; resolve it by matching
    the player's name against their NFL team's ESPN roster."""
    roster = _espn_team_roster(team)
    if not roster:
        return None
    target = _norm_name(name)
    for grp in roster.get("athletes", []):
        for it in grp.get("items", []):
            if _norm_name(it.get("fullName", "")) == target:
                return str(it.get("id"))
    return None


_PPR_SCORE = {
    "passingYards": 0.04, "passingTouchdowns": 4, "interceptions": -2,
    "rushingYards": 0.1, "rushingTouchdowns": 6,
    "receptions": 1, "receivingYards": 0.1, "receivingTouchdowns": 6,
    "fumblesLost": -2,
    "passingConversions": 2, "rushingConversions": 2, "receivingConversions": 2,
    "fieldGoalsMade": 3, "extraPointsMade": 1,
}
# machine-name substrings where a LOWER value is better (grade inverted)
_STAT_LOW = ("interception", "fumble", "sack")


def _to_num(v):
    try:
        return float(str(v).replace(",", ""))
    except (ValueError, TypeError):
        return None


def _stat_group(name):
    n = (name or "").lower()
    if "pass" in n or n in ("completions", "completionpct", "qbrating", "adjqbr",
                            "sacks", "interceptions"):
        return "PASSING"
    if "rush" in n or n == "carries":
        return "RUSHING"
    if "receiv" in n or "recept" in n or n in ("receptions", "targets"):
        return "RECEIVING"
    if "fumble" in n:
        return "FUMBLES"
    if "return" in n:
        return "RETURNING"
    if "kick" in n or "field" in n or "extrapoint" in n or "punt" in n:
        return "KICKING"
    if "tackle" in n or "defensive" in n or "sack" in n:
        return "DEFENSE"
    return "MISC"


def _stat_dir(name):
    n = (name or "").lower()
    return "low" if any(k in n for k in _STAT_LOW) else "high"


# ESPN kicker game-log columns ("made-attempted" by distance) -> points per make.
# Standard scoring: FG 0-39 = 3, 40-49 = 4, 50+ = 5, XP = 1, any miss = -1.
_KICK_SCORE = {
    "fieldGoalsMade1_19-fieldGoalAttempts1_19": 3,
    "fieldGoalsMade20_29-fieldGoalAttempts20_29": 3,
    "fieldGoalsMade30_39-fieldGoalAttempts30_39": 3,
    "fieldGoalsMade40_49-fieldGoalAttempts40_49": 4,
    "fieldGoalsMade50-fieldGoalAttempts50": 5,
    "extraPointsMade-extraPointAttempts": 1,
}


def _espn_fpts(names, stats):
    total = 0.0
    for nm, val in zip(names, stats):
        if nm in _KICK_SCORE:               # kicker columns are "made-attempted"
            try:
                made, att = (int(x) for x in str(val).split("-")[:2])
            except ValueError:
                continue
            total += made * _KICK_SCORE[nm] - (att - made)   # -1 per miss
            continue
        w = _PPR_SCORE.get(nm)
        if w is None:
            continue
        num = _to_num(val)
        if num is not None:
            total += num * w
    return round(total, 1)


def espn_gamelog(espn_id, season=None):
    url = (f"https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/"
           f"athletes/{espn_id}/gamelog")
    if season:
        url += f"?season={season}"
    j = _get_json(url, timeout=20)
    labels = j.get("labels") or []
    names = j.get("names") or []
    seasons = []
    for f in j.get("filters", []):
        if f.get("name") == "season":
            seasons = [str(o.get("value")) for o in f.get("options", [])]
            if not season:
                season = str(f.get("value"))

    columns = [{"label": "FPTS", "name": "fpts", "group": "FANTASY", "dir": "high"}]
    for i, lab in enumerate(labels):
        nm = names[i] if i < len(names) else lab
        columns.append({"label": lab, "name": nm,
                        "group": _stat_group(nm), "dir": _stat_dir(nm)})

    meta = j.get("events", {})
    rows = []
    for stype in j.get("seasonTypes", []):
        disp = (stype.get("displayName") or "").lower()
        if "pre" in disp:          # skip preseason
            continue
        playoff = "post" in disp or "playoff" in disp
        cats = [c for c in stype.get("categories", []) if c.get("events")]
        cat = None
        for c in cats:
            if c.get("events") and len(c["events"][0].get("stats", [])) == len(labels):
                cat = c
                break
        cat = cat or (cats[0] if cats else None)
        if not cat:
            continue
        for ev in cat.get("events", []):
            m = meta.get(ev.get("eventId"), {})
            opp = m.get("opponent") or {}
            stats = ev.get("stats") or []
            fpts = _espn_fpts(names, stats)
            rows.append({
                "week": m.get("week"),
                "date": m.get("gameDate"),
                "atVs": m.get("atVs"),
                "opp": opp.get("abbreviation"),
                "opp_logo": opp.get("logo"),
                "result": m.get("gameResult"),
                "score": m.get("score"),
                "fpts": fpts,
                "values": [fpts] + list(stats),
                "playoff": playoff,
                "team": canon_team((m.get("team") or {}).get("abbreviation")),
            })
    rows.sort(key=lambda r: (r["playoff"],
                             r["week"] if isinstance(r["week"], int) else 999))
    return {"season": season, "seasons": seasons, "columns": columns, "rows": rows}


# Sleeper weekly-stats game log -- reliable fallback when ESPN's gamelog is
# empty (it is, for some veterans). (key, label, group, dir)
_SLEEPER_GL_COLS = [
    ("fpts", "FPTS", "FANTASY", "high"),
    ("pass_cmp", "CMP", "PASSING", "high"), ("pass_att", "ATT", "PASSING", "high"),
    ("pass_yd", "YDS", "PASSING", "high"), ("pass_td", "TD", "PASSING", "high"),
    ("pass_int", "INT", "PASSING", "low"),
    ("rush_att", "CAR", "RUSHING", "high"), ("rush_yd", "YDS", "RUSHING", "high"),
    ("rush_td", "TD", "RUSHING", "high"),
    ("rec_tgt", "TGT", "RECEIVING", "high"), ("rec", "REC", "RECEIVING", "high"),
    ("rec_yd", "YDS", "RECEIVING", "high"), ("rec_td", "TD", "RECEIVING", "high"),
    ("fum_lost", "FL", "FUMBLES", "low"),
    ("fgm", "FGM", "KICKING", "high"), ("fga", "FGA", "KICKING", "high"),
    ("fgm_lng", "LNG", "KICKING", "high"),
    ("xpm", "XPM", "KICKING", "high"), ("xpa", "XPA", "KICKING", "high"),
]


def _logo_url(team):
    if not team:
        return None
    code = {"WAS": "wsh"}.get(team, team).lower()
    return f"https://a.espncdn.com/i/teamlogos/nfl/500/{code}.png"


def sleeper_gamelog(sleeper_id, season):
    data = _get_json(f"https://api.sleeper.com/stats/nfl/player/{sleeper_id}"
                     f"?season_type=regular&season={season}&grouping=week", timeout=20)
    if not isinstance(data, dict):
        return {"season": str(season), "columns": [], "rows": []}
    weeks = sorted((int(w) for w in data if data.get(w)))
    present = set()
    for w in data.values():
        st = (w or {}).get("stats") or {}
        for key, _, _, _ in _SLEEPER_GL_COLS:
            if key != "fpts" and st.get(key):
                present.add(key)
    cols = [c for c in _SLEEPER_GL_COLS if c[0] == "fpts" or c[0] in present]
    columns = [{"label": c[1], "name": c[0], "group": c[2], "dir": c[3]} for c in cols]
    rows = []
    for wk in weeks:
        e = data[str(wk)]
        st = e.get("stats") or {}
        fpts = round(st.get("pts_ppr", 0) or 0, 1)
        vals = []
        for c in cols:
            if c[0] == "fpts":
                vals.append(fpts)
            else:
                v = st.get(c[0])
                vals.append(round(v, 1) if isinstance(v, (int, float)) else "")
        opp = canon_team(e.get("opponent"))
        rows.append({
            "week": wk, "atVs": "@" if e.get("is_away_team") else "vs",
            "opp": opp, "opp_logo": _logo_url(opp),
            "result": None, "score": None, "fpts": fpts,
            "values": vals, "playoff": False, "team": canon_team(e.get("team")),
        })
    return {"season": str(season), "columns": columns, "rows": rows}


def player_gamelog(espn_id, sleeper_id, season=None, team=None):
    """Unified game log: ESPN when it returns data, else Sleeper weekly stats.
    Missed games (team played, player did not) are filled in as zero rows."""
    seasons = None
    if espn_id:
        try:
            seasons = espn_gamelog(espn_id, None).get("seasons")
        except Exception:
            seasons = None
    target = season or (seasons[0] if seasons else None)

    def rows_for(yr):
        if espn_id:
            try:
                gl = espn_gamelog(espn_id, yr)
                if gl.get("rows"):
                    return gl
            except Exception as e:
                print(f"[gamelog] espn {yr} failed: {e}")
        if sleeper_id and yr:
            try:
                sg = sleeper_gamelog(sleeper_id, yr)
                if sg.get("rows"):
                    return sg
            except Exception as e:
                print(f"[gamelog] sleeper {yr} failed: {e}")
        return None

    gl = rows_for(target)
    # newest season empty (e.g. season just started) -> show last one with games
    if not gl and not season and seasons:
        for yr in seasons[1:]:
            gl = rows_for(yr)
            if gl:
                break
    gl = gl or {"season": str(target) if target else None, "columns": [], "rows": []}
    gl["seasons"] = seasons or ([gl.get("season")] if gl.get("season") else [])
    gl["season"] = gl.get("season") or (str(target) if target else None)
    try:
        _fill_missed_games(gl, gl.get("season"), team)
    except Exception as e:
        print(f"[gamelog] missed-games fill failed: {e}")
    return gl


def espn_news(espn_id, count=6):
    j = _get_json(
        f"https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players"
        f"?playerId={espn_id}&count={count}", timeout=15)
    out = []
    for it in j.get("feed", []):
        links = it.get("links") or {}
        url = ((links.get("web") or {}).get("href")) if isinstance(links, dict) else None
        out.append({
            "headline": it.get("headline") or it.get("description"),
            "body": _strip_html(it.get("story") or it.get("description")),
            "source": it.get("type") or "ESPN",
            "published": it.get("published"),
            "url": url,
        })
    return out


def _sleeper_graphql(operation, query, variables):
    j = _post_json("https://sleeper.com/graphql",
                   {"operationName": None, "query": query, "variables": variables},
                   timeout=15)
    if isinstance(j, dict):
        return (j.get("data") or {}).get(operation)
    return None


def _sleeper_news_items(data):
    items = data if isinstance(data, list) else ([data] if data else [])
    out = []
    for it in items:
        if not it:
            continue
        md = it.get("metadata") or {}
        out.append({
            "headline": md.get("title") or md.get("description"),
            "body": md.get("analysis") or md.get("description"),
            "source": it.get("source") or "Sleeper",
            "published": it.get("published"),
            "url": md.get("url"),
        })
    return out


def sleeper_news(sleeper_id, limit=6):
    q = ("query($sport:String!,$player_id:String!,$limit:Int!){"
         "get_player_news(sport:$sport,player_id:$player_id,limit:$limit)"
         "{metadata published source}}")
    data = _sleeper_graphql("get_player_news", q,
                            {"sport": "nfl", "player_id": str(sleeper_id),
                             "limit": limit})
    return _sleeper_news_items(data)


def sleeper_outlook(sleeper_id, season):
    q = ("query($sport:String!,$player_id:String!,$season:String!){"
         "get_player_outlook(sport:$sport,player_id:$player_id,season:$season)"
         "{metadata published source}}")
    data = _sleeper_graphql("get_player_outlook", q,
                            {"sport": "nfl", "player_id": str(sleeper_id),
                             "season": str(season)})
    items = _sleeper_news_items(data)
    return items[0] if items else None


_DEPTH_WANT = {"qb": "QB", "rb": "RB", "wr": "WR", "te": "TE", "pk": "K"}


def espn_depth_chart(team_abbr, season, this_espn_id):
    tid = ESPN_TEAM_ID.get(canon_team(team_abbr))
    if not tid:
        return None
    roster = _get_json(
        f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/"
        f"{tid}/roster", timeout=20)
    name_by_id = {}
    for grp in roster.get("athletes", []):
        for it in grp.get("items", []):
            name_by_id[str(it.get("id"))] = it.get("fullName")

    dc = None
    for yr in [str(season), str(int(season) - 1)]:
        d = _get_json(
            f"https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/"
            f"seasons/{yr}/teams/{tid}/depthcharts", timeout=20)
        if d.get("items"):
            dc = d
            break
    positions = {}
    for item in (dc or {}).get("items", []):
        for pk, pv in item.get("positions", {}).items():
            if pk not in _DEPTH_WANT:
                continue
            plist = []
            for a in sorted(pv.get("athletes", []), key=lambda x: x.get("rank", 99)):
                ref = ((a.get("athlete") or {}).get("$ref") or "")
                aid = ref.split("/athletes/")[1].split("?")[0] if "/athletes/" in ref else ""
                plist.append({
                    "name": name_by_id.get(aid, f"Player {aid}" if aid else "—"),
                    "id": aid,
                    "is_this": bool(this_espn_id) and str(aid) == str(this_espn_id),
                })
            positions[_DEPTH_WANT[pk]] = plist
    order = ["QB", "RB", "WR", "TE", "K"]
    out = [{"pos": p, "players": positions[p]} for p in order if p in positions]
    return {"team": canon_team(team_abbr), "positions": out}


# --------------------------------------------------------------------------
# DraftKings player-prop odds (public content API, unofficial)
# --------------------------------------------------------------------------
_DK_BASE = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusoh/v1"
_DK_CATS = {1003: "td", 1000: "pass_yds", 1001: "rush_yds", 1342: "rec_yds"}
_DK_CACHE = {"ts": 0, "idx": None}


def _clean_odds(am):
    return None if am is None else str(am).replace("−", "-")


def _implied_prob(american):
    try:
        a = float(str(american).replace("−", "-").replace("+", ""))
    except (TypeError, ValueError):
        return None
    return (-a) / ((-a) + 100) if a < 0 else 100 / (a + 100)


def _implied_line(ladder):
    """From a milestone ladder [(yards, americanOdds)], interpolate the yardage
    where the implied probability crosses 50% -- the de-facto O/U line."""
    pts = []
    for v, am in ladder:
        p = _implied_prob(am)
        if p is not None:
            pts.append((v, p))
    pts.sort()
    for i in range(len(pts) - 1):
        v1, p1 = pts[i]; v2, p2 = pts[i + 1]
        if p1 >= 0.5 >= p2 and p1 != p2:
            return round(v1 + (p1 - 0.5) / (p1 - p2) * (v2 - v1), 1)
    return min(pts, key=lambda x: abs(x[1] - 0.5))[0] if pts else None


def dk_props(force=False):
    """Cached index of DraftKings player props, keyed by normalized name."""
    if not force and _DK_CACHE["idx"] and time.time() - _DK_CACHE["ts"] < 300:
        return _DK_CACHE["idx"]
    from collections import defaultdict
    idx = {}
    for cat, kind in _DK_CATS.items():
        try:
            d = _get_json(f"{_DK_BASE}/leagues/88808/categories/{cat}", timeout=25)
        except Exception as e:
            print(f"[dk] category {cat} failed: {e}")
            continue
        markets = {m["id"]: m for m in d.get("markets", [])}
        bym = defaultdict(list)
        for s in d.get("selections", []):
            bym[s["marketId"]].append(s)
        for mid, m in markets.items():
            mt = (m.get("marketType") or {}).get("name", "")
            sels = bym.get(mid, [])
            if kind == "td":
                if "Anytime Touchdown" not in mt:
                    continue
                for s in sels:
                    nm = ((s.get("participants") or [{}])[0].get("name")) or s.get("label")
                    if not nm:
                        continue
                    idx.setdefault(_norm_name(nm), {"name": nm})["td"] = \
                        _clean_odds((s.get("displayOdds") or {}).get("american"))
            else:
                if "Yards" in mt:
                    subkey = kind          # pass_yds / rush_yds / rec_yds
                elif "Reception" in mt:
                    subkey = "rec"         # receptions (for PPR)
                else:
                    continue
                nm = None
                for s in sels:
                    ps = s.get("participants") or []
                    if ps:
                        nm = ps[0].get("name"); break
                if not nm:
                    continue
                ladder = []
                for s in sels:
                    mv, am = s.get("milestoneValue"), (s.get("displayOdds") or {}).get("american")
                    if mv is not None and am is not None:
                        ladder.append((float(mv), _clean_odds(am)))
                if ladder:
                    ladder.sort()
                    idx.setdefault(_norm_name(nm), {"name": nm})[subkey] = ladder
    _DK_CACHE["ts"] = time.time()
    _DK_CACHE["idx"] = idx
    return idx


def player_odds(name, team=None, pos=None):
    idx = dk_props()
    e = idx.get(_norm_name(name))
    if not e:
        return {"found": False, "book": "DraftKings"}
    labels = [("pass_yds", "Passing yards"), ("rush_yds", "Rushing yards"),
              ("rec_yds", "Receiving yards")]
    markets = []
    for kind, label in labels:
        if kind in e:
            ladder = e[kind]
            markets.append({
                "stat": label,
                "line": _implied_line(ladder),
                "ladder": [{"v": v, "odds": am} for v, am in ladder],
            })
    return {"found": True, "book": "DraftKings", "name": e.get("name"),
            "td": e.get("td"), "markets": markets}


# --------------------------------------------------------------------------
# Per-league availability: who rosters a player (or is he a free agent)
# --------------------------------------------------------------------------
_OWN_CACHE = {}


def _name_team_key(name, team):
    return _norm_name(name or "") + "|" + canon_team(team)


def resolve_sleeper_id(espn_id=None, name=None, team=None):
    """ESPN->Sleeper id via Sleeper's espn_id field, falling back to name+team
    (Sleeper's espn_id is missing for many newer players)."""
    if espn_id:
        sid = _espn_to_sleeper_map().get(str(espn_id))
        if sid:
            return sid
    if name:
        idx = _sleeper_name_index()
        return (idx["nt"].get(_name_team_key(name, team))
                or idx["nm"].get(_norm_name(name)))
    return None


def sleeper_ownership(league_id, my_user_id=None):
    key = ("sl", str(league_id))
    hit = _OWN_CACHE.get(key)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    players = sleeper_players()
    league = _get_json(f"{SLEEPER}/league/{league_id}")
    rosters = _get_json(f"{SLEEPER}/league/{league_id}/rosters")
    users = _get_json(f"{SLEEPER}/league/{league_id}/users")
    uname = {}
    for u in users:
        uname[u["user_id"]] = ((u.get("metadata") or {}).get("team_name")
                               or u.get("display_name"))
    owners, by_name = {}, {}
    for r in rosters:
        oid = r.get("owner_id")
        info = {"team": uname.get(oid, "Team"),
                "is_me": my_user_id is not None and oid == my_user_id}
        for pid in (r.get("players") or []):
            owners[str(pid)] = info
            meta = players.get(str(pid))
            if meta and meta.get("full_name"):
                by_name[_name_team_key(meta["full_name"], meta.get("team"))] = info
    res = {"league_name": league.get("name", "Sleeper league"),
           "owners": owners, "by_name": by_name}
    _OWN_CACHE[key] = (time.time(), res)
    return res


def espn_ownership(league_id, espn_s2, swid, season, week):
    key = ("espn", str(league_id))
    hit = _OWN_CACHE.get(key)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    league = _espn_fetch(league_id, espn_s2, swid, season, week)
    my_id = _espn_my_team_id(league, swid)
    owners, by_name = {}, {}
    for t in league.get("teams", []):
        name = (t.get("name")
                or f"{t.get('location', '')} {t.get('nickname', '')}".strip()
                or "Team")
        info = {"team": name, "is_me": t.get("id") == my_id}
        for e in (t.get("roster") or {}).get("entries", []):
            p = (e.get("playerPoolEntry") or {}).get("player") or {}
            pid = p.get("id")
            if pid is not None:
                owners[str(pid)] = info
            if p.get("fullName"):
                tm = canon_team(ESPN_PRO_TEAM.get(p.get("proTeamId"), ""))
                by_name[_name_team_key(p["fullName"], tm)] = info
    res = {"league_name": (league.get("settings") or {}).get("name", "ESPN league"),
           "owners": owners, "by_name": by_name}
    _OWN_CACHE[key] = (time.time(), res)
    return res


def player_profile(espn_id, sleeper_id, team, pos, name, season):
    # Sleeper players frequently have no espn_id -> resolve via the team roster
    if not espn_id and team and name and pos != "DEF":
        try:
            espn_id = espn_athlete_id_by_name(name, team)
        except Exception as e:
            print(f"[profile] espn id resolve failed: {e}")
    headshot = (f"https://a.espncdn.com/i/headshots/nfl/players/full/{espn_id}.png"
                if espn_id else None)
    result = {
        "name": name, "pos": pos, "team": canon_team(team),
        "espn_id": espn_id, "sleeper_id": sleeper_id, "headshot": headshot,
    }
    jobs = {}
    with _Pool(max_workers=6) as ex:
        if espn_id or sleeper_id:
            # None -> builder auto-selects the latest season with games
            jobs["gamelog"] = ex.submit(player_gamelog, espn_id, sleeper_id, None, team)
        if espn_id:
            jobs["espn_news"] = ex.submit(espn_news, espn_id)
            jobs["depth"] = ex.submit(espn_depth_chart, team, season, espn_id)
        if sleeper_id:
            jobs["sleeper_news"] = ex.submit(sleeper_news, sleeper_id)
            jobs["sleeper_outlook"] = ex.submit(sleeper_outlook, sleeper_id, season)
        vals = {}
        for k, f in jobs.items():
            try:
                vals[k] = f.result()
            except Exception as e:
                print(f"[profile] {k} failed: {e}")
                vals[k] = None

    gl = vals.get("gamelog")
    result["gamelog"] = gl if isinstance(gl, dict) else None
    result["seasons"] = (gl or {}).get("seasons") if isinstance(gl, dict) else []
    result["news"] = {"espn": vals.get("espn_news") or [],
                      "sleeper": vals.get("sleeper_news") or []}
    result["outlook"] = {"sleeper": vals.get("sleeper_outlook")}
    result["depth"] = vals.get("depth")
    try:
        e = _fc_lookup(fantasycalc_values(), sleeper_id, espn_id)
        result["value"] = e["value"] if e else None
        result["ovr_rank"] = e["ovr"] if e else None
        result["pos_rank"] = e["pos"] if e else None
        result["trend"] = e["trend"] if e else None
    except Exception as e:
        print(f"[profile] value lookup failed: {e}")
    try:
        if sleeper_id:
            meta = sleeper_players().get(str(sleeper_id)) or {}
            result["injury"] = _injury_code(meta.get("injury_status"))
    except Exception:
        pass
    try:
        sid = sleeper_id or _sid_for({"espn_id": espn_id, "name": name, "team": team, "pos": pos})
        ranks = season_pos_ranks(season)
        sr = ranks.get(str(sid)) if sid else None
        if sr is None:                       # no stats this season (injured all year, etc.)
            pos_n = "DEF" if (pos or "").upper() in ("DEF", "D/ST") else (pos or "").upper()
            same = [r for r in ranks.values() if r["pos"] == pos_n]
            sr = {"pos": pos_n, "total_rank": None, "total_pts": 0.0, "ppg_rank": None, "ppg": None,
                  "gp": 0, "n": len(same), "n_ppg": sum(1 for r in same if r["gp"]), "season": str(season)}
        result["season_rank"] = sr
    except Exception as e:
        print(f"[profile] season rank failed: {e}")
        result["season_rank"] = None
    return result


# --------------------------------------------------------------------------
# League Lab: power rankings, playoff odds, SoS, recap, waivers, buy/sell,
# vegas edge. Sleeper + ESPN.
# --------------------------------------------------------------------------
_STORE_PATH = os.path.join(HERE, "data", "snapshots.json")


def _load_store():
    try:
        with open(_STORE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_store(d):
    try:
        os.makedirs(os.path.dirname(_STORE_PATH), exist_ok=True)
        with open(_STORE_PATH, "w") as f:
            json.dump(d, f)
    except Exception as e:
        print(f"[store] save failed: {e}")


def sleeper_trending(kind="add", limit=25):
    try:
        return _get_json(f"{SLEEPER}/players/nfl/trending/add?limit={limit}"
                         if kind == "add" else
                         f"{SLEEPER}/players/nfl/trending/drop?limit={limit}")
    except Exception as e:
        print(f"[trending] failed: {e}")
        return []


def _vegas_fp(e):
    """Rough expected (PPR) fantasy points implied by DraftKings lines.
    Needs at least one yardage market -- TD odds alone can't project a player,
    and early in the week DraftKings often has only anytime-TD posted."""
    fp, have_yd = 0.0, False
    for kind, mult in (("pass_yds", 0.04), ("rush_yds", 0.1), ("rec_yds", 0.1)):
        if kind in e:
            L = _implied_line(e[kind])
            if L:
                fp += L * mult
                have_yd = True
    if not have_yd:
        return None
    if "rec" in e:                       # PPR: +1 per implied reception
        R = _implied_line(e["rec"])
        if R:
            fp += R
    if e.get("td") is not None:
        p = _implied_prob(e["td"])
        if p:
            fp += p * 6
    return round(fp, 1)


def _dk_enrich_team(t, dk):
    for p in (t.get("players") or []) + (t.get("bench") or []):
        e = dk.get(_norm_name(p.get("name", "")))
        if e:
            p["vegas"] = {
                "td": e.get("td"),
                "pass": _implied_line(e["pass_yds"]) if "pass_yds" in e else None,
                "rush": _implied_line(e["rush_yds"]) if "rush_yds" in e else None,
                "rec": _implied_line(e["rec_yds"]) if "rec_yds" in e else None,
                "fp": _vegas_fp(e),
            }
        else:
            p["vegas"] = None


def nfl_byes(season):
    """{TEAM: bye_week} for the season, derived from the weekly scoreboard."""
    path = os.path.join(CACHE_DIR, f"byes_{season}.json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 7 * 86400:
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    allt = set(v for v in ESPN_PRO_TEAM.values() if v)
    bye = {}
    for wk in range(4, 15):
        try:
            sb = _get_json("https://site.api.espn.com/apis/site/v2/sports/football/"
                           f"nfl/scoreboard?seasontype=2&week={wk}&dates={season}")
        except Exception:
            continue
        playing = set()
        for e in sb.get("events", []):
            for c in (e.get("competitions") or [{}])[0].get("competitors", []):
                playing.add(canon_team((c.get("team") or {}).get("abbreviation")))
        if len(playing) < 20:
            continue
        for t in allt - playing:
            bye[t] = wk
    try:
        with open(path, "w") as f:
            json.dump(bye, f)
    except Exception:
        pass
    return bye


def _byes_section(teams, byes, cur_week):
    me = next((t for t in teams if t.get("is_me")), None)
    if not me:
        return None
    weeks = {}
    for p in (me.get("players") or []) + (me.get("bench") or []):
        b = byes.get(p.get("team"))
        if b and b >= cur_week:
            weeks.setdefault(b, []).append({"name": p["name"], "pos": p.get("pos"),
                                            "team": p.get("team"), "starter": p.get("starter")})
    return [{"week": w, "players": weeks[w]} for w in sorted(weeks)]


def _sleeper_schedule(league_id, playoff_start):
    sched = {}
    for wk in range(1, playoff_start):
        try:
            ms = _get_json(f"{SLEEPER}/league/{league_id}/matchups/{wk}")
        except Exception:
            continue
        bym = {}
        for m in ms:
            bym.setdefault(m.get("matchup_id"), []).append(m.get("roster_id"))
        for _, rs in bym.items():
            if len(rs) == 2:
                sched.setdefault(rs[0], {})[wk] = rs[1]
                sched.setdefault(rs[1], {})[wk] = rs[0]
    return sched


def _apply_movement(league_id, cur_week, teams):
    store = _load_store()
    key = str(league_id)
    hist = store.get(key, {})
    prior = [int(w) for w in hist if int(w) < cur_week]
    prev = hist[str(max(prior))] if prior else None
    for t in teams:
        pr = prev.get(str(t["id"])) if prev else None
        t["prev_rank"] = pr
        t["movement"] = (pr - t["strength_rank"]) if pr else 0
    hist[str(cur_week)] = {str(t["id"]): t["strength_rank"] for t in teams}
    store[key] = hist
    _save_store(store)


def _sos(teams, schedule, cur_week, playoff_start):
    val = {t["id"]: (t.get("value_total") or 0) for t in teams}
    out = []
    for t in teams:
        opps = schedule.get(t["id"], {})
        rem = [val[opps[w]] for w in opps
               if int(w) >= cur_week and opps[w] in val]
        out.append({"name": t["name"], "is_me": t.get("is_me"),
                    "games": len(rem),
                    "opp_value": round(sum(rem) / len(rem)) if rem else 0})
    out.sort(key=lambda x: x["opp_value"])
    for i, o in enumerate(out, 1):
        o["rank"] = i
    return out


def _recap(teams, schedule, cur_week):
    if not any((t.get("score") or 0) > 0 for t in teams):
        return None
    byid = {t["id"]: t for t in teams}
    top = max(teams, key=lambda t: t.get("score") or 0)
    low = min(teams, key=lambda t: t.get("score") or 0)
    seen, games = set(), []
    for t in teams:
        opp = schedule.get(t["id"], {}).get(cur_week)
        if opp is None or opp not in byid:
            continue
        k = tuple(sorted((t["id"], opp)))
        if k in seen:
            continue
        seen.add(k)
        a, b = byid[t["id"]], byid[opp]
        games.append((a, b, abs((a.get("score") or 0) - (b.get("score") or 0))))

    def gm(g):
        return {"a": g[0]["name"], "as": round(g[0].get("score") or 0, 1),
                "b": g[1]["name"], "bs": round(g[1].get("score") or 0, 1),
                "margin": round(g[2], 1)}
    return {
        "top": {"name": top["name"], "score": round(top.get("score") or 0, 1)},
        "low": {"name": low["name"], "score": round(low.get("score") or 0, 1)},
        "blowout": gm(max(games, key=lambda g: g[2])) if games else None,
        "closest": gm(min(games, key=lambda g: g[2])) if games else None,
    }


def _buy_sell(teams):
    allp = []
    for t in teams:
        for p in (t.get("players") or []) + (t.get("bench") or []):
            if p.get("value") and p.get("trend") is not None:
                allp.append({"name": p["name"], "pos": p.get("pos"),
                             "team": p.get("team"), "value": p["value"],
                             "trend": p["trend"], "owner": t["name"]})
    return {
        "sell": sorted([p for p in allp if p["trend"] > 0],
                       key=lambda p: -p["trend"])[:10],
        "buy": sorted([p for p in allp if p["trend"] < 0 and p["value"] >= 1000],
                      key=lambda p: p["trend"])[:10],
    }


def _vegas_edge(teams):
    out = []
    for t in teams:
        for p in (t.get("players") or []) + (t.get("bench") or []):
            v, proj = p.get("vegas"), p.get("projected")
            if v and v.get("fp") is not None and proj is not None:
                out.append({"name": p["name"], "pos": p.get("pos"),
                            "team": p.get("team"), "owner": t["name"],
                            "proj": round(proj, 1), "vegas_fp": v["fp"],
                            "edge": round(v["fp"] - proj, 1)})
    out.sort(key=lambda x: -x["edge"])
    return {"over": out[:8], "under": list(reversed(out[-8:])) if len(out) > 8 else []}


def _waivers(teams, fc, trending):
    rostered = set()
    for t in teams:
        for p in (t.get("players") or []) + (t.get("bench") or []):
            if p.get("sleeper_id"):
                rostered.add("s" + str(p["sleeper_id"]))
            if p.get("espn_id"):
                rostered.add("e" + str(p["espn_id"]))
    trend_ids = set(str(x.get("player_id")) for x in (trending or []))
    out = []
    for e in fc.get("list", []):
        sid, eid = e.get("sleeper_id"), e.get("espn_id")
        if (sid and "s" + sid in rostered) or (eid and "e" + eid in rostered):
            continue
        if not e.get("value"):
            continue
        out.append({"name": e.get("name"), "pos": e.get("position"),
                    "team": e.get("team"), "value": e["value"],
                    "trend": e.get("trend"),
                    "hot": bool(sid and sid in trend_ids)})
        if len(out) >= 25:
            break
    return out


def _sim_playoffs(teams, schedule, cur_week, playoff_start, playoff_teams, n=1500):
    import random
    strength = {t["id"]: max(t.get("value_total") or 1, 1) for t in teams}
    base = {t["id"]: t.get("wins", 0) for t in teams}
    made = {t["id"]: 0 for t in teams}
    games = []
    for wk in range(cur_week, playoff_start):
        seen = set()
        for tid, opps in schedule.items():
            opp = opps.get(wk)
            if opp is None or opp not in strength or tid not in strength:
                continue
            k = tuple(sorted((tid, opp)))
            if k in seen:
                continue
            seen.add(k)
            games.append((tid, opp))
    ids = list(strength)
    for _ in range(n):
        w = dict(base)
        for a, b in games:
            if random.random() < strength[a] / (strength[a] + strength[b]):
                w[a] += 1
            else:
                w[b] += 1
        order = sorted(ids, key=lambda t: (-w[t], -strength[t]))
        for t in order[:playoff_teams]:
            made[t] += 1
    return {t: round(made[t] / n * 100) for t in made}


def _assemble_lab(league_id, provider, name, week, teams, schedule,
                  cur_week, playoff_start, playoff_teams, fc, trending, byes=None):
    for rank, t in enumerate(sorted(teams, key=lambda x: -(x.get("value_total") or 0)), 1):
        t["strength_rank"] = rank
    _apply_movement(league_id, cur_week, teams)
    playoff = _sim_playoffs(teams, schedule, cur_week, playoff_start, playoff_teams)
    for t in teams:
        t["playoff_pct"] = playoff.get(t["id"])
    keys = ("name", "is_me", "record", "wins", "losses", "ties", "pf", "pa",
            "value_total", "strength_rank", "prev_rank", "movement", "score",
            "playoff_pct")
    standings = sorted(teams, key=lambda x: (-(x.get("wins") or 0), -(x.get("pf") or 0)))
    name_of = {t["id"]: t["name"] for t in teams}
    this_week, seen = [], set()
    for tid, opps in schedule.items():
        opp = opps.get(cur_week)
        if opp is None or (opp, tid) in seen:
            continue
        seen.add((tid, opp))
        this_week.append({"a": name_of.get(tid), "b": name_of.get(opp)})
    remaining = {name_of.get(tid): [f"wk{w}: {name_of.get(o)}" for w, o in sorted(opps.items())
                                    if cur_week < w < playoff_start]
                 for tid, opps in schedule.items() if tid in name_of}
    return {
        "provider": provider, "league_name": name, "week": week,
        "playoff_start": playoff_start, "playoff_teams": playoff_teams,
        "matchups_week": this_week, "remaining": remaining,
        "teams": [{k: t.get(k) for k in keys} for t in standings],
        "power": [{"name": t["name"], "is_me": t.get("is_me"),
                   "value_total": t["value_total"], "rank": t["strength_rank"],
                   "movement": t.get("movement"), "record": t.get("record")}
                  for t in sorted(teams, key=lambda x: x["strength_rank"])],
        "sos": _sos(teams, schedule, cur_week, playoff_start),
        "recap": _recap(teams, schedule, cur_week),
        "buysell": _buy_sell(teams),
        "vegas_edge": _vegas_edge(teams),
        "waivers": _waivers(teams, fc, trending),
        "byes": _byes_section(teams, byes or {}, cur_week),
    }


def league_lab_sleeper(league_id, my_user_id, week, players, nfl, override=None):
    league, rosters, roster_by_id, user_name, matchups, projections, slots = _sl_common(
        league_id, week)
    settings = league.get("settings", {})
    playoff_start = settings.get("playoff_week_start") or 15
    playoff_teams = settings.get("playoff_teams") or 6
    fc = _fc_for(len(rosters), _sleeper_val_params(league, override))
    dk = dk_props()
    by_roster = {m["roster_id"]: m for m in matchups}
    gstart = _global_starters(matchups)
    teams = []
    for r in rosters:
        m = by_roster.get(r["roster_id"])
        if not m:
            continue
        t = _sl_build_team(m, r, user_name, players, projections, nfl, slots, gstart)
        st = r.get("settings", {})
        t["id"] = r["roster_id"]
        t["is_me"] = r.get("owner_id") == my_user_id
        t["wins"] = st.get("wins", 0)
        t["losses"] = st.get("losses", 0)
        t["ties"] = st.get("ties", 0)
        t["pf"] = round(st.get("fpts", 0) + st.get("fpts_decimal", 0) / 100, 2)
        t["pa"] = round(st.get("fpts_against", 0) + st.get("fpts_against_decimal", 0) / 100, 2)
        _fc_enrich_team(t, fc)
        _dk_enrich_team(t, dk)
        teams.append(t)
    schedule = _sleeper_schedule(league_id, playoff_start)
    byes = nfl_byes(league.get("season"))
    return _assemble_lab(league_id, "sleeper", league.get("name", "Sleeper league"),
                         week, teams, schedule, week, playoff_start, playoff_teams,
                         fc, sleeper_trending(), byes)


def league_lab_espn(league_id, espn_s2, swid, season, week, nfl, override=None):
    league = _espn_fetch(league_id, espn_s2, swid, season, week)
    name = (league.get("settings") or {}).get("name", "ESPN league")
    ss = ((league.get("settings") or {}).get("scheduleSettings") or {})
    playoff_teams = ss.get("playoffTeamCount") or 6
    reg = ss.get("matchupPeriodCount") or 14
    playoff_start = reg + 1
    raw_teams = league.get("teams", [])
    my_id = _espn_my_team_id(league, swid)
    fc = _fc_for(len(raw_teams), _espn_val_params(league, override))
    dk = dk_props()
    teams = []
    for raw in raw_teams:
        t = _espn_build_team(raw, week, nfl)
        if not t:
            continue
        ov = (raw.get("record") or {}).get("overall", {})
        t["id"] = raw.get("id")
        t["is_me"] = raw.get("id") == my_id
        t["wins"] = ov.get("wins", 0)
        t["losses"] = ov.get("losses", 0)
        t["ties"] = ov.get("ties", 0)
        t["pf"] = round(ov.get("pointsFor", 0), 2)
        t["pa"] = round(ov.get("pointsAgainst", 0), 2)
        _fc_enrich_team(t, fc)
        _dk_enrich_team(t, dk)
        teams.append(t)
    # schedule from ESPN's schedule array (regular season only)
    schedule = {}
    for g in league.get("schedule", []):
        mp = g.get("matchupPeriodId")
        if mp is None or mp >= playoff_start:
            continue
        h = (g.get("home") or {}).get("teamId")
        a = (g.get("away") or {}).get("teamId")
        if h is None or a is None:
            continue
        schedule.setdefault(h, {})[mp] = a
        schedule.setdefault(a, {})[mp] = h
    return _assemble_lab(league_id, "espn", name, week, teams, schedule,
                         week, playoff_start, playoff_teams, fc, [],
                         nfl_byes(str(season)))


# --------------------------------------------------------------------------
# Game Day: live play-by-play feed for a matchup's players (ESPN summary),
# per-player live box (Sleeper week stats), Vegas-based lineup optimizer
# --------------------------------------------------------------------------
_PLAYS_CACHE = {}          # event_id -> {"ts", "data"}
_ESPN_TEAM_ABBR = {str(k): v for k, v in ESPN_PRO_TEAM.items() if v}


def espn_game_plays(event_id):
    """All plays so far in one NFL game (newest last), cached ~15s."""
    now = time.time()
    c = _PLAYS_CACHE.get(str(event_id))
    if c and now - c["ts"] < 15:
        return c["data"]
    s = _get_json("https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary"
                  f"?event={event_id}", timeout=20)
    drives = s.get("drives") or {}
    raw = []
    for d in (drives.get("previous") or []):
        raw.extend(d.get("plays") or [])
    cur = drives.get("current")
    if cur:
        raw.extend(cur.get("plays") or [])
    hdr = (s.get("header") or {}).get("competitions") or [{}]
    comps = hdr[0].get("competitors") or []
    home = away = None
    for cp in comps:
        ab = canon_team((cp.get("team") or {}).get("abbreviation"))
        if cp.get("homeAway") == "home":
            home = ab
        else:
            away = ab
    seen, plays = set(), []
    for p in raw:
        pid = p.get("id")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        poss = canon_team(_ESPN_TEAM_ABBR.get(str(((p.get("start") or {}).get("team") or {}).get("id"))))
        plays.append({
            "id": pid, "seq": int(p.get("sequenceNumber") or 0),
            "text": p.get("text") or "", "type": ((p.get("type") or {}).get("text")) or "",
            "period": (p.get("period") or {}).get("number"),
            "clock": (p.get("clock") or {}).get("displayValue"),
            "scoring": bool(p.get("scoringPlay")), "turnover": bool(p.get("isTurnover")),
            "wallclock": p.get("wallclock"), "yards": p.get("statYardage"),
            "poss": poss, "home_score": p.get("homeScore"), "away_score": p.get("awayScore"),
        })
    plays.sort(key=lambda x: x["seq"])
    data = {"event": str(event_id), "home": home, "away": away, "plays": plays}
    _PLAYS_CACHE[str(event_id)] = {"ts": now, "data": data}
    return data


_SUFFIX_RE = _re.compile(r"\b(jr|sr|ii|iii|iv|v)\.?$", _re.I)


def _play_name_regex(name):
    """ESPN play text abbreviates players as 'D.Maye' / 'Ja.Williams' /
    'A.St. Brown'. Build a regex matching that form for a full name."""
    nm = _SUFFIX_RE.sub("", (name or "").strip()).strip()
    parts = nm.split()
    if len(parts) < 2:
        return None
    first, last = parts[0], " ".join(parts[1:])
    last_rx = _re.escape(last).replace(r"\.", r"\.?").replace(r"\ ", r"\s?")
    return _re.compile(r"\b" + _re.escape(first[0]) + r"[a-z]{0,2}\.\s?" + last_rx + r"\b")


_DEF_PLAY_TYPES = ("interception", "sack", "fumble recovery (opponent)", "safety",
                   "blocked", "defensive")


def live_feed(players, limit=250):
    """Events from every NFL game involving the given players, newest first.
    players: [{name, team, pos, side}] where side is 'me' / 'opp'."""
    nfl = nfl_game_status()
    by_event = {}
    for p in players:
        team = canon_team(p.get("team"))
        g = nfl.get(team) or {}
        if not g.get("event") or g.get("status") == "pre":
            continue
        by_event.setdefault(g["event"], []).append(dict(p, team=team))
    games, events = [], []
    for eid, plist in by_event.items():
        try:
            gp = espn_game_plays(eid)
        except Exception as e:
            print(f"[feed] plays for {eid} failed: {e}")
            continue
        home, away = gp["home"], gp["away"]
        st = nfl.get(home) or nfl.get(away) or {}
        games.append({"event": eid, "home": home, "away": away,
                      "home_pts": (nfl.get(home) or {}).get("pts"), "away_pts": (nfl.get(away) or {}).get("pts"),
                      "status": st.get("status"), "detail": st.get("detail"),
                      "players": [{"name": p["name"], "side": p.get("side"), "pos": p.get("pos")} for p in plist]})
        skill = [(p, _play_name_regex(p["name"])) for p in plist
                 if (p.get("pos") or "").upper() not in ("DEF", "D/ST")]
        defs = [p for p in plist if (p.get("pos") or "").upper() in ("DEF", "D/ST")]
        for pl in gp["plays"]:
            hits = []
            for p, rx in skill:
                if rx and rx.search(pl["text"]):
                    hits.append({"name": p["name"], "pos": p.get("pos"), "side": p.get("side"), "team": p["team"]})
            tl = (pl["type"] or "").lower()
            if defs and pl["poss"] and any(k in tl for k in _DEF_PLAY_TYPES):
                for p in defs:
                    if p["team"] != pl["poss"]:
                        hits.append({"name": p["name"], "pos": "DEF", "side": p.get("side"), "team": p["team"]})
            if not hits:
                continue
            events.append({**pl, "game": f"{away} @ {home}", "home": home, "away": away, "players": hits})
    events.sort(key=lambda e: (e.get("wallclock") or "", e["seq"]), reverse=True)
    return {"games": games, "events": events[:limit], "ts": int(time.time())}


_LIVE_ROWS = {
    "QB": [("pass_cmp", "Comp"), ("pass_att", "Att"), ("pass_yd", "Pass yds"), ("pass_td", "Pass TD"),
           ("pass_int", "INT"), ("pass_sack", "Sacked"), ("rush_att", "Carries"), ("rush_yd", "Rush yds"),
           ("rush_td", "Rush TD"), ("fum_lost", "Fumbles lost"), ("pass_rtg", "Rating")],
    "RB": [("rush_att", "Carries"), ("rush_yd", "Rush yds"), ("rush_td", "Rush TD"), ("rush_lng", "Long"),
           ("rec_tgt", "Targets"), ("rec", "Receptions"), ("rec_yd", "Rec yds"), ("rec_td", "Rec TD"),
           ("fum_lost", "Fumbles lost"), ("off_snp", "Snaps")],
    "WR": [("rec_tgt", "Targets"), ("rec", "Receptions"), ("rec_yd", "Rec yds"), ("rec_td", "Rec TD"),
           ("rec_lng", "Long"), ("rec_rz_tgt", "RZ targets"), ("rush_att", "Carries"), ("rush_yd", "Rush yds"),
           ("rush_td", "Rush TD"), ("fum_lost", "Fumbles lost"), ("off_snp", "Snaps")],
    "K": [("fgm", "FG made"), ("fga", "FG att"), ("fgm_lng", "Long"), ("xpm", "XP made"), ("xpa", "XP att")],
    "DEF": [("sack", "Sacks"), ("int", "INT"), ("fum_rec", "Fum rec"), ("def_td", "TD"), ("safe", "Safeties"),
            ("pts_allow", "Pts allowed"), ("yds_allow", "Yds allowed"), ("blk_kick", "Blocked kicks")],
}
_LIVE_ROWS["TE"] = _LIVE_ROWS["WR"]


def player_live(sleeper_id, espn_id, name, team, pos):
    """Live/this-week box for one player from Sleeper's week stats + ESPN game state."""
    pos_n = "DEF" if (pos or "").upper() in ("DEF", "D/ST") else (pos or "").upper()
    sid = sleeper_id or _sid_for({"sleeper_id": sleeper_id, "espn_id": espn_id,
                                  "name": name, "team": team, "pos": pos_n})
    ws = _cur_week_stats()
    s = ws.get(str(sid)) if sid else None
    g = nfl_game_status().get(canon_team(team)) or {}
    rows = []
    for key, label in _LIVE_ROWS.get(pos_n, _LIVE_ROWS["WR"]):
        v = (s or {}).get(key)
        if v is None and key not in ("pass_yd", "rush_yd", "rec_yd", "rec", "rec_tgt", "rush_att", "pass_att", "fgm", "sack"):
            continue
        if key == "off_snp" and s and s.get("tm_off_snp"):
            v = f"{_num(v or 0)} ({round(100 * (v or 0) / s['tm_off_snp'])}%)"
        rows.append({"label": label, "value": _num(v or 0)})
    pts = {k: round((s or {}).get(k) or 0, 2) for k in ("pts_ppr", "pts_half_ppr", "pts_std")}
    return {
        "name": name, "pos": pos_n, "team": canon_team(team), "sleeper_id": sid,
        "week": _WSTATS.get("wk"), "found": bool(s),
        "game": {"status": g.get("status", "pre"), "detail": g.get("detail", ""), "opp": g.get("opp"),
                 "ha": g.get("ha"), "pts": g.get("pts"), "opp_pts": g.get("opp_pts"),
                 "redzone": g.get("redzone"), "possession": g.get("possession")},
        "rows": rows, "pts": pts, "statline": _statline(pos_n, s) if s else None,
        "ts": int(time.time()),
    }


_SLOT_ELIG = {
    "QB": ("QB",), "RB": ("RB",), "WR": ("WR",), "TE": ("TE",), "K": ("K",), "DEF": ("DEF",),
    "FLEX": ("RB", "WR", "TE"), "SFLEX": ("QB", "RB", "WR", "TE"), "WRT": ("WR", "TE"),
    "WRRB": ("WR", "RB"), "IDP": ("DL", "LB", "DB"),
}


def _best_lineup(players, slots, key):
    """Greedy best lineup (most restrictive slots first). Returns [(slot, player|None)]."""
    order = sorted(range(len(slots)), key=lambda i: len(_SLOT_ELIG.get(slots[i], (slots[i],))))
    used, assign = set(), {}
    for i in order:
        elig = _SLOT_ELIG.get(slots[i], (slots[i],))
        best, bv = None, -1e9
        for j, p in enumerate(players):
            if j in used or (p.get("pos") or "").upper() not in elig:
                continue
            v = p.get(key) or 0
            if v > bv:
                best, bv = j, v
        if best is not None:
            used.add(best)
            assign[i] = players[best]
    return [(slots[i], assign.get(i)) for i in range(len(slots))]


def vegas_lineup(team, slots, dk, nfl):
    """Optimal lineup using Vegas-implied points for games yet to start
    (DraftKings props), live projection for games in progress, and actual
    points for finished games. Falls back to the site projection where no
    props are posted."""
    _dk_enrich_team(team, dk)
    pool = []
    for p in (team.get("players") or []) + (team.get("bench") or []):
        if not p.get("name") or p["name"] == "(empty)":
            continue
        st = p.get("game_status")
        v = p.get("vegas") or {}
        if st == "post":
            exp, src = p.get("points") or 0, "final"
        elif st == "in":
            exp, src = (p.get("proj_live") if p.get("proj_live") is not None else p.get("points") or 0), "live"
        elif v.get("fp") is not None:
            exp, src = v["fp"], "vegas"
        else:
            exp, src = (p.get("projected") or 0), "proj"
        if (p.get("injury") or "") in ("O", "IR", "SUS", "PUP", "COV", "NA", "DNR") and st != "post":
            exp, src = 0, "out"
        q = dict(p)
        q["exp"], q["exp_src"] = round(float(exp), 1), src
        q["vegas_lines"] = {k: v.get(k) for k in ("pass", "rush", "rec", "td")} if v else None
        pool.append(q)
    slots = [s for s in (slots or []) if s]
    if not slots:
        slots = [(p.get("slot") or p.get("pos") or "").upper() for p in team.get("players") or []]
    by_key = {pkey_of(p): p for p in pool}
    current = [(p.get("slot") or p.get("pos"), by_key.get(pkey_of(p)))
               for p in (team.get("players") or []) if p.get("name") and p["name"] != "(empty)"]
    optimal = _best_lineup(pool, slots, "exp")
    cur_set = {pkey_of(p) for _, p in current if p}
    opt_set = {pkey_of(p) for _, p in optimal if p}
    strip = lambda p: None if p is None else {k: p.get(k) for k in (
        "name", "pos", "team", "slot", "exp", "exp_src", "vegas_lines", "projected", "points", "proj_live",
        "game_status", "game_detail", "opp", "opp_ha", "injury", "sleeper_id", "espn_id", "value")}
    return {
        "team": team.get("name"),
        "slots": slots,
        "current": [{"slot": s, "player": strip(p)} for s, p in current],
        "optimal": [{"slot": s, "player": strip(p)} for s, p in optimal],
        "current_total": round(sum((p or {}).get("exp") or 0 for _, p in current), 1),
        "optimal_total": round(sum((p or {}).get("exp") or 0 for _, p in optimal), 1),
        "start": [strip(p) for _, p in optimal if p and pkey_of(p) not in cur_set],
        "sit": [strip(p) for _, p in current if p and pkey_of(p) not in opt_set],
        "vegas_count": sum(1 for p in pool if p["exp_src"] == "vegas"),
        "ts": int(time.time()),
    }


def pkey_of(p):
    return str(p.get("sleeper_id") or p.get("espn_id") or p.get("name"))


# --------------------------------------------------------------------------
# Season position ranks (by total points and by points per game)
# --------------------------------------------------------------------------
_POS_RANKS = {"season": None, "ts": 0, "data": {}}


def season_pos_ranks(season):
    """{sleeper_id: {pos, total_rank, total_pts, ppg_rank, ppg, gp, n}} for the
    season, PPR scoring. ppg rank counts anyone who has played a game, so an
    injured star still shows where he stands per game."""
    now = time.time()
    if _POS_RANKS["season"] == str(season) and now - _POS_RANKS["ts"] < 600 and _POS_RANKS["data"]:
        return _POS_RANKS["data"]
    stats = season_stats(season)
    pdb = sleeper_players()
    by_pos = {}
    for sid, s in stats.items():
        meta = pdb.get(sid) or {}
        pos = "DEF" if pos_is_def(meta) or (not meta and not sid.isdigit()) else meta.get("position")
        if pos not in ("QB", "RB", "WR", "TE", "K", "DEF"):
            continue
        pts = s.get("pts_ppr") or 0
        gp = int(s.get("gp") or 0)
        by_pos.setdefault(pos, []).append((sid, round(pts, 1), gp))
    out = {}
    for pos, rows in by_pos.items():
        rows = [r for r in rows if r[1] > 0 or r[2] > 0]
        tot = sorted(rows, key=lambda r: -r[1])
        avg = sorted((r for r in rows if r[2] > 0), key=lambda r: -(r[1] / r[2]))
        total_rank = {sid: i + 1 for i, (sid, _, _) in enumerate(tot)}
        ppg_rank = {sid: i + 1 for i, (sid, _, _) in enumerate(avg)}
        for sid, pts, gp in rows:
            out[sid] = {"pos": pos, "total_rank": total_rank.get(sid), "total_pts": pts,
                        "ppg_rank": ppg_rank.get(sid), "ppg": round(pts / gp, 1) if gp else None,
                        "gp": gp, "n": len(tot), "n_ppg": len(avg), "season": str(season)}
    _POS_RANKS.update(season=str(season), ts=now, data=out)
    return out


# --------------------------------------------------------------------------
# Missed games: fill DNP rows into a game log from the team's schedule
# --------------------------------------------------------------------------
_SCHED_CACHE = {}


def team_schedule(team, season):
    """Completed regular-season games for a team: {week: {opp, atVs, result, score}}."""
    team = canon_team(team)
    key = (team, str(season))
    now = time.time()
    c = _SCHED_CACHE.get(key)
    cur = str(season) == str(sleeper_state().get("season"))
    if c and now - c["ts"] < (1800 if cur else 86400):
        return c["data"]
    code = {"WAS": "wsh"}.get(team, team).lower()
    out = {}
    try:
        sch = _get_json("https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/"
                        f"{code}/schedule?season={season}", timeout=20)
        for ev in sch.get("events") or []:
            if ((ev.get("seasonType") or {}).get("type") or 2) != 2:
                continue
            wk = (ev.get("week") or {}).get("number")
            comp = (ev.get("competitions") or [{}])[0]
            st = (comp.get("status") or {}).get("type") or {}
            if wk is None or not st.get("completed"):
                continue
            me = opp = None
            for x in comp.get("competitors") or []:
                ab = canon_team((x.get("team") or {}).get("abbreviation"))
                if ab == team:
                    me = x
                else:
                    opp = x
            if not me or not opp:
                continue
            sc = lambda x: (x.get("score") or {}).get("displayValue") if isinstance(x.get("score"), dict) else x.get("score")
            res = "W" if me.get("winner") else ("L" if opp.get("winner") else "T")
            out[int(wk)] = {"opp": canon_team((opp.get("team") or {}).get("abbreviation")),
                            "atVs": "@" if me.get("homeAway") == "away" else "vs",
                            "result": res, "score": f"{sc(me)}-{sc(opp)}"}
    except Exception as e:
        print(f"[schedule] {team} {season} failed: {e}")
        if c:
            return c["data"]
    _SCHED_CACHE[key] = {"ts": now, "data": out}
    return out


def _fill_missed_games(gl, season, fallback_team):
    """Add zero rows (dnp=True) for completed team games the player has no
    row for. The player's team per week is taken from the nearest logged game,
    so mid-season trades don't create phantom misses."""
    rows = [r for r in gl.get("rows") or [] if not r.get("playoff")]
    cols = gl.get("columns") or []
    if not season or not cols:
        return gl
    week_team = {r["week"]: canon_team(r.get("team")) for r in rows
                 if isinstance(r.get("week"), int) and r.get("team")}
    played = {r["week"] for r in rows if isinstance(r.get("week"), int)}
    fallback_team = canon_team(fallback_team)
    teams = set(week_team.values()) | ({fallback_team} if fallback_team else set())
    if not teams:
        return gl
    sched = {t: team_schedule(t, season) for t in teams}
    all_weeks = sorted({w for s in sched.values() for w in s})

    def team_for(w):
        if not week_team:
            return fallback_team
        before = [k for k in week_team if k <= w]
        after = [k for k in week_team if k > w]
        return week_team[max(before)] if before else week_team[min(after)]

    added = []
    for w in all_weeks:
        if w in played:
            continue
        t = team_for(w)
        g = (sched.get(t) or {}).get(w)
        if not g:
            continue
        added.append({"week": w, "date": None, "atVs": g["atVs"], "opp": g["opp"],
                      "opp_logo": _logo_url(g["opp"]), "result": g["result"], "score": g["score"],
                      "fpts": 0.0, "values": [0] * len(cols), "playoff": False, "dnp": True, "team": t})
    if added:
        gl["rows"] = sorted((gl.get("rows") or []) + added,
                            key=lambda r: (bool(r.get("playoff")), r["week"] if isinstance(r.get("week"), int) else 999))
        gl["missed"] = len(added)
    return gl



# --------------------------------------------------------------------------
# Playground: build a roster-style player dict for any player, in a league's
# value format (so the "what if" roster compares like-for-like)
# --------------------------------------------------------------------------
def player_card(rosters, sleeper_id=None, espn_id=None, name=None, team=None, pos=None):
    pdb = sleeper_players()
    sid = str(sleeper_id) if sleeper_id else (_sid_for({"espn_id": espn_id, "name": name, "team": team, "pos": pos}) or None)
    meta = pdb.get(sid) if sid else None
    if meta:
        if pos_is_def(meta):
            pos, team = "DEF", canon_team(meta.get("team") or sid)
            name = f"{team} D/ST"
        else:
            name = meta.get("full_name") or name
            pos = meta.get("position") or pos
            team = canon_team(meta.get("team"))
        espn_id = str(meta.get("espn_id")) if meta.get("espn_id") else espn_id
    sc = rosters.get("scoring") or {}
    season, week = rosters.get("season"), rosters.get("week")
    fc = _fc_for(sc.get("teams") or 12, {"num_qbs": sc.get("num_qbs", 1), "ppr": sc.get("ppr", 1),
                                         "dynasty": bool(sc.get("dynasty"))})
    proj = _sleeper_projections(season, week, sc.get("ppr", 1)) if season and week else {}
    nfl = nfl_game_status()
    g = nfl.get(canon_team(team)) or {}
    p = {"name": name, "pos": pos, "team": canon_team(team), "sleeper_id": sid, "espn_id": espn_id,
         "points": 0, "projected": proj.get(sid) if sid else None, "starter": False, "slot": None,
         "game_status": g.get("status", "pre"), "game_detail": g.get("detail", ""),
         "opp": g.get("opp"), "opp_ha": g.get("ha"),
         "injury": _injury_code((meta or {}).get("injury_status"))}
    _fc_enrich(p, fc)
    _season_enrich_team({"players": [p], "bench": []}, season_stats(season), nfl_byes(season),
                        sc.get("ppr", 1), season_pos_ranks(season))
    return p
