// Batch evaluation: run every search algorithm on every initial state (or on a random sample)
// and aggregate cost, time and memory. Runs unchanged in Node and in a browser worker.

import { Sandbox, PROBS_SAND, PROBS_WATER, seededRng } from './model.js';
import { HEURISTICS } from './heuristics.js';
import { ALGORITHMS, search } from './search.js';
import { makeProblem, describePath } from './problem.js';

/** Algorithm + heuristic combinations that are compared. */
export const VARIANTS = Object.freeze([
  { key: 'bfs', algo: 'bfs', h: null, label: 'BFS' },
  { key: 'dfs', algo: 'dfs', h: null, label: 'DFS' },
  { key: 'ids', algo: 'ids', h: null, label: 'IDS' },
  { key: 'ucs', algo: 'ucs', h: null, label: 'UCS' },
  { key: 'greedy', algo: 'greedy', h: 'fall', label: 'Greedy' },
  { key: 'astar-volume', algo: 'astar', h: 'volume', label: 'A* (h₁)' },
  { key: 'astar-gap', algo: 'astar', h: 'gap', label: 'A* (h₂)' },
  { key: 'wastar', algo: 'wastar', h: 'gap', label: 'Weighted A*' },
  { key: 'idastar', algo: 'idastar', h: 'gap', label: 'IDA*' },
]);

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ------------------------------------------------------- exhaustive tables

/**
 * Transition table over all 3^(2·rows) sand-only states. State index = base-3 number of the
 * cell levels, so index 0 is the empty grid (the only goal).
 */
export function buildTable(model) {
  const size = model.size;
  const N = 3 ** size;
  const A = model.actions.length;
  const next = new Int32Array(N * A).fill(-1);
  const cost = new Uint8Array(N * A);
  const succ = new Array(N);
  const cells = new Uint8Array(size);
  const indexOf = (c) => {
    let x = 0;
    for (let k = size - 1; k >= 0; k--) x = x * 3 + c[k];
    return x;
  };
  for (let i = 0; i < N; i++) {
    for (let k = 0, x = i; k < size; k++) { cells[k] = x % 3; x = (x - cells[k]) / 3; }
    const list = [];
    for (let a = 0; a < A; a++) {
      const r = model.apply(cells, a);
      if (!r) continue;
      const t = indexOf(r.cells);
      next[i * A + a] = t;
      cost[i * A + a] = r.cost;
      list.push({ a, s: t, c: r.cost });
    }
    succ[i] = list;
  }
  const cellsOf = (i) => {
    const c = new Uint8Array(size);
    for (let k = 0; k < size; k++) { c[k] = i % 3; i = (i - c[k]) / 3; }
    return c;
  };
  return { model, N, A, next, cost, succ, cellsOf, indexOf };
}

/**
 * Optimal cost-to-go for every state by value iteration (the state graph is acyclic: sand only
 * moves down or levels out). Among equally cheap solutions the one with the fewest actions is
 * kept, then the one with the fewest side gates.
 */
export function solveTable(table) {
  const { N, A, next, cost, model } = table;
  const INF = 1e9;
  const opt = new Int32Array(N).fill(INF);
  const steps = new Int16Array(N);
  const sides = new Int16Array(N);
  const act = new Int8Array(N).fill(-1);
  opt[0] = 0;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 1; i < N; i++) {
      let bc = opt[i];
      let bs = steps[i];
      let bb = sides[i];
      let ba = act[i];
      for (let a = 0; a < A; a++) {
        const t = next[i * A + a];
        if (t < 0 || opt[t] === INF) continue;
        const c = opt[t] + cost[i * A + a];
        const s = steps[t] + 1;
        const b = sides[t] + (model.actions[a].type === 'b' ? 1 : 0);
        if (c < bc || (c === bc && (s < bs || (s === bs && b < bb)))) { bc = c; bs = s; bb = b; ba = a; }
      }
      if (bc !== opt[i] || bs !== steps[i] || bb !== sides[i]) {
        opt[i] = bc; steps[i] = bs; sides[i] = bb; act[i] = ba;
        changed = true;
      }
    }
  }
  return { opt, steps, sides, act };
}

function tableHeuristics(table) {
  const hs = {};
  for (const [name, h] of Object.entries(HEURISTICS)) {
    const arr = new Float64Array(table.N);
    for (let i = 0; i < table.N; i++) arr[i] = h.fn(table.model, table.cellsOf(i));
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
 * cfg.kind = 'exhaustive': sand-only, every state of a rows×2 grid (59,049 for 5 rows), or
 *            `sample` states drawn uniformly from it. Optima come from the solved table.
 * cfg.kind = 'random':     `count` random instances of any size, optionally with water. The optimum
 *            of each instance is taken from the exact algorithms (UCS, A*, IDA*).
 */
export function createRunner(cfg = {}) {
  const kind = cfg.kind === 'random' ? 'random' : 'exhaustive';
  const rows = cfg.rows ?? 5;
  const chain = cfg.chain ?? 'press';
  const seed = cfg.seed ?? 1;

  if (kind === 'exhaustive') {
    const maxExpanded = cfg.maxExpanded ?? 2_000_000;
    const model = new Sandbox({ rows, chain });
    const N = 3 ** model.size;
    const sampled = cfg.sample > 0 && cfg.sample < N;
    let ids;
    if (sampled) {
      const rng = seededRng(seed);
      const pick = new Set();
      while (pick.size < cfg.sample) pick.add(Math.floor(rng() * N));
      ids = [...pick].sort((a, b) => a - b);
    } else {
      ids = Array.from({ length: N }, (_, i) => i);
    }
    let ctx = null; // built lazily: the coordinator only needs ids and meta
    const prepare = () => {
      const table = buildTable(model);
      const solved = solveTable(table);
      const hs = tableHeuristics(table);
      const isGoal = (s) => s === 0;
      const succOf = (s) => table.succ[s];
      const zero = () => 0;
      const problems = VARIANTS.map((v) => ({ start: 0, isGoal, succ: succOf, h: v.h ? ((arr) => (s) => arr[s])(hs[v.h]) : zero }));
      return { table, solved, problems };
    };
    return {
      ids,
      meta: { kind: sampled ? 'sample' : 'exhaustive', variant: 'sand', rows, chain, stateSpace: N, seed: sampled ? seed : null },
      run(i) {
        ctx ??= prepare();
        const runs = VARIANTS.map((v, k) => {
          const p = ctx.problems[k];
          p.start = i;
          return slim(model, search(v.algo, p, { maxExpanded }));
        });
        return { key: model.encode(ctx.table.cellsOf(i)), opt: ctx.solved.opt[i], steps: ctx.solved.steps[i], sides: ctx.solved.sides[i], runs };
      },
    };
  }

  const water = !!cfg.water;
  const concretePenalty = cfg.concretePenalty ?? 10;
  const probs = cfg.probs || (water ? PROBS_WATER : PROBS_SAND);
  const count = cfg.count ?? 500;
  const maxExpanded = cfg.maxExpanded ?? 300_000;
  const model = new Sandbox({ rows, chain, concretePenalty });
  const exactIndexes = VARIANTS.map((v, k) => k).filter((k) => ALGORITHMS[VARIANTS[k].algo].optimal && HEURISTICS[VARIANTS[k].h || 'zero'].admissible);
  return {
    ids: Array.from({ length: count }, (_, i) => i),
    meta: { kind: 'random', variant: water ? 'water' : 'sand', rows, chain, probs, concretePenalty, seed, maxExpanded, stateSpace: (water ? 6 : 3) ** (rows * 2) },
    run(i) {
      const cells = model.random(probs, seededRng(Math.imul(seed, 0x9e3779b1) + i));
      const base = makeProblem(model, cells, 'gap');
      base.warm(maxExpanded);
      const runs = VARIANTS.map((v) => slim(model, search(v.algo, base.using(v.h || 'zero'), { maxExpanded })));
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
