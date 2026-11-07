// Background worker: runs single searches for the simulator and batches for the analysis tab,
// so the page stays responsive.

import { Sandbox } from './core/model.js';
import { search, ALGORITHMS } from './core/search.js';
import { makeProblem, describePath } from './core/problem.js';
import { HEURISTICS } from './core/heuristics.js';
import { createWorkerHandler, VARIANTS } from './core/analysis.js';

const LIMIT = 1_500_000;
const analysis = createWorkerHandler((m) => postMessage(m));

function pack(model, r) {
  return {
    found: r.found,
    aborted: r.aborted,
    cost: r.found ? r.cost : null,
    path: r.path.map((e) => e.a),
    expanded: r.expanded,
    generated: r.generated,
    maxMemory: r.maxMemory,
    maxFrontier: r.maxFrontier,
    iterations: r.iterations,
    timeMs: r.timeMs,
    ...describePath(model, r.path),
  };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init' || m.type === 'run') { analysis(m); return; }
  try {
    const model = new Sandbox(m.cfg);
    const start = model.initial(Uint8Array.from(m.cells));
    if (m.type === 'solve') {
      const base = makeProblem(model, start, m.heuristic);
      const r = search(m.algo, base, { maxExpanded: LIMIT });
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
      const results = VARIANTS.map((v) => ({
        key: v.key,
        label: v.label,
        algo: v.algo,
        heuristic: v.h,
        ...pack(model, search(v.algo, base.using(v.h || 'zero'), { maxExpanded: LIMIT })),
      }));
      postMessage({ id: m.id, results });
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err && err.message ? err.message : err) });
  }
};
