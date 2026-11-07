/**
 * Parent-side embedding sidecar client.
 *
 * Forks the sidecar over IPC and never imports the local ONNX init
 * path, the embeddings barrel, or the pipeline module. Stdio must not inherit
 * parent stdout (MCP JSON-RPC).
 */

import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HF_BASE_DELAY_MS, resolveHfEnvMaxAttempts, resolveHfEnvTimeoutMs } from './hf-env.js';
import {
  EMBEDDING_SIDECAR_DIED_LEAD,
  getLocalEmbeddingRuntimeBlocker,
  LOCAL_EMBEDDING_SIDECAR_ABORT_LEAD,
} from './runtime-support.js';
import type { EmbeddingConfig, ModelProgress } from './types.js';
import type {
  EmbeddingSidecarDevice,
  SidecarRequest,
  SidecarRequestBody,
  SidecarResponse,
} from './embedding-sidecar-protocol.js';
import { logger } from '../logger.js';
import { isDeepStrictEqual } from 'node:util';
import { resolveEmbeddingConfig } from './config.js';

export type ForkImpl = (
  modulePath: string,
  args: readonly string[],
  options: ForkOptions,
) => ChildProcess;

const DEFAULT_EMBED_STALL_MS = 3 * 60 * 1000;
const MAX_RECREATES = 1;

let forkImpl: ForkImpl = fork;
let child: ChildProcess | null = null;
let ready = false;
let nextId = 1;
let recreatesUsed = 0;
let deathSeen = false;
let localUnavailable = false;
let device: EmbeddingSidecarDevice = 'cpu';
let ensureChain: Promise<void> | null = null;
let lastInitOptions:
  | {
      embeddingConfig?: Partial<EmbeddingConfig>;
      forceDevice?: EmbeddingSidecarDevice;
      heapLimitMb?: number;
    }
  | undefined;
let exitHooked = false;
let progressSink: ((progress: ModelProgress) => void) | undefined;
// A caller abort only stops waiting. The child may still be inside ONNX; keep
// its physical requests and process allocation until a response/close proves release.
const physicalRequests = new Map<number, ChildProcess>();
const liveChildren = new Set<ChildProcess>();
let runtimeReservation: { config: EmbeddingConfig; heapLimitMb: number } | undefined;

const pending = new Map<
  number,
  {
    resolve: (value: SidecarResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

export const _setForkForTests = (impl: ForkImpl | null): void => {
  forkImpl = impl ?? fork;
};

export const _resetEmbeddingSidecarForTests = (): void => {
  reapEmbeddingSidecar();
  recreatesUsed = 0;
  deathSeen = false;
  localUnavailable = false;
  ready = false;
  nextId = 1;
  device = 'cpu';
  ensureChain = null;
  lastInitOptions = undefined;
  runtimeReservation = undefined;
  physicalRequests.clear();
  liveChildren.clear();
};

const sidecarScriptPath = (): string => {
  const callerPath = fileURLToPath(import.meta.url);
  const isDev = callerPath.endsWith('.ts');
  const file = isDev ? 'embedding-sidecar.ts' : 'embedding-sidecar.js';
  return path.join(path.dirname(callerPath), file);
};

const tsxHookArgs = (): string[] => {
  const callerPath = fileURLToPath(import.meta.url);
  if (!callerPath.endsWith('.ts')) return [];
  const require = createRequire(import.meta.url);
  return ['--import', pathToFileURL(require.resolve('tsx/esm')).href];
};

const childEnv = (configPinned = false): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.GITNEXUS_EMBEDDING_URL;
  if (configPinned) {
    // The admitted, resolved config travels over IPC. An environment mutation
    // between admission and lazy model init must not override its allocations.
    for (const name of [
      'THREADS',
      'DEVICE',
      'BATCH_SIZE',
      'SUB_BATCH_SIZE',
      'MAX_INPUT_CHARS',
      'MODEL_ID',
      'CHUNK_SIZE',
      'CHUNK_OVERLAP',
      'CHUNK_STRATEGY',
    ]) {
      delete env[`GITNEXUS_EMBEDDING_${name}`];
    }
  }
  return env;
};

/** Parent timer starts before `child.send()`; child starts each download timeout after IPC. */
export const SIDECAR_INIT_IPC_SLACK_MS = 10_000;

export const sidecarInitTimeoutMs = (): number => {
  const perAttempt = resolveHfEnvTimeoutMs();
  const attempts = resolveHfEnvMaxAttempts();
  // Child retries use exponential waits between attempts (HF_BASE_DELAY_MS * 2^i).
  const backoffMs = attempts > 1 ? HF_BASE_DELAY_MS * (2 ** (attempts - 1) - 1) : 0;
  return perAttempt * attempts + backoffMs + SIDECAR_INIT_IPC_SLACK_MS;
};

export const sidecarEmbedTimeoutMs = (): number => {
  const raw = Number(process.env.GITNEXUS_EMBEDDING_SIDECAR_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_EMBED_STALL_MS;
};

export class EmbeddingSidecarDeadError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(code: number | null, signal: NodeJS.Signals | null) {
    const detail = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
    super(`${EMBEDDING_SIDECAR_DIED_LEAD} (${detail})`);
    this.name = 'EmbeddingSidecarDeadError';
    this.code = code;
    this.signal = signal;
  }
}

const NATIVE_ABORT_SIGNALS = new Set<NodeJS.Signals>(['SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL']);

const localUnavailableError = (): Error => new Error(LOCAL_EMBEDDING_SIDECAR_ABORT_LEAD);

const noteChildDeath = (signal?: NodeJS.Signals | null): void => {
  deathSeen = true;
  if (signal && NATIVE_ABORT_SIGNALS.has(signal)) {
    localUnavailable = true;
  }
};

const rejectAll = (error: Error): void => {
  const waiters = [...pending.values()];
  for (const waiter of waiters) {
    waiter.reject(error);
  }
};

const attachChild = (proc: ChildProcess): void => {
  liveChildren.add(proc);
  proc.stderr?.on('data', (chunk: Buffer | string) => {
    logger.debug({ sidecar: true }, String(chunk).trimEnd());
  });
  proc.on('message', (msg: SidecarResponse) => {
    if (msg.type !== 'progress' && physicalRequests.get(msg.id) === proc)
      physicalRequests.delete(msg.id);
    if (child !== proc) return;
    if (msg.type === 'progress') {
      progressSink?.({
        status: msg.status,
        progress: msg.progress,
      });
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    waiter.resolve(msg);
  });
  proc.on('close', (code, signal) => {
    liveChildren.delete(proc);
    for (const [id, owner] of physicalRequests) if (owner === proc) physicalRequests.delete(id);
    if (child !== proc) return;
    noteChildDeath(signal);
    child = null;
    ready = false;
    rejectAll(new EmbeddingSidecarDeadError(code, signal));
  });
  proc.on('error', (err) => {
    if (child !== proc) return;
    noteChildDeath(null);
    child = null;
    ready = false;
    rejectAll(err instanceof Error ? err : new Error(String(err)));
  });
};

const request = (
  msg: SidecarRequestBody,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SidecarResponse> => {
  if (!child) return Promise.reject(new Error('Embedding sidecar is not running'));
  const proc = child;
  try {
    signal?.throwIfAborted();
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      finish(() => {
        try {
          signal!.throwIfAborted();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Embedding sidecar request timed out after ${timeoutMs}ms (${msg.type})`));
      });
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => finish(() => resolve(value)),
      reject: (error) => finish(() => reject(error)),
      timer,
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      physicalRequests.set(id, proc);
      proc.send({ ...msg, id } as SidecarRequest);
    } catch (err) {
      physicalRequests.delete(id);
      finish(() => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    }
  });
};

const spawnSidecar = (heapLimitMb?: number): ChildProcess => {
  if (liveChildren.size > 0) {
    throw new Error('Previous embedding sidecar has not released its native resource reservation');
  }
  const proc = forkImpl(sidecarScriptPath(), [], {
    execArgv: [
      ...tsxHookArgs(),
      ...(heapLimitMb === undefined
        ? []
        : [`--max-old-space-size=${heapLimitMb}`, '--max-semi-space-size=16']),
    ],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: childEnv(runtimeReservation !== undefined),
  });
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      reapEmbeddingSidecar();
    });
  }
  return proc;
};

export const reapEmbeddingSidecar = (): void => {
  if (!child) return;
  const proc = child;
  child = null;
  ready = false;
  rejectAll(new Error('Embedding sidecar reaped'));
  try {
    proc.kill('SIGKILL');
  } catch {
    // already gone
  }
};

/** Reap and wait for the killed child's close/error so an awaited dispose is a real boundary. */
export const reapEmbeddingSidecarAndWait = async (
  timeoutMs = 5_000,
  options: { requireExit?: boolean } = {},
): Promise<void> => {
  const proc = child;
  if (!proc) return;
  const closed = new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    proc.once('close', finish);
    if (!options.requireExit) proc.once('error', finish);
  });
  reapEmbeddingSidecar();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () =>
            options.requireExit
              ? reject(
                  new Error('Embedding sidecar has not released its native resource reservation'),
                )
              : resolve(),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const getSidecarDevice = (): EmbeddingSidecarDevice | null => (ready ? device : null);

type EnsureSidecarOptions = {
  onProgress?: (progress: ModelProgress) => void;
  embeddingConfig?: Partial<EmbeddingConfig>;
  forceDevice?: EmbeddingSidecarDevice;
  signal?: AbortSignal;
};

const markUnavailableIfBudgetSpent = (): void => {
  if (deathSeen && recreatesUsed >= MAX_RECREATES) {
    localUnavailable = true;
  }
};

const spawnAndInit = async (options?: EnsureSidecarOptions): Promise<void> => {
  const runtimeBlocker = getLocalEmbeddingRuntimeBlocker();
  if (runtimeBlocker) {
    throw new Error(runtimeBlocker);
  }
  markUnavailableIfBudgetSpent();
  if (localUnavailable) throw localUnavailableError();

  if (deathSeen) {
    recreatesUsed += 1;
    deathSeen = false;
  }

  const persisted = {
    embeddingConfig:
      runtimeReservation?.config ??
      resolveEmbeddingConfig(options?.embeddingConfig ?? lastInitOptions?.embeddingConfig),
    forceDevice:
      options?.forceDevice ?? (runtimeReservation ? undefined : lastInitOptions?.forceDevice),
    heapLimitMb: runtimeReservation?.heapLimitMb ?? lastInitOptions?.heapLimitMb,
  };

  child = spawnSidecar(persisted.heapLimitMb);
  attachChild(child);
  progressSink = options?.onProgress;
  try {
    const response = await request(
      {
        type: 'init',
        embeddingConfig: persisted.embeddingConfig,
        forceDevice: persisted.forceDevice,
      },
      sidecarInitTimeoutMs(),
    );
    if (response.type === 'error') throw new Error(response.message);
    if (response.type !== 'ready') {
      throw new Error(`Unexpected sidecar response: ${response.type}`);
    }
    ready = true;
    device = response.device;
    lastInitOptions = persisted;
  } catch (err) {
    reapEmbeddingSidecar();
    throw err;
  } finally {
    progressSink = undefined;
  }
};

const rejectConflictingForceDevice = (forceDevice?: EmbeddingSidecarDevice): void => {
  if (forceDevice && forceDevice !== device) {
    throw new Error(
      `Embedding sidecar already initialized on ${device}; cannot switch to ${forceDevice}`,
    );
  }
};

const raceAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  try {
    signal.throwIfAborted();
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      try {
        signal.throwIfAborted();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
};

export const ensureEmbeddingSidecar = async (
  options?: EnsureSidecarOptions,
): Promise<{ device: EmbeddingSidecarDevice }> => {
  if (runtimeReservation) {
    if (
      options?.forceDevice &&
      runtimeReservation.config.device !== 'auto' &&
      options.forceDevice !== runtimeReservation.config.device
    ) {
      throw new Error('Embedding device conflicts with an active job resource reservation');
    }
    for (const [key, value] of Object.entries(options?.embeddingConfig ?? {})) {
      if (
        value !== undefined &&
        value !== runtimeReservation.config[key as keyof EmbeddingConfig]
      ) {
        throw new Error(
          'Embedding configuration conflicts with an active job resource reservation',
        );
      }
    }
    options = { ...options, embeddingConfig: runtimeReservation.config };
  }
  if (localUnavailable) throw localUnavailableError();
  if (ready && child) {
    rejectConflictingForceDevice(options?.forceDevice);
    return { device };
  }

  if (!ensureChain) {
    const { signal: _ignored, ...initOptions } = options ?? {};
    ensureChain = spawnAndInit(initOptions).finally(() => {
      ensureChain = null;
    });
  }
  await raceAbort(ensureChain, options?.signal);
  rejectConflictingForceDevice(options?.forceDevice);
  return { device };
};

export interface EmbeddingSidecarReservation {
  initialize(onProgress?: (progress: ModelProgress) => void): Promise<void>;
  embedBatch(texts: string[], options?: { signal?: AbortSignal }): Promise<Float32Array[]>;
  release(): void;
}

/** Admit before opening job databases; acquire does not load a model. A warm
 * compatible sidecar remains usable, and only one job can reconfigure it. */
export async function reserveEmbeddingSidecar(
  config: EmbeddingConfig,
  heapLimitMb: number,
): Promise<EmbeddingSidecarReservation> {
  if (!Number.isSafeInteger(heapLimitMb) || heapLimitMb < 128)
    throw new Error('Embedding sidecar heap allocation must be at least 128 MiB');
  if (runtimeReservation || ensureChain || physicalRequests.size > 0)
    throw new Error('Embedding runtime is busy; cannot reassign its resource reservation');
  const reservation = { config: Object.freeze({ ...config }), heapLimitMb };
  runtimeReservation = reservation;
  try {
    if (
      child &&
      (!ready ||
        lastInitOptions?.heapLimitMb !== heapLimitMb ||
        !isDeepStrictEqual(lastInitOptions?.embeddingConfig, config))
    ) {
      await reapEmbeddingSidecarAndWait(5_000, { requireExit: true });
    }
    if (liveChildren.size > (child ? 1 : 0))
      throw new Error(
        'Previous embedding sidecar has not released its native resource reservation',
      );
    const assertOwned = () => {
      if (runtimeReservation !== reservation)
        throw new Error('Embedding runtime reservation was released');
    };
    return {
      initialize: async (onProgress) => {
        assertOwned();
        await ensureEmbeddingSidecar({ onProgress, embeddingConfig: reservation.config });
      },
      embedBatch: async (texts, options) => {
        assertOwned();
        return sidecarEmbedBatch(texts, options);
      },
      release: () => {
        if (runtimeReservation === reservation) runtimeReservation = undefined;
      },
    };
  } catch (error) {
    if (runtimeReservation === reservation) runtimeReservation = undefined;
    throw error;
  }
}

/** Parser phases reuse the model reservation only after an idle child exits. */
export async function drainEmbeddingSidecarForAnalysis(): Promise<void> {
  if (runtimeReservation || ensureChain || physicalRequests.size > 0)
    throw new Error('Embedding runtime is busy; refusing to reuse its native resource reservation');
  await reapEmbeddingSidecarAndWait(5_000, { requireExit: true });
  if (liveChildren.size > 0)
    throw new Error('Previous embedding sidecar has not released its native resource reservation');
}

const vectorsFromEmbedResponse = (response: SidecarResponse): Float32Array[] => {
  if (response.type === 'error') throw new Error(response.message);
  if (response.type !== 'vectors') {
    throw new Error(`Unexpected sidecar response: ${response.type}`);
  }
  return response.vectors.map((row) => Float32Array.from(row));
};

export const sidecarEmbedBatch = async (
  texts: string[],
  options?: { signal?: AbortSignal },
): Promise<Float32Array[]> => {
  if (texts.length === 0) return [];
  options?.signal?.throwIfAborted();
  if (localUnavailable) throw localUnavailableError();

  if (!ready || !child) {
    await ensureEmbeddingSidecar({ signal: options?.signal });
  }

  try {
    return vectorsFromEmbedResponse(
      await request({ type: 'embed', texts }, sidecarEmbedTimeoutMs(), options?.signal),
    );
  } catch (err) {
    if (!(err instanceof EmbeddingSidecarDeadError)) throw err;
    await ensureEmbeddingSidecar({ signal: options?.signal });
    return vectorsFromEmbedResponse(
      await request({ type: 'embed', texts }, sidecarEmbedTimeoutMs(), options?.signal),
    );
  }
};
