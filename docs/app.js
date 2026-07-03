/* China Leadership Tracker — vanilla JS frontend.
   Data: data/meta.json, data/leaders.json, data/index.json (compact rows),
   data/events-YYYY.json (full Chinese text, lazy-loaded per year). */
"use strict";

const $ = (sel) => document.querySelector(sel);
const TIER_NAMES = {
  1: "Politburo Standing Committee (current)",
  2: "Politburo (current)",
  3: "Former PSC",
  4: "Former Politburo",
  5: "State leaders / ministers",
};
const TIER_COLORS = {
  1: "var(--tier1)", 2: "var(--tier2)", 3: "var(--tier3)",
  4: "var(--tier4)", 5: "var(--tier5)",
};

const state = {
  events: [],          // parsed event objects
  leaders: [],
  leadersById: {},
  typeLabels: {},
  meta: {},
  filtered: [],
  shown: 0,
  pageSize: 50,
  yearDetail: {},      // year -> promise of detail map
};

/* ---------------- load ---------------- */
async function boot() {
  const [meta, leaders, index] = await Promise.all([
    fetch("data/meta.json").then((r) => r.json()),
    fetch("data/leaders.json").then((r) => r.json()),
    fetch("data/index.json").then((r) => r.json()),
  ]);
  state.meta = meta;
  state.leaders = leaders;
  for (const p of leaders) state.leadersById[p.id] = p;
  state.typeLabels = index.types;

  state.events = index.events.map((row) => {
    const [id, date, type, activity, titleZh, titleEn, summaryEn,
           leaders_, mentions, counterpart, location] = row;
    return {
      id, date, type, activity: !!activity,
      titleZh, titleEn, summaryEn, counterpart, location,
      leaders: leaders_ ? leaders_.split(",") : [],
      mentions: mentions ? mentions.split(",") : [],
      hay: null,
    };
  });
  // newest first
  state.events.sort((a, b) => (a.date < b.date ? 1 : -1));

  $("#meta-line").innerHTML =
    `Covering <b>${fmtDate(meta.first_date)}</b> – <b>${fmtDate(meta.last_date)}</b>` +
    ` · ${meta.n_events.toLocaleString()} events from ${meta.n_days.toLocaleString()} broadcasts.`;
  $("#footer-meta").textContent = `Last updated ${meta.built_at.slice(0, 10)}`;

  buildFilters();
  buildLeadersView();
  buildNetworkControls();
  applyFilters();
  wireTabs();

  // deep link: #leader=xi-jinping or #q=term
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("leader")) { $("#f-leader").value = h.get("leader"); applyFilters(); }
  if (h.get("q")) { $("#f-search").value = h.get("q"); applyFilters(); }
}

function fmtDate(d) {
  if (!d) return "";
  return d;
}

function leaderName(id) {
  const p = state.leadersById[id];
  return p ? p.name_en : id;
}

function glossEn(e) {
  const names = e.leaders.map(leaderName).join(", ");
  const label = state.typeLabels[e.type] || e.type;
  let s = names ? `${label} — ${names}` : label;
  if (e.counterpart) s += ` · ${e.counterpart}`;
  return s;
}

function haystack(e) {
  if (e.hay) return e.hay;
  const parts = [e.titleZh, e.titleEn, e.summaryEn, e.counterpart, e.location,
                 e.date, state.typeLabels[e.type] || e.type];
  for (const id of e.leaders.concat(e.mentions)) {
    const p = state.leadersById[id];
    if (p) parts.push(p.name_en, p.name_zh);
  }
  e.hay = parts.join("\n").toLowerCase();
  return e.hay;
}

/* ---------------- filters + events view ---------------- */
function buildFilters() {
  const leaderSel = $("#f-leader");
  for (const p of state.leaders) {
    if (!p.count) continue;
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `${p.name_en} ${p.name_zh} (${p.count.toLocaleString()})`;
    leaderSel.appendChild(o);
  }
  const typeSel = $("#f-type");
  const typeCounts = {};
  for (const e of state.events) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  const types = Object.keys(state.typeLabels)
    .filter((t) => typeCounts[t])
    .sort((a, b) => typeCounts[b] - typeCounts[a]);
  for (const t of types) {
    const o = document.createElement("option");
    o.value = t;
    o.textContent = `${state.typeLabels[t]} (${typeCounts[t].toLocaleString()})`;
    typeSel.appendChild(o);
  }
  for (const [sel, def] of [["#f-date-from", state.meta.first_date],
                            ["#f-date-to", state.meta.last_date]]) {
    const el = $(sel);
    el.min = state.meta.first_date;
    el.max = state.meta.last_date;
    el.value = def;
  }
  let deb;
  $("#f-search").addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(applyFilters, 180); });
  for (const id of ["#f-leader", "#f-type", "#f-date-from", "#f-date-to",
                    "#f-activity", "#f-fulltext"])
    $(id).addEventListener("change", applyFilters);
  $("#more-btn").addEventListener("click", () => renderList(true));
}

function loadYearDetail(year) {
  if (!state.yearDetail[year])
    state.yearDetail[year] = fetch(`data/events-${year}.json`).then((r) => r.json());
  return state.yearDetail[year];
}

let filterToken = 0;
async function applyFilters() {
  const token = ++filterToken;
  const q = $("#f-search").value.trim().toLowerCase();
  const leader = $("#f-leader").value;
  const type = $("#f-type").value;
  const d0 = $("#f-date-from").value || state.meta.first_date;
  const d1 = $("#f-date-to").value || state.meta.last_date;
  const activityOnly = $("#f-activity").checked;
  const fullText = $("#f-fulltext").checked;

  // Full-text mode: make sure the transcript shards for the selected date
  // range are loaded before filtering (cached after first use).
  let contentByYear = null;
  if (fullText && q) {
    const years = state.meta.years.filter(
      (y) => y >= d0.slice(0, 4) && y <= d1.slice(0, 4));
    $("#result-count").textContent = "Loading full transcripts…";
    contentByYear = {};
    await Promise.all(years.map(async (y) => {
      contentByYear[y] = await loadYearDetail(y);
    }));
    if (token !== filterToken) return; // superseded by a newer filter change
  }

  state.filtered = state.events.filter((e) => {
    if (e.date < d0 || e.date > d1) return false;
    if (type && e.type !== type) return false;
    if (activityOnly && !e.activity) return false;
    if (leader && !e.leaders.includes(leader) && !e.mentions.includes(leader)) return false;
    if (q && !haystack(e).includes(q)) {
      if (!contentByYear) return false;
      const det = (contentByYear[e.date.slice(0, 4)] || {})[e.id];
      if (!det || !det.content_zh.toLowerCase().includes(q)) return false;
    }
    return true;
  });
  $("#result-count").textContent =
    `${state.filtered.length.toLocaleString()} events` +
    (q ? ` matching “${q}”${fullText ? " (incl. full text)" : ""}` : "");
  drawChart(state.filtered, d0, d1);
  renderList(false);
}

function renderList(more) {
  const list = $("#event-list");
  if (!more) { list.innerHTML = ""; state.shown = 0; }
  const next = state.filtered.slice(state.shown, state.shown + state.pageSize);
  state.shown += next.length;
  for (const e of next) list.appendChild(eventCard(e));
  $("#more-btn").hidden = state.shown >= state.filtered.length;
}

function eventCard(e) {
  const div = document.createElement("div");
  div.className = "event";
  const title = e.titleEn || glossEn(e);
  const badges = e.leaders.map((id) =>
    `<span class="badge"><b>${esc(leaderName(id))}</b></span>`).join("") +
    e.mentions.map((id) => `<span class="badge">${esc(leaderName(id))}</span>`).join("");
  div.innerHTML = `
    <div class="top">
      <span class="date">${e.date}</span>
      <span class="type">${esc(state.typeLabels[e.type] || e.type)}</span>
      ${e.location ? `<span class="date">📍 ${esc(e.location)}</span>` : ""}
    </div>
    <h4>${esc(title)}</h4>
    <p class="zh-title">${esc(e.titleZh)}</p>
    <div class="who">${badges}</div>
    <div class="detail"></div>`;
  div.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) return;
    toggleDetail(div, e);
  });
  return div;
}

async function toggleDetail(card, e) {
  if (card.classList.contains("open")) { card.classList.remove("open"); return; }
  card.classList.add("open");
  const box = card.querySelector(".detail");
  if (box.dataset.loaded) return;
  box.dataset.loaded = "1";
  let html = "";
  if (e.summaryEn) html += `<p>${esc(e.summaryEn)}</p>`;
  if (e.counterpart) html += `<p><span class="label">Counterpart</span><br>${esc(e.counterpart)}</p>`;
  html += `<p><span class="label">Original transcript 原文</span><br><span class="zh-full" id="zh-${e.id}">Loading…</span></p>`;
  box.innerHTML = html;
  const year = e.date.slice(0, 4);
  try {
    if (!state.yearDetail[year])
      state.yearDetail[year] = fetch(`data/events-${year}.json`).then((r) => r.json());
    const detail = await state.yearDetail[year];
    const el = document.getElementById(`zh-${e.id}`);
    if (el) el.textContent = (detail[e.id] || {}).content_zh || "(unavailable)";
  } catch {
    const el = document.getElementById(`zh-${e.id}`);
    if (el) el.textContent = "(failed to load)";
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- monthly chart ---------------- */
function drawChart(events, d0, d1) {
  const svg = $("#chart-svg");
  svg.innerHTML = "";
  const counts = new Map();
  for (const e of events) {
    const m = e.date.slice(0, 7);
    counts.set(m, (counts.get(m) || 0) + 1);
  }
  const m0 = d0.slice(0, 7), m1 = d1.slice(0, 7);
  const months = [];
  for (let y = +d0.slice(0, 4); y <= +d1.slice(0, 4); y++)
    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      if (key > m1) break;
      if (key < m0) continue;
      months.push(key);
    }
  if (!months.length) return;
  const W = 1000, H = 120, pad = 2, bottom = 16;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const max = Math.max(1, ...months.map((m) => counts.get(m) || 0));
  const bw = Math.min(24, (W - pad * 2) / months.length - 1);
  const step = (W - pad * 2) / months.length;
  const ns = "http://www.w3.org/2000/svg";

  // baseline
  const base = document.createElementNS(ns, "line");
  base.setAttribute("x1", 0); base.setAttribute("x2", W);
  base.setAttribute("y1", H - bottom); base.setAttribute("y2", H - bottom);
  base.setAttribute("stroke", "var(--baseline)");
  svg.appendChild(base);

  const tip = $("#tip");
  months.forEach((m, i) => {
    const v = counts.get(m) || 0;
    const h = Math.round((v / max) * (H - bottom - 8));
    const x = pad + i * step + (step - bw) / 2;
    const r = document.createElementNS(ns, "rect");
    const y = H - bottom - h;
    r.setAttribute("x", x); r.setAttribute("y", y);
    r.setAttribute("width", Math.max(1, bw)); r.setAttribute("height", Math.max(h, v ? 1 : 0));
    r.setAttribute("rx", Math.min(3, bw / 2));
    r.setAttribute("fill", "var(--accent)");
    r.addEventListener("mousemove", (ev) => {
      tip.style.display = "block";
      tip.style.left = ev.clientX + 12 + "px";
      tip.style.top = ev.clientY + 12 + "px";
      tip.textContent = `${m}: ${v.toLocaleString()} events`;
    });
    r.addEventListener("mouseleave", () => (tip.style.display = "none"));
    svg.appendChild(r);
    // year tick each January
    if (m.endsWith("-01") || i === 0) {
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", x); t.setAttribute("y", H - 3);
      t.setAttribute("fill", "var(--muted)");
      t.setAttribute("font-size", "11");
      t.textContent = m.slice(0, 4);
      svg.appendChild(t);
    }
  });
}

/* ---------------- leaders view ---------------- */
function buildLeadersView() {
  const legend = $("#tier-legend");
  legend.innerHTML = Object.entries(TIER_NAMES).map(([t, name]) =>
    `<span><i class="tier-dot" style="background:${TIER_COLORS[t]}"></i>${name}</span>`).join("");
  const grid = $("#leader-grid");
  for (const p of state.leaders) {
    if (!p.count) continue;
    const card = document.createElement("div");
    card.className = "leader-card";
    const top = Object.entries(p.by_type).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([t, n]) => `${(state.typeLabels[t] || t).toLowerCase()} ${n.toLocaleString()}`).join(" · ");
    card.innerHTML = `
      <h4><i class="tier-dot" style="background:${TIER_COLORS[p.tier]}"></i>${esc(p.name_en)}<span class="zh">${esc(p.name_zh)}</span></h4>
      <p class="roles">${esc(p.roles)}</p>
      <p class="stats"><b>${p.count.toLocaleString()}</b> events · ${top}</p>`;
    card.addEventListener("click", () => {
      $("#f-leader").value = p.id;
      switchView("events");
      applyFilters();
      location.hash = `leader=${p.id}`;
    });
    grid.appendChild(card);
  }
}

/* ---------------- network view ---------------- */
function buildNetworkControls() {
  const years = state.meta.years;
  for (const [sel, def] of [["#n-year-from", years[years.length - 4] || years[0]],
                            ["#n-year-to", years[years.length - 1]]]) {
    const el = $(sel);
    for (const y of years) {
      const o = document.createElement("option");
      o.value = y; o.textContent = y;
      el.appendChild(o);
    }
    el.value = def;
  }
  $("#net-legend").innerHTML = Object.entries(TIER_NAMES).map(([t, name]) =>
    `<span><i class="tier-dot" style="background:${TIER_COLORS[t]}"></i>${name}</span>`).join("");
  for (const id of ["#n-year-from", "#n-year-to", "#n-min", "#n-mentions"])
    $(id).addEventListener("change", drawNetwork);
}

function computeGraph() {
  const y0 = $("#n-year-from").value, y1 = $("#n-year-to").value;
  const minW = Math.max(1, +$("#n-min").value || 1);
  const useMentions = $("#n-mentions").checked;
  const pair = new Map(), nodeCount = new Map();
  for (const e of state.events) {
    if (!e.activity) continue;
    const y = e.date.slice(0, 4);
    if (y < y0 || y > y1) continue;
    const ppl = useMentions ? e.leaders.concat(e.mentions) : e.leaders;
    const uniq = [...new Set(ppl)];
    for (const id of uniq) nodeCount.set(id, (nodeCount.get(id) || 0) + 1);
    for (let i = 0; i < uniq.length; i++)
      for (let j = i + 1; j < uniq.length; j++) {
        const k = [uniq[i], uniq[j]].sort().join("|");
        pair.set(k, (pair.get(k) || 0) + 1);
      }
  }
  const edges = [];
  const keep = new Set();
  for (const [k, w] of pair) {
    if (w < minW) continue;
    const [a, b] = k.split("|");
    edges.push({ a, b, w });
    keep.add(a); keep.add(b);
  }
  const nodes = [...keep].map((id) => ({
    id, n: nodeCount.get(id) || 1,
    tier: (state.leadersById[id] || {}).tier || 5,
    x: 0, y: 0, vx: 0, vy: 0,
  }));
  return { nodes, edges };
}

function drawNetwork() {
  const svg = $("#network-svg");
  svg.innerHTML = "";
  const { nodes, edges } = computeGraph();
  const W = svg.clientWidth || 1000, H = svg.clientHeight || 620;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (!nodes.length) return;

  // init positions on a circle
  nodes.forEach((n, i) => {
    const a = (i / nodes.length) * Math.PI * 2;
    n.x = W / 2 + Math.cos(a) * Math.min(W, H) * 0.33;
    n.y = H / 2 + Math.sin(a) * Math.min(W, H) * 0.33;
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const maxW = Math.max(...edges.map((e) => e.w));
  const maxN = Math.max(...nodes.map((n) => n.n));
  const radius = (n) => 5 + 17 * Math.sqrt(n.n / maxN);

  // simple force simulation
  for (let it = 0; it < 260; it++) {
    const k = 1 - it / 300;
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy || 1;
        const rep = (1700 * k) / d2;
        dx *= rep; dy *= rep;
        a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
      }
    for (const e of edges) {
      const a = byId[e.a], b = byId[e.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 90 + 140 * (1 - e.w / maxW);
      const f = ((d - target) / d) * 0.012 * (0.5 + e.w / maxW);
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.012;
      n.vy += (H / 2 - n.y) * 0.012;
      n.x += Math.max(-14, Math.min(14, n.vx));
      n.y += Math.max(-14, Math.min(14, n.vy));
      n.vx *= 0.5; n.vy *= 0.5;
      const r = radius(n) + 4;
      n.x = Math.max(r, Math.min(W - r, n.x));
      n.y = Math.max(r, Math.min(H - r, n.y));
    }
  }

  const ns = "http://www.w3.org/2000/svg";
  const edgeLayer = document.createElementNS(ns, "g");
  const nodeLayer = document.createElementNS(ns, "g");
  svg.appendChild(edgeLayer); svg.appendChild(nodeLayer);

  const edgeEls = edges.map((e) => {
    const a = byId[e.a], b = byId[e.b];
    const l = document.createElementNS(ns, "line");
    l.setAttribute("x1", a.x); l.setAttribute("y1", a.y);
    l.setAttribute("x2", b.x); l.setAttribute("y2", b.y);
    l.setAttribute("class", "edge");
    l.setAttribute("stroke-width", Math.max(1, 6 * (e.w / maxW)));
    edgeLayer.appendChild(l);
    return l;
  });

  const info = $("#net-info");
  const reset = () => {
    for (const el of edgeEls) el.classList.remove("dim", "hl");
    nodeLayer.querySelectorAll(".node").forEach((g) => g.classList.remove("dim"));
    info.innerHTML = "Click a node to inspect; click the background to reset.";
  };
  svg.addEventListener("click", (ev) => { if (ev.target === svg) reset(); });

  nodes.sort((a, b) => b.n - a.n);
  for (const n of nodes) {
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", "node");
    g.dataset.id = n.id;
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", n.x); c.setAttribute("cy", n.y);
    c.setAttribute("r", radius(n));
    c.setAttribute("fill", TIER_COLORS[n.tier]);
    g.appendChild(c);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", n.x + radius(n) + 3);
    t.setAttribute("y", n.y + 4);
    t.textContent = leaderName(n.id);
    g.appendChild(t);
    g.addEventListener("click", () => {
      reset();
      const neighbors = new Set([n.id]);
      const partners = [];
      edges.forEach((e, i) => {
        if (e.a === n.id || e.b === n.id) {
          edgeEls[i].classList.add("hl");
          const other = e.a === n.id ? e.b : e.a;
          neighbors.add(other);
          partners.push([other, e.w]);
        } else {
          edgeEls[i].classList.add("dim");
        }
      });
      nodeLayer.querySelectorAll(".node").forEach((el) => {
        el.classList.toggle("dim", !neighbors.has(el.dataset.id));
      });
      partners.sort((a, b) => b[1] - a[1]);
      const p = state.leadersById[n.id] || {};
      info.innerHTML =
        `<b>${esc(p.name_en || n.id)}</b> ${esc(p.name_zh || "")} — ` +
        `${n.n.toLocaleString()} joint-appearance items in range. ` +
        `Top co-appearances: ` +
        partners.slice(0, 8).map(([id, w]) => `${esc(leaderName(id))} (${w})`).join(", ") +
        ` · <a href="#leader=${n.id}" data-goto="${n.id}">view events →</a>`;
      info.querySelector("[data-goto]").addEventListener("click", (ev) => {
        ev.preventDefault();
        $("#f-leader").value = n.id;
        switchView("events");
        applyFilters();
      });
    });
    nodeLayer.appendChild(g);
  }
}

/* ---------------- tabs ---------------- */
function wireTabs() {
  document.querySelectorAll("nav.tabs button").forEach((b) =>
    b.addEventListener("click", () => switchView(b.dataset.view)));
}
let networkDrawn = false;
function switchView(name) {
  document.querySelectorAll("nav.tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "network" && !networkDrawn) { networkDrawn = true; drawNetwork(); }
  window.scrollTo({ top: 0 });
}

boot().catch((err) => {
  document.querySelector("main").innerHTML =
    `<p style="color:#d03b3b">Failed to load data: ${esc(err.message)}</p>`;
  console.error(err);
});
