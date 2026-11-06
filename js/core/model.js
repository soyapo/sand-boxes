// Sand Boxes — environment model (state, physics, actions, cost).
//
// The grid has `rows` rows and 2 columns. Cell index = row * 2 + col, row 0 is the top.
// Every cell holds one of six codes. Levels are stored in half-units (0, 1, 2 = 0, 1/2, 1).

export const EMPTY = 0;
export const SAND_HALF = 1;
export const SAND_FULL = 2;
export const WATER_HALF = 3;
export const WATER_FULL = 4;
export const CONCRETE = 5;

export const NONE = 0;
export const SAND = 1;
export const WATER = 2;
export const SOLID = 3;

/** Fill level of each cell code, in half-units. Concrete always fills its box. */
export const LEVEL = Object.freeze([0, 1, 2, 1, 2, 2]);
/** Material of each cell code. */
export const MAT = Object.freeze([NONE, SAND, SAND, WATER, WATER, SOLID]);

const CODE = [[0, 0, 0], [0, SAND_HALF, SAND_FULL], [0, WATER_HALF, WATER_FULL]];
export const cellCode = (mat, level) => (level === 0 ? EMPTY : CODE[mat][level]);

export const CELL_NAMES = ['empty', '½ sand', 'full sand', '½ water', 'full water', 'concrete'];

/**
 * Which doors above an opened top-down gate open by themselves.
 *  - press:  a spring door opens only when material presses on it from both sides, i.e. the box
 *            above it holds material and the box below it is FULL (touching the door from
 *            underneath). When the agent opens the gate under a full box, the door on top of that
 *            box therefore opens too, then the one above it if that box was full as well, and so
 *            on. All of them are open at the same moment and everything falls together.
 *            A half-full box does not touch the door above it, so nothing above it follows.
 *  - always: every non-empty box of the unbroken pile above follows, full or not.
 *  - none:   nothing moves except the two boxes joined by the opened gate.
 */
export const CHAIN_MODES = Object.freeze({
  press: 'Doors pressed from both sides (default)',
  always: 'Whole pile always follows',
  none: 'No chain reaction',
});

/** Initial-state probabilities from the assignment (sand only) and a default mix with water. */
export const PROBS_SAND = Object.freeze({ empty: 0.5, sandHalf: 0.2, sandFull: 0.3, waterHalf: 0, waterFull: 0 });
export const PROBS_WATER = Object.freeze({ empty: 0.4, sandHalf: 0.15, sandFull: 0.2, waterHalf: 0.1, waterFull: 0.15 });

export class Sandbox {
  /**
   * @param {{rows?: number, chain?: 'press'|'always'|'none', concretePenalty?: number}} [opts]
   */
  constructor({ rows = 5, chain = 'press', concretePenalty = 10 } = {}) {
    if (!(rows >= 1 && rows <= 12)) throw new RangeError('rows must be between 1 and 12');
    if (!(chain in CHAIN_MODES)) throw new RangeError(`unknown chain mode: ${chain}`);
    this.rows = rows;
    this.size = rows * 2;
    this.chain = chain;
    this.concretePenalty = concretePenalty;

    /** Action list. Type 'b' = side gate of a row, type 'a' = top-down gate under a box. */
    this.actions = [];
    for (let r = 0; r < rows; r++) {
      this.actions.push({ id: r, type: 'b', row: r, label: `Side gate, row ${r + 1}`, short: `S${r + 1}` });
    }
    for (let c = 0; c < 2; c++) {
      for (let r = 0; r < rows; r++) {
        const outlet = r === rows - 1;
        const side = c === 0 ? 'Left' : 'Right';
        this.actions.push({
          id: rows + c * rows + r,
          type: 'a',
          col: c,
          row: r,
          outlet,
          label: outlet ? `${side} outlet (row ${r + 1})` : `${side} gate ${r + 1}→${r + 2}`,
          short: `${side[0]}${r + 1}${outlet ? '⤓' : '↓'}`,
        });
      }
    }
  }

  sideAction(row) { return row; }
  verticalAction(col, row) { return this.rows + col * this.rows + row; }

  // ---------------------------------------------------------------- encoding

  /** Pack a cell array into one number (base 6, exact up to 20 cells). */
  encode(cells) {
    let key = 0;
    for (let i = this.size - 1; i >= 0; i--) key = key * 6 + cells[i];
    return key;
  }

  decode(key) {
    const cells = new Uint8Array(this.size);
    for (let i = 0; i < this.size; i++) {
      cells[i] = key % 6;
      key = Math.floor(key / 6);
    }
    return cells;
  }

  /** Goal: no box contains sand (water and concrete may remain). */
  isGoal(cells) {
    for (let i = 0; i < this.size; i++) if (MAT[cells[i]] === SAND) return false;
    return true;
  }

  // ------------------------------------------------------------------ physics

  /**
   * Open one gate.
   * @param {Uint8Array} cells   state before the action (not modified)
   * @param {number} id          action id
   * @param {Array|null} events  if given, receives one entry per elementary flow, for animation
   * @returns {null | {cells: Uint8Array, cost: number, concrete: number, s: number, s2: number}}
   *          null when the gate would open on nothing (no sand or water moves).
   */
  apply(cells, id, events = null) {
    const act = this.actions[id];
    return act.type === 'b' ? this.#side(cells, act.row, events) : this.#vertical(cells, act.col, act.row, events);
  }

  /** Side gate: a full box levels with an empty neighbour, or spills into a half box of the other material. */
  #side(cells, row, events) {
    const i = row * 2;
    const j = i + 1;
    const a = cells[i];
    const b = cells[j];
    const ma = MAT[a];
    const mb = MAT[b];
    if (ma === SOLID || mb === SOLID) return null;
    const la = LEVEL[a];
    const lb = LEVEL[b];
    let from;
    let to;
    if (la === 2 && lb < 2) { from = i; to = j; } else if (lb === 2 && la < 2) { from = j; to = i; } else return null;
    const mf = MAT[cells[from]];
    const lt = LEVEL[cells[to]];
    const mt = MAT[cells[to]];
    let concrete = 0;
    const out = cells.slice();
    if (lt === 0) {
      out[from] = cellCode(mf, 1);
      out[to] = cellCode(mf, 1);
    } else if (mt !== mf) {
      // full box of one material pushes into a half box of the other: they set into concrete
      out[from] = cellCode(mf, 1);
      out[to] = CONCRETE;
      concrete = 1;
    } else {
      return null; // same material, 1 and 1/2: the levels 3/4 + 3/4 are not allowed, gate stays shut
    }
    if (events) events.push({ kind: 'side', from, to, amount: 1, mat: mf, concrete: concrete === 1, chain: false, cells: out.slice() });
    return { cells: out, cost: 1 + concrete * this.concretePenalty, concrete, s: 0, s2: 0 };
  }

  /** Top-down gate under box (row, col). The last row's gate is the outlet. */
  #vertical(cells, col, row, events) {
    const u = row * 2 + col;
    const cu = cells[u];
    const lu = LEVEL[cu];
    if (lu === 0 || cu === CONCRETE) return null;
    const out = cells.slice();
    const tally = { concrete: 0 };
    let moved;
    if (row === this.rows - 1) {
      out[u] = EMPTY;
      moved = lu;
      if (events) events.push({ kind: 'out', from: u, to: -1, amount: lu, mat: MAT[cu], concrete: false, chain: false, cells: out.slice() });
    } else {
      moved = this.#pour(out, u, u + 2, tally, events, false);
      if (moved === 0) return null;
    }

    // Doors above open at the same moment as the gate itself; s' below is read after everything fell.
    if (moved > 0) {
      if (this.chain === 'press') { if (lu === 2) this.#follow(out, col, row, tally, events); }
      else if (this.chain === 'always') this.#settle(out, col, row, tally, events);
    }

    const s2 = LEVEL[out[u]];
    return {
      cells: out,
      cost: 1 + 2 * (lu + s2) + tally.concrete * this.concretePenalty, // 1 + 4 (s + s') with s in units
      concrete: tally.concrete,
      s: lu,
      s2,
    };
  }

  /** Let box `a` flow into the box `b` right below it. Returns the amount moved (half-units). */
  #pour(out, a, b, tally, events, chain) {
    const ca = out[a];
    const la = LEVEL[ca];
    if (la === 0 || ca === CONCRETE) return 0;
    const cb = out[b];
    if (cb === CONCRETE) return 0;
    const lb = LEVEL[cb];
    const p = Math.min(la, 2 - lb);
    if (p === 0) return 0;
    const ma = MAT[ca];
    out[a] = cellCode(ma, la - p);
    const reacts = lb > 0 && MAT[cb] !== ma;
    if (reacts) {
      out[b] = CONCRETE;
      tally.concrete++;
    } else {
      out[b] = cellCode(ma, lb + p);
    }
    if (events) events.push({ kind: 'pour', from: a, to: b, amount: p, mat: ma, concrete: reacts, chain, cells: out.slice() });
    return p;
  }

  /**
   * Doors pressed from both sides. The box at `row` was full, so the door on top of it opens and
   * the box above pours in; that box's own top door opens only if it was full too, and so on.
   */
  #follow(out, col, row, tally, events) {
    for (let r = row; r > 0; r--) {
      const a = (r - 1) * 2 + col;
      const above = out[a];
      if (above === EMPTY || above === CONCRETE) break;
      const wasFull = LEVEL[above] === 2;
      this.#pour(out, a, a + 2, tally, events, true);
      if (!wasFull) break;
    }
  }

  /** 'always' rule: the whole unbroken pile directly above `row` settles down under gravity. */
  #settle(out, col, row, tally, events) {
    let top = row;
    while (top > 0) {
      const c = out[(top - 1) * 2 + col];
      if (c === EMPTY || c === CONCRETE) break;
      top--;
    }
    let moved = true;
    while (moved) {
      moved = false;
      for (let r = row - 1; r >= top; r--) {
        if (this.#pour(out, r * 2 + col, (r + 1) * 2 + col, tally, events, true) > 0) moved = true;
      }
    }
  }

  /** All state-changing actions from `cells`: [{a, s, c}] with s the encoded successor. */
  successors(cells) {
    const list = [];
    for (let id = 0; id < this.actions.length; id++) {
      const r = this.apply(cells, id);
      if (r) list.push({ a: id, s: this.encode(r.cells), c: r.cost });
    }
    return list;
  }

  // ------------------------------------------------------------------ helpers

  /** Total sand in the grid, in half-units. */
  sand(cells) {
    let t = 0;
    for (let i = 0; i < this.size; i++) if (MAT[cells[i]] === SAND) t += LEVEL[cells[i]];
    return t;
  }

  count(cells, mat) {
    let n = 0;
    for (let i = 0; i < this.size; i++) if (MAT[cells[i]] === mat) n++;
    return n;
  }

  empty() { return new Uint8Array(this.size); }

  /** Random initial state, each cell drawn independently. */
  random(probs = PROBS_SAND, rng = Math.random) {
    const cells = new Uint8Array(this.size);
    const order = [[EMPTY, probs.empty], [SAND_HALF, probs.sandHalf], [SAND_FULL, probs.sandFull], [WATER_HALF, probs.waterHalf || 0], [WATER_FULL, probs.waterFull || 0]];
    const total = order.reduce((s, [, p]) => s + p, 0) || 1;
    for (let i = 0; i < this.size; i++) {
      let x = rng() * total;
      let pick = EMPTY;
      for (const [codeValue, p] of order) {
        if (x < p) { pick = codeValue; break; }
        x -= p;
      }
      cells[i] = pick;
    }
    return cells;
  }
}

// ------------------------------------------------------------------- text I/O

const TOKENS = new Map([
  ['0', EMPTY], ['.', EMPTY], ['_', EMPTY],
  ['½', SAND_HALF], ['0.5', SAND_HALF], ['.5', SAND_HALF], ['1/2', SAND_HALF], ['h', SAND_HALF],
  ['1', SAND_FULL],
  ['w', WATER_HALF], ['W', WATER_FULL],
  ['#', CONCRETE], ['C', CONCRETE],
]);
const GLYPH = ['0', '½', '1', 'w', 'W', '#'];

/** Parse "1 0 / 0 1 / ½ W" (rows separated by newlines or '/'). */
export function parseGrid(text) {
  const rows = text.split(/[\n/]+/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[\s,]+/));
  const cells = new Uint8Array(rows.length * 2);
  rows.forEach((tokens, r) => {
    if (tokens.length !== 2) throw new SyntaxError(`row ${r + 1} must have exactly 2 cells`);
    tokens.forEach((t, c) => {
      if (!TOKENS.has(t)) throw new SyntaxError(`unknown cell "${t}" (use 0, ½, 1, w, W, #)`);
      cells[r * 2 + c] = TOKENS.get(t);
    });
  });
  return cells;
}

export function formatGrid(cells, sep = '\n') {
  const lines = [];
  for (let i = 0; i < cells.length; i += 2) lines.push(`${GLYPH[cells[i]]} ${GLYPH[cells[i + 1]]}`);
  return lines.join(sep);
}

/** Small deterministic PRNG (mulberry32) so experiments are reproducible. */
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The 4x2 example given with the assignment. */
export const PROFESSOR_EXAMPLE = '1 0 / 0 1 / 0 1 / 1 0';
