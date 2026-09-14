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
import {
  HF_BASE_DELAY_MS,
  HF_DOWNLOAD_TIMEOUT_MS,
  HF_MAX_ATTEMPTS,
  HF_MAX_ATTEMPTS_CAP,
  HF_MAX_TIMEOUT_MS,
} from './hf-env.js';
import {
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
let exitHooked = false;
let progressSink: ((progress: ModelProgress) => void) | undefined;

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

const childEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.GITNEXUS_EMBEDDING_URL;
  return env;
};

/** Parent timer starts before `child.send()`; child starts each download timeout after IPC. */
export const SIDECAR_INIT_IPC_SLACK_MS = 10_000;

export const sidecarInitTimeoutMs = (): number => {
  const rawTimeout = Number(process.env.HF_DOWNLOAD_TIMEOUT_MS);
  const perAttempt =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(rawTimeout, HF_MAX_TIMEOUT_MS)
      : HF_DOWNLOAD_TIMEOUT_MS;
  const rawAttempts = Number(process.env.HF_MAX_ATTEMPTS);
  const attempts =
    Number.isInteger(rawAttempts) && rawAttempts > 0
      ? Math.min(rawAttempts, HF_MAX_ATTEMPTS_CAP)
      : HF_MAX_ATTEMPTS;
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
    super(`Embedding sidecar died (${detail})`);
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
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
};

const attachChild = (proc: ChildProcess): void => {
  proc.stdout?.on('data', () => {
    // Discard — never inherit parent stdout (MCP JSON-RPC).
  });
  proc.stderr?.on('data', (chunk: Buffer | string) => {
    logger.debug({ sidecar: true }, String(chunk).trimEnd());
  });
  proc.on('message', (msg: SidecarResponse) => {
    if (msg.type === 'progress') {
      progressSink?.({
        status: msg.status,
        progress: msg.progress,
      });
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(msg.id);
    waiter.resolve(msg);
  });
  proc.on('close', (code, signal) => {
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

const request = (msg: SidecarRequestBody, timeoutMs: number): Promise<SidecarResponse> => {
  if (!child) return Promise.reject(new Error('Embedding sidecar is not running'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      child?.kill('SIGKILL');
      reject(new Error(`Embedding sidecar request timed out after ${timeoutMs}ms (${msg.type})`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child!.send({ ...msg, id } as SidecarRequest);
  });
};

const spawnSidecar = (): ChildProcess => {
  const proc = forkImpl(sidecarScriptPath(), [], {
    execArgv: tsxHookArgs(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: childEnv(),
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
export const reapEmbeddingSidecarAndWait = async (timeoutMs = 5_000): Promise<void> => {
  const proc = child;
  if (!proc) return;
  const closed = new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    proc.once('close', finish);
    proc.once('error', finish);
  });
  reapEmbeddingSidecar();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const isEmbeddingSidecarReady = (): boolean => ready && child !== null;

export const isLocalEmbeddingsUnavailable = (): boolean => localUnavailable;

export const getSidecarDevice = (): EmbeddingSidecarDevice => device;

const markUnavailableIfBudgetSpent = (): void => {
  if (deathSeen && recreatesUsed >= MAX_RECREATES) {
    localUnavailable = true;
  }
};

const spawnAndInit = async (options?: {
  onProgress?: (progress: ModelProgress) => void;
  embeddingConfig?: Partial<EmbeddingConfig>;
  forceDevice?: EmbeddingSidecarDevice;
}): Promise<void> => {
  const runtimeBlocker = getLocalEmbeddingRuntimeBlocker();
  if (runtimeBlocker) {
    throw new Error(runtimeBlocker);
  }
  markUnavailableIfBudgetSpent();
  if (localUnavailable) throw localUnavailableError();

  if (deathSeen) {
    recreatesUsed += 1;
    deathSeen = false;
    markUnavailableIfBudgetSpent();
    if (localUnavailable) throw localUnavailableError();
  }

  child = spawnSidecar();
  attachChild(child);
  progressSink = options?.onProgress;
  try {
    const response = await request(
      {
        type: 'init',
        embeddingConfig: options?.embeddingConfig,
        forceDevice: options?.forceDevice,
      },
      sidecarInitTimeoutMs(),
    );
    if (response.type === 'error') throw new Error(response.message);
    if (response.type !== 'ready') {
      throw new Error(`Unexpected sidecar response: ${response.type}`);
    }
    ready = true;
    device = response.device;
  } catch (err) {
    reapEmbeddingSidecar();
    throw err;
  } finally {
    progressSink = undefined;
  }
};

export const ensureEmbeddingSidecar = async (options?: {
  onProgress?: (progress: ModelProgress) => void;
  embeddingConfig?: Partial<EmbeddingConfig>;
  forceDevice?: EmbeddingSidecarDevice;
}): Promise<{ device: EmbeddingSidecarDevice }> => {
  if (localUnavailable) throw localUnavailableError();
  if (ready && child) return { device };

  if (!ensureChain) {
    ensureChain = spawnAndInit(options).finally(() => {
      ensureChain = null;
    });
  }
  await ensureChain;
  return { device };
};

const vectorsFromEmbedResponse = (response: SidecarResponse): Float32Array[] => {
  if (response.type === 'error') throw new Error(response.message);
  if (response.type !== 'vectors') {
    throw new Error(`Unexpected sidecar response: ${response.type}`);
  }
  return response.vectors.map((row) => Float32Array.from(row));
};

export const sidecarEmbedBatch = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) return [];
  if (localUnavailable) throw localUnavailableError();

  if (!ready || !child) {
    await ensureEmbeddingSidecar();
  }

  try {
    return vectorsFromEmbedResponse(
      await request({ type: 'embed', texts }, sidecarEmbedTimeoutMs()),
    );
  } catch (err) {
    if (!(err instanceof EmbeddingSidecarDeadError)) throw err;
    await ensureEmbeddingSidecar();
    return vectorsFromEmbedResponse(
      await request({ type: 'embed', texts }, sidecarEmbedTimeoutMs()),
    );
  }
};
