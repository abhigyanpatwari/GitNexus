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
   * are not safe to re-attempt in workers. They are dropped from the run (the
   * sequential fallback that once re-parsed them was removed); inspect the
   * quarantine snapshot before and after each dispatch to surface skipped files
   * in diagnostics.
   */
  dispatch<TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
    chunkHash?: string,
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
   * stalls before the pool finally quarantines the bad file and proceeds
   * without it. Default 5x `subBatchIdleTimeoutMs`.
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
  /**
   * Storage path for the disk-backed ParsedFile store (#1983 parallel
   * serialization). When set, it is baked into every spawned worker's
   * `workerData` so the worker writes its own ParsedFile shards to disk
   * instead of returning them over the MessageChannel for the main thread to
   * serialize. Immutable for the run; captured in the default factory closure
   * so RESPAWNED workers inherit it automatically (all spawn sites reuse the
   * same factory). `undefined` ⇒ workers fall back to returning ParsedFiles in
   * the result (small-repo / no-storage path).
   */
  parsedFileStoreStoragePath?: string;
  /**
   * Directory for the DURABLE, content-addressed ParsedFile store
   * (`getDurableParsedFileDir`). When set (alongside a chunk hash on the
   * dispatch), the worker ALSO writes its ParsedFiles to a content-addressed
   * shard keyed by chunk hash so a future warm parse-cache hit can restore
   * them without re-parsing (#2038 warm-cache coverage). Baked into every
   * worker's `workerData` exactly like {@link parsedFileStoreStoragePath}.
   * `undefined` ⇒ no durable write.
   */
  durableParsedFileStoragePath?: string;
  /**
   * CFG/PDG opt-in (#2081 M1). Baked into every spawned worker's `workerData`
   * (like the store paths above); when `true`, workers build a per-function
   * control-flow graph from the tree-sitter AST and attach it to
   * `ParsedFile.cfgSideChannel`. `undefined`/`false` ⇒ no CFG work.
   */
  pdg?: boolean;
  /** Per-function source-line cap for worker-side CFG construction (0 ⇒ no cap). */
  pdgMaxFunctionLines?: number;
  /**
   * Max wall time `terminate()` waits for a retired worker that has NOT yet
   * reached a JS-visible safe point before giving up on terminating it
   * (#2432). Terminating a worker thread that is inside an N-API call aborts
   * the whole process (`Napi::Error` → `std::terminate` → SIGABRT) — and the
   * same abort fires at plain process exit, so the drain is what makes
   * shutdown safe. On expiry the worker is left running (unref'd, with its
   * at-safe-point terminate listener still armed) and a diagnostic is logged.
   * Default 30000ms — above the C++ capture budget
   * (`GITNEXUS_CPP_CAPTURE_BUDGET_MS`, 20000ms) so the drain converges for
   * the known pathological class. 0 ⇒ no wait (test hook).
   */
  shutdownDrainMs?: number;
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

/**
 * How a total worker-startup failure was classified by the pool's bounded
 * self-heal (#1741). Lets the caller render an accurate cause without
 * inspecting any operator flag:
 *  - 'deterministic-startup': ≥2 fresh workers crashed with the SAME signature
 *    before any reached ready (e.g. a missing native binding) — retrying is
 *    futile, so the pool short-circuited fast.
 *  - 'transient-exhausted': workers crashed variably and exhausted the bounded
 *    startup retry budget without ever reaching ready.
 */
export type StartupCrashClass = 'deterministic-startup' | 'transient-exhausted';

export class WorkerPoolInitializationError extends WorkerPoolDispatchError {
  readonly readinessFailures: readonly string[];
  /** Pool's automatic classification of the startup crash (#1741). */
  readonly crashClass: StartupCrashClass;

  constructor(
    message: string,
    quarantinedPaths: readonly string[] = [],
    readinessFailures: readonly string[] = [],
    crashClass: StartupCrashClass = 'transient-exhausted',
  ) {
    super(message, quarantinedPaths);
    this.name = 'WorkerPoolInitializationError';
    this.readinessFailures = readinessFailures;
    this.crashClass = crashClass;
  }
}

/**
 * Thrown when a caller asks GitNexus to parse without the worker pool —
 * `--workers 0`, `GITNEXUS_WORKER_POOL_SIZE=0`, or `skipWorkers: true`.
 *
 * GitNexus no longer has a sequential parser: the worker pool (with its
 * quarantine + respawn/recycle + circuit-breaker resilience) is the SOLE
 * parse path. These channels used to select an in-process fallback; they are
 * now hard configuration errors so the operator gets an actionable message
 * instead of silently parsing through a (deleted) slower path.
 */
export class WorkerPoolDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerPoolDisabledError';
  }
}

/** Message shapes sent back by worker threads. */
type WorkerOutgoingMessage =
  | { type: 'progress'; filesProcessed: number }
  | { type: 'warning'; message: string }
  | { type: 'sub-batch-done' }
  /**
   * Worker-side caught error. `error` is the message; `errorStack` carries the
   * worker thread's stack so the pool can embed a real file:line into its
   * death / circuit-breaker reason instead of surfacing a bare one-liner (the
   * #2068 diagnosability gap). `errorStack` is optional so an older worker
   * build that only sends `error` still validates and degrades to message-only
   * — and a newer pool reading it just gets no stack.
   */
  | { type: 'error'; error: string; errorStack?: string }
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
  /**
   * Content hash of the parse chunk these items belong to (when the caller
   * dispatches per content-addressed chunk). Threaded into the worker's
   * `flush` message so the worker can additionally write a durable,
   * content-addressed ParsedFile shard for warm-cache reuse. Carried through
   * every job-derivation site (split/requeue) so a split sub-job still tags
   * its durable shard with the chunk hash. `undefined` ⇒ no durable write
   * (tests / no-cache / no storage path).
   */
  chunkHash?: string;
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

// ── Self-healing startup restart policy (#1741) ──────────────────────────────
// A worker that crashes during top-of-script init (broken native binding, bad
// import) is retried a BOUNDED number of times with jittered backoff before
// its slot is dropped, so a transient blip self-heals with no operator
// intervention. The bound is the whole point of #1741: recovery must never
// become a silent, unbounded "stuck" run. When the budget is exhausted (or a
// deterministic crash-loop is detected), the slot is dropped; if every slot is
// dropped the first dispatch fails fast with the captured cause.
/** Retries beyond the first attempt, per slot, to bring a startup worker ready. */
const STARTUP_RESTART_BUDGET = 2;
const RESTART_BACKOFF_BASE_MS = 250;
const RESTART_BACKOFF_CAP_MS = 2_000;
/**
 * When this many freshly-spawned workers crash with the SAME crash signature
 * before ANY worker reaches the `{type:'ready'}` handshake, the failure is
 * deterministic (the #1741 missing-binding case: every worker prints a
 * byte-identical native-binding stack). The pool stops retrying immediately
 * instead of burning every slot's budget, and fails fast with the cause.
 */
const DETERMINISTIC_STARTUP_FINGERPRINT_THRESHOLD = 2;

/**
 * Capped exponential backoff with FULL jitter (AWS "Exponential Backoff And
 * Jitter"): random(0, min(CAP, BASE·2^attempt)). Full jitter de-synchronizes
 * the N workers that crash near-simultaneously on a shared startup fault so
 * their respawns don't re-storm in lockstep (Google SRE thundering herd).
 */
function startupBackoffMs(attempt: number): number {
  const ceil = Math.min(RESTART_BACKOFF_CAP_MS, RESTART_BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * (ceil + 1));
}

/**
 * Sleep used between startup self-heal retries. The timer is intentionally NOT
 * `unref`'d: a pending retry is necessary work, so it must keep the event loop
 * alive long enough to actually respawn — otherwise a pool whose only live work
 * is a startup backoff could let the process exit mid-recovery (#1741). To
 * avoid wedging shutdown, the timer registers a cancel function in `pending`;
 * `terminate()` invokes those cancels to `clearTimeout` and resolve early, and
 * a normally-fired timer removes its own cancel. `aborted()` is checked once up
 * front; the CALLER re-checks after wake (it owns the terminated/deterministic
 * decision) — this function does not itself re-evaluate abort on wake.
 */
function abortableSleep(
  ms: number,
  aborted: () => boolean,
  pending: Set<() => void>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ms <= 0 || aborted()) {
      resolve();
      return;
    }
    // `cancel` is registered so terminate() can clear a pending backoff; it is
    // also the timer's own callback, so a normally-fired sleep self-deregisters.
    const cancel = () => {
      clearTimeout(timer);
      pending.delete(cancel);
      resolve();
    };
    const timer = setTimeout(cancel, ms);
    pending.add(cancel);
  });
}

/**
 * Normalize a worker crash message into a stable signature so two instances of
 * the SAME deterministic crash compare equal while unrelated crashes don't.
 * Strips hex addresses, digit runs (pids / line numbers / timestamps) and
 * absolute paths. Best-effort by design: the deterministic classification's
 * correctness rests on the STRUCTURAL signal (zero workers ever ready + startup
 * budget exhausted), so an imperfect signature only changes how fast the
 * short-circuit fires, never whether the pool ultimately fails fast. Even a
 * stderr-less crash normalizes its "exited with code N" message to a stable
 * key, so the empty-stderr timing case still groups.
 *
 * @internal Exported for unit tests; production callers are in this module.
 */
export function crashSignature(message: string): string {
  return (
    message
      .replace(/0x[0-9a-fA-F]+/g, '0xADDR') // 0x-prefixed addresses
      // Windows backslash paths (optional drive letter), e.g. C:\Users\ci\Temp\w-7f3a.js
      .replace(/(?:[A-Za-z]:)?(?:\\[^\s\\'"]+)+/g, '\\PATH')
      .replace(/(?:\/[^\s:'"]+)+/g, '/PATH') // POSIX paths
      .replace(/\b[0-9a-fA-F]{6,}\b/g, 'HEX') // bare hex runs (ASLR addrs / backtrace tokens)
      .replace(/[0-9]+/g, 'N') // pids / line numbers / exit codes / timestamps
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
  );
}

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

/** See {@link WorkerPoolOptions.shutdownDrainMs}. */
const DEFAULT_SHUTDOWN_DRAIN_MS = 30_000;

interface ResolvedWorkerPoolOptions {
  subBatchSize: number;
  subBatchMaxBytes: number;
  subBatchIdleTimeoutMs: number;
  maxTimeoutRetries: number;
  timeoutBackoffFactor: number;
  maxRespawnsPerSlot: number;
  maxCumulativeTimeoutMs: number;
  consecutiveFailureThreshold: number;
  shutdownDrainMs: number;
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
    shutdownDrainMs:
      nonNegativeInteger(options.shutdownDrainMs) ??
      nonNegativeInteger(process.env.GITNEXUS_WORKER_SHUTDOWN_DRAIN_MS) ??
      DEFAULT_SHUTDOWN_DRAIN_MS,
  };
}

/**
 * The pool size requested via the `GITNEXUS_WORKER_POOL_SIZE` env var, or
 * `undefined` when unset, empty/whitespace, or invalid. Module-internal sizing
 * reader consumed by {@link resolveAutoPoolSize} (the env override) and
 * {@link workerPoolDisabledByEnv} (the disabled-channel check). Reads only —
 * never mutates `process.env`. Empty/whitespace is treated as *unset* (falls
 * through to the auto formula), not as 0 — an empty assignment (`export
 * GITNEXUS_WORKER_POOL_SIZE=`) is an accident, not a request for zero workers;
 * only a literal `0` disables the pool.
 */
function envWorkerPoolSize(): number | undefined {
  const raw = process.env.GITNEXUS_WORKER_POOL_SIZE;
  if (raw === undefined || raw.trim() === '') return undefined;
  return nonNegativeInteger(raw);
}

/**
 * True when the operator set `GITNEXUS_WORKER_POOL_SIZE=0` — the env-channel
 * equivalent of `--workers 0`. The parse phase consults this (only when no
 * explicit `--workers <N>` was passed) and HARD-ERRORS: sequential parsing was
 * removed, so a disabled pool is an actionable configuration error, not a
 * silent fallback. An explicit positive `--workers N` always wins.
 */
export function workerPoolDisabledByEnv(): boolean {
  return envWorkerPoolSize() === 0;
}

/**
 * Resolve the auto-default worker pool size when no explicit `poolSize`
 * arg is passed to `createWorkerPool`. Precedence:
 *
 * 1. `GITNEXUS_WORKER_POOL_SIZE` env var (operator override).
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
  const envOverride = envWorkerPoolSize();
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
 * Max characters of a worker's stderr retained for crash diagnostics. A
 * native-binding load failure or a top-of-script throw prints a stack to
 * stderr; we keep the tail so `waitForWorkerReady` can attach the real
 * reason to its rejection instead of the generic "did not report ready".
 */
const WORKER_STDERR_TAIL_LIMIT = 4000;

/**
 * Per-worker captured stderr tail. Populated only for workers spawned with
 * `{ stderr: true }` (the production factory below). Test-injected workers
 * via `workerFactory` typically inherit the parent's stderr and have no
 * `worker.stderr` stream — those are simply skipped (empty tail). A WeakMap
 * so the buffer is released when the worker is GC'd.
 */
const workerStderrTails = new WeakMap<Worker, { text: string }>();

/**
 * Tee a worker's stderr into a bounded in-memory tail (for surfacing the
 * real crash on a startup failure) while still mirroring it to the parent
 * process's stderr — preserving the live-diagnostics behavior workers had
 * when they inherited stderr, before `{ stderr: true }` redirected it to a
 * stream. No-op when the worker has no `stderr` stream (test factories).
 */
function captureWorkerStderr(worker: Worker): void {
  const stream = worker.stderr;
  if (!stream) return;
  const buf = { text: '' };
  workerStderrTails.set(worker, buf);
  stream.on('data', (chunk: Buffer | string) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    process.stderr.write(s);
    buf.text = (buf.text + s).slice(-WORKER_STDERR_TAIL_LIMIT);
  });
  // A stderr stream error must never crash the pool.
  stream.on('error', () => undefined);
}

/** Captured stderr tail for a worker, trimmed; '' when nothing was captured. */
function workerStderrTail(worker: Worker): string {
  return workerStderrTails.get(worker)?.text.trim() ?? '';
}

/** Append the worker's captured stderr to a readiness-failure message. */
function withStderr(worker: Worker, message: string): string {
  const tail = workerStderrTail(worker);
  return tail ? `${message}. Worker stderr:\n${tail}` : message;
}

/**
 * Build a worker-death reason string that carries the worker-side stack when one
 * is available (#2068). The stack is appended AFTER the `Worker N error: <msg>`
 * prefix so every prefix/substring consumer downstream — recoverAndResume →
 * handleWorkerDeath → the circuit-breaker `WorkerPoolDispatchError` message, and
 * the tests that regex-match those — keeps working unchanged, while the operator
 * now gets the real frame instead of a bare one-liner. The stack's first line is
 * normally the message itself; keeping both is harmless and the indented block
 * scans cleanly in a log. The stack is capped at WORKER_STDERR_TAIL_LIMIT,
 * mirroring the sibling stderr-tail bound, so a pathological error type (or a
 * raised `Error.stackTraceLimit`) can't bloat the death reason. `stack` is
 * `undefined` for an older worker build (or a thrown non-Error), in which case
 * the reason is exactly the prior message-only form.
 */
function workerErrorReason(workerIndex: number, message: string, stack?: string): string {
  const base = `Worker ${workerIndex} error: ${message}`;
  return stack ? `${base}\n  worker stack:\n${stack.slice(0, WORKER_STDERR_TAIL_LIMIT)}` : base;
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
      // The 'error' event carries the real top-of-script exception; enrich it
      // with the worker's stderr tail (native-binding stacks land there).
      reject(new Error(withStderr(worker, err.message)));
    };
    const onExit = (code: number) => {
      cleanup();
      reject(
        new Error(
          withStderr(worker, `Replacement worker exited with code ${code} before reporting ready`),
        ),
      );
    };
    const onMessageError = (err: Error) => {
      cleanup();
      reject(
        new Error(
          withStderr(
            worker,
            `Replacement worker emitted messageerror before reporting ready: ${err.message}`,
          ),
        ),
      );
    };
    // `timer` is declared after `cleanup` so the cleanup closure can reference
    // it. The const is reached before any handler attaches below, so no TDZ
    // access can fire from the listeners.
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          withStderr(
            worker,
            `Replacement worker did not report ready within ${WORKER_READY_TIMEOUT_MS}ms — likely crashed during top-of-script init`,
          ),
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
  chunkHash?: string,
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
      chunkHash,
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
 *
 * Upstream of these layers, the parse worker self-sanitizes a result that the
 * structured-clone algorithm can't serialize (#2112) — stripping or dropping
 * the offending value and reporting the affected paths on the result — so a
 * single non-cloneable value can't masquerade as a worker death and exhaust a
 * slot's respawn budget here.
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
  // Production factory spawns with `{ stderr: true }` so a worker's crash
  // output is redirected to a `worker.stderr` stream we can tee + capture
  // (see captureWorkerStderr) and attach to readiness-failure messages —
  // instead of the generic "did not report ready" that hid the real cause
  // in #1741. Test factories (workerFactory) are used verbatim.
  // Bake the (immutable) ParsedFile store path into the factory closure so it
  // reaches EVERY spawned worker — including respawns, which reuse this same
  // factory — via `workerData`, read once at worker init. The `(url) => Worker`
  // signature is unchanged so the zero-arg test factories keep working.
  const parsedFileStoreStoragePath = options?.parsedFileStoreStoragePath;
  const durableParsedFileStoragePath = options?.durableParsedFileStoragePath;
  // CFG/PDG opt-in (#2081 M1) — carried in workerData alongside the store paths.
  const pdg = options?.pdg === true;
  const pdgMaxFunctionLines = options?.pdgMaxFunctionLines;
  const workerStoreData =
    parsedFileStoreStoragePath || durableParsedFileStoragePath || pdg
      ? { parsedFileStoreStoragePath, durableParsedFileStoragePath, pdg, pdgMaxFunctionLines }
      : undefined;
  const spawnWorker =
    options?.workerFactory ??
    ((url: URL) =>
      new Worker(url, {
        stderr: true,
        workerData: workerStoreData,
        // The CFG visitors build per-function control-flow graphs by RECURSIVE
        // descent over the tree-sitter AST, so deeply-nested source overflows
        // the worker thread's call stack. A worker's stack is governed by
        // `resourceLimits.stackSizeMb` (Node default 4 MB) — the main process's
        // `--stack-size` flag does NOT propagate to worker threads — so raise it
        // here. This pushes the overflow threshold from ~1.5k to several-k
        // nesting levels (far beyond any hand-written code); a deeper machine-
        // generated nest is still caught per-function (buildFunctionCfg's R4
        // try/catch) and only that function's PDG is skipped, never a crash.
        resourceLimits: { stackSizeMb: 16 },
      }));
  /** Spawn + wire stderr capture in one step (used by all spawn sites). */
  const spawnAndCapture = (url: URL): Worker => {
    const worker = spawnWorker(url);
    captureWorkerStderr(worker);
    return worker;
  };
  const workers: (Worker | undefined)[] = new Array(size);
  type RetiredWorkerRecord = {
    worker: Worker;
    workerIndex: number;
    reason: string;
    cleanup: () => void;
    terminate: () => Promise<void>;
    /**
     * True once the worker has been observed at a JS-visible safe point
     * (posted a message / messageerror, or died). Until then the worker may
     * be inside an N-API call, and `worker.terminate()` would abort the
     * whole process (`Napi::Error` → SIGABRT, #2432).
     */
    safeToTerminate: boolean;
    /** Resolves when `safeToTerminate` flips (or the worker exits/errors). */
    safePoint: Promise<void>;
  };
  const retiredWorkers = new Set<RetiredWorkerRecord>();
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
  // Set by `terminate()` (below). Also read by the self-healing startup loop so
  // a terminate during startup aborts pending backoff/retries (#1741).
  let terminated = false;

  /** Resolves `true` when `promise` settles within `ms`, else `false`. The
   *  timer is unref'd so an expiring drain never holds the process open. */
  const settledWithin = (promise: Promise<void>, ms: number): Promise<boolean> => {
    if (ms <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
      void promise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  };

  const terminateTrackedWorkers = async (
    liveWorkers: readonly (Worker | undefined)[],
  ): Promise<void> => {
    const retired = Array.from(retiredWorkers);
    await Promise.all([
      ...liveWorkers.map((worker) => worker?.terminate().catch(() => undefined)),
      ...retired.map(async (record) => {
        // #2432: a retired worker that has not reached a JS-visible safe
        // point may be inside an N-API call — terminating it aborts the
        // WHOLE process (`Napi::Error` → std::terminate → SIGABRT). Drain:
        // wait (bounded) for its safe point; on expiry leave it running —
        // it is unref'd and its at-safe-point terminate listener stays
        // armed — and log which file wedged it.
        if (!record.safeToTerminate) {
          const drained = await settledWithin(record.safePoint, poolOptions.shutdownDrainMs);
          if (!drained) {
            logger.warn(
              {
                workerIndex: record.workerIndex,
                reason: record.reason,
                drainMs: poolOptions.shutdownDrainMs,
              },
              `Worker ${record.workerIndex} is still inside native code after the ` +
                `${poolOptions.shutdownDrainMs}ms shutdown drain; leaving it un-terminated ` +
                `to avoid a native abort (#2432). It will be terminated at its next safe point.`,
            );
            return;
          }
        }
        await record.terminate();
      }),
    ]);
    // Undrained records stay tracked so a repeated shutdown call can retry
    // their (now possibly safe) terminate; record.terminate() removes each
    // drained record via its cleanup.
  };

  for (let i = 0; i < size; i++) {
    workers[i] = spawnAndCapture(workerUrl);
    activeSlots.add(i);
  }

  // ── Self-healing startup readiness (#1741) ────────────────────────────────
  // Bring every initial slot to readiness with a BOUNDED, jittered retry loop
  // instead of dropping it on the first crash. This symmetrizes the gate with
  // the runtime `replaceWorker` path (which already respawns a crashed slot),
  // and adds genuine self-healing at startup:
  //
  //  - TRANSIENT crash (a one-off OS hiccup / fork throttle): the slot is
  //    respawned after jittered backoff and retried, up to STARTUP_RESTART_BUDGET
  //    — so a blip heals itself with no operator intervention.
  //  - DETERMINISTIC crash-loop (every worker dies with the SAME signature
  //    before any reaches ready — the #1741 missing-binding case): detected via
  //    `crashSignature` and short-circuited immediately, so the pool gives up in
  //    ~1s rather than burning every slot's budget.
  //
  // When the loop exhausts, the slot is dropped from `activeSlots`. If EVERY
  // slot is dropped, the first dispatch throws WorkerPoolInitializationError
  // carrying the captured crash cause + classification — never a silent hang.
  // Correctness of the deterministic short-circuit rests on the STRUCTURAL
  // signal (zero workers ever ready + budget exhausted), not on signature
  // matching alone: a missed match only costs a few seconds of extra retrying.
  // Deterministic crash-loop detection (#1741). A crash counts toward
  // "deterministic" ONLY after its signature reproduces across a respawn on the
  // same slot — so every slot is guaranteed at least one self-heal attempt and
  // a simultaneous attempt-0 crash storm (e.g. transient `spawn EAGAIN` under
  // fork pressure) cannot be misclassified as deterministic. We short-circuit
  // once enough DISTINCT slots have each reproduced: ≥2 normally, or 1 for a
  // size-1 pool. Until then the structural floor (every slot exhausts its
  // budget) still bounds the worst case, so a missed match only costs retries.
  const lastStartupSignature = new Map<number, string>();
  const reproducedStartupSlots = new Set<number>();
  const deterministicSlotThreshold = Math.min(DETERMINISTIC_STARTUP_FINGERPRINT_THRESHOLD, size);
  let deterministicStartupDetected = false;
  let anyWorkerReachedReady = false;
  // Cancel functions for in-flight startup backoffs (see abortableSleep). The
  // backoff timer is ref'd so a retry actually runs; terminate() invokes these
  // to clear pending backoffs and resolve their sleeps so the slot loops wake,
  // see `terminated`, and give up — instead of the process staying pinned for
  // the backoff cap after terminate (#1741).
  const pendingStartupTimers = new Set<() => void>();

  const bringSlotReady = async (i: number): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      const worker = workers[i];
      if (!worker) return; // terminated mid-startup
      try {
        await waitForWorkerReady(worker);
        anyWorkerReachedReady = true;
        return; // ready — slot stays in activeSlots
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const sig = crashSignature(msg);
        // Same signature as this slot's previous attempt => it survived a
        // respawn, so retrying this slot is futile. (First crash has no prior
        // signature, so attempt 0 never counts — every slot self-heals once.)
        if (lastStartupSignature.get(i) === sig) reproducedStartupSlots.add(i);
        lastStartupSignature.set(i, sig);
        if (!anyWorkerReachedReady && reproducedStartupSlots.size >= deterministicSlotThreshold) {
          deterministicStartupDetected = true;
        }
        await worker.terminate().catch(() => undefined);
        workers[i] = undefined;

        const giveUp =
          terminated || deterministicStartupDetected || attempt >= STARTUP_RESTART_BUDGET;
        if (giveUp) {
          initialReadinessFailures.push(msg);
          activeSlots.delete(i);
          logger.warn(
            { workerIndex: i, attempt, err: msg, deterministic: deterministicStartupDetected },
            deterministicStartupDetected
              ? `Worker ${i} hit a deterministic startup crash-loop; dropping slot without further retries.`
              : `Worker ${i} did not report ready after ${attempt + 1} attempt(s); dropping slot.`,
          );
          return;
        }
        // Transient: jittered backoff, then respawn the slot and retry.
        await abortableSleep(
          startupBackoffMs(attempt),
          () => terminated || deterministicStartupDetected,
          pendingStartupTimers,
        );
        if (terminated || deterministicStartupDetected) {
          initialReadinessFailures.push(msg);
          activeSlots.delete(i);
          return;
        }
        logger.warn(
          { workerIndex: i, attempt: attempt + 1 },
          `Worker ${i} crashed during startup; respawning slot (self-heal attempt ${attempt + 1}/${STARTUP_RESTART_BUDGET}).`,
        );
        workers[i] = spawnAndCapture(workerUrl);
      }
    }
  };

  // First dispatch awaits this; it settles every slot's bounded retry loop in
  // parallel and drops the unrecoverable ones before any dispatch can fire.
  const initialReadyGate: Promise<void> = Promise.allSettled(
    workers.map((_, i) => bringSlotReady(i)),
  ).then(() => undefined);

  const dispatch = async <TInput, TResult>(
    items: TInput[],
    onProgress?: (filesProcessed: number) => void,
    chunkHash?: string,
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
      // The bounded self-heal exhausted (or short-circuited a deterministic
      // crash-loop). Classify automatically so the caller renders the real
      // cause without consulting any operator flag (#1741).
      const crashClass: StartupCrashClass = deterministicStartupDetected
        ? 'deterministic-startup'
        : 'transient-exhausted';
      throw new WorkerPoolInitializationError(
        `Worker pool has no active workers${detail}`,
        [],
        initialReadinessFailures,
        crashClass,
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
      chunkHash,
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

      type WorkerRemovalMode = 'terminate' | 'retire';

      const retireWorkerAfterTimeout = (
        worker: Worker,
        workerIndex: number,
        reason: string,
      ): void => {
        let cleaned = false;
        let terminateStarted = false;
        let resolveSafePoint!: () => void;
        const safePoint = new Promise<void>((resolve) => {
          resolveSafePoint = resolve;
        });

        // A message/messageerror proves the worker is executing JS again; an
        // exit/error means the thread is gone. Either way `worker.terminate()`
        // can no longer land mid-N-API call (#2432), so shutdown's drain may
        // stop waiting.
        function markSafeToTerminate() {
          record.safeToTerminate = true;
          resolveSafePoint();
        }

        function cleanupRetired() {
          if (cleaned) return;
          cleaned = true;
          worker.removeListener('message', onRetiredMessage);
          worker.removeListener('error', onRetiredError);
          worker.removeListener('exit', onRetiredExit);
          worker.removeListener('messageerror', onRetiredMessageError);
          retiredWorkers.delete(record);
        }

        async function terminateRetired() {
          if (terminateStarted) return;
          terminateStarted = true;
          cleanupRetired();
          await worker.terminate().catch(() => undefined);
        }

        function terminateWhenBackInJs() {
          markSafeToTerminate();
          void terminateRetired();
        }

        function onRetiredMessage(raw: unknown) {
          if (raw === null || typeof raw !== 'object') return;
          const type = (raw as { type?: unknown }).type;
          if (type === 'sub-batch-done' || type === 'result' || type === 'error') {
            terminateWhenBackInJs();
          }
        }

        const onRetiredError = () => {
          markSafeToTerminate();
          cleanupRetired();
        };
        const onRetiredExit = () => {
          markSafeToTerminate();
          cleanupRetired();
        };
        const onRetiredMessageError = () => terminateWhenBackInJs();
        const record: RetiredWorkerRecord = {
          worker,
          workerIndex,
          reason,
          cleanup: cleanupRetired,
          terminate: terminateRetired,
          safeToTerminate: false,
          safePoint,
        };
        retiredWorkers.add(record);
        worker.on('message', onRetiredMessage);
        worker.once('error', onRetiredError);
        worker.once('exit', onRetiredExit);
        worker.once('messageerror', onRetiredMessageError);
        (worker as Worker & { unref?: () => void }).unref?.();
        logger.warn(
          { workerIndex, reason },
          `Worker ${workerIndex} timed out; retiring without immediate terminate to avoid aborting native parser state.`,
        );
      };

      const removeWorkerFromSlot = async (
        workerIndex: number,
        mode: WorkerRemovalMode,
        reason: string,
      ): Promise<void> => {
        const existing = workers[workerIndex];
        workers[workerIndex] = undefined;
        if (!existing) return;
        if (mode === 'retire') {
          retireWorkerAfterTimeout(existing, workerIndex, reason);
          return;
        }
        await existing.terminate().catch(() => undefined);
      };

      const replaceWorker = async (
        workerIndex: number,
        mode: WorkerRemovalMode = 'terminate',
        reason = 'replacing worker',
      ): Promise<boolean> => {
        await removeWorkerFromSlot(workerIndex, mode, reason);
        if (stopped) return false;
        const replacement = spawnAndCapture(workerUrl);
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
        // #2432: a live worker with a job in flight may be inside an N-API
        // call — direct terminate risks the same native abort as the retired
        // case. Route busy workers through the retire path (terminate at
        // their next JS-visible safe point); idle workers are parked in the
        // JS event loop and terminate safely right away.
        const idleWorkers: (Worker | undefined)[] = [];
        for (let i = 0; i < liveWorkers.length; i++) {
          const worker = liveWorkers[i];
          if (worker === undefined) continue;
          if (busySlots.has(i)) {
            retireWorkerAfterTimeout(worker, i, 'circuit breaker tripped with job in flight');
          } else {
            idleWorkers.push(worker);
          }
        }
        activeSlots.clear();
        void terminateTrackedWorkers(idleWorkers);
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
          chunkHash: job.chunkHash,
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
        removalMode: WorkerRemovalMode = 'terminate',
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
          await removeWorkerFromSlot(workerIndex, removalMode, reason);
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
        const respawned = await replaceWorker(workerIndex, removalMode, reason);
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
            chunkHash: job.chunkHash,
            timeoutMs: nextTimeout,
            cumulativeTimeoutMs: nextCumulative,
          };
          const second: WorkerJob<TInput> = {
            startIndex: job.startIndex + midpoint,
            items: secondItems,
            estimatedBytes: secondItems.reduce((sum, item) => sum + estimateItemBytes(item), 0),
            attempt: job.attempt,
            splitDepth: job.splitDepth + 1,
            chunkHash: job.chunkHash,
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
                  await handleWorkerDeath(
                    workerIndex,
                    decision.reason,
                    decision.excludePaths,
                    'retire',
                  );
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
                    await removeWorkerFromSlot(
                      workerIndex,
                      'retire',
                      'idle-timeout retry consecutive-failure threshold',
                    );
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
                    await removeWorkerFromSlot(
                      workerIndex,
                      'retire',
                      'idle-timeout retry respawn budget exhausted',
                    );
                    activeSlots.delete(workerIndex);
                  } else {
                    const respawned = await replaceWorker(
                      workerIndex,
                      'retire',
                      'idle-timeout retry',
                    );
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
          // structured clone. Two distinct clone failure modes exist,
          // and NEITHER reaches this handler: (1) a SENDER-side
          // non-cloneable value (a function/symbol that leaked into the
          // result) throws a synchronous `DataCloneError` on the
          // worker's own postMessage — the parse worker self-sanitizes
          // such results before delivery (#2112) and falls back to a
          // primitive-only `{type:'error'}` if it still can't serialize;
          // (2) a RECEIVER-side deserialization failure surfaces as a
          // `messageerror` event handled below. The only thing THIS
          // handler guards is a worker that sends a message without a
          // `type` discriminant (a worker bug, not a wire-format issue):
          // without the guard `null.type` would throw a TypeError out of
          // the EventEmitter listener → uncaughtException on the main
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
            // Carry the chunk hash on the flush so the worker can write a
            // durable, content-addressed ParsedFile shard (warm-cache reuse)
            // at the flush boundary where `accumulated.parsedFiles` is complete.
            worker.postMessage({ type: 'flush', chunkHash: job.chunkHash });
          } else if (msg.type === 'error') {
            settled = true;
            cleanup();
            void recoverAndResume(
              workerErrorReason(workerIndex, msg.error, msg.errorStack),
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
            // The Node 'error' event fires on an UNCAUGHT worker throw (one that
            // escaped the worker's own try/catch, or an async rejection). Unlike
            // the `{type:'error'}` message, the event delivers a real Error whose
            // `.stack` is the worker-side frame — carry it so the surfaced reason
            // points at the actual failure site, not just `err.message` (#2068).
            void recoverAndResume(
              workerErrorReason(workerIndex, err.message, err.stack),
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

        // `messageerror` fires when V8 fails to DESERIALIZE a postMessage
        // payload on THIS (receiver) side — a value that serialized on the
        // worker but can't be reconstructed here. (A non-cloneable value on
        // the SENDER side instead throws a synchronous DataCloneError on the
        // worker's own postMessage; that path is caught and sanitized
        // worker-side (#2112) and never arrives here.) The worker stays ALIVE
        // but the message is lost — without this handler the pool would sit on
        // the dropped message until the idle timeout expires. Treat it as
        // worker death so the resilience layers fire:
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

  const terminate = async (): Promise<void> => {
    terminated = true;
    // Cancel any in-flight startup backoff so its ref'd timer doesn't keep the
    // event loop alive after terminate; each cancel resolves the awaiting sleep
    // and the slot loop then sees `terminated` and gives up (#1741).
    for (const cancel of [...pendingStartupTimers]) cancel();
    // `.catch(() => undefined)` per-worker matches every other terminate
    // site in this file. Without it, a hung/OOM-killed worker's terminate
    // rejection escapes `Promise.all` and replaces the original pipeline
    // exception when this is called from `runChunkedParseAndResolve`'s
    // finally block — masking the real failure and leaving `workers[]`
    // populated with dead references because the lines below never run.
    await terminateTrackedWorkers(workers);
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
      pendingStartupTimers: pendingStartupTimers.size,
      slotGenerations: slotGenerations.slice(),
    }),
  };
};
