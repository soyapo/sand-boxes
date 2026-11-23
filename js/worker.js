// Background worker: runs single searches for the simulator and batches for the analysis tab,
// so the page stays responsive.

import { Sandbox } from './core/model.js';
import { search, ALGORITHMS } from './core/search.js';
import { makeProblem, describePath } from './core/problem.js';
import { HEURISTICS } from './core/heuristics.js';
import { createWorkerHandler, variantsOf, effectiveBranchingFactor } from './core/analysis.js';

const LIMIT = 1_500_000;
const analysis = createWorkerHandler((m) => postMessage(m));

function pack(model, r) {
  return {
    found: r.found,
    aborted: r.aborted,
    ga: r.ga || null,
    cost: r.found ? r.cost : null,
    path: r.path.map((e) => e.a),
    expanded: r.expanded,
    generated: r.generated,
    maxMemory: r.maxMemory,
    maxFrontier: r.maxFrontier,
    iterations: r.iterations,
    timeMs: r.timeMs,
    ebf: r.found && r.path.length ? effectiveBranchingFactor(r.generated, r.path.length) : null,
    ...describePath(model, r.path),
  };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init' || m.type === 'run') { analysis(m); return; }
  try {
    const model = new Sandbox(m.cfg);
    const start = { cells: Uint8Array.from(m.cells), gates: m.gates || 0 }; // a state may come with open gates
    if (m.type === 'solve') {
      const base = makeProblem(model, start, m.heuristic);
      // the genetic algorithm reports every generation while it runs (m.stream), so the page can draw it live
      const onGeneration = m.algo === 'ga' && m.stream
        ? (info, population) => postMessage({ id: m.id, progress: { ...info, population: population.slice(0, 12).map((x) => ({ genes: x.genes, fitness: x.fitness, cost: x.cost, conflicts: x.conflicts, goal: x.goal, legal: x.legal })) } })
        : null;
      const r = search(m.algo, base, { maxExpanded: LIMIT, ga: m.ga, onGeneration });
      const algo = ALGORITHMS[m.algo];
      const exact = algo.optimal && (!algo.informed || HEURISTICS[m.heuristic].admissible);
      const ref = exact ? r : search('astar', base.using('gap'), { maxExpanded: LIMIT });
      postMessage({
        id: m.id,
        result: pack(model, r),
        optimum: ref.found ? ref.cost : null,
        unsolvable: !ref.found && !ref.aborted,
      });
    } else if (m.type === 'compare') {
      const base = makeProblem(model, start, 'gap');
      base.warm(400_000);
      const results = variantsOf(m.variants ? { variants: m.variants } : null).map((v) => ({
        key: v.key,
        label: v.label,
        algo: v.algo,
        heuristic: v.h,
        ...pack(model, search(v.algo, base.using(v.h || 'zero'), { maxExpanded: LIMIT, ga: v.ga ? { ...(m.ga || {}), ...v.ga } : undefined })),
      }));
      postMessage({ id: m.id, results });
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err && err.message ? err.message : err) });
  }
};
