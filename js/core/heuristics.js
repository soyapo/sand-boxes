// Heuristic functions h(n): lower bounds on the remaining cost to reach "no sand anywhere".
// All values are in the same integer units as the action costs.

import { LEVEL, MAT, SAND, WATER, EMPTY, CONCRETE } from './model.js';

/** h = 0. Turns A* into uniform-cost search. */
function zero() { return 0; }

/**
 * Sand-volume bound.
 *
 * Sand only leaves through an outlet (or by setting into concrete). An outlet action that removes
 * s units costs at least 1 + 4s and removes at most one unit, so with T units of sand left the
 * outlets alone cost at least 4T + ceil(T).
 *
 * With water in the grid, a box of sand can instead be turned into concrete for `penalty`; one
 * concrete box absorbs at most one unit. For penalty >= 5 the bound above still holds; for a
 * cheaper penalty we fall back to T * min(5, penalty).
 */
function volume(model, cells) {
  let t = 0; // half-units of sand
  let water = false;
  for (let i = 0; i < cells.length; i++) {
    const m = MAT[cells[i]];
    if (m === SAND) t += LEVEL[cells[i]];
    else if (m === WATER) water = true;
  }
  if (water && model.concretePenalty < 5) return (t / 2) * Math.max(0, model.concretePenalty);
  return 2 * t + Math.ceil(t / 2);
}

/**
 * Volume + gate bound (sand-only grids).
 *
 * Take a box E that is not full and has sand somewhere above it in the same column. A side gate
 * always leaves half a box behind, so some of that sand stays in the column until it has crossed
 * the gate on top of E. It can cross in two ways:
 *   - the agent opens that very gate: a top-down action with s >= 1/2, cost >= 3;
 *   - the door opens by itself because it is pressed from both sides, which needs E to be FULL
 *     first. A side gate only flows into an empty box and brings half a box, so E cannot become
 *     full unless sand has already crossed the gate from above.
 * Hence the first crossing is always a paid action on that gate, costing at least 3. The gate is
 * not an outlet and belongs to E alone, so every such box adds 3 on top of the volume bound.
 *
 * Under the alternative "whole pile always follows" rule a half-filled E is enough for the pile to
 * follow, and an empty E can get that half through its side gate for 1: only empty boxes count,
 * with weight 1. With water or concrete in the grid the argument no longer holds and the extra
 * term is dropped.
 */
function gap(model, cells) {
  const loose = model.chain === 'always';
  let count = 0;
  for (let col = 0; col < 2; col++) {
    let sandAbove = false;
    for (let i = col; i < cells.length; i += 2) {
      const c = cells[i];
      if (MAT[c] === WATER || c === CONCRETE) return volume(model, cells);
      if (sandAbove && (c === EMPTY || (!loose && LEVEL[c] < 2))) count++;
      if (c !== EMPTY) sandAbove = true;
    }
  }
  return volume(model, cells) + count * (loose ? 1 : 3);
}

/**
 * Remaining fall distance (NOT admissible).
 *
 * Pretends every unit of sand has to be carried down alone: 5 per unit for each gate it still has
 * to pass, i.e. 2.5 per half-unit per row. Doors pressed from both sides let a whole stack drop for
 * the price of one action, so this overestimates — but it ranks states the way a person who "just flushes everything
 * straight down" would, which makes it the natural guide for greedy best-first search. Side gates
 * never reduce it, so greedy search only uses them when nothing else is left.
 */
function fall(model, cells) {
  let h = 0;
  for (let i = 0; i < cells.length; i++) {
    if (MAT[cells[i]] === SAND) h += LEVEL[cells[i]] * (model.rows - (i >> 1));
  }
  return 2.5 * h;
}

export const HEURISTICS = Object.freeze({
  gap: { name: 'Volume + gates', short: 'h₂', admissible: true, fn: gap, note: 'Sand volume plus 3 for every box that is not full and has sand above it (its top gate must be opened by a paid action). Admissible and consistent.' },
  volume: { name: 'Sand volume', short: 'h₁', admissible: true, fn: volume, note: '4T + ⌈T⌉ for T units of sand left. Admissible and consistent.' },
  fall: { name: 'Fall distance', short: 'h₃', admissible: false, fn: fall, note: '5 per unit of sand per gate still below it. Overestimates, so A* loses its guarantee — the natural guide for greedy search.' },
  zero: { name: 'Zero', short: 'h₀', admissible: true, fn: zero, note: 'No information: A* behaves exactly like uniform-cost search.' },
});
