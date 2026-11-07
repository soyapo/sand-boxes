// Glue between the environment model and the search algorithms.

import { HEURISTICS } from './heuristics.js';

/**
 * Build a search problem for one start state (a { cells, gates } state, or just the cells with every
 * gate closed). Successors, goal tests and heuristic values are
 * memoised per state, so several algorithms can be compared on the same instance without paying
 * for the physics more than once.
 */
export function makeProblem(model, startState, heuristic = 'gap') {
  const cache = new Map();
  const info = (s) => {
    let n = cache.get(s);
    if (!n) {
      const state = model.decode(s);
      n = { state, succ: null, goal: model.isGoal(state) };
      cache.set(s, n);
    }
    return n;
  };
  const start = model.encode(startState.cells ? startState : model.initial(startState));
  const succ = (s) => {
    const n = info(s);
    if (!n.succ) n.succ = model.successors(n.state);
    return n.succ;
  };
  const view = (name) => {
    const hf = (HEURISTICS[name] || HEURISTICS.gap).fn;
    const memo = new Map();
    return {
      model,
      actions: model.actions,
      start,
      heuristic: name,
      isGoal: (s) => info(s).goal,
      succ,
      h: (s) => {
        let v = memo.get(s);
        if (v === undefined) { v = hf(model, info(s).state); memo.set(s, v); }
        return v;
      },
      state: (s) => info(s).state,
      cells: (s) => info(s).state.cells,
      /** Same instance (shared successor cache) with another heuristic. */
      using: view,
      /** Expand everything reachable from the start, so later timings measure search only. */
      warm(limit = 1_000_000) {
        const seen = new Set([start]);
        const stack = [start];
        while (stack.length && seen.size < limit) {
          for (const e of succ(stack.pop())) if (!seen.has(e.s)) { seen.add(e.s); stack.push(e.s); }
        }
        return seen.size;
      },
    };
  };
  return view(heuristic);
}

/** Summarise a solution path: number of actions and how many are side gates (type b). */
export function describePath(model, path) {
  let sides = 0;
  for (const e of path) if (model.actions[e.a].type === 'b') sides++;
  return { steps: path.length, sides, vertical: path.length - sides };
}
