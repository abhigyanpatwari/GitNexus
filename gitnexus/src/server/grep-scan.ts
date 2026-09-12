/**
 * Filesystem grep scan used by GET /api/grep.
 *
 * Matching runs in a worker_threads worker (see grep-worker.ts) so a
 * catastrophic `regex.test()` can be killed with terminate() when the
 * wall-clock budget expires. The parent event loop stays responsive.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

export interface GrepHit {
  filePath: string;
  line: number;
  text: string;
}

export interface GrepScanInput {
  repoRoot: string;
  /** Repo-relative paths already filtered by fileFilter. */
  filePaths: string[];
  pattern: string;
  flags: string;
  limit: number;
  /** Absolute Date.now() deadline. */
  deadlineMs: number;
}

export interface GrepScanResult {
  results: GrepHit[];
  timedOut: boolean;
}

export type GrepProgress = (partial: GrepScanResult) => void;

export async function scanGrepFiles(
  input: GrepScanInput,
  onProgress?: GrepProgress,
): Promise<GrepScanResult> {
  const regex = new RegExp(input.pattern, input.flags);
  const results: GrepHit[] = [];
  const repoRoot = path.resolve(input.repoRoot);
  const safeRepoRoot = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;

  let timedOut = false;
  files: for (const filePath of input.filePaths) {
    if (results.length >= input.limit) break;
    if (Date.now() > input.deadlineMs) {
      timedOut = true;
      break;
    }
    const fullPath = path.resolve(repoRoot, filePath);
    if (!fullPath.startsWith(safeRepoRoot) && fullPath !== repoRoot) continue;

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= input.limit) break files;
      if ((i & 255) === 0 && Date.now() > input.deadlineMs) {
        timedOut = true;
        break files;
      }
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        results.push({ filePath, line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
    onProgress?.({ results: results.slice(), timedOut });
  }

  return { results, timedOut };
}

const _require = createRequire(import.meta.url);

export function grepWorkerPath(): string {
  const callerPath = fileURLToPath(import.meta.url);
  const isDev = callerPath.endsWith('.ts');
  return path.join(path.dirname(callerPath), isDev ? 'grep-worker.ts' : 'grep-worker.js');
}

export function runGrepScanInWorker(input: GrepScanInput): Promise<GrepScanResult> {
  const callerPath = fileURLToPath(import.meta.url);
  const isDev = callerPath.endsWith('.ts');
  const tsxHookArgs: string[] = isDev
    ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href]
    : [];

  return new Promise((resolve, reject) => {
    let settled = false;
    let latest: GrepScanResult = { results: [], timedOut: false };
    const worker = new Worker(grepWorkerPath(), {
      workerData: input,
      execArgv: tsxHookArgs,
    });

    const finish = (result: GrepScanResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };

    const remain = Math.max(1, input.deadlineMs - Date.now());
    const timer = setTimeout(() => {
      finish({ results: latest.results, timedOut: true });
    }, remain);

    worker.on('message', (msg: { type: string } & GrepScanResult) => {
      if (msg.type === 'progress') {
        latest = { results: msg.results, timedOut: msg.timedOut };
        return;
      }
      if (msg.type === 'done') {
        finish({ results: msg.results, timedOut: msg.timedOut });
      }
    });
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      reject(err);
    });
    worker.on('exit', () => {
      if (settled) return;
      finish({ results: latest.results, timedOut: true });
    });
  });
}
