/* Graphiques SVG minimalistes, sans dépendance (courbes et barres groupées). */
(function (root) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function niceTicks(min, max, n = 5) {
    if (min === max) { max = min + 1; }
    const span = max - min;
    const step0 = Math.pow(10, Math.floor(Math.log10(span / n)));
    const err = (span / n) / step0;
    const step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { lo, hi, ticks };
  }

  let tip;
  function showTip(html, x, y) {
    if (!tip) { tip = document.createElement("div"); tip.className = "chart-tip"; document.body.appendChild(tip); }
    tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 14)) + "px";
    tip.style.top = Math.max(8, y - h - 10) + "px";
  }
  const hideTip = () => { if (tip) tip.hidden = true; };

  /**
   * Courbes : series = [{ label, color, values: [nombre|null] }], x = [étiquettes date AAAA-MM-JJ].
   * opts.format(v) pour les montants, opts.formatX(d) pour les dates.
   */
  function lineChart(container, x, series, opts = {}) {
    container.innerHTML = "";
    if (!x.length) { container.innerHTML = '<div class="empty">Pas encore de données.</div>'; return; }
    const W = Math.max(320, container.clientWidth || 600), H = opts.height || 260;
    const m = { t: 10, r: 12, b: 26, l: 64 };
    const all = series.flatMap((s) => s.values).filter((v) => v !== null && isFinite(v));
    const { lo, hi, ticks } = niceTicks(Math.min(0, ...all), Math.max(...all));
    const sx = (i) => m.l + (i / Math.max(1, x.length - 1)) * (W - m.l - m.r);
    const sy = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label || "Graphique" }, container);
    const g = el("g", { class: "grid" }, svg);
    for (const t of ticks) {
      el("line", { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t), "stroke-width": 1 }, g);
      const tx = el("text", { x: m.l - 8, y: sy(t) + 4, "text-anchor": "end" }, svg);
      tx.textContent = opts.formatAxis ? opts.formatAxis(t) : t;
    }
    const nLabels = Math.min(6, x.length);
    for (let k = 0; k < nLabels; k++) {
      const i = Math.round((k / Math.max(1, nLabels - 1)) * (x.length - 1));
      const tx = el("text", { x: sx(i), y: H - 6, "text-anchor": k === 0 ? "start" : k === nLabels - 1 ? "end" : "middle" }, svg);
      tx.textContent = opts.formatX ? opts.formatX(x[i]) : x[i];
    }
    for (const s of series) {
      let d = "";
      s.values.forEach((v, i) => {
        if (v === null || !isFinite(v)) return;
        d += (d ? "L" : "M") + sx(i).toFixed(1) + "," + sy(v).toFixed(1);
      });
      if (s.fill) {
        const first = s.values.findIndex((v) => v !== null);
        el("path", { d: d + `L${sx(x.length - 1).toFixed(1)},${sy(lo)}L${sx(first).toFixed(1)},${sy(lo)}Z`, fill: s.color || css("--series-1"), opacity: 0.08 }, svg);
      }
      el("path", { d, fill: "none", stroke: s.color || css("--series-1"), "stroke-width": s.width || 2,
        "stroke-dasharray": s.dash || "", "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    }
    // Survol
    const cursor = el("line", { y1: m.t, y2: H - m.b, stroke: css("--muted"), "stroke-width": 1, "stroke-dasharray": "3 3", visibility: "hidden" }, svg);
    const dots = series.map((s) => el("circle", { r: 3.5, fill: s.color || css("--series-1"), visibility: "hidden" }, svg));
    const hit = el("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" }, svg);
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(x.length - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (x.length - 1))));
      cursor.setAttribute("x1", sx(i)); cursor.setAttribute("x2", sx(i)); cursor.setAttribute("visibility", "visible");
      series.forEach((s, k) => {
        const v = s.values[i];
        if (v === null) { dots[k].setAttribute("visibility", "hidden"); return; }
        dots[k].setAttribute("cx", sx(i)); dots[k].setAttribute("cy", sy(v)); dots[k].setAttribute("visibility", "visible");
      });
      const rows = series.map((s) => `<div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:6px"></i>${s.label} : <span class="num">${s.values[i] === null ? "—" : opts.format(s.values[i])}</span></div>`).join("");
      showTip(`<strong>${opts.formatX ? opts.formatX(x[i], true) : x[i]}</strong>${rows}${opts.extra ? opts.extra(i) : ""}`, ev.clientX, ev.clientY);
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerleave", () => { hideTip(); cursor.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); });
    legend(container, series);
  }

  /** Barres groupées : categories = étiquettes, groups = [{ label, color, values: [n] }]. */
  function barChart(container, categories, groups, opts = {}) {
    container.innerHTML = "";
    const all = groups.flatMap((g) => g.values);
    if (!all.some((v) => v > 0)) { container.innerHTML = '<div class="empty">Aucun dividende perçu pour l\'instant.</div>'; return; }
    const W = Math.max(320, container.clientWidth || 600), H = opts.height || 260;
    const m = { t: 10, r: 8, b: 26, l: 48 };
    const { lo, hi, ticks } = niceTicks(0, Math.max(...all));
    const sy = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const band = (W - m.l - m.r) / categories.length;
    const inner = band * 0.78;
    const bw = inner / groups.length;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label || "Graphique" }, container);
    const g = el("g", { class: "grid" }, svg);
    for (const t of ticks) {
      el("line", { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t) }, g);
      const tx = el("text", { x: m.l - 6, y: sy(t) + 4, "text-anchor": "end" }, svg);
      tx.textContent = opts.formatAxis ? opts.formatAxis(t) : t;
    }
    categories.forEach((c, i) => {
      const x0 = m.l + i * band + (band - inner) / 2;
      const tx = el("text", { x: m.l + i * band + band / 2, y: H - 6, "text-anchor": "middle" }, svg);
      tx.textContent = c;
      groups.forEach((gr, k) => {
        const v = gr.values[i];
        if (!v) return;
        const r = el("rect", { x: x0 + k * bw + 0.5, y: sy(v), width: Math.max(1, bw - 1), height: sy(0) - sy(v), rx: 2, fill: gr.color }, svg);
        r.addEventListener("pointermove", (ev) => showTip(`<strong>${opts.catLabel ? opts.catLabel(i) : c} ${gr.label}</strong><div class="num">${opts.format(v)}</div>`, ev.clientX, ev.clientY));
        r.addEventListener("pointerleave", hideTip);
      });
    });
    legend(container, groups);
  }

  function legend(container, series) {
    const lg = document.createElement("div");
    lg.className = "legend";
    for (const s of series) {
      const sp = document.createElement("span");
      const i = document.createElement("i");
      i.style.background = s.color;
      sp.append(i, s.label);
      lg.appendChild(sp);
    }
    container.appendChild(lg);
  }

  root.PEACharts = { lineChart, barChart, css };
})(window);
