#!/usr/bin/env python3
"""
Local fantasy football dashboard server (zero dependencies, stdlib only).

Run:   python3 server.py
Then open http://localhost:8787 in your browser.

Reads config.json for your Sleeper + ESPN leagues. Nothing is ever written
back to either service -- this only reads scores.
"""

import json
import os
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fantasy

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8787"))


def load_config():
    path = os.path.join(HERE, "config.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def build_dashboard():
    cfg = load_config()
    if cfg is None:
        return {"error": "config.json not found. Copy config.example.json to "
                         "config.json and fill it in."}

    state = fantasy.sleeper_state()
    season = str(cfg.get("season") or state.get("season"))
    week = int(cfg.get("week") or state.get("display_week") or state.get("week") or 1)
    nfl = fantasy.nfl_game_status()

    tasks = []  # (label, callable)

    # ---- Sleeper ----
    sl = cfg.get("sleeper") or {}
    sleeper_user = sl.get("username")
    sleeper_user_id = sl.get("user_id")
    sleeper_league_ids = sl.get("league_ids") or []
    players = {}
    if sleeper_user or sleeper_user_id or sleeper_league_ids:
        players = fantasy.sleeper_players()
        if not sleeper_user_id and sleeper_user:
            try:
                sleeper_user_id = fantasy.sleeper_user_id(sleeper_user)
            except Exception as e:
                print(f"[sleeper] username lookup failed: {e}")
        if not sleeper_league_ids and sleeper_user_id:
            try:
                discovered = fantasy.sleeper_discover_leagues(sleeper_user_id, season)
                sleeper_league_ids = [lg["league_id"] for lg in discovered]
            except Exception as e:
                print(f"[sleeper] league discovery failed: {e}")
        for lid in sleeper_league_ids:
            tasks.append((
                f"sleeper:{lid}",
                lambda lid=lid: fantasy.sleeper_league_payload(
                    lid, sleeper_user_id, week, players, nfl)
            ))

    # ---- ESPN ----
    for lg in cfg.get("espn") or []:
        lid = lg.get("league_id")
        s2 = lg.get("espn_s2")
        swid = lg.get("swid") or lg.get("SWID")
        if not (lid and s2 and swid):
            continue
        tasks.append((
            f"espn:{lid}",
            lambda lid=lid, s2=s2, swid=swid: fantasy.espn_league_payload(
                lid, s2, swid, season, week, nfl)
        ))

    leagues = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(fn): label for label, fn in tasks}
        results = {}
        for fut, label in futures.items():
            try:
                results[label] = fut.result()
            except Exception as e:
                results[label] = {"error": f"{e}", "label": label}
                traceback.print_exc()
    # preserve task order
    for label, _ in tasks:
        payload = results.get(label, {"error": "no result"})
        if payload and not payload.get("error"):
            payload["win_prob"] = fantasy.win_probability(
                payload.get("my_team"), payload.get("opp_team"))
        leagues.append(payload)

    return {"season": season, "week": week, "leagues": leagues}


def build_rosters(full_id):
    """Return every team's full roster for a single league (all-rosters view).

    full_id looks like 'sleeper:<league_id>' or 'espn:<league_id>'."""
    cfg = load_config()
    if cfg is None:
        return {"error": "config.json not found."}
    if ":" not in full_id:
        return {"error": "bad league id"}
    provider, league_id = full_id.split(":", 1)

    state = fantasy.sleeper_state()
    season = str(cfg.get("season") or state.get("season"))
    week = int(cfg.get("week") or state.get("display_week") or state.get("week") or 1)
    nfl = fantasy.nfl_game_status()

    if provider == "sleeper":
        players = fantasy.sleeper_players()
        sl = cfg.get("sleeper") or {}
        my_uid = sl.get("user_id")
        if not my_uid and sl.get("username"):
            try:
                my_uid = fantasy.sleeper_user_id(sl["username"])
            except Exception as e:
                print(f"[rosters] sleeper user lookup failed: {e}")
        return fantasy.sleeper_all_rosters(league_id, week, players, nfl, my_uid)

    if provider == "espn":
        for lg in cfg.get("espn") or []:
            if str(lg.get("league_id")) == str(league_id):
                s2 = lg.get("espn_s2")
                swid = lg.get("swid") or lg.get("SWID")
                return fantasy.espn_all_rosters(league_id, s2, swid, season, week, nfl)
        return {"error": "league not found in config"}

    return {"error": "unknown provider"}


_espn_to_sleeper = {"built_for": None, "map": {}}


def _espn_sleeper_index(players):
    """Cache an ESPN athlete id -> Sleeper player id map from the player DB."""
    if _espn_to_sleeper["built_for"] is id(players):
        return _espn_to_sleeper["map"]
    m = {}
    for pid, meta in players.items():
        eid = meta.get("espn_id")
        if eid:
            m[str(eid)] = str(pid)
    _espn_to_sleeper["built_for"] = id(players)
    _espn_to_sleeper["map"] = m
    return m


def _current_season():
    try:
        return str(fantasy.sleeper_state().get("season"))
    except Exception:
        return "2025"


def build_player(params):
    espn_id = (params.get("espn_id") or [""])[0] or None
    sleeper_id = (params.get("sleeper_id") or [""])[0] or None
    team = (params.get("team") or [""])[0] or None
    pos = (params.get("pos") or [""])[0] or None
    name = (params.get("name") or [""])[0] or "Player"
    season = (params.get("season") or [""])[0] or _current_season()

    players = fantasy.sleeper_players()
    if sleeper_id and not espn_id:
        espn_id = (players.get(str(sleeper_id)) or {}).get("espn_id")
        espn_id = str(espn_id) if espn_id else None
    if espn_id and not sleeper_id:
        sleeper_id = _espn_sleeper_index(players).get(str(espn_id))
    return fantasy.player_profile(espn_id, sleeper_id, team, pos, name, season)


def build_gamelog(params):
    espn_id = (params.get("espn_id") or [""])[0] or None
    season = (params.get("season") or [""])[0] or None
    if not espn_id:
        return {"error": "no espn_id"}
    return fantasy.espn_gamelog(espn_id, season)


def build_league_lab(full_id):
    cfg = load_config()
    if cfg is None:
        return {"error": "config.json not found."}
    if ":" not in full_id:
        return {"error": "bad league id"}
    provider, league_id = full_id.split(":", 1)
    state = fantasy.sleeper_state()
    season = str(cfg.get("season") or state.get("season"))
    week = int(cfg.get("week") or state.get("display_week") or state.get("week") or 1)
    nfl = fantasy.nfl_game_status()

    if provider == "sleeper":
        players = fantasy.sleeper_players()
        sl = cfg.get("sleeper") or {}
        my_uid = sl.get("user_id")
        if not my_uid and sl.get("username"):
            try:
                my_uid = fantasy.sleeper_user_id(sl["username"])
            except Exception:
                pass
        return fantasy.league_lab_sleeper(league_id, my_uid, week, players, nfl)

    if provider == "espn":
        for lg in cfg.get("espn") or []:
            if str(lg.get("league_id")) == str(league_id):
                return fantasy.league_lab_espn(
                    league_id, lg.get("espn_s2"), lg.get("swid") or lg.get("SWID"),
                    season, week, nfl)
        return {"error": "league not found in config"}
    return {"error": "unknown provider"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # quiet

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        from urllib.parse import urlsplit, parse_qs
        parts = urlsplit(self.path)
        path = parts.path
        if path == "/api/dashboard":
            try:
                self._send(200, build_dashboard())
            except Exception as e:
                traceback.print_exc()
                self._send(500, {"error": str(e)})
            return
        if path == "/api/rosters":
            q = parse_qs(parts.query)
            fid = (q.get("id") or [""])[0]
            try:
                self._send(200, build_rosters(fid))
            except Exception as e:
                traceback.print_exc()
                self._send(500, {"error": str(e)})
            return
        if path == "/api/player":
            try:
                self._send(200, build_player(parse_qs(parts.query)))
            except Exception as e:
                traceback.print_exc()
                self._send(500, {"error": str(e)})
            return
        if path == "/api/player/gamelog":
            try:
                self._send(200, build_gamelog(parse_qs(parts.query)))
            except Exception as e:
                traceback.print_exc()
                self._send(500, {"error": str(e)})
            return
        if path == "/api/league":
            q = parse_qs(parts.query)
            try:
                self._send(200, build_league_lab((q.get("id") or [""])[0]))
            except Exception as e:
                traceback.print_exc()
                self._send(500, {"error": str(e)})
            return
        if path == "/api/player/odds":
            q = parse_qs(parts.query)
            try:
                self._send(200, fantasy.player_odds(
                    (q.get("name") or [""])[0],
                    (q.get("team") or [""])[0] or None,
                    (q.get("pos") or [""])[0] or None))
            except Exception as e:
                traceback.print_exc()
                self._send(500, {"error": str(e)})
            return
        if path in ("/", "/index.html"):
            return self._serve_static("index.html", "text/html; charset=utf-8")
        if path.startswith("/static/"):
            name = os.path.basename(path)
            ctype = ("text/css" if name.endswith(".css")
                     else "application/javascript" if name.endswith(".js")
                     else "application/octet-stream")
            return self._serve_static(name, ctype)
        self._send(404, {"error": "not found"})

    def _serve_static(self, name, ctype):
        fpath = os.path.join(HERE, "static", name)
        if not os.path.exists(fpath):
            return self._send(404, {"error": "not found"})
        with open(fpath, "rb") as f:
            self._send(200, f.read(), ctype)


def main():
    cfg = load_config()
    if cfg is None:
        print("\n  WARNING: config.json not found.")
        print("  Copy config.example.json to config.json and fill it in.\n")
    print(f"  Fantasy dashboard running -> http://localhost:{PORT}")
    print("  Press Ctrl+C to stop.\n")
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
