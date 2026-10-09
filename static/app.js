"use strict";

/* =====================================================================
   shared helpers (also used by trade.js)
   ===================================================================== */
const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function round1(x) { return Math.round(x * 10) / 10; }
function statusWord(s) { return s === "in" ? "LIVE" : s === "post" ? "Final" : "—"; }
function posLabel(p) { p = (p || "").toUpperCase(); return p === "D/ST" ? "DEF" : p; }
function posClass(pos) {
  const p = posLabel(pos).replace("/", "");
  return ["QB", "RB", "WR", "TE", "K", "DEF", "DST", "FLEX", "SFLEX", "WRT", "WRRB",
          "IDP", "DL", "LB", "DB"].includes(p) ? "pos-" + p : "pos-x";
}
function posBadge(pos) { return `<span class="pos ${posClass(pos)}">${esc(posLabel(pos) || "?")}</span>`; }
function abbrevName(n) {
  if (!n || /D\/ST/i.test(n)) return n || "—";
  const p = n.trim().split(/\s+/);
  return p.length < 2 ? n : `${p[0][0]}. ${p.slice(1).join(" ")}`;
}
function fmtVal(v) { if (v == null) return ""; return v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v); }
function trendArrow(t) {
  if (t == null || t === 0) return "";
  const up = t > 0;
  return `<span class="trend ${up ? "up" : "down"}">${up ? "▲" : "▼"}${Math.abs(t)}</span>`;
}
function posRankStr(p) { return p.pos_rank != null ? `${posLabel(p.pos)}${p.pos_rank}` : ""; }
function injBadge(p) {
  if (!p.injury) return "";
  const out = ["O", "IR", "SUS", "PUP", "COV", "NA", "DNR"].includes(p.injury);
  const sev = out ? "out" : (p.injury === "D" ? "doubt" : "q");
  return `<span class="inj inj-${sev}" title="${esc(p.injury)}">${esc(p.injury)}</span>`;
}
const TEAM_LOGO_FIX = { WAS: "wsh" };
function teamLogo(team) {
  if (!team) return "";
  const code = (TEAM_LOGO_FIX[team] || team).toLowerCase();
  return `<img class="tlogo" src="https://a.espncdn.com/i/teamlogos/nfl/500/${code}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
}
function pdata(p) {
  return `data-espn="${esc(p.espn_id || "")}" data-sleeper="${esc(p.sleeper_id || "")}" `
    + `data-team="${esc(p.team || "")}" data-pos="${esc(p.pos || "")}" data-name="${esc(p.name || "")}"`;
}
function pkey(p) { return String(p.sleeper_id || p.espn_id || p.name); }
function allOf(t) { return [...(t.players || []), ...(t.bench || [])].filter(p => p.name && p.name !== "(empty)"); }
function sumVal(list) { return list.reduce((a, p) => a + (p.value || 0), 0); }

const SLOT_ELIG = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF", "D/ST"], "D/ST": ["DEF", "D/ST"],
  FLEX: ["RB", "WR", "TE"], SFLEX: ["QB", "RB", "WR", "TE"],
  WRT: ["WR", "TE"], WRRB: ["WR", "RB"], IDP: ["DL", "LB", "DB"],
};

let toastTimer = null;
function toast(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); }
  catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied to clipboard"); } catch { toast("Copy failed"); } ta.remove(); }
}

/* =====================================================================
   app state + router
   ===================================================================== */
let lastData = null;
let leagues = store.get("leagues", []);          // [{id, name, provider}]
let curLeagueId = store.get("league", null);
let curView = "live";
let viewOpts = {};
const VIEWS = ["live", "rosters", "trade", "lab"];

const rosterCache = {};   // id -> {ts, promise}
function getRosters(id, force = false) {
  const c = rosterCache[id];
  if (!force && c && Date.now() - c.ts < 60_000) return c.promise;
  const promise = fetch("/api/rosters?id=" + encodeURIComponent(id), { cache: "no-store" })
    .then(r => r.json())
    .then(d => { if (d.error) { delete rosterCache[id]; throw new Error(d.error); } return d; })
    .catch(e => { delete rosterCache[id]; throw e; });
  rosterCache[id] = { ts: Date.now(), promise };
  return promise;
}

function navigate(view, leagueId, opts) {
  viewOpts = opts || {};
  const id = leagueId || curLeagueId || (leagues[0] && leagues[0].id) || "";
  const h = view === "live" ? "#live" : `#${view}/${id}`;
  if (location.hash === h) setView(view, id, viewOpts);
  else location.hash = h;
}
function routeFromHash() {
  const h = location.hash.replace(/^#/, "");
  const [view, ...rest] = h.split("/");
  const id = rest.join("/");
  setView(VIEWS.includes(view) ? view : "live", id || null, viewOpts);
  viewOpts = {};
}
function setView(view, leagueId, opts) {
  curView = view;
  if (leagueId) { curLeagueId = leagueId; store.set("league", leagueId); }
  if (!curLeagueId && leagues.length) curLeagueId = leagues[0].id;
  document.querySelectorAll(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  VIEWS.forEach(v => { $("#view-" + v).hidden = v !== view; });
  $("#leaguebar").hidden = view === "live";
  renderLeagueBar();
  renderCurrentView(opts || {});
}
function leagueOf(id) { return leagues.find(l => l.id === id); }
function renderLeagueBar() {
  const bar = $("#leaguebar");
  if (!leagues.length) { bar.innerHTML = `<span class="lb-lbl">Loading your leagues…</span>`; return; }
  bar.innerHTML = `<span class="lb-lbl">League</span>` + leagues.map(l =>
    `<button class="lpill ${l.id === curLeagueId ? "active" : ""}" data-id="${esc(l.id)}">
       <span class="pdot ${esc(l.provider)}"></span>${esc(l.name)}</button>`).join("");
}
$("#leaguebar").addEventListener("click", e => {
  const p = e.target.closest(".lpill");
  if (p) navigate(curView, p.dataset.id);
});
$("#nav").addEventListener("click", e => {
  const b = e.target.closest(".navbtn");
  if (b) navigate(b.dataset.view);
});
window.addEventListener("hashchange", routeFromHash);

function renderCurrentView(opts) {
  if (curView === "rosters") renderRostersView();
  else if (curView === "lab") renderLabView();
  else if (curView === "trade") {
    if (window.TradeView) TradeView.open($("#view-trade"), curLeagueId, opts);
  }
}
function setLeaguesFromDashboard(data) {
  const ls = (data.leagues || []).filter(l => l.id).map(l => ({ id: l.id, name: l.league_name || "League", provider: l.provider }));
  if (ls.length) {
    const changed = JSON.stringify(ls) !== JSON.stringify(leagues);
    leagues = ls; store.set("leagues", ls);
    if (!curLeagueId || !leagueOf(curLeagueId)) curLeagueId = ls[0].id;
    if (changed && curView !== "live") { renderLeagueBar(); renderCurrentView({}); }
    else renderLeagueBar();
  }
}

/* =====================================================================
   LIVE view (dashboard cards)
   ===================================================================== */
const grid = $("#grid");
const banner = $("#banner");
let timer = null;
let prevScores = {};
const cardIdx = {};

function playHint(t) {
  if (!t || !t.players) return "";
  let pre = 0, live = 0;
  for (const p of t.players) { if (p.game_status === "pre") pre++; else if (p.game_status === "in") live++; }
  const bits = [];
  if (live) bits.push(`${live} live`);
  if (pre) bits.push(`${pre} to play`);
  return bits.join(" · ");
}
function teamSide(t, cls) {
  if (!t) return `<div class="side ${cls}"><div class="team-name">—</div><div class="score">–</div></div>`;
  const rec = t.record ? `<span class="rec">${esc(t.record)}</span>` : "";
  const proj = t.projected != null ? `proj ${t.projected.toFixed(1)}` : "";
  const sub = [proj, playHint(t)].filter(Boolean).join(" · ");
  return `<div class="side ${cls}">
      <div class="team-name">${esc(t.name)} ${rec}</div>
      <div class="score" data-score>${t.score.toFixed(1)}</div>
      <div class="proj">${sub}</div>
    </div>`;
}
function oppStr(p) {
  if (!p.opp) return "";
  return ` <span class="opp-vs">${esc(p.opp_ha || "vs")} ${teamLogo(p.opp)}${esc(p.opp)}</span>`;
}
function playerRow(p) {
  const projVal = p.proj_live != null ? p.proj_live : p.projected;
  const proj = (projVal != null && p.game_status !== "post") ? `<small>${projVal.toFixed(1)} proj</small>` : "";
  const rz = p.redzone ? ` · <span class="rztag">RED ZONE</span>` : "";
  const detail = p.game_detail ? ` · ${esc(p.game_detail)}` : "";
  const clickable = p.espn_id || p.sleeper_id;
  return `<div class="prow ${p.redzone ? "rz" : ""} ${p.starter === false ? "bench-row" : ""} ${clickable ? "clickable" : ""}" ${clickable ? pdata(p) : ""}>
      <span class="gdot ${p.game_status}" title="${statusWord(p.game_status)}"></span>
      ${posBadge(p.slot || p.pos)}
      <span class="pmeta">
        <div class="pname">${esc(p.name)}${injBadge(p)}</div>
        <div class="psub">${teamLogo(p.team)}${esc(p.team || "FA")}${oppStr(p)}${rz}${detail}${p.value != null ? ` · <span class="vtag">${posRankStr(p)} ${fmtVal(p.value)}</span>` : ""}</div>
        ${p.statline ? `<div class="pstat">${esc(p.statline)}</div>` : ""}
      </span>
      <span class="ppts">${(p.points || 0).toFixed(1)}${proj}</span>
    </div>`;
}
function benchBlock(bench) {
  if (!bench || !bench.length) return "";
  const total = bench.reduce((a, p) => a + (p.points || 0), 0);
  return `<div class="bench"><div class="bench-head">BENCH <span>${total.toFixed(1)}</span></div>${bench.map(playerRow).join("")}</div>`;
}
function col(t) {
  if (!t) return `<div class="col"></div>`;
  return `<div class="col">${(t.players || []).map(playerRow).join("")}${benchBlock(t.bench)}</div>`;
}
function leagueMatchups(lg) {
  if (lg.matchups && lg.matchups.length) return lg.matchups;
  if (lg.my_team && lg.opp_team) return [{ a: lg.my_team, b: lg.opp_team, a_is_me: true, b_is_me: false, win_prob: lg.win_prob }];
  return [];
}
function matchupPager(key, total, cur, mineIdx, cls) {
  if (total <= 1) return "";
  const tag = cur === mineIdx ? `<span class="mine-tag">your matchup</span>` : "";
  return `<div class="pager ${cls || ""}">
      <button class="pgbtn ${cls ? "f" : ""}" data-key="${key}" data-dir="-1">‹</button>
      <span class="pg-lbl">Matchup ${cur + 1} / ${total} ${tag}</span>
      <button class="pgbtn ${cls ? "f" : ""}" data-key="${key}" data-dir="1">›</button>
    </div>`;
}
function scoreBlock(mu) {
  const wp = mu.win_prob;
  const aCls = mu.a_is_me ? "me" : "left";
  const bCls = (mu.b_is_me ? "me " : "") + "right";
  const winbar = wp != null ? `<div class="winbar-wrap"><div class="winbar"><i style="width:${wp}%"></i></div>
      <div class="winbar-label"><span>${wp}%</span><span>${100 - wp}%</span></div></div>` : "";
  return `<div class="scoreline">${teamSide(mu.a, aCls)}<div class="vs">vs</div>${teamSide(mu.b, bCls)}</div>${winbar}`;
}
function cardTools(lg, idx) {
  const id = esc(lg.id || "");
  return `<span class="head-right">
      <button class="iconbtn expand-btn" data-idx="${idx}" title="Expand this league">⤢</button>
      <button class="iconbtn go-btn" data-view="rosters" data-id="${id}" title="All rosters">👥</button>
      <button class="iconbtn go-btn" data-view="trade" data-id="${id}" title="Trade center">⇄</button>
      <button class="iconbtn go-btn" data-view="lab" data-id="${id}" title="League lab">📊</button>
    </span>`;
}
function cardHTML(lg, key) {
  const idx = key.replace("lg", "");
  if (lg.error) {
    return `<section class="card err">
        <div class="card-head"><span class="league-name">${esc(lg.league_name || "League")} <span class="prov ${lg.provider || ""}">${esc(lg.provider || "")}</span></span>
        ${lg.id ? cardTools(lg, idx) : ""}</div>
        <div class="err-msg">${esc(lg.error)}</div></section>`;
  }
  const ms = leagueMatchups(lg);
  const mineIdx = ms.findIndex(m => m.a_is_me || m.b_is_me);
  if (!(key in cardIdx)) cardIdx[key] = mineIdx >= 0 ? mineIdx : 0;
  const cur = Math.max(0, Math.min(cardIdx[key], ms.length - 1));
  const mu = ms[cur] || { a: {}, b: {} };
  const isMine = !!(mu.a_is_me || mu.b_is_me);
  const winning = (mu.a.score || 0) >= (mu.b.score || 0);
  const opt = optimalForTeam(lg.my_team);
  const optChip = (isMine && opt && opt.left > 0.5)
    ? `<div class="opt-row"><button class="ghost opt-chip" data-idx="${idx}">Bench left +${opt.left} pts</button></div>` : "";
  return `<section class="card ${winning ? "winning" : "losing"} ${isMine ? "" : "other"}" data-key="${key}">
      <div class="card-head">
        <span class="league-name">${esc(lg.league_name)} <span class="prov ${lg.provider}">${lg.provider}</span></span>
        ${cardTools(lg, idx)}
      </div>
      ${matchupPager(key, ms.length, cur, mineIdx)}
      ${scoreBlock(mu)}
      ${optChip}
      <div class="rosters">${col(mu.a)}${col(mu.b)}</div>
    </section>`;
}
function renderSummary(ls) {
  const real = ls.filter(l => !l.error && l.my_team && l.opp_team);
  const el = $("#summary");
  if (!real.length) { el.textContent = ""; return; }
  const winning = real.filter(l => l.my_team.score >= l.opp_team.score).length;
  const myTotal = real.reduce((a, l) => a + (l.my_team.score || 0), 0);
  el.innerHTML = `<b>Winning ${winning}/${real.length}</b> · ${myTotal.toFixed(1)} pts total`;
}
function renderWatch(ls) {
  const el = $("#watch");
  const rows = [];
  (ls || []).forEach(lg => {
    if (lg.error || !lg.my_team || !lg.opp_team) return;
    const live = [...(lg.my_team.players || []), ...(lg.opp_team.players || [])].some(p => p.game_status === "in");
    if (!live) return;
    const diff = Math.abs((lg.my_team.score || 0) - (lg.opp_team.score || 0));
    const wp = lg.win_prob;
    if (diff <= 15 || (wp != null && wp >= 30 && wp <= 70)) rows.push({ lg, diff });
  });
  if (!rows.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="watch-lbl">👀 Games to watch</span>` + rows.map(({ lg, diff }) => `
      <span class="watch-chip ${lg.my_team.score >= lg.opp_team.score ? "up" : "down"}">
        ${esc(lg.league_name)}: <b>${lg.my_team.score.toFixed(1)}</b>–${lg.opp_team.score.toFixed(1)}
        <small>Δ${diff.toFixed(1)}${lg.win_prob != null ? " · " + lg.win_prob + "%" : ""}</small></span>`).join("");
}
function renderCards() {
  const ls = (lastData && lastData.leagues) || [];
  grid.innerHTML = ls.map((lg, i) => cardHTML(lg, "lg" + i)).join("") || `<div class="card err">No leagues configured.</div>`;
  renderSummary(ls);
  renderWatch(ls);
}
async function load() {
  try {
    const r = await fetch("/api/dashboard", { cache: "no-store" });
    const data = await r.json();
    if (data.error) { showBanner(data.error); return; }
    banner.hidden = true;
    lastData = data;
    $("#weeklabel").textContent = `${data.season} · Wk ${data.week}`;
    const anyLive = (data.leagues || []).some(l => [...(l.my_team?.players || []), ...(l.opp_team?.players || [])].some(p => p.game_status === "in"));
    $("#pulse").style.visibility = anyLive ? "visible" : "hidden";
    renderCards();
    (data.leagues || []).forEach((lg, i) => {
      const key = "lg" + i;
      const card = grid.querySelector(`[data-key="${key}"]`);
      if (!card || lg.error) return;
      const ms = leagueMatchups(lg);
      const mineIdx = ms.findIndex(m => m.a_is_me || m.b_is_me);
      const scores = card.querySelectorAll("[data-score]");
      const prev = prevScores[key];
      if (prev && cardIdx[key] === mineIdx) {
        if (lg.my_team && lg.my_team.score > prev.me) scores[0]?.classList.add("bump");
        if (lg.opp_team && lg.opp_team.score > prev.opp) scores[1]?.classList.add("bump");
      }
      prevScores[key] = { me: lg.my_team?.score ?? 0, opp: lg.opp_team?.score ?? 0 };
    });
    $("#updated").textContent = "updated " + new Date().toLocaleTimeString();
    setLeaguesFromDashboard(data);
  } catch (e) {
    showBanner("Could not reach the local server. Is it still running? (" + e + ")");
  }
}
function showBanner(msg) { banner.textContent = msg; banner.hidden = false; }

grid.addEventListener("click", e => {
  const pg = e.target.closest(".pgbtn");
  if (pg) {
    const key = pg.dataset.key, ms = leagueMatchups(lastData.leagues[parseInt(key.replace("lg", ""), 10)]);
    cardIdx[key] = (((cardIdx[key] || 0) + parseInt(pg.dataset.dir, 10)) % ms.length + ms.length) % ms.length;
    renderCards(); return;
  }
  const ex = e.target.closest(".expand-btn");
  if (ex) { openFocus(parseInt(ex.dataset.idx, 10)); return; }
  const go = e.target.closest(".go-btn");
  if (go) { navigate(go.dataset.view, go.dataset.id); return; }
  const oc = e.target.closest(".opt-chip");
  if (oc) { openOptimal(parseInt(oc.dataset.idx, 10)); return; }
});

/* ---------- analytics: optimal lineup, rooting ---------- */
function optimalForTeam(t) {
  if (!t || !t.players) return null;
  const slots = (t.players || []).map(p => (p.slot || p.pos || "").toUpperCase());
  const pool = allOf(t);
  const order = slots.map((s, i) => ({ s, i })).sort((a, b) => (SLOT_ELIG[a.s] || [a.s]).length - (SLOT_ELIG[b.s] || [b.s]).length);
  const used = new Set(), assign = {};
  for (const { s, i } of order) {
    const elig = SLOT_ELIG[s] || [s];
    let best = -1;
    pool.forEach((p, pi) => {
      if (used.has(pi) || !elig.includes((p.pos || "").toUpperCase())) return;
      if (best < 0 || (p.points || 0) > (pool[best].points || 0)) best = pi;
    });
    if (best >= 0) { used.add(best); assign[i] = pool[best]; }
  }
  const optimalPts = Object.values(assign).reduce((a, p) => a + (p.points || 0), 0);
  const actualPts = (t.players || []).reduce((a, p) => a + (p.points || 0), 0);
  const optNames = new Set(Object.values(assign).map(p => p.name));
  const startNames = new Set((t.players || []).map(p => p.name));
  return { optimalPts: round1(optimalPts), actualPts: round1(actualPts), left: round1(optimalPts - actualPts),
    shouldStart: Object.values(assign).filter(p => !startNames.has(p.name)),
    shouldSit: (t.players || []).filter(p => !optNames.has(p.name) && p.name !== "(empty)") };
}
function computeRooting(ls) {
  const map = new Map();
  (ls || []).forEach(lg => {
    if (lg.error || !lg.my_team || !lg.opp_team) return;
    const add = (p, dir) => {
      if (!p.name || p.name === "(empty)") return;
      const e = map.get(p.name) || { name: p.name, pos: p.pos, team: p.team, for: 0, against: 0, live: false, status: p.game_status, forL: [], againstL: [] };
      if (dir > 0) { e.for++; e.forL.push(lg.league_name); } else { e.against++; e.againstL.push(lg.league_name); }
      if (p.game_status === "in") e.live = true;
      if (p.game_status && p.game_status !== "pre") e.status = p.game_status;
      map.set(p.name, e);
    };
    (lg.my_team.players || []).forEach(p => add(p, 1));
    (lg.opp_team.players || []).forEach(p => add(p, -1));
  });
  const arr = [...map.values()].map(e => ({ ...e, net: e.for - e.against }));
  return { rootFor: arr.filter(e => e.net > 0).sort((a, b) => b.net - a.net || b.live - a.live),
    rootAgainst: arr.filter(e => e.net < 0).sort((a, b) => a.net - b.net || b.live - a.live),
    conflicted: arr.filter(e => e.for > 0 && e.against > 0) };
}
function rootRow(e) {
  const dot = e.status === "in" ? "in" : e.status === "post" ? "post" : "pre";
  const ctx = e.net > 0 ? e.forL.join(", ") : e.againstL.join(", ");
  return `<div class="root-row"><span class="gdot ${dot}"></span>${posBadge(e.pos)}
      <span class="root-name">${esc(e.name)} <small>${esc(e.team || "")}</small></span>
      <span class="root-ctx">${esc(ctx)}</span>
      <span class="root-net ${e.net > 0 ? "pos" : "neg"}">${e.net > 0 ? "+" : ""}${e.net}</span></div>`;
}
function openRooting() {
  const r = computeRooting((lastData || {}).leagues);
  const confNote = r.conflicted.length
    ? `<div class="root-conflict">⚔️ Conflicted (own in one, against in another): ${r.conflicted.map(e => esc(e.name)).join(", ")}</div>` : "";
  openModal("Rooting guide · across all your leagues", `
    <div class="root-wrap">
      <div class="root-col"><div class="sec-label" style="background:#16a34a">ROOT FOR</div>
        ${r.rootFor.length ? r.rootFor.map(rootRow).join("") : `<div class="empty">Nothing yet.</div>`}</div>
      <div class="root-col"><div class="sec-label" style="background:#dc2626">ROOT AGAINST</div>
        ${r.rootAgainst.length ? r.rootAgainst.map(rootRow).join("") : `<div class="empty">Nothing yet.</div>`}</div>
    </div>${confNote}`, "wide");
}
function openOptimal(idx) {
  const lg = (lastData.leagues || [])[idx];
  if (!lg || !lg.my_team) return;
  const o = optimalForTeam(lg.my_team);
  const swap = o.shouldStart.map((inP, i) => {
    const outP = o.shouldSit[i];
    return `<div class="swap"><span class="swap-side">Bench ▸ ${esc(outP ? outP.name : "—")} <small>${outP ? (outP.points || 0).toFixed(1) : ""}</small></span>
        <span class="swap-arrow">↑</span><span class="swap-side">Start ▸ ${esc(inP.name)} <small>${(inP.points || 0).toFixed(1)}</small></span></div>`;
  }).join("");
  openModal(`${lg.league_name} · optimal lineup`, `
    <div class="opt-summary">
      <div><div class="opt-k">You started</div><div class="opt-v">${o.actualPts}</div></div>
      <div><div class="opt-k">Optimal</div><div class="opt-v">${o.optimalPts}</div></div>
      <div><div class="opt-k">Left on bench</div><div class="opt-v ${o.left > 0 ? "bad" : "good"}">${o.left > 0 ? "+" + o.left : "0"}</div></div>
    </div>
    ${o.left > 0.1 ? `<div class="avg-title" style="padding:0 16px">Should have started</div>${swap}` : `<div class="empty">You played the optimal lineup. 🎯</div>`}`);
}

/* ---------- focus (expand one league) ---------- */
let focusState = null;
function renderFocus() {
  const lg = lastData.leagues[focusState.leagueIdx];
  const ms = leagueMatchups(lg);
  const mineIdx = ms.findIndex(m => m.a_is_me || m.b_is_me);
  const cur = Math.max(0, Math.min(focusState.idx, ms.length - 1));
  const mu = ms[cur] || { a: {}, b: {} };
  modalBody.innerHTML = `<div class="focus">${matchupPager("focus", ms.length, cur, mineIdx, "big")}${scoreBlock(mu)}
      <div class="rosters focus-rosters">${col(mu.a)}${col(mu.b)}</div></div>`;
  modalBody.querySelectorAll(".pgbtn.f").forEach(b => b.addEventListener("click", () => {
    focusState.idx = (cur + parseInt(b.dataset.dir, 10) + ms.length) % ms.length;
    renderFocus();
  }));
}
function openFocus(leagueIdx) {
  const lg = lastData.leagues[leagueIdx];
  if (!lg || lg.error) return;
  focusState = { leagueIdx, idx: cardIdx["lg" + leagueIdx] || 0 };
  openModal(lg.league_name, "", "full");
  renderFocus();
}

/* =====================================================================
   ROSTERS view
   ===================================================================== */
function rosterCell(pl) {
  const pos = pl.slot || pl.pos || "";
  const click = (pl.espn_id || pl.sleeper_id) ? "clickable" : "";
  const val = pl.value != null ? `<span class="rcell-val">${fmtVal(pl.value)}</span>` : "";
  const oppTxt = pl.opp ? `${esc(pl.opp_ha || "vs")} ${esc(pl.opp)}` : "";
  const sub = (pl.pos_rank != null || pl.trend || oppTxt)
    ? `<div class="rcell-sub2">${posRankStr(pl)}${oppTxt ? (pl.pos_rank != null ? " · " : "") + oppTxt : ""} ${trendArrow(pl.trend)}</div>` : "";
  return `<div class="rcell ${posClass(pos)} ${click}" ${pdata(pl)}>
      <div class="rcell-top"><span>${teamLogo(pl.team)}${esc(posLabel(pos))} · ${esc(pl.team || "FA")}</span>${val}</div>
      <div class="rcell-name">${esc(abbrevName(pl.name))}${injBadge(pl)}</div>${sub}</div>`;
}
function rosterColumn(t) {
  const proj = t.projected != null ? ` · ${t.projected.toFixed(1)} proj` : "";
  const strength = t.value_total ? `<div class="rcol-str">#${t.strength_rank} strength · ${fmtVal(t.value_total)}</div>` : "";
  const tradeBtn = t.is_me
    ? `<div class="rcol-str">★ your team</div>`
    : `<button class="ghost rcol-trade" data-team="${esc(String(t.id))}">⇄ Trade with</button>`;
  return `<div class="rteam-col ${t.is_me ? "me" : ""}">
      <div class="rcol-head"><div class="rcol-name">${esc(t.name)}</div>
        <div class="rcol-sub">${esc(t.record || "")}${proj}</div>${strength}${tradeBtn}</div>
      <div class="rcol-body">${(t.players || []).map(rosterCell).join("")}
        ${(t.bench && t.bench.length) ? `<div class="rcol-bench">BENCH</div>` + t.bench.map(rosterCell).join("") : ""}</div>
    </div>`;
}
async function renderRostersView() {
  const host = $("#view-rosters");
  const id = curLeagueId;
  if (!id) { host.innerHTML = `<div class="vempty">Pick a league above.</div>`; return; }
  const lg = leagueOf(id);
  host.innerHTML = `<div class="vhead"><div class="vtitle">👥 All rosters <small>${esc(lg ? lg.name : "")}</small></div>
      <div class="vactions"><button class="ghost" id="rvTrade">⇄ Open trade center</button><button class="ghost" id="rvRefresh">↻ Refresh</button></div></div>
      <div class="loading"><span class="spin"></span>Loading rosters…</div>`;
  host.querySelector("#rvTrade").addEventListener("click", () => navigate("trade", id));
  host.querySelector("#rvRefresh").addEventListener("click", () => { getRosters(id, true); renderRostersView(); });
  try {
    const data = await getRosters(id);
    if (curView !== "rosters" || curLeagueId !== id) return;
    host.querySelector(".vtitle small").textContent = `${data.league_name} · Wk ${data.week}`;
    host.querySelector(".loading").outerHTML = `<div class="rgrid">${(data.teams || []).map(rosterColumn).join("")}</div>`;
    host.querySelectorAll(".rcol-trade").forEach(b => b.addEventListener("click", () => navigate("trade", id, { partner: b.dataset.team })));
  } catch (e) {
    const l = host.querySelector(".loading"); if (l) l.outerHTML = `<div class="err-msg">Could not load rosters (${esc(e.message || e)})</div>`;
  }
}

/* =====================================================================
   LAB view
   ===================================================================== */
function moveArrow(m) {
  if (!m) return `<span class="mv flat">–</span>`;
  return m > 0 ? `<span class="mv up">▲${m}</span>` : `<span class="mv down">▼${-m}</span>`;
}
function labStandings(d) {
  const rows = d.teams.map((t, i) => {
    const po = t.playoff_pct;
    return `<tr class="${t.is_me ? "me" : ""}"><td>${i + 1}</td><td class="lft">${esc(t.name)}${t.is_me ? " ★" : ""}</td>
        <td>${t.wins}-${t.losses}${t.ties ? "-" + t.ties : ""}</td><td>${(t.pf || 0).toFixed(1)}</td><td>${(t.pa || 0).toFixed(1)}</td>
        <td class="po"><div class="pobar"><i style="width:${po || 0}%"></i></div>${po == null ? "–" : po + "%"}</td></tr>`;
  }).join("");
  return `<div class="tablewrap"><table class="glog labtbl"><thead><tr><th>#</th><th class="lft">Team</th><th>Rec</th><th>PF</th><th>PA</th><th>Playoff %</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div class="lab-note">Playoff odds simulated ${d.playoff_teams}-team field, reg. season through week ${d.playoff_start - 1}, from current records + team strength (1,500 sims).</div>`;
}
function labPower(d) {
  return d.power.map(t => `<div class="lab-row ${t.is_me ? "me" : ""}"><span class="lab-rank">#${t.rank}</span>${moveArrow(t.movement)}
      <span class="lab-name">${esc(t.name)}${t.is_me ? " ★" : ""} <small>${esc(t.record || "")}</small></span><span class="lab-val">${fmtVal(t.value_total)}</span></div>`).join("");
}
function labSos(d) {
  return `<div class="lab-note">Easiest remaining schedule first (avg. opponent roster value).</div>` +
    d.sos.map((o, i) => `<div class="lab-row ${o.is_me ? "me" : ""}"><span class="lab-rank">${i + 1}</span>
      <span class="lab-name">${esc(o.name)}${o.is_me ? " ★" : ""} <small>${o.games} games left</small></span><span class="lab-val">${fmtVal(o.opp_value)}</span></div>`).join("");
}
function labWaivers(d) {
  if (!d.waivers.length) return `<div class="empty">No available players found.</div>`;
  return `<div class="lab-note">Best available (unrostered), by trade value. 🔥 = trending add on Sleeper.</div>` +
    d.waivers.map(w => `<div class="lab-row">${posBadge(w.pos)}<span class="lab-name">${esc(w.name)} <small>${esc(w.team || "FA")}</small> ${w.hot ? "🔥" : ""}</span>
      <span class="lab-val">${fmtVal(w.value)} ${trendArrow(w.trend)}</span></div>`).join("");
}
function labBuySell(d) {
  const c = arr => arr.length ? arr.map(p => `<div class="lab-row">${posBadge(p.pos)}<span class="lab-name">${esc(p.name)} <small>${esc(p.owner)}</small></span>
      <span class="lab-val">${fmtVal(p.value)} ${trendArrow(p.trend)}</span></div>`).join("") : `<div class="empty">–</div>`;
  return `<div class="root-wrap" style="padding:0"><div class="root-col"><div class="sec-label" style="background:#dc2626">SELL HIGH · rising 30d</div>${c(d.buysell.sell)}</div>
      <div class="root-col"><div class="sec-label" style="background:#16a34a">BUY LOW · falling 30d</div>${c(d.buysell.buy)}</div></div>`;
}
function labVegas(d) {
  if (!d.vegas_edge.over.length && !d.vegas_edge.under.length)
    return `<div class="empty">DraftKings hasn't posted player yardage props for this week yet — they usually go up mid-week.</div>`;
  const list = arr => arr.length ? arr.map(p => `<div class="lab-row">${posBadge(p.pos)}<span class="lab-name">${esc(p.name)} <small>${esc(p.owner)}</small></span>
      <span class="ve-nums">proj ${p.proj} · vegas ${p.vegas_fp} <b class="${p.edge >= 0 ? "pos" : "neg"}">${p.edge >= 0 ? "+" : ""}${p.edge}</b></span></div>`).join("") : `<div class="empty">–</div>`;
  return `<div class="lab-note">Vegas-implied fantasy points (PPR) vs. projection. Positive = Vegas likes them more than the projection.</div>
    <div class="root-wrap" style="padding:0"><div class="root-col"><div class="sec-label" style="background:#16a34a">VEGAS OVER PROJECTION</div>${list(d.vegas_edge.over)}</div>
      <div class="root-col"><div class="sec-label" style="background:#dc2626">VEGAS UNDER PROJECTION</div>${list(d.vegas_edge.under)}</div></div>`;
}
function labRecap(d) {
  const r = d.recap;
  if (!r) return `<div class="empty">No games scored yet this week — check back once games kick off.</div>`;
  const gm = g => g ? `${esc(g.a)} ${g.as} — ${g.bs} ${esc(g.b)} <small>(by ${g.margin})</small>` : "–";
  return `<div class="recap">
      <div class="recap-card"><div class="opt-k">Top score</div><div class="recap-v">${esc(r.top.name)} · ${r.top.score}</div></div>
      <div class="recap-card"><div class="opt-k">Low score</div><div class="recap-v">${esc(r.low.name)} · ${r.low.score}</div></div>
      <div class="recap-card"><div class="opt-k">Biggest blowout</div><div class="recap-v">${gm(r.blowout)}</div></div>
      <div class="recap-card"><div class="opt-k">Closest game</div><div class="recap-v">${gm(r.closest)}</div></div></div>`;
}
function labByes(d) {
  if (!d.byes || !d.byes.length) return `<div class="empty">No upcoming byes on your roster. 🎉</div>`;
  return `<div class="lab-note">Your players' upcoming NFL bye weeks — weeks with 3+ are flagged.</div>` +
    d.byes.map(b => `<div class="bye-week ${b.players.length >= 3 ? "warn" : ""}">
        <div class="bye-h">Week ${b.week} <span>${b.players.length} player${b.players.length > 1 ? "s" : ""}${b.players.length >= 3 ? " ⚠️" : ""}</span></div>
        <div class="bye-players">${b.players.map(p => `<span class="bye-p">${posBadge(p.pos)}${esc(p.name)}${p.starter ? "" : " <small>(bench)</small>"}</span>`).join("")}</div></div>`).join("");
}
const LAB_TABS = [["standings", "Standings & Odds", labStandings], ["power", "Power Rankings", labPower],
  ["sos", "Schedule", labSos], ["byes", "Byes", labByes], ["waivers", "Waivers", labWaivers],
  ["buysell", "Buy / Sell", labBuySell], ["vegas", "Vegas Edge", labVegas], ["recap", "Recap", labRecap]];
const labCache = {};
let labTab = store.get("labTab", "standings");
async function renderLabView() {
  const host = $("#view-lab");
  const id = curLeagueId;
  if (!id) { host.innerHTML = `<div class="vempty">Pick a league above.</div>`; return; }
  const lg = leagueOf(id);
  host.innerHTML = `<div class="vhead"><div class="vtitle">📊 League Lab <small>${esc(lg ? lg.name : "")}</small></div>
      <div class="vactions"><button class="ghost" id="labRefresh">↻ Refresh</button></div></div>
      <div class="panel"><div class="loading"><span class="spin"></span>Crunching numbers…</div></div>`;
  host.querySelector("#labRefresh").addEventListener("click", () => { delete labCache[id]; renderLabView(); });
  try {
    if (!labCache[id] || Date.now() - labCache[id].ts > 120_000) {
      const r = await fetch("/api/league?id=" + encodeURIComponent(id), { cache: "no-store" });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      labCache[id] = { ts: Date.now(), d };
    }
    if (curView !== "lab" || curLeagueId !== id) return;
    const d = labCache[id].d;
    host.querySelector(".panel").innerHTML = `<div class="ptabs">${LAB_TABS.map(t =>
      `<button class="ptab ${t[0] === labTab ? "active" : ""}" data-tab="${t[0]}">${t[1]}</button>`).join("")}</div>
      <div id="labHost" class="lab-host" style="padding:12px 14px"></div>`;
    const lh = host.querySelector("#labHost");
    const show = key => { const t = LAB_TABS.find(x => x[0] === key) || LAB_TABS[0]; lh.innerHTML = t[2](d); };
    host.querySelectorAll(".ptab").forEach(b => b.addEventListener("click", () => {
      host.querySelectorAll(".ptab").forEach(x => x.classList.toggle("active", x === b));
      labTab = b.dataset.tab; store.set("labTab", labTab); show(labTab);
    }));
    show(labTab);
  } catch (e) {
    host.querySelector(".panel").innerHTML = `<div class="err-msg">Could not load Lab (${esc(e.message || e)})</div>`;
  }
}

/* =====================================================================
   generic modal
   ===================================================================== */
const modal = $("#modal");
const modalBody = $("#modalBody");
const modalTitle = $("#modalTitle");
const modalCard = modal.querySelector(".modal-card");
function openModal(title, html, size) {
  modalCard.classList.remove("full", "wide");
  if (size) modalCard.classList.add(size);
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modal.hidden = false;
}
function closeModal() { modal.hidden = true; modalBody.innerHTML = ""; modalCard.classList.remove("full", "wide"); }
$("#modalClose").addEventListener("click", closeModal);
modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!pmodal.hidden) closePmWindow(); else closeModal();
});
$("#rootingBtn").addEventListener("click", openRooting);

/* =====================================================================
   settings (AI analyst)
   ===================================================================== */
let aiStatus = null;
async function fetchAiStatus(force) {
  if (aiStatus && !force) return aiStatus;
  try { const r = await fetch("/api/ai/settings", { cache: "no-store" }); aiStatus = await r.json(); }
  catch (e) { aiStatus = { configured: false, provider: "claude_cli", providers: {}, cli: {} }; }
  return aiStatus;
}
async function openSettings() {
  openModal("Settings", `<div class="loading"><span class="spin"></span>Loading…</div>`);
  const s = await fetchAiStatus(true);
  const provs = s.providers || {};
  const cliOk = s.cli || {};
  const optLabel = k => {
    const p = provs[k]; if (!p) return k;
    if (p.cli) return `${p.label} ${cliOk[k] ? "· installed ✓" : "· not installed"}`;
    return p.label;
  };
  const sel = Object.keys(provs).map(k => `<option value="${k}" ${k === s.provider ? "selected" : ""}>${esc(optLabel(k))}</option>`).join("");
  modalBody.innerHTML = `<div class="settings">
      <div class="status-line">AI analyst:
        <span class="status-pill ${s.configured ? "ok" : "no"}" id="aiPill">${s.configured ? "ready" : "not configured"}</span>
        <span class="fnote" id="aiWho"></span></div>
      <div class="frow"><label>How to connect</label><select id="aiProv">${sel}</select></div>
      <div class="fnote" id="aiHelp"></div>
      <div class="frow" id="aiKeyRow"><label>API key</label>
        <input type="password" id="aiKey" placeholder="${s.key_hint ? "saved (" + esc(s.key_hint) + ") — paste to replace" : "paste your key"}" autocomplete="off"></div>
      <div class="frow" id="aiUrlRow"><label>Base URL (OpenAI-compatible)</label>
        <input type="text" id="aiUrl" value="${esc(s.base_url || "")}" placeholder="https://host/v1"></div>
      <div class="frow"><label>Model <small style="text-transform:none;font-weight:500">(optional)</small></label>
        <input type="text" id="aiModel" value="${esc(s.model || "")}" placeholder=""></div>
      <div class="frow-actions">
        <button class="primary" id="aiSave">Save</button>
        <button class="ghost" id="aiClear" ${s.key_hint ? "" : "hidden"}>Remove saved key</button>
        <span class="fnote" id="aiMsg"></span></div>
      <div class="fnote">Everything is stored locally in <code>config.json</code> (git-ignored). League data is only sent to the provider you pick, and only when you press an AI button in the Trade Center.</div>
    </div>`;
  const prov = modalBody.querySelector("#aiProv"), keyRow = modalBody.querySelector("#aiKeyRow"),
    urlRow = modalBody.querySelector("#aiUrlRow"), help = modalBody.querySelector("#aiHelp"),
    modelIn = modalBody.querySelector("#aiModel"), who = modalBody.querySelector("#aiWho");
  const HELP = {
    claude_cli: `Uses the <b>Claude Code CLI</b> that's signed in with your Claude account on this computer — no API key. If it isn't signed in yet, open Terminal, run <code>claude</code> once and log in. ${cliOk.claude_cli ? "" : "<b>Not found on this machine</b> — install with <code>npm i -g @anthropic-ai/claude-code</code>."}`,
    codex_cli: `Uses the <b>Codex CLI</b> signed in with your ChatGPT account — no API key. If it isn't signed in, run <code>codex login</code> in Terminal. Model defaults to <code>gpt-5.5</code>. ${cliOk.codex_cli ? "" : "<b>Not found on this machine</b> — install with <code>npm i -g @openai/codex</code>."}`,
    anthropic: `Pay-as-you-go key from <code>console.anthropic.com</code>. Default model <code>claude-sonnet-5-5</code>.`,
    openai: `Pay-as-you-go key from <code>platform.openai.com</code>. Default model <code>gpt-5</code>.`,
    custom: `Any OpenAI-compatible server (Ollama, LM Studio, OpenRouter…). Enter its base URL (ending in <code>/v1</code>), a key if it needs one, and the model name.`,
  };
  const sync = () => {
    const k = prov.value, p = provs[k] || {};
    keyRow.hidden = !!p.cli; urlRow.hidden = k !== "custom";
    help.innerHTML = HELP[k] || "";
    modelIn.placeholder = p.model ? `default: ${p.model}` : "provider default";
    who.textContent = `${(provs[s.provider] || {}).label || s.provider}${s.model ? " · " + s.model : ""}${s.from_env ? " · key from environment" : ""}`;
  };
  prov.addEventListener("change", sync); sync();
  modalBody.querySelector("#aiSave").addEventListener("click", async () => {
    const body = { provider: prov.value, model: modelIn.value.trim(), base_url: modalBody.querySelector("#aiUrl").value.trim() };
    const key = modalBody.querySelector("#aiKey").value.trim();
    if (key) body.api_key = key;
    const msg = modalBody.querySelector("#aiMsg"); msg.textContent = "Saving…";
    try {
      const r = await fetch("/api/ai/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      aiStatus = d; modalBody.querySelector("#aiKey").value = "";
      msg.textContent = "Saved."; toast("AI settings saved");
      if (window.TradeView) TradeView.aiStatusChanged(d);
      closeModal();
    } catch (e) { msg.textContent = "Error: " + (e.message || e); }
  });
  modalBody.querySelector("#aiClear").addEventListener("click", async () => {
    const r = await fetch("/api/ai/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clear: true }) });
    aiStatus = await r.json(); toast("Saved key removed"); openSettings();
  });
}
$("#settingsBtn").addEventListener("click", openSettings);

/* =====================================================================
   player profile window (multi-tab)
   ===================================================================== */
function fmtDate(v) {
  if (v == null || v === "") return "";
  const d = (typeof v === "number" || /^\d+$/.test(String(v))) ? new Date(Number(v)) : new Date(v);
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function srcLabel(s) { const m = { fantasy_pros: "FantasyPros", rotowire: "RotoWire", Rotowire: "RotoWire" }; return m[s] || s || ""; }
function num(v) { if (v == null) return null; const n = parseFloat(String(v).replace(/,/g, "")); return isNaN(n) ? null : n; }
function gradeColor(v, s) {
  if (s.mx === s.mn) return "hsla(62,42%,45%,.30)";
  let f = (v - s.mn) / (s.mx - s.mn);
  if (s.dir === "low") f = 1 - f;
  return `hsla(${(5 + f * 115).toFixed(0)},45%,45%,.45)`;
}
function gamelogTable(gl) {
  if (!gl || !gl.rows || !gl.rows.length) return `<div class="empty">No games logged for this season yet.</div>`;
  const cols = gl.columns || [], rows = gl.rows;
  const scale = cols.map((c, ci) => {
    let mn = Infinity, mx = -Infinity, any = false;
    rows.forEach(r => { const v = num(r.values[ci]); if (v != null) { any = true; if (v < mn) mn = v; if (v > mx) mx = v; } });
    return any ? { mn, mx, dir: c.dir } : null;
  });
  let gh = `<th class="lead" colspan="3"></th>`;
  for (let i = 0; i < cols.length;) {
    let j = i; while (j + 1 < cols.length && cols[j + 1].group === cols[i].group) j++;
    gh += `<th class="grp grp-${esc(cols[i].group)}" colspan="${j - i + 1}">${esc(cols[i].group)}</th>`;
    i = j + 1;
  }
  const colHead = `<th>Wk</th><th class="lft">Opp</th><th>Res</th>` + cols.map(c => `<th class="${c.name === "fpts" ? "fpts" : ""}">${esc(c.label)}</th>`).join("");
  const body = rows.map(r => {
    const opp = `${r.atVs || ""} ${r.opp || ""}`.trim();
    const res = r.result ? `<span class="res res-${esc(r.result)}">${esc(r.result)}</span>` : "";
    const cells = cols.map((c, ci) => {
      const raw = r.values[ci], v = num(raw);
      const bg = (scale[ci] && v != null) ? gradeColor(v, scale[ci]) : "";
      const disp = (raw === "" || raw == null) ? "–" : (c.name === "fpts" ? Number(raw).toFixed(1) : esc(raw));
      return `<td class="${c.name === "fpts" ? "fpts" : ""}" ${bg ? `style="background:${bg}"` : ""}>${disp}</td>`;
    }).join("");
    return `<tr><td class="wk">${r.playoff ? "P" : ""}${r.week ?? ""}</td><td class="lft opp">${r.opp_logo ? `<img src="${esc(r.opp_logo)}" alt="">` : ""}${esc(opp || "—")}</td><td>${res}</td>${cells}</tr>`;
  }).join("");
  const regRows = rows.filter(r => !r.playoff);
  const base = regRows.length ? regRows : rows;
  const avg = cols.map((c, ci) => { let s = 0, n = 0; base.forEach(r => { const v = num(r.values[ci]); if (v != null) { s += v; n++; } }); return n ? s / n : null; });
  const avgCells = cols.map((c, ci) => {
    const a = avg[ci]; const bg = (scale[ci] && a != null) ? gradeColor(a, scale[ci]) : "";
    return `<td class="${c.name === "fpts" ? "fpts" : ""}" ${bg ? `style="background:${bg}"` : ""}>${a == null ? "–" : a.toFixed(1)}</td>`;
  }).join("");
  return `<div class="tablewrap"><table class="glog"><thead><tr class="ghead">${gh}</tr><tr>${colHead}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="avg-title">Season averages · per game (${base.length} G, regular season)</div>
    <div class="tablewrap"><table class="glog avg"><thead><tr>${colHead}</tr></thead>
      <tbody><tr><td class="wk"></td><td class="lft">AVG</td><td></td>${avgCells}</tr></tbody></table></div>`;
}
function newsList(items) {
  if (!items || !items.length) return `<div class="empty">No recent items.</div>`;
  return items.map(n => {
    const showBody = n.body && n.body !== n.headline && !(n.headline || "").includes(n.body);
    const longBody = showBody && n.body.length > 220;
    return `<div class="news-item"><div class="news-h">${esc(n.headline || "")}</div>
        ${showBody ? `<div class="news-b">${esc(n.body)}</div>` : ""}${longBody ? `<span class="news-more">Show more</span>` : ""}
        <div class="news-m">${esc(srcLabel(n.source))}${n.published ? " · " + fmtDate(n.published) : ""}</div></div>`;
  }).join("");
}
function outlookBlock(o) {
  if (!o) return ""; const text = o.body || o.headline; if (!text) return "";
  return `<div class="outlook"><div class="sec-label sleeper">SLEEPER · SEASON OUTLOOK</div><div class="news-b">${esc(text)}</div></div>`;
}
function depthChart(dp) {
  if (!dp || !dp.positions || !dp.positions.length) return `<div class="empty">No depth chart available.</div>`;
  return `<div class="depth">${dp.positions.map(pos => `<div class="depth-col"><div class="depth-h">${posBadge(pos.pos)}</div>
      ${pos.players.slice(0, 6).map((pl, i) => `<div class="depth-p ${pl.is_this ? "me" : ""}"><span class="depth-rank">${i + 1}</span><span class="depth-name">${esc(pl.name)}</span></div>`).join("")}</div>`).join("")}</div>`;
}

const pmodal = $("#pmodal");
const pmBody = $("#pmBody");
const pmTabsEl = $("#pmTabs");
let pmTabs = [];
let pmActiveKey = null;
function pmKey(d) { return String(d.espn || d.sleeper || ("n:" + (d.name || ""))); }
function openPlayer(d) {
  const key = pmKey(d);
  let tab = pmTabs.find(t => t.key === key);
  if (!tab) {
    tab = { key, name: d.name || "Player", d, data: null, err: null, avail: null, odds: null, panel: "log" };
    pmTabs.push(tab); fetchProfile(tab);
  }
  pmActiveKey = key; pmodal.hidden = false; renderPmTabs(); renderPmBody();
}
async function fetchProfile(tab) {
  const d = tab.d;
  const qs = new URLSearchParams({ espn_id: d.espn || "", sleeper_id: d.sleeper || "", team: d.team || "", pos: d.pos || "", name: d.name || "" });
  try {
    const r = await fetch("/api/player?" + qs.toString(), { cache: "no-store" });
    const p = await r.json();
    if (p.error) tab.err = p.error; else { tab.data = p; tab.name = p.name || tab.name; }
  } catch (e) { tab.err = String(e); }
  if (pmActiveKey === tab.key) { renderPmTabs(); renderPmBody(); }
}
function renderPmTabs() {
  pmTabsEl.innerHTML = pmTabs.map(t => `<div class="pm-tab ${t.key === pmActiveKey ? "active" : ""}" data-key="${esc(t.key)}">
       <span class="pm-tab-name">${esc(t.name)}</span><span class="pm-tab-x" data-close="${esc(t.key)}">✕</span></div>`).join("");
}
function renderPmBody() {
  const tab = pmTabs.find(t => t.key === pmActiveKey);
  if (!tab) { pmBody.innerHTML = ""; return; }
  if (tab.err) { pmBody.innerHTML = `<div class="err-msg">${esc(tab.err)}</div>`; return; }
  if (!tab.data) { pmBody.innerHTML = `<div class="loading"><span class="spin"></span>Loading ${esc(tab.name)}…</div>`; return; }
  renderPlayerInto(tab);
}
function closePmTab(key) {
  const i = pmTabs.findIndex(t => t.key === key);
  if (i < 0) return;
  pmTabs.splice(i, 1);
  if (pmActiveKey !== key) { renderPmTabs(); return; }
  const next = pmTabs[i] || pmTabs[i - 1];
  if (next) { pmActiveKey = next.key; renderPmTabs(); renderPmBody(); } else closePmWindow();
}
function closePmWindow() {
  pmodal.hidden = true; pmTabs = []; pmActiveKey = null; pmBody.innerHTML = ""; pmTabsEl.innerHTML = "";
  $("#pmResults").hidden = true;
}
function renderPlayerInto(tab) {
  const p = tab.data;
  const panel = tab.panel || "log";
  const gl0 = p.gamelog || {};
  if (!tab.glCache) { tab.glCache = {}; if (gl0.season) tab.glCache[String(gl0.season)] = gl0; }
  if (!tab.season && gl0.season) tab.season = String(gl0.season);
  const seasons = p.seasons || gl0.seasons || [];
  const curSeason = tab.season || gl0.season;
  const curGl = tab.glCache[String(curSeason)] || gl0;
  const seasonSel = seasons.length ? `<select id="glseason">${seasons.map(s => `<option ${String(s) === String(curSeason) ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>` : "";
  const head = `<div class="pp-head">${p.headshot ? `<img class="pp-shot" src="${esc(p.headshot)}" alt="" onerror="this.style.display='none'">` : ""}
      <div><div class="pp-name">${esc(p.name)} ${injBadge(p)}</div>
      <div class="pp-sub">${posBadge(p.pos)} ${teamLogo(p.team)} ${esc(p.team || "")}
        ${p.value != null ? `<span class="pp-val">${fmtVal(p.value)} · ${posRankStr(p)} ${trendArrow(p.trend)}</span>` : ""}</div></div></div>`;
  const pane = (name, label) => `<button class="ptab ${panel === name ? "active" : ""}" data-panel="${name}">${label}</button>`;
  pmBody.scrollTop = 0;
  pmBody.innerHTML = head + `<div id="availHost" class="avail"><div class="avail-loading">Checking your leagues…</div></div>`
    + `<div class="ptabs">${pane("log", "Game Log")}${pane("news", "News &amp; Outlook")}${pane("depth", "Depth Chart")}${pane("odds", "Vegas")}</div>`
    + `<div class="ppanel" data-panel="log" ${panel === "log" ? "" : "hidden"}><div class="panel-bar">Season ${seasonSel}</div><div id="glhost">${gamelogTable(curGl)}</div></div>`
    + `<div class="ppanel" data-panel="news" ${panel === "news" ? "" : "hidden"}><div class="sec-label espn">ESPN</div>${newsList(p.news.espn)}
        <div class="sec-label sleeper">SLEEPER</div>${newsList(p.news.sleeper)}${outlookBlock(p.outlook && p.outlook.sleeper)}</div>`
    + `<div class="ppanel" data-panel="depth" ${panel === "depth" ? "" : "hidden"}><div class="panel-bar">${esc(p.team || "")} depth chart</div>${depthChart(p.depth)}</div>`
    + `<div class="ppanel" data-panel="odds" ${panel === "odds" ? "" : "hidden"}><div id="oddsHost"><div class="loading">Loading odds…</div></div></div>`;
  if (tab.avail) renderAvail(tab.avail); else loadAvailability(tab);
  if (panel === "odds") { if (tab.odds) renderOdds(tab.odds); else loadOdds(tab); }
  pmBody.querySelectorAll(".ptab").forEach(btn => btn.addEventListener("click", () => {
    tab.panel = btn.dataset.panel;
    pmBody.querySelectorAll(".ptab").forEach(b => b.classList.toggle("active", b === btn));
    pmBody.querySelectorAll(".ppanel").forEach(pan => pan.hidden = pan.dataset.panel !== btn.dataset.panel);
    if (btn.dataset.panel === "odds") {
      if (tab.odds) renderOdds(tab.odds);
      else { const host = pmBody.querySelector("#oddsHost"); if (host && !host.dataset.loaded) { host.dataset.loaded = "1"; loadOdds(tab); } }
    }
  }));
  pmBody.querySelectorAll(".news-more").forEach(m => m.addEventListener("click", () => { m.closest(".news-item").classList.toggle("open"); m.textContent = m.closest(".news-item").classList.contains("open") ? "Show less" : "Show more"; }));
  const sel = pmBody.querySelector("#glseason");
  if (sel) sel.addEventListener("change", async () => {
    const yr = sel.value; tab.season = yr;
    const host = pmBody.querySelector("#glhost");
    if (tab.glCache[yr]) { host.innerHTML = gamelogTable(tab.glCache[yr]); return; }
    host.innerHTML = `<div class="loading">Loading ${yr}…</div>`;
    try {
      const r = await fetch(`/api/player/gamelog?espn_id=${encodeURIComponent(p.espn_id || "")}&sleeper_id=${encodeURIComponent(p.sleeper_id || "")}&season=${yr}`, { cache: "no-store" });
      const data = await r.json(); tab.glCache[yr] = data;
      if (pmActiveKey === tab.key && tab.season === yr) host.innerHTML = gamelogTable(data);
    } catch (e) { host.innerHTML = `<div class="err-msg">Could not load ${yr}</div>`; }
  });
}
function renderOdds(o) {
  const host = pmBody.querySelector("#oddsHost");
  if (!host) return;
  if (!o || !o.found) { host.innerHTML = `<div class="empty">No DraftKings props posted${o && o.name ? " for " + esc(o.name) : ""} — player lines usually go up during game week.</div>`; return; }
  const td = o.td ? `<div class="odds-td"><span>Anytime TD</span><b>${esc(o.td)}</b></div>` : "";
  const mk = (o.markets || []).map(m => `<div class="odds-mkt"><div class="odds-h">${esc(m.stat)}${m.line != null ? `<span class="odds-line">O/U ≈ ${m.line}</span>` : ""}</div>
      <div class="odds-ladder">${m.ladder.map(x => `<span class="rung"><b>${x.v}+</b> ${esc(x.odds)}</span>`).join("")}</div></div>`).join("");
  host.innerHTML = `<div class="odds-book">DraftKings · props update through game week</div>${td}${mk || `<div class="empty">No yardage props for this player.</div>`}`;
}
async function loadOdds(tab) {
  const p = tab.data;
  try {
    const r = await fetch("/api/player/odds?" + new URLSearchParams({ name: p.name || "", team: p.team || "", pos: p.pos || "" }), { cache: "no-store" });
    tab.odds = await r.json();
    if (pmActiveKey === tab.key) renderOdds(tab.odds);
  } catch (e) { const host = pmBody.querySelector("#oddsHost"); if (host) host.innerHTML = `<div class="err-msg">Could not load odds</div>`; }
}
function renderAvail(data) {
  const host = pmBody.querySelector("#availHost");
  if (!host) return;
  const rows = (data && data.leagues) || [];
  if (!rows.length) { host.innerHTML = ""; return; }
  const chip = r => r.status !== "owned" ? `<span class="av-chip av-free">Available · FA/waivers</span>`
    : r.is_me ? `<span class="av-chip av-mine">YOU</span>` : `<span class="av-chip av-owned">${esc(r.team || "Rostered")}</span>`;
  host.innerHTML = `<div class="avail-title">Availability in your leagues</div>` + rows.map(r =>
    `<div class="av-row"><span class="av-league"><span class="prov ${r.provider}">${r.provider}</span> ${esc(r.league)}</span>${chip(r)}</div>`).join("");
}
async function loadAvailability(tab) {
  const p = tab.data;
  try {
    const r = await fetch("/api/player/availability?" + new URLSearchParams({ sleeper_id: p.sleeper_id || "", espn_id: p.espn_id || "", name: p.name || "", team: p.team || "" }), { cache: "no-store" });
    tab.avail = await r.json();
    if (pmActiveKey === tab.key) renderAvail(tab.avail);
  } catch (e) { const host = pmBody.querySelector("#availHost"); if (host) host.innerHTML = ""; }
}
pmTabsEl.addEventListener("click", e => {
  const x = e.target.closest(".pm-tab-x");
  if (x) { e.stopPropagation(); closePmTab(x.dataset.close); return; }
  const t = e.target.closest(".pm-tab");
  if (t) { pmActiveKey = t.dataset.key; renderPmTabs(); renderPmBody(); }
});
$("#pmClose").addEventListener("click", closePmWindow);
pmodal.addEventListener("click", e => { if (e.target === pmodal) closePmWindow(); });
const pmSearch = $("#pmSearch"), pmResults = $("#pmResults");
let pmSearchTimer = null;
pmSearch.addEventListener("input", () => {
  clearTimeout(pmSearchTimer);
  const q = pmSearch.value.trim();
  if (q.length < 2) { pmResults.hidden = true; pmResults.innerHTML = ""; return; }
  pmSearchTimer = setTimeout(async () => {
    try {
      const r = await fetch("/api/search?q=" + encodeURIComponent(q), { cache: "no-store" });
      const rows = (await r.json()).results || [];
      pmResults.innerHTML = rows.length ? rows.map(p => `<div class="pm-result" ${pdata({ espn_id: p.espn_id, sleeper_id: p.sleeper_id, team: p.team, pos: p.pos, name: p.name })}>
             ${posBadge(p.pos)} <span class="pmr-name">${esc(p.name)}</span> <small>${esc(p.team)}</small></div>`).join("")
        : `<div class="pm-result empty">No players found</div>`;
      pmResults.hidden = false;
    } catch (e) { pmResults.hidden = true; }
  }, 200);
});
pmResults.addEventListener("click", e => {
  const row = e.target.closest(".pm-result");
  if (!row || !row.dataset.name) return;
  openPlayer(row.dataset); pmSearch.value = ""; pmResults.hidden = true; pmResults.innerHTML = "";
});
document.addEventListener("click", e => { if (!e.target.closest(".pm-search")) pmResults.hidden = true; });
document.body.addEventListener("click", e => {
  const pm = e.target.closest(".pm-open");
  if (pm) { e.preventDefault(); e.stopPropagation(); openPlayer(pm.dataset); return; }
  const row = e.target.closest(".prow.clickable, .rcell.clickable");
  if (row) openPlayer(row.dataset);
});

/* =====================================================================
   theme, benches, refresh, boot
   ===================================================================== */
const themeBtn = $("#themeBtn");
function effectiveTheme() {
  const s = document.documentElement.dataset.theme;
  if (s) return s;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function updateThemeBtn() {
  const dark = effectiveTheme() === "dark";
  themeBtn.textContent = dark ? "☀️" : "🌙";
  themeBtn.title = dark ? "Switch to light mode" : "Switch to dark mode";
}
themeBtn.addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next; store.set("theme", next); updateThemeBtn();
});
updateThemeBtn();

const benchesBox = $("#benches");
function applyBenches() { document.body.classList.toggle("show-bench", benchesBox.checked); store.set("showBench", benchesBox.checked); }
benchesBox.checked = store.get("showBench", false);
benchesBox.addEventListener("change", applyBenches);
applyBenches();
function schedule() {
  if (timer) clearInterval(timer);
  if ($("#autoref").checked) timer = setInterval(load, parseInt($("#interval").value, 10) * 1000);
}
$("#refresh").addEventListener("click", load);
$("#autoref").addEventListener("change", schedule);
$("#interval").addEventListener("change", schedule);

grid.innerHTML = Array.from({ length: 4 }, () => `<div class="skeleton"></div>`).join("");
window.addEventListener("load", () => {
  routeFromHash();
  load();
  schedule();
});
