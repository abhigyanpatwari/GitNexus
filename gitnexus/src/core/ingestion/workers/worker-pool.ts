import { Worker } from 'node:worker_threads';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { logger } from '../../logger.js';
import { createQuarantine } from './quarantine.js';

/**
 * Worker IPC uses Node's native `worker.postMessage(value, transferList)`
 * directly. The structured-clone algorithm V8 runs internally on every
 * `postMessage` preserves Map / Set / Date / RegExp / BigInt /
 * TypedArray / undefined values / circular refs out of the box —
 * no explicit serializer needed. File contents move zero-copy via
 * `transferList` for their ArrayBuffers; everything else is cloned
 * tree-walk style by the same algorithm a wrapper serializer would
 * call anyway. The previous `protocol.ts` framing layer was a redundant
 * V8.serialize → Buffer → postMessage(struct-clone-Buffer) double-walk;
 * removing it cut one full structured-clone pass per message.
 *
 * Sub-batch dispatch payload shape:
 *   `{ type: 'sub-batch', files: Array<{ path: string; content: Uint8Array }> }`
 *
 * The file `content` is a `Uint8Array` (not a string) so its
 * underlying `ArrayBuffer` can be transferred zero-copy via
 * `transferList`. The worker calls `new TextDecoder('utf-8').decode`
 * lazily at the tree-sitter call site.
 *
 * `Uint8Array` instances are allocated via `TextEncoder.encode`, which
 * produces a dedicated `ArrayBuffer` per call. Node's `Buffer.from(str,
 * 'utf8')` and `Buffer.alloc` may carve from the shared `Buffer.poolSize`
 * slab, and transferring one pool-backed `ArrayBuffer` detaches every
 * other Buffer sharing the slab — silent data corruption. TextEncoder
 * bypasses the pool, so transferring its outputs is safe.
 */

type ParseWorkerItem = { path: string; content: string };

/**
 * Type guard: every element of `items` has the parse-worker shape
 * (`{path: string, content: string}`). Used to narrow the generic input
 * inside `buildDispatchMessage` so a future rename of
 * `ParseWorkerInput.content` would fail to compile inside the narrowed
 * branch instead of silently mismatching at runtime.
 */
function isParseWorkerItemArray<T>(
  items: readonly T[],
): items is readonly T[] & readonly ParseWorkerItem[] {
  if (items.length === 0) return false;
  for (const it of items) {
    if (it == null || typeof it !== 'object') return false;
    if (typeof (it as { path?: unknown }).path !== 'string') return false;
    if (typeof (it as { content?: unknown }).content !== 'string') return false;
  }
  return true;
}

/**
 * Build the sub-batch dispatch payload + transferList.
 *
 * For the parse-worker shape `{path, content: string}[]`, encodes each
 * file's content as a `Uint8Array` via `TextEncoder` so the underlying
 * `ArrayBuffer` can be transferred zero-copy. For any other input
 * shape, the items array is passed through verbatim (no transfer).
 *
 * @internal Exported for the unit test suite
 * (`test/unit/worker-pool-transferlist.test.ts`) so the
 * Uint8Array-per-content allocation contract can be pinned without
 * spinning up a real worker_threads.
 */
export function buildDispatchMessage<T>(items: readonly T[]): {
  message:
    | { type: 'sub-batch'; files: Array<{ path: string; content: Uint8Array }> }
    | {
        type: 'sub-batch';
        files: readonly T[];
      };
  transferList?: ArrayBuffer[];
} {
  if (!isParseWorkerItemArray(items)) {
    return { message: { type: 'sub-batch', files: items } };
  }

  // After the type guard, `items` is narrowed to `readonly ParseWorkerItem[]`.
  const encoder = new TextEncoder();
  const files: Array<{ path: string; content: Uint8Array }> = [];
  const transferList: ArrayBuffer[] = [];
  for (const item of items) {
    const u8 = encoder.encode(item.content);
    files.push({ path: item.path, content: u8 });
    transferList.push(u8.buffer as ArrayBuffer);
  }
  return {
    message: { type: 'sub-batch', files },
    transferList,
  };
}
export interface WorkerPool {
  /**
   * Dispatch items across workers. Items are split into bounded jobs, each job
   * is committed independently, and stalled jobs are split/retried locally.
   *
   * Files in {@link WorkerPool.getQuarantinedPaths} are filtered out before
   * dispatch — they have already caused a worker death this pool lifetime and
   * are not safe to re-attempt in workers. The caller is responsible for
   * routing them (e.g. to sequential fallback); inspect the quarantine
   * snapshot before and after each dispatch.
   */
  dispatch<TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
  ): Promise<TResult[]>;

  /** Terminate all workers. Must be called when done. */
  terminate(): Promise<void>;

  /** Number of worker slots originally requested for the pool. */
  readonly size: number;

  /**
   * Snapshot of paths quarantined by this pool instance. Populated when a
   * worker dies with an authoritative in-flight file (Layer 4 starting-file
   * message) or a singleton-timeout exclusion. Cleared only by pool teardown
   * — quarantine is session-scoped per `createWorkerPool` invocation.
   *
   * Optional so external `WorkerPool` shapes (test doubles, alternate
   * implementations) can omit the method without compile errors. Callers
   * (`processParsing`) use optional chaining at the call site to handle
   * absence gracefully.
   */
  getQuarantinedPaths?(): readonly string[];

  /**
   * Throughput / health snapshot for operator observability. Surfaced at
   * chunk boundaries by `parse-impl` when verbose ingestion is enabled
   * so the operator can see whether workers are saturated, idle, or
   * dropping. Optional for compatibility with external `WorkerPool`
   * shapes that predate this method.
   */
  getStats?(): WorkerPoolStats;
}

/** Snapshot returned by {@link WorkerPool.getStats}. */
export interface WorkerPoolStats {
  /** Worker slots configured at pool creation time. */
  readonly size: number;
  /** Slots that are still in the active rotation (have not been dropped
   *  for exceeding their respawn budget and have not been cleared by
   *  the circuit breaker). */
  readonly activeSlots: number;
  /** Slots permanently removed from rotation this pool lifetime
   *  (size - activeSlots). When the circuit breaker has tripped this
   *  equals `size` because activeSlots is cleared. */
  readonly droppedSlots: number;
  /** Cumulative paths quarantined by failure attribution. */
  readonly quarantined: number;
  /** Whether the circuit breaker has tripped (no further dispatches
   *  will be accepted by this pool instance). */
  readonly poolBroken: boolean;
  /** Whether `terminate()` has been called on this pool. Distinguishes
   *  graceful shutdown (terminated=true, activeSlots=0) from a circuit-
   *  breaker trip (terminated=false, poolBroken=true, activeSlots=0).
   *  Optional for backward compatibility with external `WorkerPoolStats`
   *  implementations that predate this field. */
  readonly terminated?: boolean;
  /** Per-slot generation counter (U12). Increments by 1 on every
   *  successful worker replacement for that slot. Operators / tests
   *  observe this to confirm a death-then-respawn actually happened
   *  vs. the same worker being recycled in place. Initial value is 0
   *  for every slot at pool creation; dropped slots keep their last
   *  generation (they don't decrement). Optional so external
   *  `WorkerPoolStats` implementations that predate U12 can omit the
   *  field without a TypeScript compile error — in-repo callers use
   *  optional chaining (`stats?.slotGenerations`) consistently. */
  readonly slotGenerations?: readonly number[];
}

export interface WorkerPoolOptions {
  subBatchSize?: number;
  subBatchMaxBytes?: number;
  subBatchIdleTimeoutMs?: number;
  maxTimeoutRetries?: number;
  timeoutBackoffFactor?: number;
  /**
   * Max replacement spawns per worker slot before the slot is dropped from
   * the active rotation. Bounds respawn loops on a slot that consistently
   * crashes the worker (likely a system-level fault rather than a single
   * bad input). Default 3.
   */
  maxRespawnsPerSlot?: number;
  /**
   * Hard ceiling on total wall time the pool will spend retrying / splitting
   * any single job. Combined with `timeoutBackoffFactor`, this prevents
   * exponentially-growing retry waits from accumulating into multi-hour
   * stalls before the pool finally surfaces the bad file to sequential
   * fallback. Default 5x `subBatchIdleTimeoutMs`.
   */
  maxCumulativeTimeoutMs?: number;
  /**
   * Number of consecutive worker deaths (no successful job in between) that
   * trip the pool circuit breaker. Once tripped, the pool rejects every
   * subsequent `dispatch` with `WorkerPoolDispatchError` until a new pool is
   * created. Default `Math.max(3, poolSize)`.
   */
  consecutiveFailureThreshold?: number;
  /**
   * Test-only injection point for the Worker constructor. When provided,
   * the pool uses this factory instead of `new Worker(workerUrl)`. Production
   * code should leave this unset.
   */
  workerFactory?: (workerUrl: URL) => Worker;
}

export class WorkerPoolDispatchError extends Error {
  /**
   * Snapshot of the pool's session-scoped quarantine at the moment the
   * dispatch error was raised. Surfaced for operator diagnostics: when
   * the circuit breaker trips, this lists the files the pool had
   * already decided were unsafe before the trip. Read-only at the
   * caller boundary; no in-pool consumer rewires it post-construction.
   *
   * Previously named `fallbackExcludePaths` because the (since-
   * removed) sequential-parser fallback in `processParsing` consumed
   * it to filter the fallback file list. After U20's design pivot
   * (worker pool's resilience layers are the sole failure contract;
   * no sequential rescue), the field is informational only. The
   * rename clarifies semantics without changing wire behavior.
   */
  readonly quarantinedPaths: readonly string[];

  constructor(message: string, quarantinedPaths: readonly string[] = []) {
    super(message);
    this.name = 'WorkerPoolDispatchError';
    this.quarantinedPaths = quarantinedPaths;
  }
}

export class WorkerPoolInitializationError extends WorkerPoolDispatchError {
  readonly readinessFailures: readonly string[];

  constructor(
    message: string,
    quarantinedPaths: readonly string[] = [],
    readinessFailures: readonly string[] = [],
  ) {
    super(message, quarantinedPaths);
    this.name = 'WorkerPoolInitializationError';
    this.readinessFailures = readinessFailures;
  }
}

/** Message shapes sent back by worker threads. */
type WorkerOutgoingMessage =
  | { type: 'progress'; filesProcessed: number }
  | { type: 'warning'; message: string }
  | { type: 'sub-batch-done' }
  | { type: 'error'; error: string }
  | { type: 'result'; data: unknown }
  /**
   * Authoritative in-flight signal: worker is about to process this file.
   * Pool records it per slot so worker death can be attributed exactly,
   * instead of guessing from `items[lastProgress]` (which language-grouped
   * worker processing defeats). Optional — older worker builds may not
   * emit it; pool falls back to the heuristic when absent.
   */
  | { type: 'starting-file'; path: string }
  /**
   * Top-of-script ready handshake. Emitted by `parse-worker.ts` AFTER all
   * imports + grammar bindings + type-env setup complete, BEFORE the
   * message handler is attached. The pool's `waitForWorkerReady` resolves
   * on this message — replaces the prior `online`-event-based readiness
   * trust, which fired before the script body ran and let init crashes
   * slip past pool startup. Once consumed by `waitForWorkerReady`, any
   * subsequent `ready` message on the dispatch loop is a no-op (the
   * worker only emits it once).
   */
  | { type: 'ready' };

interface WorkerJob<TInput> {
  startIndex: number;
  items: TInput[];
  estimatedBytes: number;
  attempt: number;
  splitDepth: number;
  timeoutMs: number;
  /**
   * Running total of timeoutMs across all attempts/splits/respawn-retries
   * for this conceptual unit of work. Tracked separately from `timeoutMs`
   * so we can bound the *total* wait the pool incurs on a single job, not
   * just the current attempt. See {@link WorkerPoolOptions.maxCumulativeTimeoutMs}.
   */
  cumulativeTimeoutMs: number;
}

interface WorkerJobResult<TResult> {
  startIndex: number;
  data: TResult;
}

/**
 * Max files to send to a worker in a single postMessage.
 * Keeps structured-clone memory bounded per sub-batch.
 */
const SUB_BATCH_SIZE = 1500;
const SUB_BATCH_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_SUB_BATCH_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_RETRIES = 1;
const DEFAULT_TIMEOUT_BACKOFF_FACTOR = 2;
const DEFAULT_MAX_RESPAWNS_PER_SLOT = 3;
const DEFAULT_MAX_CUMULATIVE_TIMEOUT_FACTOR = 5;
const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD_FLOOR = 3;
/**
 * Bounded wait for a replacement worker to emit the `{type:'ready'}`
 * handshake from `parse-worker.ts`. Trusting Node's `online` event alone
 * lets a worker that crashes during top-of-script init slip past pool
 * startup — the pool only notices on the first dispatch's idle timeout
 * (default 30s). 5 seconds is a generous budget for parser + grammar
 * imports; if the worker hasn't reported ready by then, it's almost
 * certainly stuck or crashed and the pool should surface the failure
 * fast rather than wait out the dispatch idle timeout.
 */
const WORKER_READY_TIMEOUT_MS = 5_000;
/**
 * Default upper bound on auto-resolved pool size. Past 16 workers the
 * dominant cost shifts from worker-side parsing to main-thread merge /
 * extraction / structured-clone overhead, and the marginal worker adds
 * memory pressure (tree-sitter state + sub-batch buffer) without much
 * throughput gain. Operators on bigger machines override via
 * `GITNEXUS_WORKER_POOL_SIZE` or `--workers <N>`.
 */
const DEFAULT_POOL_SIZE_CAP = 16;

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : undefined;
}

interface ResolvedWorkerPoolOptions {
  subBatchSize: number;
  subBatchMaxBytes: number;
  subBatchIdleTimeoutMs: number;
  maxTimeoutRetries: number;
  timeoutBackoffFactor: number;
  maxRespawnsPerSlot: number;
  maxCumulativeTimeoutMs: number;
  consecutiveFailureThreshold: number;
}

export function resolveWorkerPoolOptions(
  options: WorkerPoolOptions = {},
  poolSize?: number,
): ResolvedWorkerPoolOptions {
  const subBatchIdleTimeoutMs =
    positiveInteger(options.subBatchIdleTimeoutMs) ??
    positiveInteger(process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS) ??
    DEFAULT_SUB_BATCH_IDLE_TIMEOUT_MS;
  return {
    subBatchSize: positiveInteger(options.subBatchSize) ?? SUB_BATCH_SIZE,
    subBatchMaxBytes:
      positiveInteger(options.subBatchMaxBytes) ??
      positiveInteger(process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES) ??
      SUB_BATCH_MAX_BYTES,
    subBatchIdleTimeoutMs,
    maxTimeoutRetries: nonNegativeInteger(options.maxTimeoutRetries) ?? DEFAULT_TIMEOUT_RETRIES,
    timeoutBackoffFactor:
      positiveInteger(options.timeoutBackoffFactor) ?? DEFAULT_TIMEOUT_BACKOFF_FACTOR,
    maxRespawnsPerSlot:
      nonNegativeInteger(options.maxRespawnsPerSlot) ??
      nonNegativeInteger(process.env.GITNEXUS_WORKER_MAX_RESPAWNS_PER_SLOT) ??
      DEFAULT_MAX_RESPAWNS_PER_SLOT,
    maxCumulativeTimeoutMs:
      positiveInteger(options.maxCumulativeTimeoutMs) ??
      positiveInteger(process.env.GITNEXUS_WORKER_MAX_CUMULATIVE_TIMEOUT_MS) ??
      subBatchIdleTimeoutMs * DEFAULT_MAX_CUMULATIVE_TIMEOUT_FACTOR,
    consecutiveFailureThreshold:
      positiveInteger(options.consecutiveFailureThreshold) ??
      positiveInteger(process.env.GITNEXUS_WORKER_CONSECUTIVE_FAILURE_THRESHOLD) ??
      Math.max(DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD_FLOOR, poolSize ?? 0),
  };
}

/**
 * Resolve the auto-default worker pool size when no explicit `poolSize`
 * arg is passed to `createWorkerPool`. Precedence:
 *
 * 1. `GITNEXUS_WORKER_POOL_SIZE` env var (operator override; set by
 *    `--workers <N>` on the CLI).
 * 2. `os.cpus().length - 1`, clamped to `[1, DEFAULT_POOL_SIZE_CAP]`.
 *
 * The cap exists because past ~16 workers the main-thread merge /
 * extraction work and structured-clone overhead dominate; adding more
 * worker threads costs memory without much throughput gain. Operators
 * who want to push past the cap set the env var explicitly.
 *
 * Exported for unit tests; production code should not call this
 * directly — pass an explicit `poolSize` to `createWorkerPool` or rely
 * on the env / default.
 */
export function resolveAutoPoolSize(): number {
  const envOverride = nonNegativeInteger(process.env.GITNEXUS_WORKER_POOL_SIZE);
  if (envOverride !== undefined) return envOverride;
  // Prefer os.availableParallelism (Node 18.14+) so cgroup CPU limits
  // (containers, taskset-restricted runtimes, CI runners with explicit
  // CPU quotas) are honored — os.cpus().length returns the host count,
  // which over-sizes the pool on constrained shapes and can reintroduce
  // the very "main-thread saturated by oversubscription" symptom the
  // pool cap exists to prevent. Falls back to os.cpus().length on
  // older Node versions. Mirrors `capabilities.ts:85`
  // (`defaultEmbeddingThreads`).
  const cores =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.min(DEFAULT_POOL_SIZE_CAP, Math.max(1, cores - 1));
}

/**
 * Wait for a freshly-spawned replacement worker to emit the
 * `{type:'ready'}` handshake from `parse-worker.ts` before treating its
 * slot as dispatch-ready. Trusting Node's `online` event alone (which
 * fires when the worker thread starts, BEFORE the worker script's
 * top-of-script body runs) let a worker that crashes during init
 * (parser/grammar import failure, missing native binding) slip past
 * pool startup. The pool then only noticed the dead replacement on the
 * first dispatch's idle timeout (default 30s) — a long stall masking
 * an actual crash. This handshake bounds the wait at
 * {@link WORKER_READY_TIMEOUT_MS} and surfaces init failures as
 * `error` / `exit` / `messageerror` events directly. `messageerror` is
 * wired the same way: a V8 deserialization failure during startup is
 * treated as worker death and rejects the readiness promise.
 */
function waitForWorkerReady(worker: Worker): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      worker.removeListener('messageerror', onMessageError);
    };
    const onMessage = (msg: unknown) => {
      // Native postMessage delivers POJO directly via Node's structured
      // clone. The ready handshake is `{type:'ready'}`; any other early
      // message during the startup window is ignored — the eventual
      // timeout / exit / error handlers catch a genuinely-broken worker.
      if (typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'ready') {
        cleanup();
        resolve();
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Replacement worker exited with code ${code} before reporting ready`));
    };
    const onMessageError = (err: Error) => {
      cleanup();
      reject(
        new Error(`Replacement worker emitted messageerror before reporting ready: ${err.message}`),
      );
    };
    // `timer` is declared after `cleanup` so the cleanup closure can reference
    // it. The const is reached before any handler attaches below, so no TDZ
    // access can fire from the listeners.
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Replacement worker did not report ready within ${WORKER_READY_TIMEOUT_MS}ms — likely crashed during top-of-script init`,
        ),
      );
    }, WORKER_READY_TIMEOUT_MS);
    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    worker.once('messageerror', onMessageError);
  });
}

function estimateItemBytes(item: unknown): number {
  if (typeof item !== 'object' || item === null) return 0;
  const content = (item as { content?: unknown }).content;
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0;
}

function itemPath(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const path = (item as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

/**
 * Best-guess path of the file in flight when a worker dies mid-job — used as
 * the fallback when the authoritative `starting-file` message hasn't been
 * observed yet (very early job-startup crash, or older worker build that
 * doesn't emit the signal).
 *
 * `lastProgress` is the number of files the worker has acknowledged via
 * `progress` messages, so `items[lastProgress]` is the next file it was
 * about to process — the most likely culprit when the worker crashes
 * (OOM, native addon SIGSEGV) or reports an error.
 *
 * Returns `[]` when no path is determinable so the caller retries the whole
 * job.
 */
function inFlightExcludePath<TInput>(job: WorkerJob<TInput>, lastProgress: number): string[] {
  if (lastProgress >= job.items.length) return [];
  const path = itemPath(job.items[lastProgress]);
  return path ? [path] : [];
}

function createJobs<TInput>(
  items: TInput[],
  maxItems: number,
  maxBytes: number,
  timeoutMs: number,
): WorkerJob<TInput>[] {
  const jobs: WorkerJob<TInput>[] = [];
  let startIndex = 0;
  let batch: TInput[] = [];
  let batchBytes = 0;

  const flush = () => {
    if (batch.length === 0) return;
    jobs.push({
      startIndex,
      items: batch,
      estimatedBytes: batchBytes,
      attempt: 0,
      splitDepth: 0,
      timeoutMs,
      cumulativeTimeoutMs: timeoutMs,
    });
    startIndex += batch.length;
    batch = [];
    batchBytes = 0;
  };

  for (const item of items) {
    const itemBytes = estimateItemBytes(item);
    const wouldExceedItems = batch.length >= maxItems;
    const wouldExceedBytes = batch.length > 0 && batchBytes + itemBytes > maxBytes;
    if (wouldExceedItems || wouldExceedBytes) flush();
    batch.push(item);
    batchBytes += itemBytes;
  }
  flush();
  return jobs;
}

/**
 * Create a pool of worker threads.
 *
 * Resilience model (PR #1693 / 1694):
 * - Layer 1 (auto-respawn): a worker `error`/`exit` triggers a replacement on
 *   the same slot, bounded by {@link WorkerPoolOptions.maxRespawnsPerSlot}.
 *   The slot is dropped from the rotation when its budget is exhausted.
 * - Layer 2 (circuit breaker): `consecutiveFailureThreshold` consecutive
 *   worker deaths (no successful job between) — OR all slots exhausting their
 *   respawn budget — trip the breaker. Every subsequent dispatch rejects
 *   with `WorkerPoolDispatchError` and the caller must build a new pool.
 * - Layer 3 (quarantine): a path identified as the in-flight file at the
 *   time of a worker death is added to `quarantined` and filtered out of
 *   future dispatches. Snapshot via {@link WorkerPool.getQuarantinedPaths}.
 * - Layer 4 (authoritative in-flight): the worker emits a `starting-file`
 *   message before each parse attempt; the pool prefers this for crash
 *   attribution and falls back to {@link inFlightExcludePath} only when no
 *   signal has been observed yet.
 * - Layer 5 (cumulative timeout budget): each job tracks the total wall
 *   time spent across all attempts/splits/retries. When the budget is
 *   exhausted, the pool surfaces the in-flight path via `WorkerPoolDispatchError`
 *   instead of letting timeouts compound indefinitely.
 */
export const createWorkerPool = (
  workerUrl: URL,
  poolSize?: number,
  options?: WorkerPoolOptions,
): WorkerPool => {
  // Validate worker script exists before spawning to prevent uncaught
  // MODULE_NOT_FOUND crashes in worker threads (e.g. when running from src/ via vitest)
  const workerPath = fileURLToPath(workerUrl);
  if (!fs.existsSync(workerPath)) {
    throw new Error(`Worker script not found: ${workerPath}`);
  }

  const size = poolSize ?? resolveAutoPoolSize();
  const poolOptions = resolveWorkerPoolOptions(options, size);
  const spawnWorker = options?.workerFactory ?? ((url: URL) => new Worker(url));
  const workers: (Worker | undefined)[] = new Array(size);
  const respawnCount: number[] = new Array(size).fill(0);
  const activeSlots: Set<number> = new Set();
  // Layer 3 (quarantine): tracked via the dedicated `quarantine.ts`
  // module so the resilience layer is addressable as a unit (named
  // interface, isolated tests) rather than an inline Set tangled into
  // 1100+ LOC of pool plumbing. Public worker-pool API is unchanged —
  // `getQuarantinedPaths()` still returns the same defensive copy.
  const quarantine = createQuarantine();
  const initialReadinessFailures: string[] = [];
  // Per-slot consecutive-failure counter (F6): replaces the prior pool-wide
  // scalar so a chronically-failing slot trips the breaker on its own
  // failure streak instead of being masked by another slot's successes.
  // Reset to 0 on that slot's next successful job.
  const consecutiveFailuresPerSlot: number[] = new Array(size).fill(0);
  // Per-slot generation counter (U12). Incremented on every successful
  // worker replacement (see replaceWorker below). Handlers in the
  // dispatch loop capture the slot's generation at attach time and
  // short-circuit when they fire on a stale generation. Defensive layer
  // on top of the existing `settled` flag + listener removal — protects
  // against any future refactor that loosens cleanup() ordering or
  // re-attaches handlers without resetting the per-job state. Exposed
  // via getStats so operators (and tests) can verify a slot was
  // actually replaced and not just the same worker recycled.
  const slotGenerations: number[] = new Array(size).fill(0);
  let poolBroken = false;
  let poolFailure: Error | undefined;

  for (let i = 0; i < size; i++) {
    workers[i] = spawnWorker(workerUrl);
    activeSlots.add(i);
  }

  // Symmetrize the readiness gate across initial and replacement spawn
  // paths. `replaceWorker` already awaits `waitForWorkerReady` per
  // replacement so an init-crashing worker is dropped before dispatch
  // sees it. The initial-spawn loop above didn't — a worker whose
  // top-of-script init crashes (failed tree-sitter native binding,
  // missing dependency) would only be noticed at the first dispatch's
  // 30s idle timeout, vs the 5s WORKER_READY_TIMEOUT_MS bound that
  // replacements enjoy.
  //
  // The promise below settles every initial slot in parallel and drops
  // unready slots from `activeSlots` before any dispatch can fire.
  // `dispatch` awaits it via `initialReadyGate` on first invocation.
  // Wrapped in a single `Promise.allSettled` so a slow worker doesn't
  // block ready workers from being usable — first dispatch waits for
  // all slots' verdicts (good or bad).
  const initialReadyGate: Promise<void> = Promise.allSettled(
    workers.map(async (w, i) => {
      if (!w) return;
      try {
        await waitForWorkerReady(w);
      } catch (err) {
        initialReadinessFailures.push(err instanceof Error ? err.message : String(err));
        logger.warn(
          {
            workerIndex: i,
            err: err instanceof Error ? err.message : String(err),
          },
          `Worker ${i} did not report ready on initial spawn; dropping slot.`,
        );
        await w.terminate().catch(() => undefined);
        workers[i] = undefined;
        activeSlots.delete(i);
      }
    }),
  ).then(() => undefined);

  const dispatch = async <TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
  ): Promise<TResult[]> => {
    // Await the initial-spawn readiness gate (F13). On first dispatch
    // this blocks for up to WORKER_READY_TIMEOUT_MS while every initial
    // worker's `{type:'ready'}` handshake is checked; on subsequent
    // dispatches the promise is already settled and resolves
    // synchronously. Slots whose initial worker crashed in top-of-
    // script init have been dropped from `activeSlots` by the gate
    // before this point — they don't surface here as "no active
    // workers" until *all* initial slots fail.
    await initialReadyGate;
    if (poolBroken) {
      const reason = poolFailure ? `: ${poolFailure.message}` : '';
      throw new WorkerPoolDispatchError(
        `Worker pool circuit breaker tripped${reason}. ` +
          `Subsequent dispatches require a fresh pool instance.`,
        [],
      );
    }
    if (items.length === 0) return [];
    if (activeSlots.size === 0) {
      const detail =
        initialReadinessFailures.length > 0
          ? ` after initial ready handshake: ${initialReadinessFailures.join('; ')}`
          : '';
      throw new WorkerPoolInitializationError(
        `Worker pool has no active workers${detail}`,
        [],
        initialReadinessFailures,
      );
    }

    // Layer 3: filter out quarantined paths so a known-bad file never reaches
    // a worker again this pool lifetime. The caller queries
    // `getQuarantinedPaths` after dispatch to route filtered items.
    const dispatchableItems: TInput[] = [];
    for (const item of items) {
      const path = itemPath(item);
      if (path !== undefined && quarantine.has(path)) continue;
      dispatchableItems.push(item);
    }
    if (dispatchableItems.length === 0) return [];

    const jobs = createJobs(
      dispatchableItems,
      poolOptions.subBatchSize,
      poolOptions.subBatchMaxBytes,
      poolOptions.subBatchIdleTimeoutMs,
    );

    return new Promise<TResult[]>((resolve, reject) => {
      const results: WorkerJobResult<TResult>[] = [];
      const inFlightProgress = new Array(size).fill(0);
      // Tracks which slots are currently mid-job so the "wake idle slots"
      // pass after a requeue doesn't double-dispatch to a busy slot.
      const busySlots: Set<number> = new Set();
      // Per-conceptual-job (identified by startIndex) death count for the
      // unattributable-crash path (F5). On the 2nd time a job dies with
      // no exclusion attribution, requeueRemainder quarantines items[0]
      // as a best-guess culprit to break the death loop.
      const unattributedJobDeaths: Map<number, number> = new Map();
      let completedFiles = 0;
      let activeWorkers = 0;
      let stopped = false;
      let maxReported = 0;

      const wakeIdleSlots = () => {
        if (stopped || jobs.length === 0) return;
        for (const slot of activeSlots) {
          if (busySlots.has(slot)) continue;
          if (jobs.length === 0) break;
          runWorker(slot);
        }
      };

      const reportProgress = () => {
        if (!onProgress) return;
        const inFlight = inFlightProgress.reduce((sum, value) => sum + value, 0);
        const next = Math.min(
          dispatchableItems.length,
          Math.max(maxReported, completedFiles + inFlight),
        );
        if (next === maxReported) return;
        maxReported = next;
        onProgress(next);
      };

      const replaceWorker = async (workerIndex: number): Promise<boolean> => {
        const existing = workers[workerIndex];
        await existing?.terminate().catch(() => undefined);
        workers[workerIndex] = undefined;
        if (stopped) return false;
        const replacement = spawnWorker(workerUrl);
        try {
          await waitForWorkerReady(replacement);
        } catch (err) {
          await replacement.terminate().catch(() => undefined);
          logger.warn(
            { workerIndex, error: err instanceof Error ? err.message : String(err) },
            `Worker ${workerIndex} replacement failed to come online; dropping slot.`,
          );
          return false;
        }
        if (stopped) {
          await replacement.terminate().catch(() => undefined);
          return false;
        }
        workers[workerIndex] = replacement;
        // U12: bump the slot generation atomically with the worker swap so
        // any late event from the OLD worker that somehow slipped past
        // cleanup() carries a stale generation and short-circuits in the
        // handler guard below. Increment AFTER `workers[workerIndex]` is
        // updated so observers (getStats) see the new pair consistently.
        slotGenerations[workerIndex]++;
        return true;
      };

      // Terminal failure path: trip the pool circuit breaker and reject the
      // outer dispatch promise with the cumulative exclude paths. This is the
      // ONLY place that sets `poolBroken = true` — recoverable single-worker
      // failures stay local to `handleWorkerDeath`.
      //
      // Reject the caller's promise BEFORE awaiting `worker.terminate()` so a
      // stuck terminate (OOM-killed thread, hung native addon) can't block
      // the caller indefinitely. Worker cleanup runs in the background; the
      // next `dispatch` call sees `poolBroken=true` and rejects up front.
      const tripBreaker = (err: WorkerPoolDispatchError) => {
        poolBroken = true;
        poolFailure = err;
        if (stopped) return;
        stopped = true;
        reject(err);
        const liveWorkers = workers.slice();
        for (let i = 0; i < workers.length; i++) workers[i] = undefined;
        activeSlots.clear();
        void Promise.all(liveWorkers.map((worker) => worker?.terminate().catch(() => undefined)));
      };

      const maybeDone = () => {
        if (stopped) return;
        if (jobs.length === 0 && activeWorkers === 0) {
          stopped = true;
          results.sort((a, b) => a.startIndex - b.startIndex);
          if (onProgress && maxReported < dispatchableItems.length)
            onProgress(dispatchableItems.length);
          resolve(results.map((result) => result.data));
        }
      };

      // Re-queue the non-quarantined remainder of a dead worker's job so a
      // healthy worker can finish the work. Earlier items in the dead job
      // were never flushed back to the main thread, so they must be
      // re-processed. The new job carries the existing job's startIndex so
      // result ordering is preserved. `cumulativeTimeoutMs` is carried
      // forward unchanged — the death itself consumed no timeout budget,
      // so charging another timeoutMs here would double-bill the next
      // `requeueAfterTimeout` call's accumulation.
      //
      // Unattributed-death tracking (F5): when called with `excluded=[]`
      // the worker died without identifying a culprit (no `starting-file`
      // observed, `lastProgress=0`, `items[lastProgress]` heuristic empty).
      // The first time, re-queue the job intact and hope another worker
      // succeeds. On the second such death of the SAME conceptual job
      // (same `startIndex`), quarantine `items[0]` as a best-guess
      // culprit so the next attempt isn't condemned to the same death.
      // This bounds the unattributable-crash death loop and ensures the
      // pool's final `quarantinedPaths` snapshot carries SOME signal
      // for downstream diagnostics instead of silently re-hitting the
      // bad file.
      const requeueRemainder = (job: WorkerJob<TInput>, excluded: readonly string[]) => {
        let effectiveExcluded = excluded;
        if (excluded.length === 0) {
          const deaths = (unattributedJobDeaths.get(job.startIndex) ?? 0) + 1;
          unattributedJobDeaths.set(job.startIndex, deaths);
          if (deaths < 2) {
            jobs.unshift(job);
            return;
          }
          const firstPath = itemPath(job.items[0]);
          if (firstPath !== undefined) {
            quarantine.add(firstPath);
            logger.warn(
              { startIndex: job.startIndex, firstPath, deaths },
              `Conceptual job ${job.startIndex} died ${deaths} times unattributably; ` +
                `quarantining items[0] (${firstPath}) as best-guess culprit.`,
            );
            effectiveExcluded = [firstPath];
          } else {
            // No identifiable file on items[0] either — drop the job to
            // break the loop. The breaker counter still increments via
            // handleWorkerDeath, so consecutive unattributable deaths
            // eventually trip it even without quarantine signal.
            logger.warn(
              { startIndex: job.startIndex, deaths },
              `Conceptual job ${job.startIndex} died ${deaths} times unattributably with ` +
                `no identifiable file; dropping job to break the death loop.`,
            );
            return;
          }
        }
        const excludeSet = new Set(effectiveExcluded);
        const filtered = job.items.filter((item) => {
          const p = itemPath(item);
          return p === undefined || !excludeSet.has(p);
        });
        if (filtered.length === 0) return;
        jobs.unshift({
          startIndex: job.startIndex,
          items: filtered,
          estimatedBytes: filtered.reduce((sum, item) => sum + estimateItemBytes(item), 0),
          attempt: job.attempt,
          splitDepth: job.splitDepth,
          timeoutMs: job.timeoutMs,
          cumulativeTimeoutMs: job.cumulativeTimeoutMs,
        });
      };

      // Recoverable worker death — quarantine the in-flight path, attempt
      // to respawn the slot, re-queue the rest of the job, and continue.
      // Trips the circuit breaker only when consecutiveFailures crosses the
      // threshold OR all slots have exhausted their respawn budget.
      const handleWorkerDeath = async (
        workerIndex: number,
        reason: string,
        excludePaths: readonly string[],
      ) => {
        if (stopped) return;
        consecutiveFailuresPerSlot[workerIndex]++;
        for (const p of excludePaths) {
          if (p) quarantine.add(p);
        }
        if (consecutiveFailuresPerSlot[workerIndex] >= poolOptions.consecutiveFailureThreshold) {
          tripBreaker(
            new WorkerPoolDispatchError(
              `${reason}. Pool circuit breaker tripped: slot ${workerIndex} hit ` +
                `${consecutiveFailuresPerSlot[workerIndex]} consecutive failures ` +
                `(threshold: ${poolOptions.consecutiveFailureThreshold}).`,
              quarantine.snapshot(),
            ),
          );
          return;
        }
        respawnCount[workerIndex]++;
        if (respawnCount[workerIndex] > poolOptions.maxRespawnsPerSlot) {
          logger.warn(
            {
              workerIndex,
              respawnCount: respawnCount[workerIndex],
              maxRespawns: poolOptions.maxRespawnsPerSlot,
              reason,
            },
            `Worker ${workerIndex} exceeded respawn budget; dropping slot.`,
          );
          const dead = workers[workerIndex];
          await dead?.terminate().catch(() => undefined);
          workers[workerIndex] = undefined;
          activeSlots.delete(workerIndex);
          if (activeSlots.size === 0) {
            tripBreaker(
              new WorkerPoolDispatchError(
                `${reason}. All ${size} worker slot(s) exhausted their respawn budget.`,
                quarantine.snapshot(),
              ),
            );
            return;
          }
          return;
        }
        logger.warn(
          {
            workerIndex,
            respawnCount: respawnCount[workerIndex],
            reason,
            excludePaths,
          },
          `Worker ${workerIndex} died; respawning slot (attempt ${respawnCount[workerIndex]}/${poolOptions.maxRespawnsPerSlot}).`,
        );
        const respawned = await replaceWorker(workerIndex);
        if (!respawned) {
          activeSlots.delete(workerIndex);
          if (activeSlots.size === 0) {
            tripBreaker(
              new WorkerPoolDispatchError(
                `${reason}. Replacement worker startup failed and no slots remain.`,
                quarantine.snapshot(),
              ),
            );
          }
          return;
        }
      };

      // Decision returned by `requeueAfterTimeout`. The caller owns the
      // post-decision orchestration so the death + respawn + dispatch
      // sequence can `await` cleanly (which is required to know when the
      // slot is ready to pick up new work after a give-up).
      type TimeoutDecision =
        | { kind: 'retry' }
        | { kind: 'give-up'; reason: string; excludePaths: readonly string[] };

      const requeueAfterTimeout = (
        workerIndex: number,
        job: WorkerJob<TInput>,
        lastProgress: number,
        inFlightPath: string | undefined,
      ): TimeoutDecision => {
        const nextTimeout = Math.ceil(job.timeoutMs * poolOptions.timeoutBackoffFactor);
        const nextCumulative = job.cumulativeTimeoutMs + nextTimeout;

        // Layer 5: respect the per-job cumulative timeout budget. Once
        // exhausted, surface the in-flight file via WorkerPoolDispatchError
        // instead of letting exponential backoff stall further.
        if (nextCumulative > poolOptions.maxCumulativeTimeoutMs) {
          const firstPath = itemPath(job.items[0]);
          const exhausted: string[] =
            inFlightPath !== undefined
              ? [inFlightPath]
              : firstPath !== undefined
                ? [firstPath]
                : [];
          logger.warn(
            {
              workerIndex,
              cumulativeMs: job.cumulativeTimeoutMs,
              nextCumulativeMs: nextCumulative,
              maxCumulativeMs: poolOptions.maxCumulativeTimeoutMs,
              exhausted,
            },
            `Worker ${workerIndex} parse job exhausted cumulative timeout budget. Surfacing in-flight file(s).`,
          );
          return {
            kind: 'give-up',
            reason:
              `Worker ${workerIndex} parse job exhausted cumulative timeout budget ` +
              `(${(nextCumulative / 1000).toFixed(0)}s > ${(poolOptions.maxCumulativeTimeoutMs / 1000).toFixed(0)}s cap)`,
            excludePaths: exhausted,
          };
        }

        if (job.items.length > 1) {
          const midpoint = Math.ceil(job.items.length / 2);
          const firstItems = job.items.slice(0, midpoint);
          const secondItems = job.items.slice(midpoint);
          const first: WorkerJob<TInput> = {
            startIndex: job.startIndex,
            items: firstItems,
            estimatedBytes: firstItems.reduce((sum, item) => sum + estimateItemBytes(item), 0),
            attempt: job.attempt,
            splitDepth: job.splitDepth + 1,
            timeoutMs: nextTimeout,
            cumulativeTimeoutMs: nextCumulative,
          };
          const second: WorkerJob<TInput> = {
            startIndex: job.startIndex + midpoint,
            items: secondItems,
            estimatedBytes: secondItems.reduce((sum, item) => sum + estimateItemBytes(item), 0),
            attempt: job.attempt,
            splitDepth: job.splitDepth + 1,
            timeoutMs: nextTimeout,
            cumulativeTimeoutMs: nextCumulative,
          };
          logger.warn(
            {
              workerIndex,
              timeoutSec: job.timeoutMs / 1000,
              items: job.items.length,
              estimatedBytes: job.estimatedBytes,
              lastProgress,
              firstSplitItems: first.items.length,
              secondSplitItems: second.items.length,
              nextTimeoutSec: nextTimeout / 1000,
            },
            `Worker ${workerIndex} parse job idle timeout. Splitting into ${first.items.length}/${second.items.length} item jobs.`,
          );
          // Preserve intuitive retry order; final result order is still enforced by startIndex sort.
          jobs.unshift(first, second);
          return { kind: 'retry' };
        }

        const nextAttempt = job.attempt + 1;
        if (nextAttempt <= poolOptions.maxTimeoutRetries) {
          logger.warn(
            {
              workerIndex,
              timeoutSec: job.timeoutMs / 1000,
              attempt: nextAttempt,
              maxAttempts: poolOptions.maxTimeoutRetries + 1,
              nextTimeoutSec: nextTimeout / 1000,
            },
            `Worker ${workerIndex} parse job idle timeout (single item). Retrying with ${nextTimeout / 1000}s timeout.`,
          );
          jobs.unshift({
            ...job,
            attempt: nextAttempt,
            timeoutMs: nextTimeout,
            cumulativeTimeoutMs: nextCumulative,
          });
          return { kind: 'retry' };
        }

        const stalledPath = inFlightPath ?? itemPath(job.items[0]);
        const excludes = stalledPath ? [stalledPath] : [];
        logger.warn(
          {
            workerIndex,
            timeoutSec: job.timeoutMs / 1000,
            stalledPath,
            cumulativeMs: job.cumulativeTimeoutMs,
          },
          `Worker ${workerIndex} parse job idle timeout exhausted retries; quarantining file and respawning slot.`,
        );
        return {
          kind: 'give-up',
          reason:
            `Worker ${workerIndex} parse job idle timeout after ${job.timeoutMs / 1000}s ` +
            `(single item${stalledPath ? `: ${stalledPath}` : ''}, ` +
            `${job.estimatedBytes} bytes, last progress: ${lastProgress})`,
          excludePaths: excludes,
        };
      };

      const runWorker = (workerIndex: number) => {
        if (stopped) return;
        if (!activeSlots.has(workerIndex)) return;
        // Drop quarantined items that may have been re-queued before a death
        // added them to quarantine — keeps the worker from ever seeing a
        // known-bad file. Loops until we find a job with dispatchable items
        // or exhaust the queue (avoids recursion depth growth when many
        // queued jobs are fully quarantined back-to-back).
        let job: WorkerJob<TInput> | undefined;
        while ((job = jobs.shift()) !== undefined) {
          if (quarantine.size === 0) break;
          const dispatchable = job.items.filter((item) => {
            const p = itemPath(item);
            return p === undefined || !quarantine.has(p);
          });
          if (dispatchable.length === 0) continue;
          if (dispatchable.length !== job.items.length) {
            job.items = dispatchable;
            job.estimatedBytes = dispatchable.reduce(
              (sum, item) => sum + estimateItemBytes(item),
              0,
            );
          }
          break;
        }
        if (!job) {
          maybeDone();
          return;
        }

        activeWorkers++;
        busySlots.add(workerIndex);
        inFlightProgress[workerIndex] = 0;
        const worker = workers[workerIndex];
        if (!worker) {
          // Slot's worker is undefined — typically mid-respawn (replaceWorker
          // clears `workers[i]` before awaiting `waitForWorkerOnline`). The
          // respawn IIFE / handleWorkerDeath that started the respawn owns
          // calling runWorker when the new worker is online; we just
          // unshift the job and bail.
          //
          // Do NOT call wakeIdleSlots from here: it would iterate
          // `activeSlots` and re-enter `runWorker` for this same slot
          // (now non-busy), find `workers[i]` still undefined, and
          // recurse until the call stack overflows.
          activeWorkers--;
          busySlots.delete(workerIndex);
          jobs.unshift(job);
          maybeDone();
          return;
        }
        let settled = false;
        let waitingForFlush = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let lastProgress = 0;
        // Authoritative in-flight file from the worker's `starting-file`
        // message. Cleared on `progress` so a between-files crash falls
        // back to the `items[lastProgress]` heuristic, which then points
        // at the next file (the one about to start) — the right guess.
        let inFlightPath: string | undefined;

        const resolveExcludePaths = (): readonly string[] => {
          if (inFlightPath !== undefined) return [inFlightPath];
          return inFlightExcludePath(job, lastProgress);
        };

        const cleanup = () => {
          if (idleTimer) clearTimeout(idleTimer);
          worker.removeListener('message', handler);
          worker.removeListener('error', errorHandler);
          worker.removeListener('exit', exitHandler);
          worker.removeListener('messageerror', messageErrorHandler);
        };

        const finishJob = () => {
          activeWorkers--;
          busySlots.delete(workerIndex);
          inFlightProgress[workerIndex] = 0;
          runWorker(workerIndex);
          maybeDone();
        };

        // Recover-and-resume flow shared by all in-pool worker death sites
        // (`error`, `exit`, msg-channel error). Bridges the per-job teardown
        // into the pool-level handleWorkerDeath recovery + breaker logic.
        const recoverAndResume = async (reason: string, excludePaths: readonly string[]) => {
          activeWorkers--;
          busySlots.delete(workerIndex);
          inFlightProgress[workerIndex] = 0;
          requeueRemainder(job, excludePaths);
          await handleWorkerDeath(workerIndex, reason, excludePaths);
          if (stopped) return;
          // Slot may have been dropped or respawned. Kick the current slot
          // if still active, then wake any other idle live slots so the
          // requeued remainder can be picked up immediately (without this,
          // dropped-slot scenarios can deadlock when no other slot is
          // currently busy and the next finishJob never fires).
          if (activeSlots.has(workerIndex)) {
            runWorker(workerIndex);
          }
          wakeIdleSlots();
          maybeDone();
        };

        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              cleanup();
              inFlightProgress[workerIndex] = 0;
              const stalledPath = inFlightPath;
              const decision = requeueAfterTimeout(workerIndex, job, lastProgress, stalledPath);
              if (decision.kind === 'give-up') {
                // Give-up path: re-queue the non-quarantined remainder,
                // then await handleWorkerDeath so we know when the slot
                // is respawned (or dropped) and can dispatch the next
                // job deterministically.
                void (async () => {
                  activeWorkers--;
                  busySlots.delete(workerIndex);
                  requeueRemainder(job, decision.excludePaths);
                  await handleWorkerDeath(workerIndex, decision.reason, decision.excludePaths);
                  if (stopped) return;
                  if (activeSlots.has(workerIndex)) runWorker(workerIndex);
                  wakeIdleSlots();
                  maybeDone();
                })();
                return;
              }
              // Timeout-retry path: enforce the per-slot respawn budget
              // BEFORE spawning a fresh worker. The previous version
              // called `replaceWorker` unconditionally, letting a
              // chronically-timing-out slot respawn forever.
              //
              // Also increment `consecutiveFailuresPerSlot` here so the
              // per-slot circuit breaker sees pure-timeout death loops
              // (not just crashes). Without it, a slot that consistently
              // times out will consume its full respawn budget without
              // the breaker ever firing — chronic timeouts are
              // structurally the same kind of failure as crashes from
              // the breaker's perspective.
              void (async () => {
                try {
                  respawnCount[workerIndex]++;
                  consecutiveFailuresPerSlot[workerIndex]++;
                  // Complete the per-slot breaker contract on the
                  // timeout-retry path. Without this check, chronic
                  // pure-timeout deaths accumulated `consecutive-
                  // FailuresPerSlot` increments that never tripped the
                  // breaker — only the `respawnCount > maxRespawnsPerSlot`
                  // slot-drop path was active. Now timeouts trip the
                  // breaker on the same threshold as crashes, which is
                  // what the increment was meant to enable.
                  if (
                    consecutiveFailuresPerSlot[workerIndex] >=
                    poolOptions.consecutiveFailureThreshold
                  ) {
                    logger.warn(
                      {
                        workerIndex,
                        consecutiveFailures: consecutiveFailuresPerSlot[workerIndex],
                        threshold: poolOptions.consecutiveFailureThreshold,
                      },
                      `Worker ${workerIndex} hit consecutive-failure threshold on idle-timeout retry; tripping circuit breaker.`,
                    );
                    const dead = workers[workerIndex];
                    await dead?.terminate().catch(() => undefined);
                    workers[workerIndex] = undefined;
                    activeSlots.delete(workerIndex);
                    tripBreaker(
                      new WorkerPoolDispatchError(
                        `Worker pool tripped circuit breaker: slot ${workerIndex} hit ` +
                          `${consecutiveFailuresPerSlot[workerIndex]} consecutive failures ` +
                          `(threshold: ${poolOptions.consecutiveFailureThreshold}).`,
                        quarantine.snapshot(),
                      ),
                    );
                    return;
                  }
                  if (respawnCount[workerIndex] > poolOptions.maxRespawnsPerSlot) {
                    logger.warn(
                      {
                        workerIndex,
                        respawnCount: respawnCount[workerIndex],
                        maxRespawns: poolOptions.maxRespawnsPerSlot,
                      },
                      `Worker ${workerIndex} exceeded respawn budget during idle-timeout retry; dropping slot.`,
                    );
                    const dead = workers[workerIndex];
                    await dead?.terminate().catch(() => undefined);
                    workers[workerIndex] = undefined;
                    activeSlots.delete(workerIndex);
                  } else {
                    const respawned = await replaceWorker(workerIndex);
                    if (!respawned) {
                      activeSlots.delete(workerIndex);
                    }
                  }
                } finally {
                  activeWorkers--;
                  busySlots.delete(workerIndex);
                }
                if (stopped) return;
                if (activeSlots.size === 0) {
                  tripBreaker(
                    new WorkerPoolDispatchError(
                      `Worker pool exhausted all slots during idle-timeout retry.`,
                      quarantine.snapshot(),
                    ),
                  );
                  return;
                }
                reportProgress();
                if (activeSlots.has(workerIndex)) runWorker(workerIndex);
                wakeIdleSlots();
                maybeDone();
              })();
            }
          }, job.timeoutMs);
        };

        // U12: capture the slot's generation at handler-attach time so any
        // late event from a previous worker on this slot (which would carry
        // an older generation) short-circuits below. Defensive — cleanup()
        // already removes listeners synchronously when a death is observed,
        // so under the current control flow no listener should fire on a
        // stale generation. The guard catches future-refactor mistakes.
        const slotGen = slotGenerations[workerIndex];

        const handler = (raw: unknown) => {
          if (slotGenerations[workerIndex] !== slotGen) return;
          if (settled || stopped) return;
          // Native postMessage delivers POJO directly via Node's
          // structured clone. V8 deserialization failures (malformed
          // frame, non-cloneable value) surface as a `messageerror`
          // event handled below — they never reach this handler. The
          // only thing we need to guard for here is a worker that
          // sends a message without a `type` discriminant (a bug in
          // the worker, not a wire-format issue): without the guard
          // `null.type` would throw a TypeError out of the
          // EventEmitter listener → uncaughtException on the main
          // thread.
          const msg = raw as WorkerOutgoingMessage;
          if (msg === null || typeof msg !== 'object' || typeof msg.type !== 'string') {
            settled = true;
            cleanup();
            void recoverAndResume(
              `Worker ${workerIndex} sent a malformed message (no type discriminant)`,
              resolveExcludePaths(),
            );
            return;
          }
          if (msg.type === 'starting-file') {
            inFlightPath = msg.path;
            resetIdleTimer();
          } else if (msg.type === 'progress') {
            const bounded = Math.min(job.items.length, Math.max(0, msg.filesProcessed));
            inFlightProgress[workerIndex] = bounded;
            lastProgress = bounded;
            inFlightPath = undefined;
            resetIdleTimer();
            reportProgress();
          } else if (msg.type === 'warning') {
            resetIdleTimer();
            logger.warn(msg.message);
          } else if (msg.type === 'sub-batch-done') {
            waitingForFlush = true;
            resetIdleTimer();
            worker.postMessage({ type: 'flush' });
          } else if (msg.type === 'error') {
            settled = true;
            cleanup();
            void recoverAndResume(
              `Worker ${workerIndex} error: ${msg.error}`,
              resolveExcludePaths(),
            );
          } else if (msg.type === 'result') {
            if (!waitingForFlush) {
              settled = true;
              cleanup();
              tripBreaker(
                new WorkerPoolDispatchError(
                  `Worker ${workerIndex} protocol error: result before flush`,
                  quarantine.snapshot(),
                ),
              );
              return;
            }
            settled = true;
            cleanup();
            results.push({ startIndex: job.startIndex, data: msg.data as TResult });
            completedFiles += job.items.length;
            // Layer 2 (F6): a successful job resets THIS slot's
            // consecutive-failure counter so the breaker only trips
            // when a specific slot is chronically failing — another
            // slot's successes can't mask a single bad slot.
            consecutiveFailuresPerSlot[workerIndex] = 0;
            reportProgress();
            finishJob();
          } else if (msg.type === 'ready') {
            // No-op: the ready handshake is consumed by `waitForWorkerReady`
            // before dispatch handlers are attached. A stray `ready` here
            // (e.g., a future worker build re-emitting after an internal
            // recovery) is benign — ignore so the exhaustiveness check
            // below keeps catching genuinely-unknown variants.
          } else {
            // F7: exhaustiveness check — drift-catcher when a future
            // WorkerOutgoingMessage variant is added without a handler.
            const _exhaustive: never = msg;
            void _exhaustive;
          }
        };

        const errorHandler = (err: Error) => {
          if (slotGenerations[workerIndex] !== slotGen) return;
          if (!settled) {
            settled = true;
            cleanup();
            void recoverAndResume(
              `Worker ${workerIndex} error: ${err.message}`,
              resolveExcludePaths(),
            );
          }
        };

        const exitHandler = (code: number) => {
          if (slotGenerations[workerIndex] !== slotGen) return;
          if (!settled) {
            settled = true;
            cleanup();
            const excludes = resolveExcludePaths();
            const inFlightSuffix = excludes.length > 0 ? ` (in-flight: ${excludes[0]})` : '';
            void recoverAndResume(
              `Worker ${workerIndex} exited with code ${code}. ` +
                `Likely OOM or native addon failure${inFlightSuffix}.`,
              excludes,
            );
          }
        };

        // `messageerror` fires when V8 fails to deserialize a postMessage
        // payload (e.g., the worker tries to send a non-cloneable value
        // back, or structured-clone hits an unsupported shape). The worker
        // stays ALIVE but the message is lost — without this handler the
        // pool would sit on the dropped message until the idle timeout
        // expires. Treat it as worker death so the resilience layers fire:
        // requeue the remainder via `recoverAndResume`, attribute the
        // in-flight file from the `starting-file` signal (if observed),
        // and let the per-slot respawn budget and circuit breaker decide
        // whether to keep this slot in rotation.
        const messageErrorHandler = (err: Error) => {
          if (slotGenerations[workerIndex] !== slotGen) return;
          if (!settled) {
            settled = true;
            cleanup();
            void recoverAndResume(
              `Worker ${workerIndex} messageerror (postMessage deserialization failure): ${err.message}`,
              resolveExcludePaths(),
            );
          }
        };

        worker.on('message', handler);
        worker.once('error', errorHandler);
        worker.once('exit', exitHandler);
        worker.once('messageerror', messageErrorHandler);
        resetIdleTimer();
        if (stopped) {
          cleanup();
          return;
        }
        const { message, transferList } = buildDispatchMessage(job.items);
        if (transferList) {
          worker.postMessage(message, transferList);
        } else {
          worker.postMessage(message);
        }
      };

      for (const slotIndex of activeSlots) runWorker(slotIndex);
    });
  };

  let terminated = false;
  const terminate = async (): Promise<void> => {
    terminated = true;
    // `.catch(() => undefined)` per-worker matches every other terminate
    // site in this file. Without it, a hung/OOM-killed worker's terminate
    // rejection escapes `Promise.all` and replaces the original pipeline
    // exception when this is called from `runChunkedParseAndResolve`'s
    // finally block — masking the real failure and leaving `workers[]`
    // populated with dead references because the lines below never run.
    await Promise.all(workers.map((w) => w?.terminate().catch(() => undefined)));
    workers.length = 0;
    activeSlots.clear();
  };

  return {
    dispatch,
    terminate,
    size,
    getQuarantinedPaths: () => quarantine.snapshot(),
    getStats: () => ({
      size,
      activeSlots: activeSlots.size,
      droppedSlots: size - activeSlots.size,
      quarantined: quarantine.size,
      poolBroken,
      terminated,
      slotGenerations: slotGenerations.slice(),
    }),
  };
};
