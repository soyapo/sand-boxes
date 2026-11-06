// Run with: npm test   (Node's built-in test runner, no dependencies)

import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox, parseGrid, formatGrid, PROFESSOR_EXAMPLE, CONCRETE, SAND_HALF, WATER_HALF, EMPTY } from '../js/core/model.js';
import { search, ALGORITHMS } from '../js/core/search.js';
import { makeProblem } from '../js/core/problem.js';
import { HEURISTICS } from '../js/core/heuristics.js';
import { buildTable, solveTable, analyze } from '../js/core/analysis.js';

/** Apply a list of [actionId, expectedCost] and return the final cells and total cost. */
function play(model, cells, plan) {
  let total = 0;
  for (const [id, expected] of plan) {
    const r = model.apply(cells, id);
    assert.ok(r, `action ${model.actions[id].label} should move something`);
    assert.equal(r.cost, expected, `cost of ${model.actions[id].label}`);
    cells = r.cells;
    total += r.cost;
  }
  return { cells, total };
}

const solve = (model, cells, algo, h = 'gap') => search(algo, makeProblem(model, cells, h));

test('grid text round-trips', () => {
  const text = '1 0\n½ W\nw #';
  assert.equal(formatGrid(parseGrid(text)), text);
  const m = new Sandbox({ rows: 3 });
  const cells = parseGrid(text);
  assert.deepEqual(m.decode(m.encode(cells)), cells);
});

test('side gate only levels a full box with an empty one', () => {
  const m = new Sandbox({ rows: 1 });
  assert.equal(formatGrid(m.apply(parseGrid('1 0'), m.sideAction(0)).cells), '½ ½');
  assert.equal(formatGrid(m.apply(parseGrid('0 1'), m.sideAction(0)).cells), '½ ½');
  assert.equal(m.apply(parseGrid('1 0'), m.sideAction(0)).cost, 1);
  for (const g of ['1 ½', '½ 0', '½ ½', '1 1', '0 0']) assert.equal(m.apply(parseGrid(g), m.sideAction(0)), null, g);
});

test('top-down gate cost is 1 + 4(s + s\')', () => {
  const m = new Sandbox({ rows: 2 });
  const L = (r) => m.verticalAction(0, r);
  assert.equal(m.apply(parseGrid('1 0/0 0'), L(0)).cost, 5); // 1 -> 0
  assert.equal(m.apply(parseGrid('½ 0/0 0'), L(0)).cost, 3); // 1/2 -> 0
  assert.equal(m.apply(parseGrid('1 0/½ 0'), L(0)).cost, 7); // 1 -> 1/2
  assert.equal(m.apply(parseGrid('1 0/1 0'), L(1)).cost, 9); // outlet, refilled by the box above
  assert.equal(m.apply(parseGrid('½ 0/½ 0'), L(1)).cost, 3); // half box drains: nothing follows
  assert.equal(m.apply(parseGrid('1 0/1 0'), L(0)), null); // lower box is full: nothing moves
  assert.equal(m.apply(parseGrid('0 0/1 0'), L(0)), null); // nothing to drop
});

test('a door above opens only when pressed from both sides (the box under it is full)', () => {
  const m = new Sandbox({ rows: 4 });
  const L = (r) => m.verticalAction(0, r - 1);
  const after = (grid, id) => { const r = m.apply(parseGrid(grid), id); return `${formatGrid(r.cells, '/')} cost ${r.cost}`; };
  // full box pours half; the half box resting on it follows at the same moment: s = 1, s' = 1
  assert.equal(after('½ 0/1 0/½ 0/1 0', L(2)), '0 0/1 0/1 0/1 0 cost 9');
  // a half box drains: it does not touch the door above, so the full box above stays
  assert.equal(after('1 0/½ 0/½ 0/1 0', L(2)), '1 0/0 0/1 0/1 0 cost 3');
  // outlet under a full box: only the boxes connected through full boxes follow
  assert.equal(after('½ 0/1 0/½ 0/1 0', L(4)), '½ 0/1 0/0 0/½ 0 cost 7');
  assert.equal(after('0 0/1 0/1 0/1 0', L(4)), '0 0/0 0/1 0/1 0 cost 9');
  assert.equal(after('½ 0/1 0/1 0/1 0', L(4)), '0 0/½ 0/1 0/1 0 cost 9');
  // a gap breaks the chain; a side gate never triggers one
  assert.equal(after('1 0/0 0/1 0/1 0', L(4)), '1 0/0 0/0 0/1 0 cost 9');
  assert.equal(after('0 ½/0 1/0 0/0 0', m.sideAction(1)), '0 ½/½ ½/0 0/0 0 cost 1');
});

/** Play a plan written as "S2 L1 R4": side gate of row 2, gate under row 1 left, under row 4 right. */
function playPlan(model, cells, plan) {
  const costs = [];
  for (const tok of plan.split(' ')) {
    const row = Number(tok.slice(1)) - 1;
    const id = tok[0] === 'S' ? model.sideAction(row) : model.verticalAction(tok[0] === 'L' ? 0 : 1, row);
    const r = model.apply(cells, id);
    if (!r) return { costs, cells, stuckAt: tok };
    cells = r.cells;
    costs.push(r.cost);
  }
  return { costs, cells, total: costs.reduce((a, b) => a + b, 0) };
}

test('assignment example: greedy 47, corrected side-gate plan 54, alternative 46', () => {
  const m = new Sandbox({ rows: 4 });
  const start = parseGrid(PROFESSOR_EXAMPLE);

  const greedy = playPlan(m, start, 'L1 L2 L4 L4 R3 R4 R4');
  assert.deepEqual(greedy.costs, [5, 5, 9, 5, 9, 9, 5]);
  assert.equal(greedy.total, 47);
  assert.ok(m.isGoal(greedy.cells));

  // The plan printed as 1+1, 7+9+9+5, 3+5+5 = 45 misses a 9: after the 7 the left column is
  // 1/2, 1, 1/2, 1 and has to be packed with one more action (cost 9) before it can be flushed.
  const corrected = playPlan(m, start, 'S2 S3 L1 L2 L4 L4 L4 R2 R3 R4');
  assert.deepEqual(corrected.costs, [1, 1, 7, 9, 9, 9, 5, 3, 5, 5]);
  assert.equal(corrected.total, 54);
  assert.ok(m.isGoal(corrected.cells));
  const asPrinted = playPlan(m, start, 'S2 S3 L1 L4 L4 L4');
  assert.deepEqual(asPrinted.costs, [1, 1, 7, 7, 3]); // not 7, 9, 9, 5
  assert.equal(asPrinted.stuckAt, 'L4');

  const other = playPlan(m, start, 'S2 S3 L2 L1 L4 L4 L4 R2 R3 R4');
  assert.deepEqual(other.costs, [1, 1, 3, 5, 9, 9, 5, 3, 5, 5]);
  assert.equal(other.total, 46);
  assert.ok(m.isGoal(other.cells));
});

test('the corrected plan matches the state-by-state trace on the 5x2 grid', () => {
  const m = new Sandbox({ rows: 5 });
  const trace = [
    '0 0/1 0/0 1/0 1/1 0', '0 0/1 0/½ ½/0 1/1 0', '0 0/1 0/½ ½/½ ½/1 0', '0 0/½ 0/1 ½/½ ½/1 0',
    '0 0/0 0/1 ½/1 ½/1 0', '0 0/0 0/0 ½/1 ½/1 0', '0 0/0 0/0 ½/0 ½/1 0', '0 0/0 0/0 ½/0 ½/0 0',
    '0 0/0 0/0 0/0 1/0 0', '0 0/0 0/0 0/0 0/0 1', '0 0/0 0/0 0/0 0/0 0',
  ];
  let cells = parseGrid(trace[0]);
  const costs = [];
  for (const tok of 'S3 S4 L2 L3 L5 L5 L5 R3 R4 R5'.split(' ')) {
    const step = playPlan(m, cells, tok);
    cells = step.cells;
    costs.push(step.costs[0]);
    assert.equal(formatGrid(cells, '/'), trace[costs.length]);
  }
  assert.deepEqual(costs, [1, 1, 7, 9, 9, 9, 5, 3, 5, 5]);
});

test('assignment example: optimum is 45, greedy search gives 47', () => {
  const m = new Sandbox({ rows: 4 });
  const start = parseGrid(PROFESSOR_EXAMPLE);
  for (const algo of ['ucs', 'astar', 'idastar']) assert.equal(solve(m, start, algo).cost, 45, algo);
  assert.equal(solve(m, start, 'astar', 'volume').cost, 45);
  assert.equal(solve(m, start, 'greedy', 'fall').cost, 47);
  assert.equal(solve(m, start, 'bfs').path.length, 7);
  for (const algo of Object.keys(ALGORITHMS)) {
    const r = solve(m, start, algo);
    assert.ok(r.found && r.cost >= 45, algo);
    const replay = play(m, start, r.path.map((e) => [e.a, e.c]));
    assert.ok(m.isGoal(replay.cells), `${algo} path ends in a goal state`);
    assert.equal(replay.total, r.cost);
  }
});

test('heuristics h1 and h2 are admissible and consistent on every state (rows 1-5; rows 1-4 for the other door rules)', () => {
  for (const chain of ['press', 'always', 'none']) {
    for (let rows = 1; rows <= (chain === 'press' ? 5 : 4); rows++) {
      const model = new Sandbox({ rows, chain });
      const table = buildTable(model);
      const { opt } = solveTable(table);
      for (const name of ['volume', 'gap']) {
        const h = Array.from({ length: table.N }, (_, i) => HEURISTICS[name].fn(model, table.cellsOf(i)));
        for (let i = 0; i < table.N; i++) {
          assert.ok(h[i] <= opt[i], `${name} admissible (${chain}, ${rows} rows, state ${i})`);
          for (const e of table.succ[i]) assert.ok(h[i] <= e.c + h[e.s], `${name} consistent`);
        }
      }
    }
  }
});

test('every exact algorithm matches the dynamic-programming optimum on all 729 states of the 3x2 grid', () => {
  const result = analyze({ kind: 'exhaustive', rows: 3 });
  assert.equal(result.meta.count, 729);
  assert.equal(result.meta.optimalityMismatches, 0);
  for (const a of result.algos) {
    assert.equal(a.solved, 729, a.label);
    if (a.guaranteesOptimal) assert.equal(a.optimal, 729, a.label);
  }
});

test('water: sand and water set into concrete, at 10 per box', () => {
  const m = new Sandbox({ rows: 2 });
  let r = m.apply(parseGrid('½ 0/w 0'), m.verticalAction(0, 0)); // sand falls onto water
  assert.equal(formatGrid(r.cells), '0 0\n# 0');
  assert.equal(r.cost, 3 + 10);
  r = m.apply(parseGrid('W 0/½ 0'), m.verticalAction(0, 0)); // water falls onto sand, half stays above
  assert.equal(formatGrid(r.cells), 'w 0\n# 0');
  assert.equal(r.cost, 1 + 4 * 1.5 + 10);
  r = m.apply(parseGrid('1 w/0 0'), m.sideAction(0)); // full sand spills into half water
  assert.equal(formatGrid(r.cells), '½ #\n0 0');
  assert.equal(r.cost, 11);
  assert.equal(m.apply(parseGrid('½ w/0 0'), m.sideAction(0)), null); // level: no flow, no reaction
  assert.equal(m.apply(parseGrid('1 W/0 0'), m.sideAction(0)), null); // no room
  assert.equal(m.apply(parseGrid('1 0/# 0'), m.verticalAction(0, 0)), null); // concrete blocks
  assert.equal(m.apply(parseGrid('# 0/0 0'), m.verticalAction(0, 0)), null); // concrete never moves
});

test('water: trapped sand is removed by concreting it; without water it is unsolvable', () => {
  const m = new Sandbox({ rows: 3 });
  const trapped = parseGrid('0 W/½ 0/# 0');
  for (const algo of ['ucs', 'astar', 'idastar']) {
    const r = solve(m, trapped, algo);
    assert.equal(r.cost, 14, algo); // side gate 1, then water onto sand 3 + 10
    const end = play(m, trapped, r.path.map((e) => [e.a, e.c])).cells;
    assert.ok(m.isGoal(end));
    assert.equal(end.filter((c) => c === CONCRETE).length, 2);
  }
  const stuck = parseGrid('0 0/½ 0/# 0');
  for (const algo of Object.keys(ALGORITHMS)) {
    const r = solve(m, stuck, algo);
    assert.equal(r.found, false, algo);
    assert.equal(r.aborted, false, algo);
  }
});

test('water: goal ignores water and concrete', () => {
  const m = new Sandbox({ rows: 1 });
  assert.ok(m.isGoal(Uint8Array.of(WATER_HALF, CONCRETE)));
  assert.ok(!m.isGoal(Uint8Array.of(SAND_HALF, EMPTY)));
});
