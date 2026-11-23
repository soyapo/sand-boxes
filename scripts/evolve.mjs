#!/usr/bin/env node
// Run the genetic algorithm of Assignment 3 on one grid from the command line, with a log of every
// generation.
//
//   node scripts/evolve.mjs "1 0 / 0 1 / 0 1 / 1 0"
//   node scripts/evolve.mjs "1 1/1 1/1 1/0 0/0 0" --population 200 --generations 300 --seed 3
//   node scripts/evolve.mjs --random --rows 5 --seed 2 --conflicts fall --selection rank
//   node scripts/evolve.mjs "1 0 / 0 1 / 0 1 / 1 0" --compare        the GA against A*, the greedy approach and its own variants
//
// Parameters (defaults in js/core/genetic.js): --population --generations --max-length --elite
// --crossover --mutation --stagnation --seed --selection roulette|windowed|rank|tournament
// --fitness graded|strict|ratio --conflicts gates|sand|fall|sweep|h2|learned|zero --weight
// --no-repair --every N (log every N generations) --quiet

import { Sandbox, parseGrid, formatGrid, formatState, seededRng, PROBS_SAND, PROFESSOR_EXAMPLE } from '../js/core/model.js';
import { search } from '../js/core/search.js';
import { makeProblem, describePath } from '../js/core/problem.js';
import { DEFAULTS, CONFLICTS, FITNESS, SELECTION } from '../js/core/genetic.js';
import { A3_VARIANTS } from '../js/core/analysis.js';

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
  cells = new Sandbox({ rows }).random(PROBS_SAND, seededRng(Number(opt.seed) || 1));
} else {
  cells = parseGrid(gridText || PROFESSOR_EXAMPLE);
}
const model = new Sandbox({ rows: cells.length / 2 });
const base = makeProblem(model, model.initial(cells), 'gap');

const num = (k, d) => (opt[k] !== undefined ? Number(opt[k]) : d);
const ga = {
  population: num('population', DEFAULTS.population),
  generations: num('generations', DEFAULTS.generations),
  maxLength: num('max-length', DEFAULTS.maxLength),
  elite: num('elite', DEFAULTS.elite),
  crossoverRate: num('crossover', DEFAULTS.crossoverRate),
  mutationRate: num('mutation', DEFAULTS.mutationRate),
  stagnation: num('stagnation', DEFAULTS.stagnation),
  seed: num('seed', DEFAULTS.seed),
  selection: opt.selection || DEFAULTS.selection,
  fitness: opt.fitness || DEFAULTS.fitness,
  conflicts: opt.conflicts || DEFAULTS.conflicts,
  conflictWeight: opt.weight !== undefined ? Number(opt.weight) : null,
  repair: !opt['no-repair'],
};
for (const [k, table] of [['selection', SELECTION], ['fitness', FITNESS], ['conflicts', CONFLICTS]]) {
  if (!table[ga[k]]) throw new Error(`unknown ${k} "${ga[k]}" (one of ${Object.keys(table).join(', ')})`);
}

console.log(`Start (${model.rows}×2):\n${formatGrid(cells)}\n`);
const optimum = search('astar', base.using('gap'));
console.log(`Optimum (A* with h₂): ${optimum.cost} in ${optimum.path.length} actions.\n`);

if (opt.compare) {
  base.warm();
  // the variants keep their own selection, fitness, conflict function and weight; only the sizes and budgets are shared
  const shared = { population: ga.population, generations: ga.generations, maxLength: ga.maxLength, elite: ga.elite, crossoverRate: ga.crossoverRate, mutationRate: ga.mutationRate, stagnation: ga.stagnation, seed: ga.seed };
  const rows = A3_VARIANTS.map((v) => {
    const r = search(v.algo, base.using(v.h || 'zero'), { ga: v.ga ? { ...shared, ...v.ga } : undefined });
    const d = describePath(model, r.path);
    return {
      run: v.label, cost: r.found ? r.cost : 'none', 'vs optimum': r.found ? `${(((r.cost - optimum.cost) / optimum.cost) * 100).toFixed(0)}%` : '-',
      actions: d.steps, 'side gates': d.sides, 'evaluations / expanded': r.expanded, 'applied / generated': r.generated, generations: r.ga ? r.ga.generations : '-', 'time (ms)': Number(r.timeMs.toFixed(1)),
    };
  });
  console.table(rows);
  process.exit(0);
}

const every = num('every', 10);
const pad = (v, n) => String(v).padStart(n);
if (!opt.quiet) {
  console.log(`${SELECTION[ga.selection].name}; fitness = ${FITNESS[ga.fitness].name}; conflict_numbers = ${CONFLICTS[ga.conflicts].name.toLowerCase()} × ${ga.conflictWeight ?? CONFLICTS[ga.conflicts].weight}; population ${ga.population}, up to ${ga.generations} generations, length ≤ ${ga.maxLength}, repair ${ga.repair ? 'on' : 'off'}.\n`);
  console.log(`${pad('gen', 5)} ${pad('best f', 8)} ${pad('mean f', 8)} ${pad('worst f', 8)} ${pad('at goal', 8)} ${pad('distinct', 8)} ${pad('best cost', 10)}  best sequence`);
}
const r = search('ga', base, {
  ga,
  onGeneration: (info) => {
    if (opt.quiet || (info.gen % every !== 0 && info.gen !== ga.generations)) return;
    console.log(`${pad(info.gen, 5)} ${pad(info.best.toFixed(1), 8)} ${pad(info.mean.toFixed(1), 8)} ${pad(info.worst.toFixed(1), 8)} ${pad(`${(100 * info.goalShare).toFixed(0)}%`, 8)} ${pad(info.unique, 8)} ${pad(info.bestEverCost ?? '-', 10)}  ${info.bestGenes.map((a) => model.actions[a].short).join(' ')}`);
  },
});

console.log('');
if (!r.found) {
  console.log(`No individual reached the goal in ${r.ga.generations} generations.`);
} else {
  let state = model.initial(cells);
  let total = 0;
  r.path.forEach((e, k) => {
    const res = model.apply(state, e.a);
    state = res.state;
    total += e.c;
    console.log(`${String(k + 1).padStart(2)}. [${model.actions[e.a].type}] ${model.actions[e.a].label.padEnd(24)} cost ${String(e.c).padStart(2)}   total ${total}`);
    if (opt.verbose) console.log(formatState(model, state).replace(/^/gm, '      ') + '\n');
  });
  const d = describePath(model, r.path);
  console.log(`\nBest solution: cost ${r.cost} in ${d.steps} actions (${d.sides} side gates) — ${r.cost === optimum.cost ? 'optimal' : `${(((r.cost - optimum.cost) / optimum.cost) * 100).toFixed(0)}% above the optimum ${optimum.cost}`}.`);
  console.log(`First goal path in generation ${r.ga.firstGoalGeneration}, best fitness reached in generation ${r.ga.bestGeneration}, stopped after ${r.ga.generations} generations.`);
}
console.log(`large_number ${r.ga.largeNumber}; ${r.expanded} fitness evaluations, ${r.generated} actions applied, ${r.timeMs.toFixed(1)} ms.`);
