/**
 * Give a worker the heap cap it asks for, even when the main process runs
 * under `--max-old-space-size`, `--max-semi-space-size` or `--max-heap-size`.
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
 *
 * There is no lease when it cannot enforce a cap: when a heap flag is set
 * and the process froze V8's flags with `--freeze-flags-after-init` (V8 then
 * aborts on any flag write), or when the flags read from execArgv and
 * NODE_OPTIONS do not explain the main isolate's live heap limit
 * (`inheritedHeap`). Workers then run with the inherited heap, and admission
 * charges each one the main heap (`workerHeapCapEnforceable`).
 *
 * The flags are read argument by argument from `process.execArgv` and
 * NODE_OPTIONS (`lib/node-size-flag.ts`), never from a joined command line, so
 * an `--eval` source or a `--title` value cannot pass for a heap flag.
 *
 * The lease state below is process-global, like the V8 flags it manages: one
 * count of starting workers and one set of flags to restore, shared by every
 * pool in the process, and a flag that stays set once any worker has started
 * under the cleared flags (a long-lived watch process keeps it across runs).
 */
import os from 'node:os';
import v8 from 'node:v8';
import type { ResourceLimits, Worker } from 'node:worker_threads';
import {
  processNodeBooleanFlag,
  processNodeSizeFlag,
  readNodeFlagValue,
} from '../../../lib/node-size-flag.js';

const MIB = 1024 * 1024;

/**
 * The old space in MB that `--max-old-space-size-percentage` gives this
 * process, by Node's formula: that percentage of the whole MB of the process
 * memory limit (the cgroup limit whenever Node reports one, else physical
 * RAM; both default to this process's). Undefined without the flag. The
 * command line wins over NODE_OPTIONS.
 */
export function percentageOldSpaceMb(
  execArgv: readonly string[],
  nodeOptions: string,
  totalMemoryBytes?: number,
  constrainedMemoryBytes?: number,
): number | undefined {
  const name = 'max-old-space-size-percentage';
  const value = readNodeFlagValue(execArgv, name) ?? readNodeFlagValue(nodeOptions, name);
  const percent = value === undefined ? NaN : Number(value);
  if (!(percent > 0 && percent <= 100)) return undefined;
  // Read only under the flag. Node treats UINT64_MAX, which reaches
  // JavaScript as 2 ** 64, as no limit.
  const constrained = constrainedMemoryBytes ?? process.constrainedMemory?.() ?? 0;
  const memory =
    constrained > 0 && constrained < 2 ** 64 ? constrained : (totalMemoryBytes ?? os.totalmem());
  return Math.floor((Math.floor(memory / MIB) * percent) / 100);
}

/** The V8 heap flags this process runs under, and the heap they gave the main isolate. */
export interface InheritedHeap {
  /** The flags a leased worker starts without, as the lease restores them. */
  flags: string[];
  /** Worker limits that give the main isolate's heap; undefined without heap flags. */
  limits: ResourceLimits | undefined;
  /** Whether the flags read from execArgv and NODE_OPTIONS explain the live limit. */
  consistent: boolean;
}

/**
 * V8 sizes a young generation as three semi-spaces, each a power of two of at
 * least a 256 KiB page.
 */
function isYoungGeneration(bytes: number): boolean {
  const pages = bytes / 3 / (256 * 1024);
  return Number.isInteger(pages) && pages >= 1 && Number.isInteger(Math.log2(pages));
}

/**
 * Read the V8 heap flags this process runs under and check them against the
 * main isolate's live `heap_size_limit`, which V8 makes old space plus a
 * three-semi-space young generation:
 * - `--max-old-space-size`, or the old space Node gives
 *   `--max-old-space-size-percentage` (which beats an explicit size), must
 *   leave a valid young generation, and exactly three
 *   `--max-semi-space-size` semi-spaces (rounded up to a power of two, as V8
 *   does) when that flag is set;
 * - `--max-heap-size` alone, or with only the semi-space flag, must equal the
 *   limit.
 * The live limit thus settles what V8 made of a `--max-heap-size` and
 * `--max-old-space-size` pair and catches a percentage Node computed
 * differently or a NODE_OPTIONS value changed after startup: the result is
 * then not consistent, and nothing is cleared or restored. The semi-space flag
 * alone leaves V8's default old space, which the limit cannot confirm. A flag
 * the process applied but neither source shows (a preload that deleted
 * NODE_OPTIONS or called `v8.setFlagsFromString`) cannot be seen this way.
 *
 * The flags are restored as read, which the check above confirms is what the
 * main isolate got. The worker limits are the main isolate's old space and
 * young generation, except under `--max-heap-size` alone, whose split V8 does
 * not report: the worker then gets the whole limit as old space, plus V8's
 * default young generation.
 */
export function inheritedHeap(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? '',
  heapLimitBytes: number = v8.getHeapStatistics().heap_size_limit,
  totalMemoryBytes?: number,
  constrainedMemoryBytes?: number,
): InheritedHeap {
  const oldMb =
    percentageOldSpaceMb(execArgv, nodeOptions, totalMemoryBytes, constrainedMemoryBytes) ??
    processNodeSizeFlag('max-old-space-size', execArgv, nodeOptions);
  const semiMb = processNodeSizeFlag('max-semi-space-size', execArgv, nodeOptions);
  const heapMb = processNodeSizeFlag('max-heap-size', execArgv, nodeOptions);
  // Undefined and an explicit 0 both leave V8's default in place.
  const isSet = (mb: number | undefined): mb is number => mb !== undefined && mb !== 0;
  if (!isSet(oldMb) && !isSet(semiMb) && !isSet(heapMb)) {
    return { flags: [], limits: undefined, consistent: true };
  }
  const unknown = { flags: [], limits: undefined, consistent: false };
  // A size too large to read exactly (NaN) has an unknown effect.
  if ([oldMb, semiMb, heapMb].some((mb) => Number.isNaN(mb))) return unknown;

  const youngBytes = isSet(semiMb)
    ? 3 * 2 ** Math.ceil(Math.log2(semiMb)) * MIB
    : isSet(oldMb)
      ? heapLimitBytes - oldMb * MIB
      : undefined;
  if (youngBytes !== undefined && !isYoungGeneration(youngBytes)) return unknown;
  if (isSet(oldMb) && heapLimitBytes - (youngBytes ?? 0) !== oldMb * MIB) return unknown;
  if (!isSet(oldMb) && isSet(heapMb) && heapLimitBytes !== heapMb * MIB) return unknown;

  const flags: string[] = [];
  if (isSet(oldMb)) flags.push(`--max-old-space-size=${oldMb}`);
  if (isSet(semiMb)) flags.push(`--max-semi-space-size=${semiMb}`);
  if (isSet(heapMb)) flags.push(`--max-heap-size=${heapMb}`);
  const limits: ResourceLimits =
    youngBytes === undefined
      ? { maxOldGenerationSizeMb: heapLimitBytes / MIB }
      : {
          maxOldGenerationSizeMb: (heapLimitBytes - youngBytes) / MIB,
          maxYoungGenerationSizeMb: youngBytes / MIB,
        };
  return { flags, limits, consistent: true };
}

/**
 * Whether the lease can enforce a worker's own heap cap. It cannot when the
 * heap flags read from execArgv and NODE_OPTIONS do not explain the main
 * isolate's live limit (`inheritedHeap`), since the lease would clear the
 * wrong flags, or when heap flags are set and the process froze V8's flags
 * (`--freeze-flags-after-init`, in any spelling): V8 aborts on the flag write
 * that would clear them. Frozen flags with no heap flag set leave nothing to
 * clear.
 */
export function workerHeapCapEnforceable(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? '',
  heapLimitBytes: number = v8.getHeapStatistics().heap_size_limit,
): boolean {
  return leaseable(inheritedHeap(execArgv, nodeOptions, heapLimitBytes), execArgv, nodeOptions);
}

function leaseable(heap: InheritedHeap, execArgv: readonly string[], nodeOptions: string): boolean {
  if (!heap.consistent) return false;
  const frozen = processNodeBooleanFlag('freeze-flags-after-init', execArgv, nodeOptions) === true;
  return !(frozen && heap.flags.length > 0);
}

/**
 * Resource limits that give a Worker the main isolate's heap under the
 * inherited flags (`inheritedHeap`). Undefined when the process set no heap
 * flag, or when its flags do not explain the main heap.
 */
export function inheritedWorkerResourceLimits(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? '',
): ResourceLimits | undefined {
  return inheritedHeap(execArgv, nodeOptions).limits;
}

// Process-global lease state (see the module comment).
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
    // Decide before the first flag write: under frozen flags that write aborts.
    const heap = inheritedHeap();
    if (!leaseable(heap, process.execArgv, process.env.NODE_OPTIONS ?? '')) return spawn();
    restoreFlags = heap.flags;
    if (restoreFlags.length === 0) return spawn();
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
