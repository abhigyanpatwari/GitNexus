import { lstat } from 'node:fs/promises';
import { getHeapStatistics } from 'node:v8';
import { ensurePrivateSharedGraph } from '../core/shared-store-analyze.js';
import { resolveGraphPath } from '../storage/shared-store.js';
import { resolveHostAnalysisResources } from '../core/analysis-host-resources.js';
import { readPreparedAnalysis } from '../core/analysis-publication.js';
import path from 'node:path';
import { cliInfo } from './cli-message.js';
import { getGitRoot } from '../storage/git.js';
import { requireExclusiveIndexLock, sweepStagingArtifacts } from '../storage/index-lock.js';
import { acquireAnalysisSlotLock } from '../storage/analysis-slot-lock.js';
import { getStoragePaths, loadMeta } from '../storage/repo-manager.js';
import { decideEmbeddingResume } from '../core/embedding-checkpoint.js';
import { EMBEDDING_DIMS, embeddingDimsMismatch } from '../core/lbug/schema.js';
import { isHttpMode } from '../core/embeddings/http-client.js';
import {
  ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS,
  getEmbeddingInstallTimeoutMs,
  getEmbeddingRuntimeDir,
  installEmbeddingRuntime,
} from '../core/embeddings/runtime-install.js';
import {
  assessLocalEmbeddingRuntime,
  localEmbeddingStackMissingMessage,
} from '../core/embeddings/runtime-support.js';

/** Add missing embeddings directly to a healthy index, checkpointing periodically. */
export const embeddingsSyncCommand = async (inputPath?: string): Promise<void> => {
  const repoPath = inputPath ? path.resolve(inputPath) : getGitRoot(process.cwd());
  if (!repoPath) throw new Error('Not inside a git repository. Pass a repository path.');

  const { metaPath } = getStoragePaths(repoPath);
  const metaDir = path.dirname(metaPath);
  // Writes go to the slot's own graph. A shared-store checkout that reads an
  // immutable commit graph (#3352) takes a private copy first.
  const resources = resolveHostAnalysisResources({
    mainHeapMb: Math.ceil(getHeapStatistics().heap_size_limit / 1024 ** 2),
    includeParsing: false,
    includeEmbeddings: true,
  });
  const lock = await acquireAnalysisSlotLock(metaDir, { sweep: false });
  try {
    requireExclusiveIndexLock(
      lock,
      `Cannot acquire the index lock at ${metaDir}; refusing an unlocked embeddings sync.`,
    );
    // Sync writes the published graph and cannot recover a staged generation.
    // Reject even malformed receipts before sweeping staging files or writing.
    const recoveryCheckpoint = (await loadMeta(metaDir))?.embeddingCheckpoint;
    if (recoveryCheckpoint && Object.hasOwn(recoveryCheckpoint, 'recovery')) {
      throw new Error(
        'Cannot sync embeddings: the index checkpoint references staged embeddings. ' +
          'Run `gitnexus analyze` to recover them first.',
      );
    }
    if (await readPreparedAnalysis(metaDir))
      throw new Error('A prepared graph awaits publication. Run gitnexus analyze first.');
    sweepStagingArtifacts(metaDir);
    if (!(await ensurePrivateSharedGraph(metaDir, (m) => console.log(`  ${m}`)))) {
      throw new Error('The shared graph this checkout reads is gone. Run gitnexus analyze first.');
    }
    const meta = await loadMeta(metaDir);
    if (!meta)
      throw new Error(`No GitNexus index found for ${repoPath}. Run gitnexus analyze first.`);
    if (meta.incrementalInProgress) {
      throw new Error('The structural index is incomplete. Run gitnexus analyze --force first.');
    }

    const lbugPath = resolveGraphPath(metaDir);
    let lbugStat;
    try {
      lbugStat = await lstat(lbugPath);
    } catch {
      throw new Error(
        `The LadybugDB graph store at ${lbugPath} is missing. Run gitnexus analyze first.`,
      );
    }
    if (!lbugStat.isFile()) {
      throw new Error(
        `The LadybugDB graph store at ${lbugPath} is not a usable database file. Run gitnexus analyze first.`,
      );
    }

    const { resolveEmbeddingIdentity } = await import('../core/embeddings/embedding-identity.js');
    const identity = resolveEmbeddingIdentity();
    if (meta.embeddingCheckpoint) {
      const checkpoint = meta.embeddingCheckpoint;
      const decision = decideEmbeddingResume(checkpoint, identity);
      if (decision.action === 'abort') throw new Error(decision.error);
      const identityDiffers =
        checkpoint.provider !== identity.provider ||
        checkpoint.model !== identity.model ||
        checkpoint.dimensions !== identity.dimensions;
      // `abandon` on a foreign identity drops the pending set only. Existing
      // rows stay; sync would then embed the holes under the new identity and
      // mix vector spaces. Fail closed — rebuild via analyze.
      //
      // Every kind is gated, `unverified-count` included. Exempting it looked
      // safe because that kind only records "the count could not be read", but
      // `decideEmbeddingResume` returns `abandon` for it BEFORE comparing
      // identity, so the exemption was the only thing standing between a
      // foreign identity and a silently mixed table.
      if (identityDiffers) {
        throw new Error(
          `Cannot sync embeddings: the index checkpoint was written by ${checkpoint.model} ` +
            `(${checkpoint.provider}) at ${checkpoint.dimensions} dimensions, but this run ` +
            `resolves ${identity.model} (${identity.provider}) at ${identity.dimensions}. ` +
            'Run `gitnexus analyze --embeddings --force` to rebuild under the new identity.',
        );
      }
      cliInfo(decision.log);
    }

    // Keep legacy sync's explicit migration requirement; the new vector store
    // can use a different width once analyze has established its own generation.
    if (!meta.graphGeneration && embeddingDimsMismatch(meta.embeddingDims, EMBEDDING_DIMS))
      throw new Error(
        `Cannot sync embeddings: this index stores FLOAT[${meta.embeddingDims}] vectors, ` +
          `but this run embeds at ${EMBEDDING_DIMS} dimensions. Run gitnexus analyze --embeddings --force.`,
      );

    if (!isHttpMode()) {
      const assessment = assessLocalEmbeddingRuntime();
      if (assessment.status === 'blocked' || assessment.status === 'prefix-unloadable') {
        throw new Error(assessment.message);
      }
      if (assessment.status === 'needs-install') {
        cliInfo(`Local embedding runtime is not installed.`);
        cliInfo(`Downloading it now from your npm registry into ${getEmbeddingRuntimeDir()} …`);
        try {
          await installEmbeddingRuntime(
            {},
            getEmbeddingInstallTimeoutMs(ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS),
          );
        } catch (err) {
          throw new Error(
            `Could not install the embedding runtime: ${err instanceof Error ? err.message : String(err)}\n\n` +
              localEmbeddingStackMissingMessage(),
          );
        }
      }
    }

    cliInfo(`Embedding ${repoPath}`);
    let lastPercent = -1;
    const { runAnalysisEmbeddingPhase } = await import('../core/analysis-embedding-phase.js');
    const completed = await runAnalysisEmbeddingPhase({
      metadataDirectory: metaDir,
      graphPath: lbugPath,
      resources,
      nodeLimit: 0,
      expectedGeneration: meta.graphGeneration?.id,
      callbacks: {
        onLog: cliInfo,
        onProgress: (_phase, percent, message) => {
          const rounded = Math.floor(percent);
          if (rounded !== lastPercent) {
            lastPercent = rounded;
            cliInfo(`  ${rounded}% — ${message}`);
          }
        },
      },
    });
    cliInfo(`Embeddings ready: ${completed.stats?.embeddings ?? 0}`);
  } finally {
    lock.release();
  }
};
