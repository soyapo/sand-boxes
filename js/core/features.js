// Numeric features of a state, used by the learned (linear-regression) heuristic and shown in the
// heuristic explorer. Every feature is a count or a sum over the grid, so a linear model stays
// easy to read.

import { LEVEL, MAT, SAND } from './model.js';

export const FEATURE_NAMES = Object.freeze([
  'bias',
  'sand (half-units)',
  'columns with sand',
  'closed gates with sand above',
  'closed gates under a full box',
  'open gates with sand above',
  'boxes with sand',
  'full sand boxes',
  'half sand boxes',
  'fall distance (half-units × closed gates below)',
  'height of sand (rows from top sand box to bottom, both columns)',
  'rows where a side gate can act',
  'empty boxes below sand',
]);

/** @returns {Float64Array} one value per FEATURE_NAMES entry */
export function features(model, state) {
  const { cells, gates } = state;
  const rows = model.rows;
  const f = new Float64Array(FEATURE_NAMES.length);
  f[0] = 1;
  for (let col = 0; col < 2; col++) {
    let sandAbove = false;
    let top = -1;
    let closedBelow = 0;
    // walk down for the "above" features
    for (let r = 0; r < rows; r++) {
      const i = r * 2 + col;
      const c = cells[i];
      const sand = MAT[c] === SAND;
      const open = (gates & (1 << i)) !== 0;
      if (sand) {
        f[1] += LEVEL[c];
        f[6]++;
        if (LEVEL[c] === 2) f[7]++; else f[8]++;
        if (top < 0) top = r;
        sandAbove = true;
      } else if (c === 0 && sandAbove) {
        f[12]++;
      }
      if (sandAbove) {
        if (open) f[5]++;
        else {
          f[3]++;
          if (sand && LEVEL[c] === 2) f[4]++;
        }
      }
    }
    if (top >= 0) {
      f[2]++;
      f[10] += rows - top;
    }
    // walk up for the fall distance
    for (let r = rows - 1; r >= 0; r--) {
      const i = r * 2 + col;
      if (!(gates & (1 << i))) closedBelow++;
      if (MAT[cells[i]] === SAND) f[9] += LEVEL[cells[i]] * closedBelow;
    }
  }
  for (let r = 0; r < rows; r++) {
    const a = cells[r * 2];
    const b = cells[r * 2 + 1];
    if ((LEVEL[a] === 2 && b === 0) || (LEVEL[b] === 2 && a === 0)) f[11]++;
  }
  return f;
}
