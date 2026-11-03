/** Common lifecycle for jobs on a published graph. The caller holds its index lock. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { RepoMeta } from '../../storage/repo-meta.js';
import { embeddingJobDirectory, syncEmbeddingJobDirectory } from '../../storage/embedding-job.js';
import {
  EmbeddingJobJournal,
  type EmbeddingJobState,
} from '../../storage/embedding-job-journal.js';
import {
  assertOwnedVectorGeneration,
  metadataMatchesGraph,
} from '../../storage/vector-generation.js';
import type { AnalysisResourceBudget } from '../analysis-resource-budget.js';
import { syncPublishedMetadata } from '../analysis-publication.js';
import { EmbeddingGraphSource } from '../lbug/embedding-source.js';
import { VectorStore, VECTOR_STORE_SCHEMA } from '../lbug/vector-store.js';
import { EMBEDDING_TEXT_VERSION } from './embedding-pipeline.js';
import { embeddingJobIdentity } from './embedding-job-identity.js';
import { resolveEmbeddingIdentity, type EmbeddingIdentity } from './embedding-identity.js';
import { resolveEmbeddingConfig } from './config.js';
import {
  createEmbeddingWorkManifest,
  loadEmbeddingWorkManifest,
  type EmbeddingManifestSource,
} from './embedding-work-manifest.js';
import { runEmbeddingJob } from './embedding-job-runner.js';
import { publishVectorGeneration, type VectorPublicationActions } from './vector-publication.js';
import type { EmbeddingConfig, ModelProgressCallback } from './types.js';
import type { embedBatch } from './embedder.js';
import type { EmbeddingSidecarReservation } from './embedding-sidecar-client.js';

type GraphSource = EmbeddingManifestSource & { close(): Promise<void> };
export interface PublishedEmbeddingJobOptions {
  metadataDirectory: string;
  /** Already resolved/owned graph, pinned for the entire job by the index lock. */
  graphPath: string;
  resources: AnalysisResourceBudget['embedding'];
  config?: Partial<EmbeddingConfig>;
  signal?: AbortSignal;
  onProgress?: (state: EmbeddingJobState, peakQueueBytes: number) => void;
  onModelProgress?: ModelProgressCallback;
  log?: (message: string) => void;
  metadata: VectorPublicationActions;
}

/** Provider/source seams allow deterministic native-storage restart tests. */
export interface PublishedEmbeddingJobDependencies {
  identity?: () => EmbeddingIdentity;
  openSource?: (file: string, poolBytes: number, threads: number) => Promise<GraphSource>;
  provider?: typeof embedBatch;
  initializeProvider?: (config: EmbeddingConfig) => Promise<void>;
}

export interface PublishedEmbeddingJobResult {
  metadata: RepoMeta;
  alreadyComplete: boolean;
  phase: 'embedding' | 'indexing' | 'ready';
  state?: EmbeddingJobState;
  peakQueueBytes: number;
}

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function existsOwnedFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Embedding artifact must be an owned regular file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function jobDirectory(root: string, identity: string): Promise<string> {
  let directory = await embeddingJobDirectory(root);
  for (const component of ['embeddings', identity]) {
    const next = path.join(directory, component);
    try {
      await fs.mkdir(next, { mode: 0o700 });
      await syncEmbeddingJobDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    directory = await embeddingJobDirectory(next);
  }
  return directory;
}

/** A preflight interrupted before any native/job artifact owns no paid work.
 * Only its known draft selection files may be removed. Corrupt paid receipts
 * remain evidence and must never turn into a fresh, apparently empty job.
 */
async function clearUnstartedManifest(directory: string): Promise<void> {
  if (
    (await existsOwnedFile(path.join(directory, 'vectors'))) ||
    (await existsOwnedFile(path.join(directory, 'job.json')))
  )
    throw new Error('Embedding manifest is missing for existing paid work; artifacts retained');
  const entries = await fs.opendir(directory);
  for await (const entry of entries) {
    if (/^(manifest\.pending|manifest\.jsonl|keys-\d+\.jsonl)$/.test(entry.name)) {
      const file = path.join(directory, entry.name);
      await existsOwnedFile(file);
      await fs.unlink(file);
    }
  }
  await syncEmbeddingJobDirectory(directory);
}

export async function runPublishedEmbeddingJob(
  options: PublishedEmbeddingJobOptions,
  dependencies: PublishedEmbeddingJobDependencies = {},
): Promise<PublishedEmbeddingJobResult> {
  const { resources, signal } = options;
  signal?.throwIfAborted();
  const root = await embeddingJobDirectory(options.metadataDirectory);
  let metadata = await options.metadata.loadMetadata();
  const graph = metadata?.graphGeneration;
  const runner = metadata?.runnerIdentity;
  if (
    !metadata ||
    !graph ||
    graph.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(graph.id) ||
    !/^[a-f0-9]{64}$/.test(graph.coveredContent) ||
    !runner ||
    runner.schemaVersion !== 4 ||
    !metadata.parseCacheIdentity ||
    !metadata.schemaFingerprint ||
    metadata.incrementalInProgress ||
    metadata.graphWriteCollapsed ||
    !metadataMatchesGraph(root, metadata, options.graphPath)
  )
    throw new Error('Embedding job requires a verified published graph generation');
  const config = resolveEmbeddingConfig(options.config);
  const resolvedVector = (dependencies.identity ?? resolveEmbeddingIdentity)();
  const vector =
    dependencies.identity || resolvedVector.provider !== 'local'
      ? resolvedVector
      : { ...resolvedVector, model: config.modelId };
  if (config.threads > resources.nativeThreads)
    throw new Error('Embedding threads exceed the admitted resource budget');
  for (const value of [resources.graphPoolBytes, resources.vectorPoolBytes, resources.queueBytes])
    if (!Number.isSafeInteger(value) || value < 8 * 1024 * 1024)
      throw new Error('Invalid embedding resource reservation');
  if (!Number.isSafeInteger(resources.nativeThreads) || resources.nativeThreads < 1)
    throw new Error('Invalid embedding CPU reservation');
  const usesLocalRuntime = vector.provider === 'local' && !dependencies.provider;
  if (
    usesLocalRuntime &&
    (!Number.isSafeInteger(resources.modelBytes) ||
      !Number.isSafeInteger(resources.modelHeapMb) ||
      resources.modelHeapMb < 128 ||
      resources.modelHeapMb * 1024 * 1024 + 48 * 1024 * 1024 >= resources.modelBytes)
  )
    throw new Error('Local embedding runtime does not fit its resource reservation');
  const identities = embeddingJobIdentity(
    {
      generation: graph.id,
      coveredContent: graph.coveredContent,
      revision: metadata.lastCommit || 'non-git',
      // Entrypoint paths are diagnostic. Identical artifacts used by analyze,
      // sync and the server must resolve to the same paid job identity.
      analyzer: digest([
        runner.schemaVersion,
        runner.runtime.version,
        runner.runtime.platform,
        runner.runtime.architecture,
        runner.runtime.modulesAbi,
        runner.runtime.libc,
        runner.cliVersion,
        runner.build.digest,
        runner.dependencyRuntime.digest,
      ]),
      parser: digest(metadata.parseCacheIdentity),
      schema: metadata.schemaFingerprint,
      vectorSchema: VECTOR_STORE_SCHEMA,
    },
    vector,
    EMBEDDING_TEXT_VERSION,
    config,
  );
  const previous = metadata.vectorGeneration;
  if (previous?.identity === identities.identity && !metadata.embeddingJob) {
    await assertOwnedVectorGeneration(root, previous.identity);
    return { metadata, alreadyComplete: true, phase: 'ready', peakQueueBytes: 0 };
  }
  if (metadata.embeddingJob && metadata.embeddingJob.identity !== identities.identity) {
    options.log?.(
      metadata.embeddingJob.graphGeneration !== graph.id
        ? 'Embedding graph generation changed; prior paid artifacts retained for compatible reuse.'
        : 'Embedding configuration changed; prior paid artifacts retained.',
    );
  } else if (previous && previous.vectorIdentity !== identities.vectorIdentity) {
    options.log?.(
      'Embedding provider, model or dimensions changed; starting a separate vector space.',
    );
  } else if (previous && previous.inputIdentity !== identities.inputIdentity) {
    options.log?.('Embedding text options changed; prior vectors are not compatible.');
  }
  const reusable =
    previous &&
    previous.identity !== identities.identity &&
    previous.vectorIdentity === identities.vectorIdentity &&
    previous.inputIdentity === identities.inputIdentity &&
    previous.dimensions === vector.dimensions;
  // A reuse reader shares the vector reservation; it is not a third default pool.
  const poolBytes = Math.floor(resources.vectorPoolBytes / (reusable ? 2 : 1));
  const storeResources = {
    bufferPoolBytes: poolBytes,
    threads: resources.nativeThreads,
    batchBytes: Math.min(resources.queueBytes, 8 * 1024 * 1024),
  };
  if (poolBytes < 8 * 1024 * 1024 || storeResources.batchBytes < vector.dimensions * 16)
    throw new Error('Vector writer and reuse reader do not fit their resource reservation');
  const directory = await jobDirectory(root, identities.identity);
  if (metadata.embeddingJob?.identity !== identities.identity) {
    metadata = {
      ...metadata,
      embeddingJob: {
        version: 1,
        identity: identities.identity,
        graphGeneration: graph.id,
      },
    };
    await options.metadata.saveMetadata(metadata);
    await syncPublishedMetadata(root, metadata);
  }
  let source: GraphSource | undefined;
  let store: VectorStore | undefined;
  let reuse: VectorStore | undefined;
  let runtime: EmbeddingSidecarReservation | undefined;
  try {
    if (usesLocalRuntime) {
      const { reserveEmbeddingSidecar } = await import('./embedding-sidecar-client.js');
      runtime = await reserveEmbeddingSidecar(config, resources.modelHeapMb);
    } else if (!dependencies.provider) {
      const { drainEmbeddingSidecarForAnalysis } = await import('./embedding-sidecar-client.js');
      await drainEmbeddingSidecarForAnalysis();
    }
    const manifestExists = await existsOwnedFile(path.join(directory, 'manifest.json'));
    if (!manifestExists) await clearUnstartedManifest(directory);
    const getSource = async (): Promise<GraphSource> =>
      (source ??= await (dependencies.openSource ?? EmbeddingGraphSource.open)(
        options.graphPath,
        resources.graphPoolBytes,
        resources.nativeThreads,
      ));
    const manifest = manifestExists
      ? await loadEmbeddingWorkManifest(directory, identities.sourceIdentity)
      : await createEmbeddingWorkManifest(directory, identities.sourceIdentity, await getSource());
    const hasStore = await existsOwnedFile(path.join(directory, 'vectors'));
    if (!hasStore && (await existsOwnedFile(path.join(directory, 'job.json'))))
      throw new Error('Embedding vectors are missing for acknowledged work; artifacts retained');
    store = await VectorStore.open({
      directory,
      identity: identities.identity,
      dimensions: vector.dimensions,
      mode: hasStore ? 'resume' : 'create',
      ...storeResources,
    });
    const journal = await EmbeddingJobJournal.recover(directory, identities.identity, manifest);
    if (reusable) {
      const file = await assertOwnedVectorGeneration(root, previous.identity);
      reuse = await VectorStore.open({
        directory: path.dirname(file),
        identity: previous.identity,
        dimensions: vector.dimensions,
        mode: 'read',
        ...storeResources,
      });
    }
    const provider: typeof embedBatch =
      dependencies.provider ??
      (async (texts, request) => {
        if (runtime) return runtime.embedBatch(texts, request);
        const { embedBatch } = await import('./embedder.js');
        return embedBatch(texts, {
          ...request,
          maxResponseBytes: texts.length * (4096 + 32 * vector.dimensions),
        });
      });
    const initializeProvider = async () => {
      if (dependencies.initializeProvider) return dependencies.initializeProvider(config);
      await runtime?.initialize(options.onModelProgress);
    };
    const result = await runEmbeddingJob({
      directory,
      manifest,
      journal,
      store,
      reuse,
      config,
      queueBytes: resources.queueBytes,
      // Opening the graph is lazy even on resume: indexing-only retries do not
      // enumerate/fetch source or initialize a provider.
      source: {
        scan: async function* (label) {
          yield* (await getSource()).scan(label);
        },
        fetch: async (label, ids) => (await getSource()).fetch(label, ids),
      },
      provider,
      initializeProvider,
      signal,
      onProgress: options.onProgress,
    });
    await store.close();
    store = undefined;
    await reuse?.close();
    reuse = undefined;
    await source?.close();
    source = undefined;
    signal?.throwIfAborted();
    if (!result.indexKind)
      return { metadata, alreadyComplete: false, phase: 'embedding', ...result };
    const published = await publishVectorGeneration(
      root,
      {
        version: 1,
        identity: identities.identity,
        graphGeneration: graph.id,
        vectorIdentity: identities.vectorIdentity,
        inputIdentity: identities.inputIdentity,
        dimensions: vector.dimensions,
        nodes: manifest.totalNodes,
        chunks: result.state.chunks,
        indexKind: result.indexKind,
      },
      storeResources,
      options.metadata,
    );
    if (!published) return { metadata, alreadyComplete: false, phase: 'indexing', ...result };
    if (journal.snapshot().phase !== 'ready') await journal.ready();
    options.onProgress?.(journal.snapshot(), result.peakQueueBytes);
    return {
      metadata: published,
      alreadyComplete: false,
      phase: 'ready',
      state: journal.snapshot(),
      peakQueueBytes: result.peakQueueBytes,
    };
  } finally {
    // Sequential finally blocks close every native handle even when one close fails.
    try {
      await store?.close();
    } finally {
      try {
        await reuse?.close();
      } finally {
        try {
          await source?.close();
        } finally {
          runtime?.release();
        }
      }
    }
  }
}
