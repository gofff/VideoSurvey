(() => {
  "use strict";

  const DEFAULT_FASTAPI = `${location.protocol}//${location.hostname}:8000/stats`;
  const el = {
    sourceSelect: document.getElementById("sourceSelect"),
    attentionFilter: document.getElementById("attentionFilter"),
    refreshBtn: document.getElementById("refreshBtn"),
    autoBtn: document.getElementById("autoBtn"),
    weightInfo: document.getElementById("weightInfo"),
    totals: document.getElementById("totals"),
    updated: document.getElementById("updated"),
    summaryBody: document.querySelector("#summaryTable tbody"),
    events: document.getElementById("events"),
    barPlot: document.getElementById("barPlot"),
    linePlot: document.getElementById("linePlot")
  };

  let autoTimer = null;
  let appConfig = {};

  function pct(v) {
    return `${(100 * asNum(v)).toFixed(1)}%`;
  }

  function asNum(v, fallback = 0) {
    if (v === null || v === undefined || v === "") return fallback;
    if (typeof v === "string") {
      v = v.replace(",", ".").trim();
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function clearSvg(svg) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  function svgEl(name, attrs = {}) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v)));
    return n;
  }

  function bitrateFromProfile(profile) {
    const p = String(profile || "").toLowerCase();
    const m = p.match(/(\d+(?:\.\d+)?)\s*m/);
    if (m) return Number(m[1]);
    if (p.includes("bad")) return 1;
    if (p.includes("same")) return 10;
    if (p.includes("codec")) return 5;
    return NaN;
  }

  function drawBarPlot(rows) {
    const svg = el.barPlot;
    clearSvg(svg);
    if (!rows.length) return;

    const pad = { l: 220, r: 20, t: 12, b: 20 };
    const w = 1100;
    const h = 280;
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const barH = Math.max(10, Math.floor(plotH / rows.length) - 4);

    rows.forEach((r, i) => {
      const y = pad.t + i * (barH + 4);
      const x2 = pad.l + plotW * asNum(r.not_worse_rate, 0);
      const label = `${r.candidate_profile} / ${r.device_class}`;

      svg.appendChild(svgEl("text", { x: 8, y: y + barH - 2, fill: "#344054", "font-size": 11 })).appendChild(document.createTextNode(label));
      svg.appendChild(svgEl("rect", { x: pad.l, y, width: plotW, height: barH, fill: "#edf2f7" }));
      svg.appendChild(svgEl("rect", { x: pad.l, y, width: Math.max(1, x2 - pad.l), height: barH, fill: "#1f77b4" }));
      svg.appendChild(svgEl("text", { x: x2 + 6, y: y + barH - 2, fill: "#111827", "font-size": 11 })).appendChild(document.createTextNode(pct(r.not_worse_rate)));
    });
  }

  function drawLinePlot(rows) {
    const svg = el.linePlot;
    clearSvg(svg);
    const points = rows
      .map((r) => ({
        ...r,
        _bitrate: Number.isFinite(asNum(r.bitrate_mbps, NaN)) ? asNum(r.bitrate_mbps, NaN) : bitrateFromProfile(r.candidate_profile),
        _notworse: asNum(r.not_worse_rate, 0)
      }))
      .filter((r) => Number.isFinite(r._bitrate));
    if (!points.length) return;

    const byDevice = new Map();
    points.forEach((r) => {
      const k = r.device_class;
      if (!byDevice.has(k)) byDevice.set(k, []);
      byDevice.get(k).push(r);
    });

    const pad = { l: 50, r: 20, t: 20, b: 28 };
    const w = 1100;
    const h = 280;
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const minX = 1;
    const maxX = 10;
    const xMap = (x) => pad.l + ((x - minX) / Math.max(0.0001, maxX - minX)) * plotW;
    const yMap = (y) => pad.t + (1 - y) * plotH;

    svg.appendChild(svgEl("line", { x1: pad.l, y1: pad.t + plotH, x2: pad.l + plotW, y2: pad.t + plotH, stroke: "#9ca3af" }));
    svg.appendChild(svgEl("line", { x1: pad.l, y1: pad.t, x2: pad.l, y2: pad.t + plotH, stroke: "#9ca3af" }));

    const colors = ["#d62728", "#1f77b4", "#2ca02c", "#9467bd"];
    let ci = 0;
    byDevice.forEach((arr, device) => {
      arr.sort((a, b) => a._bitrate - b._bitrate);
      const c = colors[ci % colors.length];
      ci += 1;
      const d = arr.map((p, i) => `${i === 0 ? "M" : "L"}${xMap(p._bitrate)},${yMap(p._notworse)}`).join(" ");
      svg.appendChild(svgEl("path", { d, fill: "none", stroke: c, "stroke-width": 2 }));
      arr.forEach((p) => {
        svg.appendChild(svgEl("circle", { cx: xMap(p._bitrate), cy: yMap(p._notworse), r: 3, fill: c }));
      });
      svg.appendChild(svgEl("text", { x: 860, y: 20 + 14 * ci, fill: c, "font-size": 11 })).appendChild(document.createTextNode(device));
    });

    [1, 2, 4, 5, 6, 8, 10].forEach((x) => {
      const gx = xMap(x);
      svg.appendChild(svgEl("line", { x1: gx, y1: pad.t, x2: gx, y2: pad.t + plotH, stroke: "#eef2f7" }));
      svg.appendChild(svgEl("text", { x: gx, y: h - 6, fill: "#374151", "font-size": 11, "text-anchor": "middle" })).appendChild(document.createTextNode(`${x} Mbps`));
    });
  }

  function render(data) {
    const t = data.totals || {};
    el.totals.textContent = `participants(filtered): ${t.participants_filtered || 0}, trials(main): ${t.main_trials_filtered || 0}, events: ${t.events_filtered || 0}`;
    el.updated.textContent = `updated: ${new Date().toLocaleTimeString()}`;
    el.weightInfo.textContent = `Goal: maximize not-worse rate (failed attention weight=${Number(data.attention_fail_weight || 0).toFixed(2)})`;

    el.summaryBody.innerHTML = "";
    const summaryRows = data.summary || [];
    if (!summaryRows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="10">No rows for current filter. If attention check was failed, switch filter to "All responses".</td>`;
      el.summaryBody.appendChild(tr);
    }
    summaryRows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.candidate_profile || ""}</td>
        <td>${r.device_class || ""}</td>
        <td>${r.n_trials_raw || 0}</td>
        <td>${r.n_trials_weighted == null ? "-" : Number(r.n_trials_weighted).toFixed(2)}</td>
        <td>${pct(r.not_worse_rate)}</td>
        <td>${pct(r.no_diff_rate)}</td>
        <td>${pct(r.better_than_baseline_rate ?? r.candidate_better_rate)}</td>
        <td>${pct(r.baseline_better_rate)}</td>
        <td>${r.avg_size_mb == null ? "-" : Number(r.avg_size_mb).toFixed(2)}</td>
        <td>${r.avg_encode_sec == null ? "-" : Number(r.avg_encode_sec).toFixed(2)}</td>`;
      el.summaryBody.appendChild(tr);
    });

    el.events.innerHTML = "";
    (data.events || []).slice().reverse().forEach((e) => {
      const div = document.createElement("div");
      div.textContent = `[${e.timestamp || ""}] ${e.text || ""}`;
      el.events.appendChild(div);
    });

    drawBarPlot(summaryRows);
    drawLinePlot(summaryRows);
  }

  async function loadConfig() {
    try {
      const res = await fetch("config.json", { cache: "no-store" });
      if (!res.ok) return {};
      return await res.json();
    } catch (_) {
      return {};
    }
  }

  function resolveMode() {
    const selected = el.sourceSelect.value;
    if (selected && selected !== "auto") return selected;
    if (appConfig.stats_source && appConfig.stats_source !== "auto") return appConfig.stats_source;
    if (appConfig.google_stats_endpoint || appConfig.google_log_endpoint) return "google";
    return "fastapi";
  }

  function buildStatsUrl() {
    const q = new URLSearchParams({
      attention_filter: el.attentionFilter.value,
      attention_fail_weight: "0.35",
      max_events: "300"
    });

    const mode = resolveMode();
    if (mode === "google") {
      const endpoint = appConfig.google_stats_endpoint || appConfig.google_log_endpoint;
      if (!endpoint) throw new Error("google stats endpoint is not configured");
      const url = new URL(endpoint, window.location.href);
      q.set("action", "stats");
      return `${url.toString()}?${q.toString()}`;
    }

    const endpoint = appConfig.stats_endpoint || DEFAULT_FASTAPI;
    return `${endpoint}?${q.toString()}`;
  }

  async function refresh() {
    const url = buildStatsUrl();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`stats fetch failed (${res.status})`);
    const data = await res.json();
    render(data);
  }

  function toggleAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
      el.autoBtn.textContent = "Auto: Off";
      return;
    }
    autoTimer = setInterval(() => {
      refresh().catch((err) => console.error(err));
    }, 5000);
    el.autoBtn.textContent = "Auto: On";
  }

  el.refreshBtn.addEventListener("click", () => {
    refresh().catch((err) => alert(err.message));
  });
  el.attentionFilter.addEventListener("change", () => {
    refresh().catch((err) => alert(err.message));
  });
  el.sourceSelect.addEventListener("change", () => {
    refresh().catch((err) => alert(err.message));
  });
  el.autoBtn.addEventListener("click", toggleAuto);

  (async () => {
    appConfig = await loadConfig();
    if (appConfig.stats_source && ["auto", "google", "fastapi"].includes(appConfig.stats_source)) {
      el.sourceSelect.value = appConfig.stats_source;
    }
    refresh().catch((err) => alert(err.message));
  })();
})();
