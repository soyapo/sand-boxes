// Batch evaluation: run every search algorithm on every initial state (or on a random sample)
// and aggregate cost, time and memory. Runs unchanged in Node and in a browser worker.

import { Sandbox, PROBS_SAND, PROBS_WATER, seededRng } from './model.js';
import { HEURISTICS } from './heuristics.js';
import { ALGORITHMS, search } from './search.js';
import { makeProblem } from './problem.js';

/** Expansion budget of RBFS per instance (it has no transposition table by design). */
export const RBFS_BUDGET = 500_000;

/**
 * What is compared. "greedy" is the greedy approach of the assignment (a fixed straight-down
 * sweep), followed by the four main searches and then the informed ones.
 * RBFS is a pure tree search, so it gets its own, smaller expansion budget.
 */
export const VARIANTS = Object.freeze([
  { key: 'greedy', algo: 'sweep', h: null, label: 'Greedy approach' },
  { key: 'bfs', algo: 'bfs', h: null, label: 'BFS' },
  { key: 'dfs', algo: 'dfs', h: null, label: 'DFS' },
  { key: 'ids', algo: 'ids', h: null, label: 'IDS' },
  { key: 'ucs', algo: 'ucs', h: null, label: 'UCS' },
  { key: 'astar-volume', algo: 'astar', h: 'volume', label: 'A* (h₁)' },
  { key: 'astar-gap', algo: 'astar', h: 'gap', label: 'A* (h₂)' },
  { key: 'rbfs', algo: 'rbfs', h: 'gap', label: 'RBFS', maxExpanded: RBFS_BUDGET },
  { key: 'idastar', algo: 'idastar', h: 'gap', label: 'IDA*' },
  { key: 'wastar', algo: 'wastar', h: 'gap', label: 'Weighted A*' },
  { key: 'gbfs', algo: 'gbfs', h: 'fall', label: 'Greedy best-first' },
]);

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// -------------------------------------------------------- the whole state graph

/**
 * Every state reachable from any of the 3^(2·rows) sand-only initial states (every gate closed),
 * with its successors. For the 5×2 grid that is 326,041 states and 2.3 million edges. Index 0..N0-1
 * are the initial states in base-3 order of their cell levels.
 */
export function buildGraph(model) {
  const size = model.size;
  const N0 = 3 ** size;
  const index = new Map();
  const keys = [];
  const queue = [];
  const add = (key) => {
    let i = index.get(key);
    if (i === undefined) {
      i = keys.length;
      index.set(key, i);
      keys.push(key);
      queue.push(i);
    }
    return i;
  };
  const cells = new Uint8Array(size);
  for (let n = 0; n < N0; n++) {
    for (let k = 0, x = n; k < size; k++) { cells[k] = x % 3; x = (x - cells[k]) / 3; }
    add(model.encode(model.initial(cells)));
  }
  const succ = [];
  const goal = [];
  while (queue.length) {
    const i = queue.pop();
    const st = model.decode(keys[i]);
    const list = [];
    for (let a = 0; a < model.actions.length; a++) {
      const r = model.apply(st, a);
      if (r) list.push({ a, s: add(model.encode(r.state)), c: r.cost });
    }
    succ[i] = list;
    goal[i] = model.isGoal(st);
  }
  return { model, N: keys.length, N0, keys, succ, goal: Uint8Array.from(goal), stateOf: (i) => model.decode(keys[i]) };
}

/**
 * Optimal cost-to-go for every state of the graph by value iteration (the graph is acyclic: sand
 * only moves down, levels out or sets, and gates close only when sand has left). Among equally
 * cheap solutions the one with the fewest actions is kept, then the one with the fewest side gates.
 */
export function solveGraph(graph) {
  const { N, succ, goal, model } = graph;
  const INF = 1e9;
  const opt = new Int32Array(N).fill(INF);
  const steps = new Int16Array(N);
  const sides = new Int16Array(N);
  for (let i = 0; i < N; i++) if (goal[i]) opt[i] = 0;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < N; i++) {
      if (goal[i]) continue;
      let bc = opt[i];
      let bs = steps[i];
      let bb = sides[i];
      for (const e of succ[i]) {
        if (opt[e.s] === INF) continue;
        const c = opt[e.s] + e.c;
        const st = steps[e.s] + 1;
        const b = sides[e.s] + (model.actions[e.a].type === 'b' ? 1 : 0);
        if (c < bc || (c === bc && (st < bs || (st === bs && b < bb)))) { bc = c; bs = st; bb = b; }
      }
      if (bc !== opt[i] || bs !== steps[i] || bb !== sides[i]) {
        opt[i] = bc; steps[i] = bs; sides[i] = bb;
        changed = true;
      }
    }
  }
  return { opt, steps, sides };
}

function graphHeuristics(graph) {
  const hs = {};
  for (const [name, h] of Object.entries(HEURISTICS)) {
    const arr = new Float64Array(graph.N);
    for (let i = 0; i < graph.N; i++) arr[i] = h.fn(graph.model, graph.stateOf(i));
    hs[name] = arr;
  }
  return hs;
}

// ---------------------------------------------------------------- collector

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(values) {
  const sorted = Float64Array.from(values).sort();
  let total = 0;
  for (const v of sorted) total += v;
  return {
    mean: sorted.length ? total / sorted.length : 0,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    total,
  };
}

class PointCloud {
  constructor() { this.map = new Map(); }
  add(x, y, example) {
    const k = `${x},${y}`;
    const p = this.map.get(k);
    if (p) p[2]++; else this.map.set(k, [x, y, 1, example]);
  }
  toJSON() { return [...this.map.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]); }
}

const RATIO_BIN = 0.05;

class Collector {
  constructor(variants) {
    this.variants = variants;
    this.per = variants.map(() => ({
      expanded: [], generated: [], memory: [], frontier: [], time: [], ratio: [], steps: [],
      solved: 0, aborted: 0, optimal: 0, costSum: 0,
      costVsOpt: new PointCloud(), actions: new PointCloud(), depth: new Map(),
    }));
    this.count = 0;
    this.solvable = 0;
    this.trivial = 0;
    this.optCost = [];
    this.optSteps = [];
    this.optActions = new PointCloud();
    this.optCostHist = new Map();
    // "With one unit per gate the greedy approach is optimal": BFS gives the fewest actions, so
    // comparing the two lengths on every instance checks that claim.
    this.greedyIndex = variants.findIndex((v) => v.key === 'greedy');
    this.bfsIndex = variants.findIndex((v) => v.key === 'bfs');
    this.unit = { compared: 0, greedyOptimal: 0, points: new PointCloud() };
  }

  /** @param {{key:number, opt:number, steps:number, sides:number, runs:Array}} rec  opt = Infinity when unsolvable */
  add(rec) {
    this.count++;
    const solvable = Number.isFinite(rec.opt);
    if (solvable) {
      this.solvable++;
      if (rec.opt === 0) this.trivial++;
      this.optCost.push(rec.opt);
      this.optSteps.push(rec.steps);
      this.optActions.add(rec.steps, rec.sides, rec.key);
      this.optCostHist.set(rec.opt, (this.optCostHist.get(rec.opt) || 0) + 1);
    }
    const gr = rec.runs[this.greedyIndex];
    const bf = rec.runs[this.bfsIndex];
    if (gr && bf && gr.found && bf.found) {
      this.unit.compared++;
      if (gr.steps === bf.steps) this.unit.greedyOptimal++;
      this.unit.points.add(gr.steps, bf.steps, rec.key);
    }
    rec.runs.forEach((r, v) => {
      const p = this.per[v];
      p.expanded.push(r.expanded);
      p.generated.push(r.generated);
      p.memory.push(r.maxMemory);
      p.frontier.push(r.maxFrontier);
      p.time.push(r.timeMs);
      if (r.aborted) p.aborted++;
      if (!r.found) return;
      p.solved++;
      p.costSum += r.cost;
      p.steps.push(r.steps);
      p.actions.add(r.steps, r.sides, rec.key);
      if (solvable) {
        if (r.cost === rec.opt) p.optimal++;
        p.costVsOpt.add(r.cost, rec.opt, rec.key);
        if (rec.opt > 0) p.ratio.push(r.cost / rec.opt);
        let d = p.depth.get(rec.steps);
        if (!d) p.depth.set(rec.steps, (d = { n: 0, expanded: 0, memory: 0, time: 0 }));
        d.n++; d.expanded += r.expanded; d.memory += r.maxMemory; d.time += r.timeMs;
      }
    });
  }

  result(meta) {
    const algos = this.variants.map((v, i) => {
      const p = this.per[i];
      const bins = [];
      let exact = 0;
      for (const r of p.ratio) {
        if (r <= 1 + 1e-9) exact++;
        const b = Math.floor((r - 1) / RATIO_BIN + 1e-9);
        bins[b] = (bins[b] || 0) + 1;
      }
      for (let b = 0; b < bins.length; b++) bins[b] = bins[b] || 0;
      return {
        key: v.key,
        algo: v.algo,
        label: v.label,
        long: ALGORITHMS[v.algo].long,
        heuristic: v.h,
        guaranteesOptimal: ALGORITHMS[v.algo].optimal && (!v.h || HEURISTICS[v.h].admissible),
        solved: p.solved,
        aborted: p.aborted,
        optimal: p.optimal,
        meanCost: p.solved ? p.costSum / p.solved : 0,
        ratio: { ...summarize(p.ratio), exact, binWidth: RATIO_BIN, bins },
        expanded: summarize(p.expanded),
        generated: summarize(p.generated),
        memory: summarize(p.memory),
        frontier: summarize(p.frontier),
        timeMs: summarize(p.time),
        steps: summarize(p.steps),
        costVsOpt: p.costVsOpt.toJSON(),
        actions: p.actions.toJSON(),
        byDepth: [...p.depth.entries()].sort((a, b) => a[0] - b[0])
          .map(([depth, d]) => ({ depth, n: d.n, expanded: d.expanded / d.n, memory: d.memory / d.n, timeMs: d.time / d.n })),
      };
    });
    return {
      meta: { ...meta, count: this.count, solvable: this.solvable, unsolvable: this.count - this.solvable, trivial: this.trivial },
      optimal: {
        cost: summarize(this.optCost),
        steps: summarize(this.optSteps),
        costHist: [...this.optCostHist.entries()].sort((a, b) => a[0] - b[0]),
        actions: this.optActions.toJSON(),
      },
      unitCost: { compared: this.unit.compared, greedyOptimal: this.unit.greedyOptimal, points: this.unit.points.toJSON() },
      algos,
    };
  }
}

function environment() {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    return `Node.js ${process.versions.node} (${process.platform} ${process.arch})`;
  }
  if (typeof navigator !== 'undefined') return `web browser, ${navigator.hardwareConcurrency || '?'} logical cores`;
  return 'unknown';
}

// ------------------------------------------------------------------ runners

function slim(model, r) {
  let sides = 0;
  for (const e of r.path) if (model.actions[e.a].type === 'b') sides++;
  return {
    found: r.found, aborted: r.aborted, cost: r.cost, steps: r.path.length, sides,
    expanded: r.expanded, generated: r.generated, maxMemory: r.maxMemory, maxFrontier: r.maxFrontier, timeMs: r.timeMs,
  };
}

/**
 * A runner evaluates one instance at a time: `run(id)` returns a plain record with the optimum and
 * one result per variant. Because records are plain data, several workers can each own a runner
 * and a single Collector can merge what they send back.
 *
 * cfg.kind = 'exhaustive': sand-only, every initial state of a rows×2 grid (59,049 for 5 rows), or
 *            `sample` of them drawn uniformly. Optima come from value iteration over the whole
 *            reachable state graph.
 * cfg.kind = 'random':     `count` random instances of any size, optionally with water. The optimum
 *            of each instance is taken from the exact algorithms (UCS, A*, IDA*).
 */
export function createRunner(cfg = {}) {
  const kind = cfg.kind === 'random' ? 'random' : 'exhaustive';
  const rows = cfg.rows ?? 5;
  const seed = cfg.seed ?? 1;

  if (kind === 'exhaustive') {
    const maxExpanded = cfg.maxExpanded ?? 2_000_000;
    const model = new Sandbox({ rows, concretePenalty: 10 });
    const N0 = 3 ** model.size;
    const sampled = cfg.sample > 0 && cfg.sample < N0;
    let ids;
    if (sampled) {
      const rng = seededRng(seed);
      const pick = new Set();
      while (pick.size < cfg.sample) pick.add(Math.floor(rng() * N0));
      ids = [...pick].sort((a, b) => a - b);
    } else {
      ids = Array.from({ length: N0 }, (_, i) => i);
    }
    let ctx = null; // built lazily: the coordinator only needs ids and meta
    const prepare = () => {
      const graph = buildGraph(model);
      const solved = solveGraph(graph);
      const hs = graphHeuristics(graph);
      const isGoal = (s) => graph.goal[s] === 1;
      const succOf = (s) => graph.succ[s];
      const zero = () => 0;
      const cellsOf = (s) => graph.stateOf(s).cells;
      const problems = VARIANTS.map((v) => ({ start: 0, actions: model.actions, isGoal, succ: succOf, cells: cellsOf, h: v.h ? ((arr) => (s) => arr[s])(hs[v.h]) : zero }));
      return { graph, solved, problems };
    };
    return {
      ids,
      meta: { kind: sampled ? 'sample' : 'exhaustive', variant: 'sand', rows, stateSpace: N0, seed: sampled ? seed : null },
      run(i) {
        ctx ??= prepare();
        const runs = VARIANTS.map((v, k) => {
          const p = ctx.problems[k];
          p.start = i; // initial state i has graph index i
          return slim(model, search(v.algo, p, { maxExpanded: Math.min(maxExpanded, v.maxExpanded ?? Infinity) }));
        });
        return { key: ctx.graph.keys[i], opt: ctx.solved.opt[i], steps: ctx.solved.steps[i], sides: ctx.solved.sides[i], runs };
      },
    };
  }

  const water = !!cfg.water;
  const concretePenalty = cfg.concretePenalty ?? 10;
  const probs = cfg.probs || (water ? PROBS_WATER : PROBS_SAND);
  const count = cfg.count ?? 500;
  const maxExpanded = cfg.maxExpanded ?? 300_000;
  const model = new Sandbox({ rows, concretePenalty });
  const exactIndexes = VARIANTS.map((v, k) => k).filter((k) => ALGORITHMS[VARIANTS[k].algo].optimal && HEURISTICS[VARIANTS[k].h || 'zero'].admissible);
  return {
    ids: Array.from({ length: count }, (_, i) => i),
    meta: { kind: 'random', variant: water ? 'water' : 'sand', rows, probs, concretePenalty, seed, maxExpanded, stateSpace: (water ? 6 : 3) ** (rows * 2) },
    run(i) {
      const cells = model.random(probs, seededRng(Math.imul(seed, 0x9e3779b1) + i));
      const base = makeProblem(model, model.initial(cells), 'gap');
      base.warm(maxExpanded);
      const runs = VARIANTS.map((v) => slim(model, search(v.algo, base.using(v.h || 'zero'), { maxExpanded: Math.min(maxExpanded, v.maxExpanded ?? Infinity) })));
      // Reference optimum: any exact algorithm that finished (one of them may hit the expansion limit).
      const best = exactIndexes.map((k) => runs[k]).find((r) => r.found);
      return { key: base.start, opt: best ? best.cost : null, steps: best ? best.steps : 0, sides: best ? best.sides : 0, runs };
    },
  };
}

/** Merge records (from one or many runners) into the final report. */
export function createCollector() {
  const collector = new Collector(VARIANTS);
  let mismatches = 0;
  return {
    add(rec) {
      const opt = rec.opt === null ? Infinity : rec.opt;
      for (const r of rec.runs) if (r.cost === null) r.cost = Infinity; // Infinity does not survive JSON
      VARIANTS.forEach((v, k) => {
        const exact = ALGORITHMS[v.algo].optimal && HEURISTICS[v.h || 'zero'].admissible;
        if (exact && !rec.runs[k].aborted && rec.runs[k].cost !== opt) mismatches++;
      });
      collector.add({ ...rec, opt });
    },
    result(meta, extra = {}) {
      return collector.result({ ...meta, optimalityMismatches: mismatches, environment: environment(), generatedAt: new Date().toISOString(), ...extra });
    },
  };
}

/** Single-threaded convenience wrapper around createRunner + createCollector. */
export function analyze(cfg = {}, onProgress = () => {}) {
  const t0 = now();
  const runner = createRunner(cfg);
  const collector = createCollector();
  const total = runner.ids.length;
  const every = runner.meta.kind === 'random' ? 8 : 256;
  for (let n = 0; n < total; n++) {
    collector.add(runner.run(runner.ids[n]));
    if ((n + 1) % every === 0) onProgress(n + 1, total);
  }
  onProgress(total, total);
  return collector.result(runner.meta, { workers: 1, wallSeconds: (now() - t0) / 1000 });
}

/**
 * Message handler shared by the browser worker and the Node worker thread.
 *   { type: 'init', cfg }      -> { type: 'ready' }
 *   { type: 'run', ids }       -> { type: 'records', records }
 */
export function createWorkerHandler(post) {
  let runner = null;
  return (msg) => {
    if (msg.type === 'init') {
      runner = createRunner(msg.cfg);
      post({ type: 'ready' });
    } else if (msg.type === 'run') {
      post({ type: 'records', records: msg.ids.map((id) => runner.run(id)) });
    }
  };
}
