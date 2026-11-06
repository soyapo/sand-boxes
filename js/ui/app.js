// Page controller: simulator, solver panel, tabs.

import {
  Sandbox, parseGrid, formatGrid, PROBS_SAND, PROBS_WATER, CHAIN_MODES, CELL_NAMES,
  EMPTY, SAND_HALF, SAND_FULL, WATER_HALF, WATER_FULL, CONCRETE, MAT, SAND,
} from '../core/model.js';
import { ALGORITHMS } from '../core/search.js';
import { HEURISTICS } from '../core/heuristics.js';
import { Board } from './board.js';
import { initAnalysis } from './analysis-ui.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
};
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtMs = (ms) => (ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : fmtInt(ms));
const fmtUnits = (half) => (half === 0 ? '0' : `${half >> 1 || ''}${half & 1 ? '½' : ''}`);

const CHAIN_HINTS = {
  press: 'A door above opens only when it is pressed from both sides: sand on top of it and a full box under it. All opened doors act at the same moment.',
  always: 'Every non-empty box of the unbroken pile above follows, whether the boxes under it are full or not.',
  none: 'Only the two boxes joined by the opened gate ever change.',
};

const PRESETS = [
  { name: 'Assignment example (4×2)', grid: '1 0/0 1/0 1/1 0' },
  { name: 'Assignment example, empty top row (5×2)', grid: '0 0/1 0/0 1/0 1/1 0' },
  { name: 'Full tower (5×2)', grid: '1 1/1 1/1 1/1 1/1 1' },
  { name: 'Zigzag (5×2)', grid: '1 0/0 1/1 0/0 1/1 0' },
  { name: 'Halves and gaps (5×2)', grid: '½ 1/0 ½/1 0/½ ½/0 1' },
  { name: 'Water: trapped sand (3×2)', grid: '0 W/½ 0/# 0' },
  { name: 'Water: mixed (5×2)', grid: 'W 1/1 ½/0 w/½ 0/1 0' },
];

const S = {
  rows: 5,
  water: false,
  chain: 'press',
  penalty: 10,
  brush: SAND_FULL,
  start: null,
  steps: [],
  cursor: 0,
  playing: false,
  speed: 1,
  source: 'manual',
  probs: { sand: { ...PROBS_SAND }, water: { ...PROBS_WATER } },
  searching: false,
};
let model;
let generation = 0;

const board = new Board($('board'), $('boardWrap'), $('boardTip'), {
  onGate: (id) => manualAction(id),
  onCell: (i) => paint(i),
  onHover: (id) => {
    for (const b of $('actions').querySelectorAll('.act')) b.classList.toggle('hot', Number(b.dataset.id) === id);
  },
});

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
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'worker failed'));
      pending.clear();
    };
  }
  return worker;
}

function rpc(type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, ...payload });
  });
}

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

const current = () => (S.cursor ? S.steps[S.cursor - 1].cells : S.start);
const modelCfg = () => ({ rows: S.rows, chain: S.chain, concretePenalty: S.penalty });

function rebuildModel() {
  model = new Sandbox(modelCfg());
  board.setModel(model);
}

/** Replace the initial grid (and forget any timeline). */
function setStart(cells) {
  cancelSearch();
  generation++;
  S.start = cells;
  S.steps = [];
  S.cursor = 0;
  S.playing = false;
  S.source = 'manual';
  $('solveResult').hidden = true;
  $('compareCard').hidden = true;
  $('gridError').hidden = true;
  refresh();
}

/** Load a grid of any size, switching rows and variant as needed. */
function loadGrid(cells, variant = 'auto') {
  const needsWater = cells.some((c) => c >= WATER_HALF);
  S.rows = cells.length / 2;
  S.water = variant === 'auto' ? needsWater : variant === 'water' || needsWater;
  syncSetupControls();
  rebuildModel();
  setStart(cells);
}

function availableFor(cells) {
  const map = new Map();
  for (const a of model.actions) {
    const r = model.apply(cells, a.id);
    if (r) map.set(a.id, r.cost);
  }
  return map;
}

function refresh() {
  const cells = current();
  const avail = availableFor(cells);
  board.show(cells);
  board.setAvailable(avail);

  const cost = S.steps.slice(0, S.cursor).reduce((s, x) => s + x.cost, 0);
  $('statCost').textContent = cost;
  $('statSteps').textContent = S.cursor;
  $('statSand').textContent = fmtUnits(model.sand(cells));
  $('tileConcrete').hidden = !S.water;
  $('statConcrete').textContent = cells.reduce((n, c) => n + (c === CONCRETE ? 1 : 0), 0);

  const status = $('status');
  status.className = 'status';
  if (model.isGoal(cells)) {
    status.textContent = S.cursor ? `Goal reached — no sand left. Total cost ${cost}.` : 'No sand in the grid: this is already a goal state.';
    status.classList.add('good');
  } else if (avail.size === 0) {
    status.textContent = 'Stuck — no gate can move anything from here.';
    status.classList.add('bad');
  } else {
    status.textContent = '';
  }

  const actions = $('actions');
  actions.replaceChildren();
  if (avail.size === 0) actions.append(el('span', { className: 'hint', textContent: 'No gate can move anything.' }));
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
  if (document.activeElement !== $('gridText')) $('gridText').value = formatGrid(S.start, ' / ');
}

function renderTimeline() {
  const list = $('timeline');
  list.replaceChildren();
  $('timelineHint').textContent = S.steps.length ? `— ${S.source}` : '';
  if (!S.steps.length) {
    list.append(el('li', { className: 'empty', textContent: 'Open gates on the board, or press Solve to let an algorithm find a plan.' }));
    return;
  }
  let total = 0;
  S.steps.forEach((step, k) => {
    total += step.cost;
    const a = model.actions[step.a];
    const li = el('li', { className: k + 1 === S.cursor ? 'current' : k < S.cursor ? 'done' : '' }, [
      el('span', { className: 'n', textContent: k + 1 }),
      el('span', {}, [el('span', { className: 'kind', textContent: a.type, title: a.type === 'a' ? 'Top-down gate' : 'Side gate' }), a.label + (step.concrete ? ' · concrete' : '')]),
      el('span', { className: 'c', textContent: `+${step.cost}` }),
      el('span', { className: 't', textContent: total }),
    ]);
    li.addEventListener('click', () => jump(k + 1));
    list.append(li);
    if (k + 1 === S.cursor) {
      // keep the current step visible inside the list without scrolling the page itself
      queueMicrotask(() => {
        const top = li.offsetTop - list.offsetTop;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (top + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + li.offsetHeight - list.clientHeight;
      });
    }
  });
}

// ------------------------------------------------------------------ playing

function makeStep(before, id) {
  const events = [];
  const r = model.apply(before, id, events);
  return r ? { a: id, cost: r.cost, cells: r.cells, events, before, concrete: r.concrete } : null;
}

async function manualAction(id) {
  if (S.playing) return;
  cancelSearch();
  const step = makeStep(current(), id);
  if (!step) return;
  if (S.cursor < S.steps.length || S.source !== 'manual') {
    S.steps = S.steps.slice(0, S.cursor);
    S.source = S.source === 'manual' ? 'manual' : `${S.source}, then manual`;
  }
  S.steps.push(step);
  await forward();
}

/** Apply the next step of the timeline with animation. */
async function forward() {
  if (S.cursor >= S.steps.length) return false;
  const step = S.steps[S.cursor];
  const mine = generation;
  board.setAvailable(new Map());
  const ok = await board.animate(step.before, step.events, S.speed);
  if (mine !== generation) return false;
  if (!ok) return false;
  S.cursor++;
  refresh();
  return true;
}

function jump(k) {
  S.playing = false;
  S.cursor = Math.max(0, Math.min(S.steps.length, k));
  refresh();
}

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
  let cells = S.start;
  for (const id of path) {
    const step = makeStep(cells, id);
    if (!step) break;
    S.steps.push(step);
    cells = step.cells;
  }
  refresh();
}

// ------------------------------------------------------------------ editing

function paint(i) {
  if (S.playing) return;
  const cells = S.start.slice();
  if (cells[i] === S.brush && S.cursor === 0 && !S.steps.length) return;
  cells[i] = S.brush;
  setStart(cells);
}

function randomGrid() {
  setStart(model.random(S.water ? S.probs.water : S.probs.sand));
}

function setRows(rows) {
  rows = Math.max(1, Math.min(8, rows));
  if (rows === S.rows) return;
  const cells = new Uint8Array(rows * 2);
  cells.set(S.start.subarray(0, Math.min(S.start.length, cells.length)));
  S.rows = rows;
  syncSetupControls();
  rebuildModel();
  setStart(cells);
}

function setVariant(water) {
  if (water === S.water) return;
  S.water = water;
  if (!water && S.brush >= WATER_HALF) S.brush = SAND_FULL;
  syncSetupControls();
  setStart(water ? S.start.slice() : S.start.map((c) => (c >= WATER_HALF ? EMPTY : c)));
}

// ---------------------------------------------------------- setup controls

function swatch(code) {
  const s = el('span', { className: 'swatch' });
  if (code === CONCRETE) s.append(el('i', { className: 'concrete', style: 'height:100%' }));
  else if (code !== EMPTY) s.append(el('i', { className: MAT[code] === SAND ? 'sand' : 'water', style: `height:${code === SAND_HALF || code === WATER_HALF ? 50 : 100}%` }));
  return s;
}

function syncSetupControls() {
  $('rowsOut').textContent = S.rows;
  const states = (S.water ? 6 : 3) ** (S.rows * 2);
  $('spaceHint').textContent = `${S.rows}×2 · ${states < 1e7 ? fmtInt(states) : states.toExponential(1)} states`;
  for (const b of $('variant').children) b.classList.toggle('on', (b.dataset.v === 'water') === S.water);
  $('penaltyField').hidden = !S.water;

  const brushes = $('brushes');
  brushes.replaceChildren();
  const codes = S.water ? [EMPTY, SAND_HALF, SAND_FULL, WATER_HALF, WATER_FULL, CONCRETE] : [EMPTY, SAND_HALF, SAND_FULL];
  for (const code of codes) {
    const b = el('button', { className: `brush${code === S.brush ? ' on' : ''}`, title: `Paint: ${CELL_NAMES[code]}` }, [swatch(code), CELL_NAMES[code]]);
    b.setAttribute('aria-pressed', String(code === S.brush));
    b.addEventListener('click', () => { S.brush = code; syncSetupControls(); });
    brushes.append(b);
  }

  const probs = $('probs');
  probs.replaceChildren();
  const set = S.water ? S.probs.water : S.probs.sand;
  const rowsDef = [['empty', 'Empty'], ['sandHalf', 'Half sand'], ['sandFull', 'Full sand']].concat(S.water ? [['waterHalf', 'Half water'], ['waterFull', 'Full water']] : []);
  for (const [key, label] of rowsDef) {
    const input = el('input', { type: 'number', min: 0, max: 1, step: 0.05, value: set[key] });
    input.setAttribute('aria-label', `Probability: ${label}`);
    input.addEventListener('change', () => { set[key] = Math.max(0, Number(input.value) || 0); });
    probs.append(el('span', { textContent: label }), input);
  }
}

function syncHeuristic(defaultForAlgo = false) {
  const algo = ALGORITHMS[$('algo').value];
  $('algoHint').textContent = `${algo.long}. ${algo.note}`;
  $('heur').disabled = !algo.informed;
  if (defaultForAlgo && algo.informed) $('heur').value = $('algo').value === 'greedy' ? 'fall' : 'gap';
  $('heurHint').textContent = algo.informed ? HEURISTICS[$('heur').value].note : 'Not used by this algorithm.';
}

// ------------------------------------------------------------------ solving

function setBusy(on, label = 'Searching…') {
  $('btnSolve').disabled = $('btnCompare').disabled = on;
  $('btnSolve').textContent = on ? label : 'Solve';
}

function optimalityBadge(cost, optimum, unsolvable) {
  if (unsolvable) return el('span', { className: 'badge bad', textContent: 'unsolvable' });
  if (optimum === null) return el('span', { className: 'badge warn', textContent: 'optimum unknown (search limit)' });
  if (cost === optimum) return el('span', { className: 'badge good', textContent: 'optimal' });
  return el('span', { className: 'badge warn', textContent: `+${(((cost - optimum) / optimum) * 100).toFixed(0)}% vs optimum ${optimum}` });
}

function showResult(label, r, optimum, unsolvable) {
  const box = $('solveResult');
  box.hidden = false;
  box.replaceChildren();
  if (r.found) {
    box.append(
      el('div', { className: 'big' }, [`Cost ${r.cost} `, el('small', { textContent: `in ${r.steps} action${r.steps === 1 ? '' : 's'} · ${r.sides} side gate${r.sides === 1 ? '' : 's'}` })]),
      el('div', {}, [`${label} `, optimalityBadge(r.cost, optimum, false)]),
    );
  } else {
    box.append(
      el('div', { className: 'big', textContent: r.aborted ? 'Stopped' : 'No solution' }),
      el('div', {}, [`${label} `, r.aborted ? el('span', { className: 'badge warn', textContent: 'search limit reached' }) : optimalityBadge(null, optimum, true)]),
    );
    if (!r.aborted) box.append(el('p', { className: 'note', textContent: 'Some sand is trapped: no sequence of gates removes it or turns it into concrete.' }));
  }
  const dl = el('dl');
  const rows = [['States expanded', fmtInt(r.expanded)], ['States generated', fmtInt(r.generated)], ['Peak memory (states)', fmtInt(r.maxMemory)], ['Time', `${fmtMs(r.timeMs)} ms`]];
  if (r.iterations > 1) rows.push(['Iterations', fmtInt(r.iterations)]);
  for (const [k, v] of rows) dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
  box.append(dl);
}

async function solve(autoplay = true) {
  if (S.searching) return;
  const algo = $('algo').value;
  const heuristic = $('heur').value;
  const label = ALGORITHMS[algo].informed ? `${ALGORITHMS[algo].name} with ${HEURISTICS[heuristic].name.toLowerCase()}` : ALGORITHMS[algo].name;
  const mine = ++generation;
  board.cancel();
  S.playing = false;
  S.searching = true;
  setBusy(true);
  try {
    const res = await rpc('solve', { cfg: modelCfg(), cells: Array.from(S.start), algo, heuristic });
    if (mine !== generation) return;
    showResult(label, res.result, res.optimum, res.unsolvable);
    loadPath(res.result.path, label);
    S.searching = false;
    setBusy(false);
    if (autoplay && res.result.found && res.result.path.length) play();
  } catch (err) {
    if (err.message !== 'cancelled') {
      $('solveResult').hidden = false;
      $('solveResult').textContent = `Search failed: ${err.message}`;
    }
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
    const { results } = await rpc('compare', { cfg: modelCfg(), cells: Array.from(S.start) });
    if (mine !== generation) return;
    const exact = results.filter((r) => r.found && ALGORITHMS[r.algo].optimal).map((r) => r.cost);
    const optimum = exact.length ? Math.min(...exact) : null;
    const table = $('compareTable');
    table.replaceChildren(el('thead', {}, el('tr', {}, [
      el('th', { textContent: 'Algorithm' }), el('th', { textContent: 'Heuristic' }), el('th', { className: 'num', textContent: 'Cost' }), el('th', { textContent: '' }),
      el('th', { className: 'num', textContent: 'Actions' }), el('th', { className: 'num', textContent: 'Side gates' }), el('th', { className: 'num', textContent: 'Expanded' }),
      el('th', { className: 'num', textContent: 'Generated' }), el('th', { className: 'num', textContent: 'Peak memory' }), el('th', { className: 'num', textContent: 'Time (ms)' }),
    ])));
    const body = el('tbody');
    for (const r of results) {
      const tr = el('tr', { className: r.found ? 'pick' : '' }, [
        el('td', { textContent: r.label }),
        el('td', { textContent: r.heuristic ? HEURISTICS[r.heuristic].name : '—' }),
        el('td', { className: 'num', textContent: r.found ? r.cost : '—' }),
        el('td', {}, r.found ? optimalityBadge(r.cost, optimum, false) : el('span', { className: `badge ${r.aborted ? 'warn' : 'bad'}`, textContent: r.aborted ? 'limit reached' : 'no solution' })),
        el('td', { className: 'num', textContent: r.found ? r.steps : '—' }),
        el('td', { className: 'num', textContent: r.found ? r.sides : '—' }),
        el('td', { className: 'num', textContent: fmtInt(r.expanded) }),
        el('td', { className: 'num', textContent: fmtInt(r.generated) }),
        el('td', { className: 'num', textContent: fmtInt(r.maxMemory) }),
        el('td', { className: 'num', textContent: fmtMs(r.timeMs) }),
      ]);
      if (r.found) {
        tr.tabIndex = 0;
        const pick = () => {
          showResult(r.label, r, optimum, false);
          loadPath(r.path, r.label);
          $('boardWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
          play();
        };
        tr.addEventListener('click', pick);
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
      }
      body.append(tr);
    }
    table.append(body);
    $('compareCard').hidden = false;
    $('compareCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    if (err.message !== 'cancelled') {
      $('compareCard').hidden = false;
      $('compareTable').replaceChildren(el('caption', { textContent: `Comparison failed: ${err.message}` }));
    }
  } finally {
    if (mine === generation) { S.searching = false; setBusy(false); }
  }
}

// --------------------------------------------------------------------- tabs

const TABS = ['sim', 'analysis', 'rules'];
let analysisReady = false;

function showTab(name) {
  if (!TABS.includes(name)) name = 'sim';
  for (const t of TABS) {
    $(`tab-${t}`).hidden = t !== name;
    $(`tabbtn-${t}`).setAttribute('aria-selected', String(t === name));
  }
  if (name === 'analysis' && !analysisReady) {
    analysisReady = true;
    initAnalysis({ openInSimulator });
  }
  if (name === 'sim') { board.layout(); board.draw(); }
  history.replaceState(null, '', name === 'sim' ? location.pathname + location.search : `#${name}`);
}

/** "S2 L1 R4" -> action ids: side gate of row 2, gate under row 1 left, gate under row 4 right. */
function parsePlan(text) {
  return text.trim().split(/\s+/).map((tok) => {
    const row = Number(tok.slice(1)) - 1;
    return tok[0] === 'S' ? model.sideAction(row) : model.verticalAction(tok[0] === 'L' ? 0 : 1, row);
  });
}

/** Used by the analysis charts and the rules page: show a grid, then solve it or replay a given plan. */
function openInSimulator({ cells, algo = 'astar', heuristic, plan }) {
  showTab('sim');
  loadGrid(cells);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (plan) {
    loadPath(parsePlan(plan), 'hand-worked plan');
    play();
    return;
  }
  $('algo').value = algo;
  syncHeuristic(true);
  if (heuristic) { $('heur').value = heuristic; syncHeuristic(); }
  solve();
}

// --------------------------------------------------------------------- init

function init() {
  for (const [id, a] of Object.entries(ALGORITHMS)) $('algo').append(el('option', { value: id, textContent: `${a.name} — ${a.long}` }));
  for (const [id, h] of Object.entries(HEURISTICS)) $('heur').append(el('option', { value: id, textContent: `${h.short} · ${h.name}${h.admissible ? '' : ' (not admissible)'}` }));
  $('algo').value = 'astar';
  syncHeuristic(true);
  $('algo').addEventListener('change', () => syncHeuristic(true));
  $('heur').addEventListener('change', () => syncHeuristic());

  for (const [id, label] of Object.entries(CHAIN_MODES)) $('chain').append(el('option', { value: id, textContent: label }));
  $('chainHint').textContent = CHAIN_HINTS[S.chain];
  $('chain').addEventListener('change', () => {
    S.chain = $('chain').value;
    $('chainHint').textContent = CHAIN_HINTS[S.chain];
    rebuildModel();
    setStart(S.start);
  });
  $('penalty').addEventListener('change', () => {
    S.penalty = Math.max(0, Number($('penalty').value) || 0);
    rebuildModel();
    setStart(S.start);
  });

  $('preset').append(el('option', { value: '', textContent: 'Choose an example…' }));
  PRESETS.forEach((p, i) => $('preset').append(el('option', { value: i, textContent: p.name })));
  $('preset').addEventListener('change', () => {
    const p = PRESETS[$('preset').value];
    if (p) loadGrid(parseGrid(p.grid));
    $('preset').value = '';
  });

  for (const b of $('variant').children) b.addEventListener('click', () => setVariant(b.dataset.v === 'water'));
  $('rowsMinus').addEventListener('click', () => setRows(S.rows - 1));
  $('rowsPlus').addEventListener('click', () => setRows(S.rows + 1));
  $('btnRandom').addEventListener('click', randomGrid);
  $('btnClear').addEventListener('click', () => setStart(model.empty()));

  const loadText = () => {
    try {
      const cells = parseGrid($('gridText').value);
      if (cells.length < 2 || cells.length > 16) throw new RangeError('use between 1 and 8 rows');
      $('gridText').blur();
      loadGrid(cells, S.water ? 'water' : 'auto');
    } catch (err) {
      $('gridError').textContent = err.message;
      $('gridError').hidden = false;
    }
  };
  $('btnLoadText').addEventListener('click', loadText);
  $('gridText').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadText(); });

  $('btnSolve').addEventListener('click', () => solve());
  $('btnCompare').addEventListener('click', compare);
  $('plPlay').addEventListener('click', play);
  $('plFirst').addEventListener('click', () => { board.cancel(); jump(0); });
  $('plPrev').addEventListener('click', () => { board.cancel(); jump(S.cursor - 1); });
  $('plLast').addEventListener('click', () => { board.cancel(); jump(S.steps.length); });
  $('plNext').addEventListener('click', async () => { if (!S.playing && !board.busy) await forward(); });
  $('speed').addEventListener('change', () => { S.speed = Number($('speed').value); });

  for (const t of TABS) $(`tabbtn-${t}`).addEventListener('click', () => showTab(t));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'sim'));

  for (const b of document.querySelectorAll('[data-load]')) {
    b.addEventListener('click', () => openInSimulator({ cells: parseGrid(b.dataset.load), algo: b.dataset.algo || 'astar', plan: b.dataset.plan }));
  }

  // rules page tables
  $('algoTable').append(
    el('thead', {}, el('tr', {}, ['Algorithm', 'Frontier order', 'Uses h', 'Cheapest solution guaranteed', 'Notes'].map((t) => el('th', { textContent: t })))),
    el('tbody', {}, Object.values(ALGORITHMS).map((a) => el('tr', {}, [
      el('td', { textContent: `${a.name} — ${a.long}` }),
      el('td', { textContent: { BFS: 'FIFO', DFS: 'LIFO', IDS: 'depth-limited DFS, limit 0, 1, 2…', UCS: 'lowest g', Greedy: 'lowest h', 'A*': 'lowest g + h', 'Weighted A*': 'lowest g + 2h', 'IDA*': 'DFS inside growing g + h contours' }[a.name] }),
      el('td', { textContent: a.informed ? 'yes' : 'no' }),
      el('td', { textContent: a.optimal ? (a.informed ? 'yes, with an admissible h' : 'yes') : 'no' }),
      el('td', { className: 'wrap', textContent: a.note }),
    ]))),
  );
  $('heurTable').append(
    el('thead', {}, el('tr', {}, ['Heuristic', 'Admissible', 'Definition'].map((t) => el('th', { textContent: t })))),
    el('tbody', {}, Object.values(HEURISTICS).map((h) => el('tr', {}, [
      el('td', { textContent: `${h.short} · ${h.name}` }),
      el('td', { textContent: h.admissible ? 'yes' : 'no' }),
      el('td', { className: 'wrap', textContent: h.note }),
    ]))),
  );

  $('themeToggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('sandboxes-theme', document.documentElement.dataset.theme); } catch { /* storage may be blocked */ }
    board.readTheme();
  });
  try {
    const saved = localStorage.getItem('sandboxes-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch { /* ignore */ }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => board.readTheme());
  board.readTheme();

  syncSetupControls();
  rebuildModel();
  setStart(parseGrid('1 0/0 1/1 ½/½ 1/1 0'));
  showTab(location.hash.slice(1) || 'sim');
}

init();
