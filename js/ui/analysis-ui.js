// Analysis tab: loads the precomputed datasets (or runs a new batch in web workers) and draws
// the histogram, the two scatter plots and the time / memory comparison.

import { Sandbox, CHAIN_MODES, formatGrid } from '../core/model.js';
import { HEURISTICS } from '../core/heuristics.js';
import { createRunner, createCollector } from '../core/analysis.js';
import { columns, bubbles, dotPlot, lines, fmt } from './charts.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
};
const int = (n) => Math.round(n).toLocaleString('en-US');
const pct = (x) => `${(100 * x).toFixed(x > 0.9995 || x < 0.0005 ? 0 : 1)}%`;

/** Fixed colour per algorithm (colour follows the entity, never its rank). */
const SERIES = { bfs: 1, ucs: 2, 'astar-gap': 3, idastar: 4, greedy: 5, dfs: 6, ids: 7, wastar: 8 };
const DEFAULT_LINES = ['bfs', 'ucs', 'astar-gap', 'idastar'];

const datasets = new Map(); // id -> { title, url?, data? }
let hooks = null;
let view = { algo: 'greedy', actionsBy: 'optimal', metric: 'timeMs', stat: 'mean', depthMetric: 'expanded', lines: new Set(DEFAULT_LINES) };
let pool = [];

export async function initAnalysis(h) {
  hooks = h;
  setupLiveControls();
  $('dataset').addEventListener('change', () => select($('dataset').value));
  try {
    const index = await (await fetch('data/index.json')).json();
    for (const d of index) addDataset(d.file, d.title, { url: `data/${d.file}` });
    await select(index[0].file);
  } catch (err) {
    $('analysisBody').replaceChildren(el('div', { className: 'card' }, [
      el('p', { textContent: 'The precomputed datasets could not be loaded. Open the page through a web server (npm start), or run an analysis in the browser with the panel above.' }),
      el('p', { className: 'error', textContent: String(err.message || err) }),
    ]));
    $('liveRun').open = true;
  }
}

function addDataset(id, title, entry) {
  datasets.set(id, { title, ...entry });
  if (![...$('dataset').options].some((o) => o.value === id)) $('dataset').append(el('option', { value: id, textContent: title }));
}

async function select(id) {
  const d = datasets.get(id);
  $('dataset').value = id;
  if (!d.data) {
    $('analysisBody').replaceChildren(el('div', { className: 'card', textContent: 'Loading…' }));
    d.data = await (await fetch(d.url)).json();
  }
  const link = $('datasetDownload');
  link.href = d.url || URL.createObjectURL(new Blob([JSON.stringify(d.data)], { type: 'application/json' }));
  link.download = d.url ? id : 'sand-boxes-analysis.json';
  render(d.data);
}

// ------------------------------------------------------------------ render

function chartCard(title, sub, { wide = false, controls = [] } = {}) {
  const chart = el('div');
  const foot = el('p', { className: 'chart-foot' });
  const card = el('div', { className: `card chart-card${wide ? ' wide' : ''}` }, [
    el('div', { className: 'chart-head' }, [
      el('div', {}, [el('h2', { textContent: title }), el('p', { className: 'sub', textContent: sub })]),
      el('div', { className: 'controls' }, controls),
    ]),
    chart,
    foot,
  ]);
  return { card, chart, foot };
}

function picker(label, options, value, onChange) {
  const s = el('select');
  s.setAttribute('aria-label', label);
  for (const [v, t] of options) s.append(el('option', { value: v, textContent: t }));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function render(data) {
  const { meta, optimal, algos } = data;
  const model = new Sandbox({ rows: meta.rows, chain: meta.chain, concretePenalty: meta.concretePenalty ?? 10 });
  const byKey = Object.fromEntries(algos.map((a) => [a.key, a]));
  const inexact = algos.filter((a) => !a.guaranteesOptimal);
  if (!byKey[view.algo] || byKey[view.algo].guaranteesOptimal) view.algo = 'greedy';
  if (view.actionsBy !== 'optimal' && !byKey[view.actionsBy]) view.actionsBy = 'optimal';
  const greedy = byKey.greedy;
  const nontrivial = meta.solvable - meta.trivial;

  const what = meta.kind === 'exhaustive' ? `All ${int(meta.count)} initial states of the ${meta.rows}×2 sand grid`
    : meta.kind === 'sample' ? `${int(meta.count)} states sampled uniformly from the ${int(meta.stateSpace)} of the ${meta.rows}×2 sand grid (seed ${meta.seed})`
    : `${int(meta.count)} random ${meta.rows}×2 instances${meta.variant === 'water' ? ' with water' : ''} (seed ${meta.seed})`;
  $('datasetMeta').textContent = `${what}. Door rule: ${CHAIN_MODES[meta.chain].toLowerCase()}. Computed in ${fmt(meta.wallSeconds)} s on ${meta.workers} worker${meta.workers === 1 ? '' : 's'} — ${meta.cpu ? `${meta.cpu}, ` : ''}${meta.environment}.`;

  const body = $('analysisBody');
  body.replaceChildren();

  // ---- headline numbers
  const sideShare = optimal.actions.reduce((s, p) => s + (p[1] > 0 ? p[2] : 0), 0) / Math.max(1, meta.solvable);
  const tiles = [
    ['Instances', int(meta.count), meta.unsolvable ? `${int(meta.unsolvable)} unsolvable` : 'all solvable'],
    ['Mean optimal cost', fmt(optimal.cost.mean), `median ${fmt(optimal.cost.median)}, max ${fmt(optimal.cost.max)}`],
    ['Greedy is optimal on', pct(greedy.optimal / Math.max(1, meta.solvable)), `${int(greedy.optimal)} of ${int(meta.solvable)} instances`],
    ['Mean greedy ÷ optimal', greedy.ratio.mean.toFixed(3), `worst case ${greedy.ratio.max.toFixed(2)}`],
    ['Optimal plans using side gates', pct(sideShare), `mean length ${fmt(optimal.steps.mean)} actions`],
  ];
  body.append(el('div', { className: 'stat-row' }, tiles.map(([k, v, s]) => el('div', { className: 'stat' }, [el('span', { textContent: k }), el('b', { textContent: v }), el('small', { textContent: s })]))));

  // ---- solution quality
  const grid = el('div', { className: 'chart-grid' });
  body.append(grid);
  const algoPick = () => picker('Algorithm', inexact.map((a) => [a.key, a.label]), view.algo, (v) => { view.algo = v; render(data); });
  const a = byKey[view.algo];
  const name = a.label;

  const hist = chartCard(`${name}_opt_ratio = cost by ${name.toLowerCase()} ÷ optimum cost`, 'How far the solution is from the cheapest one, counted over all instances with sand.', { controls: [algoPick()] });
  grid.append(hist.card);
  const bars = [{ label: '1', value: a.ratio.exact, accent: true, tip: `Ratio exactly 1 (optimal): <b>${int(a.ratio.exact)}</b> instances` }];
  a.ratio.bins.forEach((count, i) => {
    const lo = 1 + i * a.ratio.binWidth;
    const hi = lo + a.ratio.binWidth;
    const value = i === 0 ? count - a.ratio.exact : count;
    bars.push({ label: hi.toFixed(2), value, tip: `Ratio ${i === 0 ? 'above 1.00' : `from ${lo.toFixed(2)}`} to below ${hi.toFixed(2)}: <b>${int(value)}</b> instances` });
  });
  columns(hist.chart, { bars, xTitle: 'cost ratio (bar label = upper edge of the bin; first bar = exactly 1)', yTitle: 'instances' });
  hist.foot.textContent = `${int(a.ratio.exact)} of ${int(nontrivial)} instances (${pct(a.ratio.exact / Math.max(1, nontrivial))}) are solved optimally. Mean ratio ${a.ratio.mean.toFixed(3)}, median ${a.ratio.median.toFixed(3)}, 95th percentile ${a.ratio.p95.toFixed(2)}, maximum ${a.ratio.max.toFixed(2)}.`;
  const table = el('table', { className: 'data compact' }, [
    el('thead', {}, el('tr', {}, [el('th', { textContent: 'Ratio' }), el('th', { className: 'num', textContent: 'Instances' })])),
    el('tbody', {}, bars.map((b, i) => el('tr', {}, [el('td', { textContent: i === 0 ? 'exactly 1' : `${(1 + (i - 1) * a.ratio.binWidth).toFixed(2)} – ${b.label}` }), el('td', { className: 'num', textContent: int(b.value) })]))),
  ]);
  hist.card.append(el('details', {}, [el('summary', { textContent: 'Show as table' }), el('div', { className: 'table-wrap' }, table)]));

  const open = (key, algoKey) => {
    const v = byKey[algoKey];
    hooks.openInSimulator({ cells: model.decode(key), algo: v ? v.algo : 'astar', heuristic: v?.heuristic || undefined });
  };
  const gridText = (key) => formatGrid(model.decode(key), ' / ');

  const sc1 = chartCard(`Cost by ${name.toLowerCase()} against the optimum`, 'Each circle is a (cost, optimum) pair; its area is the number of instances there. Click one to open an example.', { controls: [algoPick()] });
  grid.append(sc1.card);
  bubbles(sc1.chart, {
    points: a.costVsOpt,
    xTitle: `cost by ${name.toLowerCase()} solution`,
    yTitle: 'optimum cost',
    diagonal: true,
    diagonalLabel: 'cost = optimum',
    tip: (p) => `${name} <b>${p[0]}</b> · optimum <b>${p[1]}</b><br><b>${int(p[2])}</b> instance${p[2] === 1 ? '' : 's'} · e.g. ${gridText(p[3])}`,
    onPick: (p) => open(p[3], view.algo),
  });
  sc1.foot.textContent = 'Points on the diagonal are solved optimally; the further right of it, the more the algorithm overpays.';

  const actionSets = [['optimal', 'Optimal plan']].concat(algos.map((x) => [x.key, x.label]));
  const sc2 = chartCard('Actions to the goal against side-gate actions', 'x = number of actions in the solution, y = how many of them are type b (side gates).', {
    controls: [picker('Solution by', actionSets, view.actionsBy, (v) => { view.actionsBy = v; render(data); })],
  });
  grid.append(sc2.card);
  const actionPoints = view.actionsBy === 'optimal' ? optimal.actions : byKey[view.actionsBy].actions;
  bubbles(sc2.chart, {
    points: actionPoints,
    xTitle: 'number of actions to the goal state',
    yTitle: 'actions of type b',
    integerAxes: true,
    tip: (p) => `<b>${p[0]}</b> actions, <b>${p[1]}</b> side gate${p[1] === 1 ? '' : 's'}<br><b>${int(p[2])}</b> instance${p[2] === 1 ? '' : 's'} · e.g. ${gridText(p[3])}`,
    onPick: (p) => open(p[3], view.actionsBy === 'optimal' ? 'astar-gap' : view.actionsBy),
  });
  sc2.foot.textContent = view.actionsBy === 'optimal'
    ? 'Among equally cheap plans the one with the fewest actions is counted, then the one with the fewest side gates.'
    : `Solutions returned by ${byKey[view.actionsBy].label}.`;

  const dist = chartCard('Distribution of the optimum cost', 'How expensive the cheapest plan is across the instances.');
  grid.append(dist.card);
  const maxCost = optimal.costHist.length ? optimal.costHist[optimal.costHist.length - 1][0] : 0;
  const width = Math.max(1, Math.ceil((maxCost + 1) / 30));
  const buckets = [];
  for (const [cost, count] of optimal.costHist) {
    const b = Math.floor(cost / width);
    buckets[b] = (buckets[b] || 0) + count;
  }
  columns(dist.chart, {
    bars: Array.from(buckets, (v, i) => ({
      label: width === 1 ? String(i) : `${i * width}`,
      value: v || 0,
      tip: `Optimum cost ${width === 1 ? i : `${i * width}–${i * width + width - 1}`}: <b>${int(v || 0)}</b> instances`,
    })),
    xTitle: width === 1 ? 'optimum cost' : `optimum cost (bins of ${width}, label = lower edge)`,
    yTitle: 'instances',
  });

  // ---- time and memory
  const metrics = { timeMs: 'Time (ms)', expanded: 'States expanded', generated: 'States generated', memory: 'Peak memory (states)', frontier: 'Peak frontier (states)' };
  const stats = { mean: 'mean', median: 'median', p95: '95th percentile', max: 'maximum' };
  const perf = chartCard('Time and memory per algorithm', 'One search per instance and algorithm. Logarithmic axis: each gridline is ten times the previous one.', {
    wide: true,
    controls: [
      picker('Metric', Object.entries(metrics), view.metric, (v) => { view.metric = v; render(data); }),
      picker('Statistic', Object.entries(stats), view.stat, (v) => { view.stat = v; render(data); }),
    ],
  });
  body.append(perf.card);
  dotPlot(perf.chart, {
    rows: algos.map((x) => ({
      label: x.label,
      value: x[view.metric][view.stat],
      tip: `${x.label}<br>mean <b>${fmt(x[view.metric].mean)}</b> · median <b>${fmt(x[view.metric].median)}</b><br>p95 <b>${fmt(x[view.metric].p95)}</b> · max <b>${fmt(x[view.metric].max)}</b>`,
    })),
    xTitle: `${metrics[view.metric]} — ${stats[view.stat]} per instance`,
  });

  const head = ['Algorithm', 'Heuristic', 'Optimal', 'Mean cost ÷ opt', 'Worst ÷ opt', 'Mean time (ms)', 'p95 time (ms)', 'Max time (ms)', 'Total time (s)', 'Mean expanded', 'Max expanded', 'Mean memory', 'Max memory'];
  const perfTable = el('table', { className: 'data compact' }, [
    el('thead', {}, el('tr', {}, head.map((t, i) => el('th', { className: i > 1 ? 'num' : '', textContent: t })))),
    el('tbody', {}, algos.map((x) => el('tr', {}, [
      el('td', { textContent: x.label }),
      el('td', { textContent: x.heuristic ? HEURISTICS[x.heuristic].name : '—' }),
      el('td', { className: 'num', textContent: pct(x.optimal / Math.max(1, meta.solvable)) }),
      el('td', { className: 'num', textContent: x.ratio.mean.toFixed(3) }),
      el('td', { className: 'num', textContent: x.ratio.max.toFixed(2) }),
      el('td', { className: 'num', textContent: fmt(x.timeMs.mean) }),
      el('td', { className: 'num', textContent: fmt(x.timeMs.p95) }),
      el('td', { className: 'num', textContent: fmt(x.timeMs.max) }),
      el('td', { className: 'num', textContent: fmt(x.timeMs.total / 1000) }),
      el('td', { className: 'num', textContent: fmt(x.expanded.mean) }),
      el('td', { className: 'num', textContent: int(x.expanded.max) }),
      el('td', { className: 'num', textContent: fmt(x.memory.mean) }),
      el('td', { className: 'num', textContent: int(x.memory.max) }),
    ]))),
  ]);
  perf.card.append(el('div', { className: 'table-wrap', style: 'margin-top:14px' }, perfTable));
  const aborted = algos.filter((x) => x.aborted).map((x) => `${x.label} hit the expansion limit on ${int(x.aborted)} instance${x.aborted === 1 ? '' : 's'}`);
  perf.foot.textContent = `Memory counts states held at once (frontier plus explored set or transposition table). ${meta.optimalityMismatches === 0 ? 'Every exact algorithm (UCS, A*, IDA*) returned the same optimum on every instance.' : `${meta.optimalityMismatches} optimality mismatches!`} ${aborted.join('; ')}${aborted.length ? '.' : ''}`;

  // ---- scaling with solution length
  const depthMetrics = { expanded: 'States expanded', memory: 'Peak memory (states)', timeMs: 'Time (ms)' };
  const legend = el('div', { className: 'legend' });
  const scale = chartCard('How the effort grows with the length of the optimal plan', 'Mean per instance, grouped by the number of actions in the optimal solution. Logarithmic vertical axis.', {
    wide: true,
    controls: [picker('Metric', Object.entries(depthMetrics), view.depthMetric, (v) => { view.depthMetric = v; render(data); })],
  });
  scale.chart.before(legend);
  body.append(scale.card);
  for (const x of algos) {
    if (!SERIES[x.key]) continue;
    const b = el('button', {}, [el('i', { style: `background:var(--series-${SERIES[x.key]})` }), x.label]);
    b.setAttribute('aria-pressed', String(view.lines.has(x.key)));
    b.addEventListener('click', () => { if (view.lines.has(x.key)) view.lines.delete(x.key); else view.lines.add(x.key); render(data); });
    legend.append(b);
  }
  lines(scale.chart, {
    series: algos.filter((x) => SERIES[x.key] && view.lines.has(x.key)).map((x) => ({
      label: x.label,
      color: `var(--series-${SERIES[x.key]})`,
      points: x.byDepth.filter((d) => d.depth > 0 && d[view.depthMetric] > 0).map((d) => [d.depth, d[view.depthMetric]]),
    })),
    xTitle: 'actions in the optimal solution',
    yTitle: `${depthMetrics[view.depthMetric]} — mean`,
    tipTitle: (xv) => `Optimal plan of <b>${xv}</b> actions`,
  });
  scale.foot.textContent = 'Toggle algorithms with the buttons above the chart. A* (h₁) is listed in the table above.';
}

// ---------------------------------------------------------------- live run

function setupLiveControls() {
  for (const [id, label] of Object.entries(CHAIN_MODES)) $('liveChain').append(el('option', { value: id, textContent: label }));
  const sync = () => {
    const kind = $('liveKind').value;
    const rows = kind === 'exhaustive' ? [2, 3, 4, 5] : [2, 3, 4, 5, 6];
    const prevRows = Number($('liveRows').value) || 5;
    $('liveRows').replaceChildren(...rows.map((r) => el('option', { value: r, textContent: `${r} × 2` })));
    $('liveRows').value = rows.includes(prevRows) ? prevRows : 5;
    const counts = kind === 'exhaustive' ? [[0, 'All states'], [500, 'Sample of 500'], [2000, 'Sample of 2,000'], [10000, 'Sample of 10,000']] : [[100, '100'], [300, '300'], [1000, '1,000']];
    $('liveCount').replaceChildren(...counts.map(([v, t]) => el('option', { value: v, textContent: t })));
    $('liveCount').value = kind === 'exhaustive' ? 2000 : 300;
  };
  $('liveKind').addEventListener('change', sync);
  sync();
  $('liveStart').addEventListener('click', runLive);
  $('liveStop').addEventListener('click', () => stopLive('Stopped.'));
}

function stopLive(message) {
  for (const w of pool) w.terminate();
  pool = [];
  $('liveStart').disabled = false;
  $('liveStop').hidden = true;
  if (message) $('liveProgress').querySelector('span').textContent = message;
}

function runLive() {
  const kind = $('liveKind').value;
  const cfg = {
    kind: kind === 'exhaustive' ? 'exhaustive' : 'random',
    rows: Number($('liveRows').value),
    chain: $('liveChain').value,
    seed: Math.max(1, Number($('liveSeed').value) || 1),
  };
  const n = Number($('liveCount').value);
  if (kind === 'exhaustive') cfg.sample = n; else { cfg.count = n; cfg.water = kind === 'water'; }

  const coordinator = createRunner(cfg);
  const collector = createCollector();
  const ids = coordinator.ids;
  const chunk = cfg.kind === 'random' ? 2 : 32;
  const workers = Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 1, 8, Math.ceil(ids.length / chunk)));
  const t0 = performance.now();
  let cursor = 0;
  let done = 0;
  let alive = workers;
  const bar = $('liveProgress');
  bar.hidden = false;
  const progress = () => {
    bar.querySelector('div').style.width = `${(100 * done) / ids.length}%`;
    const secs = (performance.now() - t0) / 1000;
    bar.querySelector('span').textContent = `${int(done)} / ${int(ids.length)} instances · ${secs.toFixed(0)} s${done ? ` · about ${Math.max(0, (secs / done) * (ids.length - done)).toFixed(0)} s left` : ''}`;
  };
  progress();
  $('liveStart').disabled = true;
  $('liveStop').hidden = false;

  const finish = () => {
    const data = collector.result(coordinator.meta, { workers, wallSeconds: (performance.now() - t0) / 1000 });
    stopLive(`Finished ${int(ids.length)} instances in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
    const id = `live-${Date.now()}`;
    const what = cfg.kind === 'exhaustive' ? (cfg.sample ? `sample of ${int(ids.length)}` : `all ${int(ids.length)} states`) : `${int(ids.length)} random${cfg.water ? ' with water' : ''}`;
    addDataset(id, `Live run — ${cfg.rows}×2, ${what}, ${CHAIN_MODES[cfg.chain].toLowerCase()}`, { data });
    select(id);
  };

  for (let k = 0; k < workers; k++) {
    const w = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
    pool.push(w);
    const feed = () => {
      if (cursor >= ids.length) {
        if (--alive === 0) finish();
        return;
      }
      w.postMessage({ type: 'run', ids: ids.slice(cursor, cursor + chunk) });
      cursor += chunk;
    };
    w.onmessage = (e) => {
      if (e.data.type === 'records') {
        for (const rec of e.data.records) collector.add(rec);
        done += e.data.records.length;
        progress();
      }
      feed();
    };
    w.onerror = (e) => stopLive(`Worker error: ${e.message || 'could not start'}`);
    w.postMessage({ type: 'init', cfg });
  }
}
