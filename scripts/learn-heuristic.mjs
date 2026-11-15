#!/usr/bin/env node
// Learn a heuristic by linear regression (Assignment 2).
//
// For every reachable state of the rows×2 grid we know the true cost-to-go h* (value iteration
// over the whole state graph). We fit h* ≈ w · features(state) by ordinary least squares, report how
// good the fit is and how often it overestimates, and write the coefficients to js/core/learned.js
// so that the heuristic is available to A* in the page and in the scripts.
//
//   node scripts/learn-heuristic.mjs            train on 5×2, also report the 4×2 → 5×2 transfer
//   node scripts/learn-heuristic.mjs --rows 4   train on another size

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sandbox } from '../js/core/model.js';
import { buildGraph, solveGraph } from '../js/core/analysis.js';
import { features, FEATURE_NAMES } from '../js/core/features.js';
import { HEURISTICS } from '../js/core/heuristics.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const rows = Number(args[args.indexOf('--rows') + 1]) || 5;

/** Feature matrix and target vector for every non-goal reachable state (goal states have h* = 0 and h = 0 by definition). */
function dataset(r) {
  const model = new Sandbox({ rows: r });
  const graph = buildGraph(model);
  const { opt } = solveGraph(graph);
  const X = [];
  const y = [];
  const initial = [];
  const h2 = [];
  for (let i = 0; i < graph.N; i++) {
    if (graph.goal[i]) continue;
    const state = graph.stateOf(i);
    X.push(features(model, state));
    y.push(opt[i]);
    initial.push(i < graph.N0);
    h2.push(HEURISTICS.gap.fn(model, state));
  }
  return { model, graph, X, y, initial, h2 };
}

/** Ordinary least squares by the normal equations (13 unknowns: Gaussian elimination is plenty). */
function leastSquares(X, y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Float64Array(k + 1));
  for (let n = 0; n < X.length; n++) {
    const f = X[n];
    for (let i = 0; i < k; i++) {
      const fi = f[i];
      if (fi === 0) continue;
      const row = A[i];
      for (let j = 0; j < k; j++) row[j] += fi * f[j];
      row[k] += fi * y[n];
    }
  }
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-9) { A[c][c] = 1e-9; } // a feature that never varies: weight ends up 0
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const m = A[r][c] / A[c][c];
      if (m === 0) continue;
      for (let j = c; j <= k; j++) A[r][j] -= m * A[c][j];
    }
  }
  return Array.from({ length: k }, (_, i) => A[i][k] / A[i][i]);
}

function predict(w, f) {
  let h = 0;
  for (let i = 0; i < f.length; i++) h += w[i] * f[i];
  return h > 0 ? h : 0;
}

/** Safe variant: the regression shifted down by its worst overestimate, but never below the proven bound h₂. */
function predictSafe(w, f, shift, h2) {
  return Math.max(h2, predict(w, f) - shift);
}

function evaluate(w, X, y, mask, safe = null) {
  let n = 0; let se = 0; let ae = 0; let over = 0; let overSum = 0; let maxOver = 0; let maxRatio = 0; let sy = 0; let sumRatio = 0; let exact = 0;
  for (let i = 0; i < X.length; i++) {
    if (mask && !mask[i]) continue;
    const h = safe ? predictSafe(w, X[i], safe.shift, safe.h2[i]) : predict(w, X[i]);
    const t = y[i];
    n++;
    se += (h - t) ** 2;
    ae += Math.abs(h - t);
    sy += t;
    if (h > t + 1e-9) { over++; overSum += h - t; if (h - t > maxOver) maxOver = h - t; }
    if (t > 0) { const r = h / t; if (r > maxRatio) maxRatio = r; sumRatio += r; }
    if (Math.abs(h - t) < 0.5) exact++;
  }
  const mean = sy / n;
  let sst = 0;
  for (let i = 0; i < X.length; i++) { if (mask && !mask[i]) continue; sst += (y[i] - mean) ** 2; }
  return {
    states: n, rmse: Math.sqrt(se / n), mae: ae / n, r2: 1 - se / sst,
    overestimates: over, overestimateShare: over / n, meanOverestimate: over ? overSum / over : 0, maxOverestimate: maxOver,
    maxRatio, meanRatio: sumRatio / n, withinHalf: exact / n,
  };
}

const t0 = Date.now();
console.log(`Training on every reachable state of the ${rows}×2 grid…`);
const train = dataset(rows);
const w = leastSquares(train.X, train.y);
console.log(`  ${train.X.length} states, ${FEATURE_NAMES.length} features, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const all = evaluate(w, train.X, train.y);
const initialOnly = evaluate(w, train.X, train.y, train.initial);
const safeShift = all.maxOverestimate;
const safeAll = evaluate(w, train.X, train.y, null, { shift: safeShift, h2: train.h2 });
const safeInitial = evaluate(w, train.X, train.y, train.initial, { shift: safeShift, h2: train.h2 });
const h2Only = evaluate(new Array(FEATURE_NAMES.length).fill(0), train.X, train.y, null, { shift: 0, h2: train.h2 });

console.log('\nCoefficients:');
FEATURE_NAMES.forEach((name, i) => console.log(`  ${w[i].toFixed(4).padStart(10)}  ${name}`));
const show = (label, m) => console.log(`${label.padEnd(40)} R² ${m.r2.toFixed(4)}  RMSE ${m.rmse.toFixed(2)}  MAE ${m.mae.toFixed(2)}  overestimates ${(100 * m.overestimateShare).toFixed(1)}% (mean +${m.meanOverestimate.toFixed(2)}, max +${m.maxOverestimate.toFixed(2)})  max h/h* ${m.maxRatio.toFixed(3)}  mean h/h* ${m.meanRatio.toFixed(3)}`);
console.log('');
show('h₄: all reachable states', all);
show('h₄: initial states only', initialOnly);
show(`h₅ = max(h₂, h₄ − ${safeShift.toFixed(2)}): all states`, safeAll);
show('h₅: initial states', safeInitial);
show('h₂ alone, for comparison', h2Only);

// transfer: a model trained on a smaller grid, evaluated here
let transfer = null;
if (rows > 2) {
  const small = dataset(rows - 1);
  const ws = leastSquares(small.X, small.y);
  transfer = { trainedOn: `${rows - 1}×2`, weights: ws, onTraining: evaluate(ws, small.X, small.y), onTarget: evaluate(ws, train.X, train.y) };
  show(`trained on ${rows - 1}×2, tested on ${rows}×2`, transfer.onTarget);
}

// a deterministic sample of states for the scatter plots of the page: [h*, h2, h4, h5]
const sample = [];
for (let i = 0; i < train.X.length; i += Math.max(1, Math.floor(train.X.length / 4000))) {
  sample.push([train.y[i], train.h2[i], Number(predict(w, train.X[i]).toFixed(2)), Number(predictSafe(w, train.X[i], safeShift, train.h2[i]).toFixed(2))]);
}
const metrics = { rows, states: train.X.length, all, initialOnly, safeShift, safeAll, safeInitial, h2Only, transfer, sample, trainedAt: new Date().toISOString() };
writeFileSync(resolve(root, 'data/a2-regression.json'), JSON.stringify({ names: FEATURE_NAMES, weights: w, ...metrics }, null, 1));
writeFileSync(resolve(root, 'js/core/learned.js'), `// Coefficients of the learned heuristic. Written by scripts/learn-heuristic.mjs — do not edit by hand.
// Trained ${metrics.trainedAt} on the ${train.X.length} non-goal reachable states of the ${rows}×2 grid.
export const LEARNED = {
  trainedOn: '${rows}×2',
  names: ${JSON.stringify(FEATURE_NAMES)},
  weights: ${JSON.stringify(w.map((x) => Number(x.toFixed(6))))},
  safeShift: ${safeShift.toFixed(6)},
  metrics: ${JSON.stringify({ r2: all.r2, rmse: all.rmse, mae: all.mae, overestimateShare: all.overestimateShare, maxRatio: all.maxRatio })},
};
`);
console.log('\nWrote js/core/learned.js and data/a2-regression.json');
