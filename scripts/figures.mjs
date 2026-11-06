#!/usr/bin/env node
// Renders the figures of the report as standalone SVG files (docs/figures/) and prints the
// Markdown tables used in docs/03-report.md, straight from the JSON files in data/.
//
//   node scripts/figures.mjs            figures + tables for every dataset
//   node scripts/figures.mjs --tables   tables only

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'docs/figures');
const C = { bg: '#fffdf8', ink: '#1d1a14', ink2: '#554e42', muted: '#8a8273', grid: '#e8e0cf', axis: '#c3bba8', blue: '#2a78d6', aqua: '#1baf7a' };
const FONT = 'font-family="system-ui, -apple-system, Segoe UI, sans-serif"';

const fmt = (v) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '')}K`;
  if (a >= 100 || Number.isInteger(v)) return Math.round(v).toLocaleString('en-US');
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v === 0 ? '0' : v.toPrecision(2);
};
const int = (n) => Math.round(n).toLocaleString('en-US');
const pct = (x) => `${(100 * x).toFixed(1)}%`;

function ticks(max, target = 5) {
  const raw = Math.max(max, 1) / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const list = [];
  for (let v = 0; v <= Math.ceil(max / step - 1e-9) * step + step * 1e-9; v += step) list.push(Math.round(v / step) * step);
  return list;
}

function page(w, h, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ${FONT} font-size="12">
<rect width="${w}" height="${h}" fill="${C.bg}"/>
<text x="16" y="24" font-size="15" font-weight="600" fill="${C.ink}">${title}</text>
${body}
</svg>
`;
}

function columns({ title, bars, xTitle, yTitle, every = 1 }) {
  const w = 720, h = 380, m = { l: 60, r: 16, t: 56, b: 56 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const yt = ticks(Math.max(...bars.map((b) => b.value)), 4);
  const top = yt[yt.length - 1];
  const y = (v) => m.t + ph - (v / top) * ph;
  const band = pw / bars.length;
  const bw = Math.max(2, Math.min(34, band - 2));
  let s = `<text x="16" y="44" fill="${C.ink2}">${yTitle}</text>`;
  for (const t of yt) s += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="${t ? C.grid : C.axis}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end" fill="${C.muted}">${fmt(t)}</text>`;
  bars.forEach((b, i) => {
    const x = m.l + i * band + (band - bw) / 2;
    const by = y(b.value);
    const bh = m.t + ph - by;
    const r = Math.min(4, bw / 2, bh);
    if (bh > 0) s += `<path d="M${x},${m.t + ph}V${by + r}Q${x},${by} ${x + r},${by}H${x + bw - r}Q${x + bw},${by} ${x + bw},${by + r}V${m.t + ph}Z" fill="${b.accent ? C.aqua : C.blue}"/>`;
    if (i % every === 0) s += `<text x="${m.l + i * band + band / 2}" y="${m.t + ph + 17}" text-anchor="middle" fill="${C.muted}">${b.label}</text>`;
  });
  s += `<text x="${m.l + pw / 2}" y="${h - 12}" text-anchor="middle" fill="${C.ink2}">${xTitle}</text>`;
  return page(w, h, title, s);
}

function bubbles({ title, points, xTitle, yTitle, diagonal = false, integer = false }) {
  const w = 720, h = 470, m = { l: 60, r: 24, t: 56, b: 56 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  let xMax = Math.max(...points.map((p) => p[0]), 1);
  let yMax = Math.max(...points.map((p) => p[1]), 1);
  if (diagonal) xMax = yMax = Math.max(xMax, yMax);
  const xt = ticks(xMax, integer ? Math.min(xMax, 10) : 6).filter((t) => !integer || Number.isInteger(t));
  const yt = ticks(yMax, integer ? Math.min(yMax, 6) : 5).filter((t) => !integer || Number.isInteger(t));
  const xTop = xt[xt.length - 1], yTop = yt[yt.length - 1];
  const x = (v) => m.l + (v / xTop) * pw;
  const y = (v) => m.t + ph - (v / yTop) * ph;
  let s = `<text x="16" y="44" fill="${C.ink2}">${yTitle}</text>`;
  for (const t of yt) s += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="${t ? C.grid : C.axis}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end" fill="${C.muted}">${fmt(t)}</text>`;
  for (const t of xt) s += `<text x="${x(t)}" y="${m.t + ph + 17}" text-anchor="middle" fill="${C.muted}">${fmt(t)}</text>`;
  if (diagonal) {
    const d = Math.min(xTop, yTop);
    s += `<line x1="${x(0)}" y1="${y(0)}" x2="${x(d)}" y2="${y(d)}" stroke="${C.axis}" stroke-width="1.5"/><text x="${x(d) - 8}" y="${y(d) + 16}" text-anchor="end" fill="${C.muted}">cost = optimum</text>`;
  }
  const maxCount = Math.max(...points.map((p) => p[2]));
  const dense = points.length > 600;
  const rMin = dense ? 1.6 : 3, rMax = 16;
  const sorted = [...points].sort((a, b) => b[2] - a[2]);
  for (const p of sorted) {
    const r = rMin + (rMax - rMin) * Math.sqrt(p[2] / maxCount);
    s += `<circle cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="${r.toFixed(1)}" fill="${C.blue}" fill-opacity="${dense ? 0.55 : 0.8}"${dense ? '' : ` stroke="${C.bg}" stroke-width="1.5"`}/>`;
  }
  s += `<text x="${m.l + pw / 2}" y="${h - 12}" text-anchor="middle" fill="${C.ink2}">${xTitle}</text>`;
  s += `<text x="${w - m.r}" y="44" text-anchor="end" fill="${C.muted}">circle area = number of instances (largest: ${int(maxCount)})</text>`;
  return page(w, h, title, s);
}

function dots({ title, rows, xTitle }) {
  const rowH = 30, w = 720, m = { l: 120, r: 70, t: 44, b: 52 };
  const h = m.t + m.b + rowH * rows.length;
  const pw = w - m.l - m.r;
  const vals = rows.map((r) => r.value).filter((v) => v > 0);
  const lo = Math.floor(Math.log10(Math.min(...vals)));
  const hi = Math.ceil(Math.log10(Math.max(...vals)) + 1e-9);
  const span = Math.max(1, hi - lo);
  const x = (v) => m.l + ((Math.log10(v) - lo) / span) * pw;
  let s = '';
  for (let e = lo; e <= hi; e++) s += `<line x1="${x(10 ** e)}" x2="${x(10 ** e)}" y1="${m.t}" y2="${h - m.b}" stroke="${C.grid}"/><text x="${x(10 ** e)}" y="${h - m.b + 17}" text-anchor="middle" fill="${C.muted}">${fmt(10 ** e)}</text>`;
  rows.forEach((r, i) => {
    const cy = m.t + i * rowH + rowH / 2;
    s += `<text x="${m.l - 12}" y="${cy + 4}" text-anchor="end" fill="${C.ink}" font-size="13">${r.label}</text>`;
    s += `<line x1="${m.l}" x2="${x(r.value)}" y1="${cy}" y2="${cy}" stroke="${C.blue}" stroke-opacity="0.35" stroke-width="2"/>`;
    s += `<circle cx="${x(r.value)}" cy="${cy}" r="5.5" fill="${C.blue}" stroke="${C.bg}" stroke-width="2"/>`;
    s += `<text x="${x(r.value) + 10}" y="${cy + 4}" fill="${C.ink2}">${fmt(r.value)}</text>`;
  });
  s += `<text x="${m.l + pw / 2}" y="${h - 12}" text-anchor="middle" fill="${C.ink2}">${xTitle} (logarithmic axis)</text>`;
  return page(w, h, title, s);
}

function ratioBars(a) {
  const bars = [{ label: '=1', value: a.ratio.exact, accent: true }];
  a.ratio.bins.forEach((count, i) => bars.push({ label: (1 + (i + 1) * a.ratio.binWidth).toFixed(2), value: i === 0 ? count - a.ratio.exact : count }));
  return bars;
}

function figures(name, data) {
  const by = Object.fromEntries(data.algos.map((a) => [a.key, a]));
  const g = by.greedy;
  const what = data.meta.kind === 'exhaustive' ? `all ${int(data.meta.count)} states, ${data.meta.rows}×2` : `${int(data.meta.count)} random instances, ${data.meta.rows}×2${data.meta.variant === 'water' ? ' with water' : ''}`;
  const save = (file, svg) => { writeFileSync(resolve(out, `${name}-${file}.svg`), svg); };
  save('ratio-hist', columns({ title: `Greedy_opt_ratio = greedy cost ÷ optimum cost (${what})`, bars: ratioBars(g), xTitle: 'ratio (label = upper edge of the bin; green bar = exactly 1)', yTitle: 'instances', every: Math.ceil(ratioBars(g).length / 14) }));
  save('greedy-vs-opt', bubbles({ title: `Cost by greedy solution against the optimum (${what})`, points: g.costVsOpt, xTitle: 'cost by greedy solution', yTitle: 'optimum cost', diagonal: true }));
  save('actions-vs-sides', bubbles({ title: `Actions to the goal against type-b actions, optimal plans (${what})`, points: data.optimal.actions, xTitle: 'number of actions to the goal state', yTitle: 'number of actions of type b', integer: true }));
  save('actions-vs-sides-greedy', bubbles({ title: `Actions to the goal against type-b actions, greedy plans (${what})`, points: g.actions, xTitle: 'number of actions to the goal state', yTitle: 'number of actions of type b', integer: true }));
  const maxCost = data.optimal.costHist[data.optimal.costHist.length - 1][0];
  const width = Math.max(1, Math.ceil((maxCost + 1) / 30));
  const buckets = [];
  for (const [cost, count] of data.optimal.costHist) buckets[Math.floor(cost / width)] = (buckets[Math.floor(cost / width)] || 0) + count;
  save('opt-cost', columns({ title: `Distribution of the optimum cost (${what})`, bars: Array.from(buckets, (v, i) => ({ label: String(i * width), value: v || 0 })), xTitle: `optimum cost (bins of ${width}, label = lower edge)`, yTitle: 'instances', every: 3 }));
  save('time', dots({ title: `Mean time per instance (${what})`, rows: data.algos.map((a) => ({ label: a.label, value: a.timeMs.mean })), xTitle: 'milliseconds' }));
  save('expanded', dots({ title: `Mean states expanded per instance (${what})`, rows: data.algos.map((a) => ({ label: a.label, value: a.expanded.mean })), xTitle: 'states expanded' }));
  save('memory', dots({ title: `Mean peak memory per instance (${what})`, rows: data.algos.map((a) => ({ label: a.label, value: a.memory.mean })), xTitle: 'states held at once' }));
}

function tables(name, data) {
  const { meta, optimal, algos } = data;
  const g = algos.find((a) => a.key === 'greedy');
  const L = [];
  L.push(`\n### ${name} — ${meta.title || ''}`);
  L.push(`instances ${int(meta.count)}, solvable ${int(meta.solvable)}, trivial ${meta.trivial}, mismatches ${meta.optimalityMismatches}, wall ${meta.wallSeconds.toFixed(0)} s on ${meta.workers} workers, ${meta.cpu}, ${meta.environment}`);
  L.push(`optimum cost: mean ${optimal.cost.mean.toFixed(2)}, median ${optimal.cost.median}, p95 ${optimal.cost.p95}, max ${optimal.cost.max}; optimal length: mean ${optimal.steps.mean.toFixed(2)}, median ${optimal.steps.median}, max ${optimal.steps.max}`);
  const bySides = new Map();
  for (const p of optimal.actions) bySides.set(p[1], (bySides.get(p[1]) || 0) + p[2]);
  L.push(`optimal plans by number of side gates: ${[...bySides.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}: ${int(v)} (${pct(v / meta.solvable)})`).join(', ')}`);
  L.push(`greedy: optimal on ${int(g.optimal)} (${pct(g.optimal / meta.solvable)}), ratio mean ${g.ratio.mean.toFixed(4)}, median ${g.ratio.median.toFixed(4)}, p95 ${g.ratio.p95.toFixed(3)}, max ${g.ratio.max.toFixed(3)}; greedy plans using side gates: ${int(g.actions.reduce((s, p) => s + (p[1] > 0 ? p[2] : 0), 0))}`);
  L.push('\n| Ratio | Instances | Share |\n|---|---:|---:|');
  const n = g.ratio.bins.reduce((s, v) => s + v, 0);
  L.push(`| exactly 1 | ${int(g.ratio.exact)} | ${pct(g.ratio.exact / n)} |`);
  g.ratio.bins.forEach((c, i) => {
    const v = i === 0 ? c - g.ratio.exact : c;
    L.push(`| ${i === 0 ? '(1.00' : `[${(1 + i * 0.05).toFixed(2)}`}, ${(1.05 + i * 0.05).toFixed(2)}) | ${int(v)} | ${pct(v / n)} |`);
  });
  L.push('\n| Algorithm | Optimal on | Mean cost ÷ opt | Worst | Mean time (ms) | Median | p95 | Max | Total (s) |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const a of algos) L.push(`| ${a.label} | ${pct(a.optimal / meta.solvable)} | ${a.ratio.mean.toFixed(3)} | ${a.ratio.max.toFixed(2)} | ${fmt(a.timeMs.mean)} | ${fmt(a.timeMs.median)} | ${fmt(a.timeMs.p95)} | ${fmt(a.timeMs.max)} | ${fmt(a.timeMs.total / 1000)} |`);
  L.push('\n| Algorithm | Mean expanded | Median | Max expanded | Mean generated | Mean peak memory | Median | Max peak memory | Aborted |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const a of algos) L.push(`| ${a.label} | ${fmt(a.expanded.mean)} | ${fmt(a.expanded.median)} | ${int(a.expanded.max)} | ${fmt(a.generated.mean)} | ${fmt(a.memory.mean)} | ${fmt(a.memory.median)} | ${int(a.memory.max)} | ${a.aborted} |`);
  console.log(L.join('\n'));
}

const FIGURES_FOR = ['exhaustive-5x2', 'water-5x2'];
mkdirSync(out, { recursive: true });
const tablesOnly = process.argv.includes('--tables');
for (const { file } of JSON.parse(readFileSync(resolve(root, 'data/index.json'), 'utf8'))) {
  const path = resolve(root, 'data', file);
  if (!existsSync(path)) { console.log(`(skipping ${file}: not generated yet)`); continue; }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const name = file.replace(/\.json$/, '');
  if (!tablesOnly && FIGURES_FOR.includes(name)) figures(name, data);
  tables(name, data);
}
if (!tablesOnly) console.log(`\nFigures written to docs/figures/`);
