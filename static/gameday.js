"use strict";
/* =====================================================================
   Game Day: one matchup with a live play-by-play feed for its players,
   the live "This Week" tab on player profiles, and the Vegas lineup
   optimizer. Relies on helpers defined in app.js.
   ===================================================================== */
window.GameDay = (function () {
  const G = { host: null, leagueId: null, idx: 0, filter: "all", bench: store.get("gdBench", false),
    feed: null, seen: new Set(), fresh: new Set(), timer: null, tick: 0, loading: false, err: null };

  const EV_ICON = [["touchdown", "🏈"], ["interception", "🛑"], ["fumble", "💨"], ["sack", "💥"], ["field goal", "🥅"],
    ["extra point", "🥅"], ["incompletion", "✖"], ["reception", "🎯"], ["rush", "🏃"], ["penalty", "🚩"],
    ["punt", "🦶"], ["kickoff", "🦶"], ["timeout", "⏱"], ["end", "⏱"]];
  const evIcon = e => { const t = (e.type || "").toLowerCase(); if (e.scoring) return "🏈"; const h = EV_ICON.find(([k]) => t.includes(k)); return h ? h[1] : "•"; };
  const qLabel = n => n == null ? "" : n <= 4 ? `Q${n}` : "OT";

  function league() { return (lastData && lastData.leagues || []).find(l => l.id === G.leagueId) || null; }
  function matchups() { const lg = league(); return lg ? leagueMatchups(lg) : []; }
  function current() { const ms = matchups(); return ms[Math.max(0, Math.min(G.idx, ms.length - 1))] || null; }
  function feedPlayers(mu) {
    const side = (t, s) => [...(t.players || []), ...(G.bench ? (t.bench || []) : [])]
      .filter(p => p.name && p.name !== "(empty)").map(p => ({ name: p.name, team: p.team, pos: p.pos, side: s }));
    const mine = mu.a_is_me ? "a" : mu.b_is_me ? "b" : null;
    return [...side(mu.a, mine === "a" || mine === null ? "me" : "opp"), ...side(mu.b, mine === "b" ? "me" : "opp")];
  }

  /* ---------- open / lifecycle ---------- */
  function open(host, leagueId, opts) {
    G.host = host; opts = opts || {};
    if (leagueId !== G.leagueId) { G.leagueId = leagueId; G.feed = null; G.seen = new Set(); G.fresh = new Set(); G.err = null; G.idx = 0; }
    if (opts.matchup != null) G.idx = opts.matchup;
    if (!leagueId) { host.innerHTML = `<div class="vempty">Pick a league above.</div>`; return; }
    if (!lastData) { host.innerHTML = `<div class="vhead"><div class="vtitle">📺 Game Day</div></div><div class="panel"><div class="loading"><span class="spin"></span>Loading matchups…</div></div>`; return; }
    if (opts.matchup == null && !opts.keep) { const mi = matchups().findIndex(m => m.a_is_me || m.b_is_me); if (mi >= 0 && G.feed === null) G.idx = mi; }
    renderAll();
    start();
  }
  function refresh() { if (curView === "gameday" && G.host && lastData) { renderMatch(); renderGames(); } }
  function start() {
    stop();
    pollFeed();
    G.timer = setInterval(() => { G.tick++; pollFeed(); if (G.tick % 2 === 0) load(); }, 15000);
  }
  function stop() { if (G.timer) { clearInterval(G.timer); G.timer = null; } }

  /* ---------- rendering ---------- */
  function renderAll() {
    const lg = league();
    if (!lg || lg.error) { G.host.innerHTML = `<div class="vhead"><div class="vtitle">📺 Game Day</div></div><div class="err-msg">${esc(lg ? lg.error : "League not loaded yet.")}</div>`; return; }
    G.host.innerHTML = `<div class="gd">
      <div class="vhead">
        <div class="vtitle">📺 Game Day <small>${esc(lg.league_name)} · Wk ${lastData.week}</small></div>
        <div class="vactions">
          <span id="gdPager"></span>
          <div class="seg" id="gdFilter">
            <button data-f="all" class="${G.filter === "all" ? "active" : ""}">All</button>
            <button data-f="me" class="${G.filter === "me" ? "active" : ""}">My players</button>
            <button data-f="opp" class="${G.filter === "opp" ? "active" : ""}">Opponent</button>
            <button data-f="scoring" class="${G.filter === "scoring" ? "active" : ""}">Scoring</button>
          </div>
          <label class="auto"><input type="checkbox" id="gdBench" ${G.bench ? "checked" : ""}> include benches</label>
          <button class="ghost" id="gdVegas">🎰 Vegas lineup</button>
        </div>
      </div>
      <div class="gd-body">
        <div class="panel gd-match" id="gdMatch"></div>
        <div class="panel gd-feed">
          <div class="panel-h"><span id="gdFeedTitle">Live feed</span><span class="gd-status" id="gdStatus"></span></div>
          <div class="gd-games" id="gdGames"></div>
          <div class="gd-events" id="gdEvents"></div>
        </div>
      </div></div>`;
    G.host.querySelector("#gdFilter").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      G.filter = b.dataset.f; G.host.querySelectorAll("#gdFilter button").forEach(x => x.classList.toggle("active", x === b)); renderEvents();
    });
    G.host.querySelector("#gdBench").addEventListener("change", e => { G.bench = e.target.checked; store.set("gdBench", G.bench); G.feed = null; renderMatch(); pollFeed(); });
    G.host.querySelector("#gdVegas").addEventListener("click", () => openVegasLineup(G.leagueId));
    renderMatch(); renderGames(); renderEvents();
  }
  function renderMatch() {
    const host = G.host && G.host.querySelector("#gdMatch"); if (!host) return;
    const ms = matchups(), mu = current();
    const mineIdx = ms.findIndex(m => m.a_is_me || m.b_is_me);
    const cur = Math.max(0, Math.min(G.idx, ms.length - 1));
    const pg = G.host.querySelector("#gdPager");
    if (pg) pg.innerHTML = matchupPager("gd", ms.length, cur, mineIdx, "big");
    if (!mu) { host.innerHTML = `<div class="empty">No matchups this week.</div>`; return; }
    host.innerHTML = `<div class="focus">${scoreBlock(mu)}<div class="rosters focus-rosters ${G.bench ? "" : "no-bench"}">${col(mu.a)}${col(mu.b)}</div></div>`;
    G.host.querySelectorAll("#gdPager .pgbtn").forEach(b => b.addEventListener("click", () => {
      G.idx = (cur + parseInt(b.dataset.dir, 10) + ms.length) % ms.length;
      G.feed = null; G.seen = new Set(); G.fresh = new Set();
      renderMatch(); renderGames(); renderEvents(); pollFeed();
    }));
  }
  function renderGames() {
    const host = G.host && G.host.querySelector("#gdGames"); if (!host) return;
    const mu = current();
    if (!mu) { host.innerHTML = ""; return; }
    const games = (G.feed && G.feed.games) || [];
    const all = [...(mu.a.players || []), ...(mu.b.players || []), ...(G.bench ? [...(mu.a.bench || []), ...(mu.b.bench || [])] : [])].filter(p => p.name && p.name !== "(empty)");
    const live = all.filter(p => p.game_status === "in").length, pre = all.filter(p => p.game_status === "pre").length;
    const st = G.host.querySelector("#gdStatus");
    if (st) st.innerHTML = `${live ? `<span class="livedot"></span>${live} live` : pre ? `${pre} yet to play` : "all games final"}${G.feed ? ` · updated ${new Date(G.feed.ts * 1000).toLocaleTimeString()}` : ""}`;
    if (!games.length) {
      const upcoming = {};
      all.filter(p => p.game_status === "pre").forEach(p => { const k = p.game_detail || "TBD"; (upcoming[k] = upcoming[k] || []).push(p); });
      const keys = Object.keys(upcoming);
      host.innerHTML = keys.length ? `<div class="gd-upcoming"><div class="ai-sec-h">Kickoffs</div>${keys.map(k => `<div class="gd-up-row"><b>${esc(k)}</b> ${upcoming[k].map(p => `<span>${posBadge(p.pos)} ${esc(abbrevName(p.name))}</span>`).join(" ")}</div>`).join("")}</div>` : "";
      return;
    }
    host.innerHTML = games.map(g => {
      const rzTeams = all.filter(p => p.redzone).map(p => p.team);
      const rz = rzTeams.includes(g.home) || rzTeams.includes(g.away);
      return `<div class="gd-game ${g.status}">${g.status === "in" ? `<span class="livedot"></span>` : ""}${teamLogo(g.away)}<b>${esc(g.away)} ${g.away_pts ?? ""}</b> @ ${teamLogo(g.home)}<b>${esc(g.home)} ${g.home_pts ?? ""}</b>
          <small>${esc(g.detail || "")}${rz ? ` · <span class="rztag">RED ZONE</span>` : ""}</small>
          <span class="gd-game-ps">${g.players.map(p => `<span class="gd-ps ${p.side}">${esc(abbrevName(p.name))}</span>`).join("")}</span></div>`;
    }).join("");
  }
  function highlight(text, players) {
    let out = esc(text);
    players.forEach(p => {
      const parts = p.name.replace(/\b(Jr|Sr|II|III|IV)\.?$/i, "").trim().split(/\s+/);
      if (parts.length < 2) return;
      const last = parts.slice(1).join(" ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\./g, "\\.?").replace(/\s/g, "\\s?");
      const rx = new RegExp("\\b" + parts[0][0] + "[a-z]{0,2}\\.\\s?" + last + "\\b", "g");
      out = out.replace(rx, m => `<b class="ev-name ${p.side}">${m}</b>`);
    });
    return out;
  }
  function renderEvents() {
    const host = G.host && G.host.querySelector("#gdEvents"); if (!host) return;
    if (G.err) { host.innerHTML = `<div class="err-msg">${esc(G.err)}</div>`; return; }
    if (!G.feed) { host.innerHTML = `<div class="loading"><span class="spin"></span>Loading plays…</div>`; return; }
    let evs = G.feed.events || [];
    if (G.filter === "me") evs = evs.filter(e => e.players.some(p => p.side === "me"));
    else if (G.filter === "opp") evs = evs.filter(e => e.players.some(p => p.side === "opp"));
    else if (G.filter === "scoring") evs = evs.filter(e => e.scoring);
    const t = G.host.querySelector("#gdFeedTitle"); if (t) t.textContent = `Live feed · ${evs.length} plays`;
    if (!evs.length) {
      const games = (G.feed.games || []);
      host.innerHTML = `<div class="empty">${games.length ? "No plays for these players yet." : "No games have started for the players in this matchup. The feed starts at kickoff and updates every 15 seconds."}</div>`;
      return;
    }
    host.innerHTML = evs.map(e => {
      const sides = new Set(e.players.map(p => p.side));
      const cls = sides.size > 1 ? "both" : [...sides][0];
      const score = e.home_score != null ? `${esc(e.away)} ${e.away_score}–${e.home_score} ${esc(e.home)}` : esc(e.game);
      const tags = e.players.map(p => `<span class="ev-p ${p.side}">${posBadge(p.pos)}<span class="pm-open" ${pdata({ name: p.name, team: p.team, pos: p.pos, game_status: "in" })}>${esc(abbrevName(p.name))}</span></span>`).join("");
      const meta = [e.type, e.yards != null && e.yards !== 0 ? `${e.yards > 0 ? "+" : ""}${e.yards} yds` : ""].filter(Boolean).join(" · ");
      return `<div class="ev ${cls} ${e.scoring ? "scoring" : ""} ${e.turnover ? "turnover" : ""} ${G.fresh.has(e.id) ? "fresh" : ""}">
          <div class="ev-when"><b>${qLabel(e.period)} ${esc(e.clock || "")}</b><small>${score}</small></div>
          <div class="ev-body"><div class="ev-tags">${evIcon(e)} ${tags}</div>
            <div class="ev-text">${highlight(e.text, e.players)}</div>
            <div class="ev-meta">${esc(meta)}${e.scoring ? ` · <span class="rztag">SCORING PLAY</span>` : ""}${e.turnover ? ` · <span class="turn">TURNOVER</span>` : ""}</div></div>
        </div>`;
    }).join("");
  }

  /* ---------- polling ---------- */
  async function pollFeed() {
    const mu = current(); if (!mu || G.loading) return;
    G.loading = true;
    const lid = G.leagueId, idx = G.idx;
    try {
      const r = await fetch("/api/feed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ players: feedPlayers(mu) }) });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      if (G.leagueId !== lid || G.idx !== idx) return;
      const ids = new Set((d.events || []).map(e => e.id));
      G.fresh = G.seen.size ? new Set([...ids].filter(i => !G.seen.has(i))) : new Set();
      G.seen = ids; G.feed = d; G.err = null;
    } catch (e) { G.err = "Feed unavailable: " + (e.message || e); }
    G.loading = false;
    if (curView === "gameday") { renderGames(); renderEvents(); }
  }

  /* ---------- profile "This Week" live tab ---------- */
  async function loadLive(tab, host) {
    if (!host) return;
    const d = tab.d || {};
    try {
      const qs = new URLSearchParams({ espn_id: d.espn || "", sleeper_id: d.sleeper || "", name: d.name || "", team: d.team || "", pos: d.pos || "" });
      const r = await fetch("/api/player/live?" + qs, { cache: "no-store" });
      const L = await r.json();
      if (L.error) throw new Error(L.error);
      tab.live = L;
      if (pmActiveKey !== tab.key) return;
      const h = pmBody.querySelector("#liveHost"); if (!h) return;
      const g = L.game || {};
      const status = g.status === "in" ? `<span class="livedot"></span>LIVE · ${esc(g.detail || "")}` : g.status === "post" ? `Final` : `Kickoff ${esc(g.detail || "TBD")}`;
      const scoreLine = g.opp ? `${teamLogo(L.team)}<b>${esc(L.team)} ${g.pts ?? ""}</b> ${esc(g.ha || "vs")} ${teamLogo(g.opp)}<b>${esc(g.opp)} ${g.opp_pts ?? ""}</b>` : `<b>${esc(L.team || "")}</b> — no game this week`;
      h.innerHTML = `<div class="lv-game ${g.status}"><div class="lv-score">${scoreLine}</div><div class="lv-status">${status}${g.redzone ? ` · <span class="rztag">RED ZONE</span>` : ""}${g.possession && g.status === "in" ? " · has ball" : ""}</div></div>
        <div class="lv-pts"><div><div class="opt-k">PPR</div><div class="opt-v">${L.pts.pts_ppr.toFixed(1)}</div></div>
          <div><div class="opt-k">Half PPR</div><div class="opt-v">${L.pts.pts_half_ppr.toFixed(1)}</div></div>
          <div><div class="opt-k">Standard</div><div class="opt-v">${L.pts.pts_std.toFixed(1)}</div></div></div>
        ${L.found ? `<div class="lv-grid">${L.rows.map(r => `<div class="lv-cell"><small>${esc(r.label)}</small><b>${esc(r.value)}</b></div>`).join("")}</div>` : `<div class="empty">${g.status === "pre" ? "No stats yet — this game hasn't kicked off." : "No stats recorded for this week."}</div>`}
        <div class="lab-note">Week ${L.week ?? ""} · stats from Sleeper's live feed, game state from ESPN · refreshes every 20s while the game is live · ${new Date(L.ts * 1000).toLocaleTimeString()}</div>`;
      const tb = pmBody.querySelector('.ptab[data-panel="live"]');
      if (tb) tb.innerHTML = g.status === "in" ? `<span class="livedot"></span>Live` : "This Week";
      stopLive(tab);
      if (g.status === "in") tab.liveTimer = setTimeout(() => { if (pmActiveKey === tab.key && tab.panel === "live") loadLive(tab, pmBody.querySelector("#liveHost")); }, 20000);
    } catch (e) {
      const h = pmBody.querySelector("#liveHost"); if (h) h.innerHTML = `<div class="err-msg">Could not load live stats (${esc(e.message || e)})</div>`;
    }
  }
  function stopLive(tab) { if (tab && tab.liveTimer) { clearTimeout(tab.liveTimer); tab.liveTimer = null; } }

  return { open, stop, refresh, loadLive, stopLive };
})();

/* ---------- Vegas lineup optimizer (modal) ---------- */
const SRC_BADGE = { vegas: ["🎰", "Vegas-implied"], proj: ["📈", "projection"], live: ["●", "live projection"], final: ["✓", "final"], out: ["✕", "out"] };
async function openVegasLineup(id) {
  if (!id) return;
  const lg = leagueOf(id);
  openModal(`${lg ? lg.name : "League"} · lineup by Vegas odds`, `<div class="loading"><span class="spin"></span>Pulling DraftKings props and your roster…</div>`, "wide");
  try {
    const r = await fetch("/api/lineup/vegas?id=" + encodeURIComponent(id), { cache: "no-store" });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const delta = Math.round((d.optimal_total - d.current_total) * 10) / 10;
    const cell = (p, other) => {
      if (!p) return `<td class="vl-empty">—</td>`;
      const [ic, lbl] = SRC_BADGE[p.exp_src] || ["", ""];
      const diff = other && pkey(other) !== pkey(p);
      const lines = (p.vegas_lines && p.exp_src === "vegas") ? Object.entries(p.vegas_lines).filter(([k, v]) => v).map(([k, v]) => k === "td" ? `TD ${v}` : `${k} ${v}`).join(" · ") : "";
      return `<td class="${diff ? "vl-diff" : ""}"><div class="vl-p pm-open" ${pdata(p)}>${posBadge(p.pos)} ${teamLogo(p.team)}<span>${esc(p.name)}</span>${injBadge(p)}</div>
        <div class="vl-sub">${p.opp ? `${esc(p.opp_ha || "vs")} ${esc(p.opp)} · ` : ""}<span class="src src-${p.exp_src}" title="${lbl}">${ic} ${lbl}</span>${lines ? ` · ${esc(lines)}` : ""}</div></td>
        <td class="vl-exp ${diff ? "vl-diff" : ""}">${(p.exp || 0).toFixed(1)}</td>`;
    };
    const rows = d.slots.map((s, i) => {
      const c = (d.current[i] || {}).player, o = (d.optimal[i] || {}).player;
      return `<tr><td class="vl-slot">${posBadge(s)}</td>${cell(c, o)}${cell(o, c)}</tr>`;
    }).join("");
    modalBody.innerHTML = `<div class="vl">
      <div class="opt-summary">
        <div><div class="opt-k">Your lineup</div><div class="opt-v">${d.current_total.toFixed(1)}</div></div>
        <div><div class="opt-k">Vegas-optimal</div><div class="opt-v">${d.optimal_total.toFixed(1)}</div></div>
        <div><div class="opt-k">Upside</div><div class="opt-v ${delta > 0.5 ? "bad" : "good"}">${delta > 0 ? "+" + delta : delta}</div></div>
      </div>
      ${d.vegas_count ? "" : `<div class="lab-note" style="padding:0 16px">DraftKings hasn't posted player props for the games still to be played, so projections are used for those — check back closer to kickoff.</div>`}
      <div class="tablewrap" style="margin:0 16px"><table class="glog vl-table"><thead><tr><th>Slot</th><th class="lft">Your starter</th><th>Exp</th><th class="lft">Vegas says</th><th>Exp</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${d.start.length ? `<div class="avg-title" style="padding:0 16px">Swaps</div>${d.start.map((inP, i) => { const outP = d.sit[i]; return `<div class="swap"><span class="swap-side">Sit ▸ ${esc(outP ? outP.name : "—")} <small>${outP ? outP.exp.toFixed(1) : ""}</small></span><span class="swap-arrow">→</span><span class="swap-side">Start ▸ ${esc(inP.name)} <small>${inP.exp.toFixed(1)}</small></span></div>`; }).join("")}` : `<div class="empty">Your lineup already matches what the betting lines imply. 🎯</div>`}
      <div class="lab-note" style="padding:8px 16px 0">🎰 Vegas-implied points = DraftKings yardage/TD/reception lines converted to PPR points · 📈 site projection where no props are posted (K, D/ST, most lines early in the week) · ● live projection for games in progress · ✓ actual points for finished games. Not betting advice.</div>
    </div>`;
  } catch (e) { modalBody.innerHTML = `<div class="err-msg">Could not build the Vegas lineup (${esc(e.message || e)})</div>`; }
}
