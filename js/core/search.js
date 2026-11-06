// Search algorithms over an abstract problem:
//
//   problem.start        encoded start state (a number)
//   problem.isGoal(s)    goal test
//   problem.succ(s)      array of { a: actionId, s: nextState, c: cost }
//   problem.h(s)         heuristic estimate (only used by the informed algorithms)
//
// Every algorithm returns
//   { found, aborted, cost, path: [{a, s, c}], expanded, generated, maxFrontier, maxMemory, iterations, timeMs }
// where maxMemory is the peak number of states held at once (frontier + explored / tables).

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a;
    let i = a.length;
    a.push(x);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(x, a[p])) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = x;
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const x = a.pop();
    const n = a.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let k = 2 * i + 1;
        if (k >= n) break;
        if (k + 1 < n && less(a[k + 1], a[k])) k++;
        if (!less(a[k], x)) break;
        a[i] = a[k];
        i = k;
      }
      a[i] = x;
    }
    return top;
  }
}
// heap entries: [priority, tieBreak, insertionOrder, state, g]
function less(x, y) {
  return x[0] !== y[0] ? x[0] < y[0] : x[1] !== y[1] ? x[1] < y[1] : x[2] < y[2];
}

function newStats() {
  return { found: false, aborted: false, cost: Infinity, path: [], expanded: 0, generated: 0, maxFrontier: 0, maxMemory: 0, iterations: 1, timeMs: 0 };
}

function pathFromParents(parent, goal) {
  const path = [];
  for (let s = goal, e = parent.get(s); e; s = e[0], e = parent.get(s)) path.push({ a: e[1], s, c: e[2] });
  return path.reverse();
}

function succeed(st, path) {
  st.found = true;
  st.path = path;
  st.cost = path.reduce((sum, e) => sum + e.c, 0);
  return st;
}

// ------------------------------------------------------------ uninformed

/** Breadth-first graph search. Finds a solution with the fewest actions (not the cheapest). */
function bfs(p, o) {
  const st = newStats();
  const parent = new Map([[p.start, null]]);
  if (p.isGoal(p.start)) return succeed(st, []);
  const queue = [p.start];
  let head = 0;
  while (head < queue.length) {
    if (st.expanded >= o.maxExpanded) { st.aborted = true; break; }
    const s = queue[head++];
    st.expanded++;
    for (const e of p.succ(s)) {
      st.generated++;
      if (parent.has(e.s)) continue;
      parent.set(e.s, [s, e.a, e.c]);
      if (p.isGoal(e.s)) {
        st.maxMemory = Math.max(st.maxMemory, parent.size);
        return succeed(st, pathFromParents(parent, e.s));
      }
      queue.push(e.s);
    }
    if (queue.length - head > st.maxFrontier) st.maxFrontier = queue.length - head;
    if (parent.size > st.maxMemory) st.maxMemory = parent.size;
  }
  return st;
}

/** Depth-first graph search. Returns the first solution it runs into. */
function dfs(p, o) {
  const st = newStats();
  const parent = new Map();
  const stack = [[p.start, null]];
  while (stack.length) {
    const [s, via] = stack.pop();
    if (parent.has(s)) continue;
    parent.set(s, via);
    if (p.isGoal(s)) return succeed(st, pathFromParents(parent, s));
    if (st.expanded >= o.maxExpanded) { st.aborted = true; break; }
    st.expanded++;
    const succ = p.succ(s);
    for (let i = succ.length - 1; i >= 0; i--) {
      const e = succ[i];
      st.generated++;
      if (!parent.has(e.s)) stack.push([e.s, [s, e.a, e.c]]);
    }
    if (stack.length > st.maxFrontier) st.maxFrontier = stack.length;
    if (stack.length + parent.size > st.maxMemory) st.maxMemory = stack.length + parent.size;
  }
  return st;
}

/**
 * Iterative-deepening depth-first search. Each iteration keeps a transposition table
 * (state -> largest remaining depth it was searched with); without it the many interleavings of
 * independent moves in the two columns make the search tree explode.
 */
function ids(p, o) {
  const st = newStats();
  st.iterations = 0;
  for (let limit = 0; ; limit++) {
    st.iterations++;
    const seen = new Map();
    const path = [];
    let cutoff = false;
    const visit = (s, left) => {
      if (p.isGoal(s)) return true;
      if (left === 0) { cutoff = true; return false; }
      const prev = seen.get(s);
      if (prev !== undefined && prev >= left) return false;
      seen.set(s, left);
      if (st.expanded >= o.maxExpanded) { st.aborted = true; return false; }
      st.expanded++;
      for (const e of p.succ(s)) {
        st.generated++;
        path.push(e);
        if (visit(e.s, left - 1)) return true;
        path.pop();
        if (st.aborted) return false;
      }
      return false;
    };
    const ok = visit(p.start, limit);
    const mem = seen.size + limit;
    if (mem > st.maxMemory) st.maxMemory = mem;
    if (limit > st.maxFrontier) st.maxFrontier = limit;
    if (ok) return succeed(st, path.slice());
    if (st.aborted || !cutoff) return st;
  }
}

// -------------------------------------------------------------- best-first

/**
 * Shared best-first engine.
 *   ucs:    priority g
 *   greedy: priority h          (never reopens a state)
 *   astar:  priority g + w * h  (reopens on a cheaper path, so any admissible h stays optimal)
 */
function bestFirst(p, o, mode, w = 1) {
  const st = newStats();
  const g = new Map([[p.start, 0]]);
  const parent = new Map([[p.start, null]]);
  const closed = new Set();
  const heap = new MinHeap();
  let order = 0;
  const h0 = mode === 'ucs' ? 0 : p.h(p.start);
  heap.push([mode === 'greedy' ? h0 : w * h0, mode === 'greedy' ? 0 : h0, order++, p.start, 0]);
  while (heap.size) {
    const top = heap.pop();
    const s = top[3];
    const gs = top[4];
    if (mode === 'greedy') {
      if (closed.has(s)) continue;
    } else if (gs > g.get(s)) continue; // stale entry
    closed.add(s);
    if (p.isGoal(s)) return succeed(st, pathFromParents(parent, s));
    if (st.expanded >= o.maxExpanded) { st.aborted = true; break; }
    st.expanded++;
    for (const e of p.succ(s)) {
      st.generated++;
      const ng = gs + e.c;
      const old = g.get(e.s);
      if (mode === 'greedy') {
        if (old !== undefined) continue;
        g.set(e.s, ng);
        parent.set(e.s, [s, e.a, e.c]);
        heap.push([p.h(e.s), ng, order++, e.s, ng]);
      } else {
        if (old !== undefined && old <= ng) continue;
        g.set(e.s, ng);
        parent.set(e.s, [s, e.a, e.c]);
        if (mode === 'ucs') heap.push([ng, 0, order++, e.s, ng]);
        else {
          const h = p.h(e.s);
          heap.push([ng + w * h, h, order++, e.s, ng]);
        }
      }
    }
    if (heap.size > st.maxFrontier) st.maxFrontier = heap.size;
    if (g.size > st.maxMemory) st.maxMemory = g.size;
  }
  if (g.size > st.maxMemory) st.maxMemory = g.size;
  return st;
}

/**
 * IDA*: depth-first contours of increasing f = g + h. As with IDS, a per-iteration transposition
 * table (state -> cheapest g seen) keeps the interleavings under control.
 */
function idastar(p, o) {
  const st = newStats();
  st.iterations = 0;
  let bound = p.h(p.start);
  for (;;) {
    st.iterations++;
    const seen = new Map();
    const path = [];
    let next = Infinity;
    let depth = 0;
    const visit = (s, gs) => {
      const f = gs + p.h(s);
      if (f > bound) { if (f < next) next = f; return false; }
      if (p.isGoal(s)) return true;
      const prev = seen.get(s);
      if (prev !== undefined && prev <= gs) return false;
      seen.set(s, gs);
      if (st.expanded >= o.maxExpanded) { st.aborted = true; return false; }
      st.expanded++;
      if (path.length > depth) depth = path.length;
      for (const e of p.succ(s)) {
        st.generated++;
        path.push(e);
        if (visit(e.s, gs + e.c)) return true;
        path.pop();
        if (st.aborted) return false;
      }
      return false;
    };
    const ok = visit(p.start, 0);
    const mem = seen.size + depth;
    if (mem > st.maxMemory) st.maxMemory = mem;
    if (depth > st.maxFrontier) st.maxFrontier = depth;
    if (ok) return succeed(st, path.slice());
    if (st.aborted || next === Infinity) return st;
    bound = next;
  }
}

// ------------------------------------------------------------------ registry

export const ALGORITHMS = Object.freeze({
  bfs: { name: 'BFS', long: 'Breadth-first search', informed: false, optimal: false, run: (p, o) => bfs(p, o), note: 'Fewest actions, ignores cost.' },
  dfs: { name: 'DFS', long: 'Depth-first search', informed: false, optimal: false, run: (p, o) => dfs(p, o), note: 'First solution found, ignores cost.' },
  ids: { name: 'IDS', long: 'Iterative deepening DFS', informed: false, optimal: false, run: (p, o) => ids(p, o), note: 'Fewest actions with depth-first memory.' },
  ucs: { name: 'UCS', long: 'Uniform-cost search (Dijkstra)', informed: false, optimal: true, run: (p, o) => bestFirst(p, o, 'ucs'), note: 'Cheapest solution, no heuristic.' },
  greedy: { name: 'Greedy', long: 'Greedy best-first search', informed: true, optimal: false, run: (p, o) => bestFirst(p, o, 'greedy'), note: 'Always expands the state that looks closest to the goal.' },
  astar: { name: 'A*', long: 'A* search', informed: true, optimal: true, run: (p, o) => bestFirst(p, o, 'astar', 1), note: 'Cheapest solution, guided by the heuristic.' },
  wastar: { name: 'Weighted A*', long: 'Weighted A* (w = 2)', informed: true, optimal: false, run: (p, o) => bestFirst(p, o, 'astar', o.weight ?? 2), note: 'Faster than A*, cost at most w × optimal.' },
  idastar: { name: 'IDA*', long: 'Iterative deepening A*', informed: true, optimal: true, run: (p, o) => idastar(p, o), note: 'Cheapest solution by depth-first f-contours.' },
});

/**
 * Run one algorithm.
 * @param {keyof ALGORITHMS} id
 * @param {object} problem
 * @param {{maxExpanded?: number, weight?: number}} [opts]
 */
export function search(id, problem, opts = {}) {
  const algo = ALGORITHMS[id];
  if (!algo) throw new RangeError(`unknown algorithm: ${id}`);
  const o = { maxExpanded: 2_000_000, ...opts };
  const t0 = now();
  const result = algo.run(problem, o);
  result.timeMs = now() - t0;
  result.algorithm = id;
  return result;
}
