import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { cliInfo } from './cli-message.js';
import { getGitRoot } from '../storage/git.js';
import { acquireIndexLock } from '../storage/index-lock.js';
import { getStoragePaths, loadMeta, saveMeta } from '../storage/repo-manager.js';
import {
  closeLbug,
  executeQuery,
  executeWithReusedStatement,
  fetchExistingEmbeddingHashes,
  initLbug,
} from '../core/lbug/lbug-adapter.js';
import { runEmbeddingPipeline } from '../core/embeddings/embedding-pipeline.js';
import { resolveEmbeddingIdentity } from '../core/embeddings/embedding-identity.js';
import {
  decideEmbeddingResume,
  mintInterruptedCheckpoint,
  mintPartialCheckpoint,
  mintUnverifiedCountCheckpoint,
  type EmbeddingCheckpoint,
  type EmbeddingCheckpointProgress,
} from '../core/embedding-checkpoint.js';
import { EMBEDDING_DIMS, embeddingDimsMismatch } from '../core/lbug/schema.js';
import type { RepoMeta } from '../storage/repo-meta.js';
import {
  measurePersistedEmbeddingCount,
  persistedEmbeddingCountOrUndefined,
} from '../core/embedding-count.js';

/** Add missing embeddings directly to a healthy index, checkpointing periodically. */
export const embeddingsSyncCommand = async (inputPath?: string): Promise<void> => {
  const repoPath = inputPath ? path.resolve(inputPath) : getGitRoot(process.cwd());
  if (!repoPath) throw new Error('Not inside a git repository. Pass a repository path.');

  const { lbugPath, metaPath } = getStoragePaths(repoPath);
  const metaDir = path.dirname(metaPath);
  const lock = await acquireIndexLock(metaDir);
  try {
    const meta = await loadMeta(metaDir);
    if (!meta)
      throw new Error(`No GitNexus index found for ${repoPath}. Run gitnexus analyze first.`);
    if (meta.incrementalInProgress) {
      throw new Error('The structural index is incomplete. Run gitnexus analyze --force first.');
    }

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

    const identity = resolveEmbeddingIdentity();
    let forceReembedNodeIds: ReadonlySet<string> | undefined;
    let resumedFrom: EmbeddingCheckpoint | undefined;
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
      if (decision.action === 'resume') {
        forceReembedNodeIds = decision.pendingNodeIds;
        resumedFrom = decision.resumedFrom;
      }
    }

    // The vector column is FLOAT[N] fixed when the index was built, and the
    // pipeline deletes each batch's stale rows immediately before inserting the
    // replacements — so a width change here deletes rows it cannot re-insert.
    // `analyze` forces a full rebuild on the same mismatch; only a rebuild can
    // retype the column, so this writer refuses instead. An absent recorded
    // width is not a mismatch (see `embeddingDimsMismatch`).
    if (embeddingDimsMismatch(meta.embeddingDims, EMBEDDING_DIMS)) {
      throw new Error(
        `Cannot sync embeddings: this index stores FLOAT[${meta.embeddingDims}] vectors, ` +
          `but this run embeds at ${EMBEDDING_DIMS} dimensions. ` +
          'Run `gitnexus analyze --embeddings --force` to rebuild the column at the new width.',
      );
    }

    await initLbug(lbugPath);
    try {
      const existing = await fetchExistingEmbeddingHashes(executeQuery);
      let lastPercent = -1;

      const countEmbeddings = async (): Promise<number | undefined> =>
        persistedEmbeddingCountOrUndefined(await measurePersistedEmbeddingCount(executeQuery));
      // One write path for every meta update this command makes. The re-read
      // happens immediately before each save so a concurrent writer's fields
      // survive. #2790 traced two production drifts to hand-copied writers of
      // these exact fields, so this file keeps one copy instead of three.
      const persistMeta = async (patch: (latest: RepoMeta) => Partial<RepoMeta>): Promise<void> => {
        const latest = (await loadMeta(metaDir)) ?? meta;
        await saveMeta(metaDir, { ...latest, ...patch(latest) });
      };
      const saveCheckpoint = async (
        checkpoint: EmbeddingCheckpointProgress,
        pendingNodeIds: string[],
        embeddings?: number,
      ): Promise<void> =>
        persistMeta((latest) => ({
          ...(embeddings === undefined ? {} : { stats: { ...latest.stats, embeddings } }),
          embeddingCheckpoint: mintInterruptedCheckpoint(identity, checkpoint, pendingNodeIds),
        }));

      cliInfo(`Embedding ${repoPath}`);
      cliInfo(`Checkpointed nodes already present: ${existing?.size ?? 0}`);

      const result = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (progress) => {
          const percent = Math.floor(progress.percent);
          if (percent !== lastPercent && (percent % 5 === 0 || percent === 100)) {
            lastPercent = percent;
            cliInfo(
              `  ${percent}% — ${progress.nodesProcessed ?? 0}/${progress.totalNodes ?? '?'} nodes`,
            );
          }
        },
        {},
        undefined,
        existing && existing.size ? existing : undefined,
        {
          forceReembedNodeIds,
          onCheckpointWindowStart: async ({ nodeIds, ...checkpoint }) => {
            await saveCheckpoint(checkpoint, nodeIds);
          },
          onCheckpoint: async (checkpoint) => {
            await saveCheckpoint(checkpoint, [], await countEmbeddings());
          },
        },
      );

      const embeddings = await countEmbeddings();
      if (embeddings === undefined) {
        // Keep last-known stats.embeddings. An interrupted window marker would
        // fail the identity gate on the next run even though this run finished;
        // unverified-count is the recovery kind that forces a recount (#2790).
        await persistMeta(() => ({
          embeddingCheckpoint: result.failedNodeIds.length
            ? mintPartialCheckpoint(identity, result, resumedFrom)
            : mintUnverifiedCountCheckpoint(identity, {
                nodesProcessed: result.nodesProcessed,
                totalNodes: result.nodesProcessed,
                chunksProcessed: result.chunksProcessed,
              }),
        }));
        throw new Error('Could not verify persisted embedding count.');
      }
      await persistMeta((latest) => ({
        stats: { ...latest.stats, embeddings },
        embeddingCheckpoint: result.failedNodeIds.length
          ? mintPartialCheckpoint(identity, result, resumedFrom)
          : undefined,
      }));
      cliInfo(`Embeddings ready: ${embeddings}`);
    } finally {
      await closeLbug().catch(() => {});
    }
  } finally {
    lock.release();
  }
};
