/** Common bounded embedding phase. Callers retain the ordinary slot writer lock. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import lbug from '@ladybugdb/core';
import type { AnalyzeCallbacks } from './run-analyze.js';
import type { AnalysisResourceBudget } from './analysis-resource-budget.js';
import type { RepoMeta } from '../storage/repo-meta.js';
import { loadMeta, saveMeta } from '../storage/repo-manager.js';
import { SCHEMA_FINGERPRINT } from './lbug/schema.js';
import { openLbugConnection, closeLbugConnection } from './lbug/lbug-config.js';
import { drainAnalysisNativeResources } from './lbug/lbug-adapter.js';
import { assertLbugPublicationReady } from './lbug/publication.js';
import { exportLegacyVectors } from './lbug/legacy-vector-export.js';
import {
  beginInPlaceAnalysis,
  prepareAnalysisPublication,
  publishPreparedAnalysis,
  readPreparedAnalysis,
} from './analysis-publication.js';
import { verifyPublishedAnalysisGraph } from './analysis-graph-verification.js';
import { runPublishedEmbeddingJob } from './embeddings/embedding-job.js';
import { drainEmbeddingSidecarForAnalysis } from './embeddings/embedding-sidecar-client.js';
import { deriveEmbeddingCap } from './embedding-mode.js';
import { embeddingProgressFromState, type EmbeddingJobProgress } from './analysis-progress.js';
import { ANALYZER_RUNNER_IDENTITY_SCHEMA_VERSION } from './analyzer-identity.js';
import { resolveGraphPath } from '../storage/shared-store.js';

export function canPromoteLegacyGraph(metadata: RepoMeta): boolean {
  return (
    !metadata.graphGeneration &&
    !metadata.incrementalInProgress &&
    !metadata.graphWriteCollapsed &&
    !metadata.embeddingCheckpoint?.recovery &&
    metadata.schemaFingerprint === SCHEMA_FINGERPRINT &&
    metadata.runnerIdentity?.schemaVersion === ANALYZER_RUNNER_IDENTITY_SCHEMA_VERSION &&
    metadata.parseCacheIdentity !== undefined &&
    metadata.fileHashes !== undefined
  );
}

/** Adopt a healthy legacy graph without parsing, rewriting or copying its graph.
 * Only its vector table is exported, retaining historical provenance for the
 * complete-group validator. Interrupted staged graphs take analyze's existing
 * recovery path instead. */
export async function promoteLegacyGraph(
  directory: string,
  graphPath: string,
  metadata: RepoMeta,
  resources: AnalysisResourceBudget,
  signal?: AbortSignal,
): Promise<RepoMeta> {
  signal?.throwIfAborted();
  if (!canPromoteLegacyGraph(metadata))
    throw new Error(
      'Legacy graph provenance requires analysis before embedding; run gitnexus analyze first.',
    );
  if (
    path.dirname(graphPath) !== path.resolve(directory) ||
    path.basename(graphPath) !== (metadata.graphPath ?? 'lbug')
  )
    throw new Error('Legacy graph promotion requires an owned private graph');
  await drainEmbeddingSidecarForAnalysis();
  await drainAnalysisNativeResources();
  signal?.throwIfAborted();
  await assertLbugPublicationReady(graphPath);
  const handle = await openLbugConnection(lbug, graphPath, {
    readOnly: true,
    bufferPoolBytes: resources.embedding.graphPoolBytes,
    threads: resources.embedding.nativeThreads,
  });
  let legacy = metadata.legacyVectorSource;
  try {
    if (!legacy) {
      const historical = metadata.embeddingCheckpoint;
      legacy = await exportLegacyVectors({
        metadataDirectory: directory,
        query: async (sql) => {
          const result = await handle.conn.query(sql);
          const cursors = Array.isArray(result) ? result : [result];
          try {
            if (cursors.length !== 1) throw new Error('Unexpected legacy migration result');
            return await cursors[0].getAll();
          } finally {
            for (const cursor of cursors) cursor.close();
          }
        },
        provenance: {
          schemaFingerprint: metadata.schemaFingerprint!,
          ...(historical
            ? {
                recordedIdentity: {
                  provider: historical.provider,
                  model: historical.model,
                  dimensions: historical.dimensions,
                },
              }
            : {}),
        },
        excluded: historical?.pendingNodeIds ?? [],
        bufferPoolBytes: resources.embedding.vectorPoolBytes,
        threads: resources.embedding.nativeThreads,
        signal,
      });
    }
  } finally {
    await closeLbugConnection(handle, { strict: true, databasePath: graphPath });
  }
  signal?.throwIfAborted();
  // Persist the independent paid source before retiring the monolithic name.
  const retained = { ...metadata, ...(legacy ? { legacyVectorSource: legacy } : {}) };
  // Canonical legacy paths are represented by absence in the publication
  // contract; shared-store privatization can explicitly record that same name.
  if (retained.graphPath === 'lbug') delete retained.graphPath;
  await saveMeta(directory, retained);
  const now = Date.now();
  const dirty = await beginInPlaceAnalysis(
    directory,
    {
      ...retained,
      incrementalInProgress: {
        startedAt: now,
        updatedAt: now,
        phase: 'legacy-migration',
        toWriteCount: 0,
      },
    },
    (meta) => saveMeta(directory, meta),
  );
  const attemptId = dirty.incrementalInProgress?.attemptId;
  if (!attemptId) throw new Error('Legacy migration has no owned publication attempt');
  const content = createHash('sha256');
  for (const entry of Object.entries(metadata.fileHashes!).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    content.update(JSON.stringify(entry)).update('\0');
  await prepareAnalysisPublication(directory, graphPath, retained, content.digest('hex'), {
    mode: 'in-place',
    attemptId,
  });
  const published = await publishPreparedAnalysis(directory, {
    saveMetadata: (meta) => saveMeta(directory, meta),
    verify: (file, meta) =>
      verifyPublishedAnalysisGraph(file, meta, {
        bufferPoolBytes: resources.embedding.graphPoolBytes,
        threads: resources.embedding.nativeThreads,
      }),
  });
  if (!published) throw new Error('Legacy graph publication disappeared');
  return published;
}

export interface AnalysisEmbeddingPhaseOptions {
  metadataDirectory: string;
  graphPath: string;
  resources: AnalysisResourceBudget;
  callbacks: AnalyzeCallbacks;
  nodeLimit?: number;
  signal?: AbortSignal;
  /** Reject a superseded handoff before any model or paid provider request. */
  expectedGeneration?: string;
}

export async function runAnalysisEmbeddingPhase(
  options: AnalysisEmbeddingPhaseOptions,
): Promise<RepoMeta> {
  const { metadataDirectory, resources, callbacks, signal } = options;
  signal?.throwIfAborted();
  let metadata = await loadMeta(metadataDirectory);
  if (await readPreparedAnalysis(metadataDirectory))
    throw new Error('A prepared graph awaits publication; run gitnexus analyze before embedding.');
  if (!metadata || metadata.incrementalInProgress || metadata.graphWriteCollapsed)
    throw new Error('The graph is incomplete; run gitnexus analyze before embedding.');
  if (!Number.isSafeInteger(metadata.stats?.nodes) || (metadata.stats?.nodes ?? -1) < 0)
    throw new Error('The graph node count is unverified; run gitnexus analyze before embedding.');
  if (options.expectedGeneration && metadata.graphGeneration?.id !== options.expectedGeneration)
    throw new Error('Graph generation changed before embedding; retry analysis.');
  const cap = deriveEmbeddingCap(
    metadata.stats?.nodes ?? 0,
    metadata.embeddingJob || metadata.embeddingCheckpoint ? 0 : options.nodeLimit,
  );
  if (cap.skipForCap) {
    callbacks.onLog?.(
      `Embeddings skipped: graph exceeds the ${cap.nodeLimit}-node cap; use --embeddings 0 to disable it.`,
    );
    await callbacks.onGraphPublished?.();
    return metadata;
  }
  const { isHttpMode } = await import('./embeddings/http-client.js');
  if (!isHttpMode() && resources.embedding.modelBytes === 0)
    throw new Error(
      'Local embedding work was not admitted in this resource budget; retry analysis.',
    );
  if (metadata.embeddingCheckpoint) {
    const { decideEmbeddingResume } = await import('./embedding-checkpoint.js');
    const { resolveEmbeddingIdentity } = await import('./embeddings/embedding-identity.js');
    const identity = resolveEmbeddingIdentity();
    const checkpoint = metadata.embeddingCheckpoint;
    if (Object.hasOwn(checkpoint, 'recovery'))
      throw new Error('The checkpoint references staged embeddings; run gitnexus analyze first.');
    const decision = decideEmbeddingResume(checkpoint, identity);
    if (decision.action === 'abort') throw new Error(decision.error);
    if (
      checkpoint.provider !== identity.provider ||
      checkpoint.model !== identity.model ||
      checkpoint.dimensions !== identity.dimensions
    )
      throw new Error(
        'The embedding checkpoint has a different provider, model or width; run gitnexus analyze --embeddings --force.',
      );
    callbacks.onLog?.(decision.log);
  }
  if (!metadata.graphGeneration)
    metadata = await promoteLegacyGraph(
      metadataDirectory,
      options.graphPath,
      metadata,
      resources,
      signal,
    );
  const graphPath = resolveGraphPath(metadataDirectory, metadata);
  let progress: EmbeddingJobProgress = { phase: 'preparing' };
  callbacks.onProgress('graph-ready', 90, 'Graph available; preparing embeddings', {
    graphPhase: 'ready',
    embeddingProgress: progress,
  });
  try {
    await callbacks.onGraphPublished?.();
    const result = await runPublishedEmbeddingJob({
      metadataDirectory,
      graphPath,
      resources: resources.embedding,
      signal,
      config: { threads: resources.embedding.nativeThreads },
      log: callbacks.onLog,
      metadata: {
        loadMetadata: () => loadMeta(metadataDirectory),
        saveMetadata: (meta) => saveMeta(metadataDirectory, meta),
      },
      onProgress: (state) => {
        progress = embeddingProgressFromState(state);
        const completed = state.completedNodes + state.reusedNodes;
        const percent =
          state.phase === 'indexing' ? 99 : 90 + 8 * (completed / Math.max(1, state.totalNodes));
        callbacks.onProgress(
          'embeddings',
          percent,
          state.phase === 'indexing'
            ? 'Indexing completed embeddings'
            : `Embedding ${completed}/${state.totalNodes}`,
          { graphPhase: 'ready', embeddingProgress: progress },
        );
      },
    });
    if (result.phase !== 'ready')
      throw new Error(
        'Embedding work remains incomplete; the graph is available. Retry to resume durable progress.',
      );
    return result.metadata;
  } catch (error) {
    callbacks.onProgress('embeddings', 98, 'Embeddings incomplete; graph remains available', {
      graphPhase: 'ready',
      embeddingProgress: { ...progress, phase: 'failed' },
    });
    throw error;
  }
}
