/**
 * Watch Command
 *
 * Keeps an indexed repository fresh while an agent or developer is editing.
 * This first pass is deliberately conservative: detect and batch file changes,
 * then trigger the existing analyzer. Later incremental graph patching can
 * replace the analyzer runner without changing the watch loop contract.
 */

import fs, { type FSWatcher } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { getGitRoot, hasGitDir } from '../storage/git.js';

interface WatchOptions {
  debounce?: string;
  poll?: boolean;
  interval?: string;
  skipInitial?: boolean;
  embeddings?: boolean;
  skipGit?: boolean;
  name?: string;
  maxFileSize?: string;
  workerTimeout?: string;
}

const DEFAULT_DEBOUNCE_MS = 1200;
const DEFAULT_POLL_INTERVAL_MS = 2000;

const IGNORED_DIRS = new Set([
  '.git',
  '.gitnexus',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'tmp',
  'temp',
]);

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

export function shouldIgnoreWatchPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized || normalized === '.') return false;
  return normalized.split('/').some((part) => IGNORED_DIRS.has(part));
}

async function walkSnapshot(
  root: string,
  dir: string = root,
  out: Map<string, number> = new Map(),
): Promise<Map<string, number>> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(root, fullPath).replace(/\\/g, '/');
    if (shouldIgnoreWatchPath(rel)) continue;

    if (entry.isDirectory()) {
      await walkSnapshot(root, fullPath, out);
      continue;
    }

    if (!entry.isFile()) continue;
    try {
      const stat = await fsp.stat(fullPath);
      out.set(rel, stat.mtimeMs);
    } catch {
      out.set(rel, -1);
    }
  }

  return out;
}

function diffSnapshots(prev: Map<string, number>, next: Map<string, number>): string[] {
  const changed = new Set<string>();
  for (const [rel, mtime] of next) {
    if (prev.get(rel) !== mtime) changed.add(rel);
  }
  for (const rel of prev.keys()) {
    if (!next.has(rel)) changed.add(rel);
  }
  return Array.from(changed).sort();
}

export function buildAnalyzeArgs(repoPath: string, options: WatchOptions): string[] {
  const args = [...process.execArgv, process.argv[1], 'analyze', repoPath];
  if (options.embeddings) args.push('--embeddings');
  if (options.skipGit) args.push('--skip-git');
  if (options.name) args.push('--name', options.name);
  if (options.maxFileSize) args.push('--max-file-size', options.maxFileSize);
  if (options.workerTimeout) args.push('--worker-timeout', options.workerTimeout);
  return args;
}

function runAnalyze(repoPath: string, options: WatchOptions): Promise<number> {
  const child = spawn(process.execPath, buildAnalyzeArgs(repoPath, options), {
    stdio: 'inherit',
    env: process.env,
  });
  currentAnalyze = child;

  return new Promise((resolve) => {
    child.on('close', (code) => {
      if (currentAnalyze === child) currentAnalyze = null;
      resolve(code ?? 1);
    });
    child.on('error', () => {
      if (currentAnalyze === child) currentAnalyze = null;
      resolve(1);
    });
  });
}

let currentAnalyze: ChildProcess | null = null;

export async function watchCommand(inputPath?: string, options: WatchOptions = {}): Promise<void> {
  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    repoPath = gitRoot || path.resolve(process.cwd());
  }

  if (!hasGitDir(repoPath) && !options.skipGit) {
    console.error(
      'GitNexus watch: not a git repository. Pass --skip-git to watch an arbitrary folder.',
    );
    process.exitCode = 1;
    return;
  }

  let debounceMs: number;
  let pollIntervalMs: number;
  try {
    debounceMs = parsePositiveInt(options.debounce, DEFAULT_DEBOUNCE_MS, '--debounce');
    pollIntervalMs = parsePositiveInt(options.interval, DEFAULT_POLL_INTERVAL_MS, '--interval');
  } catch (err) {
    console.error(`GitNexus watch: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const usePolling = options.poll || (process.platform !== 'win32' && process.platform !== 'darwin');

  console.log(`GitNexus watch: ${repoPath}`);
  console.log(
    usePolling
      ? `Watching by polling every ${pollIntervalMs}ms; debounce ${debounceMs}ms.`
      : `Watching filesystem events; debounce ${debounceMs}ms.`,
  );

  const changed = new Set<string>();
  let debounceTimer: NodeJS.Timeout | null = null;
  let running = false;
  let rerunQueued = false;
  let stopped = false;
  let cleanup: (() => void) | null = null;

  const triggerAnalyze = async (reason: string) => {
    if (stopped) return;
    if (running) {
      rerunQueued = true;
      return;
    }

    running = true;
    const changedNow = Array.from(changed).sort();
    changed.clear();
    const label =
      reason === 'initial'
        ? 'initial index'
        : `${changedNow.length} changed file${changedNow.length === 1 ? '' : 's'}`;
    console.log(`\nGitNexus watch: running analyze (${label})`);
    for (const rel of changedNow.slice(0, 12)) console.log(`  - ${rel}`);
    if (changedNow.length > 12) console.log(`  ... and ${changedNow.length - 12} more`);

    const code = await runAnalyze(repoPath, options);
    if (code === 0) {
      console.log('GitNexus watch: analyze complete');
    } else {
      console.error(`GitNexus watch: analyze failed with exit code ${code}`);
    }

    running = false;
    if (rerunQueued || changed.size > 0) {
      rerunQueued = false;
      void triggerAnalyze('queued');
    }
  };

  const schedule = (relativePath: string) => {
    if (shouldIgnoreWatchPath(relativePath)) return;
    changed.add(relativePath);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void triggerAnalyze('change');
    }, debounceMs);
  };

  if (!options.skipInitial) {
    void triggerAnalyze('initial');
  }

  if (usePolling) {
    let previous = await walkSnapshot(repoPath);
    const timer = setInterval(async () => {
      const next = await walkSnapshot(repoPath);
      const diff = diffSnapshots(previous, next);
      previous = next;
      for (const rel of diff) schedule(rel);
    }, pollIntervalMs);
    cleanup = () => clearInterval(timer);
  } else {
    const watcher: FSWatcher = fs.watch(
      repoPath,
      { recursive: true },
      (_eventType, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, '/');
        schedule(rel);
      },
    );
    watcher.on('error', (err) => {
      console.error(`GitNexus watch: watcher error: ${err.message}`);
    });
    cleanup = () => watcher.close();
  }

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    cleanup?.();
    if (currentAnalyze && !currentAnalyze.killed) currentAnalyze.kill('SIGINT');
    console.log('\nGitNexus watch: stopped');
  };

  process.once('SIGINT', () => {
    shutdown();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    shutdown();
    process.exit(143);
  });

  // Keep the command alive while native watchers or polling intervals are active.
  await new Promise<void>(() => {});
}
