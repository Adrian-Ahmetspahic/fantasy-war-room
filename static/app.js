"use strict";

const grid = document.getElementById("grid");
const banner = document.getElementById("banner");
const updatedEl = document.getElementById("updated");
const summaryEl = document.getElementById("summary");
const weekLabel = document.getElementById("weeklabel");
const pulse = document.getElementById("pulse");
const benchesBox = document.getElementById("benches");

let timer = null;
let prevScores = {};   // card key -> {me, opp} last poll, for change flashes

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function statusWord(s) {
  return s === "in" ? "LIVE" : s === "post" ? "Final" : "—";
}
function posClass(pos) {
  const p = (pos || "").toUpperCase().replace("/", "");
  return ["QB", "RB", "WR", "TE", "K", "DEF", "DST", "FLEX", "SFLEX",
          "IDP", "DL", "LB", "DB"].includes(p) ? "pos-" + p : "pos-x";
}
function posBadge(pos) {
  const label = (pos || "").toUpperCase() === "D/ST" ? "DEF" : (pos || "?");
  return `<span class="pos ${posClass(pos)}">${esc(label)}</span>`;
}

// count of starters still to play / live, for the "to play" hint
function playHint(t) {
  if (!t || !t.players) return "";
  let pre = 0, live = 0;
  for (const p of t.players) {
    if (p.game_status === "pre") pre++;
    else if (p.game_status === "in") live++;
  }
  const bits = [];
  if (live) bits.push(`${live} live`);
  if (pre) bits.push(`${pre} to play`);
  return bits.join(" · ");
}

function teamSide(t, cls) {
  if (!t) return `<div class="side ${cls}"><div class="team-name">—</div><div class="score">–</div></div>`;
  const rec = t.record ? `<span class="rec">${esc(t.record)}</span>` : "";
  const proj = t.projected != null ? `proj ${t.projected.toFixed(1)}` : "";
  const hint = playHint(t);
  const sub = [proj, hint].filter(Boolean).join(" · ");
  return `<div class="side ${cls}">
      <div class="team-name">${esc(t.name)} ${rec}</div>
      <div class="score" data-score>${t.score.toFixed(1)}</div>
      <div class="proj">${sub}</div>
    </div>`;
}

function playerRow(p) {
  const proj = p.projected != null ? `<small>${p.projected.toFixed(1)} proj</small>` : "";
  const rz = p.redzone ? ` · <span class="rztag">RED ZONE</span>` : "";
  const detail = p.game_detail ? ` · ${esc(p.game_detail)}` : "";
  const clickable = p.espn_id || p.sleeper_id;
  const data = clickable
    ? `data-espn="${esc(p.espn_id || "")}" data-sleeper="${esc(p.sleeper_id || "")}" `
      + `data-team="${esc(p.team || "")}" data-pos="${esc(p.pos || "")}" data-name="${esc(p.name || "")}"`
    : "";
  return `<div class="prow ${p.redzone ? "rz" : ""} ${p.starter === false ? "bench-row" : ""} ${clickable ? "clickable" : ""}" ${data}>
      <span class="gdot ${p.game_status}" title="${statusWord(p.game_status)}"></span>
      ${posBadge(p.slot || p.pos)}
      <span class="pmeta">
        <div class="pname">${esc(p.name)}</div>
        <div class="psub">${esc(p.team || "FA")}${rz}${detail}${p.value != null ? ` · <span class="vtag">${posRankStr(p)} ${fmtVal(p.value)}</span>` : ""}</div>
      </span>
      <span class="ppts">${(p.points || 0).toFixed(1)}${proj}</span>
    </div>`;
}

function benchBlock(bench) {
  if (!bench || !bench.length) return "";
  const total = bench.reduce((a, p) => a + (p.points || 0), 0);
  return `<div class="bench">
      <div class="bench-head">BENCH <span>${total.toFixed(1)}</span></div>
      ${bench.map(playerRow).join("")}
    </div>`;
}

function col(t) {
  if (!t) return `<div class="col"></div>`;
  return `<div class="col">${(t.players || []).map(playerRow).join("")}${benchBlock(t.bench)}</div>`;
}

function cardHTML(lg, key) {
  if (lg.error) {
    return `<section class="card err">
        <div class="card-head"><span class="league-name">${esc(lg.league_name || "League")}</span>
        <span class="prov ${lg.provider || ""}">${esc(lg.provider || "")}</span></div>
        <div class="err-msg">${esc(lg.error)}</div>
        ${lg.id ? `<button class="ghost rosters-btn" data-id="${esc(lg.id)}" data-name="${esc(lg.league_name)}">View all rosters</button>` : ""}
      </section>`;
  }
  const me = lg.my_team, opp = lg.opp_team;
  const wp = lg.win_prob;
  const winning = me && opp && me.score >= opp.score;

  let winbar = "";
  if (wp != null) {
    winbar = `<div class="winbar-wrap">
        <div class="winbar"><i style="width:${wp}%"></i></div>
        <div class="winbar-label"><span>${wp}% win</span><span>${100 - wp}%</span></div>
      </div>`;
  }
  const opt = optimalForTeam(me);
  const idx = key.replace("lg", "");
  const optChip = (opt && opt.left > 0.5)
    ? `<button class="ghost opt-chip" data-idx="${idx}">Bench left +${opt.left} pts</button>` : "";

  return `<section class="card ${winning ? "winning" : "losing"}" data-key="${key}">
      <div class="card-head">
        <span class="league-name">${esc(lg.league_name)}</span>
        <span class="head-right">
          <button class="ghost lab-btn" data-id="${esc(lg.id || "")}" data-name="${esc(lg.league_name)}">📊 Lab</button>
          <button class="ghost trade-btn" data-id="${esc(lg.id || "")}" data-name="${esc(lg.league_name)}">Trade</button>
          <button class="ghost rosters-btn" data-id="${esc(lg.id || "")}" data-name="${esc(lg.league_name)}">All rosters</button>
          <span class="prov ${lg.provider}">${lg.provider}</span>
        </span>
      </div>
      <div class="scoreline">
        ${teamSide(me, "me")}
        <div class="vs">vs</div>
        ${teamSide(opp, "opp")}
      </div>
      ${winbar}
      ${optChip ? `<div class="opt-row">${optChip}</div>` : ""}
      <div class="rosters">
        ${col(me)}
        ${col(opp)}
      </div>
    </section>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderSummary(leagues) {
  const real = leagues.filter(l => !l.error && l.my_team && l.opp_team);
  if (!real.length) { summaryEl.textContent = ""; return; }
  const winning = real.filter(l => l.my_team.score >= l.opp_team.score).length;
  const myTotal = real.reduce((a, l) => a + (l.my_team.score || 0), 0);
  summaryEl.innerHTML =
    `<b>Winning ${winning}/${real.length}</b> · ${myTotal.toFixed(1)} pts total`;
}

/* ---------- analytics: optimal lineup, rooting, watch ---------- */
let lastData = null;
function round1(x) { return Math.round(x * 10) / 10; }

const SLOT_ELIG = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF", "D/ST"],
  FLEX: ["RB", "WR", "TE"], SFLEX: ["QB", "RB", "WR", "TE"],
  WRT: ["WR", "TE"], WRRB: ["WR", "RB"], IDP: ["DL", "LB", "DB"],
};

function optimalForTeam(t) {
  if (!t || !t.players) return null;
  const slots = (t.players || []).map(p => (p.slot || p.pos || "").toUpperCase());
  const pool = [...(t.players || []), ...(t.bench || [])].filter(p => p.name && p.name !== "(empty)");
  const order = slots.map((s, i) => ({ s, i }))
    .sort((a, b) => (SLOT_ELIG[a.s] || [a.s]).length - (SLOT_ELIG[b.s] || [b.s]).length);
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
  const shouldStart = Object.values(assign).filter(p => !startNames.has(p.name));
  const shouldSit = (t.players || []).filter(p => !optNames.has(p.name) && p.name !== "(empty)");
  return { optimalPts: round1(optimalPts), actualPts: round1(actualPts),
    left: round1(optimalPts - actualPts), shouldStart, shouldSit };
}

function renderWatch(leagues) {
  const el = document.getElementById("watch");
  const rows = [];
  (leagues || []).forEach(lg => {
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
        <small>Δ${diff.toFixed(1)}${lg.win_prob != null ? " · " + lg.win_prob + "%" : ""}</small>
      </span>`).join("");
}

function computeRooting(leagues) {
  const map = new Map();
  (leagues || []).forEach(lg => {
    if (lg.error || !lg.my_team || !lg.opp_team) return;
    const add = (p, dir) => {
      if (!p.name || p.name === "(empty)") return;
      const k = p.name;
      const e = map.get(k) || { name: p.name, pos: p.pos, team: p.team, for: 0, against: 0, live: false, status: p.game_status, forL: [], againstL: [] };
      if (dir > 0) { e.for++; e.forL.push(lg.league_name); } else { e.against++; e.againstL.push(lg.league_name); }
      if (p.game_status === "in") e.live = true;
      if (p.game_status && p.game_status !== "pre") e.status = p.game_status;
      map.set(k, e);
    };
    (lg.my_team.players || []).forEach(p => add(p, 1));
    (lg.opp_team.players || []).forEach(p => add(p, -1));
  });
  const arr = [...map.values()].map(e => ({ ...e, net: e.for - e.against }));
  return {
    rootFor: arr.filter(e => e.net > 0).sort((a, b) => b.net - a.net || b.live - a.live),
    rootAgainst: arr.filter(e => e.net < 0).sort((a, b) => a.net - b.net || b.live - a.live),
    conflicted: arr.filter(e => e.for > 0 && e.against > 0),
  };
}

function rootRow(e) {
  const dot = e.status === "in" ? "in" : e.status === "post" ? "post" : "pre";
  const ctx = e.net > 0 ? e.forL.join(", ") : e.againstL.join(", ");
  return `<div class="root-row">
      <span class="gdot ${dot}"></span>${posBadge(e.pos)}
      <span class="root-name">${esc(e.name)} <small>${esc(e.team || "")}</small></span>
      <span class="root-ctx">${esc(ctx)}</span>
      <span class="root-net ${e.net > 0 ? "pos" : "neg"}">${e.net > 0 ? "+" : ""}${e.net}</span>
    </div>`;
}

function openRooting() {
  modalCard.classList.remove("full");
  modalCard.classList.add("wide");
  modalTitle.textContent = "Rooting guide · across all your leagues";
  const r = computeRooting((lastData || {}).leagues);
  const confNote = r.conflicted.length
    ? `<div class="root-conflict">⚔️ Conflicted (own in one, against in another): ${r.conflicted.map(e => esc(e.name)).join(", ")}</div>` : "";
  modalBody.innerHTML = `
    <div class="root-wrap">
      <div class="root-col"><div class="sec-label" style="background:#16a34a">ROOT FOR</div>
        ${r.rootFor.length ? r.rootFor.map(rootRow).join("") : `<div class="empty">Nothing yet.</div>`}</div>
      <div class="root-col"><div class="sec-label" style="background:#dc2626">ROOT AGAINST</div>
        ${r.rootAgainst.length ? r.rootAgainst.map(rootRow).join("") : `<div class="empty">Nothing yet.</div>`}</div>
    </div>${confNote}`;
  modal.hidden = false;
}

function openOptimal(idx) {
  const lg = (lastData.leagues || [])[idx];
  if (!lg || !lg.my_team) return;
  const o = optimalForTeam(lg.my_team);
  modalCard.classList.remove("full", "wide");
  modalTitle.textContent = `${lg.league_name} · optimal lineup`;
  const swap = o.shouldStart.map((inP, i) => {
    const outP = o.shouldSit[i];
    return `<div class="swap"><span class="swap-side">Bench ▸ ${esc(outP ? outP.name : "—")} <small>${outP ? (outP.points || 0).toFixed(1) : ""}</small></span>
        <span class="swap-arrow">↑</span>
        <span class="swap-side">Start ▸ ${esc(inP.name)} <small>${(inP.points || 0).toFixed(1)}</small></span></div>`;
  }).join("");
  modalBody.innerHTML = `
    <div class="opt-summary">
      <div><div class="opt-k">You started</div><div class="opt-v">${o.actualPts}</div></div>
      <div><div class="opt-k">Optimal</div><div class="opt-v">${o.optimalPts}</div></div>
      <div><div class="opt-k">Left on bench</div><div class="opt-v ${o.left > 0 ? "bad" : "good"}">${o.left > 0 ? "+" + o.left : "0"}</div></div>
    </div>
    ${o.left > 0.1 ? `<div class="avg-title">Should have started</div>${swap}` : `<div class="empty">You played the optimal lineup. 🎯</div>`}`;
  modal.hidden = false;
}

/* ---------- League Lab ---------- */
function moveArrow(m) {
  if (!m) return `<span class="mv flat">–</span>`;
  return m > 0 ? `<span class="mv up">▲${m}</span>` : `<span class="mv down">▼${-m}</span>`;
}
function labStandings(d) {
  const rows = d.teams.map((t, i) => {
    const po = t.playoff_pct;
    return `<tr class="${t.is_me ? "me" : ""}">
        <td>${i + 1}</td>
        <td class="lft">${esc(t.name)}${t.is_me ? " ★" : ""}</td>
        <td>${t.wins}-${t.losses}${t.ties ? "-" + t.ties : ""}</td>
        <td>${(t.pf || 0).toFixed(1)}</td>
        <td>${(t.pa || 0).toFixed(1)}</td>
        <td class="po"><div class="pobar"><i style="width:${po || 0}%"></i></div>${po == null ? "–" : po + "%"}</td>
      </tr>`;
  }).join("");
  return `<div class="tablewrap"><table class="glog labtbl">
      <thead><tr><th>#</th><th class="lft">Team</th><th>Rec</th><th>PF</th><th>PA</th><th>Playoff %</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div class="lab-note">Playoff odds simulated ${d.playoff_teams}-team field, reg. season through week ${d.playoff_start - 1}, from current records + team strength (1,500 sims).</div>`;
}
function labPower(d) {
  return d.power.map((t, i) => `<div class="lab-row ${t.is_me ? "me" : ""}">
      <span class="lab-rank">#${t.rank}</span>${moveArrow(t.movement)}
      <span class="lab-name">${esc(t.name)}${t.is_me ? " ★" : ""} <small>${esc(t.record || "")}</small></span>
      <span class="lab-val">${fmtVal(t.value_total)}</span></div>`).join("");
}
function labSos(d) {
  return `<div class="lab-note">Easiest remaining schedule first (avg. opponent roster value).</div>` +
    d.sos.map((o, i) => `<div class="lab-row ${o.is_me ? "me" : ""}">
      <span class="lab-rank">${i + 1}</span>
      <span class="lab-name">${esc(o.name)}${o.is_me ? " ★" : ""} <small>${o.games} games left</small></span>
      <span class="lab-val">${fmtVal(o.opp_value)}</span></div>`).join("");
}
function labWaivers(d) {
  if (!d.waivers.length) return `<div class="empty">No available players found.</div>`;
  return `<div class="lab-note">Best available (unrostered), by trade value. 🔥 = trending add on Sleeper.</div>` +
    d.waivers.map(w => `<div class="lab-row">
      ${posBadge(w.pos)}<span class="lab-name">${esc(w.name)} <small>${esc(w.team || "FA")}</small> ${w.hot ? "🔥" : ""}</span>
      <span class="lab-val">${fmtVal(w.value)} ${trendArrow(w.trend)}</span></div>`).join("");
}
function labBuySell(d) {
  const col = (arr, cls) => arr.length ? arr.map(p => `<div class="lab-row">
      ${posBadge(p.pos)}<span class="lab-name">${esc(p.name)} <small>${esc(p.owner)}</small></span>
      <span class="lab-val">${fmtVal(p.value)} ${trendArrow(p.trend)}</span></div>`).join("") : `<div class="empty">–</div>`;
  return `<div class="root-wrap">
      <div class="root-col"><div class="sec-label" style="background:#dc2626">SELL HIGH · rising 30d</div>${col(d.buysell.sell)}</div>
      <div class="root-col"><div class="sec-label" style="background:#16a34a">BUY LOW · falling 30d</div>${col(d.buysell.buy)}</div>
    </div>`;
}
function labVegas(d) {
  const list = arr => arr.length ? arr.map(p => `<div class="lab-row">
      ${posBadge(p.pos)}<span class="lab-name">${esc(p.name)} <small>${esc(p.owner)}</small></span>
      <span class="ve-nums">proj ${p.proj} · vegas ${p.vegas_fp} <b class="${p.edge >= 0 ? "pos" : "neg"}">${p.edge >= 0 ? "+" : ""}${p.edge}</b></span></div>`).join("") : `<div class="empty">–</div>`;
  return `<div class="lab-note">Vegas-implied fantasy points vs. projection (edge). Positive = Vegas likes them more than the projection.</div>
    <div class="root-wrap">
      <div class="root-col"><div class="sec-label" style="background:#16a34a">VEGAS OVER PROJECTION</div>${list(d.vegas_edge.over)}</div>
      <div class="root-col"><div class="sec-label" style="background:#dc2626">VEGAS UNDER PROJECTION</div>${list(d.vegas_edge.under)}</div>
    </div>`;
}
function labRecap(d) {
  const r = d.recap;
  if (!r) return `<div class="empty">No games scored yet this week — check back once games kick off.</div>`;
  const gm = g => g ? `${esc(g.a)} ${g.as} — ${g.bs} ${esc(g.b)} <small>(by ${g.margin})</small>` : "–";
  return `<div class="recap">
      <div class="recap-card"><div class="opt-k">Top score</div><div class="recap-v">${esc(r.top.name)} · ${r.top.score}</div></div>
      <div class="recap-card"><div class="opt-k">Low score</div><div class="recap-v">${esc(r.low.name)} · ${r.low.score}</div></div>
      <div class="recap-card"><div class="opt-k">Biggest blowout</div><div class="recap-v">${gm(r.blowout)}</div></div>
      <div class="recap-card"><div class="opt-k">Closest game</div><div class="recap-v">${gm(r.closest)}</div></div>
    </div>`;
}
function labByes(d) {
  if (!d.byes || !d.byes.length) return `<div class="empty">No upcoming byes on your roster. 🎉</div>`;
  return `<div class="lab-note">Your players' upcoming NFL bye weeks — weeks with 3+ are flagged.</div>` +
    d.byes.map(b => `<div class="bye-week ${b.players.length >= 3 ? "warn" : ""}">
        <div class="bye-h">Week ${b.week} <span>${b.players.length} player${b.players.length > 1 ? "s" : ""}${b.players.length >= 3 ? " ⚠️" : ""}</span></div>
        <div class="bye-players">${b.players.map(p => `<span class="bye-p">${posBadge(p.pos)}${esc(p.name)}${p.starter ? "" : " <small>(bench)</small>"}</span>`).join("")}</div>
      </div>`).join("");
}
const LAB_TABS = [["standings", "Standings & Odds", labStandings], ["power", "Power Rankings", labPower],
  ["sos", "Schedule", labSos], ["byes", "Byes", labByes], ["waivers", "Waivers", labWaivers],
  ["buysell", "Buy / Sell", labBuySell], ["vegas", "Vegas Edge", labVegas], ["recap", "Recap", labRecap]];

async function openLab(id, name) {
  if (!id) return;
  modalCard.classList.remove("wide");
  modalCard.classList.add("full");
  modalTitle.textContent = `${name || "League"} · Lab`;
  modalBody.innerHTML = `<div class="loading">Crunching numbers…</div>`;
  modal.hidden = false;
  try {
    const r = await fetch("/api/league?id=" + encodeURIComponent(id), { cache: "no-store" });
    const d = await r.json();
    if (d.error) { modalBody.innerHTML = `<div class="err-msg">${esc(d.error)}</div>`; return; }
    modalBody.innerHTML = `<div class="ptabs">${LAB_TABS.map((t, i) =>
      `<button class="ptab ${i === 0 ? "active" : ""}" data-tab="${t[0]}">${t[1]}</button>`).join("")}</div>
      <div id="labHost" class="lab-host"></div>`;
    const host = modalBody.querySelector("#labHost");
    const show = key => { const t = LAB_TABS.find(x => x[0] === key); host.innerHTML = t[2](d); };
    modalBody.querySelectorAll(".ptab").forEach(b => b.addEventListener("click", () => {
      modalBody.querySelectorAll(".ptab").forEach(x => x.classList.toggle("active", x === b));
      show(b.dataset.tab);
    }));
    show("standings");
  } catch (e) {
    modalBody.innerHTML = `<div class="err-msg">Could not load Lab (${esc(e)})</div>`;
  }
}

async function load() {
  try {
    const r = await fetch("/api/dashboard", { cache: "no-store" });
    const data = await r.json();
    if (data.error) { showBanner(data.error); return; }
    banner.hidden = true;
    lastData = data;

    weekLabel.textContent = `${data.season} · Week ${data.week}`;
    const anyLive = (data.leagues || []).some(l =>
      [...(l.my_team?.players || []), ...(l.opp_team?.players || [])]
        .some(p => p.game_status === "in"));
    pulse.style.visibility = anyLive ? "visible" : "hidden";

    grid.innerHTML = (data.leagues || []).map((lg, i) => cardHTML(lg, "lg" + i)).join("")
      || `<div class="card err">No leagues configured.</div>`;
    renderSummary(data.leagues || []);
    renderWatch(data.leagues || []);

    (data.leagues || []).forEach((lg, i) => {
      const key = "lg" + i;
      const card = grid.querySelector(`[data-key="${key}"]`);
      if (!card || lg.error) return;
      const scores = card.querySelectorAll("[data-score]");
      const prev = prevScores[key];
      if (prev) {
        if (lg.my_team && lg.my_team.score > prev.me) scores[0]?.classList.add("bump");
        if (lg.opp_team && lg.opp_team.score > prev.opp) scores[1]?.classList.add("bump");
      }
      prevScores[key] = { me: lg.my_team?.score ?? 0, opp: lg.opp_team?.score ?? 0 };
    });

    updatedEl.textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    showBanner("Could not reach the local server. Is it still running? (" + e + ")");
  }
}

function showBanner(msg) {
  banner.textContent = msg;
  banner.hidden = false;
  if (!grid.children.length) grid.innerHTML = "";
}

/* ---------- all-rosters modal ---------- */
const modal = document.getElementById("modal");
const modalBody = document.getElementById("modalBody");
const modalTitle = document.getElementById("modalTitle");
const modalCard = modal.querySelector(".modal-card");

function posLabel(p) { p = (p || "").toUpperCase(); return p === "D/ST" ? "DEF" : p; }
function abbrevName(n) {
  if (!n || /D\/ST/i.test(n)) return n || "—";
  const p = n.trim().split(/\s+/);
  return p.length < 2 ? n : `${p[0][0]}. ${p.slice(1).join(" ")}`;
}
function fmtVal(v) {
  if (v == null) return "";
  return v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v);
}
function trendArrow(t) {
  if (t == null || t === 0) return "";
  const up = t > 0;
  return `<span class="trend ${up ? "up" : "down"}">${up ? "▲" : "▼"}${Math.abs(t)}</span>`;
}
function posRankStr(p) {
  return p.pos_rank != null ? `${posLabel(p.pos)}${p.pos_rank}` : "";
}
function rosterCell(pl) {
  const pos = pl.slot || pl.pos || "";
  const data = `data-espn="${esc(pl.espn_id || "")}" data-sleeper="${esc(pl.sleeper_id || "")}" `
    + `data-team="${esc(pl.team || "")}" data-pos="${esc(pl.pos || "")}" data-name="${esc(pl.name || "")}"`;
  const click = (pl.espn_id || pl.sleeper_id) ? "clickable" : "";
  const val = pl.value != null ? `<span class="rcell-val">${fmtVal(pl.value)}</span>` : "";
  const sub = (pl.pos_rank != null || pl.trend) ? `<div class="rcell-sub2">${posRankStr(pl)} ${trendArrow(pl.trend)}</div>` : "";
  return `<div class="rcell ${posClass(pos)} ${click}" ${data}>
      <div class="rcell-top"><span>${esc(posLabel(pos))} · ${esc(pl.team || "FA")}</span>${val}</div>
      <div class="rcell-name">${esc(abbrevName(pl.name))}</div>
      ${sub}
    </div>`;
}
function rosterColumn(t) {
  const proj = t.projected != null ? ` · ${t.projected.toFixed(1)} proj` : "";
  const strength = t.value_total ? `<div class="rcol-str">#${t.strength_rank} strength · ${fmtVal(t.value_total)}</div>` : "";
  return `<div class="rteam-col ${t.is_me ? "me" : ""}">
      <div class="rcol-head">
        <div class="rcol-name">${esc(t.name)}${t.is_me ? " ★" : ""}</div>
        <div class="rcol-sub">${esc(t.record || "")}${proj}</div>
        ${strength}
      </div>
      <div class="rcol-body">
        ${(t.players || []).map(rosterCell).join("")}
        ${(t.bench && t.bench.length) ? `<div class="rcol-bench">BENCH</div>` + t.bench.map(rosterCell).join("") : ""}
      </div>
    </div>`;
}

async function openRosters(id, name) {
  if (!id) return;
  modalCard.classList.remove("wide");
  modalCard.classList.add("full");
  modalTitle.textContent = name || "League rosters";
  modalBody.innerHTML = `<div class="loading">Loading rosters…</div>`;
  modal.hidden = false;
  try {
    const r = await fetch("/api/rosters?id=" + encodeURIComponent(id), { cache: "no-store" });
    const data = await r.json();
    if (data.error) { modalBody.innerHTML = `<div class="err-msg">${esc(data.error)}</div>`; return; }
    modalTitle.textContent = `${data.league_name} · all rosters (Wk ${data.week})`;
    modalBody.innerHTML = `<div class="rgrid">${(data.teams || []).map(rosterColumn).join("")}</div>`;
  } catch (e) {
    modalBody.innerHTML = `<div class="err-msg">Could not load rosters (${esc(e)})</div>`;
  }
}
function closeModal() { modal.hidden = true; modalBody.innerHTML = ""; modalCard.classList.remove("full", "wide"); }

/* ---------- trade window ---------- */
let T = null;   // { teams, aIdx, bIdx, selA:Set, selB:Set }

function pkey(p) { return p.sleeper_id || p.espn_id || p.name; }
function allOf(t) { return [...(t.players || []), ...(t.bench || [])]; }
function sumVal(list) { return list.reduce((a, p) => a + (p.value || 0), 0); }
function selectedPlayers(side) {
  const t = T.teams[side === "a" ? T.aIdx : T.bIdx];
  const set = side === "a" ? T.selA : T.selB;
  return allOf(t).filter(p => set.has(pkey(p)));
}

async function openTrade(id, name) {
  if (!id) return;
  modalCard.classList.remove("wide");
  modalCard.classList.add("full");
  modalTitle.textContent = (name || "Trade") + " · trade machine";
  modalBody.innerHTML = `<div class="loading">Loading rosters…</div>`;
  modal.hidden = false;
  try {
    const r = await fetch("/api/rosters?id=" + encodeURIComponent(id), { cache: "no-store" });
    const data = await r.json();
    if (data.error) { modalBody.innerHTML = `<div class="err-msg">${esc(data.error)}</div>`; return; }
    const teams = data.teams || [];
    let aIdx = teams.findIndex(t => t.is_me); if (aIdx < 0) aIdx = 0;
    let bIdx = teams.findIndex((t, i) => i !== aIdx); if (bIdx < 0) bIdx = 0;
    const block = new Set(store.get("block:" + id, []));
    T = { teams, aIdx, bIdx, leagueId: id, selA: new Set(), selB: new Set(),
      fairness: 0.12, needOnly: false, startersOnly: false, want: new Set(), block };
    renderTrade();
  } catch (e) {
    modalBody.innerHTML = `<div class="err-msg">Could not load trade (${esc(e)})</div>`;
  }
}

function tradeSideList(side) {
  const t = T.teams[side === "a" ? T.aIdx : T.bIdx];
  const set = side === "a" ? T.selA : T.selB;
  const rows = allOf(t).map(p => {
    const key = pkey(p);
    const val = p.value != null
      ? `<span class="tl-val">${fmtVal(p.value)}</span><span class="tl-rank">${posRankStr(p)}</span>`
      : `<span class="tl-val dim">—</span>`;
    const blockStar = t.is_me
      ? `<span class="tl-block ${T.block.has(String(key)) ? "on" : ""}" data-key="${esc(String(key))}" title="Trade block">★</span>` : "";
    return `<label class="tl-row ${set.has(key) ? "on" : ""}">
        <input type="checkbox" data-side="${side}" data-key="${esc(String(key))}" ${set.has(key) ? "checked" : ""}>
        ${posBadge(p.slot || p.pos)}<span class="tl-name">${esc(p.name)}</span>${val}${trendArrow(p.trend)}${blockStar}
      </label>`;
  }).join("");
  return `<div class="trade-list">${rows}</div>`;
}

function renderTrade() {
  const opt = sel => T.teams.map((t, i) =>
    `<option value="${i}" ${i === sel ? "selected" : ""}>${esc(t.name)}${t.is_me ? " (you)" : ""}</option>`).join("");
  modalBody.innerHTML = `
    <div class="trade">
      <div class="trade-cols">
        <div class="trade-side">
          <select class="teamsel" data-side="a">${opt(T.aIdx)}</select>
          ${tradeSideList("a")}
        </div>
        <div class="trade-swap">⇄</div>
        <div class="trade-side">
          <select class="teamsel" data-side="b">${opt(T.bIdx)}</select>
          ${tradeSideList("b")}
        </div>
      </div>
      <div class="trade-foot" id="tradeFoot"></div>
      <div class="trade-finder">
        <div class="finder-ctrls">
          <label class="fair-ctrl">Fairness band ±<b id="fairPct">${Math.round(T.fairness * 100)}</b>%
            <input type="range" id="fairSlider" min="2" max="30" value="${Math.round(T.fairness * 100)}"></label>
          <label class="need-ctrl"><input type="checkbox" id="needOnly" ${T.needOnly ? "checked" : ""}> Only swaps that fill my needs</label>
          <label class="need-ctrl"><input type="checkbox" id="startersOnly" ${T.startersOnly ? "checked" : ""}> Measure need by starters only</label>
          <button id="findBtn" class="ghost">💡 Suggest swaps</button>
          <button id="blockBtn" class="ghost">🎯 Trades for my ★ block</button>
        </div>
        <div class="want-row">
          <span class="want-lbl">I want to acquire:</span>
          ${NEED_POS.map(p => `<button class="want-pill ${posClass(p)} ${T.want.has(p) ? "on" : ""}" data-pos="${p}">${p}</button>`).join("")}
        </div>
        <div id="needChips"></div>
        <div id="findOut"></div>
      </div>
    </div>`;

  modalBody.querySelectorAll(".teamsel").forEach(s => s.addEventListener("change", () => {
    const side = s.dataset.side, idx = parseInt(s.value, 10);
    if (side === "a") { T.aIdx = idx; T.selA = new Set(); } else { T.bIdx = idx; T.selB = new Set(); }
    renderTrade();
  }));
  modalBody.querySelectorAll(".trade-list input").forEach(cb => cb.addEventListener("change", () => {
    const set = cb.dataset.side === "a" ? T.selA : T.selB;
    if (cb.checked) set.add(cb.dataset.key); else set.delete(cb.dataset.key);
    cb.closest(".tl-row").classList.toggle("on", cb.checked);
    updateTradeFoot();
  }));
  const slider = modalBody.querySelector("#fairSlider");
  slider.addEventListener("input", () => {
    T.fairness = parseInt(slider.value, 10) / 100;
    modalBody.querySelector("#fairPct").textContent = slider.value;
    if (modalBody.querySelector("#findOut").children.length) renderSwaps();
  });
  modalBody.querySelector("#needOnly").addEventListener("change", e => {
    T.needOnly = e.target.checked;
    if (modalBody.querySelector("#findOut").children.length) renderSwaps();
  });
  modalBody.querySelector("#startersOnly").addEventListener("change", e => {
    T.startersOnly = e.target.checked;
    renderNeedChips();
    if (modalBody.querySelector("#findOut").children.length) renderSwaps();
  });
  modalBody.querySelectorAll(".want-pill").forEach(pill => pill.addEventListener("click", () => {
    const p = pill.dataset.pos;
    if (T.want.has(p)) T.want.delete(p); else T.want.add(p);
    pill.classList.toggle("on", T.want.has(p));
    if (modalBody.querySelector("#findOut").children.length) renderSwaps();
  }));
  modalBody.querySelector("#findBtn").addEventListener("click", renderSwaps);
  modalBody.querySelector("#blockBtn").addEventListener("click", renderBlockTrades);
  modalBody.querySelectorAll(".tl-block").forEach(star => star.addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation();
    const k = star.dataset.key;
    if (T.block.has(k)) T.block.delete(k); else T.block.add(k);
    star.classList.toggle("on", T.block.has(k));
    store.set("block:" + T.leagueId, [...T.block]);
  }));
  renderNeedChips();
  updateTradeFoot();
}

function renderBlockTrades() {
  const me = T.teams.find(t => t.is_me) || T.teams[T.aIdx];
  const meIdx = T.teams.indexOf(me);
  const blockPlayers = allOf(me).filter(p => T.block.has(String(pkey(p))) && p.value);
  const host = modalBody.querySelector("#findOut");
  if (!blockPlayers.length) {
    host.innerHTML = `<div class="empty">Star (★) players on your team to put them on the block, then tap this again.</div>`;
    return;
  }
  const need = positionNeeds(meIdx);
  const band = T.fairness || 0.12;
  const gives = blockPlayers.map(p => [p]);
  for (let i = 0; i < blockPlayers.length; i++)
    for (let j = i + 1; j < blockPlayers.length; j++) gives.push([blockPlayers[i], blockPlayers[j]]);
  const out = [];
  T.teams.forEach((B, bi) => {
    if (bi === meIdx) return;
    const Bp = allOf(B).filter(p => p.value);
    const consider = (give, get) => {
      const g = sumVal(give), h = sumVal(get), diff = Math.abs(g - h), den = Math.max(g, h) || 1;
      if (diff / den > band) return;
      if (T.want.size) {
        const gp = new Set(get.map(p => p.pos));
        let ok = false; T.want.forEach(p => { if (gp.has(p)) ok = true; });
        if (!ok) return;
      }
      const pd = posDeltaByPos(give, get);
      const fills = NEED_POS.filter(p => need[p] > 0 && (pd[p] || 0) > 0);
      if (T.needOnly && !fills.length) return;
      out.push({ team: B.name, give, get, net: h - g, diff, fills });
    };
    gives.forEach(give => {
      Bp.forEach(b => consider(give, [b]));
      for (let i = 0; i < Bp.length; i++) for (let j = i + 1; j < Bp.length; j++) consider(give, [Bp[i], Bp[j]]);
    });
  });
  out.sort((x, y) => (y.fills.length - x.fills.length) || (x.diff - y.diff));
  const top = out.slice(0, 14);
  if (!top.length) { host.innerHTML = `<div class="empty">No fair offers for your block within ±${Math.round(band * 100)}%. Loosen the band or adjust filters.</div>`; return; }
  host.innerHTML = `<div class="lab-note">Best offers around the league for your ★ block players.</div>` +
    top.map(s => `<div class="swap block-swap">
        <span class="swap-team">${esc(s.team)}</span>
        <span class="swap-side">give ${s.give.map(p => esc(p.name)).join(" + ")} <small>${fmtVal(sumVal(s.give))}</small></span>
        <span class="swap-arrow">⇄</span>
        <span class="swap-side">get ${s.get.map(p => esc(p.name)).join(" + ")} <small>${fmtVal(sumVal(s.get))}</small></span>
        <span class="swap-tags">${s.fills.map(p => `<span class="fill-tag ${posClass(p)}">fills ${p}</span>`).join("")}</span>
        <span class="swap-delta ${Math.abs(s.net) <= Math.max(sumVal(s.give), sumVal(s.get)) * 0.05 ? "fair" : ""}">${s.net >= 0 ? "+" : "−"}${fmtVal(Math.abs(s.net))}</span>
      </div>`).join("");
}

const NEED_POS = ["QB", "RB", "WR", "TE"];

// pool of players used to measure need: starters only, or the whole roster
function needPool(t) { return T.startersOnly ? (t.players || []) : allOf(t); }

function positionNeeds(teamIdx) {
  const n = T.teams.length || 1;
  const leagueTot = {}, mine = {};
  NEED_POS.forEach(p => { leagueTot[p] = 0; mine[p] = 0; });
  T.teams.forEach(t => needPool(t).forEach(pl => {
    if (pl.value && NEED_POS.includes(pl.pos)) leagueTot[pl.pos] += pl.value;
  }));
  needPool(T.teams[teamIdx]).forEach(pl => {
    if (pl.value && NEED_POS.includes(pl.pos)) mine[pl.pos] += pl.value;
  });
  const need = {};
  NEED_POS.forEach(p => { need[p] = (leagueTot[p] / n) - mine[p]; }); // >0 => below avg
  return need;
}

function renderNeedChips() {
  const need = positionNeeds(T.aIdx);
  const weak = NEED_POS.filter(p => need[p] > 0).sort((a, b) => need[b] - need[a]);
  const host = modalBody.querySelector("#needChips");
  if (!host) return;
  const mode = T.startersOnly ? " (starters)" : "";
  host.innerHTML = weak.length
    ? `<span class="need-lbl">${esc(T.teams[T.aIdx].name)} thin at${mode}:</span> `
      + weak.map(p => `<span class="need-chip ${posClass(p)}">${p}</span>`).join("")
    : `<span class="need-lbl">${esc(T.teams[T.aIdx].name)}'s roster is balanced across positions${mode}.</span>`;
}

function verdict(net, av, bv) {
  const thr = Math.max(av, bv) * 0.05;
  if (Math.abs(net) <= thr || (!av && !bv)) return { cls: "fair", label: "Fair trade" };
  return net > 0
    ? { cls: "good", label: `${T.teams[T.aIdx].name} wins +${fmtVal(Math.abs(net))}` }
    : { cls: "bad", label: `${T.teams[T.bIdx].name} wins +${fmtVal(Math.abs(net))}` };
}

function updateTradeFoot() {
  const A = selectedPlayers("a"), B = selectedPlayers("b");
  const av = sumVal(A), bv = sumVal(B), net = bv - av;
  const foot = modalBody.querySelector("#tradeFoot");
  if (!A.length && !B.length) {
    foot.innerHTML = `<div class="tf-empty">Select players from each side to weigh the trade.</div>`;
    return;
  }
  const v = verdict(net, av, bv);
  const names = list => list.length ? list.map(p => esc(p.name)).join(", ") : "—";
  foot.innerHTML = `
    <div class="tf-grid">
      <div class="tf-team"><div class="tf-label">${esc(T.teams[T.aIdx].name)} sends</div>
        <div class="tf-players">${names(A)}</div><div class="tf-sum">${fmtVal(av)}</div></div>
      <div class="tf-mid"><div class="tf-verdict ${v.cls}">${v.label}</div>
        <div class="tf-delta">net ${net >= 0 ? "+" : "−"}${fmtVal(Math.abs(net))} to ${esc(T.teams[T.aIdx].name)}</div></div>
      <div class="tf-team"><div class="tf-label">${esc(T.teams[T.bIdx].name)} sends</div>
        <div class="tf-players">${names(B)}</div><div class="tf-sum">${fmtVal(bv)}</div></div>
    </div>`;
}

function posDeltaByPos(give, get) {
  const d = {};
  give.forEach(p => { if (NEED_POS.includes(p.pos)) d[p.pos] = (d[p.pos] || 0) - (p.value || 0); });
  get.forEach(p => { if (NEED_POS.includes(p.pos)) d[p.pos] = (d[p.pos] || 0) + (p.value || 0); });
  return d;
}

function renderSwaps() {
  const A = allOf(T.teams[T.aIdx]).filter(p => p.value);
  const B = allOf(T.teams[T.bIdx]).filter(p => p.value);
  const need = positionNeeds(T.aIdx);
  const band = T.fairness || 0.12;
  const out = [];
  const consider = (give, get) => {
    const g = sumVal(give), h = sumVal(get), diff = Math.abs(g - h), den = Math.max(g, h) || 1;
    if (diff / den > band) return;
    // target positions: the incoming players must include a wanted position
    if (T.want.size) {
      const getPos = new Set(get.map(p => p.pos));
      let ok = false;
      T.want.forEach(p => { if (getPos.has(p)) ok = true; });
      if (!ok) return;
    }
    // which need positions does this swap improve (for team A)?
    const pd = posDeltaByPos(give, get);
    const fills = NEED_POS.filter(p => need[p] > 0 && (pd[p] || 0) > 0);
    if (T.needOnly && !fills.length) return;
    out.push({ give, get, net: h - g, diff, fills });
  };
  A.forEach(a => B.forEach(b => consider([a], [b])));
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) B.forEach(b => consider([A[i], A[j]], [b]));
  A.forEach(a => { for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) consider([a], [B[i], B[j]]); });
  // prefer need-filling, then fairest
  out.sort((x, y) => (y.fills.length - x.fills.length) || (x.diff - y.diff));
  const top = out.slice(0, 12);
  const host = modalBody.querySelector("#findOut");
  if (!top.length) {
    const want = T.want.size ? [...T.want].join("/") + " " : "";
    host.innerHTML = `<div class="empty">No ${want}${T.needOnly ? "need-filling " : ""}swaps within ±${Math.round(band * 100)}%. Loosen the band${T.want.size ? ", pick other target positions," : ""}${T.needOnly ? " or turn off the needs filter" : ""}.</div>`;
    return;
  }
  host.innerHTML = top.map((s, i) => {
    const fair = Math.abs(s.net) <= Math.max(sumVal(s.give), sumVal(s.get)) * 0.05;
    const tags = s.fills.map(p => `<span class="fill-tag ${posClass(p)}">fills ${p}</span>`).join("");
    return `<div class="swap" data-i="${i}">
      <span class="swap-side">you give: ${s.give.map(p => esc(p.name)).join(" + ")} <small>${fmtVal(sumVal(s.give))}</small></span>
      <span class="swap-arrow">⇄</span>
      <span class="swap-side">you get: ${s.get.map(p => esc(p.name)).join(" + ")} <small>${fmtVal(sumVal(s.get))}</small></span>
      <span class="swap-tags">${tags}</span>
      <span class="swap-delta ${fair ? "fair" : ""}">${s.net >= 0 ? "+" : "−"}${fmtVal(Math.abs(s.net))}</span>
    </div>`;
  }).join("");
  host.querySelectorAll(".swap").forEach(el => el.addEventListener("click", () => {
    const s = top[parseInt(el.dataset.i, 10)];
    T.selA = new Set(s.give.map(pkey));
    T.selB = new Set(s.get.map(pkey));
    renderTrade();
    modalBody.querySelector("#findBtn").click();
  }));
}

/* ---------- player profile modal ---------- */
let curPlayer = null;

function fmtDate(v) {
  if (v == null || v === "") return "";
  let d;
  if (typeof v === "number" || /^\d+$/.test(String(v))) d = new Date(Number(v));
  else d = new Date(v);
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function srcLabel(s) {
  const m = { fantasy_pros: "FantasyPros", rotowire: "RotoWire", Rotowire: "RotoWire" };
  return m[s] || s || "";
}

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? null : n;
}
function gradeColor(v, s) {
  if (s.mx === s.mn) return "hsla(62,42%,45%,.30)";
  let f = (v - s.mn) / (s.mx - s.mn);
  if (s.dir === "low") f = 1 - f;
  const hue = 5 + f * 115;               // red -> olive -> green
  return `hsla(${hue.toFixed(0)},45%,45%,.45)`;
}

function gamelogTable(gl) {
  if (!gl || !gl.rows || !gl.rows.length)
    return `<div class="empty">No games logged for this season yet.</div>`;
  const cols = gl.columns || [], rows = gl.rows;

  // per-column min/max for color grading
  const scale = cols.map((c, ci) => {
    let mn = Infinity, mx = -Infinity, any = false;
    rows.forEach(r => {
      const v = num(r.values[ci]);
      if (v != null) { any = true; if (v < mn) mn = v; if (v > mx) mx = v; }
    });
    return any ? { mn, mx, dir: c.dir } : null;
  });

  // grouped header row (leading 3 game columns span blank)
  let gh = `<th class="lead" colspan="3"></th>`;
  for (let i = 0; i < cols.length;) {
    let j = i; while (j + 1 < cols.length && cols[j + 1].group === cols[i].group) j++;
    gh += `<th class="grp grp-${esc(cols[i].group)}" colspan="${j - i + 1}">${esc(cols[i].group)}</th>`;
    i = j + 1;
  }
  const colHead = `<th>Wk</th><th class="lft">Opp</th><th>Res</th>`
    + cols.map(c => `<th class="${c.name === "fpts" ? "fpts" : ""}">${esc(c.label)}</th>`).join("");

  const body = rows.map(r => {
    const opp = `${r.atVs || ""} ${r.opp || ""}`.trim();
    const res = r.result ? `<span class="res res-${esc(r.result)}">${esc(r.result)}</span>` : "";
    const cells = cols.map((c, ci) => {
      const raw = r.values[ci], v = num(raw);
      const bg = (scale[ci] && v != null) ? gradeColor(v, scale[ci]) : "";
      const disp = (raw === "" || raw == null) ? "–"
        : (c.name === "fpts" ? Number(raw).toFixed(1) : esc(raw));
      return `<td class="${c.name === "fpts" ? "fpts" : ""}" ${bg ? `style="background:${bg}"` : ""}>${disp}</td>`;
    }).join("");
    return `<tr><td class="wk">${r.playoff ? "P" : ""}${r.week ?? ""}</td>
        <td class="lft opp">${r.opp_logo ? `<img src="${esc(r.opp_logo)}" alt="">` : ""}${esc(opp || "—")}</td>
        <td>${res}</td>${cells}</tr>`;
  }).join("");

  // season averages (per game) -- regular season only
  const regRows = rows.filter(r => !r.playoff);
  const base = regRows.length ? regRows : rows;
  const avg = cols.map((c, ci) => {
    let s = 0, n = 0;
    base.forEach(r => { const v = num(r.values[ci]); if (v != null) { s += v; n++; } });
    return n ? (s / n) : null;
  });
  const avgCells = cols.map((c, ci) => {
    const a = avg[ci];
    const bg = (scale[ci] && a != null) ? gradeColor(a, scale[ci]) : "";
    return `<td class="${c.name === "fpts" ? "fpts" : ""}" ${bg ? `style="background:${bg}"` : ""}>${a == null ? "–" : a.toFixed(1)}</td>`;
  }).join("");
  const avgTable = `<div class="avg-title">Season averages · per game (${base.length} G, regular season)</div>
    <div class="tablewrap"><table class="glog avg">
      <thead><tr>${colHead}</tr></thead>
      <tbody><tr><td class="wk"></td><td class="lft">AVG</td><td></td>${avgCells}</tr></tbody>
    </table></div>`;

  return `<div class="tablewrap"><table class="glog">
      <thead><tr class="ghead">${gh}</tr><tr>${colHead}</tr></thead>
      <tbody>${body}</tbody></table></div>${avgTable}`;
}

function newsList(items) {
  if (!items || !items.length) return `<div class="empty">No recent items.</div>`;
  return items.map(n => {
    const showBody = n.body && n.body !== n.headline && !(n.headline || "").includes(n.body);
    const longBody = showBody && n.body.length > 220;
    return `<div class="news-item">
        <div class="news-h">${esc(n.headline || "")}</div>
        ${showBody ? `<div class="news-b">${esc(n.body)}</div>` : ""}
        ${longBody ? `<span class="news-more">Show more</span>` : ""}
        <div class="news-m">${esc(srcLabel(n.source))}${n.published ? " · " + fmtDate(n.published) : ""}</div>
      </div>`;
  }).join("");
}

function outlookBlock(o) {
  if (!o) return "";
  const text = o.body || o.headline;
  if (!text) return "";
  return `<div class="outlook">
      <div class="sec-label sleeper">SLEEPER · SEASON OUTLOOK</div>
      <div class="news-b">${esc(text)}</div>
    </div>`;
}

function depthChart(dp) {
  if (!dp || !dp.positions || !dp.positions.length)
    return `<div class="empty">No depth chart available.</div>`;
  return `<div class="depth">${dp.positions.map(pos => `
      <div class="depth-col">
        <div class="depth-h">${posBadge(pos.pos)}</div>
        ${pos.players.slice(0, 6).map((pl, i) => `
          <div class="depth-p ${pl.is_this ? "me" : ""}">
            <span class="depth-rank">${i + 1}</span><span class="depth-name">${esc(pl.name)}</span>
          </div>`).join("")}
      </div>`).join("")}</div>`;
}

function renderPlayer(p) {
  curPlayer = p;
  const gl = p.gamelog || {};
  const seasonSel = (p.seasons && p.seasons.length)
    ? `<select id="glseason">${p.seasons.map(s => `<option ${String(s) === String(gl.season) ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>`
    : "";
  const head = `<div class="pp-head">
      ${p.headshot ? `<img class="pp-shot" src="${esc(p.headshot)}" alt="" onerror="this.style.display='none'">` : ""}
      <div><div class="pp-name">${esc(p.name)}</div>
      <div class="pp-sub">${posBadge(p.pos)} ${esc(p.team || "")}
        ${p.value != null ? `<span class="pp-val">${fmtVal(p.value)} · ${posRankStr(p)} ${trendArrow(p.trend)}</span>` : ""}
      </div></div>
    </div>`;
  const tabs = `<div class="ptabs">
      <button class="ptab active" data-panel="log">Game Log</button>
      <button class="ptab" data-panel="news">News &amp; Outlook</button>
      <button class="ptab" data-panel="depth">Depth Chart</button>
      <button class="ptab" data-panel="odds">Vegas</button>
    </div>`;
  const logPanel = `<div class="ppanel" data-panel="log">
      <div class="panel-bar">Season ${seasonSel}</div>
      <div id="glhost">${gamelogTable(gl)}</div>
    </div>`;
  const newsPanel = `<div class="ppanel" data-panel="news" hidden>
      <div class="sec-label espn">ESPN</div>${newsList(p.news.espn)}
      <div class="sec-label sleeper">SLEEPER</div>${newsList(p.news.sleeper)}
      ${outlookBlock(p.outlook && p.outlook.sleeper)}
    </div>`;
  const depthPanel = `<div class="ppanel" data-panel="depth" hidden>
      <div class="panel-bar">${esc(p.team || "")} depth chart</div>
      ${depthChart(p.depth)}
    </div>`;
  const oddsPanel = `<div class="ppanel" data-panel="odds" hidden>
      <div id="oddsHost"><div class="loading">Loading odds…</div></div>
    </div>`;

  modalTitle.textContent = p.name;
  modalBody.innerHTML = head + tabs + logPanel + newsPanel + depthPanel + oddsPanel;

  modalBody.querySelectorAll(".ptab").forEach(btn => {
    btn.addEventListener("click", () => {
      modalBody.querySelectorAll(".ptab").forEach(b => b.classList.toggle("active", b === btn));
      modalBody.querySelectorAll(".ppanel").forEach(pan =>
        pan.hidden = pan.dataset.panel !== btn.dataset.panel);
      if (btn.dataset.panel === "odds") {
        const host = modalBody.querySelector("#oddsHost");
        if (host && !host.dataset.loaded) { host.dataset.loaded = "1"; loadOdds(p); }
      }
    });
  });
  modalBody.querySelectorAll(".news-more").forEach(link => {
    link.addEventListener("click", () => {
      const item = link.closest(".news-item");
      const open = item.classList.toggle("open");
      link.textContent = open ? "Show less" : "Show more";
    });
  });
  const sel = modalBody.querySelector("#glseason");
  if (sel) sel.addEventListener("change", async () => {
    const host = modalBody.querySelector("#glhost");
    host.innerHTML = `<div class="loading">Loading ${sel.value}…</div>`;
    try {
      const r = await fetch(`/api/player/gamelog?espn_id=${encodeURIComponent(p.espn_id || "")}&season=${sel.value}`, { cache: "no-store" });
      host.innerHTML = gamelogTable(await r.json());
    } catch (e) { host.innerHTML = `<div class="err-msg">Could not load ${sel.value}</div>`; }
  });
}

function renderOdds(o) {
  const host = modalBody.querySelector("#oddsHost");
  if (!host) return;
  if (!o || !o.found) {
    host.innerHTML = `<div class="empty">No DraftKings props posted${o && o.name ? " for " + esc(o.name) : ""} — player lines usually go up during game week.</div>`;
    return;
  }
  const td = o.td ? `<div class="odds-td"><span>Anytime TD</span><b>${esc(o.td)}</b></div>` : "";
  const mk = (o.markets || []).map(m => `
      <div class="odds-mkt">
        <div class="odds-h">${esc(m.stat)}${m.line != null ? `<span class="odds-line">O/U ≈ ${m.line}</span>` : ""}</div>
        <div class="odds-ladder">${m.ladder.map(x => `<span class="rung"><b>${x.v}+</b> ${esc(x.odds)}</span>`).join("")}</div>
      </div>`).join("");
  host.innerHTML = `<div class="odds-book">DraftKings · props update through game week</div>${td}${mk || `<div class="empty">No yardage props for this player.</div>`}`;
}

async function loadOdds(p) {
  const host = modalBody.querySelector("#oddsHost");
  host.innerHTML = `<div class="loading">Loading odds…</div>`;
  try {
    const qs = new URLSearchParams({ name: p.name || "", team: p.team || "", pos: p.pos || "" });
    const r = await fetch("/api/player/odds?" + qs.toString(), { cache: "no-store" });
    renderOdds(await r.json());
  } catch (e) {
    host.innerHTML = `<div class="err-msg">Could not load odds (${esc(e)})</div>`;
  }
}

async function openPlayer(d) {
  modalCard.classList.remove("full");
  modalCard.classList.add("wide");
  modalTitle.textContent = d.name || "Player";
  modalBody.innerHTML = `<div class="loading">Loading ${esc(d.name || "")}…</div>`;
  modal.hidden = false;
  const qs = new URLSearchParams({
    espn_id: d.espn || "", sleeper_id: d.sleeper || "",
    team: d.team || "", pos: d.pos || "", name: d.name || "",
  });
  try {
    const r = await fetch("/api/player?" + qs.toString(), { cache: "no-store" });
    const p = await r.json();
    if (p.error) { modalBody.innerHTML = `<div class="err-msg">${esc(p.error)}</div>`; return; }
    renderPlayer(p);
  } catch (e) {
    modalBody.innerHTML = `<div class="err-msg">Could not load player (${esc(e)})</div>`;
  }
}

grid.addEventListener("click", e => {
  const lb = e.target.closest(".lab-btn");
  if (lb) { openLab(lb.dataset.id, lb.dataset.name); return; }
  const oc = e.target.closest(".opt-chip");
  if (oc) { openOptimal(parseInt(oc.dataset.idx, 10)); return; }
  const tb = e.target.closest(".trade-btn");
  if (tb) { openTrade(tb.dataset.id, tb.dataset.name); return; }
  const btn = e.target.closest(".rosters-btn");
  if (btn) { openRosters(btn.dataset.id, btn.dataset.name); return; }
});
document.getElementById("rootingBtn").addEventListener("click", openRooting);
document.body.addEventListener("click", e => {
  const row = e.target.closest(".prow.clickable, .rcell.clickable");
  if (row) openPlayer(row.dataset);
});
document.getElementById("modalClose").addEventListener("click", closeModal);
modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

/* ---------- benches toggle (persisted) ---------- */
function applyBenches() {
  document.body.classList.toggle("show-bench", benchesBox.checked);
  store.set("showBench", benchesBox.checked);
}
benchesBox.checked = store.get("showBench", false);
benchesBox.addEventListener("change", applyBenches);
applyBenches();

/* ---------- refresh controls ---------- */
function schedule() {
  if (timer) clearInterval(timer);
  if (document.getElementById("autoref").checked) {
    const secs = parseInt(document.getElementById("interval").value, 10);
    timer = setInterval(load, secs * 1000);
  }
}
document.getElementById("refresh").addEventListener("click", load);
document.getElementById("autoref").addEventListener("change", schedule);
document.getElementById("interval").addEventListener("change", schedule);

grid.innerHTML = Array.from({ length: 4 }, () => `<div class="skeleton"></div>`).join("");
load();
schedule();
