/** Host inputs for the pure phase-admission policy. No native/model imports. */
import os from 'node:os';
import path from 'node:path';
import { effectiveRamBytes } from './ingestion/utils/effective-ram.js';
import { granuleRatio } from './lbug/lbug-config.js';
import {
  resolveAnalysisResourceBudget,
  UNBOUNDED_GRAPH_POOL_MESSAGE,
  type AnalysisResourceBudget,
  type AnalysisResourceRequest,
} from './analysis-resource-budget.js';

const MIB = 1024 * 1024;

function positiveEnvironment(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (name === 'GITNEXUS_LBUG_BUFFER_POOL_SIZE' && value === 0)
    throw new Error(UNBOUNDED_GRAPH_POOL_MESSAGE);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer for bounded analysis`);
  return value;
}

export interface HostAnalysisResourceOptions {
  totalMb?: number;
  mainHeapMb?: number;
  workers?: number;
  includeParsing?: boolean;
  /** Local model capacity is only reserved when this invocation may embed. */
  includeEmbeddings: boolean;
  supervisorBytes?: number;
  /** Share one host envelope among concurrent auto-sync analyses. */
  concurrency?: number;
}

export function resolveHostAnalysisResources(
  options: HostAnalysisResourceOptions,
): AnalysisResourceBudget {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error('Analysis concurrency must be a positive safe integer');
  const http = Boolean(process.env.GITNEXUS_EMBEDDING_URL && process.env.GITNEXUS_EMBEDDING_MODEL);
  const effectiveMemoryBytes = Math.floor(effectiveRamBytes() / concurrency);
  const request: AnalysisResourceRequest = {
    effectiveMemoryBytes,
    availableCpus: Math.max(1, Math.floor(os.availableParallelism() / concurrency)),
    totalMb: options.totalMb,
    mainHeapMb: options.mainHeapMb,
    workers: options.workers ?? positiveEnvironment('GITNEXUS_WORKER_POOL_SIZE'),
    workerHeapMb: positiveEnvironment('GITNEXUS_WORKER_HEAP_MB'),
    embeddingThreads: options.includeEmbeddings
      ? positiveEnvironment('GITNEXUS_EMBEDDING_THREADS')
      : undefined,
    preferredWorkers: 16,
    includeParsing: options.includeParsing,
    graphPoolBytes: positiveEnvironment('GITNEXUS_LBUG_BUFFER_POOL_SIZE'),
    graphPoolGranuleRatio: granuleRatio(),
    modelMemoryMb: options.includeEmbeddings && !http ? 2048 : 0,
    supervisorBytes: options.supervisorBytes,
  };
  return resolveAnalysisResourceBudget(request);
}

/** Charge the retained frontend once, including a floor for its IPC/runtime. */
export function analysisSupervisorReservation(): number {
  return Math.max(192 * MIB, Math.ceil(process.memoryUsage().rss / MIB) * MIB);
}

/** Cheap preflight only. Core still revalidates the exact slot under its lock. */
export async function analysisMayEmbed(
  repoPath: string,
  options: { embeddings?: boolean; force?: boolean; dropEmbeddings?: boolean; branch?: string },
): Promise<boolean> {
  if (options.embeddings) return true;
  if (options.dropEmbeddings) return false;
  const { getStoragePaths, loadMeta } = await import('../storage/repo-manager.js');
  const { resolveBranchPlacement } = await import('../storage/branch-index.js');
  const placement = await resolveBranchPlacement(repoPath, options.branch ?? null);
  const directory = path.dirname(getStoragePaths(repoPath, placement.branch).metaPath);
  const meta = await loadMeta(directory);
  return Boolean(
    meta?.embeddingJob ||
    meta?.embeddingCheckpoint ||
    (options.force && (meta?.stats?.embeddings ?? 0) > 0),
  );
}
