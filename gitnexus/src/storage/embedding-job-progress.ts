/** Observation only: bounded journal read, no source scan, native DB, or model. */
import path from 'node:path';
import {
  embeddingProgressFromState,
  type EmbeddingJobProgress,
} from '../core/analysis-progress.js';
import type { RepoMeta } from './repo-meta.js';
import type { EmbeddingJobState } from './embedding-job-journal.js';
import { embeddingJobDirectory, readEmbeddingJobRecord } from './embedding-job.js';
import { embeddingGenerationDirectory, selectVectorGeneration } from './vector-generation.js';
import { getExactScanLimit } from '../core/platform/capabilities.js';

export async function readEmbeddingJobProgress(
  metadataDirectory: string,
  metadata: RepoMeta | null | undefined,
): Promise<EmbeddingJobProgress | undefined> {
  const reference = metadata?.embeddingJob;
  if (!reference) {
    if (
      !metadata?.vectorGeneration?.preservedForGraph &&
      !metadata?.vectorGeneration?.excludedNodes
    )
      return undefined;
    if (metadata.graphPath !== undefined && typeof metadata.graphPath !== 'string')
      return { phase: 'unverified' };
    const selected = selectVectorGeneration(
      metadataDirectory,
      metadata,
      path.resolve(metadataDirectory, metadata.graphPath ?? 'lbug'),
      getExactScanLimit(),
    );
    // These are historical chunks, not completed/reused work in a current
    // manifest. Unknown selection totals stay absent, never zero or complete.
    return selected.kind === 'ready'
      ? {
          phase: selected.coverage === 'preserved' ? 'preserved' : 'ready',
          chunks: selected.generation.chunks,
          ...(selected.generation.excludedNodes
            ? { excludedNodes: selected.generation.excludedNodes }
            : {}),
        }
      : undefined;
  }
  try {
    if (
      reference.version !== 1 ||
      metadata?.graphGeneration?.version !== 1 ||
      !/^[a-f0-9]{32}$/.test(reference.graphGeneration) ||
      reference.graphGeneration !== metadata.graphGeneration.id
    )
      throw new Error('Job graph mismatch');
    const directory = embeddingGenerationDirectory(metadataDirectory, reference.identity);
    // Validate every job-owned directory before following the path. In
    // particular, a symlinked embeddings parent must not redirect this read.
    await embeddingJobDirectory(metadataDirectory);
    await embeddingJobDirectory(path.dirname(directory));
    const state = (await readEmbeddingJobRecord(directory, 'job.json')) as EmbeddingJobState;
    if (
      !state ||
      state.version !== 1 ||
      state.identity !== reference.identity ||
      !/^[a-f0-9]{64}$/.test(state.manifestDigest)
    )
      throw new Error('Job identity mismatch');
    const progress = embeddingProgressFromState(state);
    // A journal alone cannot publish a vector capability. If the metadata
    // still points at pending work, even a ready journal awaits publication.
    if (progress.phase === 'ready') progress.phase = 'indexing';
    return progress;
  } catch {
    // Missing/corrupt/unreadable work is not a zero-work or completed job.
    return { phase: 'unverified' };
  }
}
