// Search algorithms over an abstract problem:
//
//   problem.start        encoded start state (a number)
//   problem.isGoal(s)    goal test
//   problem.succ(s)      array of { a: actionId, s: nextState, c: cost }
//   problem.h(s)         heuristic estimate (only used by the informed algorithms)
//   problem.actions      the model's action list   (only used by the greedy approach)
//   problem.cells(s)     decoded cell array of s   (only used by the greedy approach)
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

// ------------------------------------------------------ the greedy approach

/**
 * The "greedy approach" of the assignment. It is not a search and uses no heuristic: it is the
 * fixed procedure described in class.
 *
 *   - No side gate is ever opened; the two columns are emptied independently, left then right.
 *   - In a column, start at the topmost box that contains sand and open the gate under it. The
 *     sand either moves down or stays stuck (the box below is full); either way go on to the box
 *     below and do the same, down to the outlet.
 *   - Repeat such sweeps until the column holds no sand.
 *
 * A gate that would move nothing is not an action, so a "stuck" box is simply skipped. On sand-only
 * grids the procedure always finishes; with water it can get stuck behind concrete, in which case
 * it reports failure.
 */
function sweep(p, o) {
  const st = newStats();
  st.maxFrontier = 1;
  st.maxMemory = 1; // it only ever holds the current state
  const rows = p.actions.length / 3;
  const path = [];
  let s = p.start;
  for (let col = 0; col < 2 && !p.isGoal(s); col++) {
    for (;;) {
      const cells = p.cells(s);
      let top = 0;
      while (top < rows && (cells[top * 2 + col] !== 1 && cells[top * 2 + col] !== 2)) top++;
      if (top === rows) break; // no sand left in this column
      let moved = false;
      for (let row = top; row < rows; row++) {
        const id = rows + col * rows + row; // the top-down gate under box (row, col)
        const succ = p.succ(s);
        st.generated += succ.length;
        const e = succ.find((x) => x.a === id);
        if (!e) continue; // nothing would move: skip this box
        st.expanded++;
        path.push(e);
        s = e.s;
        moved = true;
      }
      if (!moved || st.expanded >= o.maxExpanded) return st; // stuck (only possible with water or concrete)
    }
  }
  return p.isGoal(s) ? succeed(st, path) : st;
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

/**
 * Recursive best-first search (Korf). Keeps only the current path and the siblings along it, and
 * remembers in each abandoned subtree the best f-value found there, so it can come back to it.
 * It is a pure tree search: memory is linear in the depth, at the price of re-expanding states.
 */
function rbfs(p, o) {
  const st = newStats();
  const path = [];
  let held = 0;
  // returns the new backed-up f of the node, or -1 when the goal was found below it
  const visit = (s, g, f, limit) => {
    if (p.isGoal(s)) return -1;
    if (st.expanded >= o.maxExpanded) { st.aborted = true; return Infinity; }
    st.expanded++;
    const succ = p.succ(s);
    st.generated += succ.length;
    if (!succ.length) return Infinity;
    const fs = new Array(succ.length);
    for (let i = 0; i < succ.length; i++) fs[i] = Math.max(g + succ[i].c + p.h(succ[i].s), f);
    held += succ.length;
    if (held > st.maxMemory) st.maxMemory = held;
    if (path.length + 1 > st.maxFrontier) st.maxFrontier = path.length + 1;
    for (;;) {
      let best = 0;
      let alt = Infinity;
      for (let i = 1; i < fs.length; i++) {
        if (fs[i] < fs[best]) { alt = fs[best]; best = i; } else if (fs[i] < alt) alt = fs[i];
      }
      if (fs[best] > limit || fs[best] === Infinity) { held -= succ.length; return fs[best]; }
      const e = succ[best];
      path.push(e);
      const r = visit(e.s, g + e.c, fs[best], Math.min(limit, alt));
      if (r === -1) return -1;
      path.pop();
      if (st.aborted) { held -= succ.length; return Infinity; }
      fs[best] = r;
    }
  };
  const r = visit(p.start, 0, p.h(p.start), Infinity);
  return r === -1 ? succeed(st, path.slice()) : st;
}

// ------------------------------------------------------------------ registry

export const ALGORITHMS = Object.freeze({
  sweep: { name: 'Greedy approach', long: 'Greedy approach of the assignment', informed: false, optimal: false, order: 'no frontier: a fixed top-to-bottom sweep of each column', run: (p, o) => sweep(p, o), note: 'Not a search: flush each column straight down, never using a side gate.' },
  bfs: { name: 'BFS', long: 'Breadth-first search', informed: false, optimal: false, order: 'FIFO', run: (p, o) => bfs(p, o), note: 'Fewest actions, ignores cost.' },
  dfs: { name: 'DFS', long: 'Depth-first search', informed: false, optimal: false, order: 'LIFO', run: (p, o) => dfs(p, o), note: 'First solution found, ignores cost.' },
  ids: { name: 'IDS', long: 'Iterative deepening DFS', informed: false, optimal: false, order: 'depth-limited DFS, limit 0, 1, 2…', run: (p, o) => ids(p, o), note: 'Fewest actions with depth-first memory.' },
  ucs: { name: 'UCS', long: 'Uniform-cost search (Dijkstra)', informed: false, optimal: true, order: 'lowest g', run: (p, o) => bestFirst(p, o, 'ucs'), note: 'Cheapest solution, no heuristic.' },
  astar: { name: 'A*', long: 'A* search', informed: true, optimal: true, order: 'lowest g + h', run: (p, o) => bestFirst(p, o, 'astar', 1), note: 'Cheapest solution, guided by the heuristic.' },
  rbfs: { name: 'RBFS', long: 'Recursive best-first search', informed: true, optimal: true, order: 'best f first, backing up f-values', run: (p, o) => rbfs(p, o), note: 'Cheapest solution in linear memory; re-expands states heavily.' },
  idastar: { name: 'IDA*', long: 'Iterative deepening A*', informed: true, optimal: true, order: 'DFS inside growing g + h contours', run: (p, o) => idastar(p, o), note: 'Cheapest solution by depth-first f-contours.' },
  wastar: { name: 'Weighted A*', long: 'Weighted A* (w = 2)', informed: true, optimal: false, order: 'lowest g + 2h', run: (p, o) => bestFirst(p, o, 'astar', o.weight ?? 2), note: 'Faster than A*, cost at most w × optimal.' },
  gbfs: { name: 'Greedy best-first', long: 'Greedy best-first search', informed: true, optimal: false, order: 'lowest h', run: (p, o) => bestFirst(p, o, 'greedy'), note: 'The informed-search “greedy”: always expands the state that looks closest to the goal.' },
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
