"use strict";
/* =====================================================================
   Trade Center: deal builder with lineup impact, partner finder across the
   whole league, trade block / untouchables, AI analyst, league trade
   history and saved proposals. Relies on helpers defined in app.js.
   ===================================================================== */
window.TradeView = (function () {
  const NEED_POS = ["QB", "RB", "WR", "TE"];
  const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
  const T = {
    host: null, leagueId: null, data: null, teams: [], slots: [],
    aIdx: 0, bIdx: 0, selA: new Set(), selB: new Set(),
    fairness: 0.12, needOnly: false, upgradeOnly: true, startersOnly: false,
    want: new Set(), exclude: new Set(), block: new Set(), untouch: new Set(),
    tab: "finder", finder: null,
    ai: { mode: "evaluate", busy: false, res: null, err: null, notes: "", question: "", partnerOnly: false, status: null },
    saved: [], history: null, histErr: null,
  };

  /* ---------------- helpers ---------------- */
  const team = side => T.teams[side === "a" ? T.aIdx : T.bIdx];
  const selset = side => side === "a" ? T.selA : T.selB;
  const selected = side => allOf(team(side)).filter(p => selset(side).has(pkey(p)));
  const meIdx = () => { const i = T.teams.findIndex(t => t.is_me); return i < 0 ? 0 : i; };
  const ref = p => ({ name: p.name, sleeper_id: p.sleeper_id || "", espn_id: p.espn_id || "", pos: p.pos });
  const normName = s => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/[^a-z0-9]/g, "");
  const signed = (v, f = fmtVal) => (v > 0 ? "+" : v < 0 ? "−" : "") + f(Math.abs(v));
  const dcls = v => v > 0 ? "d-up" : v < 0 ? "d-down" : "d-flat";

  function slotsFor(t) {
    if (T.slots && T.slots.length) return T.slots;
    return (t.players || []).map(p => (p.slot || p.pos || "").toUpperCase());
  }
  // greedy best lineup by `key` (value or projected): most-restrictive slots first
  function lineup(players, slots, key) {
    const pool = players.filter(p => p.name && p.name !== "(empty)");
    const order = slots.map((s, i) => ({ s: s.toUpperCase(), i }))
      .sort((a, b) => (SLOT_ELIG[a.s] || [a.s]).length - (SLOT_ELIG[b.s] || [b.s]).length);
    const used = new Set(), starters = [], bySlot = new Array(slots.length).fill(null);
    let total = 0;
    for (const { s, i } of order) {
      const elig = SLOT_ELIG[s] || [s];
      let best = -1, bv = -1;
      pool.forEach((p, pi) => {
        if (used.has(pi) || !elig.includes(posLabel(p.pos))) return;
        const v = p[key] || 0;
        if (v > bv) { bv = v; best = pi; }
      });
      if (best >= 0) { used.add(best); starters.push(pool[best]); bySlot[i] = pool[best]; total += pool[best][key] || 0; }
    }
    return { total, starters, bySlot };   // starters: assignment order; bySlot: aligned with `slots`
  }
  function impact(t, give, get, key) {
    const gk = new Set(give.map(pkey));
    const pre = lineup(allOf(t), slotsFor(t), key);
    const post = lineup([...allOf(t).filter(p => !gk.has(pkey(p))), ...get], slotsFor(t), key);
    const preK = new Set(pre.starters.map(pkey)), postK = new Set(post.starters.map(pkey));
    return { pre: pre.total, post: post.total, delta: post.total - pre.total,
      enters: post.starters.filter(p => !preK.has(pkey(p))), leaves: pre.starters.filter(p => !postK.has(pkey(p))) };
  }
  function needPool(t) { return T.startersOnly ? (t.players || []).filter(p => p.name && p.name !== "(empty)") : allOf(t); }
  function posTotals(t) {
    const m = {}; NEED_POS.forEach(p => m[p] = 0);
    needPool(t).forEach(pl => { if (pl.value && NEED_POS.includes(pl.pos)) m[pl.pos] += pl.value; });
    return m;
  }
  let avgCache = null;
  function leagueAvg() {
    if (avgCache && avgCache.so === T.startersOnly && avgCache.n === T.teams.length) return avgCache.avg;
    const avg = {}; NEED_POS.forEach(p => avg[p] = 0);
    T.teams.forEach(t => { const m = posTotals(t); NEED_POS.forEach(p => avg[p] += m[p]); });
    NEED_POS.forEach(p => avg[p] /= (T.teams.length || 1));
    avgCache = { so: T.startersOnly, n: T.teams.length, avg };
    return avg;
  }
  function needs(idx) {              // >0 => below league average at that position
    const avg = leagueAvg(), mine = posTotals(T.teams[idx]), n = {};
    NEED_POS.forEach(p => n[p] = avg[p] - mine[p]);
    return n;
  }
  function needTags(idx) {
    const n = needs(idx), avg = leagueAvg();
    const need = NEED_POS.filter(p => avg[p] && n[p] > avg[p] * 0.2);
    const has = NEED_POS.filter(p => avg[p] && -n[p] > avg[p] * 0.2);
    return { need, has, n };
  }
  function fit(myIdx, otherIdx) {
    const a = needs(myIdx), b = needs(otherIdx);
    let s = 0;
    NEED_POS.forEach(p => { s += Math.max(0, Math.min(a[p], -b[p])) + Math.max(0, Math.min(b[p], -a[p])); });
    return s;
  }
  function posDelta(give, get) {
    const d = {};
    give.forEach(p => { if (NEED_POS.includes(p.pos)) d[p.pos] = (d[p.pos] || 0) - (p.value || 0); });
    get.forEach(p => { if (NEED_POS.includes(p.pos)) d[p.pos] = (d[p.pos] || 0) + (p.value || 0); });
    return d;
  }
  function persist() {
    store.set("block:" + T.leagueId, [...T.block]);
    store.set("untouch:" + T.leagueId, [...T.untouch]);
    store.set("saved:" + T.leagueId, T.saved);
  }
  function matchPlayer(t, name) {
    const n = normName(name); if (!n) return null;
    const pool = allOf(t);
    let hit = pool.find(p => normName(p.name) === n);
    if (hit) return hit;
    hit = pool.find(p => normName(p.name).includes(n) || n.includes(normName(p.name)));
    if (hit) return hit;
    // last resort: unique last-name match ("Barkley" -> Saquon Barkley)
    const cands = pool.filter(p => n.endsWith(normName((p.name || "").split(" ").pop())));
    return cands.length === 1 ? cands[0] : null;
  }
  function teamByName(name) {
    const n = normName(name);
    let i = T.teams.findIndex(t => normName(t.name) === n);
    if (i < 0) i = T.teams.findIndex(t => normName(t.name).includes(n) || n.includes(normName(t.name)));
    return i;
  }

  /* ---------------- open / load ---------------- */
  function open(host, leagueId, opts) {
    T.host = host;
    opts = opts || {};
    if (leagueId !== T.leagueId) {
      T.leagueId = leagueId; T.data = null; T.teams = []; avgCache = null;
      T.selA = new Set(); T.selB = new Set(); T.finder = null; T.history = null; T.histErr = null;
      T.block = new Set(store.get("block:" + leagueId, []));
      T.untouch = new Set(store.get("untouch:" + leagueId, []));
      T.saved = store.get("saved:" + leagueId, []);
    }
    if (!leagueId) { host.innerHTML = `<div class="vempty">Pick a league above.</div>`; return; }
    T.pendingPartner = opts.partner || null;
    if (T.data) { applyPartner(); renderAll(); return; }
    host.innerHTML = `<div class="vhead"><div class="vtitle">⇄ Trade Center</div></div><div class="panel"><div class="loading"><span class="spin"></span>Loading rosters…</div></div>`;
    load(false);
  }
  function applyPartner() {
    if (!T.pendingPartner) return;
    const i = T.teams.findIndex(t => String(t.id) === String(T.pendingPartner));
    if (i >= 0) { if (i === T.aIdx) T.aIdx = meIdx() === i ? T.aIdx : meIdx(); T.bIdx = i; T.selB = new Set(); }
    T.pendingPartner = null;
  }
  async function load(force) {
    const id = T.leagueId;
    try {
      const data = await getRosters(id, force);
      if (T.leagueId !== id) return;
      const keepA = T.data ? T.teams[T.aIdx]?.id : null, keepB = T.data ? T.teams[T.bIdx]?.id : null;
      T.data = data; T.teams = data.teams || []; T.slots = data.slots || []; avgCache = null;
      T.aIdx = keepA != null ? Math.max(0, T.teams.findIndex(t => t.id === keepA)) : meIdx();
      if (keepB != null) T.bIdx = Math.max(0, T.teams.findIndex(t => t.id === keepB));
      else { T.bIdx = T.teams.findIndex((t, i) => i !== T.aIdx); if (T.bIdx < 0) T.bIdx = 0; }
      applyPartner();
      renderAll();
    } catch (e) {
      T.host.innerHTML = `<div class="vhead"><div class="vtitle">⇄ Trade Center</div></div><div class="err-msg">Could not load rosters (${esc(e.message || e)})</div>`;
    }
  }

  /* ---------------- frame ---------------- */
  function renderAll() {
    const d = T.data;
    T.host.innerHTML = `<div class="tc">
      <div class="vhead">
        <div class="vtitle">⇄ Trade Center <small>${esc(d.league_name)} · Wk ${d.week}</small></div>
        <div class="vactions">
          <button class="ghost" id="tcRefresh">↻ Refresh</button>
        </div>
      </div>
      <div class="tc-body">
        <aside class="panel rail"><div class="panel-h">Trade partners <span class="pt-lbl">ranked by fit</span></div><div class="rail-list" id="tcRail"></div></aside>
        <div class="tc-main">
          <div class="tc-sides"><div class="panel" id="tcA"></div><div class="panel" id="tcB"></div></div>
          <div class="panel deal" id="tcDeal"></div>
          <div class="tc-tabs">
            <div class="seg" id="tcTabs">
              <button data-tab="finder" class="${T.tab === "finder" ? "active" : ""}">🔍 Finder</button>
              <button data-tab="ai" class="ai ${T.tab === "ai" ? "active" : ""}">🤖 AI Analyst</button>
              <button data-tab="history" class="${T.tab === "history" ? "active" : ""}">📜 History</button>
              <button data-tab="saved" class="${T.tab === "saved" ? "active" : ""}">💾 Saved${T.saved.length ? ` (${T.saved.length})` : ""}</button>
              <button data-tab="playground" class="${T.tab === "playground" ? "active" : ""}">🧪 Playground</button>
            </div>
          </div>
          <div id="tcBottom"></div>
        </div>
      </div></div>`;
    T.host.querySelector("#tcTabs").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      T.tab = b.dataset.tab; store.set("tradeTab", T.tab);
      T.host.querySelectorAll("#tcTabs button").forEach(x => x.classList.toggle("active", x === b));
      renderBottom();
    });
    T.host.querySelector("#tcRefresh").addEventListener("click", () => { toast("Refreshing rosters…"); load(true); });
    renderRail(); renderSide("a"); renderSide("b"); renderDeal(); renderBottom();
  }

  /* ---------------- partners rail ---------------- */
  function renderRail() {
    const host = T.host.querySelector("#tcRail"); if (!host) return;
    const me = meIdx();
    const rows = T.teams.map((t, i) => ({ t, i, fit: i === me ? -1 : fit(me, i) }));
    const mx = Math.max(1, ...rows.map(r => r.fit));
    rows.sort((x, y) => (x.i === me ? -1 : y.i === me ? 1 : y.fit - x.fit));
    host.innerHTML = rows.map(({ t, i, fit: f }) => {
      const tags = needTags(i);
      const isMe = i === me;
      return `<button class="partner ${i === T.bIdx && !isMe ? "active" : ""} ${isMe ? "me" : ""}" data-i="${i}" title="${isMe ? "Your team" : "Trade with " + esc(t.name)}">
          <div class="pt-name"><span>${esc(t.name)}${isMe ? " ★" : ""}</span><small>${esc(t.record || "")}</small></div>
          <div class="pt-sub"><span>#${t.strength_rank || "–"} · ${fmtVal(t.value_total || 0)}</span>
            ${isMe ? "" : `<span class="fitbar" title="How well their surplus matches your needs"><i style="width:${Math.round(100 * f / mx)}%"></i></span>`}</div>
          <div class="pt-tags">${tags.need.map(p => `<span class="mini need ${posClass(p)}">needs ${p}</span>`).join("")}
            ${tags.has.map(p => `<span class="mini has ${posClass(p)}">deep ${p}</span>`).join("")}</div>
        </button>`;
    }).join("");
    host.onclick = e => {
      const b = e.target.closest(".partner"); if (!b) return;
      const i = parseInt(b.dataset.i, 10);
      if (i === meIdx()) { if (T.aIdx !== i) { T.aIdx = i; T.selA = new Set(); renderSide("a"); teamsChanged(); } return; }
      if (i === T.aIdx) { T.aIdx = meIdx(); T.selA = new Set(); renderSide("a"); }
      T.bIdx = i; T.selB = new Set();
      renderRail(); renderSide("b"); teamsChanged();
    };
  }
  // after A or B changes: redo the deal board and the bottom panel (finder /
  // AI labels name the partner); partner-specific finder results are stale
  function teamsChanged() {
    if (T.finder && T.finder.kind === "with") T.finder = null;
    renderDeal(); renderBottom();
  }

  /* ---------------- roster sides ---------------- */
  function playerRow(p, side, t) {
    const key = pkey(p), on = selset(side).has(key);
    const mine = !!t.is_me;
    const locked = mine && T.untouch.has(key);
    const meta = [];
    if (p.pos_rank != null) meta.push(`<span>${posRankStr(p)}</span>`);
    if (p.ppg != null) meta.push(`<span>${p.ppg} ppg</span>`);
    if (p.snap_pct != null && !["K", "DEF"].includes(posLabel(p.pos))) meta.push(`<span>${p.snap_pct}% snaps</span>`);
    if (p.trend) meta.push(trendArrow(p.trend));
    if (p.bye && T.data && p.bye >= T.data.week) meta.push(`<span class="bye">bye ${p.bye}</span>`);
    const proj = p.projected != null ? `proj ${p.projected.toFixed(1)}` : "";
    return `<div class="tp ${on ? "on" : ""} ${locked ? "untouch" : ""}" data-side="${side}" data-key="${esc(key)}">
        <span class="tp-add">${on ? "✓" : "+"}</span>
        <span class="tp-mid">
          <div class="tp-name">${teamLogo(p.team)}<span class="pm-open" ${pdata(p)}>${esc(p.name)}</span>${injBadge(p)}
            ${p.starter ? `<span class="slot">${esc(posLabel(p.slot || p.pos))}</span>` : ""}</div>
          <div class="tp-meta">${meta.join("")}</div>
        </span>
        <span class="tp-right">
          <div class="tp-val ${p.value == null ? "dim" : ""}">${p.value == null ? "—" : fmtVal(p.value)}
            ${mine ? `<span class="tp-star ${T.block.has(key) ? "on" : ""}" data-key="${esc(key)}" title="Trade block (shopping this player)">★</span><span class="tp-lock ${locked ? "on" : ""}" data-key="${esc(key)}" title="Untouchable">🔒</span>` : ""}</div>
          <div class="tp-rank">${proj}</div>
        </span></div>`;
  }
  function renderSide(side) {
    const host = T.host.querySelector(side === "a" ? "#tcA" : "#tcB"); if (!host) return;
    const t = team(side); if (!t) { host.innerHTML = ""; return; }
    const idx = side === "a" ? T.aIdx : T.bIdx;
    const opts = T.teams.map((x, i) => `<option value="${i}" ${i === idx ? "selected" : ""}>${esc(x.name)}${x.is_me ? " (you)" : ""}</option>`).join("");
    const tags = needTags(idx);
    const lv = lineup(allOf(t), slotsFor(t), "value").total;
    const groups = POS_ORDER.map(pos => {
      const list = allOf(t).filter(p => posLabel(p.pos) === pos).sort((x, y) => (y.value || 0) - (x.value || 0));
      if (!list.length) return "";
      return `<div class="tp-grp">${posBadge(pos)} <span>${list.length}</span></div>` + list.map(p => playerRow(p, side, t)).join("");
    }).join("");
    const other = allOf(t).filter(p => !POS_ORDER.includes(posLabel(p.pos)));
    host.innerHTML = `<div class="side-head">
        <select class="teamsel" data-side="${side}">${opts}</select>
        <div class="side-stats"><span>${esc(t.record || "")}</span><span>Roster <b>${fmtVal(t.value_total || 0)}</b></span>
          <span>Starters <b>${fmtVal(lv)}</b></span><span>#${t.strength_rank || "–"} strength</span></div>
        <div class="side-stats pos-balance">${tags.need.map(p => `<span class="mini need ${posClass(p)}">thin ${p}</span>`).join("")}
          ${tags.has.map(p => `<span class="mini has ${posClass(p)}">deep ${p}</span>`).join("")}
          ${!tags.need.length && !tags.has.length ? `<span class="pt-lbl">balanced roster</span>` : ""}</div>
      </div>
      <div class="tc-roster">${groups}${other.length ? `<div class="tp-grp">OTHER</div>` + other.map(p => playerRow(p, side, t)).join("") : ""}</div>`;
    host.querySelector(".teamsel").addEventListener("change", e => {
      const i = parseInt(e.target.value, 10);
      if (side === "a") { T.aIdx = i; T.selA = new Set(); if (T.bIdx === i) { T.bIdx = T.teams.findIndex((x, j) => j !== i); T.selB = new Set(); renderSide("b"); } }
      else { T.bIdx = i; T.selB = new Set(); if (T.aIdx === i) { T.aIdx = meIdx() === i ? T.teams.findIndex((x, j) => j !== i) : meIdx(); T.selA = new Set(); renderSide("a"); } }
      renderSide(side); renderRail(); teamsChanged();
    });
    host.querySelectorAll(".tp").forEach(row => row.addEventListener("click", e => {
      if (e.target.closest(".pm-open")) return;
      const key = row.dataset.key;
      const star = e.target.closest(".tp-star"), lock = e.target.closest(".tp-lock");
      if (star) { e.stopPropagation(); T.block.has(key) ? T.block.delete(key) : T.block.add(key); star.classList.toggle("on", T.block.has(key)); persist(); return; }
      if (lock) { e.stopPropagation(); T.untouch.has(key) ? T.untouch.delete(key) : T.untouch.add(key); lock.classList.toggle("on", T.untouch.has(key)); row.classList.toggle("untouch", T.untouch.has(key)); persist(); return; }
      const set = selset(side);
      set.has(key) ? set.delete(key) : set.add(key);
      row.classList.toggle("on", set.has(key));
      row.querySelector(".tp-add").textContent = set.has(key) ? "✓" : "+";
      renderDeal();
    }));
  }
  function syncSideRows() {
    ["a", "b"].forEach(side => {
      const set = selset(side);
      T.host.querySelectorAll(`.tp[data-side="${side}"]`).forEach(row => {
        const on = set.has(row.dataset.key);
        row.classList.toggle("on", on); row.querySelector(".tp-add").textContent = on ? "✓" : "+";
      });
    });
  }

  /* ---------------- deal board ---------------- */
  function chip(p, side) {
    return `<div class="chip">${posBadge(p.pos)}<span class="chip-name pm-open" ${pdata(p)}>${esc(p.name)}</span>${injBadge(p)}
        <span class="chip-val">${p.value == null ? "—" : fmtVal(p.value)}</span><button class="chip-x" data-side="${side}" data-key="${esc(pkey(p))}" title="Remove">✕</button></div>`;
  }
  function verdictFor(net, av, bv, A, B) {
    const thr = Math.max(av, bv) * 0.05;
    if ((!av && !bv) || Math.abs(net) <= thr) return { cls: "fair", label: "Fair by value" };
    return net > 0 ? { cls: "good", label: `${A.name} wins +${fmtVal(Math.abs(net))}` } : { cls: "bad", label: `${B.name} wins +${fmtVal(Math.abs(net))}` };
  }
  function impactCard(t, give, get, label) {
    const v = impact(t, give, get, "value"), pr = impact(t, give, get, "projected");
    const rosterDelta = get.length - give.length;
    const moves = [...v.enters.map(p => `<span class="d-up">▲ ${esc(abbrevName(p.name))} starts</span>`),
                   ...v.leaves.map(p => `<span class="d-down">▼ ${esc(abbrevName(p.name))} benched</span>`)].join("");
    return `<div class="imp"><div class="imp-h"><span>${esc(label)}</span><span>${esc(t.name)}</span></div>
        <div class="imp-row"><span>Starting lineup value</span><b class="${dcls(v.delta)}">${signed(v.delta)}</b></div>
        <div class="imp-row"><span>This week's projected starters</span><b class="${dcls(pr.delta)}">${signed(pr.delta, x => x.toFixed(1))}</b></div>
        <div class="imp-row"><span>Roster spots</span><b class="${rosterDelta > 0 ? "d-down" : rosterDelta < 0 ? "d-up" : "d-flat"}">${rosterDelta > 0 ? `needs ${rosterDelta} drop${rosterDelta > 1 ? "s" : ""}` : rosterDelta < 0 ? `frees ${-rosterDelta}` : "even"}</b></div>
        ${moves ? `<div class="imp-moves">${moves}</div>` : ""}</div>`;
  }
  function renderDeal() {
    const host = T.host.querySelector("#tcDeal"); if (!host) return;
    const A = team("a"), B = team("b");
    const give = selected("a"), get = selected("b");
    const av = sumVal(give), bv = sumVal(get), net = bv - av;
    const mx = Math.max(av, bv, 1);
    const v = verdictFor(net, av, bv, A, B);
    const empty = !give.length && !get.length;
    const n = needs(T.aIdx), pd = posDelta(give, get);
    const fills = NEED_POS.filter(p => n[p] > 0 && (pd[p] || 0) > 0);
    host.innerHTML = `<div class="deal-cols">
        <div><div class="deal-side-h"><span>${esc(A.name)} sends</span><b>${fmtVal(av)}</b></div>
          <div class="chips">${give.length ? give.map(p => chip(p, "a")).join("") : `<div class="chips-empty">Tap players on the left</div>`}</div></div>
        <div class="deal-mid">
          <div class="verdict ${v.cls}">${empty ? "Build a deal" : v.label}</div>
          <div class="bal"><i class="ba" style="width:${50 * av / mx}%"></i><i class="bb" style="width:${50 * bv / mx}%"></i></div>
          <div class="bal-lbl"><span>${fmtVal(av)}</span><span>${fmtVal(bv)}</span></div>
          <div class="deal-net">${empty ? "" : `net ${signed(net)} to ${esc(A.name)}`}</div>
          ${fills.length ? `<div class="swap-tags">${fills.map(p => `<span class="fill-tag ${posClass(p)}">fills ${p}</span>`).join("")}</div>` : ""}
        </div>
        <div><div class="deal-side-h"><span>${esc(B.name)} sends</span><b>${fmtVal(bv)}</b></div>
          <div class="chips">${get.length ? get.map(p => chip(p, "b")).join("") : `<div class="chips-empty">Tap players on the right</div>`}</div></div>
      </div>
      ${empty ? "" : `<div class="impact">${impactCard(A, give, get, "Impact for A")}${impactCard(B, get, give, "Impact for B")}</div>`}
      <div class="deal-actions">
        <button class="primary ai" id="dealAi" ${empty ? "disabled" : ""}>🤖 Analyze with AI</button>
        <button class="ghost" id="dealSave" ${empty ? "disabled" : ""}>💾 Save proposal</button>
        <button class="ghost" id="dealCopy" ${empty ? "disabled" : ""}>📋 Copy for league chat</button>
        <button class="ghost" id="dealPg" ${empty ? "disabled" : ""}>🧪 Try in playground</button>
        <span class="spacer"></span>
        <button class="ghost" id="dealClear" ${empty ? "disabled" : ""}>✕ Clear</button>
      </div>`;
    host.querySelectorAll(".chip-x").forEach(b => b.addEventListener("click", () => {
      selset(b.dataset.side).delete(b.dataset.key); syncSideRows(); renderDeal();
    }));
    host.querySelector("#dealClear").addEventListener("click", () => { T.selA = new Set(); T.selB = new Set(); syncSideRows(); renderDeal(); });
    host.querySelector("#dealCopy").addEventListener("click", () => copyText(dealText(A, B, give, get)));
    host.querySelector("#dealPg").addEventListener("click", () => {
      const me = T.teams[meIdx()];
      if (A !== me && B !== me) { toast("The playground edits your own team — put yourself on one side"); return; }
      const out = A === me ? give : get, inc = A === me ? get : give;
      pgApply(out, inc);
      T.tab = "playground"; T.host.querySelectorAll("#tcTabs button").forEach(x => x.classList.toggle("active", x.dataset.tab === "playground"));
      renderBottom(); T.host.querySelector("#tcBottom").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    host.querySelector("#dealSave").addEventListener("click", () => {
      T.saved.unshift({ ts: Date.now(), aId: A.id, bId: B.id, a: A.name, b: B.name, give: give.map(ref), get: get.map(ref), av, bv });
      persist(); toast("Proposal saved");
      const tb = T.host.querySelector('#tcTabs [data-tab="saved"]'); if (tb) tb.textContent = `💾 Saved (${T.saved.length})`;
      if (T.tab === "saved") renderBottom();
    });
    host.querySelector("#dealAi").addEventListener("click", () => {
      T.tab = "ai"; T.ai.mode = "evaluate";
      T.host.querySelectorAll("#tcTabs button").forEach(x => x.classList.toggle("active", x.dataset.tab === "ai"));
      renderBottom(); runAi("evaluate");
      T.host.querySelector("#tcBottom").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  function dealText(A, B, give, get) {
    const line = (t, ps) => `${t.name} sends: ${ps.length ? ps.map(p => `${p.name} (${posLabel(p.pos)}${p.value != null ? ", " + fmtVal(p.value) : ""})`).join(", ") : "—"}`;
    const av = sumVal(give), bv = sumVal(get);
    return `Trade proposal — ${T.data.league_name}\n${line(A, give)}\n${line(B, get)}\nValue: ${fmtVal(av)} ⇄ ${fmtVal(bv)} (net ${signed(bv - av)} to ${A.name})`;
  }

  /* ---------------- bottom panels ---------------- */
  function renderBottom() {
    const host = T.host.querySelector("#tcBottom"); if (!host) return;
    if (T.tab === "ai") renderAiPanel(host);
    else if (T.tab === "history") renderHistory(host);
    else if (T.tab === "saved") renderSaved(host);
    else if (T.tab === "playground") renderPlayground(host);
    else renderFinder(host);
  }

  /* ---- finder ---- */
  function renderFinder(host) {
    const A = team("a"), B = team("b");
    host.innerHTML = `<div class="panel finder">
      <div class="finder-ctrls">
        <label class="fair-ctrl">Fairness band ±<b id="fairPct">${Math.round(T.fairness * 100)}</b>%
          <input type="range" id="fairSlider" min="2" max="35" value="${Math.round(T.fairness * 100)}"></label>
        <label class="need-ctrl"><input type="checkbox" id="upgradeOnly" ${T.upgradeOnly ? "checked" : ""}> Must upgrade my starters</label>
        <label class="need-ctrl"><input type="checkbox" id="needOnly" ${T.needOnly ? "checked" : ""}> Only fill my needs</label>
        <label class="need-ctrl"><input type="checkbox" id="startersOnly" ${T.startersOnly ? "checked" : ""}> Measure need by starters only</label>
      </div>
      <div class="want-row"><span class="want-lbl">I want to acquire:</span>${NEED_POS.map(p => `<button class="want-pill ${posClass(p)} ${T.want.has(p) ? "on" : ""}" data-pos="${p}">${p}</button>`).join("")}</div>
      <div class="want-row"><span class="want-lbl">Keep out of trades:</span>${NEED_POS.map(p => `<button class="excl-pill ${T.exclude.has(p) ? "on" : ""}" data-pos="${p}">${p}</button>`).join("")}
        <span class="pt-lbl">+ 🔒 untouchables are never offered</span></div>
      <div class="need-line" id="needLine"></div>
      <div class="finder-run">
        <button class="primary" id="fWith">💡 Swaps with ${esc(B.name)}</button>
        <button class="primary" id="fLeague">🌐 Scan the whole league</button>
        <button class="ghost" id="fBlock">🎯 Offers for my ★ block</button>
      </div>
      <div id="findOut"></div></div>`;
    const out = host.querySelector("#findOut");
    const rerun = () => { if (T.finder) runFinder(T.finder.kind); };
    const slider = host.querySelector("#fairSlider");
    slider.addEventListener("input", () => { T.fairness = parseInt(slider.value, 10) / 100; host.querySelector("#fairPct").textContent = slider.value; rerun(); });
    host.querySelector("#upgradeOnly").addEventListener("change", e => { T.upgradeOnly = e.target.checked; rerun(); });
    host.querySelector("#needOnly").addEventListener("change", e => { T.needOnly = e.target.checked; rerun(); });
    host.querySelector("#startersOnly").addEventListener("change", e => { T.startersOnly = e.target.checked; avgCache = null; renderNeedLine(); renderRail(); rerun(); });
    host.querySelectorAll(".want-pill").forEach(p => p.addEventListener("click", () => { const k = p.dataset.pos; T.want.has(k) ? T.want.delete(k) : T.want.add(k); p.classList.toggle("on", T.want.has(k)); rerun(); }));
    host.querySelectorAll(".excl-pill").forEach(p => p.addEventListener("click", () => { const k = p.dataset.pos; T.exclude.has(k) ? T.exclude.delete(k) : T.exclude.add(k); p.classList.toggle("on", T.exclude.has(k)); rerun(); }));
    host.querySelector("#fWith").addEventListener("click", () => runFinder("with"));
    host.querySelector("#fLeague").addEventListener("click", () => runFinder("league"));
    host.querySelector("#fBlock").addEventListener("click", () => runFinder("block"));
    renderNeedLine();
    if (T.finder) renderFinderOut(out);
  }
  function renderNeedLine() {
    const el = T.host.querySelector("#needLine"); if (!el) return;
    const tags = needTags(T.aIdx), A = team("a");
    el.innerHTML = tags.need.length
      ? `${esc(A.name)} is thin at${T.startersOnly ? " (starters)" : ""}: ` + tags.need.map(p => `<span class="need-chip ${posClass(p)}">${p}</span>`).join("")
      : `${esc(A.name)}'s roster is balanced across positions${T.startersOnly ? " (starters)" : ""}.`;
  }
  function candidatesFor(t, mine) {
    return allOf(t).filter(p => p.value && !T.exclude.has(p.pos) && !(mine && T.untouch.has(pkey(p))));
  }
  function evalCombo(A, B, bi, give, get, need, band, out) {
    const g = sumVal(give), h = sumVal(get), diff = Math.abs(g - h), den = Math.max(g, h) || 1;
    if (diff / den > band) return;
    if (T.want.size && !get.some(p => T.want.has(p.pos))) return;
    const pd = posDelta(give, get);
    const fills = NEED_POS.filter(p => need[p] > 0 && (pd[p] || 0) > 0);
    if (T.needOnly && !fills.length) return;
    const imp = impact(A, give, get, "value");
    if (T.upgradeOnly && imp.delta <= 0) return;
    out.push({ bi, team: B.name, give, get, net: h - g, diff, fills, imp: imp.delta });
  }
  function pairs(list) { const o = []; for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) o.push([list[i], list[j]]); return o; }
  function runFinder(kind) {
    const A = team("a"), need = needs(T.aIdx), band = T.fairness || 0.12, out = [];
    let mine = candidatesFor(A, A.is_me);
    if (kind === "block") {
      mine = allOf(A).filter(p => T.block.has(pkey(p)) && p.value);
      if (!mine.length) { T.finder = { kind, rows: [], msg: "Star (★) players on your roster to put them on the block, then run this again." }; renderFinderOut(T.host.querySelector("#findOut")); return; }
    }
    const partners = kind === "with" ? [T.bIdx] : T.teams.map((_, i) => i).filter(i => i !== T.aIdx);
    const minePairs = pairs(mine);
    partners.forEach(bi => {
      const B = T.teams[bi], theirs = candidatesFor(B, false), theirPairs = pairs(theirs);
      mine.forEach(a => { theirs.forEach(b => evalCombo(A, B, bi, [a], [b], need, band, out)); theirPairs.forEach(pr => evalCombo(A, B, bi, [a], pr, need, band, out)); });
      minePairs.forEach(pr => theirs.forEach(b => evalCombo(A, B, bi, pr, [b], need, band, out)));
    });
    out.sort((x, y) => (y.fills.length - x.fills.length) || (y.imp - x.imp) || (x.diff - y.diff));
    // de-dupe: at most 3 offers per partner when scanning the league, 16 total
    const perTeam = {}, rows = [];
    for (const r of out) {
      if (kind !== "with" && (perTeam[r.bi] || 0) >= 3) continue;
      perTeam[r.bi] = (perTeam[r.bi] || 0) + 1; rows.push(r);
      if (rows.length >= 16) break;
    }
    T.finder = { kind, rows, msg: rows.length ? "" : noResultMsg(kind, band) };
    renderFinderOut(T.host.querySelector("#findOut"));
  }
  function noResultMsg(kind, band) {
    const bits = [];
    if (T.upgradeOnly) bits.push("turn off “must upgrade my starters”");
    if (T.needOnly) bits.push("turn off the needs filter");
    if (T.want.size) bits.push("pick other target positions");
    bits.push(`widen the band past ±${Math.round(band * 100)}%`);
    return `No ${kind === "block" ? "offers for your block" : "balanced swaps"} found. Try: ${bits.join(", ")}.`;
  }
  function renderFinderOut(host) {
    if (!host || !T.finder) return;
    const f = T.finder;
    if (!f.rows.length) { host.innerHTML = `<div class="empty">${esc(f.msg)}</div>`; return; }
    const note = f.kind === "with" ? `Balanced swaps between ${esc(team("a").name)} and ${esc(team("b").name)}, best lineup upgrades first.`
      : f.kind === "block" ? "Best offers around the league for your ★ block players." : "Best balanced deals with every team in the league (up to 3 per partner), best lineup upgrades first.";
    host.innerHTML = `<div class="lab-note">${note} Click one to load it onto the board.</div>` + f.rows.map((s, i) => `
      <div class="swap" data-i="${i}">
        <span class="swap-team">${f.kind === "with" ? "" : esc(s.team)}</span>
        <span class="swap-side">give ${s.give.map(p => esc(p.name)).join(" + ")} <small>${fmtVal(sumVal(s.give))}</small></span>
        <span class="swap-arrow">⇄</span>
        <span class="swap-side">get ${s.get.map(p => esc(p.name)).join(" + ")} <small>${fmtVal(sumVal(s.get))}</small></span>
        <span class="swap-tags">${s.fills.map(p => `<span class="fill-tag ${posClass(p)}">fills ${p}</span>`).join("")}<span class="swap-imp ${dcls(s.imp)}">lineup ${signed(s.imp)}</span></span>
        <span class="swap-delta ${Math.abs(s.net) <= Math.max(sumVal(s.give), sumVal(s.get)) * 0.05 ? "fair" : ""}">${signed(s.net)}</span>
      </div>`).join("");
    host.querySelectorAll(".swap").forEach(el => el.addEventListener("click", () => {
      const s = f.rows[parseInt(el.dataset.i, 10)];
      loadDeal(s.bi, s.give, s.get);
    }));
  }
  function loadDeal(bi, give, get) {
    if (bi != null && bi !== T.bIdx) { T.bIdx = bi; renderSide("b"); renderRail(); }
    T.selA = new Set(give.map(pkey)); T.selB = new Set(get.map(pkey));
    syncSideRows(); renderDeal();
    T.host.querySelector("#tcDeal").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ---- AI analyst ---- */
  // Results and chats live per league in module state (and the chat in
  // localStorage), so switching views or leagues never loses them, and a
  // request that is in flight lands in the right league when it finishes.
  const AI = { results: {}, chats: {}, pending: null, status: null };
  const chatFor = id => { if (!AI.chats[id]) AI.chats[id] = store.get("aichat:" + id, []); return AI.chats[id]; };
  const saveChat = id => store.set("aichat:" + id, chatFor(id).slice(-40));
  const resFor = (id, mode) => (AI.results[id] || {})[mode];
  function setRes(id, mode, res, err) { (AI.results[id] = AI.results[id] || {})[mode] = res; (AI.results[id].err = AI.results[id].err || {})[mode] = err || null; }
  const errFor = (id, mode) => ((AI.results[id] || {}).err || {})[mode];
  const isPending = (id, mode) => !!(AI.pending && AI.pending.id === id && AI.pending.mode === mode);

  function aiStatusChanged(s) { AI.status = s; if (T.tab === "ai" && T.host) renderBottom(); }
  function renderAiPanel(host) {
    const A = team("a"), B = team("b");
    const give = selected("a"), get = selected("b");
    const st = AI.status || aiStatus;
    if (!st) { fetchAiStatus().then(s => { AI.status = s; if (T.tab === "ai") renderBottom(); }); }
    const provLabel = st ? ((st.providers || {})[st.provider] || {}).label || st.provider : "…";
    const ready = st ? st.configured : true;
    const m = T.ai.mode, id = T.leagueId;
    const busy = isPending(id, m);
    const dealLine = give.length || get.length
      ? `<b>${esc(A.name)}</b> sends ${give.map(p => esc(p.name)).join(", ") || "—"} ⇄ <b>${esc(B.name)}</b> sends ${get.map(p => esc(p.name)).join(", ") || "—"}`
      : `Nothing on the board yet — pick players above, or use <i>Suggest trades</i>.`;
    const pendingElsewhere = AI.pending && !busy ? `<span class="pt-lbl">· ${esc(AI.pending.mode)} running${AI.pending.id !== id ? " in another league" : ""}…</span>` : "";
    host.innerHTML = `<div class="panel ai-panel">
      <div class="panel-h"><span>🤖 AI analyst ${pendingElsewhere}</span>
        <span class="ai-meta">${st ? esc(provLabel) + (st.model ? " · " + esc(st.model) : "") : ""} ${st && !ready ? `· <b style="color:var(--lose)">not set up</b>` : ""}
          <button class="ghost" id="aiSettings">⚙ ${ready ? "change" : "set up"}</button></span></div>
      <div class="ai-body">
        <div class="seg ai-modes">
          <button data-m="evaluate" class="${m === "evaluate" ? "active ai" : ""}">Evaluate this deal</button>
          <button data-m="suggest" class="${m === "suggest" ? "active ai" : ""}">Suggest trades for me</button>
          <button data-m="ask" class="${m === "ask" ? "active ai" : ""}">Ask the analyst${chatFor(id).length ? ` (${Math.ceil(chatFor(id).length / 2)})` : ""}</button>
        </div>
        ${m !== "ask" ? `<div class="ai-ctrls" style="margin-top:10px">
          ${m === "evaluate" ? `<span class="fnote" style="flex:1">${dealLine}</span><button class="primary ai" id="aiRun" ${(!give.length && !get.length) || busy ? "disabled" : ""}>Analyze</button>` : ""}
          ${m === "suggest" ? `<textarea id="aiNotes" placeholder="Optional notes for the analyst — e.g. “I'm a contender, need an RB2, won't move my QB, open to 2-for-1s.”">${esc(T.ai.notes)}</textarea>
             <label class="need-ctrl"><input type="checkbox" id="aiPartnerOnly" ${T.ai.partnerOnly ? "checked" : ""}> only with ${esc(B.name)}</label>
             <button class="primary ai" id="aiRun" ${busy ? "disabled" : ""}>Find trades</button>` : ""}
        </div>
        <div class="fnote" style="margin-top:8px">The analyst gets everything the app knows about this league: format, standings &amp; playoff odds, schedule &amp; this week's matchups, power rankings, trade history, waivers, buy/sell trends, Vegas edges, byes, every roster with values, season stats, usage, injuries and Vegas props, plus news, outlooks and recent games for the key players. It uses your ★ block, 🔒 untouchables and the Finder's position filters as preferences.</div>
        <div class="ai-status" ${busy ? "" : "hidden"}><span class="spin"></span>Gathering rosters, news, odds and standings, then asking ${esc(provLabel)}… this can take 20–60 seconds. You can switch views — the result will be here when you come back.</div>
        <div class="ai-err" ${errFor(id, m) ? "" : "hidden"}>${esc(errFor(id, m) || "")}</div>
        <div id="aiOut" class="ai-out"></div>` : renderChat(id, busy, provLabel)}
      </div></div>`;
    host.querySelector("#aiSettings").addEventListener("click", openSettings);
    host.querySelectorAll(".ai-modes button").forEach(b => b.addEventListener("click", () => { T.ai.mode = b.dataset.m; renderBottom(); }));
    const notes = host.querySelector("#aiNotes"); if (notes) notes.addEventListener("input", () => T.ai.notes = notes.value);
    const po = host.querySelector("#aiPartnerOnly"); if (po) po.addEventListener("change", () => T.ai.partnerOnly = po.checked);
    const run = host.querySelector("#aiRun"); if (run) run.addEventListener("click", () => runAi(T.ai.mode));
    if (m === "ask") wireChat(host, id);
    else if (resFor(id, m)) renderAiResult(host.querySelector("#aiOut"), resFor(id, m));
  }

  /* chat thread for "Ask the analyst" */
  function renderChat(id, busy, provLabel) {
    const msgs = chatFor(id);
    const bubble = (h, i) => h.role === "user"
      ? `<div class="bubble user"><div class="bubble-text">${esc(h.text)}</div><div class="bubble-meta">${new Date(h.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div></div>`
      : `<div class="bubble bot"><div class="bubble-text">${esc(h.text)}</div>
          ${h.proposal && (h.proposal.give || h.proposal.get) ? `<div class="ai-prop" data-i="${i}"><div><div class="ai-prop-h">${esc(h.proposal.team || "")}</div><div class="ai-prop-deal">give <b>${(h.proposal.give || []).map(esc).join(" + ") || "—"}</b> ⇄ get <b>${(h.proposal.get || []).map(esc).join(" + ") || "—"}</b></div></div><button class="ghost load-prop">Load</button></div>` : ""}
          <div class="bubble-meta">${esc(h.model || "")}${h.secs ? ` · ${h.secs}s` : ""} · ${new Date(h.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${h.dossier ? ` · <span class="see-data" data-i="${i}">what it saw</span>` : ""}</div></div>`;
    return `<div class="chat" id="aiChat">
        ${msgs.length ? msgs.map(bubble).join("") : `<div class="chat-empty">Ask anything about this league — “Who should I target for a WR2?”, “Is my RB room good enough to win?”, “What trades have happened?” — then keep going; the analyst remembers this conversation (saved in your browser) and re-reads the latest league data on every message.</div>`}
        ${busy ? `<div class="bubble bot typing"><span class="spin"></span>Reading the league and thinking… (${esc(provLabel)}; you can switch views meanwhile)</div>` : ""}
        ${errFor(id, "ask") ? `<div class="ai-err">${esc(errFor(id, "ask"))}</div>` : ""}
      </div>
      <div class="chat-input">
        <textarea id="aiQ" placeholder="${msgs.length ? "Ask a follow-up… (Enter to send, Shift+Enter for a new line)" : "Ask the analyst… (Enter to send)"}">${esc(T.ai.question)}</textarea>
        <div class="chat-btns"><button class="primary ai" id="aiRun" ${busy ? "disabled" : ""}>Send</button>
          <button class="ghost" id="aiNew" ${msgs.length ? "" : "hidden"}>New chat</button></div>
      </div>`;
  }
  function wireChat(host, id) {
    const q = host.querySelector("#aiQ");
    q.addEventListener("input", () => T.ai.question = q.value);
    q.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runAi("ask"); } });
    const nb = host.querySelector("#aiNew");
    if (nb) nb.addEventListener("click", () => { AI.chats[id] = []; saveChat(id); setRes(id, "ask", null, null); renderBottom(); });
    host.querySelectorAll(".load-prop").forEach(b => b.addEventListener("click", () => {
      const h = chatFor(id)[parseInt(b.closest(".ai-prop").dataset.i, 10)];
      if (h && h.proposal) loadFromNames(h.proposal.team, h.proposal.give, h.proposal.get);
    }));
    host.querySelectorAll(".see-data").forEach(x => x.addEventListener("click", () => {
      const h = chatFor(id)[parseInt(x.dataset.i, 10)];
      if (h && h.dossier) openModal("What the analyst saw", `<pre class="dossier-pre">${esc(h.dossier)}</pre>`, "wide");
    }));
    const chat = host.querySelector("#aiChat"); if (chat) chat.scrollTop = chat.scrollHeight;
    if (!isPending(id, "ask")) q.focus();
  }

  async function runAi(mode) {
    if (AI.pending) { toast("The analyst is still working on the previous request"); return; }
    const A = team("a"), B = team("b"), id = T.leagueId;
    const question = (T.ai.question || "").trim();
    if (mode === "ask" && !question) return;
    const history = mode === "ask" ? chatFor(id).map(h => ({ role: h.role, text: h.text })) : [];
    const body = {
      id, mode, a_id: A.id,
      b_id: (mode === "suggest" && !T.ai.partnerOnly) ? null : B.id,
      give: selected("a").map(ref), get: selected("b").map(ref),
      question, history,
      prefs: { want: [...T.want], exclude: [...T.exclude], notes: T.ai.notes,
        block: allOf(A).filter(p => T.block.has(pkey(p))).map(p => p.name),
        untouchable: allOf(A).filter(p => T.untouch.has(pkey(p))).map(p => p.name) },
    };
    if (mode === "ask") { chatFor(id).push({ role: "user", text: question, ts: Date.now() }); saveChat(id); T.ai.question = ""; }
    AI.pending = { id, mode }; setRes(id, mode, mode === "ask" ? resFor(id, mode) : null, null);
    if (T.tab === "ai" && T.leagueId === id) renderBottom();
    try {
      const r = await fetch("/api/trade/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      if (!d.ok && d.result && d.result.error) throw new Error(d.result.error + (d.result.raw ? "\n\n" + d.result.raw.slice(0, 400) : ""));
      if (mode === "ask") {
        const res = d.result || {};
        chatFor(id).push({ role: "assistant", text: res.answer || "", proposal: res.proposal || null, model: d.model, secs: d.secs, ts: Date.now(), dossier: d.dossier });
        saveChat(id); setRes(id, mode, d, null);
      } else setRes(id, mode, d, null);
    } catch (e) { setRes(id, mode, resFor(id, mode), String(e.message || e)); }
    AI.pending = null;
    if (T.host && T.tab === "ai" && T.leagueId === id) renderBottom();
    else if (T.host && T.tab === "ai") renderBottom();
    toast(mode === "ask" ? "The analyst replied" : `AI ${mode} finished`);
  }
  function renderAiResult(host, d) {
    if (!host) return;
    const r = d.result || {};
    const meta = `<div class="ai-meta">${esc(d.provider || "")}${d.model ? " · " + esc(d.model) : ""} · ${d.secs}s${d.usage && d.usage.in ? ` · ${d.usage.in}→${d.usage.out} tokens` : ""}${d.usage && d.usage.cost_usd != null ? ` · $${Number(d.usage.cost_usd).toFixed(3)}` : ""}</div>`
      + (d.dossier ? `<details class="ai-dossier"><summary>What the analyst saw (${Math.round(d.dossier.length / 1000)}k characters)</summary><pre>${esc(d.dossier)}</pre></details>` : "");
    const list = (arr) => (arr && arr.length) ? `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<div class="empty">–</div>`;
    const propRow = (p, i) => `<div class="ai-prop" data-i="${i}">
        <div><div class="ai-prop-h">${esc(p.team || "")} ${p.fairness ? `<small>· ${esc(p.fairness)}</small>` : ""} ${p.likelihood != null ? `<small>· ${p.likelihood}% they'd accept</small>` : ""}</div>
          <div class="ai-prop-deal">give <b>${(p.give || []).map(esc).join(" + ") || "—"}</b> ⇄ get <b>${(p.get || []).map(esc).join(" + ") || "—"}</b></div>
          ${p.why ? `<div class="ai-prop-why">${esc(p.why)}</div>` : ""}</div>
        <button class="ghost load-prop">Load</button></div>`;
    if (d.mode === "evaluate") {
      const tag = (r.verdict || "").toLowerCase();
      host.innerHTML = `
        <div class="ai-verdict">
          <div class="grade">${esc(r.grade_a || "–")}<small>${esc(d.a || "A")}</small></div>
          <div><div class="ai-head">${esc(r.headline || "")}</div>
            <div class="ai-sub">${tag ? `<span class="ai-tag ${esc(tag)}">${esc(tag)}</span> ` : ""}${r.winner ? `favors ${r.winner === "A" ? esc(d.a) : r.winner === "B" ? esc(d.b) : "neither side"}` : ""}${r.confidence != null ? ` · ${r.confidence}% confident` : ""}</div></div>
          <div class="grade">${esc(r.grade_b || "–")}<small>${esc(d.b || "B")}</small></div>
        </div>
        ${r.summary ? `<div class="ai-text">${esc(r.summary)}</div>` : ""}
        <div class="ai-cols">
          <div class="ai-sec"><div class="ai-sec-h">What ${esc(d.a)} gets</div>${list(r.for_a)}</div>
          <div class="ai-sec"><div class="ai-sec-h">What ${esc(d.b)} gets</div>${list(r.for_b)}</div>
        </div>
        <div class="ai-cols">
          <div class="ai-sec"><div class="ai-sec-h">Risks</div>${list(r.risks)}</div>
          <div class="ai-sec"><div class="ai-sec-h">Lineup impact</div><div>${esc(r.lineup_impact || "–")}</div></div>
        </div>
        ${r.counter && (r.counter.give || r.counter.get) ? `<div class="ai-sec"><div class="ai-sec-h">Suggested counter</div>${propRow({ team: d.b, ...r.counter }, 0)}</div>` : ""}
        ${r.pitch ? `<div class="ai-sec"><div class="ai-sec-h" style="display:flex;justify-content:space-between">Pitch to ${esc(d.b)} <button class="ghost copybtn" id="copyPitch">📋 Copy</button></div><div class="ai-text">${esc(r.pitch)}</div></div>` : ""}
        ${meta}`;
      const cp = host.querySelector("#copyPitch"); if (cp) cp.addEventListener("click", () => copyText(r.pitch));
      host.querySelectorAll(".load-prop").forEach(b => b.addEventListener("click", () => loadFromNames(d.b, r.counter.give, r.counter.get)));
    } else if (d.mode === "suggest") {
      const props = r.proposals || [];
      host.innerHTML = `
        ${r.strategy ? `<div class="ai-sec"><div class="ai-sec-h">Strategy</div><div class="ai-text">${esc(r.strategy)}</div></div>` : ""}
        ${r.needs && r.needs.length ? `<div class="need-line">Biggest needs: ${r.needs.map(n => `<span class="need-chip" style="background:var(--ai)">${esc(n)}</span>`).join("")}</div>` : ""}
        ${props.length ? props.map(propRow).join("") : `<div class="empty">No proposals returned.</div>`}
        ${meta}`;
      host.querySelectorAll(".load-prop").forEach(b => b.addEventListener("click", () => {
        const p = props[parseInt(b.closest(".ai-prop").dataset.i, 10)]; loadFromNames(p.team, p.give, p.get);
      }));
    } else {
      host.innerHTML = `<div class="ai-sec"><div class="ai-text">${esc(r.answer || "")}</div></div>
        ${r.proposal && (r.proposal.give || r.proposal.get) ? propRow(r.proposal, 0) : ""}${meta}`;
      host.querySelectorAll(".load-prop").forEach(b => b.addEventListener("click", () => loadFromNames(r.proposal.team, r.proposal.give, r.proposal.get)));
    }
  }
  function loadFromNames(teamName, giveNames, getNames) {
    let bi = teamName ? teamByName(teamName) : T.bIdx;
    if (bi < 0 || bi === T.aIdx) bi = T.bIdx;
    const B = T.teams[bi], A = team("a");
    const give = (giveNames || []).map(n => matchPlayer(A, n)).filter(Boolean);
    const get = (getNames || []).map(n => matchPlayer(B, n)).filter(Boolean);
    const missed = (giveNames || []).length + (getNames || []).length - give.length - get.length;
    loadDeal(bi, give, get);
    toast(missed ? `Loaded (couldn't match ${missed} name${missed > 1 ? "s" : ""})` : "Proposal loaded onto the board");
  }

  /* ---- playground: edit your roster freely, compare before/after ---- */
  const PG = { roster: null, leagueId: null, q: "", results: [], busy: false };
  function pgLoad() {
    if (PG.leagueId === T.leagueId && PG.roster) return;
    PG.leagueId = T.leagueId;
    PG.roster = store.get("pg:" + T.leagueId, null);
    PG.results = []; PG.q = "";
  }
  function pgBase() { return allOf(T.teams[meIdx()]); }
  function pgSave() { store.set("pg:" + T.leagueId, PG.roster); }
  function pgApply(outs, ins) {
    pgLoad();
    const cur = PG.roster || pgBase().map(p => ({ ...p }));
    const outK = new Set(outs.map(pkey));
    PG.roster = cur.filter(p => !outK.has(pkey(p)));
    ins.forEach(p => { if (!PG.roster.some(x => pkey(x) === pkey(p))) PG.roster.push({ ...p }); });
    pgSave();
  }
  function pgProfile(players) {
    const avg = leagueAvg(), mine = {}; NEED_POS.forEach(p => mine[p] = 0);
    players.forEach(pl => { if (pl.value && NEED_POS.includes(pl.pos)) mine[pl.pos] += pl.value; });
    return { need: NEED_POS.filter(p => avg[p] && avg[p] - mine[p] > avg[p] * 0.2), has: NEED_POS.filter(p => avg[p] && mine[p] - avg[p] > avg[p] * 0.2), mine };
  }
  function pgStats(players) {
    const me = T.teams[meIdx()], slots = slotsFor(me);
    const lv = lineup(players, slots, "value"), lp = lineup(players, slots, "projected");
    const byes = {};
    players.forEach(p => { if (p.bye && T.data && p.bye >= T.data.week) (byes[p.bye] = byes[p.bye] || []).push(p); });
    return { total: sumVal(players), starters: lv.total, startersList: lv.bySlot, proj: lp.total, projList: lp.bySlot,
      count: players.length, profile: pgProfile(players), byes, slots };
  }
  function renderPlayground(host) {
    pgLoad();
    const me = T.teams[meIdx()];
    const base = pgBase();
    const roster = PG.roster || base.map(p => ({ ...p }));
    const edited = !!PG.roster;
    const before = pgStats(base), after = pgStats(roster);
    // your real roster is the ceiling (IR players push it past the league's slot count)
    const limit = Math.max(T.data.roster_size || 0, base.length);
    const baseK = new Set(base.map(pkey)), afterK = new Set(roster.map(pkey));
    const d = (a, b, f = fmtVal) => { const v = b - a; return `<b class="${dcls(v)}">${signed(v, f)}</b>`; };
    const starterNames = st => st.startersList.filter(Boolean).map(pkey);
    const bS = new Set(starterNames(before)), aS = new Set(starterNames(after));
    const lineupCol = (st, other, label) => `<div class="pg-lineup"><div class="ai-sec-h">${label} · starters by value</div>
        ${st.slots.map((sl, i) => { const p = st.startersList[i]; const chg = p && !other.has(pkey(p)); return `<div class="pg-slot ${chg ? "chg" : ""}">${posBadge(sl)}<span class="pg-slot-n">${p ? esc(abbrevName(p.name)) : "—"}${p && p.injury ? injBadge(p) : ""}</span><span class="pg-slot-v">${p ? fmtVal(p.value || 0) : ""}</span></div>`; }).join("")}
        <div class="pg-slot total"><span></span><span class="pg-slot-n">Starters</span><span class="pg-slot-v">${fmtVal(st.starters)}</span></div></div>`;
    const byeLine = st => Object.keys(st.byes).sort((a, b) => a - b).map(w => `<span class="${st.byes[w].length >= 3 ? "d-down" : ""}">wk${w}: ${st.byes[w].length}</span>`).join(" · ") || "none";
    const tags = pr => pr.need.map(p => `<span class="mini need ${posClass(p)}">thin ${p}</span>`).join("") + pr.has.map(p => `<span class="mini has ${posClass(p)}">deep ${p}</span>`).join("") || `<span class="pt-lbl">balanced</span>`;
    const groups = POS_ORDER.map(pos => {
      const list = roster.filter(p => posLabel(p.pos) === pos).sort((x, y) => (y.value || 0) - (x.value || 0));
      if (!list.length) return "";
      return `<div class="tp-grp">${posBadge(pos)} <span>${list.length}</span></div>` + list.map(p => {
        const added = !baseK.has(pkey(p));
        const meta = [p.pos_rank != null ? posRankStr(p) : "", p.ppg != null ? `${p.ppg} ppg` : "", p.projected != null ? `proj ${Number(p.projected).toFixed(1)}` : "", p.bye ? `bye ${p.bye}` : ""].filter(Boolean);
        return `<div class="tp pg-row ${added ? "added" : ""}" data-key="${esc(pkey(p))}">
            <span class="tp-add pg-x" title="Remove from playground">✕</span>
            <span class="tp-mid"><div class="tp-name">${teamLogo(p.team)}<span class="pm-open" ${pdata(p)}>${esc(p.name)}</span>${injBadge(p)}${added ? `<span class="slot" style="color:var(--win);border-color:var(--win)">NEW</span>` : ""}${aS.has(pkey(p)) ? `<span class="slot">starter</span>` : ""}</div>
              <div class="tp-meta">${meta.map(m => `<span>${esc(m)}</span>`).join("")}${trendArrow(p.trend)}</div></span>
            <span class="tp-right"><div class="tp-val ${p.value == null ? "dim" : ""}">${p.value == null ? "—" : fmtVal(p.value)}</div></span></div>`;
      }).join("");
    }).join("");
    const removed = base.filter(p => !afterK.has(pkey(p)));
    host.innerHTML = `<div class="panel pg">
      <div class="panel-h"><span>🧪 Playground · ${esc(me.name)}</span>
        <span class="vactions"><button class="ghost" id="pgLoadDeal">⇄ Apply deal on the board</button><button class="ghost" id="pgReset" ${edited ? "" : "disabled"}>↺ Reset to my real roster</button></span></div>
      <div class="pg-body">
        <div class="pg-left">
          <div class="pg-search"><input type="text" id="pgQ" placeholder="🔍 Add any NFL player…" value="${esc(PG.q)}" autocomplete="off">
            <div class="pm-results pg-results" id="pgRes" ${PG.results.length ? "" : "hidden"}>${PG.results.map(r => `<div class="pm-result" data-sid="${esc(r.sleeper_id)}" data-eid="${esc(r.espn_id)}" data-name="${esc(r.name)}" data-team="${esc(r.team)}" data-pos="${esc(r.pos)}">${posBadge(r.pos)} <span class="pmr-name">${esc(r.name)}</span> <small>${esc(r.team)}</small></div>`).join("")}</div></div>
          <div class="pg-count ${after.count > limit ? "d-down" : ""}">${after.count} / ${limit} roster spots${after.count > limit ? ` · ${after.count - limit} over — you'd need to drop` : ""}${removed.length ? ` · removed: ${removed.map(p => esc(abbrevName(p.name))).join(", ")}` : ""}</div>
          <div class="tc-roster pg-roster">${groups || `<div class="empty">Empty roster — add players above.</div>`}</div>
        </div>
        <div class="pg-right">
          <div class="pg-cmp">
            <div class="imp"><div class="imp-h"><span>Before → After</span><span>${edited ? "edited" : "unchanged"}</span></div>
              <div class="imp-row"><span>Roster value</span><b>${fmtVal(before.total)} → ${fmtVal(after.total)} ${d(before.total, after.total)}</b></div>
              <div class="imp-row"><span>Starting lineup value</span><b>${fmtVal(before.starters)} → ${fmtVal(after.starters)} ${d(before.starters, after.starters)}</b></div>
              <div class="imp-row"><span>This week's projected starters</span><b>${before.proj.toFixed(1)} → ${after.proj.toFixed(1)} ${d(before.proj, after.proj, x => x.toFixed(1))}</b></div>
              <div class="imp-row"><span>Roster spots</span><b>${before.count} → ${after.count}${after.count > limit ? ` <span class="d-down">(${after.count - limit} over)</span>` : ""}</b></div>
              <div class="imp-row"><span>Positions · before</span><span>${tags(before.profile)}</span></div>
              <div class="imp-row"><span>Positions · after</span><span>${tags(after.profile)}</span></div>
              <div class="imp-row"><span>Byes · before</span><span class="pt-lbl">${byeLine(before)}</span></div>
              <div class="imp-row"><span>Byes · after</span><span class="pt-lbl">${byeLine(after)}</span></div>
            </div>
            <div class="pg-lineups">${lineupCol(before, aS, "Before")}${lineupCol(after, bS, "After")}</div>
          </div>
          <div class="lab-note">Add anyone in the NFL (free agents, other teams' players) or remove your own to see how the lineup and depth change. Values and projections are matched to this league's format. Nothing here touches your real roster; it's saved in your browser per league.</div>
        </div>
      </div></div>`;
    const q = host.querySelector("#pgQ"), res = host.querySelector("#pgRes");
    let timer = null;
    q.addEventListener("input", () => {
      PG.q = q.value; clearTimeout(timer);
      const term = q.value.trim();
      if (term.length < 2) { PG.results = []; res.hidden = true; return; }
      timer = setTimeout(async () => {
        try {
          const r = await fetch("/api/search?q=" + encodeURIComponent(term), { cache: "no-store" });
          const have = new Set(roster.map(pkey));
          PG.results = ((await r.json()).results || []).filter(x => !have.has(String(x.sleeper_id)));
          res.innerHTML = PG.results.length ? PG.results.map(r2 => `<div class="pm-result" data-sid="${esc(r2.sleeper_id)}" data-eid="${esc(r2.espn_id)}" data-name="${esc(r2.name)}" data-team="${esc(r2.team)}" data-pos="${esc(r2.pos)}">${posBadge(r2.pos)} <span class="pmr-name">${esc(r2.name)}</span> <small>${esc(r2.team)}</small></div>`).join("") : `<div class="pm-result empty">No players found</div>`;
          res.hidden = false;
        } catch (e) { res.hidden = true; }
      }, 200);
    });
    res.addEventListener("click", async e => {
      const row = e.target.closest(".pm-result"); if (!row || !row.dataset.name || PG.busy) return;
      PG.busy = true; row.innerHTML = `<span class="spin"></span>Adding ${esc(row.dataset.name)}…`;
      try {
        const qs = new URLSearchParams({ id: T.leagueId, sleeper_id: row.dataset.sid || "", espn_id: row.dataset.eid || "", name: row.dataset.name, team: row.dataset.team || "", pos: row.dataset.pos || "" });
        const r = await fetch("/api/player/card?" + qs, { cache: "no-store" });
        const card = await r.json();
        if (card.error) throw new Error(card.error);
        pgApply([], [card]); PG.q = ""; PG.results = [];
        toast(`${card.name} added to the playground`);
      } catch (err) { toast("Could not add player: " + (err.message || err)); }
      PG.busy = false; renderPlayground(host);
    });
    host.querySelectorAll(".pg-x").forEach(x => x.addEventListener("click", e => {
      e.stopPropagation();
      const key = x.closest(".pg-row").dataset.key;
      pgLoad(); PG.roster = (PG.roster || pgBase().map(p => ({ ...p }))).filter(p => pkey(p) !== key); pgSave(); renderPlayground(host);
    }));
    host.querySelector("#pgReset").addEventListener("click", () => { PG.roster = null; store.set("pg:" + T.leagueId, null); renderPlayground(host); });
    host.querySelector("#pgLoadDeal").addEventListener("click", () => {
      const A = team("a"), B = team("b"), give = selected("a"), get = selected("b");
      if (!give.length && !get.length) { toast("Build a deal on the board first"); return; }
      if (A !== me && B !== me) { toast("Put your own team on one side of the deal first"); return; }
      pgApply(A === me ? give : get, A === me ? get : give); renderPlayground(host);
    });
    document.addEventListener("click", e => { if (!e.target.closest(".pg-search")) res.hidden = true; }, { once: true });
  }

  /* ---- history ---- */
  async function renderHistory(host) {
    host.innerHTML = `<div class="panel"><div class="panel-h">Recent trades in this league</div><div id="histBody"><div class="loading"><span class="spin"></span>Loading…</div></div></div>`;
    const body = host.querySelector("#histBody");
    if (!T.history && !T.histErr) {
      try {
        const r = await fetch("/api/league/trades?id=" + encodeURIComponent(T.leagueId), { cache: "no-store" });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        T.history = d.trades || [];
      } catch (e) { T.histErr = String(e.message || e); }
      if (T.tab !== "history") return;
    }
    if (T.histErr) { body.innerHTML = `<div class="err-msg">${esc(T.histErr)}</div>`; return; }
    if (!T.history.length) { body.innerHTML = `<div class="empty">No completed trades in this league yet this season.</div>`; return; }
    body.innerHTML = T.history.map(tr => `<div class="hist-row"><span class="hist-wk">${tr.week != null ? `WK ${tr.week}<br>` : ""}${tr.when ? new Date(tr.when).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}</span>
        <div>${tr.sides.map(s => `<div class="hist-side"><b>${esc(s.team)}</b> gets ${s.gets.map(p => `<span>${p.pos ? posBadge(p.pos) : ""} <span class="pm-open" ${pdata({ name: p.name, sleeper_id: p.sleeper_id, espn_id: p.espn_id, pos: p.pos })}>${esc(p.name)}</span></span>`).join(", ")}${s.picks && s.picks.length ? `, picks ${s.picks.map(esc).join(", ")}` : ""}${!s.gets.length && !(s.picks || []).length ? "nothing" : ""}</div>`).join("")}</div></div>`).join("");
  }

  /* ---- saved ---- */
  function renderSaved(host) {
    host.innerHTML = `<div class="panel"><div class="panel-h">Saved proposals <span class="pt-lbl">stored in this browser</span></div><div id="savedBody"></div></div>`;
    const body = host.querySelector("#savedBody");
    if (!T.saved.length) { body.innerHTML = `<div class="empty">No saved proposals. Build a deal and press 💾 Save.</div>`; return; }
    body.innerHTML = T.saved.map((s, i) => `<div class="saved-row">
        <div><b>${esc(s.a)}</b> sends ${s.give.map(p => esc(p.name)).join(", ") || "—"} ⇄ <b>${esc(s.b)}</b> sends ${s.get.map(p => esc(p.name)).join(", ") || "—"}
          <small>${fmtVal(s.av)} ⇄ ${fmtVal(s.bv)} · saved ${new Date(s.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></div>
        <span><button class="ghost" data-load="${i}">Load</button> <button class="ghost" data-del="${i}">✕</button></span></div>`).join("");
    body.querySelectorAll("[data-load]").forEach(b => b.addEventListener("click", () => {
      const s = T.saved[parseInt(b.dataset.load, 10)];
      const ai = T.teams.findIndex(t => t.id === s.aId), bi = T.teams.findIndex(t => t.id === s.bId);
      if (ai >= 0 && ai !== T.aIdx) { T.aIdx = ai; renderSide("a"); }
      const A = T.teams[T.aIdx], B = T.teams[bi >= 0 ? bi : T.bIdx];
      const find = (t, refs) => refs.map(r => allOf(t).find(p => (r.sleeper_id && p.sleeper_id === r.sleeper_id) || (r.espn_id && p.espn_id === r.espn_id) || normName(p.name) === normName(r.name))).filter(Boolean);
      loadDeal(bi >= 0 ? bi : T.bIdx, find(A, s.give), find(B, s.get));
    }));
    body.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
      T.saved.splice(parseInt(b.dataset.del, 10), 1); persist(); renderSaved(host);
      const tb = T.host.querySelector('#tcTabs [data-tab="saved"]'); if (tb) tb.textContent = `💾 Saved${T.saved.length ? ` (${T.saved.length})` : ""}`;
    }));
  }

  T.tab = store.get("tradeTab", "finder");
  return { open, aiStatusChanged, refresh: () => load(true) };
})();
