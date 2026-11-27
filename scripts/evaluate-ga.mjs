#!/usr/bin/env node
// Deliverable 6 of the genetic-algorithm brief: the GA against a state-space search on 100 random
// problems with different initial states.
//
//   node scripts/evaluate-ga.mjs                        5×2 and 6×2, 100 problems each, writes data/a3-random100.json
//   node scripts/evaluate-ga.mjs --rows 5 --count 100 --seed 1 --out data/custom.json
//   node scripts/evaluate-ga.mjs --configs default,brief-ops,retry
//
// For every problem: the optimum from A* (h₂) and UCS, then one run of each GA configuration.
// Reported per configuration, exactly as the brief asks:
//   - how many of the 100 problems the GA solved (reached the goal state)
//   - the share of those successes whose path cost is optimal (equal to A* / UCS)
//   - the mean of GA_Path_cost / optimum_path_cost over all 100 problems and over the successes only.
// When the GA does not reach the goal, GA_Path_cost is the path cost of the fittest sequence it
// returned (which is cheap because it is unfinished), so the all-problems mean can be below the
// successes-only mean; the per-problem rows keep both numbers apart.
// Single-threaded; a 5×2 set takes seconds, a 6×2 set about two minutes (A* and UCS dominate).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { Sandbox, seededRng, PROBS_SAND, formatGrid } from '../js/core/model.js';
import { search } from '../js/core/search.js';
import { makeProblem, describePath } from '../js/core/problem.js';
import { DEFAULTS, normalizeParams } from '../js/core/genetic.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The configurations compared; each line changes one thing from the defaults. */
export const CONFIGS = {
  default: { label: 'GA (default)', ga: {} },
  'end': { label: 'conflicts of the end state', ga: { conflictMode: 'end' } },
  'brief-ops': { label: 'mutations of the brief only (replace, swap, reverse)', ga: { mutations: 'brief' } },
  double: { label: 'double-point crossover', ga: { crossover: 'double' } },
  retry: { label: 'lethal mutation: retry instead of repair', ga: { illegal: 'retry' } },
  zero: { label: 'illegal kept with fitness 0, no repair', ga: { illegal: 'zero' } },
  strict: { label: 'strict fitness (0 unless the goal is reached)', ga: { fitness: 'strict' } },
  boxes: { label: 'conflicts = boxes with sand', ga: { conflicts: 'boxes' } },
  fall: { label: 'conflicts = h₃', ga: { conflicts: 'fall' } },
  h2: { label: 'conflicts = h₂ unweighted (admissible)', ga: { conflicts: 'h2' } },
  roulette: { label: 'plain roulette', ga: { selection: 'roulette' } },
  tournament: { label: 'tournament selection', ga: { selection: 'tournament' } },
  small: { label: 'population 20', ga: { population: 20 } },
  large: { label: 'population 200', ga: { population: 200 } },
};

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) a[k.slice(2)] = true; else { a[k.slice(2)] = v; i++; }
  }
  return a;
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** 100 distinct random initial states with sand, drawn with the assignment's probabilities. */
function problems(model, count, seed) {
  const rng = seededRng(seed);
  const seen = new Set();
  const list = [];
  while (list.length < count) {
    const cells = model.random(PROBS_SAND, rng);
    const key = cells.join('');
    if (seen.has(key) || !cells.some((c) => c)) continue;
    seen.add(key);
    list.push(cells);
  }
  return list;
}

export function evaluateSet({ rows, count, seed, configs, log = () => {} }) {
  const model = new Sandbox({ rows });
  const t0 = performance.now();
  const rowsOut = [];
  problems(model, count, seed).forEach((cells, i) => {
    const base = makeProblem(model, model.initial(cells), 'gap');
    const astar = search('astar', base);
    const ucs = search('ucs', base.using('zero'));
    if (astar.cost !== ucs.cost) throw new Error(`A* and UCS disagree on problem ${i}`);
    const row = {
      grid: formatGrid(cells, ' / '),
      optimum: astar.cost,
      optimalSteps: astar.path.length,
      astar: { expanded: astar.expanded, timeMs: astar.timeMs },
      ucs: { expanded: ucs.expanded, timeMs: ucs.timeMs },
      runs: {},
    };
    for (const key of configs) {
      const r = search('ga', base, { ga: { ...CONFIGS[key].ga, seed } });
      const d = describePath(model, r.path);
      row.runs[key] = {
        success: r.found,
        cost: r.found ? r.cost : null,
        bestCost: r.ga.best.cost, // path cost of the fittest sequence (= cost when the goal was reached by the fittest one)
        bestConflicts: r.ga.best.conflicts,
        optimal: r.found && r.cost === astar.cost,
        ratio: r.found ? r.cost / astar.cost : null,
        ratioAll: (r.found ? r.cost : r.ga.best.cost) / astar.cost,
        steps: d.steps,
        sides: d.sides,
        generations: r.ga.generations,
        firstGoal: r.ga.firstGoalGeneration,
        evaluations: r.expanded,
        timeMs: r.timeMs,
      };
    }
    rowsOut.push(row);
    log(i + 1, count);
  });
  const summary = {};
  for (const key of configs) {
    const runs = rowsOut.map((r) => r.runs[key]);
    const ok = runs.filter((r) => r.success);
    summary[key] = {
      label: CONFIGS[key].label,
      params: normalizeParams(CONFIGS[key].ga),
      problems: count,
      successes: ok.length,
      optimal: ok.filter((r) => r.optimal).length,
      optimalShareOfSuccesses: ok.length ? ok.filter((r) => r.optimal).length / ok.length : null,
      optimalShareOfAll: ok.filter((r) => r.optimal).length / count,
      meanRatioAll: mean(runs.map((r) => r.ratioAll)),
      meanRatioSuccesses: mean(ok.map((r) => r.ratio)),
      worstRatio: ok.length ? Math.max(...ok.map((r) => r.ratio)) : null,
      meanEvaluations: mean(runs.map((r) => r.evaluations)),
      meanGenerations: mean(runs.map((r) => r.generations)),
      meanFirstGoal: mean(ok.map((r) => r.firstGoal)),
      medianTimeMs: median(runs.map((r) => r.timeMs)),
      meanTimeMs: mean(runs.map((r) => r.timeMs)),
    };
  }
  return {
    meta: {
      rows, count, seed, configs,
      defaults: normalizeParams({}),
      maxLength: 4 * rows,
      probabilities: PROBS_SAND,
      generatedAt: new Date().toISOString(),
      cpu: `${os.cpus()[0]?.model || 'unknown CPU'}`,
      environment: `Node.js ${process.versions.node} (${process.platform} ${process.arch})`,
      wallSeconds: (performance.now() - t0) / 1000,
    },
    reference: {
      astar: { label: 'A* with h₂', meanExpanded: mean(rowsOut.map((r) => r.astar.expanded)), medianTimeMs: median(rowsOut.map((r) => r.astar.timeMs)), meanTimeMs: mean(rowsOut.map((r) => r.astar.timeMs)) },
      ucs: { label: 'UCS', meanExpanded: mean(rowsOut.map((r) => r.ucs.expanded)), medianTimeMs: median(rowsOut.map((r) => r.ucs.timeMs)), meanTimeMs: mean(rowsOut.map((r) => r.ucs.timeMs)) },
      optimum: { mean: mean(rowsOut.map((r) => r.optimum)), max: Math.max(...rowsOut.map((r) => r.optimum)), meanSteps: mean(rowsOut.map((r) => r.optimalSteps)), maxSteps: Math.max(...rowsOut.map((r) => r.optimalSteps)) },
    },
    summary,
    problems: rowsOut,
  };
}

const args = parseArgs(process.argv.slice(2));
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('evaluate-ga.mjs')) {
  const configs = args.configs ? String(args.configs).split(',') : Object.keys(CONFIGS);
  for (const k of configs) if (!CONFIGS[k]) throw new Error(`unknown configuration "${k}" (one of ${Object.keys(CONFIGS).join(', ')})`);
  const count = Number(args.count) || 100;
  const seed = Number(args.seed) || 1;
  const sizes = args.rows ? [Number(args.rows)] : [5, 6];
  const sets = {};
  for (const rows of sizes) {
    process.stdout.write(`${rows}×2: ${count} random problems, ${configs.length} configurations\n`);
    const set = evaluateSet({ rows, count, seed, configs, log: (i, n) => { if (i % 10 === 0 || i === n) process.stdout.write(`\r  ${i}/${n}`); } });
    process.stdout.write('\n');
    for (const [k, s] of Object.entries(set.summary)) {
      console.log(`  ${s.label.padEnd(52)} solved ${String(s.successes).padStart(3)}/${count}  optimal ${String(s.optimal).padStart(3)} (${s.optimalShareOfSuccesses === null ? '-' : `${(100 * s.optimalShareOfSuccesses).toFixed(0)}% of successes`})  ratio all ${s.meanRatioAll.toFixed(3)}  ratio successes ${s.meanRatioSuccesses === null ? '-' : s.meanRatioSuccesses.toFixed(3)}  evals ${s.meanEvaluations.toFixed(0)}  median ${s.medianTimeMs.toFixed(1)} ms`);
    }
    console.log(`  A*: median ${set.reference.astar.medianTimeMs.toFixed(1)} ms, ${set.reference.astar.meanExpanded.toFixed(0)} expanded; UCS: median ${set.reference.ucs.medianTimeMs.toFixed(1)} ms, ${set.reference.ucs.meanExpanded.toFixed(0)} expanded; wall ${set.meta.wallSeconds.toFixed(0)} s`);
    sets[`${rows}x2`] = set;
  }
  const out = resolve(root, args.out || 'data/a3-random100.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), sets }));
  console.log(`wrote ${args.out || 'data/a3-random100.json'}`);
}
