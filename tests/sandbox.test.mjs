// Run with: npm test   (Node's built-in test runner, no dependencies)

import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox, parseGrid, formatGrid, formatState, PROFESSOR_EXAMPLE, CONCRETE, SAND_HALF, WATER_HALF, EMPTY } from '../js/core/model.js';
import { search, ALGORITHMS } from '../js/core/search.js';
import { makeProblem } from '../js/core/problem.js';
import { HEURISTICS } from '../js/core/heuristics.js';
import { buildGraph, solveGraph, analyze } from '../js/core/analysis.js';

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
