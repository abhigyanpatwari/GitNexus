/** Common lifecycle for jobs on a published graph. The caller holds its index lock. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { RepoMeta } from '../../storage/repo-meta.js';
import {
  createEmbeddingJobDirectories,
  embeddingJobDirectory,
  syncEmbeddingJobDirectory,
  readEmbeddingJobRecord,
  writeEmbeddingJobRecord,
} from '../../storage/embedding-job.js';
import {
  adoptEmbeddingArtifact,
  readEmbeddingArtifactSpace,
  type EmbeddingArtifactOwner,
} from '../../storage/embedding-artifact.js';
import {
  EmbeddingJobJournal,
  type EmbeddingJobState,
} from '../../storage/embedding-job-journal.js';
import {
  assertOwnedVectorGeneration,
  metadataMatchesGraph,
} from '../../storage/vector-generation.js';
import type { AnalysisResourceBudget } from '../analysis-resource-budget.js';
import { contentRetentionFromMeta } from '../content-retention.js';
import { syncPublishedMetadata } from '../analysis-publication.js';
import { EmbeddingGraphSource } from '../lbug/embedding-source.js';
import { LegacyVectorSource, legacyVectorCompatibility } from '../lbug/legacy-vector-source.js';
import { readLegacyEmbeddingSource } from '../../storage/legacy-embedding-source.js';
import { drainAnalysisNativeResources } from '../lbug/lbug-adapter.js';
import { VectorStore, VECTOR_STORE_SCHEMA } from '../lbug/vector-store.js';
import { estimateBufferPool } from '../lbug/lbug-config.js';
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
  const directory = await embeddingJobDirectory(root);
  return createEmbeddingJobDirectories(directory, ['embeddings', identity]);
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
  // A previous failed close must finish before a model or another native pool
  // can consume the next invocation's reservation.
  await drainAnalysisNativeResources();
  signal?.throwIfAborted();
  const root = await embeddingJobDirectory(options.metadataDirectory);
  // Canonicalize the parent just as we do for the job root. macOS temporary
  // paths can name the same directory through /var and /private/var.
  const graphPath = path.join(
    await embeddingJobDirectory(path.dirname(path.resolve(options.graphPath))),
    path.basename(options.graphPath),
  );
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
    !metadataMatchesGraph(root, metadata, graphPath)
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
    contentRetentionFromMeta(metadata),
  );
  const previous = metadata.vectorGeneration;
  if (previous?.identity === identities.identity && !metadata.embeddingJob) {
    await assertOwnedVectorGeneration(root, previous.artifactIdentity ?? previous.identity);
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
  const previousCompatible =
    previous &&
    previous.identity !== identities.identity &&
    previous.vectorIdentity === identities.vectorIdentity &&
    previous.inputIdentity === identities.inputIdentity &&
    previous.dimensions === vector.dimensions;
  const limits = (hasFallback: boolean) => {
    // Writer and the sole reuse reader share this reservation. A sealed probe
    // is physically closed before its replacement writer is opened.
    const result = {
      bufferPoolBytes: Math.floor(resources.vectorPoolBytes / (hasFallback ? 2 : 1)),
      threads: resources.nativeThreads,
      batchBytes: Math.min(resources.queueBytes, 8 * 1024 * 1024),
    };
    if (result.bufferPoolBytes < 8 * 1024 * 1024 || result.batchBytes < vector.dimensions * 16)
      throw new Error('Vector writer and reuse reader do not fit their resource reservation');
    return result;
  };
  const space = {
    vectorIdentity: identities.vectorIdentity,
    inputIdentity: identities.inputIdentity,
    dimensions: vector.dimensions,
    schema: VECTOR_STORE_SCHEMA,
  };
  const validateOwner = async (owner: EmbeddingArtifactOwner) => {
    const directory = await embeddingJobDirectory(path.join(root, 'embeddings', owner.jobIdentity));
    const manifest = await loadEmbeddingWorkManifest(directory, owner.sourceIdentity);
    if (manifest.digest !== owner.manifestDigest)
      throw new Error('Owned embedding artifact manifest changed; paid artifacts retained');
  };
  let artifact = await readEmbeddingArtifactSpace(root, space, validateOwner);
  // A direct legacy receipt survives graph-bound journal replacement. Prefer
  // the newer complete artifact when one exists; never open two reuse readers.
  // A sealed owner has cleared its fallback before metadata publication. Recover
  // that crash window from the legacy pointer still recorded in metadata.
  const legacyIdentity =
    artifact?.owner.fallbackLegacy ??
    (artifact?.owner.phase === 'sealed' || (!artifact && !previousCompatible)
      ? metadata.legacyVectorSource
      : undefined);
  let legacy = legacyIdentity ? await readLegacyEmbeddingSource(root, legacyIdentity) : undefined;
  if (legacy) {
    const incompatible =
      legacyVectorCompatibility(legacy.recordedIdentity, vector) ??
      (legacy.recordedInputIdentity !== undefined &&
      legacy.recordedInputIdentity !== identities.inputIdentity
        ? 'Legacy embedding input provenance differs from this request; source retained.'
        : undefined);
    if (incompatible) {
      if (artifact?.owner.fallbackLegacy) throw new Error(incompatible);
      options.log?.(incompatible);
      legacy = undefined;
    } else {
      const current = await fs.lstat(graphPath, { bigint: true });
      if (String(current.dev) === legacy.file.dev && String(current.ino) === legacy.file.ino)
        throw new Error('Legacy reuse requires a retired source distinct from the mutable graph');
    }
  }
  if (
    !artifact &&
    metadata.embeddingJob &&
    !metadata.embeddingJob.spaceKey &&
    metadata.embeddingJob.identity !== identities.identity
  )
    options.log?.(
      'Prior pending job has no verified vector/input ownership receipt; retaining its files without assuming compatibility.',
    );
  const needsFallback = () =>
    artifact
      ? artifact.owner.phase === 'sealed'
        ? artifact.owner.jobIdentity !== identities.identity
        : Boolean(artifact.owner.fallbackArtifact || artifact.owner.fallbackLegacy)
      : Boolean(
          legacy ||
          (previousCompatible &&
            (previous.artifactIdentity ?? previous.identity) !== identities.identity),
        );
  limits(needsFallback());
  const directory = await jobDirectory(root, identities.identity);
  let source: GraphSource | undefined;
  let store: VectorStore | undefined;
  let reuse: VectorStore | LegacyVectorSource | undefined;
  let runtime: EmbeddingSidecarReservation | undefined;
  try {
    if (usesLocalRuntime) {
      const { reserveEmbeddingSidecar } = await import('./embedding-sidecar-client.js');
      runtime = await reserveEmbeddingSidecar(config, resources.modelHeapMb);
    } else if (!dependencies.provider) {
      const { drainEmbeddingSidecarForAnalysis } = await import('./embedding-sidecar-client.js');
      await drainEmbeddingSidecarForAnalysis();
    }
    // A crash after native sealing but before recording that fact must not
    // turn the complete artifact into a mutable writer for a different graph.
    if (artifact?.owner.phase === 'pending' && artifact.owner.jobIdentity !== identities.identity) {
      const ownedDirectory = await jobDirectory(root, artifact.owner.artifactIdentity);
      if (await existsOwnedFile(path.join(ownedDirectory, 'vectors'))) {
        store = await VectorStore.open({
          directory: ownedDirectory,
          identity: artifact.owner.artifactIdentity,
          dimensions: vector.dimensions,
          mode: 'resume',
          recoverEmptyBootstrap: !(await existsOwnedFile(
            path.join(root, 'embeddings', artifact.owner.jobIdentity, 'job.json'),
          )),
          ...limits(Boolean(artifact.owner.fallbackArtifact || artifact.owner.fallbackLegacy)),
        });
        if (store.isSealed) {
          await store.close();
          store = undefined;
          artifact = await adoptEmbeddingArtifact(
            root,
            space,
            artifact,
            {
              ...artifact.owner,
              phase: 'sealed',
              fallbackArtifact: undefined,
              fallbackLegacy: undefined,
            },
            validateOwner,
          );
        }
      } else if (
        await existsOwnedFile(path.join(root, 'embeddings', artifact.owner.jobIdentity, 'job.json'))
      ) {
        throw new Error('Embedding vectors are missing for acknowledged work; artifacts retained');
      }
    }
    // Sealing may have been discovered by the probe. Admit both pools before
    // reading source or creating a replacement manifest.
    limits(needsFallback());
    const manifestExists = await existsOwnedFile(path.join(directory, 'manifest.json'));
    if (!manifestExists && artifact?.owner.jobIdentity === identities.identity)
      throw new Error('Owned embedding manifest is missing; paid artifacts retained');
    if (!manifestExists) await clearUnstartedManifest(directory);
    const graphElements = (metadata.stats?.nodes ?? NaN) + (metadata.stats?.edges ?? NaN);
    const sourcePoolBytes =
      Number.isSafeInteger(graphElements) && graphElements >= 0
        ? Math.min(resources.graphPoolBytes, estimateBufferPool(graphElements))
        : resources.graphPoolBytes;
    const getSource = async (): Promise<GraphSource> =>
      (source ??= await (dependencies.openSource ?? EmbeddingGraphSource.open)(
        graphPath,
        sourcePoolBytes,
        resources.nativeThreads,
      ));
    const manifest = manifestExists
      ? await loadEmbeddingWorkManifest(directory, identities.sourceIdentity)
      : await createEmbeddingWorkManifest(directory, identities.sourceIdentity, await getSource());
    const makeOwner = (
      artifactIdentity: string,
      revalidateInputs: boolean,
      fallbackArtifact?: string,
      fallbackLegacy?: string,
    ): EmbeddingArtifactOwner => ({
      artifactIdentity,
      jobIdentity: identities.identity,
      graphGeneration: graph.id,
      sourceIdentity: identities.sourceIdentity,
      manifestDigest: manifest.digest,
      phase: 'pending',
      revalidateInputs,
      ...(fallbackArtifact === undefined ? {} : { fallbackArtifact }),
      ...(fallbackLegacy === undefined ? {} : { fallbackLegacy }),
    });
    let owner: EmbeddingArtifactOwner;
    if (artifact?.owner.phase === 'sealed' && artifact.owner.jobIdentity === identities.identity) {
      // Publication/index-only recovery for this exact manifest. Never reopen
      // a sealed artifact with a native writer handle.
      owner = artifact.owner;
    } else if (artifact?.owner.phase === 'sealed') {
      owner = makeOwner(randomBytes(32).toString('hex'), false, artifact.owner.artifactIdentity);
    } else if (artifact) {
      owner = makeOwner(
        artifact.owner.artifactIdentity,
        artifact.owner.revalidateInputs || artifact.owner.jobIdentity !== identities.identity,
        artifact.owner.fallbackArtifact,
        artifact.owner.fallbackLegacy,
      );
    } else {
      // Start a space beside its first job. This also adopts an older bounded
      // artifact only for this exact compatible job; a digest cannot tell us
      // the vector/text provenance of a different old pending job.
      const legacyStore = await existsOwnedFile(path.join(directory, 'vectors'));
      owner = makeOwner(
        identities.identity,
        false,
        previousCompatible ? (previous.artifactIdentity ?? previous.identity) : undefined,
        legacy?.identity,
      );
      if (owner.fallbackArtifact === owner.artifactIdentity) owner.fallbackArtifact = undefined;
      if (
        legacyStore &&
        previous?.identity === identities.identity &&
        (previous.artifactIdentity ?? previous.identity) === owner.artifactIdentity
      )
        owner.phase = 'sealed';
    }
    artifact = await adoptEmbeddingArtifact(root, space, artifact, owner, validateOwner);
    const storeResources = limits(Boolean(owner.fallbackArtifact || owner.fallbackLegacy));
    if (
      metadata.embeddingJob?.identity !== identities.identity ||
      metadata.embeddingJob.artifactIdentity !== owner.artifactIdentity ||
      metadata.embeddingJob.spaceKey !== artifact.spaceKey
    ) {
      metadata = {
        ...metadata,
        embeddingJob: {
          version: 1,
          identity: identities.identity,
          graphGeneration: graph.id,
          artifactIdentity: owner.artifactIdentity,
          spaceKey: artifact.spaceKey,
        },
      };
      await options.metadata.saveMetadata(metadata);
      await syncPublishedMetadata(root, metadata);
    }
    signal?.throwIfAborted();
    const artifactDirectory = await jobDirectory(root, owner.artifactIdentity);
    if (owner.artifactIdentity !== owner.jobIdentity) {
      // Rebased artifacts live apart from the journal. Keep independent proof
      // of ownership so a later generation can reclaim their native payload.
      try {
        const receipt = (await readEmbeddingJobRecord(artifactDirectory, 'artifact.json')) as {
          version: number;
          identity: string;
          jobIdentity: string;
        };
        if (
          receipt.version !== 1 ||
          receipt.identity !== owner.artifactIdentity ||
          !/^[a-f0-9]{64}$/.test(receipt.jobIdentity)
        )
          throw new Error('Embedding artifact has unknown ownership');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeEmbeddingJobRecord(artifactDirectory, 'artifact.json', {
          version: 1,
          identity: owner.artifactIdentity,
          jobIdentity: owner.jobIdentity,
        });
      }
    }
    const hasStore = await existsOwnedFile(path.join(artifactDirectory, 'vectors'));
    const hasJournal = await existsOwnedFile(path.join(directory, 'job.json'));
    if (!hasStore && hasJournal)
      throw new Error('Embedding vectors are missing for acknowledged work; artifacts retained');
    store ??= await VectorStore.open({
      directory: artifactDirectory,
      identity: owner.artifactIdentity,
      dimensions: vector.dimensions,
      mode: owner.phase === 'sealed' ? 'read' : hasStore ? 'resume' : 'create',
      recoverEmptyBootstrap: !hasJournal,
      ...storeResources,
    });
    const journal = await EmbeddingJobJournal.recover(directory, identities.identity, manifest);
    if (owner.fallbackArtifact) {
      const file = await assertOwnedVectorGeneration(root, owner.fallbackArtifact);
      reuse = await VectorStore.open({
        directory: path.dirname(file),
        identity: owner.fallbackArtifact,
        dimensions: vector.dimensions,
        mode: 'read',
        ...storeResources,
      });
    } else if (owner.fallbackLegacy && !store.isSealed) {
      if (!legacy || legacy.identity !== owner.fallbackLegacy)
        throw new Error('Legacy source does not match the owned fallback; artifacts retained');
      reuse = await LegacyVectorSource.open(
        {
          path: legacy.path,
          sourceIdentity: legacy.identity,
          recordedIdentity: legacy.recordedIdentity,
          expectedIdentity: vector,
          recordedInputIdentity: legacy.recordedInputIdentity,
          expectedInputIdentity: identities.inputIdentity,
          config,
          signal,
          log: options.log,
          ...storeResources,
        },
        store,
        legacy.excludedIds,
      );
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
      // A sealed artifact still belongs to this exact job/manifest; rebuilding
      // a damaged cursor can use its complete groups without source reads.
      revalidateStoredInputs: owner.revalidateInputs && !store.isSealed,
      config,
      queueBytes: resources.queueBytes,
      sourceContext: {
        repoPath: metadata.repoPath,
        fileHashes: metadata.fileHashes,
        contentRetention: contentRetentionFromMeta(metadata),
      },
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
    const sealed = store.isSealed;
    await store.close();
    store = undefined;
    await reuse?.close();
    reuse = undefined;
    await source?.close();
    source = undefined;
    signal?.throwIfAborted();
    if (!result.indexKind)
      return { metadata, alreadyComplete: false, phase: 'embedding', ...result };
    if (sealed && artifact.owner.phase !== 'sealed') {
      artifact = await adoptEmbeddingArtifact(
        root,
        space,
        artifact,
        {
          ...artifact.owner,
          phase: 'sealed',
          fallbackArtifact: undefined,
          fallbackLegacy: undefined,
        },
        validateOwner,
      );
    }
    const published = await publishVectorGeneration(
      root,
      {
        version: 1,
        identity: identities.identity,
        artifactIdentity: owner.artifactIdentity,
        graphGeneration: graph.id,
        vectorIdentity: identities.vectorIdentity,
        inputIdentity: identities.inputIdentity,
        dimensions: vector.dimensions,
        nodes: manifest.totalNodes,
        chunks: result.state.chunks,
        ...(result.state.excludedNodes
          ? {
              excludedNodes: result.state.excludedNodes,
              exclusionReason: 'input-rejected' as const,
            }
          : {}),
        indexKind: result.indexKind,
      },
      storeResources,
      options.metadata,
      legacy?.identity,
    );
    if (!published) return { metadata, alreadyComplete: false, phase: 'indexing', ...result };
    if (result.state.excludedNodes)
      options.log?.(
        `Skipped ${result.state.excludedNodes} node(s) after three deterministic embedding input rejections; compatible vectors were published.`,
      );
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
