/** Pure admission policy. Reservations are not an OS-enforced RSS limit. */
const MIB = 1024 * 1024;
const GRAPH_POOL_MB = 256;
const VECTOR_POOL_MB = 64;
const MIN_MAIN_HEAP_MB = 384;
const MIN_WORKER_HEAP_MB = 512;
const WORKER_NATIVE_MB = 128;

export interface AnalysisResourceRequest {
  /** Effective process/container RAM, before reserving host headroom. */
  effectiveMemoryBytes: number;
  availableCpus: number;
  /** Explicit total reservation ceiling; independent of the heap-only flag. */
  totalMb?: number;
  mainHeapMb?: number;
  workers?: number;
  workerHeapMb?: number;
  embeddingThreads?: number;
  /** Existing automatic worker policy; explicit workers still wins. */
  preferredWorkers?: number;
  /** Resume/sync can admit embeddings without reserving parser workers. */
  includeParsing?: boolean;
  graphPoolBytes?: number;
  /** LadybugDB COPY accounting uses OS-page-sized granules. */
  graphPoolGranuleRatio?: number;
  /** Resident parent process, charged once per child phase. */
  supervisorBytes?: number;
  /** Estimated peak model/sidecar allocation; zero for an HTTP provider. */
  modelMemoryMb: number;
}

export interface AnalysisResourceBudget {
  readonly totalBytes: number;
  readonly automatic: boolean;
  readonly headroomBytes: number;
  readonly supervisorBytes: number;
  readonly mainHeapMb: number;
  readonly parse: {
    readonly workers: number;
    readonly workerHeapMb: number;
    readonly workerNativeBytes: number;
    readonly graphPoolBytes: number;
    /** Graph writes run after parser workers drain and may use the full CPU allowance. */
    readonly nativeThreads: number;
    readonly reservedBytes: number;
  };
  readonly embedding: {
    readonly graphPoolBytes: number;
    readonly vectorPoolBytes: number;
    readonly modelBytes: number;
    /** Sidecar old-generation allocation, included in modelBytes with native/young space. */
    readonly modelHeapMb: number;
    /** Combined source, expanded text, encoded request, vectors and prefetch. */
    readonly queueBytes: number;
    readonly nativeThreads: number;
    readonly reservedBytes: number;
  };
}

function integer(value: number, label: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function bytes(mb: number, label: string): number {
  return integer(integer(mb, label, 0) * MIB, `${label} in bytes`, 0);
}

export const UNBOUNDED_GRAPH_POOL_MESSAGE =
  "Zero graph pool bytes selects LadybugDB's native 80%-of-RAM default, which bounded analysis cannot reserve. " +
  'Unset GITNEXUS_LBUG_BUFFER_POOL_SIZE for automatic sizing or set a positive byte limit of at least 8388608.';

/** Resolve before opening a writable database or starting parser/model work. */
export function resolveAnalysisResourceBudget(
  request: AnalysisResourceRequest,
): AnalysisResourceBudget {
  if (request.graphPoolBytes === 0) throw new Error(UNBOUNDED_GRAPH_POOL_MESSAGE);
  const memory = integer(request.effectiveMemoryBytes, 'effectiveMemoryBytes');
  const cpus = integer(request.availableCpus, 'availableCpus');
  const embeddingThreads =
    request.embeddingThreads === undefined
      ? Math.min(4, cpus)
      : integer(request.embeddingThreads, 'embedding threads');
  if (embeddingThreads > cpus) throw new Error('Embedding threads exceed the CPU allowance');
  const availableMb = Math.floor(memory / MIB);
  const automatic = request.totalMb === undefined;
  const totalMb =
    request.totalMb === undefined
      ? Math.floor(availableMb * 0.75)
      : integer(request.totalMb, 'resource budget');
  if (totalMb > availableMb) {
    throw new Error(
      `Resource budget ${totalMb} MiB exceeds effective process memory ${availableMb} MiB`,
    );
  }
  const headroomMb = Math.max(128, Math.ceil(totalMb * 0.12));
  const supervisorMb = Math.ceil(
    integer(request.supervisorBytes ?? 0, 'supervisor reservation', 0) / MIB,
  );
  const poolScale = integer(request.graphPoolGranuleRatio ?? 1, 'graph pool granule ratio');
  const graphPoolBytes =
    request.graphPoolBytes === undefined
      ? bytes(
          Math.max(GRAPH_POOL_MB * poolScale, Math.min(4096, Math.floor(totalMb * 0.15))),
          'graph pool',
        )
      : integer(request.graphPoolBytes, 'graph pool bytes', 8 * MIB);
  // Zero is the native engine's unbounded override, never a bounded allocation.
  const graphPoolMb = Math.ceil(graphPoolBytes / MIB);
  const vectorPoolMb = Math.max(VECTOR_POOL_MB, Math.min(4096, Math.floor(totalMb / 8)));
  const modelMb = integer(request.modelMemoryMb, 'model reservation', 0);
  if (modelMb > 0 && modelMb < 512)
    throw new Error(
      'Local model reservation must be at least 512 MiB for heap and native allocations',
    );
  // A supported 10 MiB source node needs its full text/AST working set. Larger
  // explicit budgets must be able to admit it without truncating its content.
  const queueMb = Math.max(16, Math.min(512, Math.floor(totalMb / 32)));
  const embeddingFixedMb =
    headroomMb + supervisorMb + graphPoolMb + vectorPoolMb + modelMb + queueMb;
  const includeParsing = request.includeParsing !== false;
  const cpuWorkers = Math.max(1, cpus - 1);
  const desiredWorkers =
    request.workers === undefined
      ? Math.min(integer(request.preferredWorkers ?? 4, 'preferred workers'), cpuWorkers)
      : integer(request.workers, 'parser workers');
  const explicitWorkerHeapMb =
    request.workerHeapMb === undefined
      ? undefined
      : integer(request.workerHeapMb, 'worker heap reservation');
  const requiredWorkers = includeParsing ? (request.workers ?? 1) : 0;
  const parseBaseMb = headroomMb + supervisorMb + graphPoolMb;
  const parseFixedMb =
    parseBaseMb +
    requiredWorkers * ((explicitWorkerHeapMb ?? MIN_WORKER_HEAP_MB) + WORKER_NATIVE_MB);
  // Node's main-process heap flag overrides Worker resourceLimits. Leave room
  // for that inherited heap in every required worker, even with a smaller cap.
  const maximumMainMb = Math.min(
    totalMb - Math.max(embeddingFixedMb, parseFixedMb),
    Math.floor(
      (totalMb - parseBaseMb - requiredWorkers * WORKER_NATIVE_MB) / (requiredWorkers + 1),
    ),
  );
  const mainHeapMb =
    request.mainHeapMb === undefined
      ? Math.min(16_384, maximumMainMb, Math.max(MIN_MAIN_HEAP_MB, Math.floor(totalMb * 0.35)))
      : integer(request.mainHeapMb, 'main heap reservation');
  const totalBytes = bytes(totalMb, 'resource budget');
  // --memory-budget has an established 200 MiB minimum. Preserve that explicit
  // choice; the larger floor is only the automatic sizing policy.
  const minimumMainMb = request.mainHeapMb === undefined ? MIN_MAIN_HEAP_MB : 200;
  if (mainHeapMb < minimumMainMb || mainHeapMb > maximumMainMb) {
    const requiredMainMb = Math.max(minimumMainMb, request.mainHeapMb ?? 0);
    const minimum =
      requiredMainMb +
      Math.max(
        embeddingFixedMb,
        parseBaseMb +
          requiredWorkers *
            (Math.max(requiredMainMb, explicitWorkerHeapMb ?? MIN_WORKER_HEAP_MB) +
              WORKER_NATIVE_MB),
      );
    throw new Error(
      `Resource budget ${totalMb} MiB cannot admit parser/model work; requires at least ${minimum} MiB for these allocations. ` +
        'Reduce explicit reservations or concurrent analyses, or increase available RAM. ' +
        'If using a local embedding model, an HTTP embedding provider can reduce its reservation.',
    );
  }

  // Explicit worker counts intentionally permit CPU oversubscription, as the
  // parser's existing override does. Reserve every worker's heap/native memory
  // below; automatic concurrency remains bounded by the usable CPU count.
  const workerBudgetMb = totalMb - headroomMb - supervisorMb - graphPoolMb - mainHeapMb;
  if (
    includeParsing &&
    explicitWorkerHeapMb !== undefined &&
    explicitWorkerHeapMb < MIN_WORKER_HEAP_MB
  ) {
    throw new Error(`Worker heap reservation must be at least ${MIN_WORKER_HEAP_MB} MiB`);
  }
  const workers = !includeParsing
    ? 0
    : request.workers === undefined
      ? Math.min(
          desiredWorkers,
          Math.floor(
            workerBudgetMb /
              (Math.max(mainHeapMb, explicitWorkerHeapMb ?? MIN_WORKER_HEAP_MB) + WORKER_NATIVE_MB),
          ),
        )
      : desiredWorkers;
  const workerHeapMb = !includeParsing
    ? 0
    : Math.max(
        mainHeapMb,
        explicitWorkerHeapMb ??
          Math.min(4096, Math.floor(workerBudgetMb / Math.max(1, workers)) - WORKER_NATIVE_MB),
      );
  const parseReservedMb =
    headroomMb +
    supervisorMb +
    graphPoolMb +
    mainHeapMb +
    workers * (workerHeapMb + WORKER_NATIVE_MB);
  if (
    (includeParsing && (workers < 1 || workerHeapMb < MIN_WORKER_HEAP_MB)) ||
    parseReservedMb > totalMb
  ) {
    throw new Error(
      `Parser workers do not fit resource budget ${totalMb} MiB; reduce workers or explicit heap reservations`,
    );
  }
  const embeddingReservedMb = mainHeapMb + embeddingFixedMb;
  return Object.freeze({
    totalBytes,
    automatic,
    headroomBytes: bytes(headroomMb, 'headroom'),
    supervisorBytes: bytes(supervisorMb, 'supervisor reservation'),
    mainHeapMb,
    parse: Object.freeze({
      workers,
      workerHeapMb,
      workerNativeBytes: bytes(WORKER_NATIVE_MB, 'worker native reservation'),
      graphPoolBytes,
      nativeThreads: cpus,
      reservedBytes: bytes(parseReservedMb, 'parse reservation'),
    }),
    embedding: Object.freeze({
      graphPoolBytes,
      vectorPoolBytes: bytes(vectorPoolMb, 'vector pool'),
      modelBytes: bytes(modelMb, 'model reservation'),
      modelHeapMb: modelMb === 0 ? 0 : Math.min(1024, Math.floor(modelMb / 4)),
      queueBytes: bytes(queueMb, 'embedding queues'),
      nativeThreads: embeddingThreads,
      reservedBytes: bytes(embeddingReservedMb, 'embedding reservation'),
    }),
  });
}

/** Account retained payloads before admission, including a prefetched unit. */
export class EmbeddingByteBudget {
  private retained = 0;
  private peak = 0;

  constructor(readonly limit: number) {
    integer(limit, 'embedding byte budget');
  }

  get usedBytes(): number {
    return this.retained;
  }
  get peakBytes(): number {
    return this.peak;
  }

  reserve(size: number): () => void {
    integer(size, 'retained payload bytes', 0);
    if (size > this.limit - this.retained) {
      throw new Error(
        `Embedding payload requires ${size} bytes with ${this.limit - this.retained} bytes available`,
      );
    }
    this.retained += size;
    this.peak = Math.max(this.peak, this.retained);
    let released = false;
    return () => {
      if (released) throw new Error('Embedding byte reservation released twice');
      released = true;
      this.retained -= size;
    };
  }
}
