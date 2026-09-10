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
  checkpointKind,
  decideEmbeddingResume,
  mintInterruptedCheckpoint,
  mintPartialCheckpoint,
  mintUnverifiedCountCheckpoint,
  type EmbeddingCheckpoint,
  type EmbeddingCheckpointProgress,
} from '../core/embedding-checkpoint.js';
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
      // `abandon` on a non-interrupted foreign identity drops the pending set
      // only. Existing rows stay; sync would then embed the holes under the new
      // identity and mix vector spaces. Fail closed — rebuild via analyze.
      if (identityDiffers && checkpointKind(checkpoint) !== 'unverified-count') {
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

    await initLbug(lbugPath);
    try {
      const existing = await fetchExistingEmbeddingHashes(executeQuery);
      let lastPercent = -1;

      const countEmbeddings = async (): Promise<number | undefined> =>
        persistedEmbeddingCountOrUndefined(await measurePersistedEmbeddingCount(executeQuery));
      const saveCheckpoint = async (
        checkpoint: EmbeddingCheckpointProgress,
        pendingNodeIds: string[],
        embeddings?: number,
      ): Promise<void> => {
        const latest = (await loadMeta(metaDir)) ?? meta;
        await saveMeta(metaDir, {
          ...latest,
          ...(embeddings === undefined ? {} : { stats: { ...latest.stats, embeddings } }),
          embeddingCheckpoint: mintInterruptedCheckpoint(identity, checkpoint, pendingNodeIds),
        });
      };

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
      const latest = (await loadMeta(metaDir)) ?? meta;
      if (embeddings === undefined) {
        // Keep last-known stats.embeddings. An interrupted window marker would
        // fail the identity gate on the next run even though this run finished;
        // unverified-count is the recovery kind that forces a recount (#2790).
        await saveMeta(metaDir, {
          ...latest,
          embeddingCheckpoint: result.failedNodeIds.length
            ? mintPartialCheckpoint(identity, result, resumedFrom)
            : mintUnverifiedCountCheckpoint(identity, {
                nodesProcessed: result.nodesProcessed,
                totalNodes: result.nodesProcessed,
                chunksProcessed: result.chunksProcessed,
              }),
        });
        throw new Error('Could not verify persisted embedding count.');
      }
      await saveMeta(metaDir, {
        ...latest,
        stats: { ...latest.stats, embeddings },
        embeddingCheckpoint: result.failedNodeIds.length
          ? mintPartialCheckpoint(identity, result, resumedFrom)
          : undefined,
      });
      cliInfo(`Embeddings ready: ${embeddings}`);
    } finally {
      await closeLbug().catch(() => {});
    }
  } finally {
    lock.release();
  }
};
