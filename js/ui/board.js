// Canvas view of the grid: draws boxes, sand, water, concrete and gates, animates flows,
// and reports clicks on gates and boxes.

import { LEVEL, MAT, SAND, WATER, SOLID, CONCRETE } from '../core/model.js';

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (t) => t * t * (3 - 2 * t);
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Board {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} wrap      positioned container (used for sizing and the tooltip)
   * @param {HTMLElement} tip       tooltip element inside `wrap`
   * @param {{onGate:(id:number)=>void, onCell:(index:number)=>void, onHover?:(id:number|null)=>void}} handlers
   */
  constructor(canvas, wrap, tip, handlers) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.wrap = wrap;
    this.tip = tip;
    this.handlers = handlers;
    this.model = null;
    this.state = null;
    this.available = new Map();
    this.hover = null;
    this.highlight = null;
    this.animToken = 0;
    this.busy = false;
    this.readTheme();

    canvas.addEventListener('pointermove', (e) => this.#pointer(e));
    canvas.addEventListener('pointerleave', () => this.#setHover(null));
    canvas.addEventListener('click', (e) => this.#click(e));
    new ResizeObserver(() => { if (this.model) { this.layout(); this.draw(); } }).observe(wrap);
  }

  readTheme() {
    this.colors = {
      wall: token('--wall'), box: token('--box'), sand: token('--sand'), sandDark: token('--sand-dark'),
      water: token('--water'), waterDark: token('--water-dark'), concrete: token('--concrete'), concreteDark: token('--concrete-dark'),
      gate: token('--gate'), gateOff: token('--gate-off'), ink: token('--ink'), muted: token('--muted'), surface: token('--surface'),
    };
    this.patterns = {
      sand: this.#speckle(this.colors.sand, this.colors.sandDark, 90),
      concrete: this.#bricks(this.colors.concrete, this.colors.concreteDark),
    };
    if (this.model) this.draw();
  }

  #speckle(base, dark, n) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, 64, 64);
    for (let i = 0; i < n; i++) {
      g.globalAlpha = 0.25 + hash(i * 3.1) * 0.5;
      g.fillStyle = hash(i * 5.3) > 0.35 ? dark : '#ffffff';
      g.beginPath();
      g.arc(hash(i) * 64, hash(i + 77.7) * 64, 0.6 + hash(i * 9.9) * 0.9, 0, 6.3);
      g.fill();
    }
    return this.ctx.createPattern(c, 'repeat');
  }

  #bricks(base, dark) {
    const c = document.createElement('canvas');
    c.width = 28;
    c.height = 20;
    const g = c.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, 28, 20);
    g.strokeStyle = dark;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, 0.75); g.lineTo(28, 0.75);
    g.moveTo(0, 10.75); g.lineTo(28, 10.75);
    g.moveTo(7, 0); g.lineTo(7, 10);
    g.moveTo(21, 10); g.lineTo(21, 20);
    g.stroke();
    return this.ctx.createPattern(c, 'repeat');
  }

  setModel(model) {
    this.model = model;
    this.cancel();
    this.layout();
  }

  /** Recompute geometry for the current model and container width. */
  layout() {
    const rows = this.model.rows;
    const avail = Math.max(250, this.wrap.clientWidth);
    const wall = 8;
    const padX = 30;
    const padT = 8;
    const tray = 34;
    let cellH = Math.max(44, Math.min(92, Math.floor(500 / rows)));
    const cellW = Math.max(70, Math.min(156, Math.round(cellH * 1.7), Math.floor((avail - 2 * padX - 3 * wall) / 2)));
    cellH = Math.min(cellH, Math.round(cellW * 0.8));
    const W = 2 * padX + 2 * cellW + 3 * wall;
    const H = padT + rows * cellH + (rows + 1) * wall + tray;
    this.geo = { rows, wall, padX, padT, tray, cellW, cellH, W, H };

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.cellRects = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 2; c++) {
        this.cellRects.push({ x: padX + wall + c * (cellW + wall), y: padT + wall + r * (cellH + wall), w: cellW, h: cellH });
      }
    }
    this.gateRects = this.model.actions.map((a) => {
      if (a.type === 'b') {
        const cell = this.cellRects[a.row * 2];
        const gh = cellH * 0.5;
        return { x: cell.x + cellW, y: cell.y + cellH / 2 - gh / 2, w: wall, h: gh, vertical: false };
      }
      const cell = this.cellRects[a.row * 2 + a.col];
      const gw = cellW * 0.44;
      return { x: cell.x + cellW / 2 - gw / 2, y: cell.y + cellH, w: gw, h: wall, vertical: true };
    });
  }

  /** Show a state ({ cells, gates }) without animation. */
  show(state) {
    this.cancel();
    this.state = state;
    this.draw();
  }

  /** Map of action id -> cost for the gates that would move something. */
  setAvailable(map) {
    this.available = map;
    this.draw();
  }

  setHighlight(id) {
    this.highlight = id;
    if (!this.busy) this.draw();
  }

  cancel() {
    this.animToken++;
    this.busy = false;
  }

  /**
   * Animate one action: the gate opens, everything that flows through the open gates moves at the
   * same moment, then the gates with nothing left above them close.
   * @returns {Promise<boolean>} false if the animation was cancelled
   */
  async animate(before, events, final, actionId, speed = 1) {
    const my = ++this.animToken;
    this.busy = true;
    if (reducedMotion() || !events.length) {
      await this.#tween(160 / speed, my, () => {});
    } else {
      const flows = events.filter((ev) => ev.kind !== 'open').map((ev) => ({ ev, gate: this.#gateOf(ev) }));
      const base = { flows, prev: before, final, action: actionId };
      await this.#tween(130 / speed, my, (t) => this.draw(before, { ...base, open: ease(t), flow: 0, closing: 0 }));
      await this.#tween(flows.length ? 520 / speed : 200 / speed, my, (t) => this.draw(before, { ...base, open: 1, flow: t, closing: 0 }));
      await this.#tween(110 / speed, my, (t) => this.draw(final, { ...base, open: 1, flow: 1, closing: ease(t) }));
    }
    if (my !== this.animToken) return false;
    this.busy = false;
    this.state = final;
    this.draw();
    return true;
  }

  #gateOf(ev) {
    if (ev.kind === 'side') return this.model.sideAction(ev.from >> 1);
    return this.model.verticalAction(ev.from & 1, ev.from >> 1);
  }

  #tween(ms, my, frame) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = (now) => {
        if (my !== this.animToken) return resolve(false);
        const t = ms <= 0 ? 1 : clamp01((now - t0) / ms);
        frame(t);
        if (t < 1) requestAnimationFrame(step); else resolve(true);
      };
      requestAnimationFrame(step);
    });
  }

  // ------------------------------------------------------------------ drawing

  draw(state = this.state, overlay = null) {
    if (!state || !this.geo) return;
    const { cells } = state;
    const { ctx, geo, colors } = this;
    const { wall, padX, padT, cellW, cellH, rows, W, H } = geo;
    const now = performance.now();
    ctx.clearRect(0, 0, W, H);

    // frame
    ctx.fillStyle = colors.wall;
    this.#roundRect(padX, padT, 2 * cellW + 3 * wall, rows * cellH + (rows + 1) * wall, 9);
    ctx.fill();

    // boxes and their content
    for (let i = 0; i < cells.length; i++) {
      const rect = this.cellRects[i];
      ctx.fillStyle = colors.box;
      this.#roundRect(rect.x, rect.y, rect.w, rect.h, 3);
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
      const was = overlay ? overlay.prev.cells[i] : cells[i];
      const will = overlay ? overlay.final.cells[i] : cells[i];
      if (overlay && was !== will) {
        const t = ease(overlay.flow);
        if (will === CONCRETE) {
          this.#fill(rect, MAT[was], LEVEL[was], 1, now);
          this.#fill(rect, SOLID, 2, clamp01((overlay.flow - 0.5) / 0.5), now);
        } else if (was !== 0 && will !== 0 && MAT[was] !== MAT[will]) {
          // one material drains out completely while another arrives from above
          if (t < 0.5) this.#fill(rect, MAT[was], LEVEL[was] * (1 - 2 * t), 1, now);
          else this.#fill(rect, MAT[will], LEVEL[will] * (2 * t - 1), 1, now);
        } else {
          const a = LEVEL[was];
          this.#fill(rect, was !== 0 ? MAT[was] : MAT[will], a + (LEVEL[will] - a) * t, 1, now);
        }
      } else {
        this.#fill(rect, MAT[cells[i]], LEVEL[cells[i]], 1, 0);
      }
      ctx.restore();
      this.#levelLabel(rect, overlay && was !== will && overlay.flow < 1 ? was : cells[i]);
    }

    // gates: top-down gates stay open while there is material above them
    for (let id = 0; id < this.gateRects.length; id++) {
      const act = this.model.actions[id];
      let open = 0;
      let dir = 1;
      if (act.type === 'a') {
        const wasOpen = (overlay ? overlay.prev : state).gates & (1 << act.cell);
        const willOpen = (overlay ? overlay.final : state).gates & (1 << act.cell);
        if (!overlay) open = wasOpen ? 1 : 0;
        else if (wasOpen) open = willOpen ? 1 : 1 - overlay.closing;
        else if (id === overlay.action) open = willOpen ? overlay.open : overlay.open * (1 - overlay.closing);
      } else if (overlay && id === overlay.action) {
        const side = overlay.flows.find((f) => f.ev.kind === 'side');
        dir = side && side.ev.to < side.ev.from ? -1 : 1;
        open = overlay.open * (1 - overlay.closing);
      }
      this.#gate(id, open, dir);
    }

    // row numbers and outlet marks
    ctx.fillStyle = colors.muted;
    ctx.font = '600 11.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < rows; r++) ctx.fillText(String(r + 1), padX / 2, this.cellRects[r * 2].y + cellH / 2);
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let c = 0; c < 2; c++) {
      const g = this.gateRects[this.model.verticalAction(c, rows - 1)];
      const cx = g.x + g.w / 2;
      const y = g.y + wall + 12;
      ctx.beginPath();
      ctx.moveTo(cx - 6, y); ctx.lineTo(cx, y + 6); ctx.lineTo(cx + 6, y);
      ctx.moveTo(cx - 6, y + 8); ctx.lineTo(cx, y + 14); ctx.lineTo(cx + 6, y + 8);
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (overlay && overlay.flow > 0 && overlay.flow < 1) {
      for (const f of overlay.flows) this.#particles(f, overlay, now);
    }
  }

  #roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  #fill(rect, mat, level, alpha, time) {
    if (level <= 0 || alpha <= 0 || mat === 0) return;
    const { ctx, colors } = this;
    const h = (level / 2) * rect.h;
    const top = rect.y + rect.h - h;
    ctx.globalAlpha = alpha;
    if (mat === SOLID) {
      ctx.fillStyle = this.patterns.concrete;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    } else if (mat === SAND) {
      const bump = level >= 2 ? 0 : 4;
      ctx.beginPath();
      ctx.moveTo(rect.x, rect.y + rect.h);
      ctx.lineTo(rect.x, top + bump);
      ctx.quadraticCurveTo(rect.x + rect.w / 2, top - bump, rect.x + rect.w, top + bump);
      ctx.lineTo(rect.x + rect.w, rect.y + rect.h);
      ctx.closePath();
      ctx.fillStyle = this.patterns.sand;
      ctx.fill();
      if (bump) {
        ctx.strokeStyle = colors.sandDark;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(rect.x, top + bump);
        ctx.quadraticCurveTo(rect.x + rect.w / 2, top - bump, rect.x + rect.w, top + bump);
        ctx.stroke();
      }
    } else if (mat === WATER) {
      const amp = level >= 2 ? 0 : 2.2;
      const phase = time / 260;
      ctx.beginPath();
      ctx.moveTo(rect.x, rect.y + rect.h);
      for (let k = 0; k <= 12; k++) {
        const x = rect.x + (rect.w * k) / 12;
        ctx.lineTo(x, top + Math.sin(phase + k * 1.1) * amp);
      }
      ctx.lineTo(rect.x + rect.w, rect.y + rect.h);
      ctx.closePath();
      ctx.fillStyle = colors.water;
      ctx.globalAlpha = alpha * 0.85;
      ctx.fill();
      ctx.globalAlpha = alpha * 0.35;
      ctx.fillStyle = colors.waterDark;
      ctx.fillRect(rect.x, top + h * 0.55, rect.w, h * 0.45);
    }
    ctx.globalAlpha = 1;
  }

  #levelLabel(rect, code) {
    if (code === 0) return;
    const { ctx, colors } = this;
    const text = code === CONCRETE ? 'concrete' : `${LEVEL[code] === 2 ? '1' : '½'}${MAT[code] === WATER ? ' water' : ''}`;
    ctx.font = '600 11.5px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const w = ctx.measureText(text).width + 10;
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = colors.surface;
    this.#roundRect(rect.x + 5, rect.y + 5, w, 17, 5);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.ink;
    ctx.fillText(text, rect.x + 10, rect.y + 8);
  }

  #gate(id, open, dir) {
    const { ctx, colors } = this;
    const g = this.gateRects[id];
    const enabled = this.available.has(id);
    const hot = !this.busy && enabled && (this.hover === id || this.highlight === id);
    const color = enabled || open > 0 ? colors.gate : colors.gateOff;
    // the opening itself
    ctx.fillStyle = colors.box;
    ctx.fillRect(g.x, g.y, g.w, g.h);
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineWidth = hot ? 6 : 4;
    const angle = open * 1.35;
    ctx.beginPath();
    if (g.vertical) {
      const y = g.y + g.h / 2;
      const half = g.w / 2 - 1;
      ctx.moveTo(g.x, y);
      ctx.lineTo(g.x + Math.cos(angle) * half, y + Math.sin(angle) * half);
      ctx.moveTo(g.x + g.w, y);
      ctx.lineTo(g.x + g.w - Math.cos(angle) * half, y + Math.sin(angle) * half);
    } else {
      const x = g.x + g.w / 2;
      const half = g.h / 2 - 1;
      ctx.moveTo(x, g.y);
      ctx.lineTo(x + dir * Math.sin(angle) * half, g.y + Math.cos(angle) * half);
      ctx.moveTo(x, g.y + g.h);
      ctx.lineTo(x + dir * Math.sin(angle) * half, g.y + g.h - Math.cos(angle) * half);
    }
    ctx.stroke();
    if (hot) {
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = colors.gate;
      const pad = 7;
      this.#roundRect(g.x - pad, g.y - pad, g.w + 2 * pad, g.h + 2 * pad, 8);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  #particles(flowItem, overlay, now) {
    const { ctx, colors, geo } = this;
    const ev = flowItem.ev;
    const g = this.gateRects[flowItem.gate];
    ctx.fillStyle = ev.mat === WATER ? colors.water : colors.sandDark;
    const n = 30;
    const fade = Math.min(1, overlay.flow * 6, (1 - overlay.flow) * 6);
    for (let k = 0; k < n; k++) {
      const u = (hash(k) + now * 0.0021) % 1;
      const jitter = hash(k + 40.5) - 0.5;
      let x;
      let y;
      if (ev.kind === 'side') {
        const dir = ev.to > ev.from ? 1 : -1;
        const dest = this.cellRects[ev.to];
        const y0 = g.y + g.h / 2 + jitter * g.h * 0.5;
        const floor = dest.y + dest.h - (LEVEL[overlay.prev.cells[ev.to]] / 2) * dest.h;
        x = g.x + g.w / 2 + dir * u * geo.cellW * 0.42;
        y = y0 + u * u * Math.max(0, floor - y0);
      } else {
        const y0 = g.y;
        let y1;
        if (ev.to < 0) y1 = g.y + geo.wall + geo.tray;
        else {
          const dest = this.cellRects[ev.to];
          y1 = dest.y + dest.h - (LEVEL[overlay.prev.cells[ev.to]] / 2) * dest.h;
        }
        x = g.x + g.w / 2 + jitter * g.w * 0.6;
        y = y0 + u * u * (y1 - y0);
      }
      ctx.globalAlpha = fade * (0.55 + hash(k + 9.1) * 0.45);
      ctx.beginPath();
      ctx.arc(x, y, 1.5 + hash(k + 3.3) * 1.3, 0, 6.3);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------- interaction

  #locate(e) {
    const box = this.canvas.getBoundingClientRect();
    const sx = this.geo.W / box.width;
    const x = (e.clientX - box.left) * sx;
    const y = (e.clientY - box.top) * sx;
    const pad = 9;
    for (let id = 0; id < this.gateRects.length; id++) {
      const g = this.gateRects[id];
      if (x >= g.x - pad && x <= g.x + g.w + pad && y >= g.y - pad && y <= g.y + g.h + pad) return { gate: id, x, y };
    }
    for (let i = 0; i < this.cellRects.length; i++) {
      const c = this.cellRects[i];
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return { cell: i, x, y };
    }
    return { x, y };
  }

  #pointer(e) {
    if (!this.geo) return;
    const hit = this.#locate(e);
    this.#setHover(hit.gate ?? null);
    this.canvas.style.cursor = hit.gate !== undefined ? (this.available.has(hit.gate) ? 'pointer' : 'not-allowed') : hit.cell !== undefined ? 'cell' : 'default';
    if (hit.gate !== undefined) {
      const act = this.model.actions[hit.gate];
      const cost = this.available.get(hit.gate);
      this.tip.textContent = cost === undefined ? `${act.label} — nothing would move` : `${act.label} — cost ${cost}`;
      const g = this.gateRects[hit.gate];
      const scale = this.canvas.getBoundingClientRect().width / this.geo.W;
      this.tip.style.left = `${this.canvas.offsetLeft + (g.x + g.w / 2) * scale}px`;
      this.tip.style.top = `${this.canvas.offsetTop + g.y * scale}px`;
      this.tip.hidden = false;
    } else {
      this.tip.hidden = true;
    }
  }

  #setHover(id) {
    if (id === null) this.tip.hidden = true;
    if (this.hover === id) return;
    this.hover = id;
    this.handlers.onHover?.(id);
    if (!this.busy) this.draw();
  }

  #click(e) {
    const hit = this.#locate(e);
    if (hit.gate !== undefined) {
      if (this.available.has(hit.gate)) this.handlers.onGate(hit.gate);
    } else if (hit.cell !== undefined) {
      this.handlers.onCell(hit.cell);
    }
  }
}
