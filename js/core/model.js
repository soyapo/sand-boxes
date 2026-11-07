// Sand Boxes — environment model (state, physics, actions, cost).
//
// The grid has `rows` rows and 2 columns. Cell index = row * 2 + col, row 0 is the top.
// Every cell holds one of six codes. Levels are stored in half-units (0, 1, 2 = 0, 1/2, 1).
//
// A state is { cells, gates }: the cell codes plus a bit mask of the top-down gates that are
// currently open (bit i = the gate under cell i; the gates under the bottom row are the outlets).

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

/** The most rows the simulator supports: a state must still fit in one JavaScript number. */
export const MAX_ROWS = 7;

/** Initial-state probabilities from the assignment (sand only) and a default mix with water. */
export const PROBS_SAND = Object.freeze({ empty: 0.5, sandHalf: 0.2, sandFull: 0.3, waterHalf: 0, waterFull: 0 });
export const PROBS_WATER = Object.freeze({ empty: 0.4, sandHalf: 0.15, sandFull: 0.2, waterHalf: 0.1, waterFull: 0.15 });

/** Does the box hold something that can flow (sand or water)? */
const flows = (code) => code !== EMPTY && code !== CONCRETE;

export class Sandbox {
  /**
   * @param {{rows?: number, concretePenalty?: number}} [opts]
   */
  constructor({ rows = 5, concretePenalty = 10 } = {}) {
    if (!(rows >= 1 && rows <= MAX_ROWS)) throw new RangeError(`rows must be between 1 and ${MAX_ROWS}`);
    this.rows = rows;
    this.size = rows * 2;
    this.concretePenalty = concretePenalty;
    this.gateSpace = 2 ** this.size; // number of possible gate masks

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
          cell: r * 2 + c,
          outlet,
          label: outlet ? `${side} outlet (row ${r + 1})` : `${side} gate ${r + 1}→${r + 2}`,
          short: `${side[0]}${r + 1}${outlet ? '⤓' : '↓'}`,
        });
      }
    }
  }

  sideAction(row) { return row; }
  verticalAction(col, row) { return this.rows + col * this.rows + row; }

  // ---------------------------------------------------------------- states

  /** A fresh state: the given cells, every gate closed. */
  initial(cells) { return { cells: Uint8Array.from(cells), gates: 0 }; }

  /** Pack a state into one number: cells in base 6, then the gate mask. Exact up to 7 rows. */
  encode(state) {
    const { cells } = state;
    let key = 0;
    for (let i = this.size - 1; i >= 0; i--) key = key * 6 + cells[i];
    return key * this.gateSpace + state.gates;
  }

  decode(key) {
    const gates = key % this.gateSpace;
    let rest = (key - gates) / this.gateSpace;
    const cells = new Uint8Array(this.size);
    for (let i = 0; i < this.size; i++) {
      cells[i] = rest % 6;
      rest = (rest - cells[i]) / 6;
    }
    return { cells, gates };
  }

  /** Is the top-down gate under cell i open? */
  isOpen(state, i) { return (state.gates & (1 << i)) !== 0; }

  /** Goal: no box contains sand (water, concrete and open gates do not matter). */
  isGoal(state) {
    const { cells } = state;
    for (let i = 0; i < this.size; i++) if (MAT[cells[i]] === SAND) return false;
    return true;
  }

  // ------------------------------------------------------------------ physics

  /**
   * Open one gate.
   * @param {{cells: Uint8Array, gates: number}} state   not modified
   * @param {number} id                                  action id
   * @param {Array|null} events  if given, receives one entry per elementary flow, for animation
   * @returns {null | {state, cost: number, concrete: number, s: number, s2: number}}
   *          null when the action would change nothing.
   */
  apply(state, id, events = null) {
    const act = this.actions[id];
    return act.type === 'b' ? this.#side(state, act.row, events) : this.#vertical(state, act.cell, events);
  }

  /**
   * Side gate. It closes again right after: a full box levels with an empty neighbour, or spills
   * into a half box of the other material. Whatever moved may then flow on through open gates.
   */
  #side(state, row, events) {
    const cells = state.cells;
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
    const tally = { concrete: 0 };
    const out = cells.slice();
    if (lt === 0) {
      out[from] = cellCode(mf, 1);
      out[to] = cellCode(mf, 1);
    } else if (mt !== mf) {
      // full box of one material pushes into a half box of the other: they set into concrete
      out[from] = cellCode(mf, 1);
      out[to] = CONCRETE;
      tally.concrete = 1;
    } else {
      return null; // same material, 1 and 1/2: the levels 3/4 + 3/4 are not allowed, gate stays shut
    }
    if (events) events.push({ kind: 'side', from, to, amount: 1, mat: mf, concrete: tally.concrete === 1, chain: false, cells: out.slice() });
    const gates = this.#settle(out, state.gates, tally, events);
    return { state: { cells: out, gates }, cost: 1 + tally.concrete * this.concretePenalty, concrete: tally.concrete, s: 0, s2: 0 };
  }

  /**
   * Top-down gate under cell u. It can only be opened when it is closed and the box above it
   * holds sand or water (otherwise it would close again at once). It then stays open: everything
   * that can flow through the open gates flows, at the same moment, until nothing moves any more.
   * Gates whose box above has become empty close again.
   */
  #vertical(state, u, events) {
    const cu = state.cells[u];
    if (!flows(cu) || this.isOpen(state, u)) return null;
    const out = state.cells.slice();
    const tally = { concrete: 0 };
    const lu = LEVEL[cu];
    if (events) events.push({ kind: 'open', from: u, to: -1, amount: 0, mat: MAT[cu], concrete: false, chain: false, cells: out.slice() });
    const gates = this.#settle(out, state.gates | (1 << u), tally, events);
    const s2 = LEVEL[out[u]];
    return {
      state: { cells: out, gates },
      cost: 1 + 2 * (lu + s2) + tally.concrete * this.concretePenalty, // 1 + 4 (s + s') with s in units
      concrete: tally.concrete,
      s: lu,
      s2,
    };
  }

  /** Let box `a` flow into the box `b` right below it. Returns the amount moved (half-units). */
  #pour(out, a, b, tally, events) {
    const ca = out[a];
    if (!flows(ca)) return 0;
    const cb = out[b];
    if (cb === CONCRETE) return 0;
    const la = LEVEL[ca];
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
    if (events) events.push({ kind: 'pour', from: a, to: b, amount: p, mat: ma, concrete: reacts, chain: true, cells: out.slice() });
    return p;
  }

  /**
   * Everything flows through the open gates until it has settled, then the gates with nothing
   * above them close. Returns the new gate mask.
   */
  #settle(out, gates, tally, events) {
    const bottom = (this.rows - 1) * 2;
    let moved = true;
    while (moved) {
      moved = false;
      for (let i = this.size - 1; i >= 0; i--) {
        if (!(gates & (1 << i))) continue;
        if (i >= bottom) {
          // outlet: whatever is in the bottom box leaves the grid
          const c = out[i];
          if (!flows(c)) continue;
          out[i] = EMPTY;
          moved = true;
          if (events) events.push({ kind: 'out', from: i, to: -1, amount: LEVEL[c], mat: MAT[c], concrete: false, chain: true, cells: out.slice() });
        } else if (this.#pour(out, i, i + 2, tally, events) > 0) {
          moved = true;
        }
      }
    }
    for (let i = 0; i < this.size; i++) if (!flows(out[i])) gates &= ~(1 << i);
    return gates;
  }

  /** All state-changing actions from `state`: [{a, s, c}] with s the encoded successor. */
  successors(state) {
    const list = [];
    for (let id = 0; id < this.actions.length; id++) {
      const r = this.apply(state, id);
      if (r) list.push({ a: id, s: this.encode(r.state), c: r.cost });
    }
    return list;
  }

  // ------------------------------------------------------------------ helpers

  /** Total sand in the grid, in half-units. */
  sand(state) {
    const cells = state.cells || state;
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

  /** Random initial cells, each drawn independently. */
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

/** "1 0 / ½ ½" with the open gates marked: a '-' line under a row means that gate is open. */
export function formatState(model, state) {
  const lines = [];
  for (let r = 0; r < model.rows; r++) {
    const i = r * 2;
    lines.push(`${GLYPH[state.cells[i]]} ${GLYPH[state.cells[i + 1]]}`);
    lines.push(`${model.isOpen(state, i) ? '-' : '_'} ${model.isOpen(state, i + 1) ? '-' : '_'}`);
  }
  return lines.join('\n');
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
