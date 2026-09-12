import { parentPort, workerData } from 'node:worker_threads';
import type { GrepScanInput } from './grep-scan.js';

if (!parentPort) {
  throw new Error('grep-worker must run as a worker_threads worker');
}

const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const { scanGrepFiles } = await import(new URL(`./grep-scan${ext}`, import.meta.url).href);

const port = parentPort;
const input = workerData as GrepScanInput;
const out = await scanGrepFiles(input, (partial) => {
  port.postMessage({ type: 'progress', ...partial });
});
port.postMessage({ type: 'done', ...out });
