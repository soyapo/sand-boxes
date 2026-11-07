// Heuristic functions h(n): lower bounds on the remaining cost to reach "no sand anywhere".
// All values are in the same integer units as the action costs. Every function takes a state
// { cells, gates }.

import { LEVEL, MAT, SAND, WATER, CONCRETE } from './model.js';

/** h = 0. Turns A* into uniform-cost search. */
function zero() { return 0; }

/**
 * Column bound.
 *
 * Sand never leaves a column completely through a side gate (half a box always stays behind), so
 * every column that holds sand still needs at least one more paid action of its own: a top-down
 * gate opened under a box with sand (s >= 1/2, so cost >= 3), or, with water, a flow that sets the
 * sand into concrete (penalty >= 10 on top of the action). Each such action belongs to one column,
 * so the columns add up: h = 3 per column that contains sand.
 *
 * Note that one outlet action may drain a whole column once the gates above it are open, so a
 * bound by the amount of sand is NOT valid in this model.
 */
function columns(model, state) {
  const { cells } = state;
  let n = 0;
  for (let col = 0; col < 2; col++) {
    for (let i = col; i < cells.length; i += 2) if (MAT[cells[i]] === SAND) { n++; break; }
  }
  return 3 * n;
}

/**
 * Closed-gate bound (sand-only grids).
 *
 * Take a closed top-down gate g with sand somewhere above it in its column. That sand can only
 * leave the column through the outlet below g (a side gate leaves half a box behind, and nothing
 * else moves sand sideways), so some of it has to pass g, and a gate only opens by a paid action
 * on that very gate, with a box holding sand above it: cost >= 1 + 4 * 1/2 = 3. Every such gate
 * needs its own action, so h = 3 per closed gate with sand above it. Open gates cost nothing more.
 *
 * With water or concrete in the grid sand may be set into concrete above a closed gate instead, so
 * the count is replaced by the column bound.
 */
function gates(model, state) {
  const { cells } = state;
  let n = 0;
  for (let col = 0; col < 2; col++) {
    let sandAbove = false;
    for (let i = col; i < cells.length; i += 2) {
      const c = cells[i];
      if (MAT[c] === WATER || c === CONCRETE) return columns(model, state);
      if (MAT[c] === SAND) sandAbove = true;
      if (sandAbove && !(state.gates & (1 << i))) n++;
    }
  }
  return 3 * n;
}

/**
 * Remaining fall distance (NOT admissible).
 *
 * Pretends every unit of sand has to be carried down alone: 5 per unit for each closed gate it
 * still has to pass, i.e. 2.5 per half-unit per gate. Open gates let a whole pile drop for the
 * price of one action, so this overestimates — but it ranks states the way a person who "just
 * flushes everything straight down" would, which makes it the natural guide for greedy best-first
 * search. Side gates never reduce it.
 */
function fall(model, state) {
  const { cells } = state;
  let h = 0;
  for (let col = 0; col < 2; col++) {
    let closedBelow = 0;
    for (let i = (model.rows - 1) * 2 + col; i >= 0; i -= 2) {
      if (!(state.gates & (1 << i))) closedBelow++;
      if (MAT[cells[i]] === SAND) h += LEVEL[cells[i]] * closedBelow;
    }
  }
  return 2.5 * h;
}

export const HEURISTICS = Object.freeze({
  gap: { name: 'Closed gates', short: 'h₂', admissible: true, fn: gates, note: '3 for every closed gate that has sand above it in its column (each must be opened by a paid action). Admissible and consistent.' },
  volume: { name: 'Columns', short: 'h₁', admissible: true, fn: columns, note: '3 for every column that still holds sand. Admissible and consistent, but weak.' },
  fall: { name: 'Fall distance', short: 'h₃', admissible: false, fn: fall, note: '5 per unit of sand per closed gate below it. Overestimates, so A* loses its guarantee — the natural guide for greedy best-first search.' },
  zero: { name: 'Zero', short: 'h₀', admissible: true, fn: zero, note: 'No information: A* behaves exactly like uniform-cost search.' },
});
