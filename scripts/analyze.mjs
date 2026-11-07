#!/usr/bin/env node
// Batch evaluation of all search algorithms. Writes the JSON files the web page reads.
//
//   node scripts/analyze.mjs                      regenerate every dataset listed in PRESETS
//   node scripts/analyze.mjs --rows 5             all 3^10 = 59,049 sand-only states of a 5x2 grid
//   node scripts/analyze.mjs --rows 5 --sample 2000 --seed 7
//   node scripts/analyze.mjs --random --water --rows 5 --count 1000
//
// Options: --workers N   --out file.json   --penalty 10

import { Worker } from 'node:worker_threads';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createRunner, createCollector } from '../js/core/analysis.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PRESETS = [
  { file: 'exhaustive-2x2.json', title: '2×2 grid — all 81 states', cfg: { kind: 'exhaustive', rows: 2 } },
  { file: 'exhaustive-3x2.json', title: '3×2 grid — all 729 states', cfg: { kind: 'exhaustive', rows: 3 } },
  { file: 'exhaustive-4x2.json', title: '4×2 grid — all 6,561 states', cfg: { kind: 'exhaustive', rows: 4 } },
  { file: 'water-5x2.json', title: '5×2 grid with water — 1,000 random instances', cfg: { kind: 'random', rows: 5, water: true, count: 1000, seed: 1 } },
  { file: 'exhaustive-5x2.json', title: '5×2 grid — all 59,049 states', cfg: { kind: 'exhaustive', rows: 5 }, primary: true },
];

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const name = k.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) a[name] = true; else { a[name] = v; i++; }
  }
  return a;
}

function runParallel(cfg, workers) {
  return new Promise((resolveRun, reject) => {
    const t0 = performance.now();
    const coordinator = createRunner(cfg); // only its ids and meta are used here
    const ids = coordinator.ids;
    const collector = createCollector();
    const chunk = cfg.kind === 'random' ? 4 : 64;
    const n = Math.max(1, Math.min(workers, Math.ceil(ids.length / chunk)));
    let cursor = 0;
    let done = 0;
    let alive = n;
    let lastPrint = 0;
    const pool = [];
    const feed = (w) => {
      if (cursor >= ids.length) {
        w.terminate();
        if (--alive === 0) {
          process.stdout.write('\n');
          resolveRun(collector.result(coordinator.meta, { workers: n, wallSeconds: (performance.now() - t0) / 1000 }));
        }
        return;
      }
      w.postMessage({ type: 'run', ids: ids.slice(cursor, cursor + chunk) });
      cursor += chunk;
    };
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL('./analyze-worker.mjs', import.meta.url));
      pool.push(w);
      w.on('error', reject);
      w.on('message', (msg) => {
        if (msg.type === 'records') {
          for (const rec of msg.records) collector.add(rec);
          done += msg.records.length;
          const t = performance.now();
          if (t - lastPrint > 2000 || done === ids.length) {
            lastPrint = t;
            const secs = (t - t0) / 1000;
            const eta = done ? (secs / done) * (ids.length - done) : 0;
            process.stdout.write(`\r  ${done}/${ids.length} instances  ${secs.toFixed(0)}s elapsed  ~${eta.toFixed(0)}s left   `);
          }
        }
        feed(w);
      });
      w.postMessage({ type: 'init', cfg });
    }
  });
}

function save(file, data) {
  const path = resolve(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
  console.log(`  wrote ${file} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`);
}

const args = parseArgs(process.argv.slice(2));
const workers = Number(args.workers) || Math.max(1, Math.min(4, os.availableParallelism() - 1));
const cpu = `${os.cpus()[0]?.model || 'unknown CPU'}, ${os.cpus().length} logical cores`;

if (args.rows || args.random) {
  const cfg = {
    kind: args.random ? 'random' : 'exhaustive',
    rows: Number(args.rows) || 5,
    seed: Number(args.seed) || 1,
  };
  if (args.sample) cfg.sample = Number(args.sample);
  if (args.random) { cfg.water = !!args.water; cfg.count = Number(args.count) || 500; }
  if (args.penalty) cfg.concretePenalty = Number(args.penalty);
  console.log(`Running ${JSON.stringify(cfg)} on ${workers} workers`);
  const result = await runParallel(cfg, workers);
  result.meta.cpu = cpu;
  save(args.out || `data/custom-${cfg.kind}-${cfg.rows}x2.json`, result);
} else {
  const only = args.only ? String(args.only).split(',') : null;
  const manifest = [];
  for (const preset of PRESETS) {
    manifest.push({ file: preset.file, title: preset.title, primary: !!preset.primary });
    if (only && !only.includes(preset.file)) continue;
    console.log(`${preset.title} — ${workers} workers`);
    const result = await runParallel(preset.cfg, workers);
    result.meta.cpu = cpu;
    result.meta.title = preset.title;
    save(`data/${preset.file}`, result);
  }
  manifest.sort((a, b) => Number(b.primary) - Number(a.primary));
  save('data/index.json', manifest);
}
