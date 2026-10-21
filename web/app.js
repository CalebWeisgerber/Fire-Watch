/* Fire-Watch front end. All numbers come from precomputed JSON in data/ (scripts/analyze.py,
   scripts/build_staging.py); the browser only filters, groups and draws. */
(() => {
  "use strict";

  const EMBER = "#d9531e", EMBER_SOFT = "rgba(217,83,30,.55)", GREY = "#9aa5b1", RAIN = "#2f6fae", SLATE = "#1f2a37";
  const CAUSE_COLORS = ["#2f6fae", "#d9531e", "#e8a33d", "#8c6bb1", "#6b8e23", "#b22222", "#e377c2", "#17becf", "#b0b7c0"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const WA_BOUNDS = [[45.55, -124.8], [49.0, -116.9]];

  const S = { area: "ALL", tab: "plan", seasonEra: 0, charts: {}, maps: {} };
  let D = {};

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 0) => (n == null || isNaN(n) ? "–" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const weekLabel = (w) => { const d = new Date(2001, 0, 1 + (w - 1) * 7 + 3); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
  const doyLabel = (n) => { const d = new Date(2001, 0, n); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
  const areaInfo = (k) => D.meta.areas.find((a) => a.key === k);
  const areaName = (k = S.area) => areaInfo(k).name;
  const regionOf = (k = S.area) => { const a = areaInfo(k); return a.type === "region" ? k : a.type === "county" ? a.region : null; };

  function chart(id, config) {
    if (S.charts[id]) S.charts[id].destroy();
    config.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: false }, config.options || {});
    S.charts[id] = new Chart($(id), config);
  }

  function areaCountySet(k) {
    const a = areaInfo(k);
    if (a.type === "state") return null;
    if (a.type === "county") return new Set([D.fires.counties.indexOf(k)]);
    const ri = D.fires.regions.indexOf(k);
    return new Set(D.fires.county_region.map((r, i) => (r === ri ? i : -1)).filter((i) => i >= 0));
  }

  // ---------- load ----------
  async function load() {
    const names = ["meta", "demand", "calendar", "causes", "weather_link", "coverage", "holdout", "allocation", "fires", "stations", "staging"];
    const got = await Promise.all(names.map((n) => fetch(`data/${n}.json`).then((r) => { if (!r.ok) throw new Error(n); return r.json(); })));
    names.forEach((n, i) => (D[n] = got[i]));
    const geo = (n) => fetch(`data/${n}.geojson`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    [D.regionsGeo, D.countiesGeo] = await Promise.all([geo("dnr_regions"), geo("counties")]);
    const F = D.fires.fields, ix = Object.fromEntries(F.map((f, i) => [f, i]));
    // month from day-of-year (non-leap calendar is close enough for monthly filtering)
    const monthOf = (doy) => new Date(2001, 0, doy).getMonth() + 1;
    D.fireRows = D.fires.rows.map((r) => ({ era: r[ix.era], year: r[ix.year], month: monthOf(r[ix.doy]), county: r[ix.county], cause: r[ix.cause], acres: r[ix.acres], lat: r[ix.lat], lon: r[ix.lon] }));
    const SF = D.staging.fields;
    D.stRows = D.staging.rows.map((r) => Object.fromEntries(SF.map((f, i) => [f, r[i]])));
  }

  // ---------- picker + tabs ----------
  function initPicker() {
    const sel = $("area");
    const groups = { state: [], region: [], county: [] };
    D.meta.areas.forEach((a) => groups[a.type].push(a));
    const add = (label, list) => {
      const og = document.createElement("optgroup"); og.label = label;
      list.sort((a, b) => a.name.localeCompare(b.name)).forEach((a) => og.append(new Option(a.name, a.key)));
      sel.append(og);
    };
    groups.state.forEach((a) => sel.append(new Option(a.name, a.key)));
    add("DNR regions", groups.region);
    add("Counties", groups.county);
    sel.value = S.area;
    sel.addEventListener("change", () => { S.area = sel.value; render(); });
    // Any element with data-area (table rows) drills into that area.
    const drill = (e) => { const tr = e.target.closest("[data-area]"); if (tr) setArea(tr.dataset.area); };
    document.querySelector("main").addEventListener("click", drill);
    document.querySelector("main").addEventListener("keydown", (e) => { if (e.key === "Enter") drill(e); });
  }

  function setArea(k) {
    S.area = k; $("area").value = k; render();
  }

  function initTabs() {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const select = (t) => {
      tabs.forEach((b) => { const on = b === t; b.setAttribute("aria-selected", on); b.tabIndex = on ? 0 : -1; $(b.getAttribute("aria-controls")).hidden = !on; });
      S.tab = t.id.replace("tab-", "");
      render();
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(t));
      t.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (d) { const n = tabs[(i + d + tabs.length) % tabs.length]; n.focus(); select(n); }
      });
    });
  }

  // ---------- maps ----------
  function baseMap(id) {
    // The panel was just un-hidden, so re-measure before any heat layer draws (it fails on a 0-size canvas).
    if (S.maps[id]) { S.maps[id].map.invalidateSize(false); return S.maps[id]; }
    const map = L.map(id, { preferCanvas: true, zoomSnap: 0.5 });
    map.fitBounds(WA_BOUNDS);
    // Standard OSM tiles (no key). Muted with CSS so the fire layers stand out.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 16, className: "muted-tiles",
    }).addTo(map);
    const counties = D.countiesGeo
      ? L.geoJSON(D.countiesGeo, { style: { color: "#7b8794", weight: 0.7, fill: false, opacity: 0.6 }, interactive: false }).addTo(map) : null;
    const outline = D.regionsGeo
      ? L.geoJSON(D.regionsGeo, { style: { color: "#56616e", weight: 1.6, fill: false, opacity: 0.8 }, interactive: false }).addTo(map) : null;
    S.maps[id] = { map, outline, counties, layers: [] };
    return S.maps[id];
  }

  function clearLayers(m) { m.layers.forEach((l) => m.map.removeLayer(l)); m.layers = []; }

  // Zoom to the selected area using its real boundary (county or region polygon), else WA.
  function zoomToArea(m, key = S.area) {
    const a = areaInfo(key);
    let layer = null;
    if (a.type === "county" && m.counties) layer = m.counties.getLayers().find((l) => l.feature.properties.JURISDICT_LABEL_NM.toUpperCase() === key);
    if (a.type === "region" && m.outline) layer = m.outline.getLayers().find((l) => l.feature.properties.JURISDICT_LABEL_NM === a.name);
    if (layer) m.map.fitBounds(layer.getBounds(), { padding: [16, 16] });
    else m.map.fitBounds(WA_BOUNDS);
  }

  function highlightRegion(m) {
    const a = areaInfo(S.area), r = regionOf(), label = r ? areaName(r) : null;
    if (m.outline) m.outline.setStyle((f) => {
      const on = f.properties.JURISDICT_LABEL_NM === label;
      return { color: on ? SLATE : "#56616e", weight: on ? 3 : 1.6, fill: false, opacity: 0.8 };
    });
    if (m.counties) m.counties.setStyle((f) => {
      const on = a.type === "county" && f.properties.JURISDICT_LABEL_NM.toUpperCase() === S.area;
      return { color: on ? SLATE : "#7b8794", weight: on ? 2.5 : 0.7, fill: false, opacity: on ? 1 : 0.6 };
    });
  }

  function areaFires(filterFn) {
    const set = areaCountySet(S.area);
    return D.fireRows.filter((f) => (!set || set.has(f.county)) && (!filterFn || filterFn(f)));
  }

  // ---------- Where (map + filters) ----------
  const F = { from: 1970, to: 2026, months: "1-12", cause: "all", acres: 0, stations: false };
  const POINT_ZOOM = 9;          // at/after this zoom, individual fires are drawn as dots
  const HEAT_GRADIENT = { 0.3: "#fdd49e", 0.6: "#fc8d59", 0.85: "#d7301f", 1: "#7f0000" };

  function initWhereControls() {
    const cs = $("ov-cause");
    cs.append(new Option("All causes", "all"), new Option("Human-caused only", "human"));
    D.meta.causes.forEach((c, i) => cs.append(new Option(c, String(i))));
    const from = $("yr-from"), to = $("yr-to");
    const syncYears = (src) => {
      let a = +from.value, b = +to.value;
      if (a > b) { if (src === from) b = a; else a = b; from.value = a; to.value = b; }
      F.from = a; F.to = b; renderWhere();
    };
    from.addEventListener("input", () => syncYears(from));
    to.addEventListener("input", () => syncYears(to));
    document.querySelectorAll(".presets button").forEach((b) => b.addEventListener("click", () => {
      const [a, z] = b.dataset.yr.split(",").map(Number);
      from.value = a; to.value = z; F.from = a; F.to = z; renderWhere();
    }));
    $("ov-months").addEventListener("change", (e) => { F.months = e.target.value; renderWhere(); });
    $("ov-cause").addEventListener("change", (e) => { F.cause = e.target.value; renderWhere(); });
    $("ov-acres").addEventListener("change", (e) => { F.acres = +e.target.value; renderWhere(); });
    $("ov-stations").addEventListener("change", (e) => { F.stations = e.target.checked; renderWhere(); });
    $("ov-reset").addEventListener("click", () => {
      Object.assign(F, { from: 1970, to: 2026, months: "1-12", cause: "all", acres: 0 });
      from.value = 1970; to.value = 2026; $("ov-months").value = "1-12"; $("ov-cause").value = "all"; $("ov-acres").value = "0";
      renderWhere();
    });
  }

  function filteredFires() {
    const [m0, m1] = F.months.split("-").map(Number);
    const cause = F.cause === "all" ? null : F.cause === "human" ? "human" : +F.cause;
    return areaFires((f) => f.year >= F.from && f.year <= F.to && f.month >= m0 && f.month <= m1 && f.acres >= F.acres &&
      (cause === null || (cause === "human" ? D.meta.human[f.cause] : f.cause === cause)));
  }

  function dotStyle(f) {
    const r = Math.max(2.5, Math.min(14, 2.5 + 2 * Math.log10(1 + f.acres)));
    return { radius: r, color: "#7f0000", weight: 0.6, fillColor: f.era === 0 ? EMBER : "#c0392b", fillOpacity: 0.65 };
  }

  function drawFireLayer(m, fires) {
    if (m.fireLayer) { m.map.removeLayer(m.fireLayer); m.fireLayer = null; }
    const located = fires.filter((f) => f.lat != null);
    if (m.map.getZoom() >= POINT_ZOOM) {
      const b = m.map.getBounds().pad(0.2);
      const inView = located.filter((f) => b.contains([f.lat, f.lon]));
      const g = L.layerGroup(inView.map((f) => L.circleMarker([f.lat, f.lon], dotStyle(f))
        .bindPopup(`<strong>${MONTHS[f.month - 1]} ${f.year}</strong><br>${esc(D.meta.causes[f.cause])}<br>${fmt(f.acres, f.acres < 10 ? 2 : 0)} acres<br>${esc(areaName(D.fires.counties[f.county]))} County`)));
      m.fireLayer = g.addTo(m.map);
    } else {
      // weight by size a little so big fires show, but keep density readable
      const pts = located.map((f) => [f.lat, f.lon, 0.35 + Math.min(0.65, Math.log10(1 + f.acres) / 4)]);
      m.fireLayer = L.heatLayer(pts, { radius: 8, blur: 10, minOpacity: 0.25, max: 1, gradient: HEAT_GRADIENT }).addTo(m.map);
    }
  }

  function renderWhere() {
    const fires = filteredFires();
    const n = fires.length, acres = sum(fires.map((f) => f.acres));
    const known = fires.filter((f) => f.cause !== D.meta.causes.length - 1);
    const human = known.length ? (100 * known.filter((f) => D.meta.human[f.cause]).length) / known.length : null;
    const byMonth = MONTHS.map((_, i) => fires.filter((f) => f.month === i + 1).length);
    const peakM = n ? byMonth.indexOf(Math.max(...byMonth)) : -1;
    const big = fires.filter((f) => f.acres >= 100);
    const bigShare = acres ? (100 * sum(big.map((f) => f.acres))) / acres : null;
    const yrs = F.to - F.from + 1;
    const span = F.from === F.to ? `${F.from}` : `${F.from}–${F.to}`;

    $("yr-label").textContent = span;
    $("yr-dual").style.setProperty("--a", `${((F.from - 1970) / 56) * 100}%`);
    $("yr-dual").style.setProperty("--b", `${((F.to - 1970) / 56) * 100}%`);
    document.querySelectorAll(".presets button").forEach((b) => b.classList.toggle("on", b.dataset.yr === `${F.from},${F.to}`));
    $("ov-count").textContent = `${fmt(n)} fires match`;

    $("kpis").innerHTML = [
      { v: fmt(n), l: `Fires, ${span}`, s: `${fmt(n / yrs, 0)} per year` },
      { v: fmt(acres), l: "Acres burned", s: big.length ? `${fmt(bigShare, 0)}% from ${fmt(big.length)} fires ≥ 100 ac` : "No fires ≥ 100 ac" },
      { v: peakM >= 0 ? MONTHS[peakM] : "–", l: "Busiest month", s: peakM >= 0 ? `${fmt((100 * byMonth[peakM]) / n, 0)}% of fires` : "" },
      { v: human != null ? `${fmt(human, 0)}%` : "–", l: "Human-caused", s: "of known causes · DNR says ~85%" },
    ].map((x) => `<div class="kpi"><div class="v">${x.v}</div><div class="l">${x.l}</div><div class="s">${x.s}</div></div>`).join("");
    $("take-overview").textContent = n
      ? `${areaName()}, ${span}: ${fmt(n)} fires burned ${fmt(acres)} acres. ${big.length ? `Just ${fmt((100 * big.length) / n, 1)}% of fires (≥ 100 ac) made up ${fmt(bigShare, 0)}% of the acres.` : ""}`
      : "No fires match these filters. Try widening the years or cause.";

    const m = baseMap("map");
    if (!m.zoomHooked) { m.map.on("zoomend moveend", () => { if (S.tab === "where") drawFireLayer(m, filteredFires()); }); m.zoomHooked = true; }
    clearLayers(m); highlightRegion(m);
    if (m.lastArea !== S.area) { zoomToArea(m); m.lastArea = S.area; }
    if (F.stations) {
      const st = L.layerGroup(D.stations.map(([la, lo]) => L.circleMarker([la, lo], { radius: 3.5, color: "#fff", weight: 1, fillColor: RAIN, fillOpacity: 1 })
        .bindTooltip("Fire station"))).addTo(m.map);
      m.layers.push(st);
    }
    drawFireLayer(m, fires);
    renderCoverageTable();
  }

  // ---------- Trends ----------
  function renderTrends() {
    const dm = D.demand[S.area], y = dm.yearly, cs = D.causes[S.area];
    const colors = y.years.map((yr) => (yr < 2008 ? EMBER : GREY));
    chart("c-count", { type: "bar", data: { labels: y.years, datasets: [{ label: "Fires", data: y.count, backgroundColor: colors }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { title: { display: true, text: "fires" } } } } });
    chart("c-acres", { type: "bar", data: { labels: y.years, datasets: [{ label: "Acres", data: y.acres, backgroundColor: colors }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { type: "logarithmic", title: { display: true, text: "acres (log scale)" } } } } });
    const old = y.count.slice(0, 38), peakIdx = old.indexOf(Math.max(...old));
    const bigIdx = y.acres.indexOf(Math.max(...y.acres));
    $("take-trends").textContent = `Fire counts trended ${dm.trend} (${fmt(Math.abs(dm.trend_pct_per_decade))}% per decade, 1970–2007). Busiest year: ${y.years[peakIdx]} (${fmt(old[peakIdx])} fire${old[peakIdx] === 1 ? "" : "s"}). Most acres: ${y.years[bigIdx]} (${fmt(y.acres[bigIdx])} ac).`;
  }

  function renderCauses() {
    const cs = D.causes[S.area];
    chart("c-causes", { type: "bar",
      data: { labels: cs.decades, datasets: D.meta.causes.map((c, i) => ({ label: c, data: cs.share.map((s) => s[i]), backgroundColor: CAUSE_COLORS[i] })) },
      options: { scales: { x: { stacked: true }, y: { stacked: true, max: 100, title: { display: true, text: "% of fires" } } }, plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } } } });
    const hs = cs.human_share, first = hs.find((v) => v != null), last = [...hs].reverse().find((v) => v != null);
    $("take-causes").textContent = `About ${fmt(last)}% of known-cause fires are human-caused (${cs.decades[cs.decades.length - 1]}), vs ${fmt(first)}% in the ${cs.decades[0]}. Most are preventable.`;
  }

  // ---------- Season ----------
  function renderSeason() {
    const keys = ["ALL", ...D.fires.regions];
    const sel = regionOf() || "ALL";
    const era = S.seasonEra;
    let html = `<div></div>` + Array.from({ length: 52 }, (_, i) => `<div class="ax">${i % 9 === 0 ? weekLabel(i + 1) : ""}</div>`).join("");
    keys.forEach((k) => {
      const w = D.calendar[k].weeks[era], tot = sum(w) || 1, mx = Math.max(...w) / tot || 1;
      html += `<div class="rl ${k === sel ? "sel" : ""}" title="${esc(areaName(k))}">${esc(areaName(k))}</div>`;
      html += w.map((v, i) => { const a = (v / tot) / mx; return `<div class="cell ${k === sel ? "sel" : ""}" style="background:rgba(217,83,30,${a.toFixed(3)})" title="${esc(areaName(k))}, week of ${weekLabel(i + 1)}: ${fmt(v)} fires"></div>`; }).join("");
    });
    $("heat-grid").innerHTML = html;
    const cal = D.calendar[S.area], p0 = cal.peak_week[0], p1 = cal.peak_week[1];
    const shift = p0 && p1 ? p1 - p0 : null;
    $("take-season").textContent = `${areaName()} fires peaked around ${weekLabel(p0)} in 1970–2007` +
      (p1 ? ` and around ${weekLabel(p1)} since 2008 (${shift === 0 ? "no change" : `${Math.abs(shift)} week${Math.abs(shift) === 1 ? "" : "s"} ${shift < 0 ? "earlier" : "later"}`}).` : ".");
    const decs = Object.keys(cal.season);
    chart("c-season", { type: "bar",
      data: { labels: decs, datasets: [{ label: "Season window (10th–90th pct)", data: decs.map((d) => [cal.season[d].start, cal.season[d].end]), backgroundColor: decs.map((d) => (parseInt(d) < 2008 ? EMBER_SOFT : "rgba(154,165,177,.7)")) }] },
      options: { indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${doyLabel(c.raw[0])} – ${doyLabel(c.raw[1])} (${c.raw[1] - c.raw[0]} days)` } } },
        scales: { x: { min: 1, max: 365, ticks: { callback: (v) => doyLabel(v), stepSize: 30.4 } } } } });
    if (decs.length >= 2) {
      const a = cal.season[decs[0]], b = cal.season[decs[decs.length - 1]];
      $("take-length").textContent = `The middle 80% of fires spanned ${a.days} days in the ${decs[0]} and ${b.days} days in the ${decs[decs.length - 1]} (${b.days >= a.days ? "+" : ""}${b.days - a.days} days).`;
    } else $("take-length").textContent = "Too few fires in this area to estimate the season window.";
  }

  // ---------- Weather ----------
  function renderWeather() {
    const w = D.weather_link[S.area];
    if (!w || !w.terciles) {
      $("take-weather").textContent = `Weather for ${areaName()} isn't available yet. The county weather download may still be running; rerun scripts/analyze.py when it finishes.`;
      ["c-scatter", "c-terciles"].forEach((id) => { if (S.charts[id]) { S.charts[id].destroy(); delete S.charts[id]; } });
      $("weather-r").textContent = ""; $("weather-cuts").textContent = "";
      return;
    }
    const pts = (era) => w.rows.filter((r) => r.rain_pct != null && r.year < 2026 && (era === 0 ? r.year < 2008 : r.year >= 2008)).map((r) => ({ x: r.rain_pct, y: Math.max(r.acres, 1), year: r.year }));
    const tYear = w.this_year;
    const ds = [
      { label: "1970–2007", data: pts(0), backgroundColor: EMBER },
      { label: "2008–2025", data: pts(1), backgroundColor: GREY },
    ];
    chart("c-scatter", { type: "scatter", data: { datasets: ds },
      options: { plugins: { tooltip: { callbacks: { label: (c) => `${c.raw.year}: ${fmt(c.raw.x)}% spring rain, ${fmt(c.raw.y)} summer ac` } },
        annotation: undefined },
        scales: { x: { title: { display: true, text: "Apr–Jun rain, % of 1970–2007 normal" } }, y: { type: "logarithmic", title: { display: true, text: "Jul–Sep acres (log)" } } } } });
    const T = w.terciles, T2 = w.terciles_2008;
    chart("c-terciles", { type: "bar",
      data: { labels: ["Dry spring", "Normal spring", "Wet spring"], datasets: [
        { label: "1970–2007 median summer acres", data: ["dry", "normal", "wet"].map((g) => T[g].median_acres), backgroundColor: [EMBER, "#e8a37a", RAIN] },
        { label: "2008–2025", data: ["dry", "normal", "wet"].map((g) => T2 && T2[g].median_acres), backgroundColor: "rgba(154,165,177,.8)" } ] },
      options: { scales: { y: { title: { display: true, text: "median Jul–Sep acres" } } }, plugins: { legend: { position: "bottom" } } } });
    const r = w.r.rain_pct.log_acres, rt = w.r.tmax.log_acres;
    $("weather-r").textContent = `Pearson r (1970–2007, vs. log acres): spring rain ${fmt(r, 2)}, Jul–Aug max temp ${fmt(rt, 2)}, longest dry streak ${fmt(w.r.dry_streak.log_acres, 2)}.` +
      (w.counties_with_weather < w.counties_total ? ` Weather loaded for ${w.counties_with_weather} of ${w.counties_total} counties.` : "");
    $("weather-cuts").textContent = `Dry ≤ ${fmt(w.cuts[0])}% of normal, wet > ${fmt(w.cuts[1])}%. ${T.dry.years}/${T.normal.years}/${T.wet.years} years.`;
    const ratio = T.dry_vs_wet_acres;
    const thisLine = tYear.tercile ? ` ${tYear.year} spring came in at ${fmt(tYear.rain_pct)}% of normal: a ${tYear.tercile} spring.` : "";
    $("take-weather").textContent = ratio != null
      ? `${S.area === "ALL" ? "Across DNR-protected lands" : `In ${areaName()}`}, dry springs were followed by ${fmt(ratio, 1)}× the median summer acres of wet springs (1970–2007).${thisLine}`
      : `Spring rain and summer acres for ${areaName()}.${thisLine}`;
  }

  // ---------- Coverage (table under the Where map) ----------
  function renderCoverageTable() {
    const c = D.coverage[S.area];
    $("cov-summary").textContent = c ? `${fmt(c.pct_far, 0)}% of fires >${D.meta.far_miles} mi out` : "";
    $("take-coverage").textContent = c
      ? `${fmt(c.pct_far, 1)}% of ${areaName()} fires (all years) started more than ${D.meta.far_miles} mi from today's nearest station, and they account for ${fmt(c.acres_far_share, 0)}% of acres burned. Turn on "Fire stations" above to see them.`
      : "No located fires for this area.";
    const set = areaCountySet(S.area);
    const rows = D.fires.counties.map((name, i) => ({ name, i, c: D.coverage[name] })).filter((r) => r.c && r.c.gap_score != null)
      .sort((a, b) => b.c.gap_score - a.c.gap_score);
    $("gap-table").innerHTML = `<caption class="sr-only">Counties ranked by coverage gap score</caption>
      <thead><tr><th>County</th><th class="num">Gap</th><th class="num">Median mi</th><th class="num">% fires &gt;10 mi</th><th class="num">Acres &gt;10 mi</th></tr></thead><tbody>` +
      rows.map((r) => `<tr class="${set && set.has(r.i) ? "sel" : ""} clickable" data-area="${esc(r.name)}" tabindex="0"><td>${esc(areaName(r.name))}</td><td class="num"><span class="bar" style="width:${r.c.gap_score * 0.4}px"></span> ${r.c.gap_score}</td><td class="num">${fmt(r.c.median_mi, 1)}</td><td class="num">${fmt(r.c.pct_far, 0)}%</td><td class="num">${fmt(r.c.acres_far)}</td></tr>`).join("") + "</tbody>";
  }

  // ---------- Staging & prevention ----------
  const isHuman = (ci) => !D.staging.human_exclude.includes(D.staging.causes[ci]);
  const isFail = (r) => (r.hours || 0) > D.staging.ia_fail.hours || r.acres > D.staging.ia_fail.acres;
  const causeIs = (r, ...names) => names.includes(D.staging.causes[r.cause]);
  const FULL_YEARS = 2025 - 2008 + 1;

  function severity(r, mode) {
    const h = Math.min(r.hours || 0, 72) / 72;
    const t = Math.min(Math.log1p(r.timber) / Math.log1p(500), 1);
    return mode === "hours" ? h : mode === "timber" ? t : 0.5 * h + 0.5 * t;
  }

  // Deterministic weighted k-means (farthest-point seeding) on equirectangular coords.
  function stagingCenters(pts, k) {
    if (!pts.length) return [];
    k = Math.min(k, pts.length);
    const cx = Math.cos((47.3 * Math.PI) / 180);
    const d2 = (p, c) => ((p.lat - c.lat) ** 2) + (((p.lon - c.lon) * cx) ** 2);
    const centers = [pts.reduce((a, b) => (b.w > a.w ? b : a))].map((p) => ({ lat: p.lat, lon: p.lon }));
    while (centers.length < k) {
      let best = null, bv = -1;
      pts.forEach((p) => { const v = p.w * Math.min(...centers.map((c) => d2(p, c))); if (v > bv) { bv = v; best = p; } });
      centers.push({ lat: best.lat, lon: best.lon });
    }
    let assign = [];
    for (let it = 0; it < 30; it++) {
      assign = pts.map((p) => { let bi = 0, bd = Infinity; centers.forEach((c, i) => { const d = d2(p, c); if (d < bd) { bd = d; bi = i; } }); return bi; });
      centers.forEach((c, i) => {
        const mem = pts.filter((_, j) => assign[j] === i), W = sum(mem.map((p) => p.w));
        if (W > 0) { c.lat = sum(mem.map((p) => p.lat * p.w)) / W; c.lon = sum(mem.map((p) => p.lon * p.w)) / W; }
      });
    }
    return centers.map((c, i) => { const mem = pts.filter((_, j) => assign[j] === i); return { ...c, n: mem.length, hours: median(mem.map((p) => p.hours).filter((h) => h != null)), timber: sum(mem.map((p) => p.timber)) }; })
      .sort((a, b) => b.n - a.n);
  }

  function initStagingControls() {
    const ms = $("st-month");
    MONTHS.forEach((m, i) => ms.append(new Option(new Date(2001, i, 1).toLocaleString("en-US", { month: "long" }), i + 1)));
    ms.value = 8;
    ["st-month", "st-teams", "st-weight"].forEach((id) => $(id).addEventListener("change", render));
  }

  function renderStaging() {
    const month = +$("st-month").value, teams = +$("st-teams").value, mode = $("st-weight").value;
    const reg = regionOf(), ri = reg ? D.staging.regions.indexOf(reg) : -1;
    const inReg = D.stRows.filter((r) => ri < 0 || r.region === ri);
    const inMonth = inReg.filter((r) => r.month === month);
    const full = inMonth.filter((r) => r.year <= 2025);
    const fails = inMonth.filter(isFail);
    const label = reg ? areaName(reg) : "All DNR regions";
    const mName = $("st-month").selectedOptions[0].text;
    $("mx-region").textContent = label;

    const hrs = inMonth.map((r) => r.hours).filter((h) => h != null);
    const sharedAll = inMonth.length ? (100 * inMonth.filter((r) => r.shared).length) / inMonth.length : null;
    const sharedFail = fails.length ? (100 * fails.filter((r) => r.shared).length) / fails.length : null;
    const failElev = median(fails.map((r) => r.elev).filter((e) => e != null && e > 0));
    const allElev = median(inMonth.map((r) => r.elev).filter((e) => e != null && e > 0));
    // secondary facts go into the takeaway instead of extra tiles
    const extra = [
      sharedFail != null ? `${fmt(sharedFail, 0)}% of failures were on shared jurisdiction (vs ${fmt(sharedAll, 0)}% of all fires)` : null,
      failElev && allElev ? `failures start higher (median ${fmt(failElev)} ft vs ${fmt(allElev)} ft)` : null,
    ].filter(Boolean);
    $("st-kpis").innerHTML = [
      { v: fmt(full.length / FULL_YEARS, 0), l: `Fires per ${mName} (2008–2025 avg)`, s: `${fmt(inMonth.length)} total` },
      { v: `${fmt(inMonth.length ? (100 * fails.length) / inMonth.length : null, 1)}%`, l: "Escaped initial attack", s: `>24 h to control or >100 ac · ${fmt(fails.length)} fires` },
      { v: `${fmt(median(hrs), 1)} h`, l: "Median hours to control", s: `Failures: ${fmt(median(fails.map((r) => r.hours).filter((h) => h != null)), 0)} h` },
      { v: fmt(sum(full.map((r) => r.timber)) / FULL_YEARS, 0), l: "Timber acres lost / yr", s: "Merchantable + reproduction" },
    ].map((x) => `<div class="kpi"><div class="v">${x.v}</div><div class="l">${x.l}</div><div class="s">${x.s}</div></div>`).join("");

    // map
    const m = baseMap("map3");
    clearLayers(m); highlightRegion(m);
    const heatPts = inMonth.map((r) => [r.lat, r.lon, severity(r, mode)]).filter((p) => p[2] > 0);
    m.layers.push(L.heatLayer(heatPts, { radius: 14, blur: 16, max: 1, minOpacity: 0.25, gradient: { 0.3: "#fdd49e", 0.6: "#fc8d59", 0.85: "#d7301f", 1: "#7f0000" } }).addTo(m.map));
    const centers = stagingCenters(fails.map((r) => ({ lat: r.lat, lon: r.lon, w: 0.15 + severity(r, mode), hours: r.hours, timber: r.timber })), teams);
    centers.forEach((c, i) => {
      const mk = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: "", html: `<div class="stage-pin">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }), keyboard: true, title: `Staging point ${i + 1}` })
        .bindPopup(`<strong>Staging point ${i + 1}</strong><br>${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}<br>${c.n} IA failures nearby (${mName}, 2008+)<br>Median ${fmt(c.hours, 0)} h to control<br>${fmt(c.timber)} timber ac lost`);
      mk.addTo(m.map); m.layers.push(mk);
    });
    if (m.lastArea !== S.area) { zoomToArea(m, reg || "ALL"); m.lastArea = S.area; }
    $("take-staging").textContent = fails.length
      ? `In ${mName}, ${label} averages ${fmt(full.length / FULL_YEARS, 0)} fires; ${fmt(fails.length)} since 2008 escaped initial attack. Stage ${centers.length > 1 ? `${centers.length} strike teams` : "one strike team"} at the numbered pins.${extra.length ? ` Note: ${extra.join("; ")}.` : ""}`
      : `${label} has no initial-attack failures on record in ${mName} since 2008. Routine staffing is likely enough.`;

    // prevention: use month if enough data, else fall back to all months
    const pick = (fn, min = 30) => { const a = inMonth.filter(fn); return a.length >= min ? [a, mName] : [inReg.filter(fn), "all months"]; };

    const [rec, recScope] = pick((r) => causeIs(r, "Celebration", "Recreation"));
    const dow = DAYS.map((_, d) => rec.filter((r) => r.dow === d).length);
    const wkend = rec.length ? (100 * (dow[4] + dow[5] + dow[6])) / rec.length : null;
    const recElev = rec.filter((r) => r.elev > 0), highShare = recElev.length ? (100 * recElev.filter((r) => r.elev > 2500).length) / recElev.length : null;
    chart("c-dow", { type: "bar", data: { labels: DAYS, datasets: [{ label: "Recreation / campfire fires", data: dow, backgroundColor: DAYS.map((_, i) => (i >= 4 ? EMBER : "#e8b49a")) }] }, options: { plugins: { legend: { display: false } } } });
    $("take-dow").textContent = rec.length
      ? `${fmt(wkend, 0)}% of ${fmt(rec.length)} campfire/recreation fires (${recScope}) start Fri–Sun, vs 43% if spread evenly. ${highShare != null ? `${fmt(highShare, 0)}% are above 2,500 ft.` : ""} Schedule patrols for those days.`
      : "No recreation fires in this selection.";

    const [eq, eqScope] = pick((r) => causeIs(r, "Equip/Vehicle", "Power Gen") && r.hour != null);
    const hours = Array.from({ length: 24 }, (_, h) => eq.filter((r) => r.hour === h).length);
    const after1 = eq.length ? (100 * eq.filter((r) => r.hour >= 13).length) / eq.length : null;
    chart("c-hour", { type: "bar", data: { labels: hours.map((_, h) => `${h}:00`), datasets: [{ label: "Equipment / power-line fires", data: hours, backgroundColor: hours.map((_, h) => (h >= 13 ? EMBER : "#e8b49a")) }] }, options: { plugins: { legend: { display: false } } } });
    $("take-hour").textContent = eq.length
      ? `${fmt(after1, 0)}% of ${fmt(eq.length)} equipment and power-line fires (${eqScope}) were discovered at or after 1:00 PM, the window an IFPL afternoon shutdown targets.`
      : "No equipment fires in this selection.";

    const [deb, debScope] = pick((r) => causeIs(r, "Debris Burn") && D.staging.escapes[r.escape], 15);
    const escCount = {};
    deb.forEach((r) => { const e = D.staging.escapes[r.escape]; escCount[e] = (escCount[e] || 0) + 1; });
    const escList = Object.entries(escCount).sort((a, b) => b[1] - a[1]);
    chart("c-escape", { type: "bar", data: { labels: escList.map((e) => e[0]), datasets: [{ label: "Escaped debris burns", data: escList.map((e) => e[1]), backgroundColor: EMBER }] }, options: { indexAxis: "y", plugins: { legend: { display: false } } } });
    const windMonths = MONTHS.map((_, i) => inReg.filter((r) => r.month === i + 1 && causeIs(r, "Debris Burn") && D.staging.escapes[r.escape] === "High Winds").length);
    const topWind = windMonths.map((v, i) => [v, MONTHS[i]]).sort((a, b) => b[0] - a[0]).slice(0, 2).filter((x) => x[0] > 0).map((x) => x[1]);
    $("take-escape").textContent = escList.length
      ? `Top escape reason (${debScope}): ${escList[0][0]} (${fmt((100 * escList[0][1]) / deb.length, 0)}% of ${fmt(deb.length)}).${topWind.length ? ` Wind escapes cluster in ${topWind.join(" and ")}, a case for weather-triggered burn restrictions.` : ""}`
      : "No escaped debris burns recorded in this selection.";

    // cost by cause
    const byCause = {};
    inReg.forEach((r) => { const c = D.staging.causes[r.cause]; (byCause[c] = byCause[c] || []).push(r); });
    const costRows = Object.entries(byCause).map(([c, rs]) => ({ c, n: rs.length, f: rs.filter(isFail).length, h: median(rs.map((r) => r.hours).filter((x) => x != null)), t: sum(rs.map((r) => r.timber)), human: isHuman(D.staging.causes.indexOf(c)) }))
      .sort((a, b) => b.f - a.f);
    $("cost-table").innerHTML = `<caption class="sr-only">Cause groups by cost</caption><thead><tr><th>Cause</th><th class="num">Fires</th><th class="num">IA fail</th><th class="num">Fail rate</th><th class="num">Median h</th><th class="num">Timber ac</th></tr></thead><tbody>` +
      costRows.map((r) => `<tr><td>${esc(r.c)}${r.human ? "" : ' <span class="why">(not human)</span>'}</td><td class="num">${fmt(r.n)}</td><td class="num">${fmt(r.f)}</td><td class="num">${fmt((100 * r.f) / r.n, 0)}%</td><td class="num">${fmt(r.h, 1)}</td><td class="num">${fmt(r.t)}</td></tr>`).join("") + "</tbody>";
    const topHuman = costRows.filter((r) => r.human).sort((a, b) => b.t - a.t)[0];
    $("take-cost").textContent = topHuman ? `${topHuman.c} is the costliest human cause here: ${fmt(topHuman.f)} escaped initial attack and ${fmt(topHuman.t)} timber acres lost (2008+, all months).` : "";

    // monthly matrix
    const mrows = MONTHS.map((mn, i) => {
      const rs = inReg.filter((r) => r.month === i + 1), fy = rs.filter((r) => r.year <= 2025), fl = rs.filter(isFail);
      const hc = {}; rs.filter((r) => isHuman(r.cause)).forEach((r) => { const c = D.staging.causes[r.cause]; hc[c] = (hc[c] || 0) + 1; });
      const top = Object.entries(hc).sort((a, b) => b[1] - a[1])[0];
      return { mn, i, perYr: fy.length / FULL_YEARS, failYr: fy.filter(isFail).length / FULL_YEARS, h: median(rs.map((r) => r.hours).filter((x) => x != null)), t: sum(fy.map((r) => r.timber)) / FULL_YEARS, top: top ? top[0] : "–", nf: fl.length };
    });
    const maxF = Math.max(...mrows.map((r) => r.failYr)) || 1;
    $("matrix").innerHTML = `<caption class="sr-only">Monthly resource allocation matrix</caption><thead><tr><th>Month</th><th class="num">Fires / yr</th><th class="num">IA failures / yr</th><th class="num">Median h to control</th><th class="num">Timber ac / yr</th><th>Top human cause</th></tr></thead><tbody>` +
      mrows.map((r) => `<tr class="${r.i + 1 === month ? "sel" : ""}"><td>${r.mn}</td><td class="num">${fmt(r.perYr, 1)}</td><td class="mx" style="background:rgba(217,83,30,${(0.08 + 0.8 * (r.failYr / maxF)).toFixed(2)});color:${r.failYr / maxF > 0.6 ? "#fff" : "inherit"}">${fmt(r.failYr, 1)}</td><td class="num">${fmt(r.h, 1)}</td><td class="num">${fmt(r.t, 0)}</td><td>${esc(r.top)}</td></tr>`).join("") + "</tbody>";
  }

  // ---------- Allocation ----------
  function renderAllocation() {
    const A = D.allocation, sel = regionOf();
    $("alloc-year").textContent = A.year;
    chart("c-alloc", { type: "bar",
      data: { labels: A.regions.map((r) => r.name), datasets: [{ label: "% of crews", data: A.regions.map((r) => r.pct), backgroundColor: A.regions.map((r) => (r.region === sel ? SLATE : EMBER)) }] },
      options: { indexAxis: "y", onClick: (_, els) => { if (els.length) setArea(A.regions[els[0].index].region); },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.raw}% of crews · click to focus` } } }, scales: { x: { max: Math.ceil(Math.max(...A.regions.map((r) => r.pct)) / 10) * 10, title: { display: true, text: "% of crews" } } } } });
    // Three short chips per region: history, this spring, coverage.
    const why = (r) => [
      `<span class="chip" title="Share of 1970–2007 fires and acres">${fmt(r.share_acres, 0)}% of acres</span>`,
      r.tercile ? `<span class="chip ${r.tercile}" title="${A.year} Apr–Jun rain ${fmt(r.rain_pct)}% of normal">${r.tercile} spring ×${r.weather_mult}</span>` : `<span class="chip">no weather</span>`,
      r.gap_boost ? `<span class="chip gap" title="Coverage gap score ${r.gap_score}">thin coverage +${Math.round(r.gap_boost * 100)}%</span>` : "",
    ].join(" ");
    $("alloc-table").innerHTML = `<caption class="sr-only">Allocation by region</caption><thead><tr><th>Region</th><th class="num">Crews</th><th>Because</th></tr></thead><tbody>` +
      A.regions.map((r) => `<tr class="${r.region === sel ? "sel" : ""} clickable" data-area="${esc(r.region)}" tabindex="0" title="Open ${esc(r.name)}"><td>${esc(r.name)}</td><td class="num"><strong>${fmt(r.pct, 1)}%</strong></td><td>${why(r)}</td></tr>`).join("") + "</tbody>";
    const top = A.regions[0];
    $("take-alloc").textContent = `For ${A.year}, put about ${fmt(top.pct, 0)}% of crews in ${top.name}, followed by ${A.regions[1].name} (${fmt(A.regions[1].pct, 0)}%). Each share is history × this spring's weather × a coverage-gap boost.`;
    $("alloc-method").textContent = `Method: historical share = average of fire-count and acres share (1970–2007). Weather multiplier = median summer acres in years with this spring's tercile ÷ normal-spring years, clamped to ${A.mult_range[0]}–${A.mult_range[1]}. Regions in the top quartile of coverage-gap score get +${Math.round(A.boost * 100)}%. Normalized to 100%. Weather loaded for ${A.weather_counties} of ${A.total_counties} counties.`;

    const H = D.holdout, ha = H.areas[sel || "ALL"];
    const card = (v, title, ok, text) => `<div class="hold"><div class="verdict ${ok ? "yes" : "shift"}">${ok ? "Held" : "Shifted"}</div><div class="v">${v}</div><strong>${title}</strong><p>${text}</p></div>`;
    const sh = ha.peak_shift_weeks, hs = ha.human_share, dw = ha.dry_vs_wet_acres;
    const held = [H.county_rank_spearman >= 0.7, sh != null && Math.abs(sh) <= 2, Math.abs(hs[1] - hs[0]) <= 5,
      !!(dw && dw[1] != null && (dw[0] > 1) === (dw[1] > 1))].filter(Boolean).length;
    $("hold-summary").textContent = `${held} of 4 checks held`;
    $("holdout").innerHTML = [
      card(`ρ = ${fmt(H.county_rank_spearman, 2)}`, "County rankings", H.county_rank_spearman >= 0.7, `Counties that burned most in 1970–2007 still do. Top 5 then: ${H.top5_old.map((c) => areaName(c)).join(", ")}. Now: ${H.top5_new.map((c) => areaName(c)).join(", ")}.`),
      card(sh == null ? "–" : `${sh > 0 ? "+" : ""}${sh} wk`, `Peak week, ${areaName(sel || "ALL")}`, sh != null && Math.abs(sh) <= 2, sh == null ? "Not enough data." : `Peak moved from ${weekLabel(ha.peak_week[0])} to ${weekLabel(ha.peak_week[1])}.`),
      card(`${fmt(hs[0])}% → ${fmt(hs[1])}%`, "Human-caused share", Math.abs(hs[1] - hs[0]) <= 5, "Share of known-cause fires with a human cause. Prevention still addresses most fires."),
      card(dw && dw[0] != null ? `${fmt(dw[0], 1)}× → ${dw[1] != null ? fmt(dw[1], 1) + "×" : "–"}` : "–", "Dry vs. wet spring acres", !!(dw && dw[1] != null && (dw[0] > 1) === (dw[1] > 1)), dw ? "Median summer acres after dry springs ÷ after wet springs, 1970–2007 vs 2008–2025." : "Weather not loaded for this area yet."),
    ].join("");
  }

  // ---------- render ----------
  // Each tab = one question; it may draw several sections.
  const RENDER = {
    plan: [renderAllocation],
    where: [renderWhere],
    when: [renderSeason, renderTrends],
    why: [renderWeather, renderCauses],
    stage: [renderStaging],
  };
  function render() {
    RENDER[S.tab].forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }

  // Leaflet.heat throws if it redraws while its map sits in a hidden tab (0-px canvas). Skip those frames;
  // the map is re-measured and redrawn when its tab is shown again.
  if (L.HeatLayer) {
    const redraw = L.HeatLayer.prototype._redraw;
    L.HeatLayer.prototype._redraw = function () {
      if (!this._map || !this._canvas || !this._canvas.width || !this._canvas.height) { this._frame = null; return; }
      return redraw.call(this);
    };
  }

  async function init() {
    try { await load(); } catch (e) {
      $("loading").textContent = `Could not load data (${e.message}). Run the scripts in scripts/ and serve web/ with "python -m http.server".`;
      return;
    }
    $("loading").remove();
    $("generated").textContent = `Data built ${D.meta.generated}. ${fmt(D.meta.stations)} fire stations (OpenStreetMap).`;
    initPicker(); initTabs(); initStagingControls(); initWhereControls();
    // Charts inside collapsed "More" sections are drawn at 0 px; redraw when opened.
    document.querySelectorAll("details.more").forEach((d) => d.addEventListener("toggle", () => { if (d.open) render(); }));
    document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
      S.seasonEra = +b.dataset.era;
      document.querySelectorAll(".seg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); });
      render();
    }));
    Chart.defaults.font.family = getComputedStyle(document.documentElement).fontFamily;
    Chart.defaults.color = "#3b4552";
    render();
  }
  init();
})();
