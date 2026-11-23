// Genetic algorithm over action sequences — the third assignment.
//
// The brief asks for three classes (Problem, Environment, SolverAgent), for individuals that are
// sequences of actions from the start state with a fixed maximum length, and for the functions
// successful_path, fitness (with the variables large_number, conflict_numbers and path_cost),
// mutation, crossover and selection. They are all here, on top of the same problem interface the
// other algorithms use (see search.js), so the genetic algorithm can be compared with them on the
// same instances:
//
//   view.start        encoded start state
//   view.isGoal(s)    goal test
//   view.succ(s)      legal actions from s: [{ a, s: next, c: cost }]  (an action that is not in
//                     the list is illegal in s: it would not move anything)
//   view.h(s)         heuristic estimate of the remaining cost, used as conflict_numbers
//   view.actions      the action list of the model

import { seededRng, MAT, SAND, LEVEL } from './model.js';
import { HEURISTICS } from './heuristics.js';
import { search } from './search.js'; // only called inside functions, so the import cycle is harmless

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The most a single action can cost on a sand-only grid: 1 + 4·(1 + 1). */
const MAX_STEP_COST = 9;

/** The full { cells, gates } state behind an encoded state, whichever problem view we are given. */
function stateOf(view, s) {
  if (view.state) return view.state(s);
  return { cells: view.cells(s), gates: 0 };
}

/**
 * conflict_numbers: ways of estimating how far a state is from the goal. Each is a count or a
 * cost estimate; the fitness multiplies it by a weight (`conflictWeight`, default per kind) so
 * that the penalty for stopping short of the goal is at least the cost of finishing — otherwise
 * the fittest path is the one that does nothing (see the design notes).
 */
export const CONFLICTS = Object.freeze({
  gates: {
    name: 'Closed gates with sand above them',
    short: 'gates',
    weight: MAX_STEP_COST,
    note: 'The gates that still have to be opened (h₂ ÷ 3), each weighted by the largest possible action cost, 9. On every reachable 5×2 state 9 × gates ≥ h*, so finishing a path always pays.',
    fn: (view, s) => HEURISTICS.gap.fn(view.model, stateOf(view, s)) / 3,
  },
  sand: {
    name: 'Half-units of sand left',
    short: 'sand',
    weight: MAX_STEP_COST,
    note: 'The naive conflict count: how much sand is still in the grid, weighted by 9. Unlike the gates it does not see how deep the sand sits, so it can be far below h*.',
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

// ---------------------------------------------------------------- Problem

/**
 * What has to be solved: the start state, the goal test, the actions, the length bound of a path
 * and the estimate of the distance to the goal (conflict_numbers).
 */
export class Problem {
  /**
   * @param {object} view  problem interface (see above); `model` and `state(s)` are used by the conflict functions
   * @param {{maxLength?: number, largeNumber?: number, conflicts?: string, conflictWeight?: number}} [opts]
   */
  constructor(view, { maxLength = 20, largeNumber = null, conflicts = 'gates', conflictWeight = null } = {}) {
    if (!CONFLICTS[conflicts]) throw new RangeError(`unknown conflict function: ${conflicts}`);
    this.view = view;
    this.start = view.start;
    this.actions = view.actions;
    this.maxLength = maxLength;
    this.conflicts = conflicts;
    this.conflictWeight = conflictWeight ?? CONFLICTS[conflicts].weight;
    const size = (view.actions.length / 3) * 2;
    const cells = view.cells ? view.cells(view.start) : null;
    const wet = cells ? Array.prototype.some.call(cells, (c) => c >= 3) : false; // water or concrete present
    /** Upper bound on the cost of one action: with water, every box could set into concrete. */
    this.maxStepCost = MAX_STEP_COST + (wet && view.model ? view.model.concretePenalty * size : 0);
    /**
     * large_number: derived, not hand-picked. A legal path has at most maxLength actions of at most
     * maxStepCost each, and the weighted conflict estimate of its last state is a cost estimate
     * too, bounded the same way; with this constant the fitness of every legal path is positive.
     */
    this.largeNumber = largeNumber ?? 2 * maxLength * this.maxStepCost + 1;
  }

  isGoal(s) { return this.view.isGoal(s); }

  /** conflict_numbers of state s (unweighted; 0 exactly in the goal states). */
  conflictNumbers(s) { return this.view.isGoal(s) ? 0 : CONFLICTS[this.conflicts].fn(this.view, s); }
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

// ------------------------------------------------- the functions of the brief

/** successful_path: does the sequence reach the goal (true) or not (false)? */
export function successfulPath(problem, env, genes) {
  return env.replay(problem, genes).goal;
}

/**
 * fitness: a number per path. Three forms are implemented; all of them are 0 for a sequence with
 * an illegal action, and all of them equal large_number − path_cost on a path that reaches the
 * goal (there conflict_numbers = 0).
 *
 *   graded  large_number − conflict_numbers − path_cost     (default; see the design notes)
 *   strict  large_number − path_cost if the goal is reached, otherwise 0
 *   ratio   large_number / (1 + conflict_numbers + path_cost)
 */
export const FITNESS = Object.freeze({
  graded: {
    name: 'large − conflicts − cost',
    note: 'The cost so far plus a pessimistic estimate of what is left, subtracted from a constant: an unfinished path never beats its own best completion, and partial paths are still ranked, so the population has a slope to climb.',
    fn: (L, conflicts, cost, goal) => Math.max(0, L - conflicts - cost),
  },
  strict: {
    name: 'large − cost, only at the goal',
    note: 'The literal reading: 0 unless the path reaches the goal. Every path that does not finish looks the same, so selection is blind until the first solution appears by chance.',
    fn: (L, conflicts, cost, goal) => (goal ? L - cost : 0),
  },
  ratio: {
    name: 'large ÷ (1 + conflicts + cost)',
    note: 'Division instead of subtraction: the same ranking with the differences between good and bad paths compressed. Measured as good as the default once the wheel subtracts the worst fitness first.',
    fn: (L, conflicts, cost, goal) => L / (1 + conflicts + cost),
  },
});

export function fitness(problem, env, genes, variant = 'graded') {
  const r = env.replay(problem, genes);
  if (!r.legal) return 0;
  return FITNESS[variant].fn(problem.largeNumber, problem.conflictWeight * problem.conflictNumbers(r.end), r.cost, r.goal);
}

/**
 * selection: turn fitness into a probability and draw n individuals (with repetition). The list
 * comes back sorted by fitness, best first.
 *
 *   roulette    p_i = f_i / Σ f          the textbook formula; with large_number in every f_i the
 *                                        probabilities are nearly equal, so the pressure is weak
 *   windowed    p_i ∝ f_i − f_min + 1    the same wheel after subtracting the worst fitness, so the
 *                                        constant cancels and the differences in cost show
 *   rank        p_i ∝ N − rank_i         linear ranking: depends only on the order
 *   tournament  best of 3 random picks   no probabilities at all; kept for comparison
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

// ------------------------------------------------------------- SolverAgent

export const DEFAULTS = Object.freeze({
  population: 60,
  generations: 150,
  maxLength: 20,
  crossoverRate: 0.9,
  mutationRate: 0.3,
  elite: 2,
  selection: 'windowed',
  fitness: 'graded',
  conflicts: 'gates',
  conflictWeight: null,
  repair: true,
  stagnation: 50,
  seed: 1,
});

/**
 * The genetic algorithm. An individual is { genes: action ids, fitness, cost, conflicts, goal,
 * legal }. The agent only talks to the problem through the Environment.
 */
export class SolverAgent {
  constructor(problem, env, params = {}) {
    this.problem = problem;
    this.env = env;
    this.p = { ...DEFAULTS, ...params };
    this.rng = seededRng(this.p.seed >>> 0);
    this.evaluations = 0;
  }

  /** Uniform random pick from an array. */
  #pick(list) { return list[Math.floor(this.rng() * list.length)]; }

  /**
   * Walk a sequence through the environment and turn it into an evaluated individual: it is cut
   * at the first goal state and at the length bound; with `repair` on, an illegal action is
   * replaced by a random legal one at that point (so every individual stays legal), otherwise the
   * illegal action stays and the fitness is 0.
   */
  build(genes) {
    const { problem, env } = this;
    const out = [];
    let s = problem.start;
    let cost = 0;
    let legal = true;
    this.evaluations++;
    for (let i = 0; i < genes.length && out.length < problem.maxLength; i++) {
      if (problem.isGoal(s)) break;
      let e = env.step(s, genes[i]);
      if (!e) {
        if (!this.p.repair) { legal = false; out.push(...genes.slice(i, problem.maxLength)); break; }
        const options = env.legal(s);
        if (!options.length) break; // stuck: nothing can move (only possible with water or concrete)
        e = this.#pick(options);
      }
      out.push(e.a);
      cost += e.c;
      s = e.s;
    }
    const goal = legal && problem.isGoal(s);
    const conflicts = legal ? problem.conflictNumbers(s) : NaN;
    const fit = legal ? FITNESS[this.p.fitness].fn(problem.largeNumber, problem.conflictWeight * conflicts, cost, goal) : 0;
    return { genes: out, fitness: fit, cost, conflicts, goal, legal, end: s };
  }

  /** A random individual: a random legal walk of random length (or random action ids without repair). */
  randomIndividual() {
    const L = this.problem.maxLength;
    const target = 1 + Math.floor(this.rng() * L);
    const genes = [];
    if (!this.p.repair) {
      for (let i = 0; i < target; i++) genes.push(Math.floor(this.rng() * this.problem.actions.length));
      return this.build(genes);
    }
    let s = this.problem.start;
    while (genes.length < target && !this.problem.isGoal(s)) {
      const options = this.env.legal(s);
      if (!options.length) break;
      const e = this.#pick(options);
      genes.push(e.a);
      s = e.s;
    }
    return this.build(genes);
  }

  successfulPath(genes) { return successfulPath(this.problem, this.env, genes); }
  fitness(genes) { return fitness(this.problem, this.env, genes, this.p.fitness); }
  select(population, n) { return selection(population, n, this.p.selection, this.rng); }

  /**
   * crossover: one-point on both parents (independent cut points, because paths differ in length):
   * child 1 = head of A + tail of B, child 2 = head of B + tail of A. The tail is replayed from the
   * state the head ends in, and repaired where it does not fit (see build).
   */
  crossover(a, b) {
    const ga = a.genes;
    const gb = b.genes;
    if (ga.length < 1 || gb.length < 1) return [this.build(ga.slice()), this.build(gb.slice())];
    const cutA = 1 + Math.floor(this.rng() * ga.length); // keep at least one gene of the head
    const cutB = 1 + Math.floor(this.rng() * gb.length);
    return [this.build(ga.slice(0, cutA).concat(gb.slice(cutB))), this.build(gb.slice(0, cutB).concat(ga.slice(cutA)))];
  }

  /**
   * mutation: one random edit of the sequence, then repair of what follows:
   *   point    replace one action by another legal action at that point
   *   insert   insert a legal action
   *   delete   remove one action
   *   regrow   cut the sequence and continue it with a fresh random legal walk
   * The first three are the edit-distance moves on sequences (small steps); regrow is the large
   * step that lets the population leave a local optimum.
   */
  mutate(ind, forcedKind = null) {
    const genes = ind.genes.slice();
    const L = this.problem.maxLength;
    const kinds = genes.length ? ['point', 'insert', 'delete', 'regrow'] : ['insert', 'regrow'];
    const kind = forcedKind && kinds.includes(forcedKind) ? forcedKind : this.#pick(kinds);
    const i = Math.floor(this.rng() * (genes.length + (kind === 'insert' || kind === 'regrow' ? 1 : 0)));
    if (!this.p.repair) {
      const randomAction = () => Math.floor(this.rng() * this.problem.actions.length);
      if (kind === 'point') genes[i] = randomAction();
      else if (kind === 'insert') genes.splice(i, 0, randomAction());
      else if (kind === 'delete') genes.splice(i, 1);
      else { genes.length = i; while (genes.length < L && this.rng() < 0.8) genes.push(randomAction()); }
      return this.build(genes.slice(0, L));
    }
    // the state reached before position i
    let s = this.problem.start;
    for (let k = 0; k < i; k++) { const e = this.env.step(s, genes[k]); if (!e) break; s = e.s; }
    const options = this.env.legal(s);
    if (kind === 'point') {
      const others = options.filter((e) => e.a !== genes[i]);
      if (others.length) genes[i] = this.#pick(others).a;
    } else if (kind === 'insert') {
      if (options.length) genes.splice(i, 0, this.#pick(options).a);
    } else if (kind === 'delete') {
      genes.splice(i, 1);
    } else {
      genes.length = i;
      const target = i + 1 + Math.floor(this.rng() * Math.max(1, L - i));
      let cur = s;
      while (genes.length < target && !this.problem.isGoal(cur)) {
        const opts = this.env.legal(cur);
        if (!opts.length) break;
        const e = this.#pick(opts);
        genes.push(e.a);
        cur = e.s;
      }
    }
    return this.build(genes.slice(0, L));
  }

  /**
   * Run the algorithm.
   * @param {(info: object) => void} [onGeneration]  called after every generation with its statistics
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
      const seen = new Set();
      for (const x of population) { sum += x.fitness; if (x.goal) goals++; seen.add(x.genes.join(',')); }
      const info = {
        gen,
        best: population[0].fitness,
        mean: sum / N,
        worst: population[N - 1].fitness,
        goalShare: goals / N,
        unique: seen.size,
        bestCost: population[0].goal ? population[0].cost : null,
        bestGenes: population[0].genes,
        bestEverCost: solution ? solution.cost : null,
        evaluations: this.evaluations,
        steps: this.env.steps,
      };
      history.push({ gen: info.gen, best: info.best, mean: info.mean, worst: info.worst, goalShare: info.goalShare, unique: info.unique, bestCost: info.bestCost });
      if (onGeneration) onGeneration(info, population);
    };
    record();
    for (gen = 1; gen <= p.generations; gen++) {
      if (p.stagnation > 0 && gen - bestGeneration > p.stagnation) break;
      const parents = this.select(population, N - elite);
      // mate in random pairs (the selected list is sorted for display, mating adjacent entries
      // would always pair the best with the best)
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
        best: { genes: best.genes, fitness: best.fitness, cost: best.cost, conflicts: best.conflicts, goal: best.goal },
        solution: solution ? { genes: solution.genes, fitness: solution.fitness, cost: solution.cost } : null,
        history,
        population: population.slice(0, 12).map((x) => ({ genes: x.genes, fitness: x.fitness, cost: x.cost, conflicts: x.conflicts, goal: x.goal, legal: x.legal })),
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
  const params = { ...DEFAULTS, ...(o.ga || {}), ...pickParams(o) };
  const seedMix = (Math.imul(params.seed | 0, 0x9e3779b1) ^ Number(view.start % 4294967296)) >>> 0;
  const problem = new Problem(view, { maxLength: params.maxLength, largeNumber: params.largeNumber ?? null, conflicts: params.conflicts, conflictWeight: params.conflictWeight });
  const env = new Environment(view);
  return new SolverAgent(problem, env, { ...params, seed: seedMix }).run(o.onGeneration || null);
}

function pickParams(o) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) if (o[k] !== undefined) out[k] = o[k];
  if (o.largeNumber !== undefined) out.largeNumber = o.largeNumber;
  return out;
}
