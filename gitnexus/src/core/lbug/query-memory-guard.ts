/**
 * Native-memory guard for read queries (#3696).
 *
 * A runaway LadybugDB query allocates native heap that neither
 * `bufferManagerSize` nor V8 limits bound, and the binding cannot interrupt
 * it. While a query runs, process memory is sampled; past the budget, the
 * running queries are named on stderr and the process exits so the host does
 * not run out of memory. On macOS, RSS excludes compressed and swapped pages,
 * so queries running longer than 1 s also read the physical footprint.
 *
 * `GITNEXUS_QUERY_MAX_RSS_MB`: limit in MiB, `0` disables. Default is
 * max(8 GiB, 25% of RAM); the floor leaves room for the read pool's own
 * buffer pools (up to 5 databases × 2 GiB).
 * `GITNEXUS_QUERY_TRACE=1`: one stderr line per query with duration, rows and
 * memory.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { realStderrWrite } from '../../mcp/stdio-capture.js';

export const QUERY_MAX_RSS_ENV = 'GITNEXUS_QUERY_MAX_RSS_MB';
export const QUERY_TRACE_ENV = 'GITNEXUS_QUERY_TRACE';
/** EX_SOFTWARE from sysexits.h: distinct from the CLI's generic exit 1. */
export const QUERY_MEMORY_LIMIT_EXIT_CODE = 70;

const MIB = 1024 * 1024;
const MIN_DEFAULT_BUDGET_BYTES = 8 * 1024 * MIB;
const DEFAULT_RAM_FRACTION = 0.25;
const SAMPLE_INTERVAL_MS = 200;
/** Footprint reads start once a query has run this long, and repeat at most this often. */
export const FOOTPRINT_INTERVAL_MS = 1000;
const FOOTPRINT_TIMEOUT_MS = 2000;
const LABEL_MAX_CHARS = 200;

/** Memory budget in bytes, or `null` when disabled. Invalid values use the default. */
export function resolveQueryRssBudgetBytes(
  raw: string | undefined,
  totalMemBytes: number,
): number | null {
  const trimmed = raw?.trim();
  if (trimmed) {
    const mb = Number(trimmed);
    if (mb === 0) return null;
    if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * MIB);
  }
  return Math.max(MIN_DEFAULT_BUDGET_BYTES, Math.floor(totalMemBytes * DEFAULT_RAM_FRACTION));
}

/** One-line, length-bounded query label. Never includes bound parameters. */
export function queryLabel(cypher: string): string {
  const flat = cypher.replace(/\s+/g, ' ').trim();
  return flat.length > LABEL_MAX_CHARS ? `${flat.slice(0, LABEL_MAX_CHARS)}…` : flat;
}

/** Parse `phys_footprint: <n> B` from `footprint -f bytes` output. */
export function parsePhysFootprintBytes(output: string): number | null {
  const m = /phys_footprint:\s*(\d+)\s*B\b/.exec(output);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

interface ActiveQuery {
  label: string;
  startedAt: number;
  startBytes: number;
  peakBytes: number;
}

export interface QueryMemoryBreach {
  rssBytes: number;
  budgetBytes: number;
  activeLabels: string[];
}

export interface QueryMemoryGuardDeps {
  readRss: () => number;
  /** Physical footprint, where the platform can report it; `null` when unavailable. */
  readFootprint?: () => Promise<number | null>;
  env: () => NodeJS.ProcessEnv;
  totalMem: () => number;
  now: () => number;
  writeStderr: (line: string) => void;
  onBreach: (breach: QueryMemoryBreach) => void;
  /** Start the periodic sampler; returns a stop function. */
  startSampler: (tick: () => void) => () => void;
}

export interface QueryMemoryGuard {
  /** Register a query as in flight. Pass the returned token to `end`. */
  begin(cypher: string): object;
  /** Unregister a query; `rowCount` is only used for the trace line. */
  end(token: object, rowCount?: number): void;
  /** Take one sample now (called by the sampler). */
  sample(): void;
}

export function formatBreachMessage(breach: QueryMemoryBreach): string {
  const gb = (n: number) => (n / (1024 * MIB)).toFixed(1);
  const queries = breach.activeLabels.map((l) => `  - ${l}`).join('\n');
  return (
    `GitNexus stopped: process memory reached ${gb(breach.rssBytes)} GB, over the ` +
    `${gb(breach.budgetBytes)} GB limit, while running a graph query. The database ` +
    `cannot cancel a running query, so the process is exiting to protect the host.\n` +
    `Running queries:\n${queries}\n` +
    `Set ${QUERY_MAX_RSS_ENV}=<MiB> to change the limit (0 disables it). ` +
    `Please report this with ${QUERY_TRACE_ENV}=1 output (see issue #3696).\n`
  );
}

export function createQueryMemoryGuard(deps: QueryMemoryGuardDeps): QueryMemoryGuard {
  const active = new Set<ActiveQuery>();
  let stopSampler: (() => void) | null = null;
  let budgetBytes: number | null = null;
  let tracing = false;
  let breached = false;
  let footprintInFlight = false;
  let lastFootprintAt = Number.NEGATIVE_INFINITY;

  const observe = (bytes: number): void => {
    if (active.size === 0 || breached) return;
    for (const q of active) if (bytes > q.peakBytes) q.peakBytes = bytes;
    if (budgetBytes !== null && bytes > budgetBytes) {
      breached = true;
      deps.onBreach({
        rssBytes: bytes,
        budgetBytes,
        activeLabels: [...active].map((q) => q.label),
      });
    }
  };

  const maybeReadFootprint = (): void => {
    if (!deps.readFootprint || footprintInFlight) return;
    const now = deps.now();
    if (now - lastFootprintAt < FOOTPRINT_INTERVAL_MS) return;
    let oldest = Number.POSITIVE_INFINITY;
    for (const q of active) oldest = Math.min(oldest, q.startedAt);
    if (now - oldest < FOOTPRINT_INTERVAL_MS) return;
    footprintInFlight = true;
    lastFootprintAt = now;
    deps.readFootprint().then(
      (bytes) => {
        footprintInFlight = false;
        if (bytes !== null) observe(bytes);
      },
      () => {
        footprintInFlight = false;
      },
    );
  };

  const sample = (): void => {
    if (active.size === 0 || breached) return;
    observe(deps.readRss());
    if (!breached) maybeReadFootprint();
  };

  return {
    begin(cypher: string): object {
      if (active.size === 0) {
        const env = deps.env();
        budgetBytes = resolveQueryRssBudgetBytes(env[QUERY_MAX_RSS_ENV], deps.totalMem());
        tracing = env[QUERY_TRACE_ENV] === '1';
      }
      const rss = deps.readRss();
      const q: ActiveQuery = {
        label: queryLabel(cypher),
        startedAt: deps.now(),
        startBytes: rss,
        peakBytes: rss,
      };
      active.add(q);
      if (!stopSampler && (budgetBytes !== null || tracing)) {
        stopSampler = deps.startSampler(sample);
      }
      return q;
    },

    end(token: object, rowCount?: number): void {
      const q = token as ActiveQuery;
      if (!active.delete(q)) return;
      if (tracing) {
        const endRss = deps.readRss();
        const mb = (n: number) => Math.round(n / MIB);
        deps.writeStderr(
          `[query-trace] ms=${deps.now() - q.startedAt} rows=${rowCount ?? '?'} ` +
            `memStartMB=${mb(q.startBytes)} memPeakMB=${mb(Math.max(q.peakBytes, endRss))} ` +
            `rssEndMB=${mb(endRss)} active=${active.size} q="${q.label}"\n`,
        );
      }
      if (active.size === 0 && stopSampler) {
        stopSampler();
        stopSampler = null;
      }
    },

    sample,
  };
}

/** `footprint` ships with macOS; once it fails, stop trying for this process. */
let footprintUnavailable = false;
function readDarwinFootprint(): Promise<number | null> {
  if (footprintUnavailable) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/footprint',
      ['--noCategories', '-f', 'bytes', '-p', String(process.pid)],
      { timeout: FOOTPRINT_TIMEOUT_MS },
      (err, stdout) => {
        const bytes = err ? null : parsePhysFootprintBytes(String(stdout));
        if (bytes === null) footprintUnavailable = true;
        resolve(bytes);
      },
    );
  });
}

/** Process-wide guard used by the read pool. */
export const queryMemoryGuard: QueryMemoryGuard = createQueryMemoryGuard({
  readRss: () => process.memoryUsage.rss(),
  ...(process.platform === 'darwin' ? { readFootprint: readDarwinFootprint } : {}),
  env: () => process.env,
  totalMem: () => os.totalmem(),
  now: () => Date.now(),
  writeStderr: (line) => {
    realStderrWrite(line);
  },
  onBreach: (breach) => {
    // Synchronous so the message lands before exit (pipe writes are async).
    try {
      fs.writeSync(2, formatBreachMessage(breach));
    } catch {
      /* exit regardless */
    }
    process.exit(QUERY_MEMORY_LIMIT_EXIT_CODE);
  },
  startSampler: (tick) => {
    const timer = setInterval(tick, SAMPLE_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  },
});
