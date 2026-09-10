import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { cliError, cliInfo, cliWarn } from './cli-message.js';
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
  type EmbeddingCheckpoint,
  type EmbeddingCheckpointProgress,
} from '../core/embedding-checkpoint.js';
import {
  measurePersistedEmbeddingCount,
  persistedEmbeddingCountOrUndefined,
} from '../core/embedding-count.js';
import {
  getEmbeddingRuntimeDir,
  getEmbeddingStackSpecs,
  installEmbeddingRuntime,
  isPrefixRuntimeLoadable,
  resolveEmbeddingRuntime,
} from '../core/embeddings/runtime-install.js';
import { localEmbeddingPrefixUnloadableMessage } from '../core/embeddings/runtime-support.js';

export interface EmbeddingsInstallOptions {
  cuda?: boolean;
  force?: boolean;
}

/**
 * `gitnexus embeddings install [--cuda] [--force]` — fetch the optional local
 * embedding stack on demand (#2370). Goes through the user's npm registry
 * config (mirrors/proxies apply); with --cuda it additionally runs
 * onnxruntime-node's postinstall to download the CUDA GPU binaries from NuGet
 * (set GLOBAL_AGENT_HTTPS_PROXY behind a proxy).
 */
export const embeddingsInstallCommand = async (
  options: EmbeddingsInstallOptions = {},
): Promise<void> => {
  const resolved = resolveEmbeddingRuntime();
  if (resolved?.source === 'package' && !options.force) {
    cliInfo(
      'The embedding stack is already installed with gitnexus itself — nothing to do.\n' +
        '(Use --force to install a copy into the runtime prefix anyway.)',
    );
    return;
  }

  const specs = Object.entries(getEmbeddingStackSpecs())
    .map(([name, spec]) => `${name}@${spec}`)
    .join(', ');
  cliInfo(`Installing ${specs} into ${getEmbeddingRuntimeDir()} …`);
  cliInfo(
    options.cuda
      ? 'CUDA mode: onnxruntime-node will download GPU binaries from NuGet ' +
          '(set GLOBAL_AGENT_HTTPS_PROXY=<proxy-url> behind a proxy).'
      : 'CPU mode: install scripts are skipped — only your npm registry is contacted.',
  );

  try {
    await installEmbeddingRuntime({ cuda: options.cuda, onOutput: (line) => cliInfo(`  ${line}`) });
  } catch (err) {
    cliError(`${err instanceof Error ? err.message : String(err)}\n`, {
      recoveryHint: 'local-embedding-stack-missing',
    });
    process.exitCode = 1;
    return;
  }

  const postInstall = resolveEmbeddingRuntime();
  if (postInstall === null) {
    cliInfo('✗ Install completed but the stack still does not resolve — check the output above.');
    process.exitCode = 1;
    return;
  }
  if (postInstall.source === 'runtime-prefix' && !isPrefixRuntimeLoadable()) {
    // The packages are in the prefix, but this Node has no module.registerHooks
    // to load them — don't claim readiness the loader can't honour.
    cliWarn(`${localEmbeddingPrefixUnloadableMessage()}\n`);
    return;
  }
  cliInfo('✓ Embedding runtime installed. `gitnexus analyze --embeddings` is ready.');
};

/** Add missing embeddings directly to a healthy index, checkpointing every batch. */
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
      cliInfo(`Checkpointed vectors already present: ${existing?.size ?? 0}`);

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
      if (embeddings === undefined) throw new Error('Could not verify persisted embedding count.');
      const latest = (await loadMeta(metaDir)) ?? meta;
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
