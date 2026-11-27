// Run with: npm test   (Node's built-in test runner, no dependencies)

import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox, parseGrid, formatGrid, formatState, PROFESSOR_EXAMPLE, CONCRETE, SAND_HALF, WATER_HALF, EMPTY, seededRng } from '../js/core/model.js';
import { search, ALGORITHMS } from '../js/core/search.js';
import { makeProblem } from '../js/core/problem.js';
import { HEURISTICS } from '../js/core/heuristics.js';
import { buildGraph, solveGraph, analyze, effectiveBranchingFactor } from '../js/core/analysis.js';
import { features, FEATURE_NAMES } from '../js/core/features.js';
import { LEARNED } from '../js/core/learned.js';

/** Play a plan written as "S2 L1 R4": side gate of row 2, gate under row 1 left, under row 4 right. */
function play(model, cells, plan) {
  let state = cells.cells ? cells : model.initial(cells);
  const costs = [];
  for (const tok of plan.split(' ')) {
    const row = Number(tok.slice(1)) - 1;
    const id = tok[0] === 'S' ? model.sideAction(row) : model.verticalAction(tok[0] === 'L' ? 0 : 1, row);
    const r = model.apply(state, id);
    if (!r) return { costs, state, stuckAt: tok };
    state = r.state;
    costs.push(r.cost);
  }
  return { costs, state, total: costs.reduce((a, b) => a + b, 0), goal: model.isGoal(state) };
}

/** Replay a path of {a, c} entries and check it reaches the goal with the given total cost. */
function replay(model, cells, path) {
  let state = model.initial(cells);
  let total = 0;
  for (const e of path) {
    const r = model.apply(state, e.a);
    assert.ok(r, `action ${model.actions[e.a].label} should be applicable`);
    assert.equal(r.cost, e.c);
    state = r.state;
    total += r.cost;
  }
  return { state, total };
}

const solve = (model, cells, algo, h = 'gap') => search(algo, makeProblem(model, cells, h));

test('grid text round-trips, states encode and decode', () => {
  const text = '1 0\n½ W\nw #';
  assert.equal(formatGrid(parseGrid(text)), text);
  const m = new Sandbox({ rows: 3 });
  const state = { cells: parseGrid(text), gates: 0b100101 };
  const back = m.decode(m.encode(state));
  assert.deepEqual(back.cells, state.cells);
  assert.equal(back.gates, state.gates);
});

test('side gate only levels a full box with an empty one, and closes again', () => {
  const m = new Sandbox({ rows: 1 });
  const r = m.apply(m.initial(parseGrid('1 0')), m.sideAction(0));
  assert.equal(formatGrid(r.state.cells), '½ ½');
  assert.equal(r.cost, 1);
  assert.equal(r.state.gates, 0);
  assert.equal(formatGrid(m.apply(m.initial(parseGrid('0 1')), m.sideAction(0)).state.cells), '½ ½');
  for (const g of ['1 ½', '½ 0', '½ ½', '1 1', '0 0']) assert.equal(m.apply(m.initial(parseGrid(g)), m.sideAction(0)), null, g);
});

test('top-down gates are spring loaded: they open on sand and stay open while sand is above them', () => {
  const m = new Sandbox({ rows: 3 });
  const L = (r) => m.verticalAction(0, r - 1);
  const show = (grid, plan) => { const p = play(m, parseGrid(grid), plan); return `${formatState(m, p.state).replaceAll('\n', ' ')} cost ${p.costs.join('+')}`; };
  // sand falls, the gate stays open because the box above still holds sand: s = 1, s' = 1/2
  assert.equal(show('1 0/½ 0/0 0', 'L1'), '½ 0 - _ 1 0 _ _ 0 0 _ _ cost 7');
  // the box above empties: the gate closes again
  assert.equal(show('1 0/0 0/0 0', 'L1'), '0 0 _ _ 1 0 _ _ 0 0 _ _ cost 5');
  // opening a gate between two full boxes is allowed: nothing moves yet, the gate stays open (cost 9)
  assert.equal(show('1 0/1 0/0 0', 'L1'), '1 0 - _ 1 0 _ _ 0 0 _ _ cost 9');
  // ... and the pile follows later through it in one go: outlet s = 1, s' = 0 drains both boxes
  assert.equal(show('0 0/1 0/1 0', 'L2 L3'), '0 0 _ _ 0 0 _ _ 0 0 _ _ cost 9+5');
  // an open gate is not an action; an empty box has nothing to open
  assert.equal(play(m, parseGrid('1 0/1 0/0 0'), 'L1 L1').stuckAt, 'L1');
  assert.equal(m.apply(m.initial(parseGrid('0 0/1 0/0 0')), L(1)), null);
  // the teacher's step: a gate opened under a half box over a full box moves nothing (cost 5) but
  // stays open; when the full box then pours half into the half box below, the half box above
  // flows in through the open gate at the same moment (s = 1, s' = 1, cost 9)
  assert.equal(show('½ 0/1 0/½ 0', 'L1 L2'), '0 0 _ _ 1 0 - _ 1 0 _ _ cost 5+9');
});

test("the assignment's three plans cost 47, 45 and 46, as printed", () => {
  const m = new Sandbox({ rows: 4 });
  const ex = parseGrid(PROFESSOR_EXAMPLE);
  const greedy = play(m, ex, 'L1 L2 L3 L4 R2 R3 R4');
  assert.deepEqual(greedy.costs, [5, 5, 9, 5, 9, 9, 5]);
  assert.ok(greedy.goal);
  const sides = play(m, ex, 'S2 S3 L1 L2 L3 L4 R2 R3 R4');
  assert.deepEqual(sides.costs, [1, 1, 7, 9, 9, 5, 3, 5, 5]);
  assert.equal(sides.total, 45);
  assert.ok(sides.goal);
  const other = play(m, ex, 'S2 S3 L2 L1 L2 L3 L4 R2 R3 R4');
  assert.deepEqual(other.costs, [1, 1, 3, 5, 9, 9, 5, 3, 5, 5]);
  assert.equal(other.total, 46);
  assert.ok(other.goal);
});

test('the side-gate plan matches the state-by-state trace on the 5x2 grid, gates included', () => {
  const m = new Sandbox({ rows: 5 });
  const trace = [
    ['0 0/_ _/1 0/_ _/0 1/_ _/0 1/_ _/1 0/_ _', null],
    ['0 0/_ _/1 0/_ _/½ ½/_ _/0 1/_ _/1 0/_ _', 1],
    ['0 0/_ _/1 0/_ _/½ ½/_ _/½ ½/_ _/1 0/_ _', 1],
    ['0 0/_ _/½ 0/- _/1 ½/_ _/½ ½/_ _/1 0/_ _', 7],
    ['0 0/_ _/0 0/_ _/1 ½/- _/1 ½/_ _/1 0/_ _', 9],
    ['0 0/_ _/0 0/_ _/1 ½/- _/1 ½/- _/1 0/_ _', 9],
    ['0 0/_ _/0 0/_ _/0 ½/_ _/0 ½/_ _/0 0/_ _', 5],
    ['0 0/_ _/0 0/_ _/0 0/_ _/0 1/_ _/0 0/_ _', 3],
    ['0 0/_ _/0 0/_ _/0 0/_ _/0 0/_ _/0 1/_ _', 5],
    ['0 0/_ _/0 0/_ _/0 0/_ _/0 0/_ _/0 0/_ _', 5],
  ];
  let state = m.initial(parseGrid('0 0/1 0/0 1/0 1/1 0'));
  assert.equal(formatState(m, state).replaceAll('\n', '/'), trace[0][0]);
  'S3 S4 L2 L3 L4 L5 R3 R4 R5'.split(' ').forEach((tok, k) => {
    const step = play(m, state, tok);
    state = step.state;
    assert.equal(step.costs[0], trace[k + 1][1], tok);
    assert.equal(formatState(m, state).replaceAll('\n', '/'), trace[k + 1][0], tok);
  });
  assert.ok(m.isGoal(state));
});

test('assignment example: the optimum is 38 with every exact algorithm', () => {
  const m = new Sandbox({ rows: 4 });
  const ex = parseGrid(PROFESSOR_EXAMPLE);
  for (const algo of ['ucs', 'astar', 'idastar', 'rbfs']) assert.equal(solve(m, ex, algo).cost, 38, algo);
  assert.equal(solve(m, ex, 'astar', 'volume').cost, 38);
  assert.equal(solve(m, ex, 'bfs').path.length, 7);
  for (const algo of Object.keys(ALGORITHMS)) {
    const r = solve(m, ex, algo);
    assert.ok(r.found && r.cost >= 38, algo);
    const back = replay(m, ex, r.path);
    assert.ok(m.isGoal(back.state), `${algo} path ends in a goal state`);
    assert.equal(back.total, r.cost);
  }
});

test('greedy approach of the assignment: straight-down sweep, column by column, no side gates', () => {
  const m = new Sandbox({ rows: 4 });
  const r = solve(m, parseGrid(PROFESSOR_EXAMPLE), 'sweep');
  // exactly the sequence given in class: left 5+5+9+5, then right 9+9+5
  assert.deepEqual(r.path.map((e) => e.c), [5, 5, 9, 5, 9, 9, 5]);
  assert.deepEqual(r.path.map((e) => m.actions[e.a].short), ['L1↓', 'L2↓', 'L3↓', 'L4⤓', 'R2↓', 'R3↓', 'R4⤓']);
  assert.ok(r.path.every((e) => m.actions[e.a].type === 'a'));
  // with water it can get stuck behind concrete and then reports failure instead of looping
  const m3 = new Sandbox({ rows: 3 });
  assert.equal(solve(m3, parseGrid('0 0/½ 0/# 0'), 'sweep').found, false);
});

test('with one unit per gate the greedy approach uses the fewest possible actions (all 729 states of 3x2)', () => {
  const m = new Sandbox({ rows: 3 });
  const graph = buildGraph(m);
  let worse = 0;
  for (let i = 0; i < graph.N0; i++) {
    const cells = graph.stateOf(i).cells;
    if (solve(m, cells, 'sweep').path.length !== solve(m, cells, 'bfs').path.length) worse++;
  }
  assert.equal(worse, 0);
});

test('heuristics h1 and h2 are admissible and consistent on every reachable state (rows 1-5)', () => {
  for (let rows = 1; rows <= 5; rows++) {
    const model = new Sandbox({ rows });
    const graph = buildGraph(model);
    const { opt } = solveGraph(graph);
    for (const name of ['volume', 'gap']) {
      const h = new Float64Array(graph.N);
      for (let i = 0; i < graph.N; i++) h[i] = HEURISTICS[name].fn(model, graph.stateOf(i));
      for (let i = 0; i < graph.N; i++) {
        assert.ok(h[i] <= opt[i], `${name} admissible (${rows} rows, state ${i}: h ${h[i]} > h* ${opt[i]})`);
        for (const e of graph.succ[i]) assert.ok(h[i] <= e.c + h[e.s], `${name} consistent (${rows} rows)`);
      }
    }
  }
});

test('every exact algorithm matches the value-iteration optimum on all 729 initial states of the 3x2 grid', () => {
  const result = analyze({ kind: 'exhaustive', rows: 3 });
  assert.equal(result.meta.count, 729);
  assert.equal(result.meta.optimalityMismatches, 0);
  for (const a of result.algos) {
    if (a.key === 'rbfs') continue; // may hit its budget
    assert.equal(a.solved, 729, a.label);
    if (a.guaranteesOptimal) assert.equal(a.optimal, 729, a.label);
  }
});

test('water: sand and water set into concrete, at 10 per box', () => {
  const m = new Sandbox({ rows: 2 });
  const L = (r) => m.verticalAction(0, r);
  let r = m.apply(m.initial(parseGrid('½ 0/w 0')), L(0)); // sand falls onto water
  assert.equal(formatGrid(r.state.cells), '0 0\n# 0');
  assert.equal(r.cost, 3 + 10);
  assert.equal(r.state.gates, 0);
  r = m.apply(m.initial(parseGrid('W 0/½ 0')), L(0)); // water falls onto sand, half stays above, gate stays open
  assert.equal(formatGrid(r.state.cells), 'w 0\n# 0');
  assert.equal(r.cost, 1 + 4 * 1.5 + 10);
  assert.equal(r.state.gates, 1);
  r = m.apply(m.initial(parseGrid('1 w/0 0')), m.sideAction(0)); // full sand spills into half water
  assert.equal(formatGrid(r.state.cells), '½ #\n0 0');
  assert.equal(r.cost, 11);
  assert.equal(m.apply(m.initial(parseGrid('½ w/0 0')), m.sideAction(0)), null); // level: no flow, no reaction
  assert.equal(m.apply(m.initial(parseGrid('1 W/0 0')), m.sideAction(0)), null); // no room
  assert.equal(m.apply(m.initial(parseGrid('# 0/0 0')), L(0)), null); // concrete never moves
  r = m.apply(m.initial(parseGrid('1 0/# 0')), L(0)); // gate above concrete opens but nothing passes
  assert.equal(formatGrid(r.state.cells), '1 0\n# 0');
  assert.equal(r.cost, 9);
});

test('water: trapped sand is removed by concreting it; without water it is unsolvable', () => {
  const m = new Sandbox({ rows: 3 });
  const trapped = parseGrid('0 W/½ 0/# 0');
  for (const algo of ['ucs', 'astar', 'idastar']) {
    const r = solve(m, trapped, algo);
    assert.equal(r.cost, 14, algo); // side gate 1, then water onto sand 3 + 10
    const back = replay(m, trapped, r.path);
    assert.ok(m.isGoal(back.state));
    assert.equal(back.state.cells.filter((c) => c === CONCRETE).length, 2);
  }
  const stuck = parseGrid('0 0/½ 0/# 0');
  for (const algo of Object.keys(ALGORITHMS)) {
    const r = solve(m, stuck, algo);
    assert.equal(r.found, false, algo);
    assert.equal(r.aborted, false, algo);
  }
});

test('water: goal ignores water, concrete and open gates', () => {
  const m = new Sandbox({ rows: 1 });
  assert.ok(m.isGoal({ cells: Uint8Array.of(WATER_HALF, CONCRETE), gates: 1 }));
  assert.ok(!m.isGoal({ cells: Uint8Array.of(SAND_HALF, EMPTY), gates: 0 }));
});

test('effective branching factor: 1 + b + b² + … + b^d = N + 1', () => {
  assert.equal(effectiveBranchingFactor(6, 2).toFixed(6), '2.000000'); // 2 + 4 = 6
  assert.equal(effectiveBranchingFactor(3, 1).toFixed(6), '3.000000');
  assert.ok(Math.abs(effectiveBranchingFactor(39, 3) - 3) < 1e-6); // 3 + 9 + 27
  assert.equal(effectiveBranchingFactor(2, 2), 1); // fewer nodes than a path: b* = 1
  assert.ok(Number.isNaN(effectiveBranchingFactor(10, 0)));
});

test('state features count what they say', () => {
  const m = new Sandbox({ rows: 3 });
  const f = features(m, m.initial(parseGrid('1 0/½ 1/0 0')));
  const by = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, f[i]]));
  assert.equal(by.bias, 1);
  assert.equal(by['sand (half-units)'], 5);
  assert.equal(by['columns with sand'], 2);
  assert.equal(by['closed gates with sand above'], 5); // left: 3 gates, right: 2
  assert.equal(by['closed gates under a full box'], 2);
  assert.equal(by['full sand boxes'], 2);
  assert.equal(by['half sand boxes'], 1);
  assert.equal(by['rows where a side gate can act'], 1);
  assert.equal(by['empty boxes below sand'], 2);
  const g = features(m, { cells: parseGrid('1 0/½ 1/0 0'), gates: 0b000001 });
  assert.equal(g[FEATURE_NAMES.indexOf('open gates with sand above')], 1);
  assert.equal(g[FEATURE_NAMES.indexOf('closed gates with sand above')], 4);
});

test('the learned heuristic is zero on goal states and h5 never falls below the proven h2', () => {
  if (!LEARNED.weights.length) return;
  const m = new Sandbox({ rows: 4 });
  const graph = buildGraph(m);
  let below = 0;
  for (let i = 0; i < graph.N; i += 7) {
    const st = graph.stateOf(i);
    if (graph.goal[i]) { assert.equal(HEURISTICS.learned.fn(m, st), 0); continue; }
    if (HEURISTICS['learned-safe'].fn(m, st) < HEURISTICS.gap.fn(m, st) - 1e-9) below++;
  }
  assert.equal(below, 0);
});

// ------------------------------------------------------------ Assignment 3

test('genetic algorithm: fitness is 0 on an illegal action and large_number − cost at the goal', async () => {
  const { Problem, Environment, SolverAgent, successfulPath, fitness } = await import('../js/core/genetic.js');
  const m = new Sandbox({ rows: 4 });
  const view = makeProblem(m, parseGrid(PROFESSOR_EXAMPLE), 'gap');
  const problem = new Problem(view, { maxLength: 20 });
  const env = new Environment(view);
  assert.equal(problem.largeNumber, 2 * 20 * 9 + 1);
  const plan = (text) => text.split(' ').map((tok) => (tok[0] === 'S' ? m.sideAction(Number(tok.slice(1)) - 1) : m.verticalAction(tok[0] === 'L' ? 0 : 1, Number(tok.slice(1)) - 1)));
  const sideGatePlan = plan('S2 S3 L1 L2 L3 L4 R2 R3 R4'); // the assignment's 45 plan
  assert.equal(successfulPath(problem, env, sideGatePlan), true);
  assert.equal(fitness(problem, env, sideGatePlan), problem.largeNumber - 45);
  assert.equal(fitness(problem, env, sideGatePlan, 'strict'), problem.largeNumber - 45);
  assert.equal(successfulPath(problem, env, plan('S2 S3')), false);
  // the partial path S2 S3 (cost 2): 1 0 / 0 1 / 0 1 / 1 0 has 7 closed gates with sand above them
  // (four on the left, three on the right) and the two side gates leave that count at 7 → 9 · 7
  assert.equal(fitness(problem, env, plan('S2 S3')), problem.largeNumber - 9 * 7 - 2);
  // the conflict number of a sequence is the smallest value among the states after each action:
  // from 1 0 / 0 0 / 0 0 / 0 0, L1 drops the sand one row (gates 4 → 3), then S2 spreads it over both
  // columns (3 → 6): the smallest post-action value is 3, the end state gives 6, and the start state
  // (4) does not count
  const spread = makeProblem(m, parseGrid('1 0/0 0/0 0/0 0'), 'gap');
  const spreadEnv = new Environment(spread);
  assert.equal(fitness(new Problem(spread, { maxLength: 20 }), spreadEnv, plan('L1 S2')), problem.largeNumber - 9 * 3 - 5 - 1);
  assert.equal(fitness(new Problem(spread, { maxLength: 20, conflictMode: 'end' }), spreadEnv, plan('L1 S2')), problem.largeNumber - 9 * 6 - 5 - 1);
  // an empty sequence is scored by the start state (4 gates)
  assert.equal(fitness(new Problem(spread, { maxLength: 20 }), spreadEnv, []), problem.largeNumber - 9 * 4);
  assert.equal(fitness(problem, env, plan('S2 S3'), 'strict'), 0);
  // an illegal action (the left gate under row 2: that box is empty) → 0 in every form
  for (const form of ['graded', 'strict', 'ratio']) assert.equal(fitness(problem, env, plan('L2 L1'), form), 0);
  // the path is cut at the first goal state: what follows is neither applied nor paid for
  assert.equal(fitness(problem, env, sideGatePlan.concat(sideGatePlan)), problem.largeNumber - 45);
  const agent = new SolverAgent(problem, env, { seed: 3 });
  const ind = agent.build(sideGatePlan.concat(sideGatePlan));
  assert.equal(ind.genes.length, 9);
  assert.equal(ind.goal, true);
});

test('genetic algorithm: 9 × closed gates with sand above is never below h* (every reachable state of 2x2 … 4x2)', async () => {
  const { CONFLICTS } = await import('../js/core/genetic.js');
  for (const rows of [2, 3, 4]) {
    const m = new Sandbox({ rows });
    const graph = buildGraph(m);
    const { opt } = solveGraph(graph);
    const view = { model: m, state: (s) => graph.stateOf(s), cells: (s) => graph.stateOf(s).cells };
    for (let s = 0; s < graph.N; s++) {
      if (graph.goal[s]) continue;
      assert.ok(9 * CONFLICTS.gates.fn(view, s) >= opt[s], `${rows}x2 state ${s}: 9·gates ${9 * CONFLICTS.gates.fn(view, s)} < h* ${opt[s]}`);
    }
  }
});

test('genetic algorithm: selection probabilities sum to 1, the list is sorted, repeats are allowed', async () => {
  const { selection, selectionProbabilities, SELECTION } = await import('../js/core/genetic.js');
  const pop = [320, 300, 300, 290, 0, 350].map((f, i) => ({ fitness: f, genes: [i] }));
  const rng = seededRng(5);
  for (const method of Object.keys(SELECTION)) {
    const p = selectionProbabilities(pop, method);
    assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9, method);
    assert.ok(p[5] >= p[0] && p[0] >= p[1] && p[1] >= p[4], `${method}: a fitter individual is never less likely`);
    const picked = selection(pop, 20, method, rng);
    assert.equal(picked.length, 20);
    for (let i = 1; i < picked.length; i++) assert.ok(picked[i - 1].fitness >= picked[i].fitness, `${method}: sorted`);
  }
  // the plain wheel barely tells 300 from 350 apart; the windowed one does (once the worst is 290, not 0)
  const legal = pop.filter((x) => x.fitness > 0);
  assert.ok(selectionProbabilities(legal, 'roulette')[4] / selectionProbabilities(legal, 'roulette')[1] < 1.2);
  assert.ok(selectionProbabilities(legal, 'windowed')[4] / selectionProbabilities(legal, 'windowed')[1] > 4);
  // all-zero fitness: uniform, no division by zero
  const zeros = pop.map((x) => ({ ...x, fitness: 0 }));
  assert.ok(selectionProbabilities(zeros, 'roulette').every((v) => Math.abs(v - 1 / 6) < 1e-9));
});

test('genetic algorithm: crossover and mutation keep individuals legal and within the length bound', async () => {
  const { Problem, Environment, SolverAgent, MUTATIONS } = await import('../js/core/genetic.js');
  const m = new Sandbox({ rows: 5 });
  const view = makeProblem(m, parseGrid('1 1/1 1/1 1/0 0/0 0'), 'gap');
  const problem = new Problem(view, { maxLength: 12 });
  const env = new Environment(view);
  for (const [illegal, crossover] of [['repair', 'single'], ['repair', 'double'], ['retry', 'single'], ['retry', 'double']]) {
    const agent = new SolverAgent(problem, env, { seed: 11, illegal, crossover });
    const pop = Array.from({ length: 30 }, () => agent.randomIndividual());
    // step 6.1: fixed-length random sequences, cut at the goal, legal by construction
    for (const x of pop) { assert.ok(x.legal); assert.ok(x.genes.length <= 12); assert.ok(x.genes.length === 12 || x.goal); assert.ok(x.fitness > 0); }
    for (let i = 0; i < 200; i++) {
      const a = pop[i % 30];
      const b = pop[(i * 7) % 30];
      for (const child of agent.crossover(a, b)) {
        assert.ok(child.legal && child.genes.length <= 12, `${illegal} ${crossover}`);
        assert.equal(env.replay(problem, child.genes).legal, true);
      }
      for (const kind of Object.keys(MUTATIONS)) {
        const mutant = agent.mutate(a, kind);
        assert.ok(mutant.legal && mutant.genes.length <= 12, `${illegal} ${kind}`);
        assert.equal(env.replay(problem, mutant.genes).cost, mutant.cost);
      }
    }
    // the fitness of an individual is what the standalone function says
    for (const x of pop.slice(0, 5)) assert.equal(agent.fitness(x.genes), x.fitness);
  }
  // swap and reverse change the order only; without repair the multiset of actions is preserved
  const agent = new SolverAgent(problem, env, { seed: 2, illegal: 'zero' });
  const parent = agent.build([5, 6, 7, 8, 9, 10, 11], false);
  const sorted = (g) => [...g].sort((x, y) => x - y).join(',');
  assert.equal(sorted(agent.mutate(parent, 'swap').genes), sorted(parent.genes));
  assert.equal(sorted(agent.mutate(parent, 'reverse').genes), sorted(parent.genes));
  // the lethal-mutation mode never returns an illegal child: it retries, then keeps the parent
  const lethal = new SolverAgent(problem, env, { seed: 5, illegal: 'retry' });
  const legalParent = lethal.randomIndividual();
  for (let i = 0; i < 50; i++) assert.ok(lethal.mutate(legalParent).legal);
  assert.ok(lethal.retries > 0, 'some operators were redrawn');
});

test('genetic algorithm: solves the assignment example, is reproducible per seed, and reports like the other algorithms', () => {
  const m = new Sandbox({ rows: 4 });
  const p = makeProblem(m, parseGrid(PROFESSOR_EXAMPLE), 'gap');
  const r1 = search('ga', p, { ga: { seed: 1 } });
  const r2 = search('ga', p, { ga: { seed: 1 } });
  assert.ok(r1.found);
  assert.ok(r1.cost >= 38 && r1.cost <= 47, `cost ${r1.cost} between the optimum and the greedy approach`);
  assert.deepEqual(r1.path.map((e) => e.a), r2.path.map((e) => e.a));
  const { total, state } = replay(m, parseGrid(PROFESSOR_EXAMPLE), r1.path);
  assert.equal(total, r1.cost);
  assert.ok(m.isGoal(state));
  assert.equal(r1.ga.history.length, r1.ga.generations + 1);
  assert.ok(r1.expanded > 0 && r1.generated > r1.expanded);
  // the admissible h₂ used unweighted rewards stopping short: the fittest individual is not a goal path
  const bad = search('ga', p, { ga: { seed: 1, conflicts: 'h2' } });
  assert.equal(bad.ga.best.goal, false);
  // without repair nothing is legal for long (the first version's flag and the new name agree)
  const naive = search('ga', p, { ga: { seed: 1, illegal: 'zero' } });
  assert.equal(naive.found, false);
  assert.deepEqual(search('ga', p, { ga: { seed: 1, repair: false } }).ga.params, naive.ga.params);
  // the length bound defaults to 4 actions per row and large_number follows from it
  assert.equal(r1.ga.maxLength, 16);
  assert.equal(r1.ga.largeNumber, 2 * 16 * 9 + 1);
  // the brief's conflict count (boxes with sand) and the general form with transforms also run
  const alt = search('ga', p, { ga: { seed: 1, conflicts: 'boxes', conflictTransform: 'sqrt', costTransform: 'log', costWeight: 2, mutations: 'brief', crossover: 'double' } });
  assert.ok(alt.found && alt.cost >= 38);
});
