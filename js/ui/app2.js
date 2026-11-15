// Assignment 2 page: heuristic explorer, the learned heuristic, the evaluation and the design notes.

import { Sandbox, parseGrid, formatGrid, PROBS_SAND, CELL_NAMES, MAX_ROWS, EMPTY, SAND_HALF, SAND_FULL, MAT, SAND, PROFESSOR_EXAMPLE } from '../core/model.js';
import { ALGORITHMS } from '../core/search.js';
import { HEURISTICS } from '../core/heuristics.js';
import { features, FEATURE_NAMES } from '../core/features.js';
import { LEARNED } from '../core/learned.js';
import { Board } from './board.js';
import { columns, bubbles, dotPlot, lines, fmt } from './charts.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
};
const int = (n) => Math.round(n).toLocaleString('en-US');
const pct = (x) => `${(100 * x).toFixed(x > 0.9995 || x < 0.0005 ? 0 : 1)}%`;
const fmtMs = (ms) => (ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : int(ms));
const LEVEL_TEXT = ['0', '½', '1'];
const DATA = new URL('../../data/', import.meta.url).href;

/** Heuristics shown in the explorer, in display order. */
const SHOWN = ['volume', 'gap', 'fall', 'learned', 'learned-safe'];
/** Variants compared on one state by the "Compare heuristics" button. */
const COMPARE = ['ucs', 'astar-volume', 'astar-gap', 'astar-learned', 'astar-safe', 'wastar', 'rbfs', 'rbfs-learned'];
/** Colours of the evaluation line chart, fixed per variant. */
const SERIES = { ucs: 1, 'astar-gap': 3, 'astar-learned': 2, 'astar-safe': 4, rbfs: 5, 'astar-volume': 7, wastar: 8, 'rbfs-learned': 6 };

const PRESETS = [
  { name: 'Assignment example (4×2)', grid: PROFESSOR_EXAMPLE },
  { name: 'Hardest 5×2 state (optimum 76)', grid: '1 1/1 1/1 1/0 0/0 0' },
  { name: 'Worst case for the greedy approach', grid: '1 0/1 ½/0 1/½ 0/1 0' },
  { name: 'Full tower (5×2)', grid: '1 1/1 1/1 1/1 1/1 1' },
  { name: 'Halves and gaps (5×2)', grid: '½ 1/0 ½/1 0/½ ½/0 1' },
];

const S = { rows: 5, brush: SAND_FULL, start: null, steps: [], cursor: 0, playing: false, speed: 1, source: 'manual', searching: false, optKey: null };
let model;
let generation = 0;

// ------------------------------------------------------------------- worker

let worker = null;
let rpcId = 0;
const pending = new Map();
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
    };
    worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'worker failed')); pending.clear(); };
  }
  return worker;
}
const rpc = (type, payload) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  pending.set(id, { resolve, reject });
  getWorker().postMessage({ id, type, ...payload });
});
function cancelSearch() {
  if (!S.searching) return;
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(new Error('cancelled'));
  pending.clear();
  S.searching = false;
  setBusy(false);
}

// -------------------------------------------------------------------- state

const current = () => (S.cursor ? S.steps[S.cursor - 1].state : S.start);
const modelCfg = () => ({ rows: S.rows, concretePenalty: 10 });

const board = new Board($('board'), $('boardWrap'), $('boardTip'), {
  onGate: (id) => manualAction(id),
  onCell: (i) => paint(i),
  onHover: (id) => { for (const b of $('actions').querySelectorAll('.act')) b.classList.toggle('hot', Number(b.dataset.id) === id); },
});

function rebuildModel() {
  model = new Sandbox(modelCfg());
  board.setModel(model);
}

function setStart(cells) {
  cancelSearch();
  generation++;
  S.start = model.initial(cells);
  S.steps = [];
  S.cursor = 0;
  S.playing = false;
  S.source = 'manual';
  $('solveResult').hidden = true;
  $('compareCard').hidden = true;
  $('gridError').hidden = true;
  refresh();
}

function loadGrid(cells) {
  S.rows = cells.length / 2;
  syncSetup();
  rebuildModel();
  setStart(cells);
}

function availableFor(state) {
  const map = new Map();
  for (const a of model.actions) { const r = model.apply(state, a.id); if (r) map.set(a.id, r.cost); }
  return map;
}

function explainStep(step) {
  const a = model.actions[step.a];
  const flowsAfter = step.events.filter((e) => e.kind === 'pour' || e.kind === 'out').length;
  if (a.type === 'b') return `${a.label}: the full box levels with the empty one. Cost 1.`;
  const stillOpen = (step.state.gates & (1 << a.cell)) !== 0;
  const moved = flowsAfter === 0 ? ' Nothing moves yet, but the gate is now open.' : flowsAfter > 1 ? ` ${flowsAfter} flows through the open gates.` : '';
  return `${a.label}: s = ${LEVEL_TEXT[step.s]}, s′ = ${LEVEL_TEXT[step.s2]}.${moved}${stillOpen ? ' The gate stays open.' : ' The gate closes again.'} Cost 1 + 4·(${LEVEL_TEXT[step.s]} + ${LEVEL_TEXT[step.s2]}) = ${step.cost}.`;
}

let optRequest = 0;
async function refreshOptimum(state) {
  if (model.isGoal(state)) { $('statOpt').textContent = '0'; renderHeuristics(state, 0); return; }
  const my = ++optRequest;
  $('statOpt').textContent = '…';
  renderHeuristics(state, null);
  try {
    const res = await rpc('solve', { cfg: modelCfg(), cells: Array.from(state.cells), algo: 'astar', heuristic: 'gap', gates: state.gates });
    if (my !== optRequest) return;
    const opt = res.result.found ? res.result.cost : null;
    $('statOpt').textContent = opt === null ? '—' : opt;
    renderHeuristics(state, opt);
  } catch {
    // the worker was restarted under us (a search was cancelled): ask again once things settle
    if (my === optRequest) setTimeout(() => { if (my === optRequest) { optRequest--; refreshOptimum(state); } }, 300);
  }
}

function renderHeuristics(state, opt) {
  const box = $('hvalues');
  box.replaceChildren();
  const rows = SHOWN.map((k) => ({ k, h: HEURISTICS[k], v: HEURISTICS[k].fn(model, state) }));
  const max = Math.max(opt || 0, ...rows.map((r) => r.v), 1);
  const add = (label, short, v, cls, title) => {
    box.append(
      el('span', { className: 'k', title }, [el('b', { textContent: short }), label]),
      el('span', {}, el('span', { className: `bar ${cls}`, style: `width:${(100 * v) / max}%` })),
      el('span', { className: 'v', textContent: v === null ? '…' : fmt(v) }),
    );
  };
  add('true cost-to-go', 'h*', opt, 'star', 'Optimal remaining cost, from A* with h₂');
  for (const r of rows) add(r.h.name, r.h.short, r.v, opt !== null && r.v > opt + 1e-9 ? 'over' : '', r.h.note);
  const f = features(model, state);
  const table = $('features');
  table.replaceChildren(
    el('thead', {}, el('tr', {}, [el('th', { textContent: 'Feature' }), el('th', { className: 'num', textContent: 'Value' }), el('th', { className: 'num', textContent: 'Weight in h₄' }), el('th', { className: 'num', textContent: 'Contribution' })])),
    el('tbody', {}, FEATURE_NAMES.map((n, i) => el('tr', {}, [
      el('td', { className: 'wrap', textContent: n }), el('td', { className: 'num', textContent: fmt(f[i]) }),
      el('td', { className: 'num', textContent: LEARNED.weights[i] === undefined ? '—' : LEARNED.weights[i].toFixed(2) }),
      el('td', { className: 'num', textContent: LEARNED.weights[i] === undefined ? '—' : (LEARNED.weights[i] * f[i]).toFixed(1) }),
    ]))),
  );
}

function refresh() {
  const state = current();
  const avail = availableFor(state);
  board.show(state);
  board.setAvailable(avail);
  const cost = S.steps.slice(0, S.cursor).reduce((s, x) => s + x.cost, 0);
  $('statCost').textContent = cost;
  $('statSteps').textContent = S.cursor;
  const status = $('status');
  status.className = 'status';
  if (model.isGoal(state)) { status.textContent = S.cursor ? `Goal reached. Total cost ${cost}.` : 'No sand: already a goal state.'; status.classList.add('good'); } else status.textContent = '';
  $('stepNote').textContent = S.cursor ? explainStep(S.steps[S.cursor - 1]) : '';
  const actions = $('actions');
  actions.replaceChildren();
  for (const [id, c] of avail) {
    const a = model.actions[id];
    const b = el('button', { className: 'act', title: a.label }, [a.label, el('b', { textContent: c })]);
    b.dataset.id = id;
    b.addEventListener('click', () => manualAction(id));
    b.addEventListener('pointerenter', () => board.setHighlight(id));
    b.addEventListener('pointerleave', () => board.setHighlight(null));
    actions.append(b);
  }
  renderTimeline();
  $('plFirst').disabled = $('plPrev').disabled = S.cursor === 0;
  $('plNext').disabled = $('plLast').disabled = S.cursor >= S.steps.length;
  $('plPlay').disabled = S.steps.length === 0;
  $('plPlay').textContent = S.playing ? '⏸ Pause' : S.cursor >= S.steps.length && S.steps.length ? '↺ Replay' : '▶ Play';
  if (document.activeElement !== $('gridText')) $('gridText').value = formatGrid(S.start.cells, ' / ');
  refreshOptimum(state);
}

function renderTimeline() {
  const list = $('timeline');
  list.replaceChildren();
  $('timelineHint').textContent = S.steps.length ? `— ${S.source}` : '';
  if (!S.steps.length) { list.append(el('li', { className: 'empty', textContent: 'Open gates, or press Solve.' })); return; }
  let total = 0;
  S.steps.forEach((step, k) => {
    total += step.cost;
    const a = model.actions[step.a];
    const li = el('li', { className: k + 1 === S.cursor ? 'current' : k < S.cursor ? 'done' : '', title: explainStep(step) }, [
      el('span', { className: 'n', textContent: k + 1 }),
      el('span', {}, [el('span', { className: 'kind', textContent: a.type }), a.label]),
      el('span', { className: 'c', textContent: `+${step.cost}` }),
      el('span', { className: 't', textContent: total }),
    ]);
    li.addEventListener('click', () => jump(k + 1));
    list.append(li);
  });
}

// ------------------------------------------------------------------ playing

function makeStep(before, id) {
  const events = [];
  const r = model.apply(before, id, events);
  return r ? { a: id, cost: r.cost, state: r.state, events, before, s: r.s, s2: r.s2 } : null;
}
async function manualAction(id) {
  if (S.playing) return;
  cancelSearch();
  const step = makeStep(current(), id);
  if (!step) return;
  if (S.cursor < S.steps.length || S.source !== 'manual') { S.steps = S.steps.slice(0, S.cursor); S.source = 'manual'; }
  S.steps.push(step);
  await forward();
}
async function forward() {
  if (S.cursor >= S.steps.length) return false;
  const step = S.steps[S.cursor];
  const mine = generation;
  board.setAvailable(new Map());
  const ok = await board.animate(step.before, step.events, step.state, step.a, S.speed);
  if (mine !== generation || !ok) return false;
  S.cursor++;
  refresh();
  return true;
}
function jump(k) { S.playing = false; S.cursor = Math.max(0, Math.min(S.steps.length, k)); refresh(); }
async function play() {
  if (S.playing) { S.playing = false; board.cancel(); refresh(); return; }
  if (!S.steps.length) return;
  if (S.cursor >= S.steps.length) S.cursor = 0;
  S.playing = true;
  refresh();
  while (S.playing && S.cursor < S.steps.length) {
    if (!(await forward())) break;
    await new Promise((r) => setTimeout(r, 140 / S.speed));
  }
  S.playing = false;
  refresh();
}
function loadPath(path, source) {
  generation++;
  board.cancel();
  S.steps = [];
  S.cursor = 0;
  S.playing = false;
  S.source = source;
  let state = S.start;
  for (const id of path) { const step = makeStep(state, id); if (!step) break; S.steps.push(step); state = step.state; }
  refresh();
}

// ------------------------------------------------------------------ editing

function paint(i) {
  if (S.playing) return;
  const cells = S.start.cells.slice();
  cells[i] = S.brush;
  setStart(cells);
}
function setRows(rows) {
  rows = Math.max(1, Math.min(MAX_ROWS, rows));
  if (rows === S.rows) return;
  const cells = new Uint8Array(rows * 2);
  cells.set(S.start.cells.subarray(0, Math.min(S.start.cells.length, cells.length)));
  S.rows = rows;
  syncSetup();
  rebuildModel();
  setStart(cells);
}
function swatch(code) {
  const s = el('span', { className: 'swatch' });
  if (code !== EMPTY) s.append(el('i', { className: 'sand', style: `height:${code === SAND_HALF ? 50 : 100}%` }));
  return s;
}
function syncSetup() {
  $('rowsOut').textContent = S.rows;
  $('spaceHint').textContent = `${S.rows}×2 · ${int(3 ** (S.rows * 2))} initial states`;
  const brushes = $('brushes');
  brushes.replaceChildren();
  for (const code of [EMPTY, SAND_HALF, SAND_FULL]) {
    const b = el('button', { className: `brush${code === S.brush ? ' on' : ''}` }, [swatch(code), CELL_NAMES[code]]);
    b.addEventListener('click', () => { S.brush = code; syncSetup(); });
    brushes.append(b);
  }
}

// ------------------------------------------------------------------ solving

function setBusy(on, label = 'Searching…') {
  $('btnSolve').disabled = $('btnCompare').disabled = on;
  $('btnSolve').textContent = on ? label : 'Solve';
}
function badge(cost, optimum) {
  if (optimum === null) return el('span', { className: 'badge warn', textContent: 'optimum unknown' });
  if (cost === optimum) return el('span', { className: 'badge good', textContent: 'optimal' });
  return el('span', { className: 'badge warn', textContent: `+${(((cost - optimum) / optimum) * 100).toFixed(0)}% vs optimum ${optimum}` });
}
function showResult(label, r, optimum) {
  const box = $('solveResult');
  box.hidden = false;
  box.replaceChildren();
  if (!r.found) {
    box.append(el('div', { className: 'big', textContent: r.aborted ? 'Stopped at the search limit' : 'No solution' }), el('div', { textContent: label }));
    return;
  }
  box.append(
    el('div', { className: 'big' }, [`Cost ${r.cost} `, el('small', { textContent: `in ${r.steps} actions · ${r.sides} side gate${r.sides === 1 ? '' : 's'}` })]),
    el('div', {}, [`${label} `, badge(r.cost, optimum)]),
  );
  const dl = el('dl');
  for (const [k, v] of [['Effective branching factor b*', r.ebf ? r.ebf.toFixed(3) : '—'], ['States expanded', int(r.expanded)], ['States generated', int(r.generated)], ['Peak memory (states)', int(r.maxMemory)], ['Time', `${fmtMs(r.timeMs)} ms`]]) dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
  box.append(dl);
}
async function solve() {
  if (S.searching) return;
  const algo = $('algo').value;
  const heuristic = $('heur').value;
  const label = `${ALGORITHMS[algo].name} with ${HEURISTICS[heuristic].short} ${HEURISTICS[heuristic].name.toLowerCase()}`;
  const mine = ++generation;
  board.cancel();
  S.playing = false;
  S.searching = true;
  setBusy(true);
  try {
    const res = await rpc('solve', { cfg: modelCfg(), cells: Array.from(S.start.cells), algo, heuristic });
    if (mine !== generation) return;
    showResult(label, res.result, res.optimum);
    loadPath(res.result.path, label);
    S.searching = false;
    setBusy(false);
    if (res.result.found) play();
  } catch (err) {
    if (err.message !== 'cancelled') { $('solveResult').hidden = false; $('solveResult').textContent = `Search failed: ${err.message}`; }
  } finally {
    if (mine === generation) { S.searching = false; setBusy(false); }
  }
}
async function compare() {
  if (S.searching) return;
  const mine = ++generation;
  board.cancel();
  S.playing = false;
  S.searching = true;
  setBusy(true, 'Comparing…');
  try {
    const { results } = await rpc('compare', { cfg: modelCfg(), cells: Array.from(S.start.cells), variants: COMPARE });
    if (mine !== generation) return;
    const exact = results.filter((r) => r.found && ALGORITHMS[r.algo].optimal && (!r.heuristic || HEURISTICS[r.heuristic].admissible)).map((r) => r.cost);
    const optimum = exact.length ? Math.min(...exact) : null;
    const table = $('compareTable');
    const head = ['Algorithm', 'Heuristic', 'Cost', '', 'Actions', 'b*', 'Expanded', 'Generated', 'Peak memory', 'Time (ms)'];
    table.replaceChildren(el('thead', {}, el('tr', {}, head.map((t, i) => el('th', { className: i >= 2 && i !== 3 ? 'num' : '', textContent: t })))));
    const body = el('tbody');
    for (const r of results) {
      const tr = el('tr', { className: r.found ? 'pick' : '' }, [
        el('td', { textContent: ALGORITHMS[r.algo].name }),
        el('td', { textContent: r.heuristic ? `${HEURISTICS[r.heuristic].short} ${HEURISTICS[r.heuristic].name}` : 'h₀ (none)' }),
        el('td', { className: 'num', textContent: r.found ? r.cost : '—' }),
        el('td', {}, r.found ? badge(r.cost, optimum) : el('span', { className: 'badge warn', textContent: r.aborted ? 'limit reached' : 'no solution' })),
        el('td', { className: 'num', textContent: r.found ? r.steps : '—' }),
        el('td', { className: 'num', textContent: r.ebf ? r.ebf.toFixed(3) : '—' }),
        el('td', { className: 'num', textContent: int(r.expanded) }),
        el('td', { className: 'num', textContent: int(r.generated) }),
        el('td', { className: 'num', textContent: int(r.maxMemory) }),
        el('td', { className: 'num', textContent: fmtMs(r.timeMs) }),
      ]);
      if (r.found) tr.addEventListener('click', () => { showResult(`${ALGORITHMS[r.algo].name} with ${r.heuristic ? HEURISTICS[r.heuristic].short : 'h₀'}`, r, optimum); loadPath(r.path, r.label); $('boardWrap').scrollIntoView({ behavior: 'smooth', block: 'center' }); play(); });
      body.append(tr);
    }
    table.append(body);
    $('compareCard').hidden = false;
    $('compareCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    if (err.message !== 'cancelled') { $('compareCard').hidden = false; $('compareTable').replaceChildren(el('caption', { textContent: `Comparison failed: ${err.message}` })); }
  } finally {
    if (mine === generation) { S.searching = false; setBusy(false); }
  }
}

// ------------------------------------------------------------- learned tab

let learnedLoaded = false;
async function renderLearned() {
  if (learnedLoaded) return;
  learnedLoaded = true;
  const body = $('learnedBody');
  let d;
  try { d = await (await fetch(`${DATA}a2-regression.json`)).json(); } catch (err) {
    body.append(el('div', { className: 'card', textContent: `Could not load data/a2-regression.json: ${err.message}` }));
    return;
  }
  const m = (x) => [['States', int(x.states)], ['R²', x.r2.toFixed(3)], ['RMSE', x.rmse.toFixed(2)], ['Mean absolute error', x.mae.toFixed(2)], ['Overestimates h*', `${pct(x.overestimateShare)} of states`], ['Mean overestimate (when it does)', `+${x.meanOverestimate.toFixed(2)}`], ['Largest overestimate', `+${x.maxOverestimate.toFixed(2)}`], ['Mean h / h*', x.meanRatio.toFixed(3)], ['Largest h / h*', x.maxRatio.toFixed(2)]];
  const metricsTable = (title, x) => el('div', {}, [el('h3', { textContent: title }), el('table', { className: 'data compact' }, el('tbody', {}, m(x).map(([k, v]) => el('tr', {}, [el('td', { textContent: k }), el('td', { className: 'num', textContent: v })]))))]);

  const coef = el('article', { className: 'card prose' }, [
    el('h2', { textContent: 'The fitted model' }),
    el('p', { className: 'sub', textContent: `h₄ = w · features, least squares on the ${int(d.states)} non-goal reachable states of the ${d.rows}×2 grid (trained ${new Date(d.trainedAt).toLocaleDateString('en-GB')}). h₅ = max(h₂, h₄ − ${d.safeShift.toFixed(2)}).` }),
    el('div', { className: 'table-wrap' }, el('table', { className: 'data compact' }, [
      el('thead', {}, el('tr', {}, [el('th', { textContent: 'Feature' }), el('th', { className: 'num', textContent: 'Weight' })])),
      el('tbody', {}, d.names.map((n, i) => el('tr', {}, [el('td', { className: 'wrap', textContent: n }), el('td', { className: 'num', textContent: d.weights[i].toFixed(3) })]))),
    ])),
    el('p', { className: 'note', textContent: 'The weights are not separately meaningful: the features are strongly correlated (every box with sand also counts in the sand, the gates and the height), so the model balances large positive and negative terms. Read them as a whole.' }),
  ]);
  const quality = el('article', { className: 'card prose' }, [
    el('h2', { textContent: 'How good is it?' }),
    el('div', { className: 'two' }, [metricsTable('h₄ — all reachable states', d.all), metricsTable('h₄ — initial states only', d.initialOnly), metricsTable('h₅ (made safe) — all states', d.safeAll), metricsTable('h₂ (proven) — for comparison', d.h2Only)]),
    d.transfer ? el('p', { className: 'note', textContent: `Generalisation: a model trained on the ${d.transfer.trainedOn} grid and applied to ${d.rows}×2 reaches R² ${d.transfer.onTarget.r2.toFixed(3)} with RMSE ${d.transfer.onTarget.rmse.toFixed(2)}, but overestimates ${pct(d.transfer.onTarget.overestimateShare)} of the states (largest +${d.transfer.onTarget.maxOverestimate.toFixed(1)}).` }) : '',
  ]);
  body.append(coef, quality);

  const grid = el('div', { className: 'chart-grid', style: 'grid-column: 1 / -1' });
  body.append(grid);
  const cloud = (idx, title, sub, xTitle) => {
    const map = new Map();
    for (const p of d.sample) { const x = Math.round(p[idx]); const k = `${x},${p[0]}`; const e = map.get(k); if (e) e[2]++; else map.set(k, [x, p[0], 1, null]); }
    const chart = el('div');
    grid.append(el('div', { className: 'card chart-card' }, [el('div', { className: 'chart-head' }, el('div', {}, [el('h2', { textContent: title }), el('p', { className: 'sub', textContent: sub })])), chart]));
    bubbles(chart, { points: [...map.values()], xTitle, yTitle: 'true cost-to-go h*', diagonal: true, diagonalLabel: 'h = h*', tip: (p) => `h ${p[0]} · h* ${p[1]}<br><b>${int(p[2])}</b> sampled state${p[2] === 1 ? '' : 's'}` });
  };
  cloud(2, 'h₄ against h*', `${int(d.sample.length)} sampled reachable states; points above the line underestimate, below it overestimate.`, 'h₄ (regression, rounded)');
  cloud(3, 'h₅ against h*', 'The safe version never crosses the line on the training states, and is never below h₂.', 'h₅ (rounded)');
  cloud(1, 'h₂ against h*', 'The proven bound: always below the line, with a wide gap on the costly states.', 'h₂ (closed gates)');
}

// ---------------------------------------------------------- evaluation tab

let evalLoaded = false;
async function renderEval() {
  if (evalLoaded) return;
  evalLoaded = true;
  const body = $('evalBody');
  let data;
  try { data = await (await fetch(`${DATA}a2-5x2.json`)).json(); } catch (err) {
    body.append(el('div', { className: 'card', textContent: `The evaluation dataset (data/a2-5x2.json) is not available: ${err.message}. Run "node scripts/analyze.mjs --only a2-5x2.json" to generate it.` }));
    return;
  }
  const { meta, optimal, algos } = data;
  const by = Object.fromEntries(algos.map((a) => [a.key, a]));
  const greedy = by.greedy;
  const m5 = new Sandbox({ rows: meta.rows });
  const gridText = (key) => formatGrid(m5.decode(key).cells, ' / ');
  const open = (key, algoKey) => { const v = by[algoKey]; showTab('explore'); loadGrid(m5.decode(key).cells); if (v && v.algo !== 'sweep') { $('algo').value = v.algo; $('heur').value = v.heuristic || 'gap'; } };

  body.append(el('p', { className: 'sub', textContent: `All ${int(meta.count)} initial states of the ${meta.rows}×2 grid, ${algos.length} runs each. Computed in ${fmt(meta.wallSeconds)} s on ${meta.workers} workers — ${meta.cpu}, ${meta.environment}. ${meta.optimalityMismatches === 0 ? 'Every exact run agrees with value iteration.' : `${meta.optimalityMismatches} mismatches!`}` }));

  const tiles = [
    ['Mean optimal cost', fmt(optimal.cost.mean), `max ${optimal.cost.max}, mean plan ${fmt(optimal.steps.mean)} actions`],
    ['b* of UCS (h₀)', by.ucs.ebf.mean.toFixed(3), `median ${by.ucs.ebf.median.toFixed(3)}`],
    ['b* of A* with h₂', by['astar-gap'].ebf.mean.toFixed(3), `median ${by['astar-gap'].ebf.median.toFixed(3)}`],
    ['b* of A* with h₄', by['astar-learned'].ebf.mean.toFixed(3), `optimal on ${pct(by['astar-learned'].optimal / meta.count)} of states`],
    ['b* of A* with h₅', by['astar-safe'].ebf.mean.toFixed(3), `optimal on ${pct(by['astar-safe'].optimal / meta.count)} of states`],
    ['Greedy approach optimal on', pct(greedy.optimal / meta.count), `mean ratio ${greedy.ratio.mean.toFixed(3)}, worst ${greedy.ratio.max.toFixed(2)}`],
  ];
  body.append(el('div', { className: 'stat-row' }, tiles.map(([k, v, s]) => el('div', { className: 'stat' }, [el('span', { textContent: k }), el('b', { textContent: v }), el('small', { textContent: s })]))));

  const card = (title, sub, wide = false) => { const chart = el('div'); const foot = el('p', { className: 'chart-foot' }); const c = el('div', { className: `card chart-card${wide ? ' wide' : ''}` }, [el('div', { className: 'chart-head' }, el('div', {}, [el('h2', { textContent: title }), el('p', { className: 'sub', textContent: sub })])), chart, foot]); return { c, chart, foot }; };
  const grid = el('div', { className: 'chart-grid' });
  body.append(grid);

  const informed = algos.filter((a) => a.key !== 'greedy' && a.key !== 'bfs');
  const label = (a) => a.heuristic ? `${ALGORITHMS[a.algo].name} · ${HEURISTICS[a.heuristic].short}` : `${ALGORITHMS[a.algo].name} · h₀`;
  const ebf = card('Effective branching factor b*', 'Mean over the states each run finished; closer to 1 is better. Linear axis.', true);
  grid.append(ebf.c);
  dotPlot(ebf.chart, { linear: true, min: 1, rows: informed.map((a) => ({ label: label(a), value: a.ebf.mean, tip: `${label(a)}<br>mean b* <b>${a.ebf.mean.toFixed(3)}</b> · median <b>${a.ebf.median.toFixed(3)}</b> · p95 <b>${a.ebf.p95.toFixed(3)}</b><br>finished ${int(a.solved)} states${a.aborted ? `, ${int(a.aborted)} hit the budget` : ''}` })), xTitle: 'b* (mean per state)' });
  ebf.foot.textContent = 'b* solves 1 + b + b² + … + b^d = N + 1, with N the states generated and d the length of the plan returned. RBFS finishes only part of the states within its budget; its b* is over those.';

  const perf = card('Search effort and plan quality per heuristic', 'One run per state; A* with each heuristic, RBFS with two of them, UCS and Weighted A* for reference.', true);
  grid.append(perf.c);
  const head = ['Run', 'Optimal on', 'Mean cost ÷ opt', 'Worst', 'Mean b*', 'Median b*', 'Mean expanded', 'Mean generated', 'Mean memory', 'Mean time (ms)', 'Hit the budget'];
  perf.chart.append(el('div', { className: 'table-wrap' }, el('table', { className: 'data compact' }, [
    el('thead', {}, el('tr', {}, head.map((t, i) => el('th', { className: i ? 'num' : '', textContent: t })))),
    el('tbody', {}, algos.map((a) => el('tr', {}, [
      el('td', { textContent: a.key === 'greedy' ? 'Greedy approach' : label(a) }),
      el('td', { className: 'num', textContent: pct(a.optimal / meta.count) }),
      el('td', { className: 'num', textContent: a.ratio.mean.toFixed(3) }),
      el('td', { className: 'num', textContent: a.ratio.max.toFixed(2) }),
      el('td', { className: 'num', textContent: a.ebf.mean ? a.ebf.mean.toFixed(3) : '—' }),
      el('td', { className: 'num', textContent: a.ebf.median ? a.ebf.median.toFixed(3) : '—' }),
      el('td', { className: 'num', textContent: fmt(a.expanded.mean) }),
      el('td', { className: 'num', textContent: fmt(a.generated.mean) }),
      el('td', { className: 'num', textContent: fmt(a.memory.mean) }),
      el('td', { className: 'num', textContent: fmt(a.timeMs.mean) }),
      el('td', { className: 'num', textContent: a.aborted ? int(a.aborted) : '0' }),
    ]))),
  ])));

  const hist = card('Greedy_opt_ratio = cost by greedy solution ÷ optimum cost', 'The greedy approach of the assignment (straight-down sweep, no side gates) over all states with sand.');
  grid.append(hist.c);
  const bars = [{ label: '1', value: greedy.ratio.exact, accent: true, tip: `Ratio exactly 1: <b>${int(greedy.ratio.exact)}</b> states` }];
  greedy.ratio.bins.forEach((count, i) => { const hi = 1 + (i + 1) * greedy.ratio.binWidth; const v = i === 0 ? count - greedy.ratio.exact : count; bars.push({ label: hi.toFixed(2), value: v, tip: `Ratio ${i === 0 ? 'above 1.00' : `from ${(hi - greedy.ratio.binWidth).toFixed(2)}`} to below ${hi.toFixed(2)}: <b>${int(v)}</b> states` }); });
  columns(hist.chart, { bars, xTitle: 'cost ratio (bar label = upper edge of the bin; first bar = exactly 1)', yTitle: 'states' });
  hist.foot.textContent = `Mean ${greedy.ratio.mean.toFixed(3)}, median ${greedy.ratio.median.toFixed(3)}, 95th percentile ${greedy.ratio.p95.toFixed(2)}, maximum ${greedy.ratio.max.toFixed(2)}.`;

  const sc1 = card('Cost by greedy solution against the optimum', 'Circle area = number of states; click one to open an example in the explorer.');
  grid.append(sc1.c);
  bubbles(sc1.chart, { points: greedy.costVsOpt, xTitle: 'cost by greedy solution', yTitle: 'optimum cost', diagonal: true, diagonalLabel: 'cost = optimum', tip: (p) => `greedy <b>${p[0]}</b> · optimum <b>${p[1]}</b><br><b>${int(p[2])}</b> state${p[2] === 1 ? '' : 's'} · e.g. ${gridText(p[3])}`, onPick: (p) => open(p[3], 'greedy') });

  const sc2 = card('Actions to the goal against side-gate actions', 'Optimal plans: x = number of actions, y = how many are of type b.');
  grid.append(sc2.c);
  bubbles(sc2.chart, { points: optimal.actions, xTitle: 'number of actions to the goal state', yTitle: 'actions of type b', integerAxes: true, tip: (p) => `<b>${p[0]}</b> actions, <b>${p[1]}</b> side gate${p[1] === 1 ? '' : 's'}<br><b>${int(p[2])}</b> state${p[2] === 1 ? '' : 's'} · e.g. ${gridText(p[3])}`, onPick: (p) => open(p[3], 'astar-gap') });

  const sc3 = card('Side-gate actions in the plans of A* with h₄', 'The learned heuristic is not admissible: these are the plans it actually returns.');
  grid.append(sc3.c);
  bubbles(sc3.chart, { points: by['astar-learned'].actions, xTitle: 'number of actions to the goal state', yTitle: 'actions of type b', integerAxes: true, tip: (p) => `<b>${p[0]}</b> actions, <b>${p[1]}</b> side gate${p[1] === 1 ? '' : 's'}<br><b>${int(p[2])}</b> state${p[2] === 1 ? '' : 's'} · e.g. ${gridText(p[3])}`, onPick: (p) => open(p[3], 'astar-learned') });

  const scale = card('States expanded against the length of the optimal plan', 'Mean per state; logarithmic vertical axis.', true);
  grid.append(scale.c);
  const legend = el('div', { className: 'legend' });
  scale.chart.before(legend);
  const shown = new Set(['ucs', 'astar-gap', 'astar-learned', 'astar-safe']);
  const draw = () => lines(scale.chart, { series: informed.filter((a) => SERIES[a.key] && shown.has(a.key)).map((a) => ({ label: label(a), color: `var(--series-${SERIES[a.key]})`, points: a.byDepth.filter((d) => d.depth > 0 && d.expanded > 0).map((d) => [d.depth, d.expanded]) })), xTitle: 'actions in the optimal plan', yTitle: 'states expanded — mean', tipTitle: (x) => `Optimal plan of <b>${x}</b> actions` });
  for (const a of informed) {
    if (!SERIES[a.key]) continue;
    const b = el('button', {}, [el('i', { style: `background:var(--series-${SERIES[a.key]})` }), label(a)]);
    b.setAttribute('aria-pressed', String(shown.has(a.key)));
    b.addEventListener('click', () => { if (shown.has(a.key)) shown.delete(a.key); else shown.add(a.key); b.setAttribute('aria-pressed', String(shown.has(a.key))); draw(); });
    legend.append(b);
  }
  draw();
}

// --------------------------------------------------------------------- tabs

const TABS = ['explore', 'learned', 'eval', 'design'];
function showTab(name) {
  if (!TABS.includes(name)) name = 'explore';
  for (const t of TABS) { $(`tab-${t}`).hidden = t !== name; $(`tabbtn-${t}`).setAttribute('aria-selected', String(t === name)); }
  if (name === 'learned') renderLearned();
  if (name === 'eval') renderEval();
  if (name === 'explore') { board.layout(); board.draw(); }
  history.replaceState(null, '', name === 'explore' ? location.pathname + location.search : `#${name}`);
}

// --------------------------------------------------------------------- init

function init() {
  for (const id of ['astar', 'rbfs', 'wastar', 'gbfs', 'idastar']) $('algo').append(el('option', { value: id, textContent: `${ALGORITHMS[id].name} — ${ALGORITHMS[id].long}` }));
  for (const [id, h] of Object.entries(HEURISTICS)) $('heur').append(el('option', { value: id, textContent: `${h.short} · ${h.name}${h.admissible ? '' : ' (not admissible)'}` }));
  $('heur').value = 'gap';
  const hint = () => { $('heurHint').textContent = HEURISTICS[$('heur').value].note; };
  hint();
  $('heur').addEventListener('change', hint);
  $('preset').append(el('option', { value: '', textContent: 'Choose an example…' }));
  PRESETS.forEach((p, i) => $('preset').append(el('option', { value: i, textContent: p.name })));
  $('preset').addEventListener('change', () => { const p = PRESETS[$('preset').value]; if (p) loadGrid(parseGrid(p.grid)); $('preset').value = ''; });
  $('rowsMinus').addEventListener('click', () => setRows(S.rows - 1));
  $('rowsPlus').addEventListener('click', () => setRows(S.rows + 1));
  $('btnRandom').addEventListener('click', () => setStart(model.random(PROBS_SAND)));
  $('btnClear').addEventListener('click', () => setStart(model.empty()));
  const loadText = () => {
    try {
      const cells = parseGrid($('gridText').value);
      if (cells.length < 2 || cells.length > MAX_ROWS * 2) throw new RangeError(`use between 1 and ${MAX_ROWS} rows`);
      if (cells.some((c) => c > SAND_FULL)) throw new RangeError('this project uses sand only (0, ½, 1)');
      $('gridText').blur();
      loadGrid(cells);
    } catch (err) { $('gridError').textContent = err.message; $('gridError').hidden = false; }
  };
  $('btnLoadText').addEventListener('click', loadText);
  $('gridText').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadText(); });
  $('btnSolve').addEventListener('click', solve);
  $('btnCompare').addEventListener('click', compare);
  $('plPlay').addEventListener('click', play);
  $('plFirst').addEventListener('click', () => { board.cancel(); jump(0); });
  $('plPrev').addEventListener('click', () => { board.cancel(); jump(S.cursor - 1); });
  $('plLast').addEventListener('click', () => { board.cancel(); jump(S.steps.length); });
  $('plNext').addEventListener('click', async () => { if (!S.playing && !board.busy) await forward(); });
  $('speed').addEventListener('change', () => { S.speed = Number($('speed').value); });
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || $('tab-explore').hidden) return;
    if (e.target.closest('input, select, textarea, button, [role="tab"], summary, a')) return;
    const keys = { ' ': 'plPlay', ArrowRight: 'plNext', ArrowLeft: 'plPrev', Home: 'plFirst', End: 'plLast' };
    const id = keys[e.key];
    if (!id || $(id).disabled) return;
    e.preventDefault();
    $(id).click();
  });
  for (const t of TABS) $(`tabbtn-${t}`).addEventListener('click', () => showTab(t));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'explore'));
  $('themeToggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('sandboxes-theme', document.documentElement.dataset.theme); } catch { /* blocked */ }
    board.readTheme();
  });
  try { const saved = localStorage.getItem('sandboxes-theme'); if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved; } catch { /* ignore */ }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => board.readTheme());
  board.readTheme();
  syncSetup();
  rebuildModel();
  let initial = parseGrid(PROFESSOR_EXAMPLE);
  const shared = new URLSearchParams(location.search).get('g');
  if (shared) { try { initial = parseGrid(shared.replaceAll('_', '/').replaceAll('-', ' ')); } catch { /* fall back */ } }
  loadGrid(initial);
  showTab(location.hash.slice(1) || 'explore');
}

init();
