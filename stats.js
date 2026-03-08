(() => {
  "use strict";

  const API_BASE = `${location.protocol}//${location.hostname}:8000`;
  const el = {
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

  function pct(v) {
    return `${(100 * Number(v || 0)).toFixed(1)}%`;
  }

  function clearSvg(svg) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  function svgEl(name, attrs = {}) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v)));
    return n;
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
      const x2 = pad.l + plotW * Number(r.no_diff_rate || 0);
      const label = `${r.candidate_profile} / ${r.device_class}`;

      svg.appendChild(svgEl("text", { x: 8, y: y + barH - 2, fill: "#344054", "font-size": 11 })).appendChild(document.createTextNode(label));
      svg.appendChild(svgEl("rect", { x: pad.l, y, width: plotW, height: barH, fill: "#edf2f7" }));
      svg.appendChild(svgEl("rect", { x: pad.l, y, width: Math.max(1, x2 - pad.l), height: barH, fill: "#1f77b4" }));
      svg.appendChild(svgEl("text", { x: x2 + 6, y: y + barH - 2, fill: "#111827", "font-size": 11 })).appendChild(document.createTextNode(pct(r.no_diff_rate)));
    });
  }

  function drawLinePlot(rows) {
    const svg = el.linePlot;
    clearSvg(svg);
    const points = rows.filter((r) => Number.isFinite(r.bitrate_mbps));
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

    const xs = points.map((p) => p.bitrate_mbps);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const xMap = (x) => pad.l + ((x - minX) / Math.max(0.0001, maxX - minX)) * plotW;
    const yMap = (y) => pad.t + (1 - y) * plotH;

    svg.appendChild(svgEl("line", { x1: pad.l, y1: pad.t + plotH, x2: pad.l + plotW, y2: pad.t + plotH, stroke: "#9ca3af" }));
    svg.appendChild(svgEl("line", { x1: pad.l, y1: pad.t, x2: pad.l, y2: pad.t + plotH, stroke: "#9ca3af" }));

    const colors = ["#d62728", "#1f77b4", "#2ca02c", "#9467bd"];
    let ci = 0;
    byDevice.forEach((arr, device) => {
      arr.sort((a, b) => a.bitrate_mbps - b.bitrate_mbps);
      const c = colors[ci % colors.length];
      ci += 1;
      const d = arr.map((p, i) => `${i === 0 ? "M" : "L"}${xMap(p.bitrate_mbps)},${yMap(Number(p.no_diff_rate || 0))}`).join(" ");
      svg.appendChild(svgEl("path", { d, fill: "none", stroke: c, "stroke-width": 2 }));
      arr.forEach((p) => {
        svg.appendChild(svgEl("circle", { cx: xMap(p.bitrate_mbps), cy: yMap(Number(p.no_diff_rate || 0)), r: 3, fill: c }));
      });
      svg.appendChild(svgEl("text", { x: 860, y: 20 + 14 * ci, fill: c, "font-size": 11 })).appendChild(document.createTextNode(device));
    });

    [minX, maxX].forEach((x) => {
      svg.appendChild(svgEl("text", { x: xMap(x), y: h - 6, fill: "#374151", "font-size": 11, "text-anchor": "middle" })).appendChild(document.createTextNode(`${x} Mbps`));
    });
  }

  function render(data) {
    const t = data.totals;
    el.totals.textContent = `participants(filtered): ${t.participants_filtered}, trials(main): ${t.main_trials_filtered}, events: ${t.events_filtered}`;
    el.updated.textContent = `updated: ${new Date().toLocaleTimeString()}`;
    el.weightInfo.textContent = `Goal: % no-difference vs baseline (failed attention weight=${Number(data.attention_fail_weight || 0).toFixed(2)})`;

    el.summaryBody.innerHTML = "";
    (data.summary || []).forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.candidate_profile || ""}</td>
        <td>${r.device_class || ""}</td>
        <td>${r.n_trials_raw || 0}</td>
        <td>${r.n_trials_weighted == null ? "-" : Number(r.n_trials_weighted).toFixed(2)}</td>
        <td>${pct(r.no_diff_rate)}</td>
        <td>${pct(r.baseline_better_rate)}</td>
        <td>${pct(r.candidate_better_rate)}</td>
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

    drawBarPlot(data.summary || []);
    drawLinePlot(data.summary || []);
  }

  async function refresh() {
    const q = new URLSearchParams({
      attention_filter: el.attentionFilter.value,
      attention_fail_weight: "0.35",
      max_events: "300"
    });
    const res = await fetch(`${API_BASE}/stats?${q.toString()}`);
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
  el.autoBtn.addEventListener("click", toggleAuto);

  refresh().catch((err) => alert(err.message));
})();
