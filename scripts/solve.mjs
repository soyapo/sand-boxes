#!/usr/bin/env node
// Solve one grid from the command line.
//
//   node scripts/solve.mjs "1 0 / 0 1 / 0 1 / 1 0"                 A* with the gap heuristic
//   node scripts/solve.mjs "1 0 / 0 1 / 0 1 / 1 0" --algo greedy --h fall
//   node scripts/solve.mjs "0 W / ½ 0 / # 0" --all                 compare every algorithm
//   node scripts/solve.mjs --random --rows 5 --seed 3 [--water]
//
// Cells: 0 empty, ½ (or .5) half sand, 1 full sand, w half water, W full water, # concrete.
// Options: --chain press|always|none   --penalty 10   --quiet

import { Sandbox, parseGrid, formatGrid, seededRng, PROBS_SAND, PROBS_WATER, PROFESSOR_EXAMPLE } from '../js/core/model.js';
import { search, ALGORITHMS } from '../js/core/search.js';
import { makeProblem, describePath } from '../js/core/problem.js';
import { HEURISTICS } from '../js/core/heuristics.js';
import { VARIANTS } from '../js/core/analysis.js';

const argv = process.argv.slice(2);
const opt = {};
let gridText = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opt[argv[i].slice(2)] = true; else { opt[argv[i].slice(2)] = next; i++; }
  } else gridText = argv[i];
}

let cells;
if (opt.random) {
  const rows = Number(opt.rows) || 5;
  cells = new Sandbox({ rows }).random(opt.water ? PROBS_WATER : PROBS_SAND, seededRng(Number(opt.seed) || 1));
} else {
  cells = parseGrid(gridText || PROFESSOR_EXAMPLE);
}
const model = new Sandbox({ rows: cells.length / 2, chain: opt.chain || 'press', concretePenalty: opt.penalty !== undefined ? Number(opt.penalty) : 10 });

console.log(`Start (${model.rows}×2, door rule: ${model.chain}):\n${formatGrid(cells)}\n`);

if (opt.all) {
  const base = makeProblem(model, cells, 'gap');
  base.warm();
  const rows = VARIANTS.map((v) => {
    const r = search(v.algo, base.using(v.h || 'zero'));
    const d = describePath(model, r.path);
    return {
      algorithm: v.label, heuristic: v.h ? HEURISTICS[v.h].name : '-', cost: r.found ? r.cost : (r.aborted ? 'limit' : 'none'),
      actions: d.steps, 'side gates': d.sides, expanded: r.expanded, generated: r.generated, 'peak memory': r.maxMemory, 'time (ms)': Number(r.timeMs.toFixed(3)),
    };
  });
  console.table(rows);
} else {
  const algo = opt.algo || 'astar';
  const h = opt.h || (algo === 'greedy' ? 'fall' : 'gap');
  if (!ALGORITHMS[algo]) throw new Error(`unknown algorithm "${algo}" (one of ${Object.keys(ALGORITHMS).join(', ')})`);
  if (!HEURISTICS[h]) throw new Error(`unknown heuristic "${h}" (one of ${Object.keys(HEURISTICS).join(', ')})`);
  const r = search(algo, makeProblem(model, cells, h));
  if (!r.found) {
    console.log(r.aborted ? 'Search stopped at the expansion limit.' : 'No solution: some sand is trapped.');
  } else {
    let state = cells;
    let total = 0;
    r.path.forEach((e, k) => {
      const res = model.apply(state, e.a);
      state = res.cells;
      total += e.c;
      console.log(`${String(k + 1).padStart(2)}. [${model.actions[e.a].type}] ${model.actions[e.a].label.padEnd(24)} cost ${String(e.c).padStart(2)}   total ${total}`);
      if (!opt.quiet) console.log(formatGrid(state).replace(/^/gm, '      ') + '\n');
    });
    const d = describePath(model, r.path);
    console.log(`\n${ALGORITHMS[algo].long}${ALGORITHMS[algo].informed ? ` with heuristic "${HEURISTICS[h].name}"` : ''}`);
    console.log(`Solution cost ${r.cost} in ${d.steps} actions (${d.sides} side gates).`);
  }
  console.log(`Expanded ${r.expanded} states, generated ${r.generated}, peak memory ${r.maxMemory} states, ${r.timeMs.toFixed(2)} ms.`);
}
