// Genetic algorithm over action sequences — the third assignment.
//
// The project brief describes the algorithm in seven steps; each maps to something here:
//
//   step 1  the problem           the Sandbox model and the problem interface shared with the searches
//   step 2  state = sequence of   an individual is an array of action ids read from the start state,
//           actions               with a fixed upper bound on its length (actions after the goal are ignored)
//   step 3  Path_Goal_Test /      successfulPath(problem, env, genes): replay the sequence, true if the
//           Successful_Path_Test  goal is reached at any point
//   step 4  Conflict Number       Problem.conflictNumbers(s) per state, several choices; conflictNumber(...)
//                                 of a sequence = the smallest value seen while executing it (as the brief asks)
//   step 5  Fitness               fitness(...): large_number − w1·f(conflict_number) − w2·g(path_cost);
//                                 the strict and ratio forms are kept for comparison
//   step 6  the GA                SolverAgent: initial population, mutation (replace / swap / reverse, plus
//                                 insert / delete / regrow), single- and double-point crossover
//   step 7  selection             selection(population, n, method): fitness → probability, a mating pool
//                                 with repeats, sorted by fitness
//
// Everything works on the same problem interface the other algorithms use (see search.js):
//   view.start, view.isGoal(s), view.succ(s) = [{ a, s: next, c: cost }] (the legal actions in s),
//   view.actions, view.model, view.state(s) / view.cells(s).

import { seededRng, MAT, SAND, LEVEL } from './model.js';
import { HEURISTICS } from './heuristics.js';
import { search } from './search.js'; // only called inside functions, so the import cycle is harmless

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The most a single action can cost on a sand-only grid: 1 + 4·(1 + 1). */
const MAX_STEP_COST = 9;
/** How often an operator is retried in the "lethal mutation" mode before the parent is kept. */
const RETRIES = 20;

/** The full { cells, gates } state behind an encoded state, whichever problem view we are given. */
function stateOf(view, s) {
  if (view.state) return view.state(s);
  return { cells: view.cells(s), gates: 0 };
}

// ------------------------------------------------------- step 4: Conflict Number

/**
 * Ways of estimating how far a state is from the goal. Each is a count or a cost estimate, 0 at
 * the goal; the fitness multiplies it by a weight (`conflictWeight`, default per kind) chosen so
 * that the penalty for stopping short of the goal is at least the cost of finishing — otherwise
 * the fittest path is the one that does nothing (see the design notes, step 5).
 */
export const CONFLICTS = Object.freeze({
  gates: {
    name: 'Closed gates with sand above them',
    short: 'gates',
    weight: MAX_STEP_COST,
    note: 'The gates that still have to be opened (h₂ ÷ 3), each weighted by the largest possible action cost, 9. On every reachable 5×2 state 9 × gates ≥ h*, so finishing a path always pays.',
    fn: (view, s) => HEURISTICS.gap.fn(view.model, stateOf(view, s)) / 3,
  },
  boxes: {
    name: 'Boxes that still hold sand',
    short: 'boxes',
    weight: MAX_STEP_COST,
    note: 'The brief’s own example of a conflict count: the number of cells that are not empty yet, weighted by 9. It does not see how deep the sand sits.',
    fn: (view, s) => {
      const { cells } = stateOf(view, s);
      let n = 0;
      for (let i = 0; i < cells.length; i++) if (MAT[cells[i]] === SAND) n++;
      return n;
    },
  },
  sand: {
    name: 'Half-units of sand left',
    short: 'sand',
    weight: MAX_STEP_COST,
    note: 'How much sand is still in the grid, weighted by 9. Like the box count it ignores depth, so it can be far below h*.',
    fn: (view, s) => {
      const { cells } = stateOf(view, s);
      let t = 0;
      for (let i = 0; i < cells.length; i++) if (MAT[cells[i]] === SAND) t += LEVEL[cells[i]];
      return t;
    },
  },
  fall: {
    name: 'Fall distance h₃',
    short: 'h₃',
    weight: 1.2,
    note: 'Assignment 2’s inadmissible estimate: 2.5 per half-unit of sand per closed gate below it. Overestimates almost everywhere (h*/h₃ ≤ 1.2), so weight 1.2.',
    fn: (view, s) => HEURISTICS.fall.fn(view.model, stateOf(view, s)),
  },
  sweep: {
    name: 'Cost of the greedy approach from here',
    short: 'greedy',
    weight: 1,
    note: 'Run the straight-down sweep of Assignment 1 from the state: an exact upper bound on the remaining cost (never below h*), tight on 10% of states.',
    fn: (view, s) => { const r = search('sweep', { ...view, start: s }); return r.found ? r.cost : NaN; },
  },
  h2: {
    name: 'Closed-gate bound h₂ (admissible)',
    short: 'h₂',
    weight: 1,
    note: 'The proven lower bound, unweighted. It underestimates by half on average, so large − h₂ − cost rewards stopping early: the failure case of the design.',
    fn: (view, s) => HEURISTICS.gap.fn(view.model, stateOf(view, s)),
  },
  learned: {
    name: 'Regression estimate h₄',
    short: 'h₄',
    weight: 1.35,
    note: 'Assignment 2’s learned estimate, weighted by 1.35 (h*/h₄ ≤ 1.34 on the training states where h₄ > 0) so that it rarely falls below h*.',
    fn: (view, s) => HEURISTICS.learned.fn(view.model, stateOf(view, s)),
  },
  zero: {
    name: 'None',
    short: '0',
    weight: 1,
    note: 'No conflict term: fitness = large − cost. Only the strict form can work with it.',
    fn: () => 0,
  },
});

/** How the conflict number of a whole sequence is taken from the states it passes through. */
export const CONFLICT_MODES = Object.freeze({
  min: { name: 'smallest value seen along the sequence', note: 'As the brief asks: the sequence is replayed from the start state, the state after every action is scored, and the smallest of those scores is the conflict number of the sequence (an empty sequence is scored by the start state).' },
  end: { name: 'value of the last state', note: 'The state the sequence ends in. Used by the first version of this project; kept for comparison.' },
});

// ---------------------------------------------------------------- Problem

/**
 * What has to be solved: the start state, the goal test, the actions, the length bound of a path,
 * the conflict function and how it is read along a path, and large_number.
 */
export class Problem {
  /**
   * @param {object} view  problem interface (see above); `model` and `state(s)` are used by the conflict functions
   * @param {{maxLength?: number|null, largeNumber?: number|null, conflicts?: string, conflictWeight?: number|null, conflictMode?: string}} [opts]
   */
  constructor(view, { maxLength = null, largeNumber = null, conflicts = 'gates', conflictWeight = null, conflictMode = 'min' } = {}) {
    if (!CONFLICTS[conflicts]) throw new RangeError(`unknown conflict function: ${conflicts}`);
    if (!CONFLICT_MODES[conflictMode]) throw new RangeError(`unknown conflict mode: ${conflictMode}`);
    this.view = view;
    this.start = view.start;
    this.actions = view.actions;
    this.rows = view.actions.length / 3;
    /** Length bound of a sequence: 4 actions per row by default (20 for 5×2; no optimal 5×2 plan needs more than 18). */
    this.maxLength = maxLength ?? 4 * this.rows;
    this.conflicts = conflicts;
    this.conflictWeight = conflictWeight ?? CONFLICTS[conflicts].weight;
    this.conflictMode = conflictMode;
    const size = this.rows * 2;
    const cells = view.cells ? view.cells(view.start) : null;
    const wet = cells ? Array.prototype.some.call(cells, (c) => c >= 3) : false; // water or concrete present
    /** Upper bound on the cost of one action: with water, every box could set into concrete. */
    this.maxStepCost = MAX_STEP_COST + (wet && view.model ? view.model.concretePenalty * size : 0);
    /**
     * large_number: derived, not hand-picked. A legal path has at most maxLength actions of at most
     * maxStepCost each, and the weighted conflict estimate is a cost estimate too, bounded the same
     * way; with this constant the fitness of every legal path is positive.
     */
    this.largeNumber = largeNumber ?? 2 * this.maxLength * this.maxStepCost + 1;
  }

  isGoal(s) { return this.view.isGoal(s); }

  /** Conflict number of one state (unweighted; 0 exactly in the goal states). */
  conflictNumbers(s) { return this.view.isGoal(s) ? 0 : CONFLICTS[this.conflicts].fn(this.view, s); }

  /**
   * Conflict number of a sequence from the states it passed through: as the brief says, the state
   * after each action is scored and the smallest score is reported (an empty sequence is scored by
   * the start state). In the 'end' mode only the last state counts.
   */
  pathConflicts(states) {
    if (this.conflictMode === 'end' || states.length === 1) return this.conflictNumbers(states[states.length - 1]);
    let best = Infinity;
    for (let i = 1; i < states.length; i++) { const c = this.conflictNumbers(states[i]); if (c < best) best = c; if (best === 0) break; }
    return best;
  }
}

// ------------------------------------------------------------ Environment

/** The world the agent acts in: it applies actions, reports their cost, and says what is legal. */
export class Environment {
  constructor(view) {
    this.view = view;
    this.steps = 0; // actions applied (the "states generated" of this algorithm)
  }

  /** The legal actions in s, each with its outcome: [{ a, s, c }]. */
  legal(s) { return this.view.succ(s); }

  /** Apply action a in s; null when a is illegal there (it would move nothing). */
  step(s, a) {
    this.steps++;
    for (const e of this.view.succ(s)) if (e.a === a) return e;
    return null;
  }

  /**
   * Replay a sequence from the start state. Stops at the first goal state (the rest of the
   * sequence is not needed and is not paid for) and at the first illegal action.
   * @returns {{legal: boolean, failedAt: number, used: number, cost: number, end: number, goal: boolean, states: number[], costs: number[]}}
   */
  replay(problem, genes) {
    let s = problem.start;
    let cost = 0;
    const states = [s];
    const costs = [];
    for (let i = 0; i < genes.length; i++) {
      if (problem.isGoal(s)) break;
      const e = this.step(s, genes[i]);
      if (!e) return { legal: false, failedAt: i, used: i, cost, end: s, goal: false, states, costs };
      s = e.s;
      cost += e.c;
      states.push(s);
      costs.push(e.c);
    }
    return { legal: true, failedAt: -1, used: states.length - 1, cost, end: s, goal: problem.isGoal(s), states, costs };
  }
}

// ---------------------------------------------- step 3: Path_Goal_Test

/** Successful_Path_Test / Path_Goal_Test: does the sequence reach the goal (true) or not (false)? */
export function successfulPath(problem, env, genes) {
  return env.replay(problem, genes).goal;
}
export const successfulPathTest = successfulPath;
export const pathGoalTest = successfulPath;

/** Conflict number of a sequence: the smallest value seen while executing it (or its end value). */
export function conflictNumber(problem, env, genes) {
  const r = env.replay(problem, genes);
  return r.legal ? problem.pathConflicts(r.states) : NaN;
}

// ------------------------------------------------------- step 5: Fitness

/** The increasing functions f and g of the brief's general form. */
export const TRANSFORMS = Object.freeze({
  linear: { name: 'x', fn: (x) => x },
  sqrt: { name: '√x', fn: (x) => Math.sqrt(x) },
  log: { name: 'ln(1 + x)', fn: (x) => Math.log1p(x) },
});

/**
 * fitness forms. All are 0 for a sequence with an illegal action; at the goal the conflict term
 * vanishes and `graded` and `strict` both give large_number − w2·g(path_cost).
 *
 *   graded  large_number − w1·f(conflict_number) − w2·g(path_cost)   (default; the brief's general form)
 *   strict  large_number − w2·g(path_cost) if the goal is reached, otherwise 0   (the literal reading)
 *   ratio   large_number ÷ (1 + w1·f(conflict_number) + w2·g(path_cost))        (division, for comparison)
 *
 * The functions take the already weighted and transformed terms.
 */
export const FITNESS = Object.freeze({
  graded: {
    name: 'large − w₁·f(conflicts) − w₂·g(cost)',
    note: 'The brief’s general form. Cost so far plus a pessimistic estimate of what is left, subtracted from a constant: an unfinished path never beats its own best completion, and partial paths are still ranked, so the population has a slope to climb.',
    fn: (L, conflictTerm, costTerm, goal) => Math.max(0, L - conflictTerm - costTerm),
  },
  strict: {
    name: 'large − w₂·g(cost), only at the goal',
    note: 'Zero unless the path reaches the goal. Every path that does not finish looks the same, so selection is blind among them; it works here only because random legal walks reach the goal often.',
    fn: (L, conflictTerm, costTerm, goal) => (goal ? Math.max(0, L - costTerm) : 0),
  },
  ratio: {
    name: 'large ÷ (1 + w₁·f(conflicts) + w₂·g(cost))',
    note: 'Division instead of subtraction: the same ranking with the differences between good and bad paths compressed. Measured as good as the default once the wheel subtracts the worst fitness first.',
    fn: (L, conflictTerm, costTerm, goal) => L / (1 + conflictTerm + costTerm),
  },
});

/** Fitness weights and transforms, with the brief's names: w1, f, w2, g. */
export const FITNESS_DEFAULTS = Object.freeze({ fitness: 'graded', conflictTransform: 'linear', costWeight: 1, costTransform: 'linear' });

/** The fitness of an evaluated sequence from its parts. `p` carries the form, w2 and the transforms; w1 is the problem's conflict weight. */
export function fitnessValue(problem, p, { legal, goal, cost, conflicts }) {
  if (!legal) return 0;
  const f = TRANSFORMS[p.conflictTransform || 'linear'].fn;
  const g = TRANSFORMS[p.costTransform || 'linear'].fn;
  const conflictTerm = problem.conflictWeight * f(conflicts);
  const costTerm = (p.costWeight ?? 1) * g(cost);
  return FITNESS[p.fitness || 'graded'].fn(problem.largeNumber, conflictTerm, costTerm, goal);
}

/** fitness(sequence): replay, then score. */
export function fitness(problem, env, genes, form = 'graded', opts = {}) {
  const r = env.replay(problem, genes);
  const p = { ...FITNESS_DEFAULTS, ...opts, fitness: form };
  return fitnessValue(problem, p, { legal: r.legal, goal: r.goal, cost: r.cost, conflicts: r.legal ? problem.pathConflicts(r.states) : NaN });
}

// ----------------------------------------------------- step 7: Selection

/**
 * Turn fitness into a probability and draw n individuals (with repetition): the mating pool. The
 * list comes back sorted by fitness, best first.
 *
 *   roulette    p_i = f_i / Σ f          the textbook formula; with large_number in every f_i the
 *                                        probabilities are nearly equal, so the pressure is weak
 *   windowed    p_i ∝ f_i − f_min + 1    the same wheel after subtracting the worst fitness, so the
 *                                        constant cancels and the differences in cost show
 *   rank        p_i ∝ N − rank_i         linear ranking: depends only on the order
 *   tournament  best of 3 random picks   no explicit probabilities; kept for comparison
 */
export const SELECTION = Object.freeze({
  roulette: { name: 'Roulette on f', formula: 'pᵢ = fᵢ / Σf' },
  windowed: { name: 'Roulette on f − f_min', formula: 'pᵢ = (fᵢ − f_min + 1) / Σ(fⱼ − f_min + 1)' },
  rank: { name: 'Linear ranking', formula: 'pᵢ = (N − rankᵢ) / Σ(N − rankⱼ)' },
  tournament: { name: 'Tournament of 3', formula: 'best of 3 uniform picks' },
});

/** The selection probability of every individual (population sorted or not), as an array. */
export function selectionProbabilities(population, method = 'windowed') {
  const n = population.length;
  const f = population.map((x) => x.fitness);
  let w;
  if (method === 'rank') {
    const order = population.map((x, i) => i).sort((a, b) => f[b] - f[a]);
    w = new Array(n);
    order.forEach((i, rank) => { w[i] = n - rank; });
  } else if (method === 'windowed') {
    const min = Math.min(...f);
    w = f.map((v) => v - min + 1);
  } else if (method === 'tournament') {
    // not a wheel: the chance that the individual of rank r is the best of 3 uniform picks
    const order = population.map((x, i) => i).sort((a, b) => f[b] - f[a]);
    w = new Array(n);
    order.forEach((i, rank) => { const k = n - rank; w[i] = (k ** 3 - (k - 1) ** 3) / n ** 3; });
  } else {
    w = f.slice();
  }
  const total = w.reduce((s, v) => s + v, 0);
  return total > 0 ? w.map((v) => v / total) : w.map(() => 1 / n);
}

export function selection(population, n, method = 'windowed', rng = Math.random) {
  const picked = [];
  if (method === 'tournament') {
    for (let k = 0; k < n; k++) {
      let best = population[Math.floor(rng() * population.length)];
      for (let t = 1; t < 3; t++) {
        const c = population[Math.floor(rng() * population.length)];
        if (c.fitness > best.fitness) best = c;
      }
      picked.push(best);
    }
  } else {
    const p = selectionProbabilities(population, method);
    const cumulative = [];
    let acc = 0;
    for (const v of p) { acc += v; cumulative.push(acc); }
    for (let k = 0; k < n; k++) {
      const x = rng() * acc;
      let i = 0;
      while (i < cumulative.length - 1 && cumulative[i] < x) i++;
      picked.push(population[i]);
    }
  }
  return picked.sort((a, b) => b.fitness - a.fitness);
}

// --------------------------------------------------- step 6: the algorithm

/** What happens to a sequence that an operator has made illegal. */
export const ILLEGAL = Object.freeze({
  repair: { name: 'Repair', note: 'The first illegal action is replaced by a random legal one and the replay continues; every individual stays legal.' },
  retry: { name: 'Lethal: retry the operator', note: 'The brief’s lethal mutation: an illegal child is discarded and the operator is drawn again (up to 20 times); if none is legal the parent is kept, so the population size stays constant.' },
  zero: { name: 'Keep with fitness 0', note: 'The illegal child stays in the population with fitness 0 (random action ids throughout; the baseline that shows why legality matters).' },
});

export const CROSSOVERS = Object.freeze({
  single: { name: 'Single-point', note: 'Child 1 = prefix of A + suffix of B, child 2 = prefix of B + suffix of A, with independent cut points because the parents differ in length.' },
  double: { name: 'Double-point', note: 'Two cut points in each parent; the middle segments are exchanged.' },
});

/** Mutation kinds. The first three are the brief's; the other three change the length of the sequence. */
export const MUTATIONS = Object.freeze({
  point: { name: 'Replace an action', brief: true, note: 'One position gets another action (a legal one at that point when repairing).' },
  swap: { name: 'Swap two actions', brief: true, note: 'Two positions exchange their actions.' },
  reverse: { name: 'Reverse a segment', brief: true, note: 'The actions between two positions are reversed.' },
  insert: { name: 'Insert an action', brief: false, note: 'A legal action is inserted; the sequence grows by one.' },
  delete: { name: 'Delete an action', brief: false, note: 'One action is removed; the sequence shrinks by one.' },
  regrow: { name: 'Cut and regrow', brief: false, note: 'The sequence is cut and continued with a fresh random legal walk: the large jump out of a local optimum.' },
});
export const MUTATION_SETS = Object.freeze({
  all: Object.keys(MUTATIONS),
  brief: Object.keys(MUTATIONS).filter((k) => MUTATIONS[k].brief),
});

export const DEFAULTS = Object.freeze({
  population: 60,
  generations: 150,
  maxLength: null, // 4 per row
  crossoverRate: 0.9,
  mutationRate: 0.3,
  elite: 2,
  stagnation: 50,
  seed: 1,
  selection: 'windowed',
  fitness: 'graded',
  conflicts: 'gates',
  conflictWeight: null, // per conflict kind
  conflictMode: 'min',
  conflictTransform: 'linear',
  costWeight: 1,
  costTransform: 'linear',
  illegal: 'repair',
  crossover: 'single',
  mutations: 'all',
});

/** Accept the first version's `repair: true/false` as `illegal: 'repair' / 'zero'`. */
export function normalizeParams(params = {}) {
  const p = { ...DEFAULTS, ...params };
  if (params.illegal === undefined && params.repair !== undefined) p.illegal = params.repair ? 'repair' : 'zero';
  delete p.repair;
  if (typeof p.mutations === 'string') p.mutations = MUTATION_SETS[p.mutations] || MUTATION_SETS.all;
  for (const [k, table] of [['selection', SELECTION], ['fitness', FITNESS], ['conflicts', CONFLICTS], ['conflictMode', CONFLICT_MODES], ['illegal', ILLEGAL], ['crossover', CROSSOVERS], ['conflictTransform', TRANSFORMS], ['costTransform', TRANSFORMS]]) {
    if (!table[p[k]]) throw new RangeError(`unknown ${k}: ${p[k]}`);
  }
  for (const k of p.mutations) if (!MUTATIONS[k]) throw new RangeError(`unknown mutation: ${k}`);
  return p;
}

/**
 * The genetic algorithm. An individual is { genes: action ids, fitness, cost, conflicts, goal,
 * legal }. The agent only talks to the problem through the Environment.
 */
export class SolverAgent {
  constructor(problem, env, params = {}) {
    this.problem = problem;
    this.env = env;
    this.p = normalizeParams(params);
    this.rng = seededRng(this.p.seed >>> 0);
    this.evaluations = 0;
    this.retries = 0; // operators drawn again in the "retry" mode
  }

  /** Uniform random pick from an array. */
  #pick(list) { return list[Math.floor(this.rng() * list.length)]; }
  #randomAction() { return Math.floor(this.rng() * this.problem.actions.length); }

  /**
   * Walk a sequence through the environment and turn it into an evaluated individual: it is cut
   * at the first goal state and at the length bound. With `repair`, an illegal action is replaced
   * by a random legal one at that point and the walk continues; otherwise the illegal action stays,
   * the individual is marked illegal and its fitness is 0.
   */
  build(genes, repair = this.p.illegal === 'repair') {
    const { problem, env } = this;
    const out = [];
    const states = [problem.start];
    let s = problem.start;
    let cost = 0;
    let legal = true;
    this.evaluations++;
    for (let i = 0; i < genes.length && out.length < problem.maxLength; i++) {
      if (problem.isGoal(s)) break;
      let e = env.step(s, genes[i]);
      if (!e) {
        if (!repair) { legal = false; out.push(...genes.slice(i, problem.maxLength)); break; }
        const options = env.legal(s);
        if (!options.length) break; // stuck: nothing can move (only possible with water or concrete)
        e = this.#pick(options);
      }
      out.push(e.a);
      cost += e.c;
      s = e.s;
      states.push(s);
    }
    const goal = legal && problem.isGoal(s);
    const conflicts = legal ? problem.pathConflicts(states) : NaN;
    const fit = fitnessValue(problem, this.p, { legal, goal, cost, conflicts });
    return { genes: out, fitness: fit, cost, conflicts, endConflicts: legal ? problem.conflictNumbers(s) : NaN, goal, legal, end: s };
  }

  /** A random legal walk of the full length (cut at the goal), from a given state and prefix. */
  #walk(prefix, from, length) {
    const genes = prefix.slice();
    let s = from;
    while (genes.length < length && !this.problem.isGoal(s)) {
      const options = this.env.legal(s);
      if (!options.length) break;
      const e = this.#pick(options);
      genes.push(e.a);
      s = e.s;
    }
    return genes;
  }

  /** The state reached after the first i actions of a legal sequence. */
  #stateAt(genes, i) {
    let s = this.problem.start;
    for (let k = 0; k < i; k++) { const e = this.env.step(s, genes[k]); if (!e) break; s = e.s; }
    return s;
  }

  /**
   * step 6.1: an individual of the initial population — a random sequence of maxLength actions.
   * Legal by construction (a random legal walk) unless illegal sequences are kept with fitness 0,
   * in which case the action ids are drawn uniformly.
   */
  randomIndividual() {
    const L = this.problem.maxLength;
    if (this.p.illegal === 'zero') {
      const genes = [];
      for (let i = 0; i < L; i++) genes.push(this.#randomAction());
      return this.build(genes);
    }
    return this.build(this.#walk([], this.problem.start, L));
  }

  successfulPath(genes) { return successfulPath(this.problem, this.env, genes); }
  fitness(genes) { return fitness(this.problem, this.env, genes, this.p.fitness, this.p); }
  select(population, n) { return selection(population, n, this.p.selection, this.rng); }

  /** Apply an operator in the "retry" mode: redraw it while the child is illegal, then fall back to a copy of the parent. */
  #withRetries(make, fallback) {
    if (this.p.illegal === 'repair') return this.build(make());
    if (this.p.illegal === 'zero') return this.build(make(), false);
    for (let t = 0; t < RETRIES; t++) {
      const child = this.build(make(), false);
      if (child.legal) return child;
      this.retries++;
    }
    return this.build(fallback.slice(), false);
  }

  /**
   * step 6.2b: crossover. Single-point: child 1 = prefix of A + suffix of B, child 2 = prefix of B
   * + suffix of A, with independent cut points because the parents differ in length. Double-point:
   * the segments between two cut points are exchanged. The new tail is replayed from the state the
   * prefix ends in and repaired (or retried, or scored 0) where it does not fit.
   */
  crossover(a, b) {
    const ga = a.genes;
    const gb = b.genes;
    if (ga.length < 1 || gb.length < 1) return [this.build(ga.slice()), this.build(gb.slice())];
    const cut = (g) => 1 + Math.floor(this.rng() * g.length); // keep at least one action of the prefix
    if (this.p.crossover === 'double' && ga.length >= 2 && gb.length >= 2) {
      const two = (g) => { const i = Math.floor(this.rng() * g.length); const j = Math.floor(this.rng() * g.length); return i <= j ? [i, j + 1] : [j, i + 1]; };
      const child1 = () => { const [i, j] = two(ga); const [k, l] = two(gb); return ga.slice(0, i).concat(gb.slice(k, l), ga.slice(j)); };
      const child2 = () => { const [i, j] = two(ga); const [k, l] = two(gb); return gb.slice(0, k).concat(ga.slice(i, j), gb.slice(l)); };
      return [this.#withRetries(child1, ga), this.#withRetries(child2, gb)];
    }
    const child1 = () => ga.slice(0, cut(ga)).concat(gb.slice(cut(gb)));
    const child2 = () => gb.slice(0, cut(gb)).concat(ga.slice(cut(ga)));
    return [this.#withRetries(child1, ga), this.#withRetries(child2, gb)];
  }

  /**
   * step 6.2a: mutation — one random edit, then the part after it is replayed and repaired (or
   * the edit is retried, or the child is kept with fitness 0):
   *   point    replace one action (by another legal action at that point, when repairing)
   *   swap     exchange two positions
   *   reverse  reverse the actions between two positions
   *   insert   insert a (legal) action           ┐
   *   delete   remove one action                 ├ our additions: they change the length
   *   regrow   cut and continue with a random legal walk ┘
   */
  mutate(ind, forcedKind = null) {
    const parent = ind.genes;
    const L = this.problem.maxLength;
    const n = parent.length;
    const possible = this.p.mutations.filter((k) => (k === 'swap' || k === 'reverse' ? n >= 2 : k === 'point' || k === 'delete' ? n >= 1 : true));
    if (!possible.length) return this.build(parent.slice());
    const kind = forcedKind && possible.includes(forcedKind) ? forcedKind : this.#pick(possible);
    const repairing = this.p.illegal === 'repair';
    const edit = () => {
      const genes = parent.slice();
      if (kind === 'point') {
        const i = Math.floor(this.rng() * n);
        if (repairing) {
          const others = this.env.legal(this.#stateAt(genes, i)).filter((e) => e.a !== genes[i]);
          if (others.length) genes[i] = this.#pick(others).a;
        } else genes[i] = this.#randomAction();
      } else if (kind === 'swap') {
        const i = Math.floor(this.rng() * n);
        let j = Math.floor(this.rng() * (n - 1));
        if (j >= i) j++;
        [genes[i], genes[j]] = [genes[j], genes[i]];
      } else if (kind === 'reverse') {
        let i = Math.floor(this.rng() * n);
        let j = Math.floor(this.rng() * n);
        if (i > j) [i, j] = [j, i];
        if (i === j) j = Math.min(n - 1, j + 1);
        const seg = genes.slice(i, j + 1).reverse();
        genes.splice(i, seg.length, ...seg);
      } else if (kind === 'insert') {
        const i = Math.floor(this.rng() * (n + 1));
        if (repairing) {
          const options = this.env.legal(this.#stateAt(genes, i));
          if (options.length) genes.splice(i, 0, this.#pick(options).a);
        } else genes.splice(i, 0, this.#randomAction());
      } else if (kind === 'delete') {
        genes.splice(Math.floor(this.rng() * n), 1);
      } else {
        const i = Math.floor(this.rng() * (n + 1));
        if (repairing) return this.#walk(genes.slice(0, i), this.#stateAt(genes, i), L);
        genes.length = i;
        while (genes.length < L) genes.push(this.#randomAction());
        return genes;
      }
      return genes.slice(0, L);
    };
    return this.#withRetries(edit, parent);
  }

  /**
   * Run the algorithm.
   * @param {(info: object, population: object[]) => void} [onGeneration]  called after every generation
   */
  run(onGeneration = null) {
    const t0 = now();
    const { p, problem } = this;
    const N = Math.max(2, p.population);
    const elite = Math.min(Math.max(0, p.elite), N - 1);
    let population = [];
    for (let i = 0; i < N; i++) population.push(this.randomIndividual());
    population.sort((a, b) => b.fitness - a.fitness);
    const history = [];
    let best = population[0]; // highest fitness ever seen (goal or not)
    let bestGeneration = 0;
    let solution = null; // the cheapest path that reaches the goal, ever seen
    let firstGoal = -1;
    let gen = 0;
    const noteGoals = () => {
      for (const x of population) {
        if (!x.goal) continue;
        if (firstGoal < 0) firstGoal = gen;
        if (!solution || x.cost < solution.cost) solution = x;
      }
    };
    noteGoals();
    const record = () => {
      let sum = 0;
      let goals = 0;
      let legal = 0;
      const seen = new Set();
      for (const x of population) { sum += x.fitness; if (x.goal) goals++; if (x.legal) legal++; seen.add(x.genes.join(',')); }
      const info = {
        gen,
        best: population[0].fitness,
        mean: sum / N,
        worst: population[N - 1].fitness,
        goalShare: goals / N,
        legalShare: legal / N,
        unique: seen.size,
        bestCost: population[0].goal ? population[0].cost : null,
        bestGenes: population[0].genes,
        bestEverCost: solution ? solution.cost : null,
        evaluations: this.evaluations,
        steps: this.env.steps,
      };
      history.push({ gen: info.gen, best: info.best, mean: info.mean, worst: info.worst, goalShare: info.goalShare, legalShare: info.legalShare, unique: info.unique, bestCost: info.bestCost });
      if (onGeneration) onGeneration(info, population);
    };
    record();
    for (gen = 1; gen <= p.generations; gen++) {
      if (p.stagnation > 0 && gen - bestGeneration > p.stagnation) break;
      // step 7: the mating pool, as large as the population minus the elites, sorted by fitness
      const parents = this.select(population, N - elite);
      // mate in random pairs (i, i+1): mating the sorted list in order would always pair the best with the best
      for (let i = parents.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [parents[i], parents[j]] = [parents[j], parents[i]]; }
      const children = [];
      for (let i = 0; i < parents.length; i += 2) {
        const a = parents[i];
        const b = parents[(i + 1) % parents.length];
        let pair;
        if (this.rng() < p.crossoverRate) pair = this.crossover(a, b);
        else pair = [this.build(a.genes.slice()), this.build(b.genes.slice())];
        for (const child of pair) {
          if (children.length >= parents.length) break;
          children.push(this.rng() < p.mutationRate ? this.mutate(child) : child);
        }
      }
      population = population.slice(0, elite).concat(children);
      population.sort((a, b) => b.fitness - a.fitness);
      if (population[0].fitness > best.fitness) { best = population[0]; bestGeneration = gen; }
      noteGoals();
      record();
    }
    const generations = history.length - 1;
    // the result in the shape every other algorithm returns: the cheapest goal path found
    const replay = solution ? this.env.replay(problem, solution.genes) : null;
    const path = solution ? replay.states.slice(1).map((s, i) => ({ a: solution.genes[i], s, c: replay.costs[i] })) : [];
    const slim = (x) => ({ genes: x.genes, fitness: x.fitness, cost: x.cost, conflicts: x.conflicts, goal: x.goal, legal: x.legal });
    return {
      found: !!solution,
      aborted: false,
      cost: solution ? solution.cost : Infinity,
      path,
      expanded: this.evaluations,
      generated: this.env.steps,
      maxFrontier: N,
      maxMemory: 2 * N,
      iterations: generations,
      timeMs: now() - t0,
      ga: {
        generations,
        firstGoalGeneration: firstGoal,
        bestGeneration,
        largeNumber: problem.largeNumber,
        maxLength: problem.maxLength,
        retries: this.retries,
        best: slim(best), // the fittest sequence ever seen; its cost is GA_Path_cost when no goal path was found
        solution: solution ? slim(solution) : null,
        history,
        population: population.slice(0, 12).map(slim),
        params: { ...p },
      },
    };
  }
}

/**
 * Entry point used by search.js: build the three objects from a problem view and run. Options are
 * the parameters above (o.ga or top level); the seed is mixed with the start state so that every
 * instance gets its own, reproducible random sequence.
 */
export function geneticSearch(view, o = {}) {
  const params = normalizeParams({ ...(o.ga || {}), ...pickParams(o) });
  const seedMix = (Math.imul(params.seed | 0, 0x9e3779b1) ^ Number(view.start % 4294967296)) >>> 0;
  const problem = new Problem(view, { maxLength: params.maxLength, largeNumber: params.largeNumber ?? null, conflicts: params.conflicts, conflictWeight: params.conflictWeight, conflictMode: params.conflictMode });
  const env = new Environment(view);
  return new SolverAgent(problem, env, { ...params, seed: seedMix }).run(o.onGeneration || null);
}

function pickParams(o) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) if (o[k] !== undefined) out[k] = o[k];
  if (o.repair !== undefined) out.repair = o.repair;
  if (o.largeNumber !== undefined) out.largeNumber = o.largeNumber;
  return out;
}
