/**
 * Give a worker the heap cap it asks for, even when the main process runs
 * under `--max-old-space-size` or `--max-semi-space-size` flags.
 *
 * V8 reads those flags when it creates an isolate, and the process-wide values
 * override the Worker's `resourceLimits`: under `--max-old-space-size=3000` a
 * worker capped at 512 MB still gets a ~3 GB old space, and under
 * `--max-semi-space-size=128` its young generation is 384 MB rather than the
 * few tens of MB V8 sizes for a 512 MB heap. Clearing the flags while a worker
 * isolate is created lets the worker's own cap apply; the main isolate keeps
 * the limits it started with.
 *
 * Node creates the isolate on the worker's thread, after `new Worker()`
 * returns, so a synchronous set-and-restore races it (measured: the main limit
 * leaked into roughly a third of workers). The flags therefore stay cleared
 * until every starting worker reports `online`, posts its first message, or
 * exits. A Worker created in the analysis process without these helpers while
 * a lease is open gets V8's default heap, so new Worker sites there must use
 * them.
 *
 * Parser workers start through the lease with their own cap. Other workers use
 * `spawnWithInheritedHeap()`. Node shares one built-in code cache between a
 * process's isolates and accepts an entry only under the V8 flag hash it was
 * compiled with, so the first worker that starts under the cleared flags
 * recompiles the built-ins its startup needs (measured: ~13 ms). A later worker
 * reuses that work when it starts under the cleared flags too, and the main
 * isolate's entries when it starts under the inherited ones; it therefore takes
 * the lease only once a worker has already started under the cleared flags.
 */
import v8 from 'node:v8';
import type { ResourceLimits, Worker } from 'node:worker_threads';
import { readNodeSizeFlag } from '../../../lib/node-size-flag.js';

const MIB = 1024 * 1024;
const OLD_SPACE_FLAG = 'max-old-space-size';
const OLD_SPACE_PERCENTAGE_FLAG = /--max[-_]old[-_]space[-_]size[-_]percentage\b/;
const SEMI_SPACE_FLAG = 'max-semi-space-size';

function lastFlagMb(flags: string, flag: string): number {
  return readNodeSizeFlag(flags, flag) ?? 0;
}

/**
 * The process-wide V8 old-space flag in MB, or 0 when this process set none.
 * Command-line flags are applied after NODE_OPTIONS, so an execArgv value
 * wins. Node turns `--max-old-space-size-percentage` into the same V8 flag and
 * lets it beat an explicit size, but it carries no MB value, so the limit the
 * main isolate actually received stands in for it.
 */
export function inheritedOldSpaceMb(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? '',
  heapSizeLimitBytes: number = v8.getHeapStatistics().heap_size_limit,
): number {
  const commandLine = execArgv.join(' ');
  if (OLD_SPACE_PERCENTAGE_FLAG.test(commandLine) || OLD_SPACE_PERCENTAGE_FLAG.test(nodeOptions)) {
    return Math.floor(heapSizeLimitBytes / MIB);
  }
  return lastFlagMb(commandLine, OLD_SPACE_FLAG) || lastFlagMb(nodeOptions, OLD_SPACE_FLAG);
}

/** The process-wide V8 semi-space flag in MB, or 0 when this process set none. */
export function inheritedSemiSpaceMb(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? '',
): number {
  return (
    lastFlagMb(execArgv.join(' '), SEMI_SPACE_FLAG) || lastFlagMb(nodeOptions, SEMI_SPACE_FLAG)
  );
}

/**
 * Resource limits that give a Worker at least the heap the inherited flags
 * would have given it: old space from `--max-old-space-size` and a young
 * generation of three `--max-semi-space-size` semi-spaces. Under
 * `--max-old-space-size-percentage` the old space is the main isolate's whole
 * limit, which includes its young generation, so the worker gets slightly more.
 * Undefined when the process set neither flag.
 */
export function inheritedWorkerResourceLimits(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? '',
): ResourceLimits | undefined {
  const oldSpaceMb = inheritedOldSpaceMb(execArgv, nodeOptions);
  const semiSpaceMb = inheritedSemiSpaceMb(execArgv, nodeOptions);
  if (oldSpaceMb === 0 && semiSpaceMb === 0) return undefined;
  return {
    ...(oldSpaceMb > 0 ? { maxOldGenerationSizeMb: oldSpaceMb } : {}),
    ...(semiSpaceMb > 0 ? { maxYoungGenerationSizeMb: 3 * semiSpaceMb } : {}),
  };
}

let startingWorkers = 0;
let restoreFlags: string[] = [];
// Set once a worker has started under the cleared flags in this process.
let clearedFlagsUsed = false;

/**
 * Run `spawn` with the process-wide heap flags cleared, so the worker's
 * `resourceLimits` are the limits V8 enforces. Concurrent spawns share one
 * lease; the last starting worker restores the flags.
 */
export function spawnWithOwnHeapLimit<T extends Worker>(spawn: () => T): T {
  if (startingWorkers === 0) {
    const oldSpaceMb = inheritedOldSpaceMb();
    const semiSpaceMb = inheritedSemiSpaceMb();
    if (oldSpaceMb === 0 && semiSpaceMb === 0) return spawn();
    restoreFlags = [];
    if (oldSpaceMb > 0) restoreFlags.push(`--max-old-space-size=${oldSpaceMb}`);
    if (semiSpaceMb > 0) restoreFlags.push(`--max-semi-space-size=${semiSpaceMb}`);
    for (const flag of restoreFlags) v8.setFlagsFromString(flag.replace(/=\d+$/, '=0'));
    clearedFlagsUsed = true;
  }
  startingWorkers++;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (--startingWorkers === 0) {
      for (const flag of restoreFlags) v8.setFlagsFromString(flag);
    }
  };
  let worker: T;
  try {
    worker = spawn();
  } catch (err) {
    release();
    throw err;
  }
  // No 'error' listener: 'exit' always follows a worker error, and a listener
  // here would stop an unhandled worker error from surfacing.
  const settle = (): void => {
    worker.off('online', settle);
    worker.off('message', settle);
    worker.off('exit', settle);
    release();
  };
  worker.once('online', settle);
  worker.once('message', settle);
  worker.once('exit', settle);
  return worker;
}

/**
 * Spawn a worker that has no heap cap of its own with the heap the inherited
 * flags give it. Once a worker has started under the cleared flags in this
 * process, this one does too, with `inheritedWorkerResourceLimits()`, so its
 * startup reuses that worker's built-in compile. Otherwise it starts plainly
 * under the inherited flags and reuses the main isolate's built-ins instead.
 */
export function spawnWithInheritedHeap<T extends Worker>(
  spawn: (resourceLimits: ResourceLimits | undefined) => T,
): T {
  if (!clearedFlagsUsed) return spawn(undefined);
  return spawnWithOwnHeapLimit(() => spawn(inheritedWorkerResourceLimits()));
}
