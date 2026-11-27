// Assignment 3 page: the genetic algorithm — live evolution on one state, the operators shown step
// by step, the evaluation over all initial states, and the design notes.

import { Sandbox, parseGrid, formatGrid, PROBS_SAND, CELL_NAMES, MAX_ROWS, EMPTY, SAND_HALF, SAND_FULL, PROFESSOR_EXAMPLE } from '../core/model.js';
import { ALGORITHMS } from '../core/search.js';
import { HEURISTICS } from '../core/heuristics.js';
import { makeProblem } from '../core/problem.js';
import { Problem, Environment, SolverAgent, FITNESS, SELECTION, CONFLICTS, CONFLICT_MODES, TRANSFORMS, ILLEGAL, CROSSOVERS, MUTATIONS, DEFAULTS, selectionProbabilities } from '../core/genetic.js';
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

/** Variants compared on one state by the "Compare" button (keys of analysis.js ALL_VARIANTS). */
const COMPARE = ['greedy', 'ucs', 'astar-gap', 'ga', 'ga-end', 'ga-brief-ops', 'ga-double', 'ga-retry', 'ga-norepair', 'ga-roulette', 'ga-tournament', 'ga-strict', 'ga-boxes', 'ga-fall', 'ga-h2'];

const PRESETS = [
  { name: 'Assignment example (4×2)', grid: PROFESSOR_EXAMPLE },
  { name: 'Hardest 5×2 state (optimum 76)', grid: '1 1/1 1/1 1/0 0/0 0' },
  { name: 'Worst case for the greedy approach', grid: '1 0/1 ½/0 1/½ 0/1 0' },
  { name: 'Full tower (5×2)', grid: '1 1/1 1/1 1/1 1/1 1' },
  { name: 'Halves and gaps (5×2)', grid: '½ 1/0 ½/1 0/½ ½/0 1' },
];

const S = { rows: 5, brush: SAND_FULL, start: null, steps: [], cursor: 0, playing: false, speed: 1, source: 'manual', searching: false, optimum: null, run: null };
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
      if (e.data.progress) { p.onProgress?.(e.data.progress); return; }
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
    };
    worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'worker failed')); pending.clear(); };
  }
  return worker;
}
const rpc = (type, payload, onProgress = null) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  pending.set(id, { resolve, reject, onProgress });
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
  S.run = null;
  S.optimum = null;
  $('solveResult').hidden = true;
  $('compareCard').hidden = true;
  $('liveCards').hidden = true;
  $('gridError').hidden = true;
  $('statBest').textContent = '—';
  $('statGen').textContent = '0';
  $('statEvals').textContent = '0';
  operatorsDirty = true;
  refresh();
  refreshOptimum();
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
async function refreshOptimum() {
  const state = S.start;
  if (model.isGoal(state)) { S.optimum = 0; $('statOpt').textContent = '0'; return; }
  const my = ++optRequest;
  $('statOpt').textContent = '…';
  try {
    const res = await rpc('solve', { cfg: modelCfg(), cells: Array.from(state.cells), algo: 'astar', heuristic: 'gap' });
    if (my !== optRequest) return;
    S.optimum = res.result.found ? res.result.cost : null;
    $('statOpt').textContent = S.optimum === null ? '—' : S.optimum;
    if (S.run) drawCharts(S.run.shown);
  } catch {
    if (my === optRequest) setTimeout(() => { if (my === optRequest) { optRequest--; refreshOptimum(); } }, 300);
  }
}

function refresh() {
  const state = current();
  const avail = availableFor(state);
  board.show(state);
  board.setAvailable(avail);
  const cost = S.steps.slice(0, S.cursor).reduce((s, x) => s + x.cost, 0);
  const status = $('status');
  status.className = 'status';
  if (model.isGoal(state)) { status.textContent = S.cursor ? `Goal reached. Total cost ${cost}.` : 'No sand: already a goal state.'; status.classList.add('good'); } else status.textContent = S.cursor ? `Cost so far ${cost}, ${S.cursor} action${S.cursor === 1 ? '' : 's'}.` : '';
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
}

function renderTimeline() {
  const list = $('timeline');
  list.replaceChildren();
  $('timelineHint').textContent = S.steps.length ? `— ${S.source}` : '';
  if (!S.steps.length) { list.append(el('li', { className: 'empty', textContent: 'Press Evolve, or open gates by hand.' })); return; }
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

// --------------------------------------------------------------- parameters

function params() {
  const num = (id, fallback) => { const v = Number($(id).value); return Number.isFinite(v) ? v : fallback; };
  return {
    population: Math.max(2, Math.round(num('pPopulation', DEFAULTS.population))),
    generations: Math.max(1, Math.round(num('pGenerations', DEFAULTS.generations))),
    maxLength: $('pMaxLength').value === '' ? null : Math.max(1, Math.round(num('pMaxLength', 4 * S.rows))),
    elite: Math.max(0, Math.round(num('pElite', DEFAULTS.elite))),
    crossoverRate: Math.min(1, Math.max(0, num('pCrossover', DEFAULTS.crossoverRate))),
    mutationRate: Math.min(1, Math.max(0, num('pMutation', DEFAULTS.mutationRate))),
    stagnation: Math.max(0, Math.round(num('pStagnation', DEFAULTS.stagnation))),
    seed: Math.round(num('pSeed', DEFAULTS.seed)),
    selection: $('pSelection').value,
    fitness: $('pFitness').value,
    conflicts: $('pConflicts').value,
    conflictWeight: num('pWeight', CONFLICTS[$('pConflicts').value].weight),
    conflictMode: $('pConflictMode').value,
    costWeight: Math.max(0, num('pCostWeight', DEFAULTS.costWeight)),
    conflictTransform: $('pConflictTransform').value,
    costTransform: $('pCostTransform').value,
    illegal: $('pIllegal').value,
    crossover: $('pCrossoverType').value,
    mutations: [...$('pMutations').querySelectorAll('input:checked')].map((b) => b.value),
  };
}
const maxLengthOf = (p) => p.maxLength ?? 4 * S.rows;
const genesText = (genes) => genes.map((a) => model.actions[a].short).join(' ');

// ----------------------------------------------------------------- evolving

function setBusy(on, label = 'Evolving…') {
  $('btnEvolve').disabled = $('btnCompare').disabled = on;
  $('btnEvolve').textContent = on ? label : 'Evolve';
}
function badge(cost, optimum) {
  if (optimum === null) return el('span', { className: 'badge warn', textContent: 'optimum unknown' });
  if (cost === optimum) return el('span', { className: 'badge good', textContent: 'optimal' });
  return el('span', { className: 'badge warn', textContent: `+${(((cost - optimum) / optimum) * 100).toFixed(0)}% vs optimum ${optimum}` });
}

function drawCharts(upTo) {
  const run = S.run;
  if (!run) return;
  const hist = run.history.slice(0, upTo + 1);
  const L = run.largeNumber;
  const series = [
    { label: 'best', color: 'var(--series-3)', points: hist.map((h) => [h.gen, h.best]) },
    { label: 'mean', color: 'var(--series-1)', points: hist.map((h) => [h.gen, h.mean]) },
    { label: 'worst', color: 'var(--series-8)', points: hist.map((h) => [h.gen, h.worst]) },
  ];
  if (S.optimum !== null && L) series.push({ label: 'optimal plan', color: 'var(--muted)', points: hist.map((h) => [h.gen, L - S.optimum]) });
  lines($('fitnessChart'), { linear: true, series, xTitle: 'generation', yTitle: 'fitness', tipTitle: (x) => `Generation <b>${x}</b>` });
  const costSeries = [];
  const bestCost = hist.filter((h) => h.bestEverCost !== null).map((h) => [h.gen, h.bestEverCost]);
  if (bestCost.length) costSeries.push({ label: 'best solution', color: 'var(--series-3)', points: bestCost });
  if (S.optimum !== null) costSeries.push({ label: 'optimum', color: 'var(--muted)', points: hist.map((h) => [h.gen, S.optimum]) });
  const goalShare = hist.map((h) => [h.gen, Math.round(100 * h.goalShare)]);
  costSeries.push({ label: '% at the goal', color: 'var(--series-7)', points: goalShare });
  if (costSeries.length) lines($('costChart'), { linear: true, yMin: 0, series: costSeries, xTitle: 'generation', yTitle: 'cost · percent of population', tipTitle: (x) => `Generation <b>${x}</b>` });
  else $('costChart').replaceChildren(el('p', { className: 'note', textContent: 'No goal path yet.' }));
}

function renderPopulation(info, method) {
  const table = $('popTable');
  const pop = info.population;
  const probs = selectionProbabilities(pop, method);
  const pMax = Math.max(...probs, 1e-9);
  $('popHint').textContent = `— generation ${info.gen}, ${pct(info.goalShare)} of the population reaches the goal${info.legalShare !== undefined && info.legalShare < 1 ? `, ${pct(info.legalShare)} legal` : ''}, ${info.unique} distinct sequences`;
  table.replaceChildren(
    el('thead', {}, el('tr', {}, ['#', 'Sequence', 'Length', 'path_cost', 'conflict_numbers', 'fitness', `p(selected), ${SELECTION[method].name.toLowerCase()}`].map((t, i) => el('th', { className: i >= 2 ? 'num' : '', textContent: t })))),
    el('tbody', {}, pop.map((x, i) => {
      const tr = el('tr', { className: 'pick' }, [
        el('td', { textContent: i + 1 }),
        el('td', { className: 'wrap' }, [el('code', { textContent: genesText(x.genes) || '(empty)' }), x.goal ? el('span', { className: 'badge good', textContent: 'goal', style: 'margin-left:6px' }) : '', x.legal ? '' : el('span', { className: 'badge bad', textContent: 'illegal', style: 'margin-left:6px' })]),
        el('td', { className: 'num', textContent: x.genes.length }),
        el('td', { className: 'num', textContent: x.legal ? x.cost : '—' }),
        el('td', { className: 'num', textContent: x.legal ? fmt(x.conflicts) : '—' }),
        el('td', { className: 'num', textContent: fmt(x.fitness) }),
        el('td', { className: 'num' }, el('span', { className: 'pbar', title: pct(probs[i]) }, [el('i', { style: `width:${(100 * probs[i]) / pMax}%` }), pct(probs[i])])),
      ]);
      tr.addEventListener('click', () => { loadPath(x.genes, `individual ${i + 1} of generation ${info.gen}`); $('boardWrap').scrollIntoView({ behavior: 'smooth', block: 'center' }); if (x.goal) play(); });
      return tr;
    })),
  );
}

function showResult(label, r, optimum) {
  const box = $('solveResult');
  box.hidden = false;
  box.replaceChildren();
  if (!r.found) {
    box.append(el('div', { className: 'big', textContent: 'No goal path found' }), el('div', { textContent: `${label}: in ${int(r.ga?.generations ?? r.iterations)} generations no individual reached the goal.` }));
    return;
  }
  box.append(
    el('div', { className: 'big' }, [`Cost ${r.cost} `, el('small', { textContent: `in ${r.steps} actions · ${r.sides} side gate${r.sides === 1 ? '' : 's'}` })]),
    el('div', {}, [`${label} `, badge(r.cost, optimum)]),
  );
  const dl = el('dl');
  const rows = r.ga
    ? [['Generations run', int(r.ga.generations)], ['First goal path in generation', r.ga.firstGoalGeneration < 0 ? '—' : r.ga.firstGoalGeneration], ['Best fitness reached in generation', int(r.ga.bestGeneration)], ['Fitness evaluations', int(r.expanded)], ['Actions applied in the environment', int(r.generated)], ...(r.ga.retries ? [['Operators redrawn (lethal mode)', int(r.ga.retries)]] : []), ['Length bound', int(r.ga.maxLength)], ['large_number', int(r.ga.largeNumber)], ['Time', `${fmtMs(r.timeMs)} ms`]]
    : [['States expanded', int(r.expanded)], ['States generated', int(r.generated)], ['Peak memory (states)', int(r.maxMemory)], ['Time', `${fmtMs(r.timeMs)} ms`]];
  for (const [k, v] of rows) dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
  box.append(dl);
}

async function evolve() {
  if (S.searching) return;
  const p = params();
  const mine = ++generation;
  board.cancel();
  S.playing = false;
  S.searching = true;
  setBusy(true);
  $('liveCards').hidden = false;
  $('solveResult').hidden = true;
  const run = { history: [], largeNumber: null, shown: 0, infos: [] };
  S.run = run;
  const pace = Number($('pace').value);
  let drawing = false;
  const showUpTo = (k) => {
    run.shown = k;
    const info = run.infos[k];
    $('statGen').textContent = int(info.gen);
    $('statEvals').textContent = int(info.evaluations);
    $('statBest').textContent = info.bestEverCost === null ? '—' : info.bestEverCost;
    drawCharts(k);
    renderPopulation(info, p.selection);
  };
  // generations arrive from the worker as they happen (the whole run takes milliseconds); the page
  // replays them at the chosen pace so the evolution can be watched
  const drain = async () => {
    if (drawing) return;
    drawing = true;
    while (run.shown < run.infos.length - 1 || (run.shown === 0 && run.infos.length === 1 && !run.drawnFirst)) {
      if (mine !== generation) { drawing = false; return; }
      const next = run.drawnFirst ? run.shown + 1 : 0;
      run.drawnFirst = true;
      showUpTo(next);
      if (pace > 0) await new Promise((r) => setTimeout(r, 1000 / pace));
    }
    drawing = false;
  };
  try {
    const res = await rpc('solve', { cfg: modelCfg(), cells: Array.from(S.start.cells), algo: 'ga', heuristic: 'gap', ga: p, stream: pace > 0 }, (info) => {
      if (mine !== generation) return;
      run.infos.push(info);
      run.history.push({ gen: info.gen, best: info.best, mean: info.mean, worst: info.worst, goalShare: info.goalShare, bestEverCost: info.bestEverCost });
      drain();
    });
    if (mine !== generation) return;
    const r = res.result;
    run.largeNumber = r.ga.largeNumber;
    if (!run.infos.length) {
      // instant mode: the worker did not stream, rebuild the display from the recorded history
      let bestEver = null;
      r.ga.history.forEach((h) => { if (h.bestCost !== null && (bestEver === null || h.bestCost < bestEver)) bestEver = h.bestCost; run.infos.push({ ...h, bestEverCost: bestEver, evaluations: r.expanded, population: r.ga.population }); });
      run.history = run.infos.map((h) => ({ gen: h.gen, best: h.best, mean: h.mean, worst: h.worst, goalShare: h.goalShare, bestEverCost: h.bestEverCost }));
      run.infos[run.infos.length - 1].population = r.ga.population;
      showUpTo(run.infos.length - 1);
    } else {
      while (drawing || run.shown < run.infos.length - 1) {
        if (mine !== generation) return;
        if (!drawing) drain();
        await new Promise((res2) => setTimeout(res2, 30));
      }
      run.infos[run.infos.length - 1].population = r.ga.population;
      showUpTo(run.infos.length - 1);
    }
    const label = `Genetic algorithm: ${SELECTION[p.selection].name.toLowerCase()}; ${FITNESS[p.fitness].name}; conflicts = ${CONFLICTS[p.conflicts].short} (${p.conflictMode === 'min' ? 'smallest along the sequence' : 'end state'}); ${CROSSOVERS[p.crossover].name.toLowerCase()} crossover; illegal: ${ILLEGAL[p.illegal].name.toLowerCase()}`;
    showResult(label, r, S.optimum);
    loadPath(r.path, 'best individual');
    S.searching = false;
    setBusy(false);
    if (r.found) play();
  } catch (err) {
    if (err.message !== 'cancelled') { $('solveResult').hidden = false; $('solveResult').textContent = `Run failed: ${err.message}`; }
  } finally {
    if (mine === generation) { S.searching = false; setBusy(false); }
  }
}

async function compare() {
  if (S.searching) return;
  const mine = ++generation;
  const p = params();
  board.cancel();
  S.playing = false;
  S.searching = true;
  setBusy(true, 'Comparing…');
  try {
    // only the size and budget settings are shared with the variants: each row keeps its own
    // selection, fitness, conflict function and weight, otherwise the rows would not differ
    const shared = { population: p.population, generations: p.generations, maxLength: p.maxLength, elite: p.elite, crossoverRate: p.crossoverRate, mutationRate: p.mutationRate, stagnation: p.stagnation, seed: p.seed };
    const { results } = await rpc('compare', { cfg: modelCfg(), cells: Array.from(S.start.cells), variants: COMPARE, ga: shared });
    if (mine !== generation) return;
    const exact = results.filter((r) => r.found && ALGORITHMS[r.algo].optimal && (!r.heuristic || HEURISTICS[r.heuristic].admissible)).map((r) => r.cost);
    const optimum = exact.length ? Math.min(...exact) : S.optimum;
    const table = $('compareTable');
    const head = ['Run', 'Cost', '', 'Actions', 'Side gates', 'Expanded / evaluations', 'Generated / actions applied', 'Generations', 'Time (ms)'];
    table.replaceChildren(el('thead', {}, el('tr', {}, head.map((t, i) => el('th', { className: i >= 1 && i !== 2 ? 'num' : '', textContent: t })))));
    const body = el('tbody');
    for (const r of results) {
      const tr = el('tr', { className: r.found ? 'pick' : '' }, [
        el('td', { textContent: r.label }),
        el('td', { className: 'num', textContent: r.found ? r.cost : '—' }),
        el('td', {}, r.found ? badge(r.cost, optimum) : el('span', { className: 'badge warn', textContent: r.aborted ? 'limit reached' : 'no goal path' })),
        el('td', { className: 'num', textContent: r.found ? r.steps : '—' }),
        el('td', { className: 'num', textContent: r.found ? r.sides : '—' }),
        el('td', { className: 'num', textContent: int(r.expanded) }),
        el('td', { className: 'num', textContent: int(r.generated) }),
        el('td', { className: 'num', textContent: r.ga ? int(r.ga.generations) : '—' }),
        el('td', { className: 'num', textContent: fmtMs(r.timeMs) }),
      ]);
      if (r.found) tr.addEventListener('click', () => { showResult(r.label, r, optimum); loadPath(r.path, r.label); $('boardWrap').scrollIntoView({ behavior: 'smooth', block: 'center' }); play(); });
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

// ------------------------------------------------------------ operators tab

let operatorsDirty = true;
let demoSeed = 7;
function renderOperators() {
  if (!operatorsDirty) return;
  operatorsDirty = false;
  const body = $('operatorsBody');
  body.replaceChildren();
  const p = params();
  const view = makeProblem(model, S.start, 'gap');
  const problem = new Problem(view, { maxLength: p.maxLength, conflicts: p.conflicts, conflictWeight: p.conflictWeight, conflictMode: p.conflictMode });
  const env = new Environment(view);
  const agent = new SolverAgent(problem, env, { ...p, seed: demoSeed, population: 10 });
  const L = problem.largeNumber;
  const w = problem.conflictWeight;

  const seq = (genes, marks = []) => el('code', { className: 'seq' }, genes.length ? genes.map((a, i) => el('span', { className: marks[i] || '', textContent: model.actions[a].short })) : [el('span', { className: 'muted', textContent: '(empty)' })]);
  const fT = TRANSFORMS[p.conflictTransform];
  const gT = TRANSFORMS[p.costTransform];
  const term = (t, x) => (t === TRANSFORMS.linear ? String(fmt(x)) : `${t.name.replace('x', fmt(x))}`);
  const breakdown = (x) => {
    if (!x.legal) return 'illegal action → 0';
    if (p.fitness === 'strict') return x.goal ? `${L} − ${p.costWeight}·${term(gT, x.cost)} = ${fmt(x.fitness)}` : 'not at the goal → 0';
    if (p.fitness === 'ratio') return `${L} ÷ (1 + ${w}·${term(fT, x.conflicts)} + ${p.costWeight}·${term(gT, x.cost)}) = ${fmt(x.fitness)}`;
    return `${L} − ${w}·${term(fT, x.conflicts)} − ${p.costWeight}·${term(gT, x.cost)} = ${fmt(x.fitness)}`;
  };

  // 1. representation and fitness on a small random population
  const pop = [];
  for (let i = 0; i < 10; i++) pop.push(agent.randomIndividual());
  pop.sort((a, b) => b.fitness - a.fitness);
  const methods = Object.keys(SELECTION);
  const probs = Object.fromEntries(methods.map((mth) => [mth, selectionProbabilities(pop, mth)]));
  const head = ['#', 'Sequence (a random legal walk)', 'Length', 'Goal?', 'path_cost', 'conflict number', 'fitness = ' + FITNESS[p.fitness].name, ...methods.map((mth) => SELECTION[mth].name)];
  const popCard = el('article', { className: 'card prose wide' }, [
    el('h2', { textContent: 'Steps 2 to 5 and 7: individuals, goal test, conflict number, fitness, selection probabilities' }),
    el('p', { className: 'sub', textContent: `Ten random individuals of the initial population for the current start state (seed ${demoSeed}): random legal walks of ${problem.maxLength} actions, cut at the first goal state (step 2 and 6.1). "Goal?" is the Path_Goal_Test (step 3). The conflict number is the ${CONFLICTS[p.conflicts].name.toLowerCase()}, ${CONFLICT_MODES[p.conflictMode].name} (step 4). large_number = ${L} (= 2 · ${problem.maxLength} · ${problem.maxStepCost} + 1), w₁ = ${w}, w₂ = ${p.costWeight}, f = ${fT.name}, g = ${gT.name} (step 5). The last columns turn fitness into a selection probability with each formula (step 7).` }),
    el('div', { className: 'table-wrap' }, el('table', { className: 'data compact' }, [
      el('thead', {}, el('tr', {}, head.map((t, i) => el('th', { className: i >= 2 ? 'num' : '', textContent: t })))),
      el('tbody', {}, pop.map((x, i) => el('tr', {}, [
        el('td', { textContent: i + 1 }), el('td', { className: 'wrap' }, seq(x.genes)), el('td', { className: 'num', textContent: x.genes.length }),
        el('td', { className: 'num', textContent: x.goal ? 'yes' : 'no' }), el('td', { className: 'num', textContent: x.cost }), el('td', { className: 'num', textContent: fmt(x.conflicts) }),
        el('td', { className: 'num', textContent: breakdown(x) }),
        ...methods.map((mth) => el('td', { className: 'num' }, el('span', { className: 'pbar' }, [el('i', { style: `width:${(100 * probs[mth][i]) / Math.max(...probs[mth])}%` }), pct(probs[mth][i])]))),
      ]))),
    ])),
    el('p', { className: 'note', textContent: `${SELECTION.roulette.formula}: with large_number inside every fitness the plain wheel is almost uniform. ${SELECTION.windowed.formula} removes the constant. ${SELECTION.rank.formula}. Tournament: the chance of being the best of three uniform picks.` }),
  ]);
  body.append(popCard);

  // 2. crossover (step 6.2b)
  const A = pop[0];
  const B = pop[1];
  const rng = agent.rng;
  const marksFor = (intended, built, headLen, tailStart = headLen) => built.genes.map((g, i) => (i < headLen ? 'head' : i < tailStart ? 'tail' : intended[i] === g ? 'tail2' : 'fixed'));
  let crossRows;
  let crossNote;
  if (p.crossover === 'double' && A.genes.length >= 2 && B.genes.length >= 2) {
    const two = (g) => { const i = Math.floor(rng() * g.length); const j = Math.floor(rng() * g.length); return i <= j ? [i, j + 1] : [j, i + 1]; };
    const [i, j] = two(A.genes);
    const [k, l] = two(B.genes);
    const intended1 = A.genes.slice(0, i).concat(B.genes.slice(k, l), A.genes.slice(j));
    const intended2 = B.genes.slice(0, k).concat(A.genes.slice(i, j), B.genes.slice(l));
    const c1 = agent.build(intended1, true);
    const c2 = agent.build(intended2, true);
    const mark = (parent, lo, hi) => parent.genes.map((g, x) => (x < lo ? 'head' : x < hi ? 'tail' : 'dim'));
    const childMarks = (intended, built, lo, len) => built.genes.map((g, x) => (x < lo ? 'head' : x < lo + len ? (intended[x] === g ? 'tail' : 'fixed') : intended[x] === g ? '' : 'fixed'));
    crossRows = [
      [`Parent A, cut at ${i} and ${j}`, seq(A.genes, mark(A, i, j))],
      [`Parent B, cut at ${k} and ${l}`, seq(B.genes, mark(B, k, l))],
      ['Child 1 = A with B’s middle', [seq(c1.genes, childMarks(intended1, c1, i, l - k)), el('span', { className: 'muted', textContent: ` cost ${c1.cost}, fitness ${fmt(c1.fitness)}${c1.goal ? ', reaches the goal' : ''}` })]],
      ['Child 2 = B with A’s middle', [seq(c2.genes, childMarks(intended2, c2, k, j - i)), el('span', { className: 'muted', textContent: ` cost ${c2.cost}, fitness ${fmt(c2.fitness)}${c2.goal ? ', reaches the goal' : ''}` })]],
    ];
    crossNote = 'Double-point crossover of the two fittest individuals above: the segments between two cut points are exchanged. The new middle and whatever follows it are replayed from the state the prefix ends in; actions that are illegal there are repaired (red).';
  } else {
    const cutA = 1 + Math.floor(rng() * Math.max(1, A.genes.length));
    const cutB = 1 + Math.floor(rng() * Math.max(1, B.genes.length));
    const intended1 = A.genes.slice(0, cutA).concat(B.genes.slice(cutB));
    const intended2 = B.genes.slice(0, cutB).concat(A.genes.slice(cutA));
    const c1 = agent.build(intended1, true);
    const c2 = agent.build(intended2, true);
    crossRows = [
      [`Parent A, cut after ${cutA}`, seq(A.genes, A.genes.map((g, x) => (x < cutA ? 'head' : 'dim')))],
      [`Parent B, cut after ${cutB}`, seq(B.genes, B.genes.map((g, x) => (x < cutB ? 'dim' : 'tail')))],
      ['Child 1 = prefix A + suffix B', [seq(c1.genes, marksFor(intended1, c1, cutA)), el('span', { className: 'muted', textContent: ` cost ${c1.cost}, fitness ${fmt(c1.fitness)}${c1.goal ? ', reaches the goal' : ''}` })]],
      ['Child 2 = prefix B + suffix A', [seq(c2.genes, marksFor(intended2, c2, cutB)), el('span', { className: 'muted', textContent: ` cost ${c2.cost}, fitness ${fmt(c2.fitness)}${c2.goal ? ', reaches the goal' : ''}` })]],
    ];
    crossNote = 'Single-point crossover of the two fittest individuals above, with independent cut points because the parents differ in length. The suffix is replayed from the state the prefix ends in; actions that are illegal there are replaced by random legal ones (repair, shown in red).';
  }
  const crossCard = el('article', { className: 'card prose' }, [
    el('h2', { textContent: `Step 6.2b: ${CROSSOVERS[p.crossover].name.toLowerCase()} crossover` }),
    el('p', { className: 'sub', textContent: crossNote }),
    el('dl', { className: 'ops' }, crossRows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', {}, v)])),
    el('p', { className: 'note', textContent: `A child can be shorter than the sum of its parts: the replay stops at the first goal state, and at the length bound (${problem.maxLength}).${p.illegal === 'retry' ? ' In the lethal mode an illegal child is not repaired but redrawn; the demonstration repairs so that the cut points can be shown.' : ''}` }),
  ]);
  body.append(crossCard);

  // 3. mutation (step 6.2a): one edit of each enabled kind on the same parent
  const mutCard = el('article', { className: 'card prose' }, [
    el('h2', { textContent: 'Step 6.2a: mutation' }),
    el('p', { className: 'sub', textContent: `One mutation of the fittest individual per enabled kind. The edit position is random; what follows it is replayed and ${p.illegal === 'repair' ? 'repaired where it no longer fits' : p.illegal === 'retry' ? 'the edit is redrawn while the child is illegal (lethal mutation)' : 'left as it is: an illegal child keeps fitness 0'}.` }),
  ]);
  const dl = el('dl', { className: 'ops' });
  dl.append(el('dt', { textContent: 'Parent' }), el('dd', {}, seq(A.genes)));
  for (const kind of p.mutations) {
    if (A.genes.length < 2 && (kind === 'swap' || kind === 'reverse')) continue;
    if (!A.genes.length && (kind === 'point' || kind === 'delete')) continue;
    const child = agent.mutate(A, kind);
    const marks = child.genes.map((g, i) => (i < A.genes.length && A.genes[i] === g ? '' : 'fixed'));
    dl.append(el('dt', { textContent: `${MUTATIONS[kind].name}${MUTATIONS[kind].brief ? '' : ' (ours)'}` }), el('dd', {}, [seq(child.genes, marks), el('span', { className: 'muted', textContent: ` cost ${child.cost}, fitness ${fmt(child.fitness)}${child.goal ? ', goal' : ''}${child.legal ? '' : ', illegal'}` })]));
  }
  mutCard.append(dl, el('p', { className: 'note', textContent: 'Positions that differ from the parent are shown in red (an edit, a shift, or a repair). Replace, swap and reverse are the three mutations of the brief; insert, delete and regrow are additions that change the length of the sequence.' }));
  body.append(mutCard);

  // 4. one generation step
  const stepCard = el('article', { className: 'card prose wide' }, [
    el('h2', { textContent: 'Step 7: one generation' }),
    el('p', { className: 'sub', textContent: `Elites kept: ${Math.min(p.elite, 9)}. The other ${10 - Math.min(p.elite, 9)} parents are drawn by ${SELECTION[p.selection].name.toLowerCase()} (sorted by fitness, repeats allowed), mated in random pairs with crossover probability ${p.crossoverRate}, and each child is mutated with probability ${p.mutationRate}.` }),
  ]);
  const parents = agent.select(pop, 10 - Math.min(p.elite, 9));
  stepCard.append(el('p', {}, [el('b', { textContent: 'Mating pool returned by Select (sorted by fitness, repeats allowed): ' }), ...parents.map((x) => el('span', { className: 'chip', textContent: `#${pop.indexOf(x) + 1}` }))]), el('p', { className: 'note', textContent: 'The pool is shuffled before the pairs (i, i+1) are mated, so that the fittest are not always crossed with each other; the rows of the table above show why a sorted pool paired in order would do that.' }));
  const btn = el('button', { className: 'btn', textContent: 'Draw another example' });
  btn.addEventListener('click', () => { demoSeed = (demoSeed * 7 + 3) % 10007; operatorsDirty = true; renderOperators(); });
  stepCard.append(btn);
  body.append(stepCard);
}

// ---------------------------------------------------------- evaluation tab

// deliverable 6 of the brief: the GA against A* and UCS on 100 random problems
async function renderRandom100(body) {
  let data;
  try { data = await (await fetch(`${DATA}a3-random100.json`)).json(); } catch (err) {
    body.append(el('div', { className: 'card', textContent: `The 100-problem evaluation (data/a3-random100.json) is not available: ${err.message}. Run "node scripts/evaluate-ga.mjs" to generate it.` }));
    return;
  }
  const sets = Object.entries(data.sets);
  body.append(el('h2', { className: 'section-title', textContent: 'The genetic algorithm against A* and UCS on 100 random problems' }));
  const first = sets[0][1];
  body.append(el('p', { className: 'sub', textContent: `For each grid size, ${int(first.meta.count)} distinct random initial states drawn with the assignment's probabilities (empty 0.5, full 0.3, half 0.2; seed ${first.meta.seed}). The optimum of every problem comes from A* with h₂ and from UCS, which agree. Each configuration changes one thing from the current defaults (population ${first.meta.defaults.population}, ${first.meta.defaults.generations} generations, length bound 4 per row, ${first.meta.defaults.selection === 'windowed' ? 'roulette on f − f_min' : first.meta.defaults.selection}, conflict number = closed gates with sand above, smallest along the sequence, w₁ = 9, w₂ = 1, repair). The four numbers the brief asks for are the first four columns; when the GA does not reach the goal, GA_Path_cost is the path cost of the fittest sequence it returned, which is why the all-problems mean of a failing configuration can fall below 1.` }));
  for (const [name, set] of sets) {
    const def = set.summary.default;
    const tiles = [
      ['Successes (goal reached)', `${int(def.successes)} / ${int(set.meta.count)}`, `${name} grid, default configuration`],
      ['Successes with the optimal path cost', def.optimalShareOfSuccesses === null ? '—' : pct(def.optimalShareOfSuccesses), `${int(def.optimal)} of ${int(def.successes)} successes (A* = UCS)`],
      ['Mean GA_Path_cost ÷ optimum, all problems', def.meanRatioAll.toFixed(3), 'failures counted with the fittest sequence'],
      ['Mean ratio, successes only', def.meanRatioSuccesses === null ? '—' : def.meanRatioSuccesses.toFixed(3), `worst ${def.worstRatio === null ? '—' : def.worstRatio.toFixed(2)}`],
      ['Median time per problem', `${fmt(def.medianTimeMs)} ms`, `A*: ${fmt(set.reference.astar.medianTimeMs)} ms · UCS: ${fmt(set.reference.ucs.medianTimeMs)} ms`],
      ['Mean optimal cost', fmt(set.reference.optimum.mean), `max ${set.reference.optimum.max}; optimal plans of ${fmt(set.reference.optimum.meanSteps)} actions on average, at most ${set.reference.optimum.maxSteps}`],
    ];
    const card = el('div', { className: 'card' }, [el('h2', { textContent: `${name}: ${int(set.meta.count)} random problems` })]);
    card.append(el('div', { className: 'stat-row' }, tiles.map(([k, v, s]) => el('div', { className: 'stat' }, [el('span', { textContent: k }), el('b', { textContent: v }), el('small', { textContent: s })]))));
    const head = ['Configuration', 'Successes', 'Optimal among successes', 'Mean ratio, all', 'Mean ratio, successes', 'Worst ratio', 'Mean evaluations', 'Mean generations', 'Median time (ms)'];
    const rows = Object.entries(set.summary).map(([key, s]) => el('tr', { className: key === 'default' ? 'hl' : '' }, [
      el('td', { textContent: s.label }),
      el('td', { className: 'num', textContent: `${int(s.successes)} / ${int(s.problems)}` }),
      el('td', { className: 'num', textContent: s.optimalShareOfSuccesses === null ? '—' : `${int(s.optimal)} (${pct(s.optimalShareOfSuccesses)})` }),
      el('td', { className: 'num', textContent: s.meanRatioAll.toFixed(3) }),
      el('td', { className: 'num', textContent: s.meanRatioSuccesses === null ? '—' : s.meanRatioSuccesses.toFixed(3) }),
      el('td', { className: 'num', textContent: s.worstRatio === null ? '—' : s.worstRatio.toFixed(2) }),
      el('td', { className: 'num', textContent: fmt(s.meanEvaluations) }),
      el('td', { className: 'num', textContent: fmt(s.meanGenerations) }),
      el('td', { className: 'num', textContent: fmt(s.medianTimeMs) }),
    ]));
    rows.push(el('tr', {}, [el('td', { textContent: `${set.reference.astar.label} (reference)` }), el('td', { className: 'num', textContent: `${int(set.meta.count)} / ${int(set.meta.count)}` }), el('td', { className: 'num', textContent: `${int(set.meta.count)} (100%)` }), el('td', { className: 'num', textContent: '1.000' }), el('td', { className: 'num', textContent: '1.000' }), el('td', { className: 'num', textContent: '1.00' }), el('td', { className: 'num', textContent: `${fmt(set.reference.astar.meanExpanded)} expanded` }), el('td', { className: 'num', textContent: '—' }), el('td', { className: 'num', textContent: fmt(set.reference.astar.medianTimeMs) })]));
    rows.push(el('tr', {}, [el('td', { textContent: `${set.reference.ucs.label} (reference)` }), el('td', { className: 'num', textContent: `${int(set.meta.count)} / ${int(set.meta.count)}` }), el('td', { className: 'num', textContent: `${int(set.meta.count)} (100%)` }), el('td', { className: 'num', textContent: '1.000' }), el('td', { className: 'num', textContent: '1.000' }), el('td', { className: 'num', textContent: '1.00' }), el('td', { className: 'num', textContent: `${fmt(set.reference.ucs.meanExpanded)} expanded` }), el('td', { className: 'num', textContent: '—' }), el('td', { className: 'num', textContent: fmt(set.reference.ucs.medianTimeMs) })]));
    card.append(el('div', { className: 'table-wrap' }, el('table', { className: 'data compact' }, [el('thead', {}, el('tr', {}, head.map((t, i) => el('th', { className: i ? 'num' : '', textContent: t })))), el('tbody', {}, rows)])));
    // the 100 problems, one row each, for the default configuration
    const details = el('details', {}, el('summary', { textContent: `The ${int(set.meta.count)} problems one by one (default configuration); click a row to open it on the Evolve tab` }));
    const phead = ['#', 'Initial state', 'Optimum', 'Optimal plan', 'GA cost', 'Ratio', 'GA plan', 'Side gates', 'First goal in generation', 'Generations', 'Evaluations', 'Time (ms)'];
    details.append(el('div', { className: 'table-wrap' }, el('table', { className: 'data compact' }, [
      el('thead', {}, el('tr', {}, phead.map((t, i) => el('th', { className: i >= 2 ? 'num' : '', textContent: t })))),
      el('tbody', {}, set.problems.map((pr, i) => {
        const r = pr.runs.default;
        const tr = el('tr', { className: 'pick' }, [
          el('td', { textContent: i + 1 }), el('td', {}, el('code', { textContent: pr.grid })), el('td', { className: 'num', textContent: pr.optimum }), el('td', { className: 'num', textContent: `${pr.optimalSteps} actions` }),
          el('td', { className: 'num' }, r.success ? [String(r.cost), ' ', badge(r.cost, pr.optimum)] : el('span', { className: 'badge bad', textContent: 'no goal path' })),
          el('td', { className: 'num', textContent: r.ratio === null ? '—' : r.ratio.toFixed(3) }), el('td', { className: 'num', textContent: r.success ? `${r.steps} actions` : '—' }), el('td', { className: 'num', textContent: r.success ? r.sides : '—' }),
          el('td', { className: 'num', textContent: r.firstGoal < 0 ? '—' : r.firstGoal }), el('td', { className: 'num', textContent: r.generations }), el('td', { className: 'num', textContent: int(r.evaluations) }), el('td', { className: 'num', textContent: fmtMs(r.timeMs) }),
        ]);
        tr.addEventListener('click', () => { showTab('evolve'); loadGrid(parseGrid(pr.grid)); });
        return tr;
      })),
    ])));
    card.append(details);
    body.append(card);
  }
}

let evalLoaded = false;
async function renderEval() {
  if (evalLoaded) return;
  evalLoaded = true;
  const body = $('evalBody');
  await renderRandom100(body);
  let data;
  try { data = await (await fetch(`${DATA}a3-5x2.json`)).json(); } catch (err) {
    body.append(el('div', { className: 'card', textContent: `The exhaustive dataset (data/a3-5x2.json) is not available: ${err.message}. Run "node scripts/analyze.mjs --only a3-5x2.json" to generate it.` }));
    return;
  }
  body.append(el('h2', { className: 'section-title', textContent: 'Every initial state of the 5×2 grid: the first version of the algorithm' }));
  body.append(el('p', { className: 'sub', textContent: 'This larger run was made with the first version of this project: the conflict number taken at the end state (not the smallest along the sequence), initial walks of random length, four mutation kinds (replace, insert, delete, regrow) and single-point crossover. It covers all 59,049 initial states and is kept because its comparison of selection methods, fitness forms and conflict functions is broadly consistent with the 100-problem results above; it has not been recomputed (about 45 minutes of all cores).' }));
  const { meta, optimal, algos } = data;
  const by = Object.fromEntries(algos.map((a) => [a.key, a]));
  const ga = by.ga;
  const m5 = new Sandbox({ rows: meta.rows });
  const gridText = (key) => formatGrid(m5.decode(key).cells, ' / ');
  const open = (key) => { showTab('evolve'); loadGrid(m5.decode(key).cells); };
  const solvable = meta.solvable - meta.trivial; // states with sand

  body.append(el('p', { className: 'sub', textContent: `All ${int(meta.count)} initial states of the ${meta.rows}×2 grid, ${algos.length} runs each, the same seed per state for every variant, on ${meta.workers} workers — ${meta.cpu}, ${meta.environment}. Optima from value iteration over the whole state graph. Times are medians: the machine slept during the run, which inflated a few individual timings and with them the means.` }));

  const tiles = [
    ['GA reaches the goal on', pct(ga.solved / meta.solvable), `${int(ga.solved)} of ${int(meta.solvable)} states`],
    ['GA plan is optimal on', pct(ga.optimal / meta.solvable), `mean ratio ${ga.ratio.mean.toFixed(3)}, worst ${ga.ratio.max.toFixed(2)}`],
    ['Greedy approach optimal on', pct(by.greedy.optimal / meta.solvable), `mean ratio ${by.greedy.ratio.mean.toFixed(3)}, worst ${by.greedy.ratio.max.toFixed(2)}`],
    ['Mean fitness evaluations', fmt(ga.expanded.mean), `median ${fmt(ga.expanded.median)}`],
    ['Median time, GA', `${fmt(ga.timeMs.median)} ms`, `A* with h₂: ${fmt(by['astar-gap'].timeMs.median)} ms per state`],
    ['Mean optimal cost', fmt(optimal.cost.mean), `max ${optimal.cost.max}, mean plan ${fmt(optimal.steps.mean)} actions`],
  ];
  body.append(el('div', { className: 'stat-row' }, tiles.map(([k, v, s]) => el('div', { className: 'stat' }, [el('span', { textContent: k }), el('b', { textContent: v }), el('small', { textContent: s })]))));

  const card = (title, sub, wide = false) => { const chart = el('div'); const foot = el('p', { className: 'chart-foot' }); const c = el('div', { className: `card chart-card${wide ? ' wide' : ''}` }, [el('div', { className: 'chart-head' }, el('div', {}, [el('h2', { textContent: title }), el('p', { className: 'sub', textContent: sub })])), chart, foot]); return { c, chart, foot }; };
  const grid = el('div', { className: 'chart-grid' });
  body.append(grid);

  const gas = algos.filter((a) => a.algo === 'ga');
  const quality = card('Plan quality per variant: mean GA cost ÷ optimum', 'Over the states where the variant reached the goal; 1 is optimal. Linear axis.', true);
  grid.append(quality.c);
  dotPlot(quality.chart, { linear: true, min: 1, rows: gas.filter((a) => a.solved > 0).map((a) => ({ label: a.label, value: a.ratio.mean, tip: `${a.label}<br>mean ratio <b>${a.ratio.mean.toFixed(3)}</b> · median <b>${a.ratio.median.toFixed(3)}</b> · worst <b>${a.ratio.max.toFixed(2)}</b><br>goal reached on ${pct(a.solved / meta.solvable)}, optimal on ${pct(a.optimal / meta.solvable)}` })), xTitle: 'mean cost ÷ optimum' });
  quality.foot.textContent = `Variants that never reach the goal (${gas.filter((a) => a.solved === 0).map((a) => a.label).join(', ') || 'none'}) are left out.`;

  const table = card('Every variant', 'One run per state. “Expanded” counts fitness evaluations for the genetic algorithm.', true);
  grid.append(table.c);
  const head = ['Run', 'Goal reached', 'Optimal on', 'Mean cost ÷ opt', 'Median', 'Worst', 'Mean evaluations', 'Mean actions applied', 'Median time (ms)'];
  table.chart.append(el('div', { className: 'table-wrap' }, el('table', { className: 'data compact' }, [
    el('thead', {}, el('tr', {}, head.map((t, i) => el('th', { className: i ? 'num' : '', textContent: t })))),
    el('tbody', {}, algos.map((a) => el('tr', {}, [
      el('td', { textContent: a.label }),
      el('td', { className: 'num', textContent: a.solved === meta.solvable ? '100%' : `${pct(a.solved / meta.solvable)} (${int(a.solved)})` }),
      el('td', { className: 'num', textContent: pct(a.optimal / meta.solvable) }),
      el('td', { className: 'num', textContent: a.solved ? a.ratio.mean.toFixed(3) : '—' }),
      el('td', { className: 'num', textContent: a.solved ? a.ratio.median.toFixed(3) : '—' }),
      el('td', { className: 'num', textContent: a.solved ? a.ratio.max.toFixed(2) : '—' }),
      el('td', { className: 'num', textContent: fmt(a.expanded.mean) }),
      el('td', { className: 'num', textContent: fmt(a.generated.mean) }),
      el('td', { className: 'num', textContent: fmt(a.timeMs.median) }),
    ]))),
  ])));

  const hist = card('GA_opt_ratio = cost of the genetic algorithm ÷ optimum cost', 'Default variant, all states with sand where a goal path was found.');
  grid.append(hist.c);
  const bars = [{ label: '1', value: ga.ratio.exact, accent: true, tip: `Ratio exactly 1: <b>${int(ga.ratio.exact)}</b> states` }];
  ga.ratio.bins.forEach((count, i) => { const hi = 1 + (i + 1) * ga.ratio.binWidth; const v = i === 0 ? count - ga.ratio.exact : count; bars.push({ label: hi.toFixed(2), value: v, tip: `Ratio ${i === 0 ? 'above 1.00' : `from ${(hi - ga.ratio.binWidth).toFixed(2)}`} to below ${hi.toFixed(2)}: <b>${int(v)}</b> states` }); });
  columns(hist.chart, { bars, xTitle: 'cost ratio (bar label = upper edge of the bin; first bar = exactly 1)', yTitle: 'states' });
  hist.foot.textContent = `Mean ${ga.ratio.mean.toFixed(3)}, median ${ga.ratio.median.toFixed(3)}, 95th percentile ${ga.ratio.p95.toFixed(2)}, maximum ${ga.ratio.max.toFixed(2)}. For comparison the greedy approach: mean ${by.greedy.ratio.mean.toFixed(3)}, maximum ${by.greedy.ratio.max.toFixed(2)}.`;

  const ghist = card('Greedy_opt_ratio, for reference', 'The greedy approach of the assignment on the same states.');
  grid.append(ghist.c);
  const gbars = [{ label: '1', value: by.greedy.ratio.exact, accent: true, tip: `Ratio exactly 1: <b>${int(by.greedy.ratio.exact)}</b> states` }];
  by.greedy.ratio.bins.forEach((count, i) => { const hi = 1 + (i + 1) * by.greedy.ratio.binWidth; const v = i === 0 ? count - by.greedy.ratio.exact : count; gbars.push({ label: hi.toFixed(2), value: v, tip: `Ratio ${i === 0 ? 'above 1.00' : `from ${(hi - by.greedy.ratio.binWidth).toFixed(2)}`} to below ${hi.toFixed(2)}: <b>${int(v)}</b> states` }); });
  columns(ghist.chart, { bars: gbars, xTitle: 'cost ratio (bar label = upper edge of the bin; first bar = exactly 1)', yTitle: 'states' });

  const sc1 = card('Cost of the genetic algorithm against the optimum', 'Circle area = number of states; click one to open an example on the Evolve tab.');
  grid.append(sc1.c);
  bubbles(sc1.chart, { points: ga.costVsOpt, xTitle: 'cost of the GA plan', yTitle: 'optimum cost', diagonal: true, diagonalLabel: 'cost = optimum', tip: (p) => `GA <b>${p[0]}</b> · optimum <b>${p[1]}</b><br><b>${int(p[2])}</b> state${p[2] === 1 ? '' : 's'} · e.g. ${gridText(p[3])}`, onPick: (p) => open(p[3]) });

  const sc2 = card('Actions to the goal against side-gate actions, GA plans', 'x = number of actions in the GA plan, y = how many are of type b.');
  grid.append(sc2.c);
  bubbles(sc2.chart, { points: ga.actions, xTitle: 'number of actions to the goal state', yTitle: 'actions of type b', integerAxes: true, tip: (p) => `<b>${p[0]}</b> actions, <b>${p[1]}</b> side gate${p[1] === 1 ? '' : 's'}<br><b>${int(p[2])}</b> state${p[2] === 1 ? '' : 's'} · e.g. ${gridText(p[3])}`, onPick: (p) => open(p[3]) });

  const sc3 = card('The same for the optimal plans', 'From value iteration; among equally cheap plans the shortest, then the one with the fewest side gates.');
  grid.append(sc3.c);
  bubbles(sc3.chart, { points: optimal.actions, xTitle: 'number of actions to the goal state', yTitle: 'actions of type b', integerAxes: true, tip: (p) => `<b>${p[0]}</b> actions, <b>${p[1]}</b> side gate${p[1] === 1 ? '' : 's'}<br><b>${int(p[2])}</b> state${p[2] === 1 ? '' : 's'} · e.g. ${gridText(p[3])}`, onPick: (p) => open(p[3]) });

  if (ga.byDepth && ga.byDepth.length && ga.byDepth[0].attempts !== undefined) {
    const depth = card('Success and optimality against the length of the optimal plan', 'Share of states where the default variant reaches the goal and where its plan is optimal, by the number of actions of the optimal plan.', true);
    grid.append(depth.c);
    const shown = [by.ga, by['ga-fall'], by['ga-sweep'], by['ga-large']].filter(Boolean);
    const colors = { ga: 3, 'ga-fall': 1, 'ga-sweep': 7, 'ga-large': 2 };
    const shortLabel = { ga: 'default', 'ga-fall': 'conflicts = h₃', 'ga-sweep': 'greedy cost', 'ga-large': 'population 200' };
    lines(depth.chart, { linear: true, yMin: 0, series: shown.map((a) => (
      { label: shortLabel[a.key] || a.label, color: `var(--series-${colors[a.key]})`, points: a.byDepth.filter((d) => d.depth > 0 && d.attempts > 0).map((d) => [d.depth, Math.round((100 * d.optimal) / d.attempts)]) }
    )), xTitle: 'actions in the optimal plan', yTitle: 'percent of states with an optimal GA plan', tipTitle: (x) => `Optimal plan of <b>${x}</b> actions` });
    const goalShare = (a) => a.byDepth.reduce((acc, d) => acc + (d.attempts ? d.n : 0), 0) / Math.max(1, a.byDepth.reduce((acc, d) => acc + d.attempts, 0));
    depth.foot.textContent = `Longer optimal plans leave more room for a valid but costlier sequence. Goal reached: ${shown.map((a) => `${a.label} ${pct(goalShare(a))}`).join(', ')}.`;
  }
}

// --------------------------------------------------------------------- tabs

const TABS = ['evolve', 'operators', 'eval', 'design'];
function showTab(name) {
  if (!TABS.includes(name)) name = 'evolve';
  for (const t of TABS) { $(`tab-${t}`).hidden = t !== name; $(`tabbtn-${t}`).setAttribute('aria-selected', String(t === name)); }
  if (name === 'operators') renderOperators();
  if (name === 'eval') renderEval();
  if (name === 'evolve') { board.layout(); board.draw(); }
  history.replaceState(null, '', name === 'evolve' ? location.pathname + location.search : `#${name}`);
}

// --------------------------------------------------------------------- init

function init() {
  for (const [id, m] of Object.entries(SELECTION)) $('pSelection').append(el('option', { value: id, textContent: `${m.name} — ${m.formula}` }));
  $('pSelection').value = DEFAULTS.selection;
  for (const [id, f] of Object.entries(FITNESS)) $('pFitness').append(el('option', { value: id, textContent: f.name }));
  $('pFitness').value = DEFAULTS.fitness;
  for (const [id, c] of Object.entries(CONFLICTS)) $('pConflicts').append(el('option', { value: id, textContent: c.name }));
  $('pConflicts').value = DEFAULTS.conflicts;
  for (const [id, m] of Object.entries(CONFLICT_MODES)) $('pConflictMode').append(el('option', { value: id, textContent: m.name }));
  $('pConflictMode').value = DEFAULTS.conflictMode;
  for (const sel of ['pConflictTransform', 'pCostTransform']) for (const [id, t] of Object.entries(TRANSFORMS)) $(sel).append(el('option', { value: id, textContent: t.name }));
  $('pConflictTransform').value = DEFAULTS.conflictTransform;
  $('pCostTransform').value = DEFAULTS.costTransform;
  for (const [id, c] of Object.entries(CROSSOVERS)) $('pCrossoverType').append(el('option', { value: id, textContent: c.name }));
  $('pCrossoverType').value = DEFAULTS.crossover;
  for (const [id, c] of Object.entries(ILLEGAL)) $('pIllegal').append(el('option', { value: id, textContent: c.name }));
  $('pIllegal').value = DEFAULTS.illegal;
  for (const [id, mu] of Object.entries(MUTATIONS)) {
    const box = el('input', { type: 'checkbox', value: id, checked: true });
    $('pMutations').append(el('label', { title: mu.note }, [box, `${mu.name}${mu.brief ? '' : ' *'}`]));
  }
  const hints = () => {
    $('selectionHint').textContent = SELECTION[$('pSelection').value].formula;
    $('fitnessHint').textContent = FITNESS[$('pFitness').value].note;
    $('conflictsHint').textContent = CONFLICTS[$('pConflicts').value].note;
    $('illegalHint').textContent = ILLEGAL[$('pIllegal').value].note;
  };
  hints();
  $('pSelection').addEventListener('change', hints);
  $('pFitness').addEventListener('change', hints);
  $('pConflicts').addEventListener('change', () => { $('pWeight').value = CONFLICTS[$('pConflicts').value].weight; hints(); });
  $('params').addEventListener('change', () => { operatorsDirty = true; });
  $('pIllegal').addEventListener('change', hints);
  for (const id of ['pSelection', 'pFitness', 'pConflicts', 'pWeight', 'pCostWeight', 'pConflictTransform', 'pCostTransform', 'pConflictMode', 'pIllegal', 'pCrossoverType', 'pMutations']) $(id).addEventListener('change', () => { operatorsDirty = true; });
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
  $('btnEvolve').addEventListener('click', evolve);
  $('btnCompare').addEventListener('click', compare);
  $('plPlay').addEventListener('click', play);
  $('plFirst').addEventListener('click', () => { board.cancel(); jump(0); });
  $('plPrev').addEventListener('click', () => { board.cancel(); jump(S.cursor - 1); });
  $('plLast').addEventListener('click', () => { board.cancel(); jump(S.steps.length); });
  $('plNext').addEventListener('click', async () => { if (!S.playing && !board.busy) await forward(); });
  $('speed').addEventListener('change', () => { S.speed = Number($('speed').value); });
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || $('tab-evolve').hidden) return;
    if (e.target.closest('input, select, textarea, button, [role="tab"], summary, a')) return;
    const keys = { ' ': 'plPlay', ArrowRight: 'plNext', ArrowLeft: 'plPrev', Home: 'plFirst', End: 'plLast' };
    const id = keys[e.key];
    if (!id || $(id).disabled) return;
    e.preventDefault();
    $(id).click();
  });
  for (const t of TABS) $(`tabbtn-${t}`).addEventListener('click', () => showTab(t));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'evolve'));
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
  showTab(location.hash.slice(1) || 'evolve');
}

init();
