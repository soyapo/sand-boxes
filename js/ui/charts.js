// Small dependency-free SVG charts: columns (histogram), bubbles (scatter with counts),
// dot plot on a log axis, and multi-series lines. Colours come from CSS variables, so the
// charts follow the page theme without re-rendering.

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

function text(parent, x, y, str, attrs = {}) {
  const t = svg('text', { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}

const trim = (str) => str.replace(/\.0+$/, '');
export const fmt = (v) => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${trim((v / 1e6).toFixed(a >= 1e7 ? 0 : 1))}M`;
  if (a >= 1e4) return `${trim((v / 1e3).toFixed(a >= 1e5 ? 0 : 1))}K`;
  if (a >= 100 || Number.isInteger(v)) return Math.round(v).toLocaleString('en-US');
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return '0';
  return v.toPrecision(2);
};

function niceTicks(min, max, target = 5) {
  if (max <= min) max = min + 1;
  const raw = (max - min) / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const ticks = [];
  // the last tick always covers the maximum, so marks never overshoot the plot area
  const end = Math.ceil(max / step - 1e-9) * step;
  for (let v = Math.ceil(min / step) * step; v <= end + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

/** Re-run `draw(width)` whenever the container's width changes. */
function mount(container, draw) {
  container.classList.add('chart');
  let last = -1;
  const run = () => {
    const w = Math.max(280, Math.floor(container.clientWidth));
    if (w === last || container.clientWidth === 0) return;
    last = w;
    container.replaceChildren();
    draw(w);
  };
  container._chartObserver?.disconnect();
  container._chartObserver = new ResizeObserver(run);
  container._chartObserver.observe(container);
  run();
}

function tooltip(container) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.append(tip);
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.hidden = false;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.max(half, Math.min(container.clientWidth - half, x))}px`;
      tip.style.top = `${Math.max(tip.offsetHeight + 12, y)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

function frame(container, w, h, m, { xTitle, yTitle }) {
  const root = svg('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img' });
  container.append(root);
  if (xTitle) text(root, m.l + (w - m.l - m.r) / 2, h - 6, xTitle, { 'text-anchor': 'middle', class: 'axis-title' });
  if (yTitle) text(root, m.l - 4, 12, yTitle, { 'text-anchor': 'start', class: 'axis-title', x: 0 });
  return root;
}

// ---------------------------------------------------------------- columns

/**
 * @param {{bars: {label:string, value:number, tip?:string, accent?:boolean}[], xTitle?:string, yTitle?:string, every?:number}} spec
 */
export function columns(container, spec) {
  mount(container, (w) => {
    const h = 300;
    const m = { l: 46, r: 12, t: 26, b: 52 };
    const root = frame(container, w, h, m, spec);
    const tip = tooltip(container);
    const n = spec.bars.length;
    const pw = w - m.l - m.r;
    const ph = h - m.t - m.b;
    const max = Math.max(1, ...spec.bars.map((b) => b.value));
    const ticks = niceTicks(0, max, 4);
    const top = ticks[ticks.length - 1];
    const y = (v) => m.t + ph - (v / top) * ph;
    for (const t of ticks) {
      svg('line', { x1: m.l, x2: w - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'axisline' : 'gridline' }, root);
      text(root, m.l - 6, y(t) + 4, fmt(t), { 'text-anchor': 'end' });
    }
    const band = pw / n;
    const bw = Math.max(2, Math.min(34, band - 2));
    const every = spec.every || Math.ceil(n / Math.max(1, Math.floor(pw / 58)));
    const marks = svg('g', {}, root);
    spec.bars.forEach((b, i) => {
      const x = m.l + i * band + (band - bw) / 2;
      const by = y(b.value);
      const bh = m.t + ph - by;
      const r = Math.min(4, bw / 2, bh);
      const path = bh <= 0 ? '' : `M${x},${m.t + ph}V${by + r}Q${x},${by} ${x + r},${by}H${x + bw - r}Q${x + bw},${by} ${x + bw},${by + r}V${m.t + ph}Z`;
      const mark = svg('path', { d: path, fill: b.accent ? 'var(--series-3)' : 'var(--series-1)', class: 'mark' }, marks);
      const hit = svg('rect', { x: m.l + i * band, y: m.t, width: band, height: ph, fill: 'transparent' }, root);
      hit.addEventListener('pointerenter', () => {
        marks.classList.add('dim');
        mark.classList.add('hot');
        tip.show(b.tip || `${b.label}: <b>${fmt(b.value)}</b>`, m.l + i * band + band / 2, by);
      });
      hit.addEventListener('pointerleave', () => { marks.classList.remove('dim'); mark.classList.remove('hot'); tip.hide(); });
      if (i % every === 0) text(root, m.l + i * band + band / 2, m.t + ph + 16, b.label, { 'text-anchor': 'middle' });
    });
  });
}

// ---------------------------------------------------------------- bubbles

/**
 * Scatter of integer-valued pairs where many instances share a point: circle area = count.
 * @param {{points: [number, number, number, any][], xTitle:string, yTitle:string, diagonal?:boolean,
 *          tip:(p:any[])=>string, onPick?:(p:any[])=>void, integerAxes?:boolean}} spec
 */
export function bubbles(container, spec) {
  mount(container, (w) => {
    const h = Math.min(420, Math.max(300, Math.round(w * 0.62)));
    const m = { l: 46, r: 16, t: 26, b: 44 };
    const root = frame(container, w, h, m, spec);
    const tip = tooltip(container);
    const pts = spec.points;
    if (!pts.length) { text(root, w / 2, h / 2, 'No data', { 'text-anchor': 'middle' }); return; }
    const pw = w - m.l - m.r;
    const ph = h - m.t - m.b;
    let xMax = Math.max(...pts.map((p) => p[0]));
    let yMax = Math.max(...pts.map((p) => p[1]));
    if (spec.diagonal) xMax = yMax = Math.max(xMax, yMax);
    const xt = niceTicks(0, Math.max(1, xMax), spec.integerAxes ? Math.min(8, Math.max(1, xMax)) : 6).filter((t) => !spec.integerAxes || Number.isInteger(t));
    const yt = niceTicks(0, Math.max(1, yMax), spec.integerAxes ? Math.min(6, Math.max(1, yMax)) : 5).filter((t) => !spec.integerAxes || Number.isInteger(t));
    const xTop = Math.max(xt[xt.length - 1], xMax);
    const yTop = Math.max(yt[yt.length - 1], yMax);
    const x = (v) => m.l + (v / xTop) * pw;
    const y = (v) => m.t + ph - (v / yTop) * ph;
    for (const t of yt) {
      svg('line', { x1: m.l, x2: w - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'axisline' : 'gridline' }, root);
      text(root, m.l - 6, y(t) + 4, fmt(t), { 'text-anchor': 'end' });
    }
    for (const t of xt) text(root, x(t), m.t + ph + 16, fmt(t), { 'text-anchor': 'middle' });
    if (spec.diagonal) {
      const d = Math.min(xTop, yTop);
      svg('line', { x1: x(0), y1: y(0), x2: x(d), y2: y(d), class: 'ref' }, root);
      text(root, x(d) - 6, y(d) + 14, spec.diagonalLabel || 'equal', { 'text-anchor': 'end' });
    }
    const maxCount = Math.max(...pts.map((p) => p[2]));
    const rMax = Math.max(5, Math.min(16, pw / 34));
    const rMin = pts.length > 600 ? 1.6 : 3;
    const radius = (c) => rMin + (rMax - rMin) * Math.sqrt(c / maxCount);
    const order = pts.map((p, i) => i).sort((a, b) => pts[b][2] - pts[a][2]);
    const marks = svg('g', {}, root);
    const ring = pts.length <= 600;
    for (const i of order) {
      const p = pts[i];
      svg('circle', {
        cx: x(p[0]).toFixed(1), cy: y(p[1]).toFixed(1), r: radius(p[2]).toFixed(1), fill: 'var(--series-1)', 'fill-opacity': ring ? 0.8 : 0.55,
        ...(ring ? { stroke: 'var(--chart-surface)', 'stroke-width': 1.5 } : {}),
      }, marks);
    }
    const cursor = svg('circle', { r: 0, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2, visibility: 'hidden' }, root);
    const hit = svg('rect', { x: m.l - 10, y: m.t - 10, width: pw + 20, height: ph + 20, fill: 'transparent', class: spec.onPick ? 'pickable' : '' }, root);
    let near = null;
    const locate = (e) => {
      const box = root.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * w;
      const py = ((e.clientY - box.top) / box.height) * h;
      let best = null;
      let bd = 24 * 24;
      for (const p of pts) {
        const dx = x(p[0]) - px;
        const dy = y(p[1]) - py;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    };
    hit.addEventListener('pointermove', (e) => {
      near = locate(e);
      if (!near) { cursor.setAttribute('visibility', 'hidden'); tip.hide(); return; }
      cursor.setAttribute('cx', x(near[0]));
      cursor.setAttribute('cy', y(near[1]));
      cursor.setAttribute('r', radius(near[2]) + 2.5);
      cursor.setAttribute('visibility', 'visible');
      tip.show(spec.tip(near), x(near[0]), y(near[1]) - radius(near[2]));
    });
    hit.addEventListener('pointerleave', () => { cursor.setAttribute('visibility', 'hidden'); tip.hide(); near = null; });
    if (spec.onPick) hit.addEventListener('click', (e) => { const p = locate(e); if (p) spec.onPick(p); });
  });
}

// --------------------------------------------------------------- dot plot

/**
 * One value per category on a logarithmic axis (values span several orders of magnitude,
 * so bars from a zero baseline would not be honest).
 * @param {{rows: {label:string, value:number, tip?:string}[], xTitle:string}} spec
 */
export function dotPlot(container, spec) {
  mount(container, (w) => {
    const rowH = 30;
    const m = { l: 112, r: 64, t: 10, b: 44 };
    const h = m.t + m.b + rowH * spec.rows.length;
    const root = frame(container, w, h, m, { xTitle: spec.xTitle });
    const tip = tooltip(container);
    const pw = w - m.l - m.r;
    const vals = spec.rows.map((r) => r.value).filter((v) => v > 0);
    const lo = Math.floor(Math.log10(Math.min(...vals, 1e9)));
    const hi = Math.ceil(Math.log10(Math.max(...vals, lo + 1)) + 1e-9);
    const span = Math.max(1, hi - lo);
    const x = (v) => m.l + ((Math.log10(Math.max(v, 10 ** lo)) - lo) / span) * pw;
    const step = Math.ceil(span / Math.max(2, Math.floor(pw / 70)));
    for (let e = lo; e <= hi; e += step) {
      const px = x(10 ** e);
      svg('line', { x1: px, x2: px, y1: m.t, y2: h - m.b, class: 'gridline' }, root);
      text(root, px, h - m.b + 16, fmt(10 ** e), { 'text-anchor': 'middle' });
    }
    const marks = svg('g', {}, root);
    spec.rows.forEach((r, i) => {
      const cy = m.t + i * rowH + rowH / 2;
      text(root, m.l - 12, cy + 4, r.label, { 'text-anchor': 'end', class: 'cat-label' });
      const g = svg('g', { class: 'mark' }, marks);
      svg('line', { x1: m.l, x2: x(r.value), y1: cy, y2: cy, stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-opacity': 0.35 }, g);
      svg('circle', { cx: x(r.value), cy, r: 5.5, fill: 'var(--series-1)', stroke: 'var(--chart-surface)', 'stroke-width': 2 }, g);
      text(root, x(r.value) + 10, cy + 4, fmt(r.value), { class: 'value-label' });
      const hit = svg('rect', { x: 0, y: cy - rowH / 2, width: w, height: rowH, fill: 'transparent' }, root);
      hit.addEventListener('pointerenter', () => { marks.classList.add('dim'); g.classList.add('hot'); if (r.tip) tip.show(r.tip, x(r.value), cy - 6); });
      hit.addEventListener('pointerleave', () => { marks.classList.remove('dim'); g.classList.remove('hot'); tip.hide(); });
    });
  });
}

// ------------------------------------------------------------------ lines

/**
 * @param {{series: {label:string, color:string, points:[number, number][]}[], xTitle:string, yTitle:string, log?:boolean, tipTitle?:(x:number)=>string}} spec
 */
export function lines(container, spec) {
  mount(container, (w) => {
    const h = 340;
    const m = { l: 52, r: 104, t: 26, b: 44 };
    const root = frame(container, w, h, m, spec);
    const tip = tooltip(container);
    const series = spec.series.filter((s) => s.points.length);
    if (!series.length) { text(root, w / 2, h / 2, 'Select at least one algorithm', { 'text-anchor': 'middle' }); return; }
    const pw = w - m.l - m.r;
    const ph = h - m.t - m.b;
    const all = series.flatMap((s) => s.points);
    const xMin = Math.min(...all.map((p) => p[0]));
    const xMax = Math.max(...all.map((p) => p[0]));
    const pos = all.map((p) => p[1]).filter((v) => v > 0);
    const lo = Math.floor(Math.log10(Math.min(...pos)));
    const hi = Math.ceil(Math.log10(Math.max(...pos)) + 1e-9);
    const span = Math.max(1, hi - lo);
    const x = (v) => m.l + ((v - xMin) / Math.max(1, xMax - xMin)) * pw;
    const y = (v) => m.t + ph - ((Math.log10(Math.max(v, 10 ** lo)) - lo) / span) * ph;
    for (let e = lo; e <= hi; e++) {
      svg('line', { x1: m.l, x2: w - m.r, y1: y(10 ** e), y2: y(10 ** e), class: e === lo ? 'axisline' : 'gridline' }, root);
      text(root, m.l - 6, y(10 ** e) + 4, fmt(10 ** e), { 'text-anchor': 'end' });
    }
    for (const t of niceTicks(xMin, xMax, Math.min(10, Math.floor(pw / 50))).filter((t) => Number.isInteger(t) && t <= xMax)) text(root, x(t), m.t + ph + 16, t, { 'text-anchor': 'middle' });

    const ends = [];
    for (const s of series) {
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
      svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, root);
      const last = s.points[s.points.length - 1];
      svg('circle', { cx: x(last[0]), cy: y(last[1]), r: 4, fill: s.color, stroke: 'var(--chart-surface)', 'stroke-width': 2 }, root);
      ends.push({ s, x: x(last[0]), y: y(last[1]) });
    }
    // direct end labels, nudged apart; skipped when too many lines converge
    if (ends.length <= 5) {
      ends.sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
      for (const e of ends) text(root, e.x + 9, e.y + 4, e.s.label, { class: 'cat-label' });
    }

    const guide = svg('line', { y1: m.t, y2: m.t + ph, class: 'ref', visibility: 'hidden' }, root);
    const hit = svg('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' }, root);
    const xs = [...new Set(all.map((p) => p[0]))].sort((a, b) => a - b);
    hit.addEventListener('pointermove', (e) => {
      const box = root.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * w;
      const xv = xs.reduce((best, v) => (Math.abs(x(v) - px) < Math.abs(x(best) - px) ? v : best), xs[0]);
      guide.setAttribute('x1', x(xv));
      guide.setAttribute('x2', x(xv));
      guide.setAttribute('visibility', 'visible');
      const rows = series
        .map((s) => ({ s, p: s.points.find((q) => q[0] === xv) }))
        .filter((r) => r.p)
        .sort((a, b) => b.p[1] - a.p[1])
        .map((r) => `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${r.s.color};margin-right:6px"></span>${r.s.label}: <b>${fmt(r.p[1])}</b>`);
      tip.show(`${spec.tipTitle ? spec.tipTitle(xv) : xv}<br>${rows.join('<br>')}`, x(xv), m.t + 40);
    });
    hit.addEventListener('pointerleave', () => { guide.setAttribute('visibility', 'hidden'); tip.hide(); });
  });
}
