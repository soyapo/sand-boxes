// Worker thread used by scripts/analyze.mjs. Each worker owns its own runner.
import { parentPort } from 'node:worker_threads';
import { createWorkerHandler } from '../js/core/analysis.js';

const handle = createWorkerHandler((msg) => parentPort.postMessage(msg));
parentPort.on('message', handle);
