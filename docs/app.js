/* China Leadership Tracker — vanilla JS frontend.
   Data: data/meta.json, data/leaders.json, data/index.json (compact rows),
   data/events-YYYY.json (full Chinese text, lazy-loaded per year). */
"use strict";

const $ = (sel) => document.querySelector(sel);

const TYPE_CODES = {
  meeting: "MTG", talks: "BIL", phone_call: "TEL", message: "MSG",
  chaired_meeting: "CHR", inspection: "INS", foreign_trip: "TRIP",
  visit_to_china: "VIS",
  ceremony: "CER", symposium: "SYM", deliberation: "NPC", funeral: "FNR",
  speech: "SPCH", decree: "APPT", document: "DOC", article: "ART", brief: "BRF",
  coverage: "COV", other: "OTH",
};
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTHS_FULL = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
                     "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

const state = {
  events: [],
  leaders: [],
  leadersById: {},
  typeLabels: {},
  meta: {},
  filtered: [],
  monthCounts: new Map(),
  shown: 0,
  lastMonth: null,
  pageSize: 50,
  yearDetail: {},
};

/* ---------------- theme ---------------- */
function initTheme() {
  const btn = $("#theme-btn");
  const label = () =>
    (document.documentElement.dataset.theme === "dark" ? "◑ LIGHT" : "◐ DARK");
  btn.textContent = label();
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("clt-theme", next); } catch (e) {}
    btn.textContent = label();
  });
}

function switchOn(el) { return el.classList.contains("on"); }
function wireSwitch(el, onChange) {
  el.addEventListener("click", () => {
    el.classList.toggle("on");
    onChange();
  });
}

/* ---------------- load ---------------- */
async function boot() {
  initTheme();
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
  state.events.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

  $("#upd-label").textContent = `UPD ${meta.built_at.slice(0, 10)}`;
  $("#stat-events").textContent = meta.n_events.toLocaleString();
  $("#stat-leaders").textContent = state.leaders.filter((p) => p.count).length;
  $("#stat-days").textContent = meta.n_days.toLocaleString();

  buildFilters();
  buildLeadersView();
  buildNetworkControls();
  applyFilters();
  wireTabs();
  prefetchTranscripts();

  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("leader")) { $("#f-leader").value = h.get("leader"); applyFilters(); }
  if (h.get("q")) { $("#f-search").value = h.get("q"); applyFilters(); }
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

function loadYearDetail(year) {
  if (!state.yearDetail[year])
    state.yearDetail[year] = fetch(`data/events-${year}.json`).then((r) => r.json());
  return state.yearDetail[year];
}

// Full-text search is on by default, so quietly warm the transcript cache
// (newest year first) shortly after load; searches reuse the same promises.
function prefetchTranscripts() {
  const years = [...state.meta.years].reverse();
  let i = 0;
  const next = () => {
    if (i >= years.length) return;
    loadYearDetail(years[i++]).catch(() => {}).finally(() => setTimeout(next, 250));
  };
  setTimeout(next, 1200);
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
    o.textContent = `${(state.typeLabels[t] || t).toUpperCase()} (${typeCounts[t].toLocaleString()})`;
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
  for (const id of ["#f-leader", "#f-type", "#f-date-from", "#f-date-to"])
    $(id).addEventListener("change", applyFilters);
  wireSwitch($("#f-activity"), applyFilters);
  wireSwitch($("#f-fulltext"), applyFilters);
  $("#more-btn").addEventListener("click", () => renderList(true));
  wireExport();
}

let filterToken = 0;
async function applyFilters() {
  const token = ++filterToken;
  const q = $("#f-search").value.trim().toLowerCase();
  const leader = $("#f-leader").value;
  const type = $("#f-type").value;
  const d0 = $("#f-date-from").value || state.meta.first_date;
  const d1 = $("#f-date-to").value || state.meta.last_date;
  const activityOnly = switchOn($("#f-activity"));
  const fullText = switchOn($("#f-fulltext"));

  // Full-text mode: make sure the transcript shards for the selected date
  // range are loaded before filtering (cached after first use).
  let contentByYear = null;
  if (fullText && q) {
    const years = state.meta.years.filter(
      (y) => y >= d0.slice(0, 4) && y <= d1.slice(0, 4));
    $("#result-count").textContent = "LOADING FULL TRANSCRIPTS…";
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

  state.monthCounts = new Map();
  for (const e of state.filtered) {
    const m = e.date.slice(0, 7);
    state.monthCounts.set(m, (state.monthCounts.get(m) || 0) + 1);
  }

  $("#result-count").textContent =
    `SHOWING ${state.filtered.length.toLocaleString()} MATCHING EVENTS` +
    (q ? ` · “${q.toUpperCase()}”${fullText ? " · INCL. FULL TEXT" : ""}` : "");
  $("#chart-count").innerHTML =
    `COUNT: <b>${state.filtered.length.toLocaleString()}</b> MATCHING EVENTS`;
  drawChart(d0, d1);
  renderList(false);
}

function renderList(more) {
  const list = $("#event-list");
  if (!more) { list.innerHTML = ""; state.shown = 0; state.lastMonth = null; }
  const next = state.filtered.slice(state.shown, state.shown + state.pageSize);
  state.shown += next.length;
  for (const e of next) {
    const m = e.date.slice(0, 7);
    if (m !== state.lastMonth) {
      state.lastMonth = m;
      const [y, mo] = m.split("-");
      const hd = document.createElement("div");
      hd.className = "group-hd";
      hd.innerHTML =
        `<b>${y} · ${MONTHS_FULL[+mo - 1]}</b><span class="rule"></span>` +
        `<span>${(state.monthCounts.get(m) || 0).toLocaleString()} EVENTS</span>`;
      list.appendChild(hd);
    }
    list.appendChild(eventCard(e));
  }
  $("#empty-note").hidden = state.filtered.length > 0;
  $("#more-btn").hidden = state.shown >= state.filtered.length;
}

function eventCard(e) {
  const div = document.createElement("div");
  div.className = "ev";
  const title = e.titleEn || glossEn(e);
  const mo = +e.date.slice(5, 7);
  const chips = e.leaders.map((id) =>
    `<span class="pill primary">${esc(leaderName(id))}</span>`).join("") +
    e.mentions.map((id) => `<span class="pill">${esc(leaderName(id))}</span>`).join("");
  div.innerHTML = `
    <div class="ev-day">
      <div class="num">${e.date.slice(8)}</div>
      <div class="mon">${MONTHS[mo - 1]}</div>
    </div>
    <div>
      <div class="ev-meta">
        <span class="chip${e.activity ? " act" : ""}"><i></i>${esc((state.typeLabels[e.type] || e.type).toUpperCase())}</span>
        <span class="code">${TYPE_CODES[e.type] || "OTH"}·${e.id}</span>
        ${e.location ? `<span class="code">📍 ${esc(e.location)}</span>` : ""}
      </div>
      <h3>${esc(title)}</h3>
      ${e.summaryEn ? `<p class="sum">${esc(e.summaryEn)}</p>` : ""}
      <div class="zh-line"><span class="lab">原文</span><span class="txt">${esc(e.titleZh)}</span></div>
      <div class="pills">${chips}</div>
      <div class="detail"></div>
    </div>`;
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
  if (e.counterpart) html += `<div class="lab">COUNTERPART</div><p>${esc(e.counterpart)}</p>`;
  html += `<div class="lab">ORIGINAL TRANSCRIPT 原文</div><p class="zh-full" id="zh-${e.id}">Loading…</p>`;
  box.innerHTML = html;
  try {
    const detail = await loadYearDetail(e.date.slice(0, 4));
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
function drawChart(d0, d1) {
  const svg = $("#chart-svg");
  svg.innerHTML = "";
  const counts = state.monthCounts;
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
  const W = 1000, H = 110, pad = 2, bottom = 16;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const max = Math.max(1, ...months.map((m) => counts.get(m) || 0));
  const step = (W - pad * 2) / months.length;
  const bw = Math.min(24, step - 1);
  const ns = "http://www.w3.org/2000/svg";

  const base = document.createElementNS(ns, "line");
  base.setAttribute("x1", 0); base.setAttribute("x2", W);
  base.setAttribute("y1", H - bottom); base.setAttribute("y2", H - bottom);
  base.setAttribute("stroke", "var(--line)");
  svg.appendChild(base);

  const tip = $("#tip");
  months.forEach((m, i) => {
    const v = counts.get(m) || 0;
    const h = Math.round((v / max) * (H - bottom - 8));
    const x = pad + i * step + (step - bw) / 2;
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", x); r.setAttribute("y", H - bottom - h);
    r.setAttribute("width", Math.max(1, bw));
    r.setAttribute("height", Math.max(h, v ? 1 : 0));
    r.setAttribute("rx", Math.min(2, bw / 2));
    r.setAttribute("fill", "var(--accent)");
    r.addEventListener("mousemove", (ev) => {
      tip.style.display = "block";
      tip.style.left = ev.clientX + 12 + "px";
      tip.style.top = ev.clientY + 12 + "px";
      tip.textContent = `${m} · ${v.toLocaleString()} EVENTS`;
    });
    r.addEventListener("mouseleave", () => (tip.style.display = "none"));
    svg.appendChild(r);
    if (m.endsWith("-01") || i === 0) {
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", x); t.setAttribute("y", H - 3);
      t.setAttribute("fill", "var(--faint)");
      t.setAttribute("font-size", "10");
      t.setAttribute("font-family", "'IBM Plex Mono', monospace");
      t.setAttribute("letter-spacing", "1");
      t.textContent = m.slice(0, 4);
      svg.appendChild(t);
    }
  });
}

/* ---------------- leaders view ---------------- */
function buildLeadersView() {
  // Last-seen date per leader (as primary actor or mention).
  const lastSeen = {};
  for (const e of state.events) {
    for (const id of e.leaders.concat(e.mentions))
      if (!lastSeen[id]) lastSeen[id] = e.date; // events are newest-first
  }
  const grid = $("#leader-grid");
  const ranked = state.leaders.filter((p) => p.count)
    .slice()
    .sort((a, b) => b.count - a.count);
  ranked.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "l-card";
    const last = lastSeen[p.id]
      ? `${MONTHS[+lastSeen[p.id].slice(5, 7) - 1]} ${lastSeen[p.id].slice(0, 4)}`
      : "—";
    const top = Object.entries(p.by_type).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([t, n]) => `<span>${esc((state.typeLabels[t] || t))} ${n.toLocaleString()}</span>`).join("");
    card.innerHTML = `
      <div class="top"><span>№${String(i + 1).padStart(2, "0")}</span><span>LAST ${last}</span></div>
      <div class="mid">
        <div><h3>${esc(p.name_en)}</h3><div class="zh">${esc(p.name_zh)}</div></div>
        <div class="n"><div class="v">${p.count.toLocaleString()}</div><div class="k">EVENTS</div></div>
      </div>
      <div class="role">${esc(p.roles)}</div>
      <div class="types">${top}</div>`;
    card.addEventListener("click", () => {
      $("#f-leader").value = p.id;
      switchView("events");
      applyFilters();
      location.hash = `leader=${p.id}`;
    });
    grid.appendChild(card);
  });
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
  for (const id of ["#n-year-from", "#n-year-to", "#n-min"])
    $(id).addEventListener("change", drawNetwork);
  wireSwitch($("#n-mentions"), drawNetwork);
}

function computeGraph() {
  const y0 = $("#n-year-from").value, y1 = $("#n-year-to").value;
  const minW = Math.max(1, +$("#n-min").value || 1);
  const useMentions = switchOn($("#n-mentions"));
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
    x: 0, y: 0, vx: 0, vy: 0,
  }));
  return { nodes, edges };
}

function drawNetwork() {
  const svg = $("#network-svg");
  svg.innerHTML = "";
  $("#n-selected").textContent = "FULL NETWORK";
  const { nodes, edges } = computeGraph();
  const W = svg.clientWidth || 1120, H = svg.clientHeight || 620;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (!nodes.length) return;
  $("#n-selected").textContent = `FULL NETWORK · ${nodes.length} NODES`;

  nodes.forEach((n, i) => {
    const a = (i / nodes.length) * Math.PI * 2;
    n.x = W / 2 + Math.cos(a) * Math.min(W, H) * 0.33;
    n.y = H / 2 + Math.sin(a) * Math.min(W, H) * 0.33;
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const maxW = Math.max(...edges.map((e) => e.w));
  const maxN = Math.max(...nodes.map((n) => n.n));
  const radius = (n) => 5 + 17 * Math.sqrt(n.n / maxN);

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
    nodeLayer.querySelectorAll(".node").forEach((g) => g.classList.remove("dim", "sel"));
    $("#n-selected").textContent = `FULL NETWORK · ${nodes.length} NODES`;
    info.innerHTML = "Click a node to inspect its strongest co-appearance partners.";
  };
  svg.addEventListener("click", (ev) => { if (ev.target === svg) reset(); });

  const svgPoint = (ev) => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };

  nodes.sort((a, b) => b.n - a.n);
  for (const n of nodes) {
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", "node");
    g.dataset.id = n.id;
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", n.x); c.setAttribute("cy", n.y);
    c.setAttribute("r", radius(n));
    g.appendChild(c);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", n.x + radius(n) + 4);
    t.setAttribute("y", n.y + 4);
    t.textContent = leaderName(n.id);
    g.appendChild(t);

    // Drag to reposition; a small movement still counts as a click.
    let dragged = false;
    g.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      dragged = false;
      const start = svgPoint(ev);
      const ox = n.x, oy = n.y;
      const move = (mv) => {
        const p = svgPoint(mv);
        if (Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 3) dragged = true;
        n.x = ox + p.x - start.x;
        n.y = oy + p.y - start.y;
        c.setAttribute("cx", n.x); c.setAttribute("cy", n.y);
        t.setAttribute("x", n.x + radius(n) + 4);
        t.setAttribute("y", n.y + 4);
        edges.forEach((e, i) => {
          if (e.a === n.id) {
            edgeEls[i].setAttribute("x1", n.x);
            edgeEls[i].setAttribute("y1", n.y);
          } else if (e.b === n.id) {
            edgeEls[i].setAttribute("x2", n.x);
            edgeEls[i].setAttribute("y2", n.y);
          }
        });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });

    g.addEventListener("click", () => {
      if (dragged) { dragged = false; return; }
      reset();
      g.classList.add("sel");
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
      $("#n-selected").textContent = `ISOLATED: ${(p.name_en || n.id).toUpperCase()}`;
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

/* ---------------- export (password-gated XLSX) ---------------- */
// SHA-256 of the export password; a client-side gate on a public static
// site is a deterrent only — the underlying JSON in data/ is public.
const EXPORT_PASS_SHA256 =
  "c809c86f60f6eb45228c990fd24ccde2650440c7c95ea92b32754906210a36d3";

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function wireExport() {
  const pop = $("#dl-pop"), pass = $("#dl-pass"), err = $("#dl-err");
  $("#dl-btn").addEventListener("click", () => {
    if (sessionStorage.getItem("dlAuth") === "1") { exportXlsx(); return; }
    pop.hidden = !pop.hidden;
    if (!pop.hidden) { err.hidden = true; pass.value = ""; pass.focus(); }
  });
  const submit = async () => {
    if ((await sha256Hex(pass.value)) === EXPORT_PASS_SHA256) {
      sessionStorage.setItem("dlAuth", "1");
      pop.hidden = true;
      exportXlsx();
    } else {
      err.hidden = false;
      pass.select();
    }
  };
  $("#dl-go").addEventListener("click", submit);
  pass.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !e.target.closest(".dl-wrap")) pop.hidden = true;
  });
}

function xmlEsc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function colRef(n) {
  let s = "";
  for (n++; n; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(64 + ((n - 1) % 26) + 1) + s;
  return s;
}

function sheetXml(rows) {
  const body = rows.map((row, ri) =>
    `<row r="${ri + 1}">` + row.map((v, ci) =>
      `<c r="${colRef(ci)}${ri + 1}" t="inlineStr">` +
      `<is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`
    ).join("") + "</row>").join("");
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/' +
    'spreadsheetml/2006/main"><sheetData>' + body +
    "</sheetData></worksheet>";
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Minimal ZIP writer, entries stored uncompressed — enough for an .xlsx.
function zipStore(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) |
                  (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) |
                  ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.text);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);       // version needed to extract
    lh.setUint16(6, 0x0800, true);   // UTF-8 filenames
    lh.setUint16(8, 0, true);        // stored (no compression)
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, a) => s + a.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function exportXlsx() {
  const rows = [["Date", "Type", "Title (ZH)", "Title (EN)", "Summary (EN)",
                 "Leaders", "Mentions", "Counterpart", "Location",
                 "Event ID"]];
  for (const e of state.filtered) {
    rows.push([
      e.date,
      state.typeLabels[e.type] || e.type,
      e.titleZh,
      e.titleEn || "",
      e.summaryEn || "",
      e.leaders.map(leaderName).join("; "),
      e.mentions.map(leaderName).join("; "),
      e.counterpart || "",
      e.location || "",
      e.id,
    ]);
  }
  const XMLNS_PKG = "http://schemas.openxmlformats.org/package/2006";
  const XMLNS_DOC = "http://schemas.openxmlformats.org/officeDocument/2006";
  const files = [
    { name: "[Content_Types].xml", text:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<Types xmlns="${XMLNS_PKG}/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.' +
      'openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.' +
      'openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType=' +
      '"application/vnd.openxmlformats-officedocument.spreadsheetml.' +
      'worksheet+xml"/></Types>' },
    { name: "_rels/.rels", text:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<Relationships xmlns="${XMLNS_PKG}/relationships">` +
      `<Relationship Id="rId1" Type="${XMLNS_DOC}/relationships/` +
      'officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: "xl/workbook.xml", text:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/' +
      `2006/main" xmlns:r="${XMLNS_DOC}/relationships"><sheets>` +
      '<sheet name="Events" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: "xl/_rels/workbook.xml.rels", text:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<Relationships xmlns="${XMLNS_PKG}/relationships">` +
      `<Relationship Id="rId1" Type="${XMLNS_DOC}/relationships/worksheet" ` +
      'Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: "xl/worksheets/sheet1.xml", text: sheetXml(rows) },
  ];
  const d0 = $("#f-date-from").value || state.meta.first_date;
  const d1 = $("#f-date-to").value || state.meta.last_date;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zipStore(files));
  a.download = `china-leadership-tracker_${d0}_${d1}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
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
  document.body.insertAdjacentHTML("beforeend",
    `<p style="color:#d9503f;padding:20px 28px;font-family:'IBM Plex Mono',monospace">FAILED TO LOAD DATA: ${esc(err.message)}</p>`);
  console.error(err);
});
